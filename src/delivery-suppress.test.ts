/**
 * Outbound suppression and settle — the engine half of a host mid-turn stop.
 *
 * A suppressed row is closed as failed (never sent, never retried) without
 * agent-facing failure feedback. `settleSessionDelivery` lets an in-flight
 * send finish (it cannot be recalled) and then drains once, so every queued
 * row behind it meets the suppressor before it can reach the channel.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    DATA_DIR: '/tmp/nanoclaw-test-delivery-suppress',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-suppress/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-suppress';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { withExistingMailboxSession } from './session-manager.js';
import {
  deliverSessionMessages,
  dropSuppressedOutbound,
  registerOutboundSuppressor,
  setDeliveryAdapter,
  settleSessionDelivery,
} from './delivery.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

async function seedSession(): Promise<Session> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-1',
    name: 'Test Group',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
  return session;
}

let seq = 0;
function insertOutbound(sessionId: string, msgId: string, text: string, deliverAfter: string | null = null): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  seq += 1;
  db.prepare(
    `INSERT INTO messages_out (id, seq, timestamp, deliver_after, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, datetime('now', ?), ?, 'chat', 'chan-1', 'discord', NULL, ?)`,
  ).run(msgId, seq, `+${seq} seconds`, deliverAfter, JSON.stringify({ text }));
  db.close();
}

function deliveredStatus(sessionId: string, msgId: string): string | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string }
    | undefined;
  db.close();
  return row?.status;
}

function feedbackRows(sessionId: string): number {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  const row = db.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE id LIKE 'delivery-feedback:%'").get() as {
    n: number;
  };
  db.close();
  return row.n;
}

let unregister: Array<() => void> = [];

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  seq = 0;
});

afterEach(async () => {
  for (const off of unregister) off();
  unregister = [];
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('outbound suppressor', () => {
  it('drops suppressed rows quietly (failed, no feedback, never resent) and delivers the rest', async () => {
    const session = await seedSession();
    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        sent.push((JSON.parse(content) as { text: string }).text);
        return `d-${sent.length}`;
      },
    });
    insertOutbound(session.id, 'out-1', 'keep');
    insertOutbound(session.id, 'out-2', 'drop me');
    unregister.push(registerOutboundSuppressor((msg) => (msg.id === 'out-2' ? 'user-stop' : null)));

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(sent).toEqual(['keep']);
    expect(deliveredStatus(session.id, 'out-1')).toBe('delivered');
    expect(deliveredStatus(session.id, 'out-2')).toBe('failed');
    expect(feedbackRows(session.id)).toBe(0);
  });

  it('a throwing suppressor never blocks delivery', async () => {
    const session = await seedSession();
    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        sent.push((JSON.parse(content) as { text: string }).text);
        return 'x';
      },
    });
    insertOutbound(session.id, 'out-1', 'hello');
    unregister.push(
      registerOutboundSuppressor(() => {
        throw new Error('boom');
      }),
    );
    await deliverSessionMessages(session);
    expect(sent).toEqual(['hello']);
  });
});

describe('dropSuppressedOutbound', () => {
  it('drops suppressed rows whose deliver_after is still in the future; never sends anything', async () => {
    const session = await seedSession();
    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        sent.push((JSON.parse(content) as { text: string }).text);
        return 'x';
      },
    });
    insertOutbound(session.id, 'out-later', 'scheduled reply', '2099-01-01 00:00:00');
    insertOutbound(session.id, 'out-keep-later', 'other scheduled', '2099-01-01 00:00:00');
    unregister.push(registerOutboundSuppressor((msg) => (msg.id === 'out-later' ? 'user-stop' : null)));

    expect(await dropSuppressedOutbound(session.id)).toEqual(['out-later']);
    expect(sent).toEqual([]);
    expect(deliveredStatus(session.id, 'out-later')).toBe('failed');
    expect(deliveredStatus(session.id, 'out-keep-later')).toBeUndefined();
  });
});

describe('mailbox reads for a stop', () => {
  it('getDeliveredSince returns only rows actually delivered at or after the instant', async () => {
    const session = await seedSession();
    setDeliveryAdapter({ deliver: async () => 'p' });
    insertOutbound(session.id, 'out-1', 'one');
    await deliverSessionMessages(session);
    const after = new Date(Date.now() + 5).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    insertOutbound(session.id, 'out-2', 'two');
    insertOutbound(session.id, 'out-3', 'three');
    unregister.push(registerOutboundSuppressor((msg) => (msg.id === 'out-3' ? 'user-stop' : null)));
    await deliverSessionMessages(session);
    const rows = await withExistingMailboxSession('ag-1', session.id, (mailbox) => mailbox.getDeliveredSince(after));
    expect(rows?.map((r) => r.messageOutId)).toEqual(['out-2']);
  });
});

describe('settleSessionDelivery', () => {
  it('lets the in-flight send finish, then drops everything queued behind it', async () => {
    const session = await seedSession();
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        const text = (JSON.parse(content) as { text: string }).text;
        if (text === 'first') {
          entered();
          await gate;
        }
        sent.push(text);
        return `d-${sent.length}`;
      },
    });
    insertOutbound(session.id, 'out-1', 'first');
    insertOutbound(session.id, 'out-2', 'second');
    insertOutbound(session.id, 'out-3', 'third');

    const poll = deliverSessionMessages(session);
    await inFlight; // 'first' is now inside the channel send

    let stopped = false;
    unregister.push(registerOutboundSuppressor(() => (stopped ? 'user-stop' : null)));
    stopped = true;
    let settled = false;
    const settle = settleSessionDelivery(session.id).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false); // waits for the in-flight send

    release();
    await Promise.all([poll, settle]);

    expect(sent).toEqual(['first']);
    expect(deliveredStatus(session.id, 'out-1')).toBe('delivered');
    expect(deliveredStatus(session.id, 'out-2')).toBe('failed');
    expect(deliveredStatus(session.id, 'out-3')).toBe('failed');
  });

  it('resolves for an unknown session', async () => {
    await expect(settleSessionDelivery('sess-missing')).resolves.toBeUndefined();
  });
});
