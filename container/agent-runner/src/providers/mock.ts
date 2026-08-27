import { registerProvider } from './provider-registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 */
export interface MockProviderBehavior {
  /**
   * Emit a single retryable `error` event with NO result, then close —
   * models a provider failing before any turn output (e.g. codex's MCP-init
   * transport death). Used to assert the poll-loop leaves the row pending
   * for a host retry instead of marking it completed.
   */
  retryableErrorNoResult?: string;
  /**
   * After `init`, block WITHOUT emitting any `result` until `end()` is called,
   * then close with no result — models a turn cut short by a SIGTERM-driven
   * graceful shutdown (host reap) before the agent produced output. Used to
   * assert the poll-loop leaves the row pending for the next container rather
   * than silently completing it.
   */
  blockUntilEndNoResult?: boolean;
}

export type MockTextFactory = (prompt: string) => string[];

export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  /**
   * Mirrors ClaudeProvider: turnEvents() emits every configured text segment
   * before the turn's result, so the mock exercises the same one-door
   * mid-turn delivery path as the real SDK.
   */
  readonly emitsMidTurnText = true;

  private responseFactory: (prompt: string) => string | null;
  private behavior: MockProviderBehavior;
  private textFactory: MockTextFactory | undefined;

  constructor(
    _options: ProviderOptions = {},
    responseFactory?: (prompt: string) => string | null,
    /**
     * Backward-compatible discriminated third argument. Optimus behavior
     * fixtures pass an object; upstream streaming fixtures pass a function.
     * The runtime type split prevents either shape from being misread as the
     * other while preserving both existing test APIs.
     */
    behaviorOrTextFactory: MockProviderBehavior | MockTextFactory = {},
  ) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
    if (typeof behaviorOrTextFactory === 'function') {
      this.behavior = {};
      this.textFactory = behaviorOrTextFactory;
    } else {
      this.behavior = behaviorOrTextFactory;
      this.textFactory = undefined;
    }
  }

  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {}

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;
    const behavior = this.behavior;
    const textFactory = this.textFactory;

    // Mid-turn text segments (if configured) followed by the turn's result —
    // mirrors the SDK's assistant-message → result ordering. The result text
    // itself streams as the LAST text event first: the real SDK's result only
    // repeats the final assistant text, which already streamed — that is the
    // emitsMidTurnText contract this mock declares.
    function* turnEvents(prompt: string): Generator<ProviderEvent> {
      for (const text of textFactory?.(prompt) ?? []) {
        yield { type: 'text', text };
      }
      const result = responseFactory(prompt);
      if (result) yield { type: 'text', text: result };
      yield { type: 'result', text: result };
    }

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Failure mode: a retryable error with no result, then close.
        if (behavior.retryableErrorNoResult) {
          yield { type: 'error', message: behavior.retryableErrorNoResult, retryable: true };
          return;
        }

        // Shutdown mode: block (no result) until end() is called, then close
        // with no result — a turn cut short by a host reap mid-turn.
        if (behavior.blockUntilEndNoResult) {
          while (!ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          return;
        }

        // Process initial prompt.
        yield { type: 'activity' };
        yield* turnEvents(input.prompt);

        // Process any pushed follow-ups.
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield* turnEvents(msg);
            continue;
          }
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining messages.
        while (pending.length > 0) {
          const msg = pending.shift()!;
          yield* turnEvents(msg);
        }
      },
    };

    return {
      push(message: string) {
        // Mock provider ignores image blocks — vision is provider-specific.
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));
