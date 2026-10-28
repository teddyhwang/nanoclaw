/**
 * Session-DB host writes that must survive a brief runner lock.
 *
 * Host connections wait only ~20 ms in SQLite (mailbox/sqlite/busy.ts). For
 * each write below a failed attempt would lose a user action or state, so it
 * retries asynchronously. Each test holds a runner-style read transaction on
 * inbound.db (a SHARED lock: the host cannot commit) for ~300 ms, i.e. far
 * past the SQLite wait, then releases it; the write must land.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-lockwait',
    GROUPS_DIR: '/tmp/nanoclaw-test-lockwait/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-lockwait';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { updateSession } from './db/sessions.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import {
  _carryForwardRecentPendingChatRowsForTesting,
  completeInboundDurably,
  resolveSession,
  settlePendingCompletions,
  writeSessionMessage,
  writeSessionRouting,
} from './session-manager.js';
import { getPendingCompletions } from './db/pending-completions.js';
import { reconcileSession } from './reconcile-session.js';
import { wakeContainer } from './container-runner.js';
import { createDestination, deleteDestination } from './modules/agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from './modules/agent-to-agent/write-destinations.js';
import {
  deliverSessionMessages,
  dropSuppressedOutbound,
  registerOutboundSuppressor,
  setDeliveryAdapter,
} from './delivery.js';
import { recordDeliveryAttempt } from './db/coordination.js';
import type { Session } from './types.js';

const now = () => new Date().toISOString();

async function seed(): Promise<Session> {
  await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-1',
    name: 'G',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  return (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
}

/** A runner read transaction on inbound.db, released after `ms`. Resolves
 * once released; `held()` reports whether it was still open. */
function holdInbound(sessionId: string, ms = 300) {
  const reader = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM messages_in').get();
  let open = true;
  const released = new Promise<void>((resolve) =>
    setTimeout(() => {
      reader.exec('COMMIT');
      reader.close();
      open = false;
      resolve();
    }, ms),
  );
  return { released, held: () => open };
}

function inbound<T>(sessionId: string, sql: string, ...args: unknown[]): T | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  try {
    return db.prepare(sql).get(...args) as T | undefined;
  } finally {
    db.close();
  }
}

function insertOutbound(sessionId: string, id: string): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, 1, datetime('now'), 'chat', 'chan-1', 'discord', '{"text":"x"}')`,
  ).run(id);
  db.close();
}

let unregister: Array<() => void> = [];
beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  for (const off of unregister) off();
  unregister = [];
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writes that wait out a brief runner lock', () => {
  it('writeSessionRouting (every wake)', async () => {
    const session = await seed();
    const lock = holdInbound(session.id);
    await writeSessionRouting('ag-1', session.id);
    expect(lock.held()).toBe(false); // it really waited past the lock
    expect(inbound(session.id, 'SELECT platform_id FROM session_routing')).toEqual({ platform_id: 'chan-1' });
  });

  it('writeDestinations (every wake)', async () => {
    const session = await seed();
    const db = new Database(inboundDbPath('ag-1', session.id));
    db.prepare("INSERT INTO destinations (name, type) VALUES ('stale', 'channel')").run();
    db.close();
    const lock = holdInbound(session.id);
    await writeDestinations('ag-1', session.id);
    expect(lock.held()).toBe(false);
    expect(inbound(session.id, "SELECT 1 FROM destinations WHERE name = 'stale'")).toBeUndefined();
  });

  it('carried-forward chat rows are completed in the source session (no double run)', async () => {
    const source = await seed();
    await writeSessionMessage('ag-1', source.id, {
      id: 'chat-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'chan-1',
      channelType: 'discord',
      content: '{"text":"hi"}',
      trigger: true,
    });
    await updateSession(source.id, { status: 'closed' });
    const target = (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
    expect(target.id).not.toBe(source.id);
    // resolveSession carried it; re-pend it and carry again under a lock.
    const db = new Database(inboundDbPath('ag-1', source.id));
    db.prepare("UPDATE messages_in SET status = 'pending' WHERE id = 'chat-1'").run();
    db.close();
    const lock = holdInbound(source.id);
    await _carryForwardRecentPendingChatRowsForTesting('ag-1', 'mg-1', null, target.id);
    expect(lock.held()).toBe(false);
    expect(inbound(source.id, "SELECT status FROM messages_in WHERE id = 'chat-1'")).toEqual({
      status: 'completed',
    });
  });

  it('dropSuppressedOutbound closes a Stop-suppressed row', async () => {
    const session = await seed();
    insertOutbound(session.id, 'out-1');
    unregister.push(registerOutboundSuppressor(() => 'user-stop'));
    const lock = holdInbound(session.id);
    expect(await dropSuppressedOutbound(session.id)).toEqual(['out-1']);
    expect(lock.held()).toBe(false);
    expect(inbound(session.id, "SELECT status FROM delivered WHERE message_out_id = 'out-1'")).toEqual({
      status: 'failed',
    });
  });

  it('a permanent delivery failure is recorded (not re-queued)', async () => {
    const session = await seed();
    insertOutbound(session.id, 'out-poison');
    for (let i = 0; i < 2; i++)
      await recordDeliveryAttempt({
        messageId: 'out-poison',
        sessionId: session.id,
        now: now(),
        nextAttemptAt: null,
        error: 'earlier',
      });
    let calls = 0;
    let lock: ReturnType<typeof holdInbound> | undefined;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        lock = holdInbound(session.id);
        throw new Error('still failing');
      },
    });
    await deliverSessionMessages(session);
    expect(lock?.held()).toBe(false);
    expect(inbound(session.id, "SELECT status FROM delivered WHERE message_out_id = 'out-poison'")).toEqual({
      status: 'failed',
    });
    await deliverSessionMessages(session);
    expect(calls).toBe(1);
  });
});

async function pendingChat(sessionId: string, id: string): Promise<void> {
  await writeSessionMessage('ag-1', sessionId, {
    id,
    kind: 'chat',
    timestamp: now(),
    platformId: 'chan-1',
    channelType: 'discord',
    content: '{"text":"hi"}',
    trigger: true,
  });
}

describe('serialized projections (no stale overwrite)', () => {
  it('a slow retried destination write never lands after a newer one', async () => {
    const session = await seed();
    await createAgentGroup({ id: 'ag-peer', name: 'Old peer', folder: 'p', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: 'ag-new', name: 'New peer', folder: 'n', agent_provider: null, created_at: now() });
    await createDestination({
      agent_group_id: 'ag-1',
      local_name: 'peer',
      target_type: 'agent',
      target_id: 'ag-peer',
      created_at: now(),
    });
    // A runner lock outlives both writers' first attempts. A starts first
    // (computes "Old peer"), the destination changes, B starts later.
    const lock = holdInbound(session.id, 330);
    const a = writeDestinations('ag-1', session.id);
    await new Promise((r) => setTimeout(r, 200));
    await deleteDestination('ag-1', 'peer');
    await createDestination({
      agent_group_id: 'ag-1',
      local_name: 'peer',
      target_type: 'agent',
      target_id: 'ag-new',
      created_at: now(),
    });
    const b = writeDestinations('ag-1', session.id);
    await Promise.all([a, b, lock.released]);
    expect(inbound(session.id, "SELECT display_name FROM destinations WHERE name = 'peer'")).toEqual({
      display_name: 'New peer',
    });
  });
});

describe('sweep steps are independent', () => {
  it('a busy ack sync does not skip the due-message wake', async () => {
    const session = await seed();
    await pendingChat(session.id, 'due-1');
    // A terminal ack the sweep must sync into inbound.db (a write).
    const out = new Database(outboundDbPath('ag-1', session.id));
    out.prepare("INSERT INTO processing_ack VALUES ('older', 'completed', datetime('now'))").run();
    out.close();
    vi.mocked(wakeContainer).mockClear();
    // Long enough that a loaded host's whole sweep pass (several fast-failing
    // busy steps) still finishes inside it: the sync really meets the lock.
    const lock = holdInbound(session.id, 3000);
    await reconcileSession(session.id);
    expect(lock.held()).toBe(true);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    await lock.released;
  }, 15_000);
});

describe('owed completions (a Stop whose completion cannot land)', () => {
  it('stays owed durably, blocks no-one but the runner, and settles before any spawn', async () => {
    const session = await seed();
    await pendingChat(session.id, 'stopped-1');
    const lock = holdInbound(session.id, 300);
    await expect(
      completeInboundDurably('ag-1', session.id, ['stopped-1'], { reason: 'user-stop' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });
    expect(await getPendingCompletions(session.id)).toEqual(['stopped-1']);
    await lock.released;
    // The spawn gate (and every sweep pass) settles it before a runner runs.
    expect(await settlePendingCompletions('ag-1', session.id)).toBe(true);
    expect(inbound(session.id, "SELECT status FROM messages_in WHERE id = 'stopped-1'")).toEqual({
      status: 'completed',
    });
    expect(await getPendingCompletions(session.id)).toEqual([]);
  });

  it('the sweep settles an owed completion before deciding a wake', async () => {
    const session = await seed();
    await pendingChat(session.id, 'stopped-2');
    const lock = holdInbound(session.id, 100);
    await expect(
      completeInboundDurably('ag-1', session.id, ['stopped-2'], { reason: 'user-stop' }),
    ).rejects.toBeDefined();
    await lock.released;
    vi.mocked(wakeContainer).mockClear();
    await reconcileSession(session.id);
    expect(inbound(session.id, "SELECT status FROM messages_in WHERE id = 'stopped-2'")).toEqual({
      status: 'completed',
    });
    expect(await getPendingCompletions(session.id)).toEqual([]);
    expect(wakeContainer).not.toHaveBeenCalled(); // nothing else was due
  });

  it('settlePendingCompletions reports false while the lock outlasts its retry', async () => {
    const session = await seed();
    await pendingChat(session.id, 'stopped-3');
    const first = holdInbound(session.id, 50);
    await expect(
      completeInboundDurably('ag-1', session.id, ['stopped-3'], { reason: 'user-stop' }),
    ).rejects.toBeDefined();
    await first.released;
    const long = holdInbound(session.id, 6000);
    expect(await settlePendingCompletions('ag-1', session.id)).toBe(false);
    expect(await getPendingCompletions(session.id)).toEqual(['stopped-3']);
    await long.released;
  }, 15_000);
});
