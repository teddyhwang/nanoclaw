import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';

import { getUndeliveredMessages } from './db/messages-out.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

// The idle poll's getPendingMessages used to be unguarded: one transient
// inbound error (the host's hot-journal window surfacing as `attempt to
// write a readonly database`) escaped runPollLoop → main().catch →
// process.exit(1), killing a healthy container between turns. The
// follow-up poll already skipped driver-classified transient errors; the
// idle poll now honours the same contract.

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
     VALUES ('main', 'Main', 'channel', 'slack', 'channel-1')`,
  );
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', ?, 'pending', 1, 'channel-1', 'slack', NULL, ?)`,
    )
    .run(new Date().toISOString(), JSON.stringify({ text: 'hi', prompt: 'hi' }));
});
afterEach(() => closeSessionDb());

function answeringProvider(onQuery: () => void): AgentProvider {
  return {
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    query: () => {
      onQuery();
      return {
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'text', text: '<message to="main">hello</message>' };
          yield { type: 'result', text: '' };
        })(),
        push: () => {},
        end: () => {},
        abort: () => {},
      };
    },
  };
}

function hotJournalError(): Error {
  return Object.assign(new Error('attempt to write a readonly database'), { code: 'SQLITE_READONLY_ROLLBACK' });
}

it('survives a transient inbound error on the idle poll and processes the next tick', async () => {
  const ops = getAgentMailbox().operations;
  const real = ops.getPendingMessages.bind(ops);
  let calls = 0;
  const pending = spyOn(ops, 'getPendingMessages').mockImplementation((limit, isFirstPoll) => {
    calls++;
    if (calls <= 2) throw hotJournalError();
    return real(limit, isFirstPoll);
  });
  const controller = new AbortController();
  try {
    await runPollLoop({
      provider: answeringProvider(() => controller.abort()),
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
  } finally {
    pending.mockRestore();
  }
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toContain('hello');
});

it('still throws a non-transient idle-poll error (real bugs are not swallowed)', async () => {
  const ops = getAgentMailbox().operations;
  const pending = spyOn(ops, 'getPendingMessages').mockImplementation(() => {
    throw new Error('no such column: bogus');
  });
  try {
    await expect(
      runPollLoop({
        provider: answeringProvider(() => {}),
        providerContract: CONTRACT,
        providerName: 'mock',
        cwd: '/workspace/agent',
      }),
    ).rejects.toThrow('no such column: bogus');
    expect(pending).toHaveBeenCalledTimes(1);
  } finally {
    pending.mockRestore();
  }
});
