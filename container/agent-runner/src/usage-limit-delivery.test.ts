import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { markProcessing } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation } from './db/session-state.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { _resetShutdownStateForTests, processQuery, runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import { UsageLimitFallbackProvider } from './providers/usage-limit-fallback.js';

class ScriptedProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly pushes: string[] = [];
  readonly inputs: QueryInput[] = [];
  constructor(
    readonly emitsMidTurnText: boolean,
    private readonly script: () => AsyncGenerator<ProviderEvent>,
  ) {}
  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }
  query(input: QueryInput): AgentQuery {
    this.inputs.push(input);
    return {
      push: (text) => {
        this.pushes.push(text);
      },
      end() {},
      abort() {},
      events: this.script(),
    };
  }
}

const routing = { platformId: 'test-chat', channelType: 'telegram', threadId: null, inReplyTo: 'm1', taskFire: false };
const block = '<message to="test-dm">The complete answer.</message>';
const internal = '<internal>Reply sent; memory updated.</internal>';
const quota: ProviderEvent = { type: 'error', message: 'quota', retryable: true, classification: 'quota' };

function insertMessage(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
    (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
    VALUES (?, 'chat', datetime('now'), 'pending', 1, 'test-chat', 'telegram', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Test User', text: 'Please answer', isMention: true }));
}
function texts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => JSON.parse(m.content).text);
}
function wrap(primaryName: string, primary: AgentProvider, fallbackName: string, fallback: AgentProvider) {
  return new UsageLimitFallbackProvider({ primaryName, primary, fallbackName, fallback });
}
async function dispatch(provider: AgentProvider, name: string): Promise<void> {
  markProcessing(['m1']);
  await processQuery(
    provider.query({ prompt: 'question', cwd: '/tmp' }),
    { ...routing },
    ['m1'],
    name,
    'telegram:Test User',
    true,
    'Assistant',
    [],
    null,
    undefined,
    'question',
    undefined,
    provider.emitsMidTurnText === true,
  );
}

beforeEach(() => {
  _resetShutdownStateForTests();
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
    VALUES ('test-dm', 'Test DM', 'channel', 'telegram', 'test-chat')`,
    )
    .run();
  insertMessage('m1');
});
afterEach(() => {
  closeSessionDb();
  _resetShutdownStateForTests();
});

describe('quota wrapper delivery through the real poll loop', () => {
  it('delivers Claude answer before memory work, not a failure or a second result-door copy', async () => {
    // September 8: answer -> Edit memory -> internal-only result. No quota
    // occurred; merely wrapping Claude used to hide its streaming capability.
    const controller = new AbortController();
    let beforeMemory: string[] = [];
    const primary = new ScriptedProvider(true, async function* () {
      yield { type: 'init', continuation: 'claude-thread' };
      yield { type: 'text', text: block };
      beforeMemory = texts();
      yield { type: 'activity' }; // memory tool
      yield { type: 'text', text: internal };
      yield { type: 'result', text: internal };
      controller.abort();
    });
    const fallback = new ScriptedProvider(false, async function* () {});
    const provider = wrap('claude', primary, 'codex', fallback);
    await runPollLoop({ provider, providerName: 'claude', cwd: '/tmp', signal: controller.signal });
    expect(beforeMemory).toEqual(['The complete answer.']);
    expect(texts()).toEqual(['The complete answer.']);
    expect(primary.pushes).toEqual([]);
    expect(fallback.inputs).toHaveLength(0);
    expect(getContinuation('claude')).toBe('claude-thread');
  });

  it('keeps unwrapped narration private and a repeated Claude final inert', async () => {
    const primary = new ScriptedProvider(true, async function* () {
      yield { type: 'text', text: 'private unwrapped narration' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    });
    await dispatch(wrap('claude', primary, 'codex', new ScriptedProvider(false, async function* () {})), 'claude');
    expect(texts()).toEqual(['The complete answer.']);
    expect(primary.pushes).toEqual([]);
  });

  it('keeps Codex text events inert until its authoritative result', async () => {
    const primary = new ScriptedProvider(false, async function* () {
      yield { type: 'text', text: '<message to="test-dm">Not final.</message>' };
      expect(texts()).toEqual([]);
      yield { type: 'result', text: block };
    });
    await dispatch(wrap('codex', primary, 'claude', new ScriptedProvider(true, async function* () {})), 'codex');
    expect(texts()).toEqual(['The complete answer.']);
  });

  it('does not carry a Codex supersede flag into a merged Claude fallback result', async () => {
    let primary: ScriptedProvider;
    primary = new ScriptedProvider(false, async function* () {
      insertMessage('m2');
      const deadline = Date.now() + 2000;
      while (primary.pushes.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(primary.pushes).toHaveLength(1);
      yield quota;
    });
    const fallback = new ScriptedProvider(true, async function* () {
      yield { type: 'text', text: block };
      yield { type: 'result', text: internal };
    });
    const provider = wrap('codex', primary, 'claude', fallback);
    const exchanges: string[] = [];
    markProcessing(['m1']);
    await processQuery(
      provider.query({ prompt: 'question', cwd: '/tmp' }),
      { ...routing },
      ['m1'],
      'codex',
      'telegram:Test User',
      true,
      'Assistant',
      [],
      null,
      (exchange) => {
        exchanges.push(exchange.status);
      },
    );
    expect(texts()).toEqual(['The complete answer.']);
    expect(exchanges).toEqual(['completed']);
    expect(fallback.pushes).toEqual(primary.pushes);
  });

  it('discards partial streamed tags on failover and keeps a delivered answer deduplicated', async () => {
    const primary = new ScriptedProvider(true, async function* () {
      yield { type: 'text', text: block };
      yield { type: 'text', text: '<message to="test-dm">unfinished primary' };
      yield quota;
    });
    // Two streaming providers exercise the wrapper contract independently of
    // today's Claude↔Codex pairing; fragments from separate attempts cannot join.
    const fallback = new ScriptedProvider(true, async function* () {
      yield { type: 'text', text: 'different attempt</message>' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: internal };
    });
    await dispatch(wrap('claude', primary, 'other-streaming', fallback), 'claude');
    expect(texts()).toEqual(['The complete answer.']);
    expect(fallback.pushes).toEqual([]);
  });

  it('nudges a streaming fallback that supplies a block only at the result door', async () => {
    const primary = new ScriptedProvider(false, async function* () {
      yield quota;
    });
    const fallback = new ScriptedProvider(true, async function* () {
      yield { type: 'result', text: block };
      expect(texts()).toEqual([]);
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    });
    await dispatch(wrap('codex', primary, 'claude', fallback), 'codex');
    expect(texts()).toEqual(['The complete answer.']);
    expect(fallback.pushes).toHaveLength(1);
    expect(fallback.pushes[0]).toContain('was not delivered');
  });

  it('keeps a dual-quota maintenance failure out of chat after switching delivery modes', async () => {
    const provider = wrap(
      'codex',
      new ScriptedProvider(false, async function* () {
        yield quota;
      }),
      'claude',
      new ScriptedProvider(true, async function* () {
        yield quota;
      }),
    );
    markProcessing(['m1']);
    await processQuery(
      provider.query({ prompt: 'maintenance', cwd: '/tmp' }),
      { ...routing, taskFire: true },
      ['m1'],
      'codex',
      null,
      false,
      'Assistant',
      [{ seriesId: 'dream-test', taskId: 'm1', dispatched: [], assistantText: null, written: false }],
    );
    expect(texts()).toEqual([]);
  });

  for (const primaryName of ['claude', 'codex']) {
    const fallbackName = primaryName === 'claude' ? 'codex' : 'claude';
    it(`uses ${fallbackName}'s delivery mode after ${primaryName} quota, including later queries`, async () => {
      const primary = new ScriptedProvider(primaryName === 'claude', async function* () {
        yield { type: 'init', continuation: 'standing-thread' };
        yield quota;
      });
      const fallback = new ScriptedProvider(fallbackName === 'claude', async function* () {
        yield { type: 'init', continuation: 'ephemeral-thread' };
        yield { type: 'text', text: fallbackName === 'claude' ? block : 'unwrapped commentary' };
        yield { type: 'activity' };
        yield { type: 'result', text: fallbackName === 'claude' ? internal : block };
      });
      const provider = wrap(primaryName, primary, fallbackName, fallback);
      await dispatch(provider, primaryName);
      expect(texts()).toEqual(['The complete answer.']);
      expect(getContinuation(primaryName)).toBe('standing-thread');
      expect(getContinuation(fallbackName)).toBeUndefined();
      await dispatch(provider, primaryName);
      expect(texts()).toEqual(['The complete answer.', 'The complete answer.']);
      expect(primary.inputs).toHaveLength(1);
      expect(fallback.inputs).toHaveLength(2);
      expect(fallback.pushes).toEqual([]);
    });

    it(`uses ${fallbackName}'s follow-up semantics after switching from ${primaryName}`, async () => {
      const primary = new ScriptedProvider(primaryName === 'claude', async function* () {
        yield quota;
      });
      let fallback: ScriptedProvider;
      fallback = new ScriptedProvider(fallbackName === 'claude', async function* () {
        // Let the 500ms follow-up poll push new details into the active query.
        insertMessage('m2');
        const deadline = Date.now() + 2000;
        while (fallback.pushes.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(fallback.pushes).toHaveLength(1);
        if (fallbackName === 'claude') {
          yield { type: 'text', text: block }; // Claude merges pushed input
          yield { type: 'result', text: internal };
        } else {
          yield { type: 'result', text: '<message to="test-dm">Stale answer.</message>' };
          yield { type: 'result', text: block }; // Codex queues a new turn
        }
      });
      await dispatch(wrap(primaryName, primary, fallbackName, fallback), primaryName);
      expect(texts()).toEqual(['The complete answer.']);
      expect(fallback.pushes[0].includes('withheld')).toBe(fallbackName === 'codex');
    });
  }
});
