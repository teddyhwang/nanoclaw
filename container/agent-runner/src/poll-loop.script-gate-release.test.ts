import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

// When a pre-task script gates the only trigger=1 row, the accumulate-only
// rows that rode along are skipped "until the next trigger". They had already
// been claimed with markProcessing, so they must be released back to pending;
// otherwise they stay 'processing', are excluded from every later poll and
// never ride along with the next trigger.

const GATED = `printf '{"wakeAgent":false}'`;
const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

function insert(id: string, kind: string, trigger: 0 | 1, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
       VALUES (?, ?, ?, 'pending', ?, 'chan-1', 'discord', ?)`,
    )
    .run(id, kind, new Date().toISOString(), trigger, JSON.stringify(content));
}

const ack = (id: string): string | undefined =>
  (
    getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined
  )?.status;

it('initial batch: releases accumulate rows left after the script gates the only trigger', async () => {
  insert('t-gated', 'task', 1, { prompt: 'monitor', script: GATED });
  insert('t-context', 'task', 0, { prompt: 'context only' });

  const ops = getAgentMailbox().operations;
  const real = ops.getPendingMessages.bind(ops);
  const controller = new AbortController();
  let calls = 0;
  const pending = spyOn(ops, 'getPendingMessages').mockImplementation((limit, isFirstPoll) => {
    calls++;
    if (calls > 1) controller.abort();
    return calls > 1 ? [] : real(limit, isFirstPoll);
  });
  let queries = 0;
  const provider: AgentProvider = {
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    query: () => {
      queries++;
      throw new Error('the model must not be woken');
    },
  };
  try {
    await runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
  } finally {
    pending.mockRestore();
  }

  expect(queries).toBe(0);
  expect(ack('t-gated')).toBe('completed');
  expect(ack('t-context')).toBeUndefined();
  expect(getPendingMessages().map((m) => m.id)).toContain('t-context');
});

it('follow-up: releases accumulate rows left after the script gates the only trigger', async () => {
  const pushes: string[] = [];

  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    insert('t-gated', 'task', 1, { prompt: 'monitor', script: GATED });
    insert('m-context', 'chat', 0, { sender: 'A', text: 'context only' });
    const deadline = Date.now() + 5000;
    while (ack('t-gated') !== 'completed' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  }

  await processQuery(
    { push: (message) => pushes.push(message), end: () => {}, events: events(), abort: () => {} },
    { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: null },
    [],
    'claude',
    null,
    false,
    'TestBot',
    [],
    null,
    undefined,
    'prompt',
    undefined,
  );

  expect(pushes).toHaveLength(0);
  expect(ack('t-gated')).toBe('completed');
  expect(ack('m-context')).toBeUndefined();
  expect(getPendingMessages().map((m) => m.id)).toEqual(['m-context']);
});
