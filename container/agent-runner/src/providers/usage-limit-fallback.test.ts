import { describe, expect, it } from 'bun:test';

import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './types.js';
import { UsageLimitFallbackProvider, isUsageLimitEvent, resolveUsageLimitFallback } from './usage-limit-fallback.js';

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
