import { describe, expect, it } from 'bun:test';

import { registerProvider, registerProviderContract } from './provider-registry.js';
import { mockRuntimeContract } from '../provider-contracts/mock.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './types.js';
import {
  UsageLimitFallbackProvider,
  buildFailoverHandoff,
  isAuthFailureEvent,
  isUsageLimitEvent,
  resolveUsageLimitFallback,
  summarizeTurnLedger,
  type FailoverInfo,
} from './usage-limit-fallback.js';

class StubProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly inputs: QueryInput[] = [];
  readonly pushes: string[] = [];
  aborts = 0;
  ends = 0;

  constructor(private readonly eventSets: ProviderEvent[][]) {}

  query(input: QueryInput): AgentQuery {
    this.inputs.push(input);
    const events = this.eventSets.shift() ?? [];
    return {
      push: (message) => this.pushes.push(message),
      end: () => {
        this.ends++;
      },
      abort: () => {
        this.aborts++;
      },
      events: (async function* () {
        for (const event of events) yield event;
      })(),
    };
  }

  isSessionInvalid(): boolean {
    return false;
  }
}

async function collect(query: AgentQuery): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of query.events) events.push(event);
  return events;
}

describe('isUsageLimitEvent', () => {
  it('matches only explicitly-classified quota errors', () => {
    expect(isUsageLimitEvent({ type: 'error', message: 'limit', retryable: true, classification: 'quota' })).toBe(true);
    expect(isUsageLimitEvent({ type: 'error', message: 'network', retryable: true })).toBe(false);
    expect(isUsageLimitEvent({ type: 'result', text: 'quota' })).toBe(false);
  });
});

const REVOKED = 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';

describe('isAuthFailureEvent', () => {
  it('matches only terminal error results carrying a credential failure', () => {
    expect(isAuthFailureEvent({ type: 'result', text: REVOKED, isError: true })).toBe(true);
    expect(isAuthFailureEvent({ type: 'result', text: REVOKED })).toBe(false);
    expect(isAuthFailureEvent({ type: 'result', text: 'API Error: 500 Internal', isError: true })).toBe(false);
    expect(isAuthFailureEvent({ type: 'error', message: REVOKED, retryable: false })).toBe(false);
  });
});

describe('resolveUsageLimitFallback', () => {
  it('maps Claude and Codex to each other with host-supplied models', () => {
    const env = {
      NANOCLAW_USAGE_LIMIT_FALLBACK: '1',
      NANOCLAW_USAGE_LIMIT_CLAUDE_MODEL: 'claude-opus-4-8',
      NANOCLAW_USAGE_LIMIT_CODEX_MODEL: 'gpt-5.6-sol',
    };
    expect(resolveUsageLimitFallback('claude', env)).toEqual({
      providerName: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(resolveUsageLimitFallback('codex', env)).toEqual({
      providerName: 'claude',
      model: 'claude-opus-4-8',
    });
  });

  it('stays disabled for pi and when the host flag is absent', () => {
    expect(resolveUsageLimitFallback('pi_rpc', { NANOCLAW_USAGE_LIMIT_FALLBACK: '1' })).toBeNull();
    expect(resolveUsageLimitFallback('claude', {})).toBeNull();
  });
});

describe('UsageLimitFallbackProvider', () => {
  it('swallows the primary quota event and returns the alternate result', async () => {
    const primary = new StubProvider([
      [
        { type: 'init', continuation: 'primary-thread' },
        { type: 'error', message: 'usage limit', retryable: true, classification: 'quota' },
      ],
    ]);
    const fallback = new StubProvider([
      [
        { type: 'init', continuation: 'fallback-thread' },
        { type: 'result', text: '<message to="current">ok</message>' },
      ],
    ]);
    const provider = new UsageLimitFallbackProvider({
      primaryName: 'codex',
      fallbackName: 'claude',
      fallbackModel: 'claude-opus-4-8',
      primary,
      fallback,
    });

    const events = await collect(
      provider.query({ prompt: 'hello', continuation: 'codex-thread', cwd: '/workspace/agent' }),
    );

    expect(events).toEqual([
      { type: 'init', continuation: 'primary-thread' },
      { type: 'result', text: '<message to="current">ok</message>' },
    ]);
    expect(primary.aborts).toBe(1);
    expect(fallback.inputs[0].continuation).toBeUndefined();
    expect(fallback.inputs[0].systemContext?.instructions).toContain('provider claude with model claude-opus-4-8');
  });

  it('replays queued follow-ups and end state onto a fallback started after quota', async () => {
    const primary = new StubProvider([
      [{ type: 'error', message: '429 quota', retryable: true, classification: 'quota' }],
    ]);
    const fallback = new StubProvider([[{ type: 'result', text: 'done' }]]);
    const provider = new UsageLimitFallbackProvider({
      primaryName: 'claude',
      fallbackName: 'codex',
      primary,
      fallback,
    });
    const query = provider.query({ prompt: 'first', cwd: '/workspace/agent' });
    query.push('follow-up');
    query.end();

    await collect(query);

    expect(primary.pushes).toEqual(['follow-up']);
    expect(fallback.pushes).toEqual(['follow-up']);
    expect(fallback.ends).toBe(1);
  });

  it('prefers the alternate harness for later queries after the first quota', async () => {
    const primary = new StubProvider([[{ type: 'error', message: 'quota', retryable: true, classification: 'quota' }]]);
    const fallback = new StubProvider([[{ type: 'result', text: 'first' }], [{ type: 'result', text: 'second' }]]);
    const provider = new UsageLimitFallbackProvider({
      primaryName: 'codex',
      fallbackName: 'claude',
      primary,
      fallback,
    });

    await collect(provider.query({ prompt: 'one', cwd: '/workspace/agent' }));
    await collect(provider.query({ prompt: 'two', continuation: 'codex-thread', cwd: '/workspace/agent' }));

    expect(primary.inputs).toHaveLength(1);
    expect(fallback.inputs).toHaveLength(2);
    expect(fallback.inputs[1].continuation).toBeUndefined();
  });

  it('surfaces one terminal notice when both accounts are limited, then resets to standing', async () => {
    const primary = new StubProvider([
      [{ type: 'error', message: 'primary quota', retryable: true, classification: 'quota' }],
      [{ type: 'result', text: 'primary recovered' }],
    ]);
    const fallback = new StubProvider([
      [{ type: 'error', message: 'fallback quota', retryable: true, classification: 'quota' }],
    ]);
    const provider = new UsageLimitFallbackProvider({
      primaryName: 'codex',
      fallbackName: 'claude',
      primary,
      fallback,
    });

    expect(await collect(provider.query({ prompt: 'one', cwd: '/workspace/agent' }))).toEqual([
      {
        type: 'result',
        text:
          'Both codex and claude have reached their usage limits. ' +
          'Please try again after one of the limits resets.',
        error:
          'Both codex and claude have reached their usage limits. Please try again after one of the limits resets.',
        isError: true,
      },
    ]);
    expect(fallback.aborts).toBe(1);
    expect(await collect(provider.query({ prompt: 'retry', cwd: '/workspace/agent' }))).toEqual([
      { type: 'result', text: 'primary recovered' },
    ]);
    expect(primary.inputs).toHaveLength(2);
  });

  it('does not switch providers for ordinary retryable failures', async () => {
    const primary = new StubProvider([[{ type: 'error', message: 'connection reset', retryable: true }]]);
    const fallback = new StubProvider([]);
    const provider = new UsageLimitFallbackProvider({
      primaryName: 'codex',
      fallbackName: 'claude',
      primary,
      fallback,
    });

    expect(await collect(provider.query({ prompt: 'x', cwd: '/workspace/agent' }))).toEqual([
      { type: 'error', message: 'connection reset', retryable: true },
    ]);
    expect(fallback.inputs).toHaveLength(0);
  });
});

it('quota wrappers use the active runtime contract instead of stale legacy delivery flags', async () => {
  const primary = new StubProvider([[{ type: 'error', message: 'quota', retryable: true, classification: 'quota' }]]);
  const fallback = new StubProvider([
    [
      { type: 'text', text: 'stream' },
      { type: 'result', text: 'final' },
    ],
  ]);
  Object.assign(primary, { emitsMidTurnText: true, supportsNativeSlashCommands: true });
  const primaryName = 'fallback-contract-primary';
  const fallbackName = 'fallback-contract-alternate';
  registerProvider(primaryName, () => primary);
  registerProviderContract(primaryName, {
    ...mockRuntimeContract,
    textDelivery: 'result-only',
    commands: { formatting: 'xml' },
  });
  registerProvider(fallbackName, () => fallback);
  registerProviderContract(fallbackName, mockRuntimeContract);
  const provider = new UsageLimitFallbackProvider({ primaryName, fallbackName, primary, fallback });
  expect(provider.supportsNativeSlashCommands).toBe(false);
  const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
  expect(query.delivery).toEqual({ providerName: primaryName, emitsMidTurnText: false });
  const modes: unknown[] = [];
  for await (const _event of query.events) modes.push(query.delivery);
  expect(modes).toEqual([
    { providerName: fallbackName, emitsMidTurnText: true },
    { providerName: fallbackName, emitsMidTurnText: true },
  ]);
});

describe('UsageLimitFallbackProvider — credential failures', () => {
  function build(primary: StubProvider, fallback: StubProvider, seen: FailoverInfo[] = []) {
    return new UsageLimitFallbackProvider({
      primaryName: 'claude',
      fallbackName: 'codex',
      fallbackModel: 'gpt-6-astra',
      primary,
      fallback,
      onFailover: (info) => {
        seen.push(info);
      },
    });
  }

  // Danielle DM, 2026-09-24: the revoked Claude token returned this result
  // after ten API retries while Codex was healthy; nobody answered her.
  it('replays a revoked-credential turn on the alternate and reports the failover', async () => {
    const primary = new StubProvider([
      [
        { type: 'init', continuation: 'claude-thread' },
        { type: 'error', message: 'API retry', retryable: true },
        { type: 'result', text: REVOKED, isError: true },
      ],
    ]);
    const fallback = new StubProvider([
      [
        { type: 'init', continuation: 'codex-thread' },
        { type: 'result', text: '<message to="current">answer</message>' },
      ],
    ]);
    const seen: FailoverInfo[] = [];

    const events = await collect(build(primary, fallback, seen).query({ prompt: 'q', cwd: '/workspace/agent' }));

    expect(events).toEqual([
      { type: 'init', continuation: 'claude-thread' },
      { type: 'error', message: 'API retry', retryable: true },
      { type: 'result', text: '<message to="current">answer</message>' },
    ]);
    expect(primary.aborts).toBe(1);
    expect(seen).toEqual([{ reason: 'auth', from: 'claude', to: 'codex', detail: REVOKED }]);
  });

  it('fails over when the primary SDK throws the credential failure instead of yielding it', async () => {
    const primary: StubProvider = new StubProvider([]);
    primary.query = (input) => {
      primary.inputs.push(input);
      return {
        push: () => {},
        end: () => {},
        abort: () => {
          primary.aborts++;
        },
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          throw new Error(`Claude Code returned an error result: ${REVOKED}`);
        })(),
      };
    };
    const fallback = new StubProvider([[{ type: 'result', text: 'ok' }]]);
    const seen: FailoverInfo[] = [];

    const events = await collect(build(primary, fallback, seen).query({ prompt: 'q', cwd: '/workspace/agent' }));

    expect(events).toEqual([{ type: 'result', text: 'ok' }]);
    expect(seen.map((i) => i.reason)).toEqual(['auth']);
  });

  it('still throws non-credential primary failures', async () => {
    const primary: StubProvider = new StubProvider([]);
    primary.query = () => ({
      push: () => {},
      end: () => {},
      abort: () => {},
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        throw new Error('Claude Code process exited with code 137');
      })(),
    });
    const fallback = new StubProvider([[{ type: 'result', text: 'unused' }]]);

    await expect(collect(build(primary, fallback).query({ prompt: 'q', cwd: '/workspace/agent' }))).rejects.toThrow(
      'code 137',
    );
    expect(fallback.inputs).toHaveLength(0);
  });

  it('does not fail over on a non-credential error result', async () => {
    const primary = new StubProvider([
      [{ type: 'result', text: 'API Error: 500 Internal server error', isError: true }],
    ]);
    const fallback = new StubProvider([[{ type: 'result', text: 'unused' }]]);
    const seen: FailoverInfo[] = [];

    const events = await collect(build(primary, fallback, seen).query({ prompt: 'q', cwd: '/workspace/agent' }));

    expect(events).toEqual([{ type: 'result', text: 'API Error: 500 Internal server error', isError: true }]);
    expect(fallback.inputs).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it('passes an alternate credential failure through unchanged', async () => {
    const primary = new StubProvider([[{ type: 'result', text: REVOKED, isError: true }]]);
    const codexAuth = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header';
    const fallback = new StubProvider([[{ type: 'result', text: codexAuth, isError: true }]]);

    const events = await collect(build(primary, fallback).query({ prompt: 'q', cwd: '/workspace/agent' }));

    expect(events).toEqual([{ type: 'result', text: codexAuth, isError: true }]);
  });

  it('reports the primary credential failure, not "both limits", when the alternate is then limited', async () => {
    const primary = new StubProvider([[{ type: 'result', text: REVOKED, isError: true }]]);
    const fallback = new StubProvider([
      [{ type: 'error', message: 'usage limit', retryable: true, classification: 'quota' }],
    ]);

    const events = await collect(build(primary, fallback).query({ prompt: 'q', cwd: '/workspace/agent' }));

    expect(events).toEqual([{ type: 'result', text: REVOKED, isError: true }]);
  });

  it('keeps preferring the alternate for later turns after a credential failure', async () => {
    const primary = new StubProvider([[{ type: 'result', text: REVOKED, isError: true }]]);
    const fallback = new StubProvider([[{ type: 'result', text: 'first' }], [{ type: 'result', text: 'second' }]]);
    const provider = build(primary, fallback);

    await collect(provider.query({ prompt: 'one', cwd: '/workspace/agent' }));
    const events = await collect(provider.query({ prompt: 'two', cwd: '/workspace/agent' }));

    expect(events).toEqual([{ type: 'result', text: 'second' }]);
    expect(primary.inputs).toHaveLength(1);
  });

  it('never lets a throwing observer break the failover', async () => {
    const primary = new StubProvider([[{ type: 'result', text: REVOKED, isError: true }]]);
    const fallback = new StubProvider([[{ type: 'result', text: 'ok' }]]);
    const provider = new UsageLimitFallbackProvider({
      primaryName: 'claude',
      fallbackName: 'codex',
      primary,
      fallback,
      onFailover: () => {
        throw new Error('observer boom');
      },
    });

    const events = await collect(provider.query({ prompt: 'q', cwd: '/workspace/agent' }));

    expect(events).toEqual([{ type: 'result', text: 'ok' }]);
  });
});

for (const event of [
  { type: 'result', text: 'already answered' },
  { type: 'text', text: '<message to="current">already sent</message>' },
] satisfies ProviderEvent[]) {
  it(`does not replay completed work after ${event.type} then credential failure`, async () => {
    const primary = new StubProvider([[event, { type: 'result', text: REVOKED, isError: true }]]);
    const fallback = new StubProvider([[{ type: 'result', text: 'duplicate' }]]);
    const provider = new UsageLimitFallbackProvider({
      primaryName: 'claude',
      fallbackName: 'codex',
      primary,
      fallback,
    });
    expect(await collect(provider.query({ prompt: 'q', cwd: '/tmp' }))).toEqual([
      event,
      { type: 'result', text: REVOKED, isError: true },
    ]);
    expect(fallback.inputs).toHaveLength(0);
  });
}
it('awaits and contains async observer failures', async () => {
  const primary = new StubProvider([[{ type: 'result', text: REVOKED, isError: true }]]);
  const fallback = new StubProvider([[{ type: 'result', text: 'ok' }]]);
  const provider = new UsageLimitFallbackProvider({
    primaryName: 'claude',
    fallbackName: 'codex',
    primary,
    fallback,
    onFailover: async () => {
      await Promise.resolve();
      throw new Error('async observer');
    },
  });
  expect(await collect(provider.query({ prompt: 'q', cwd: '/tmp' }))).toEqual([{ type: 'result', text: 'ok' }]);
});

it('recognizes upstream dedicated credential errors without leaking alternate continuations', async () => {
  const primary = new StubProvider([[{ type: 'result', text: null, error: REVOKED, isError: true }]]);
  const fallback = new StubProvider([
    [
      { type: 'init', continuation: 'alternate-secret' },
      { type: 'result', text: 'ok' },
    ],
  ]);
  const provider = new UsageLimitFallbackProvider({ primaryName: 'claude', fallbackName: 'codex', primary, fallback });
  expect(await collect(provider.query({ prompt: 'q', cwd: '/tmp' }))).toEqual([{ type: 'result', text: 'ok' }]);
});

describe('mid-turn failover handoff (AI Friends 2026-10-08 duplicate answer)', () => {
  // Claude sent the full answer with the send_message MCP tool, then hit a 429
  // on its next request. Tool sends never surface as provider events, so the
  // alternate replayed the bare prompt and answered the same question again.
  class FakeLedger {
    rows: Array<{ kind: string; content: string }> = [];
    failCursor = false;
    cursor(): string {
      if (this.failCursor) throw new Error('db closed');
      return String(this.rows.length);
    }
    since(cursor: string) {
      return this.rows.slice(Number(cursor));
    }
    send(text: string): void {
      this.rows.push({ kind: 'chat', content: JSON.stringify({ text }) });
    }
    action(action: string): void {
      this.rows.push({ kind: 'system', content: JSON.stringify({ action, requestId: 'r' }) });
    }
  }
  const quota: ProviderEvent = { type: 'error', message: '429', retryable: true, classification: 'quota' };
  const answer = "That wasn't you. Mack posted the Hindsight link on Jul 14.";

  function wrapWithLedger(primary: StubProvider, fallback: StubProvider, ledger: FakeLedger) {
    return new UsageLimitFallbackProvider({
      primaryName: 'claude',
      fallbackName: 'codex',
      primary,
      fallback,
      turnLedger: ledger,
    });
  }

  it('hands the alternate the messages the primary already delivered by tool', async () => {
    const ledger = new FakeLedger();
    ledger.send('an earlier turn reply');
    const primary = new StubProvider([[{ type: 'activity' }, quota]]);
    const fallback = new StubProvider([[{ type: 'result', text: '<internal>silent turn</internal>' }]]);
    const provider = wrapWithLedger(primary, fallback, ledger);
    const query = provider.query({ prompt: 'did I share a hindsight link?', cwd: '/tmp' });
    ledger.action('search_conversations');
    ledger.send(answer); // MCP send_message mid-turn: invisible to the wrapper's event stream
    expect(await collect(query)).toEqual([
      { type: 'activity' },
      { type: 'result', text: '<internal>silent turn</internal>' },
    ]);
    const prompt = fallback.inputs[0].prompt;
    expect(prompt.startsWith('[Runtime failover handoff')).toBe(true);
    expect(prompt).toContain(`1. <<<${answer}>>>`);
    expect(prompt).not.toContain('an earlier turn reply');
    expect(prompt).toContain('search_conversations');
    expect(prompt).toContain('<internal>silent turn</internal>');
    expect(prompt.endsWith('did I share a hindsight link?')).toBe(true);
    expect(fallback.inputs[0].continuation).toBeUndefined();
  });

  it('leaves the prompt untouched when the primary failed before doing anything', async () => {
    const ledger = new FakeLedger();
    ledger.send('previous turn');
    const fallback = new StubProvider([[{ type: 'result', text: 'ok' }]]);
    const provider = wrapWithLedger(new StubProvider([[quota]]), fallback, ledger);
    await collect(provider.query({ prompt: 'q', cwd: '/tmp' }));
    expect(fallback.inputs[0].prompt).toBe('q');
  });

  it('flags streamed-but-undelivered primary output without claiming a delivery', async () => {
    const fallback = new StubProvider([[{ type: 'result', text: 'ok' }]]);
    const provider = wrapWithLedger(
      new StubProvider([[{ type: 'text', text: 'private narration' }, quota]]),
      fallback,
      new FakeLedger(),
    );
    await collect(provider.query({ prompt: 'q', cwd: '/tmp' }));
    const prompt = fallback.inputs[0].prompt;
    expect(prompt).toContain('Nothing has been delivered to the chat yet');
    expect(prompt).not.toContain('silent turn');
  });

  it('does not replay a credential-failed turn whose answer was already tool-sent', async () => {
    const ledger = new FakeLedger();
    const primary = new StubProvider([[{ type: 'result', text: REVOKED, isError: true }]]);
    const fallback = new StubProvider([[{ type: 'result', text: 'duplicate' }]]);
    const provider = wrapWithLedger(primary, fallback, ledger);
    const query = provider.query({ prompt: 'q', cwd: '/tmp' });
    ledger.send(answer);
    expect(await collect(query)).toEqual([{ type: 'result', text: REVOKED, isError: true }]);
    expect(fallback.inputs).toHaveLength(0);
  });

  it('still fails over with the bare prompt when the ledger is unavailable', async () => {
    const ledger = new FakeLedger();
    ledger.failCursor = true;
    const fallback = new StubProvider([[{ type: 'result', text: 'ok' }]]);
    const provider = wrapWithLedger(new StubProvider([[quota]]), fallback, ledger);
    expect(await collect(provider.query({ prompt: 'q', cwd: '/tmp' }))).toEqual([{ type: 'result', text: 'ok' }]);
    expect(fallback.inputs[0].prompt).toBe('q');
  });

  it('summarizes ledger rows and bounds the delivered text', () => {
    const work = summarizeTurnLedger([
      { kind: 'chat', content: JSON.stringify({ text: 'x'.repeat(4000) }) },
      { kind: 'chat', content: JSON.stringify({ text: '', files: ['a.png'] }) },
      { kind: 'system', content: JSON.stringify({ action: 'schedule_task' }) },
      { kind: 'system', content: JSON.stringify({ action: 'schedule_task' }) },
      { kind: 'chat', content: 'not json' },
    ]);
    expect(work.delivered).toHaveLength(2);
    expect(work.delivered[1]).toBe('[1 file attachment(s)]');
    expect(work.actions.get('schedule_task')).toBe(2);
    const handoff = buildFailoverHandoff({ from: 'claude', reason: 'quota', work, producedOutput: false })!;
    expect(handoff).toContain('… [truncated]');
    expect(handoff).toContain('schedule_task ×2');
    expect(handoff.length).toBeLessThan(3500);
    expect(
      buildFailoverHandoff({
        from: 'claude',
        reason: 'quota',
        work: { delivered: [], actions: new Map() },
        producedOutput: false,
      }),
    ).toBeNull();
  });
});
