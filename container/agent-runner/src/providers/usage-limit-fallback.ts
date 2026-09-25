import { isProviderAuthFailureText } from './auth-failure.js';
import { getProviderRuntimeContract } from './provider-registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ImageContentBlock, ProviderEvent, QueryInput } from './types.js';

function log(message: string): void {
  console.error(`[usage-limit-fallback] ${message}`);
}

export interface FallbackProviderConfig {
  primaryName: string;
  fallbackName: string;
  fallbackModel?: string;
  primary: AgentProvider;
  fallback: AgentProvider;
  /** Observes each primary→alternate switch (operator alerting). Must not throw. */
  onFailover?: (info: FailoverInfo) => void | Promise<void>;
}

export type FailoverReason = 'quota' | 'auth';

export interface FailoverInfo {
  reason: FailoverReason;
  from: string;
  to: string;
  /** Provider text that triggered the switch. */
  detail: string;
}

export interface UsageLimitFallbackSelection {
  providerName: 'claude' | 'codex';
  model?: string;
}

/** Resolve Optimus-style Claude↔Codex failover from the container env. */
export function resolveUsageLimitFallback(
  primaryName: string,
  env: Record<string, string | undefined> = process.env,
): UsageLimitFallbackSelection | null {
  if (env.NANOCLAW_USAGE_LIMIT_FALLBACK !== '1') return null;
  if (primaryName === 'claude') {
    return {
      providerName: 'codex',
      model: env.NANOCLAW_USAGE_LIMIT_CODEX_MODEL?.trim() || undefined,
    };
  }
  if (primaryName === 'codex') {
    return {
      providerName: 'claude',
      model: env.NANOCLAW_USAGE_LIMIT_CLAUDE_MODEL?.trim() || undefined,
    };
  }
  return null;
}

/**
 * True only for provider events that explicitly identify an account quota or
 * usage-limit failure. Ordinary retryable transport/API errors stay on their
 * existing retry path and never cross providers.
 */
export function isUsageLimitEvent(event: ProviderEvent): boolean {
  return event.type === 'error' && event.classification === 'quota';
}

/**
 * True for a terminal error result that says the provider rejected our
 * credential (e.g. `401 OAuth access token has been revoked`). Like a quota
 * failure it is account-level and deterministic — retrying the same provider
 * cannot succeed until an operator rotates the token — so it is failover
 * eligible. Danielle DM, 2026-09-24: the revoked Claude token left a
 * time-sensitive question unanswered while Codex was healthy.
 */
export function isAuthFailureEvent(event: ProviderEvent): boolean {
  return event.type === 'result' && event.isError === true && isProviderAuthFailureText(event.text);
}

function failoverReason(event: ProviderEvent): FailoverReason | null {
  if (isUsageLimitEvent(event)) return 'quota';
  if (isAuthFailureEvent(event)) return 'auth';
  return null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wrap two providers so an account usage-limit from the standing provider is
 * swallowed and the same turn is retried once on the alternate provider.
 *
 * The fallback continuation is deliberately ephemeral. The poll-loop stores
 * continuations under the standing provider name; allowing the alternate
 * provider's init event through would persist an incompatible thread id under
 * that key. Suppressing fallback init events keeps the standing provider's
 * session intact while the alternate harness completes the user's turn.
 */
export class UsageLimitFallbackProvider implements AgentProvider {
  readonly supportsNativeSlashCommands: boolean;

  private readonly primaryName: string;
  private readonly fallbackName: string;
  private readonly fallbackModel?: string;
  private readonly primary: AgentProvider;
  private readonly fallback: AgentProvider;
  private readonly onFailover?: (info: FailoverInfo) => void | Promise<void>;
  private preferFallback = false;
  private fallbackCause: { reason: FailoverReason; detail: string } | null = null;

  constructor(config: FallbackProviderConfig) {
    this.primaryName = config.primaryName;
    this.fallbackName = config.fallbackName;
    this.fallbackModel = config.fallbackModel;
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.onFailover = config.onFailover;
    const contract = getProviderRuntimeContract(config.primaryName);
    this.supportsNativeSlashCommands = contract
      ? contract.commands.formatting === 'native'
      : (config.primary as AgentProvider & { supportsNativeSlashCommands?: boolean }).supportsNativeSlashCommands ===
        true;
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.primary.registerMemorySessionHook(hook);
    this.fallback.registerMemorySessionHook(hook);
  }

  query(input: QueryInput): AgentQuery {
    const fallbackInput = (): QueryInput => ({
      ...input,
      continuation: undefined,
      systemContext: {
        ...input.systemContext,
        instructions:
          `${input.systemContext?.instructions ?? ''}\n\n` +
          `[Runtime failover: this turn is running on provider ${this.fallbackName}` +
          `${this.fallbackModel ? ` with model ${this.fallbackModel}` : ''}.]`,
      },
    });
    let activeProvider = this.preferFallback ? this.fallback : this.primary;
    let activeQuery = activeProvider.query(activeProvider === this.fallback ? fallbackInput() : input);
    const fallbackProvider = this.fallback;
    const primaryName = this.primaryName;
    const fallbackName = this.fallbackName;
    const dualLimitText =
      `Both ${this.primaryName} and ${this.fallbackName} have reached their usage limits. ` +
      'Please try again after one of the limits resets.';
    const notifyFailover = async (info: FailoverInfo): Promise<void> => {
      try {
        await this.onFailover?.(info);
      } catch (err) {
        log(`onFailover observer threw: ${errorText(err)}`);
      }
    };
    // Why the primary was abandoned this turn. A primary auth failure followed
    // by an alternate quota failure is not "both limits reached"; surface the
    // primary's credential error so the poll-loop's auth handling applies.
    let primaryFailure = this.fallbackCause;
    // Replaying the initial prompt after an earlier result/output can duplicate
    // completed work. Auth failover is only safe before observable work.
    let primaryProducedWork = false;
    const resetPreference = (): void => {
      this.preferFallback = false;
      this.fallbackCause = null;
    };
    const followups: Array<{ message: string; imageBlocks?: ImageContentBlock[] }> = [];
    let ended = false;
    let aborted = false;

    const switchToFallback = async (reason: FailoverReason, detail: string): Promise<void> => {
      if (activeProvider === this.fallback) return;
      log(
        reason === 'auth'
          ? `${this.primaryName} authentication failed — retrying transparently with ${this.fallbackName}`
          : `${this.primaryName} usage limit reached — retrying transparently with ${this.fallbackName}`,
      );
      primaryFailure = this.fallbackCause = { reason, detail };
      await notifyFailover({ reason, from: this.primaryName, to: this.fallbackName, detail });
      activeQuery.abort();
      this.preferFallback = true;
      activeProvider = this.fallback;
      activeQuery = this.fallback.query(fallbackInput());
      for (const followup of followups) {
        activeQuery.push(followup.message, followup.imageBlocks);
      }
      if (aborted) activeQuery.abort();
      else if (ended) activeQuery.end();
    };

    async function* events(): AsyncGenerator<ProviderEvent> {
      while (true) {
        const iterator = activeQuery.events[Symbol.asyncIterator]();
        let switched = false;
        while (true) {
          let next: IteratorResult<ProviderEvent>;
          try {
            next = await iterator.next();
          } catch (err) {
            // Some SDK versions throw the credential failure instead of (or
            // after) yielding it as an error result. Treat that the same way.
            if (
              !aborted &&
              !primaryProducedWork &&
              activeProvider !== fallbackProvider &&
              isProviderAuthFailureText(errorText(err))
            ) {
              await switchToFallback('auth', errorText(err));
              switched = true;
              break;
            }
            throw err;
          }
          if (next.done) break;
          const event = next.value;
          const reason = activeProvider !== fallbackProvider ? failoverReason(event) : null;
          if (!aborted && reason && (reason !== 'auth' || !primaryProducedWork)) {
            // Do not await iterator.return(): a provider stream can be parked
            // in its SDK even after abort. The alternate attempt must start
            // immediately rather than inheriting that hang.
            await switchToFallback(
              reason,
              event.type === 'result' ? (event.text ?? '') : event.type === 'error' ? event.message : '',
            );
            switched = true;
            break;
          }
          // Never leak the alternate provider's continuation into the
          // standing provider's continuation slot.
          if (activeProvider === fallbackProvider && event.type === 'init') continue;
          if (activeProvider === fallbackProvider && isUsageLimitEvent(event)) {
            // The first limit was invisible; the alternate is now limited too.
            // Convert the second quota event into a terminal result so chat
            // turns receive one clear notice instead of remaining pending
            // forever with no response. The poll-loop suppresses error results
            // for task-only turns, preserving silent maintenance semantics.
            resetPreference();
            activeQuery.abort();
            const failure = primaryFailure as { reason: FailoverReason; detail: string } | null;
            yield {
              type: 'result',
              text: failure?.reason === 'auth' ? failure.detail : dualLimitText,
              isError: true,
            };
            return;
          }
          if (
            activeProvider !== fallbackProvider &&
            (event.type === 'result' ||
              event.type === 'text' ||
              event.type === 'file' ||
              event.type === 'generated_image')
          ) {
            primaryProducedWork = true;
          }
          yield event;
        }
        if (!switched) return;
      }
    }

    return {
      // A static capability on the wrapper loses one side of Claude↔Codex:
      // Claude must stream pre-tool replies, while Codex's text events must
      // remain inert until its final result. Forward the active query's
      // contract (including nested wrappers) without leaking its continuation.
      get delivery() {
        const name = activeProvider === fallbackProvider ? fallbackName : primaryName;
        const contract = getProviderRuntimeContract(name);
        return (
          activeQuery.delivery ?? {
            providerName: name,
            emitsMidTurnText: contract
              ? contract.textDelivery === 'mid-turn-complete'
              : (activeProvider as AgentProvider & { emitsMidTurnText?: boolean }).emitsMidTurnText === true,
          }
        );
      },
      push: (message, imageBlocks) => {
        followups.push({ message, imageBlocks });
        activeQuery.push(message, imageBlocks);
      },
      end: () => {
        ended = true;
        activeQuery.end();
      },
      abort: () => {
        aborted = true;
        activeQuery.abort();
      },
      events: events(),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    return this.primary.isSessionInvalid(err) || this.fallback.isSessionInvalid(err);
  }

  maybeRotateContinuation(continuation: string, cwd: string): string | null {
    return this.primary.maybeRotateContinuation?.(continuation, cwd) ?? null;
  }

  pressureRotationTokens(): number | null {
    const provider = this.preferFallback ? this.fallback : this.primary;
    return provider.pressureRotationTokens?.() ?? null;
  }

  onExchangeComplete(exchange: Parameters<NonNullable<AgentProvider['onExchangeComplete']>>[0]): void {
    const provider = this.preferFallback ? this.fallback : this.primary;
    provider.onExchangeComplete?.(exchange);
  }
}
