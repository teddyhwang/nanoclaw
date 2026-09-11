import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPendingMessages, markProcessing } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { UsageLimitFallbackProvider } from './providers/usage-limit-fallback.js';

// A half-open provider that really drops unfinished work on end(), like Codex.
// Tests drive events, not timers pretending to have produced a final result.
class ControlledProvider implements AgentProvider {
  readonly pushes: string[] = [];
  ends = 0;
  private stopped = false;
  private events: ProviderEvent[] = [];
  private wake?: () => void;
  constructor(readonly emitsMidTurnText = false) {}
  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }
  emit(event: ProviderEvent): void {
    this.events.push(event);
    this.wake?.();
  }
  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
  query(): AgentQuery {
    const self = this;
    return {
      push: (prompt) => {
        this.pushes.push(prompt);
      },
      end: () => {
        this.ends++;
        this.stop();
      },
      abort: () => this.stop(),
      events: (async function* () {
        while (!self.stopped) {
          const event = self.events.shift();
          if (event) yield event;
          else
            await new Promise<void>((resolve) => {
              self.wake = resolve;
            });
        }
      })(),
    };
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('lifecycle wait timed out');
    await sleep(10);
  }
}
function chat(id: string, sender = 'Teddy', trigger = 1): void {
  getInboundDb()
    .query(
      `INSERT INTO messages_in
    (id,kind,timestamp,status,trigger,platform_id,channel_type,content)
    VALUES (?,'chat',datetime('now'),'pending',?,'room','discord',?)`,
    )
    .run(id, trigger, JSON.stringify({ sender, text: id, isMention: trigger === 1 }));
}
function reflection(): void {
  getInboundDb()
    .query(
      `INSERT INTO messages_in
    (id,kind,timestamp,status,trigger,content)
    VALUES ('reflection','task',datetime('now'),'pending',1,?)`,
    )
    .run(JSON.stringify({ prompt: 'INTERNAL MAINTENANCE — DO NOT MESSAGE THE USER' }));
}
function texts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => JSON.parse(m.content).text);
}
function result(provider: ControlledProvider, text: string): void {
  const block = `<message to="ai-friends">${text}</message>`;
  if (provider.emitsMidTurnText) provider.emit({ type: 'text', text: block });
  provider.emit({ type: 'result', text: block });
}
function start(primary: ControlledProvider, name = 'codex', fallback = new ControlledProvider(name === 'codex')) {
  const provider = new UsageLimitFallbackProvider({
    primaryName: name,
    primary,
    fallbackName: name === 'codex' ? 'claude' : 'codex',
    fallback,
  });
  const query = provider.query({ prompt: 'initial', cwd: '/tmp' });
  markProcessing(['initial']);
  const done = processQuery(
    query,
    { platformId: 'room', channelType: 'discord', threadId: null, inReplyTo: 'initial', taskFire: false },
    ['initial'],
    name,
    'discord:Teddy',
    true,
    'Optimus',
    [],
    null,
    undefined,
    'initial',
  );
  return { done, query, fallback };
}
beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .query(
      `INSERT INTO destinations (name,display_name,type,channel_type,platform_id)
    VALUES ('ai-friends','AI Friends','channel','discord','room')`,
    )
    .run();
  chat('initial');
});
afterEach(() => closeSessionDb());

describe('deferred work must not preempt any unfinished input', () => {
  for (const name of ['codex', 'claude'] as const) {
    for (const deferred of ['reflection', 'cross-sender', 'mixed'] as const) {
      it(`protects a warm follow-up from ${deferred} after an earlier result (${name})`, async () => {
        const primary = new ControlledProvider(name === 'claude');
        const { done, query } = start(primary, name);
        try {
          result(primary, 'First request finished');
          await waitFor(() => texts().length === 1);
          chat('timezone');
          await waitFor(() => primary.pushes.length === 1);
          // The real incident sent this via MCP, triggering reflection before
          // the page publish. An outbox acknowledgment is not turn completion.
          await writeMessageOut({
            id: 'ack',
            kind: 'chat',
            platform_id: 'room',
            channel_type: 'discord',
            in_reply_to: 'timezone',
            content: JSON.stringify({ text: 'I will remove the selector' }),
          });
          if (deferred !== 'cross-sender') reflection();
          if (deferred !== 'reflection') chat('bob', 'Bob');
          await sleep(650);
          expect(primary.ends).toBe(0);
          expect(primary.pushes).toHaveLength(1);
          result(primary, 'Timezone published');
          await waitFor(() => texts().includes('Timezone published'));
          await waitFor(() => primary.ends === 1);
          const final = getUndeliveredMessages().find((m) => JSON.parse(m.content).text === 'Timezone published');
          expect(final?.in_reply_to).toBe('timezone');
          expect(getInboundDb().query('SELECT COUNT(*) AS n FROM delivered').get()).toEqual({ n: 0 });
          await done;
          const pending = getPendingMessages()
            .map((row) => row.id)
            .sort();
          expect(pending).toEqual(
            deferred === 'reflection' ? ['reflection'] : deferred === 'cross-sender' ? ['bob'] : ['bob', 'reflection'],
          );
        } finally {
          query.abort();
          await done;
        }
      });
    }
  }

  it('does not let another sender preempt the initial result either', async () => {
    const primary = new ControlledProvider();
    const { done, query } = start(primary);
    try {
      chat('bob', 'Bob');
      await sleep(650);
      expect(primary.ends).toBe(0);
      result(primary, 'Initial finished');
      await waitFor(() => primary.ends === 1);
      expect(texts()).toEqual(['Initial finished']);
    } finally {
      query.abort();
      await done;
    }
  });

  it('waits for all queued Codex inputs, not just the stale first result', async () => {
    const primary = new ControlledProvider();
    const { done, query } = start(primary);
    try {
      chat('more-details');
      await waitFor(() => primary.pushes.length === 1);
      reflection();
      result(primary, 'Stale answer');
      await sleep(650);
      expect(texts()).toEqual([]);
      expect(primary.ends).toBe(0);
      result(primary, 'Complete answer');
      await waitFor(() => primary.ends === 1);
      expect(texts()).toEqual(['Complete answer']);
    } finally {
      query.abort();
      await done;
    }
  });

  it('protects a wrapping retry from reflection after a warm follow-up', async () => {
    const primary = new ControlledProvider();
    const { done, query } = start(primary);
    try {
      result(primary, 'First finished');
      await waitFor(() => texts().length === 1);
      chat('next');
      await waitFor(() => primary.pushes.length === 1);
      primary.emit({ type: 'result', text: 'unwrapped answer' });
      await waitFor(() => primary.pushes.length === 2);
      reflection();
      await sleep(650);
      expect(primary.ends).toBe(0);
      result(primary, 'Wrapped answer');
      await waitFor(() => primary.ends === 1);
      expect(texts()).toEqual(['First finished', 'Wrapped answer']);
    } finally {
      query.abort();
      await done;
    }
  });

  it('does not end a task stream while another pushed task is unfinished', async () => {
    getInboundDb()
      .query("UPDATE messages_in SET kind='task', content=? WHERE id='initial'")
      .run(JSON.stringify({ prompt: 'first maintenance task' }));
    const primary = new ControlledProvider();
    const query = primary.query();
    markProcessing(['initial']);
    const done = processQuery(
      query,
      { platformId: null, channelType: null, threadId: null, inReplyTo: 'initial', taskFire: true },
      ['initial'],
      'codex',
      null,
      false,
      'Optimus',
      [{ seriesId: 'first', taskId: 'initial', dispatched: [], assistantText: null, written: false }],
      null,
      undefined,
      'initial',
    );
    try {
      reflection();
      await waitFor(() => primary.pushes.length === 1);
      chat('bob', 'Bob');
      primary.emit({ type: 'result', text: '<internal>first finished</internal>' });
      await sleep(650);
      expect(primary.ends).toBe(0);
      primary.emit({ type: 'result', text: '<internal>second finished</internal>' });
      await waitFor(() => primary.ends === 1);
      expect(texts()).toEqual([]);
      expect(getPendingMessages().map((row) => row.id)).toEqual(['bob']);
    } finally {
      query.abort();
      await done;
    }
  });

  for (const name of ['claude', 'codex'] as const) {
    it(`lets deferred reflection run after a single merged Claude result (${name} standing)`, async () => {
      const primary = new ControlledProvider(name === 'claude');
      const fallback = new ControlledProvider(true);
      const { done, query } = start(primary, name, fallback);
      try {
        chat('more-details');
        await waitFor(() => primary.pushes.length === 1);
        reflection();
        let active = primary;
        if (name === 'codex') {
          primary.emit({ type: 'error', message: 'quota', retryable: true, classification: 'quota' });
          await waitFor(() => query.delivery?.providerName === 'claude');
          active = fallback;
        }
        result(active, 'Merged answer');
        await waitFor(() => active.ends === 1);
        expect(texts()).toEqual(['Merged answer']);
      } finally {
        query.abort();
        await done;
      }
    });
  }

  it('protects a new Codex follow-up after failover from standing Claude', async () => {
    const primary = new ControlledProvider(true);
    const fallback = new ControlledProvider();
    const { done, query } = start(primary, 'claude', fallback);
    try {
      primary.emit({ type: 'error', message: 'quota', retryable: true, classification: 'quota' });
      await waitFor(() => query.delivery?.providerName === 'codex');
      result(fallback, 'First finished');
      await waitFor(() => texts().length === 1);
      chat('timezone');
      await waitFor(() => fallback.pushes.length === 1);
      reflection();
      await sleep(650);
      expect(fallback.ends).toBe(0);
      result(fallback, 'Timezone published');
      await waitFor(() => fallback.ends === 1);
      expect(texts()).toEqual(['First finished', 'Timezone published']);
    } finally {
      query.abort();
      await done;
    }
  });
});
