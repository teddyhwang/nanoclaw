import { registerProvider } from './provider-registry.js';
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

export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string) => string;
  private behavior: MockProviderBehavior;

  constructor(
    _options: ProviderOptions = {},
    responseFactory?: (prompt: string) => string,
    behavior: MockProviderBehavior = {},
  ) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
    this.behavior = behavior;
  }

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

        // Process initial prompt
        yield { type: 'activity' };
        yield { type: 'result', text: responseFactory(input.prompt) };

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield { type: 'result', text: responseFactory(msg) };
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          yield { type: 'result', text: responseFactory(msg) };
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
