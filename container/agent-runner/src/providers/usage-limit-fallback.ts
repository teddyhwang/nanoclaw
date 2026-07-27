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
  private preferFallback = false;

  constructor(config: FallbackProviderConfig) {
    this.primaryName = config.primaryName;
    this.fallbackName = config.fallbackName;
    this.fallbackModel = config.fallbackModel;
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.supportsNativeSlashCommands = config.primary.supportsNativeSlashCommands;
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
    const dualLimitText =
      `Both ${this.primaryName} and ${this.fallbackName} have reached their usage limits. ` +
      'Please try again after one of the limits resets.';
    const resetPreference = (): void => {
      this.preferFallback = false;
    };
    const followups: Array<{ message: string; imageBlocks?: ImageContentBlock[] }> = [];
    let ended = false;
    let aborted = false;

    const switchToFallback = (): void => {
      if (activeProvider === this.fallback) return;
      log(`${this.primaryName} usage limit reached — retrying transparently with ${this.fallbackName}`);
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
          const next = await iterator.next();
          if (next.done) break;
          const event = next.value;
          if (activeProvider !== fallbackProvider && isUsageLimitEvent(event)) {
            // Do not await iterator.return(): a provider stream can be parked
            // in its SDK even after abort. The alternate attempt must start
            // immediately rather than inheriting that hang.
            switchToFallback();
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
            yield {
              type: 'result',
              text: dualLimitText,
              isError: true,
            };
            return;
          }
          yield event;
        }
        if (!switched) return;
      }
    }

    return {
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
