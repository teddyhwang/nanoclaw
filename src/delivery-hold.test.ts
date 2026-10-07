/**
 * Channel-unavailable holds and retry backoff.
 *
 * A `ChannelUnavailableError` (transport down, account logged out, adapter
 * missing) is a hold, not an attempt: the message keeps its retry budget, is
 * re-tried every 15s, and delivers in order once the channel recovers. Only a
 * hold older than 24h fails. Ordinary failures back off (5s, then 30s)
 * instead of burning all three attempts on consecutive 1s polls — the gap that
 * permanently lost a scheduled WhatsApp digest during a 2026-10-06 logout.
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
    DATA_DIR: '/tmp/nanoclaw-test-delivery-hold',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-hold/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-hold';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveryAttempt } from './db/coordination.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { ChannelUnavailableError, isChannelUnavailableError } from './channels/channel-unavailable.js';
import { MissingChannelAdapterError } from './channels/channel-registry.js';
import { engineEvents } from './engine/events.js';
import { hasPendingUserFacingOutbound } from './modules/typing/index.js';
import { log } from './log.js';
import type { Session } from './types.js';

const HOUR_MS = 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
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
    channel_type: 'whatsapp',
    platform_id: 'group@g.us',
    name: 'Test Group',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
  return session;
}

/** Rows are ordered by `timestamp`; `seq` keeps same-second inserts stable. */
let seq = 0;
function insertOutbound(sessionId: string, msgId: string, text: string, threadId: string | null = null): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  seq += 1;
  db.prepare(
    `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, datetime('now', ?), 'chat', 'group@g.us', 'whatsapp', ?, ?)`,
  ).run(msgId, seq, `+${seq} seconds`, threadId, JSON.stringify({ text }));
  db.close();
}

function deliveredRow(
  sessionId: string,
  msgId: string,
): { status: string; platform_message_id: string | null } | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  const row = db.prepare('SELECT status, platform_message_id FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string; platform_message_id: string | null }
    | undefined;
  db.close();
  return row;
}

/** Adapter whose availability the test flips; records every send it accepts. */
function controllableAdapter(): { sent: string[]; calls: number; available: boolean; fail: Error | null } {
  const state = { sent: [] as string[], calls: 0, available: false, fail: null as Error | null };
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      state.calls += 1;
      if (!state.available) throw new ChannelUnavailableError('whatsapp', 'socket disconnected');
      if (state.fail) throw state.fail;
      const text = (JSON.parse(content) as { text: string }).text;
      state.sent.push(text);
      return `wa-${state.sent.length}`;
    },
  });
  return state;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  seq = 0;
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('isChannelUnavailableError', () => {
  it('classifies the typed error, a structurally identical copy, and a missing adapter', () => {
    expect(isChannelUnavailableError(new ChannelUnavailableError('whatsapp', 'down'))).toBe(true);
    // A second module instance (separately installed engine) still matches.
    expect(isChannelUnavailableError(Object.assign(new Error('x'), { code: 'CHANNEL_UNAVAILABLE' }))).toBe(true);
    const missing = new MissingChannelAdapterError('whatsapp');
    expect(missing).toBeInstanceOf(ChannelUnavailableError);
    expect(isChannelUnavailableError(missing)).toBe(true);
    expect(missing.channelType).toBe('whatsapp');

    expect(isChannelUnavailableError(new Error('WhatsApp send returned no message id'))).toBe(false);
    expect(isChannelUnavailableError(null)).toBe(false);
    expect(isChannelUnavailableError('CHANNEL_UNAVAILABLE')).toBe(false);
  });
});

describe('channel-unavailable holds', () => {
  it('holds without spending attempts across a long outage, then delivers on recovery', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-digest', '3 new transactions');
    const adapter = controllableAdapter();

    // A four-hour outage, polled at the 15s hold cadence: the old path gave
    // up after three ~1s polls.
    for (let elapsed = 0; elapsed < 4 * HOUR_MS; elapsed += 15 * 60 * 1000) {
      await deliverSessionMessages(session);
      advance(15 * 60 * 1000);
    }
    expect(deliveredRow(session.id, 'out-digest')).toBeUndefined();
    const held = await getDeliveryAttempt('out-digest');
    expect(held?.attempts).toBe(0);
    expect(held?.last_error).toBe('whatsapp unavailable: socket disconnected');

    adapter.available = true;
    await deliverSessionMessages(session);
    expect(adapter.sent).toEqual(['3 new transactions']);
    expect(deliveredRow(session.id, 'out-digest')).toEqual({ status: 'delivered', platform_message_id: 'wa-1' });
    expect(await getDeliveryAttempt('out-digest')).toBeUndefined();
  });

  it('re-tries a held message only every 15s, not on every 1s active poll', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-1', 'hello');
    const adapter = controllableAdapter();

    await deliverSessionMessages(session);
    expect(adapter.calls).toBe(1);
    for (let i = 0; i < 10; i++) {
      advance(1_000);
      await deliverSessionMessages(session);
    }
    expect(adapter.calls).toBe(1);

    advance(5_001);
    await deliverSessionMessages(session);
    expect(adapter.calls).toBe(2);
  });

  it('keeps per-destination order: a later reply never overtakes a held one', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-held', 'first, written during the outage');
    insertOutbound(session.id, 'out-other-thread', 'other destination', 'thread-b');
    const adapter = controllableAdapter();

    await deliverSessionMessages(session);
    // The first message to the chat was held; the second destination is
    // independent and was attempted (and held) in its own right.
    expect(adapter.calls).toBe(2);

    // The channel recovers between polls and a new reply to the held chat is
    // written while the first message's 15s hold is still pending.
    adapter.available = true;
    insertOutbound(session.id, 'out-after', 'second, written after recovery');
    advance(1_000);
    await deliverSessionMessages(session);
    expect(adapter.sent).toEqual([]);
    expect(deliveredRow(session.id, 'out-after')).toBeUndefined();

    advance(15_000);
    await deliverSessionMessages(session);
    expect(adapter.sent).toEqual([
      'first, written during the outage',
      'other destination',
      'second, written after recovery',
    ]);
  });

  it('does not let holds launder the attempt budget of a genuinely failing message', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-poison', 'poison');
    const adapter = controllableAdapter();

    // Two real failures…
    adapter.available = true;
    adapter.fail = new Error('media upload rejected');
    await deliverSessionMessages(session);
    advance(5_001);
    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('out-poison'))?.attempts).toBe(2);

    // …an outage in between does not reset the count…
    adapter.available = false;
    advance(31_000);
    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('out-poison'))?.attempts).toBe(2);

    // …so the third real failure is still terminal.
    adapter.available = true;
    advance(15_001);
    await deliverSessionMessages(session);
    expect(deliveredRow(session.id, 'out-poison')).toEqual({ status: 'failed', platform_message_id: null });
  });

  it('fails a hold only after 24h measured from the start of the hold', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-stale', 'stale');
    controllableAdapter();
    const failed: string[] = [];
    const unsubscribe = engineEvents.on('outbound.failed', (event) => {
      failed.push(event.platformId);
    });

    await deliverSessionMessages(session);
    const firstHold = (await getDeliveryAttempt('out-stale'))?.last_attempt_at;

    // Re-tries during the window must not refresh the hold's start.
    advance(23 * HOUR_MS);
    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('out-stale'))?.last_attempt_at).toBe(firstHold);
    expect(deliveredRow(session.id, 'out-stale')).toBeUndefined();

    advance(HOUR_MS);
    await deliverSessionMessages(session);
    unsubscribe();
    expect(deliveredRow(session.id, 'out-stale')).toEqual({ status: 'failed', platform_message_id: null });
    expect(await getDeliveryAttempt('out-stale')).toBeUndefined();
    expect(failed).toEqual(['group@g.us']);
  });

  it('starts the hold clock of replies queued behind a held one, so a backlog fails after ~24h, not N×24h', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-first', 'first');
    controllableAdapter();

    await deliverSessionMessages(session);
    // Written an hour into the outage, while the first is still held.
    advance(HOUR_MS);
    insertOutbound(session.id, 'out-second', 'second');
    advance(15_001);
    await deliverSessionMessages(session);
    const queued = await getDeliveryAttempt('out-second');
    expect(queued?.attempts).toBe(0);
    expect(queued?.next_attempt_at).toBeNull(); // the mark adds no delay of its own
    const queuedAt = queued?.last_attempt_at;

    // Later drains do not move the queued message's clock.
    advance(HOUR_MS);
    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('out-second'))?.last_attempt_at).toBe(queuedAt);

    // 24h after the outage began the first fails; the second becomes the
    // front of the queue on the next drain and is held on its own clock.
    advance(22 * HOUR_MS);
    await deliverSessionMessages(session);
    expect(deliveredRow(session.id, 'out-first')?.status).toBe('failed');
    advance(15_001);
    await deliverSessionMessages(session);
    expect(deliveredRow(session.id, 'out-second')).toBeUndefined();

    // ~24h after it was first queued — not 24h after it reached the front.
    advance(HOUR_MS);
    await deliverSessionMessages(session);
    expect(deliveredRow(session.id, 'out-second')).toEqual({ status: 'failed', platform_message_id: null });
  });

  it('a queued reply still delivers in order once the channel recovers', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-a', 'a');
    insertOutbound(session.id, 'out-b', 'b');
    const adapter = controllableAdapter();

    await deliverSessionMessages(session);
    expect(adapter.calls).toBe(1); // b is queued behind a, not attempted
    adapter.available = true;
    advance(15_001);
    await deliverSessionMessages(session);
    expect(adapter.sent).toEqual(['a', 'b']);
    expect(await getDeliveryAttempt('out-b')).toBeUndefined();
  });

  it('does not report a reply queued behind a held one as imminent either', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-1', 'first');
    insertOutbound(session.id, 'out-2', 'second');
    controllableAdapter();

    await deliverSessionMessages(session);
    // out-1 held, out-2 queued behind it (attempt row, NULL next_attempt_at).
    expect((await getDeliveryAttempt('out-2'))?.next_attempt_at).toBeNull();
    expect(await hasPendingUserFacingOutbound('ag-1', session.id)).toBe(false);
  });

  it('does not report a held reply as imminent delivery to the typing refresher', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-1', 'hello');
    // Undelivered and never attempted: imminent.
    expect(await hasPendingUserFacingOutbound('ag-1', session.id)).toBe(true);

    const adapter = controllableAdapter();
    await deliverSessionMessages(session);
    expect(await hasPendingUserFacingOutbound('ag-1', session.id)).toBe(false);

    // Its 15s re-try comes due: imminent again.
    advance(15_001);
    expect(await hasPendingUserFacingOutbound('ag-1', session.id)).toBe(true);
    adapter.available = true;
    await deliverSessionMessages(session);
    expect(await hasPendingUserFacingOutbound('ag-1', session.id)).toBe(false);
  });

  it('warns once when a hold starts and keeps the 15s re-tries at debug', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-1', 'hello');
    controllableAdapter();
    const warn = vi.spyOn(log, 'warn');
    const debug = vi.spyOn(log, 'debug');

    await deliverSessionMessages(session);
    for (let i = 0; i < 3; i++) {
      advance(15_001);
      await deliverSessionMessages(session);
    }

    const holdWarnings = warn.mock.calls.filter(([msg]) => String(msg).startsWith('Channel unavailable'));
    const holdDebugs = debug.mock.calls.filter(([msg]) => String(msg).startsWith('Channel still unavailable'));
    expect(holdWarnings).toHaveLength(1);
    expect(holdDebugs).toHaveLength(3);
  });
});

describe('retry backoff for ordinary failures', () => {
  it('schedules 5s after the first failure and 30s after the second', async () => {
    const session = await seedSession();
    insertOutbound(session.id, 'out-flaky', 'flaky');
    const adapter = controllableAdapter();
    adapter.available = true;
    adapter.fail = new Error('HTTP 502');

    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('out-flaky'))?.next_attempt_at).toBe(new Date(Date.now() + 5_000).toISOString());

    advance(5_001);
    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('out-flaky'))?.next_attempt_at).toBe(new Date(Date.now() + 30_000).toISOString());

    // A blip that clears inside the backoff window now delivers instead of
    // exhausting the budget.
    adapter.fail = null;
    advance(30_001);
    await deliverSessionMessages(session);
    expect(deliveredRow(session.id, 'out-flaky')).toEqual({ status: 'delivered', platform_message_id: 'wa-1' });
  });
});
