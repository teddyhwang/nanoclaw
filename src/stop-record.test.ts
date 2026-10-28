/**
 * A host Stop's owed completions (db/pending-completions.ts): stopped inputs
 * are never failed, notified, carried forward or replayed, even when every
 * write that could record or settle them fails; a stuck debt alerts once;
 * records are cleaned up; guarded actions see their originating row id.
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
    DATA_DIR: '/tmp/nanoclaw-test-stop-record',
    GROUPS_DIR: '/tmp/nanoclaw-test-stop-record/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-stop-record';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup, getDb } from './db/index.js';
import { updateSession } from './db/sessions.js';
import {
  _resetPendingCompletionsMemoryForTesting,
  getPendingCompletions,
  prunePendingCompletions,
  recordPendingCompletions,
} from './db/pending-completions.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import {
  _carryForwardRecentPendingChatRowsForTesting,
  completeInboundDurably,
  destroySessionMailbox,
  resolveSession,
  settlePendingCompletions,
  withExistingMailboxSession,
  writeSessionMessage,
} from './session-manager.js';
import {
  _resetOwedStuckForTesting,
  _resetStuckProcessingRowsForTesting,
  reconcileSession,
} from './reconcile-session.js';
import { engineEvents } from './engine/events.js';
import { setDeliveryAdapter } from './delivery.js';
import { runGuarded, splitReplayPayload, DELIVERY_MESSAGE_ID_KEY, holdContext } from './delivery-guard.js';
import { defineGuardedAction } from './guard/guard-actions.js';
import { ALLOW, HOLD } from './guard/types.js';
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

function holdInbound(sessionId: string, ms: number) {
  const reader = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM messages_in').get();
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      reader.exec('COMMIT');
      reader.close();
      resolve();
    }, ms),
  );
}

function statusOf(sessionId: string, id: string): string | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  try {
    return (db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string } | undefined)
      ?.status;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  _resetPendingCompletionsMemoryForTesting();
  _resetOwedStuckForTesting();
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('1. a stopped input is never failed or notified', () => {
  it('the stuck-claim reset leaves an owed input alone, even past MAX_TRIES', async () => {
    const session = await seed();
    await pendingChat(session.id, 'stopped');
    await pendingChat(session.id, 'other');
    const inbound = new Database(inboundDbPath('ag-1', session.id));
    inbound.prepare("UPDATE messages_in SET status = 'processing', tries = 9").run();
    inbound.close();
    const outbound = new Database(outboundDbPath('ag-1', session.id));
    for (const id of ['stopped', 'other'])
      outbound.prepare("INSERT INTO processing_ack VALUES (?, 'processing', datetime('now'))").run(id);
    outbound.close();
    const deliver = vi.fn(async () => undefined);
    setDeliveryAdapter({ deliver });
    await withExistingMailboxSession('ag-1', session.id, (mailbox) =>
      _resetStuckProcessingRowsForTesting(mailbox, mailbox, session, 'claim-stuck', false, new Set(['stopped'])),
    );
    expect(statusOf(session.id, 'stopped')).toBe('processing');
    expect(statusOf(session.id, 'other')).toBe('failed');
    // The one failure notice is for the other input only.
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('2. no replay even when recording the stop fails', () => {
  it('central DB down and mailbox locked: the host file keeps it across a restart; nothing runs or carries it', async () => {
    const session = await seed();
    await pendingChat(session.id, 'stopped');
    // The central DB record fails (table unavailable) and the runner holds
    // the mailbox, for both Stop attempts.
    await getDb().exec('ALTER TABLE pending_inbound_completions RENAME TO pic_away');
    const lock = holdInbound(session.id, 200);
    for (let i = 0; i < 2; i++)
      await expect(
        completeInboundDurably('ag-1', session.id, ['stopped'], { reason: 'user-stop' }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });
    await lock;
    // While the DB cannot even be read, no runner may start.
    expect(await settlePendingCompletions('ag-1', session.id)).toBe(false);
    // The host restarts (memory gone); the DB is back but holds no row.
    await getDb().exec('ALTER TABLE pic_away RENAME TO pending_inbound_completions');
    _resetPendingCompletionsMemoryForTesting();
    expect(await getPendingCompletions(session.id)).toEqual(['stopped']);
    // Carry-forward into a new session never copies it.
    await updateSession(session.id, { status: 'closed' });
    const next = (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
    await _carryForwardRecentPendingChatRowsForTesting('ag-1', 'mg-1', null, next.id);
    expect(statusOf(next.id, 'stopped')).toBeUndefined();
    // Before any runner starts, the settle completes it; nothing is owed.
    expect(await settlePendingCompletions('ag-1', session.id)).toBe(true);
    expect(statusOf(session.id, 'stopped')).toBe('completed');
    expect(await getPendingCompletions(session.id)).toEqual([]);
  });
});

describe('3. a stuck debt alerts once per episode', () => {
  it('emits completions.stuck once after 3 unsettled passes, again only for a new episode', async () => {
    const session = await seed();
    await pendingChat(session.id, 'stopped');
    await recordPendingCompletions(session.id, ['stopped'], 'user-stop');
    const events: unknown[] = [];
    const off = engineEvents.on('completions.stuck', (e) => {
      events.push(e);
    });
    try {
      const pass = async () => {
        const lock = holdInbound(session.id, 150);
        await reconcileSession(session.id);
        await lock;
      };
      for (let i = 0; i < 5; i++) await pass();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sessionId: session.id, passes: 3, owedCount: 1 });
      await reconcileSession(session.id); // settles
      expect(await getPendingCompletions(session.id)).toEqual([]);
      await pendingChat(session.id, 'stopped-2');
      await recordPendingCompletions(session.id, ['stopped-2'], 'user-stop');
      for (let i = 0; i < 3; i++) await pass();
      expect(events).toHaveLength(2);
    } finally {
      off();
    }
  });
});

describe('4. cleanup', () => {
  it('destroying the mailbox clears its records', async () => {
    const session = await seed();
    await recordPendingCompletions(session.id, ['a', 'b'], 'user-stop');
    await destroySessionMailbox('ag-1', session.id);
    expect(await getPendingCompletions(session.id)).toEqual([]);
  });

  it('prune drops gone sessions, closed sessions past 25 h and anything past 7 d; keeps live debts', async () => {
    const live = await seed();
    await recordPendingCompletions(live.id, ['live-new'], 'user-stop');
    await recordPendingCompletions('sess-gone', ['gone'], 'user-stop');
    await getDb().run(
      "INSERT INTO pending_inbound_completions VALUES (?, 'live-ancient', 'user-stop', ?)",
      live.id,
      new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
    );
    await updateSession(live.id, { status: 'closed' });
    const closedNow = await getPendingCompletions(live.id);
    expect(closedNow.sort()).toEqual(['live-ancient', 'live-new']);
    // Right now: the ancient one and the gone session's go; the closed
    // session's fresh record stays (carry-forward could still see its row).
    await prunePendingCompletions();
    expect(await getPendingCompletions(live.id)).toEqual(['live-new']);
    expect(await getPendingCompletions('sess-gone')).toEqual([]);
    // 26 h later the closed session's record goes too.
    await prunePendingCompletions(Date.now() + 26 * 3600_000);
    expect(await getPendingCompletions(live.id)).toEqual([]);
  });
});

describe('5. guarded actions see their originating row id', () => {
  const session = { id: 's', agent_group_id: 'ag' } as Session;

  it('a fresh allowed dispatch passes the context to the handler', async () => {
    const handler = vi.fn(async () => undefined);
    const spec = {
      guardAction: defineGuardedAction({ action: 'test.stoprec.allow', decide: () => ALLOW('ok') }),
      requestHold: vi.fn(async () => undefined),
    };
    await runGuarded('test.stoprec.allow', spec, handler, { a: 1 }, session, null, { messageId: 'out-1' });
    expect(handler).toHaveBeenCalledWith({ a: 1 }, session, { messageId: 'out-1' });
  });

  it('a hold remembers the row id and the approved replay hands it back', async () => {
    let seen: unknown;
    const spec = {
      guardAction: defineGuardedAction({ action: 'test.stoprec.hold', decide: () => HOLD('ask') }),
      requestHold: vi.fn(async () => {
        seen = holdContext();
      }),
    };
    await runGuarded('test.stoprec.hold', spec, vi.fn(), { a: 1 }, session, null, { messageId: 'out-2' });
    expect(seen).toEqual({ messageId: 'out-2' });
    expect(holdContext()).toBeUndefined();
    // requestApproval stores it under the reserved key; the replay splits it.
    expect(splitReplayPayload({ a: 1, [DELIVERY_MESSAGE_ID_KEY]: 'out-2' })).toEqual({
      content: { a: 1 },
      context: { messageId: 'out-2' },
    });
    expect(splitReplayPayload({ a: 1 })).toEqual({ content: { a: 1 } });
  });
});
