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
  resolveSession,
  writeSessionMessage,
  writeSessionRouting,
} from './session-manager.js';
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
