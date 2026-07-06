/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STARTUP_GRACE_MS,
  CLAIM_STUCK_MS,
  MCP_TOOL_CEILING_MS,
  _MAX_CONSECUTIVE_CLAIM_STUCK_KILLS_FOR_TESTING,
  _claimStuckHelpersForTesting,
  _resetStuckProcessingRowsForTesting,
  _resetFailedNotifyDedupForTesting,
  _shouldForceFailClaimStuckForTesting,
  _withTimeoutForTesting,
  _SweepTimeoutErrorForTesting,
  decideStuckAction,
  pickIdleTimeoutMs,
  parseSqliteUtc,
} from './host-sweep.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from './delivery.js';
import { getLatestHumanInboundMs } from './db/session-db.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
      idleTimeoutMs: ABSOLUTE_CEILING_MS + 60_000,
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('returns stop-idle when a warm container has no work past idle timeout', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 6 * 60 * 1000,
      containerState: null,
      claims: [],
      dueCount: 0,
      idleTimeoutMs: 5 * 60 * 1000,
    });
    expect(res.action).toBe('stop-idle');
  });

  it('does not stop-idle when due work exists', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 6 * 60 * 1000,
      containerState: null,
      claims: [],
      dueCount: 1,
      idleTimeoutMs: 5 * 60 * 1000,
    });
    expect(res.action).toBe('ok');
  });

  it('does not stop-idle when a message is still processing', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 6 * 60 * 1000,
      containerState: null,
      claims: [claim('msg-1', 30_000)],
      idleTimeoutMs: 5 * 60 * 1000,
    });
    expect(res.action).toBe('ok');
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('does NOT claim-stuck-kill a heartbeat-less container still inside the startup grace', () => {
    // Regression: 2026-05-18 Teddy DM silent ~12h. A container that claimed a
    // message but hasn't written its first heartbeat is still in provider
    // cold start (the runner's first touchHeartbeat is gated behind the SDK
    // stream open; codex cold start is 2–4 min). Killing it ~60s in,
    // mid-startup, every sweep, makes the message permanently unanswerable.
    // While no heartbeat exists, the wider CLAIM_STARTUP_GRACE_MS applies.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000; // past the OLD 60s tolerance…
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok'); // …but inside the startup grace ⇒ not stuck
  });

  it('claim-stuck-kills a heartbeat-less container once it exceeds the startup grace', () => {
    // A container that has burned the entire startup grace without ever
    // writing a heartbeat is genuinely wedged at the gate — kill it so a
    // fresh one can retry.
    const claimedAgeMs = CLAIM_STARTUP_GRACE_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.toleranceMs).toBe(CLAIM_STARTUP_GRACE_MS);
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('extends the ceiling while a non-Bash MCP tool is in flight', () => {
    // Repro of 2026-05-09 tico whatsapp_dm_teddy: long-running gws-docs MCP
    // call left the heartbeat untouched past 30 min. Old behavior killed the
    // container mid-tool with code=137. New behavior tolerates up to
    // MCP_TOOL_CEILING_MS while current_tool is an mcp__* tool.
    const fortyFiveMinMs = 45 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - fortyFiveMinMs,
      containerState: {
        current_tool: 'mcp__google__create_doc',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(BASE - fortyFiveMinMs).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('still kills past the MCP ceiling when an MCP tool is genuinely hung', () => {
    const overMcpCeiling = MCP_TOOL_CEILING_MS + 60_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - overMcpCeiling,
      containerState: {
        current_tool: 'mcp__google__create_doc',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(BASE - overMcpCeiling).toISOString(),
      },
      claims: [],
      idleTimeoutMs: overMcpCeiling + 60_000,
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(MCP_TOOL_CEILING_MS);
  });

  it('does not extend the ceiling for non-MCP, non-Bash tools', () => {
    // SDK builtins like Read/Edit/Glob complete in milliseconds — they should
    // not get the MCP grace window. Heartbeat older than 30 min with a
    // builtin in flight is still a stuck container.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - ABSOLUTE_CEILING_MS - 60_000,
      containerState: {
        current_tool: 'Read',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(BASE - ABSOLUTE_CEILING_MS - 60_000).toISOString(),
      },
      claims: [],
      idleTimeoutMs: ABSOLUTE_CEILING_MS * 2,
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
  });

  it('widens per-claim tolerance for a running MCP tool', () => {
    // A claim that's been processing for 45 min with the MCP tool still in
    // flight should not trip claim-stuck.
    const fortyFiveMinMs = 45 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - fortyFiveMinMs - 5_000,
      containerState: {
        current_tool: 'mcp__google__create_doc',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(BASE - fortyFiveMinMs).toISOString(),
      },
      claims: [claim('msg-1', fortyFiveMinMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });

  it('recovers a message stranded at status=processing (codex resume-deadlock wedge, 2026-05-18)', () => {
    // THE BUG: a codex resume deadlock leaves messages_in.status at
    // 'processing' (the in-container agent-runner claimed it, then the
    // turn hung and the container was reaped). The old reset path looked
    // up the row with a 'pending'-only filter, got undefined, skipped it,
    // then deleted its orphan processing_ack — stranding the message at
    // 'processing' forever with NO path to ever re-dispatch it. Observed
    // live: a Teddy DM silently wedged ~4h. This asserts the row is now
    // reset back to 'pending' (re-dispatchable) AND its orphan claim is
    // cleared — i.e. the wedge self-heals on the next sweep tick.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-proc', 1, 'chat', ?, 'processing', 0, '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    // Orphan claim cleared.
    expect(getProcessingClaims(outDb)).toEqual([]);
    // And the stranded message is back to 'pending' with backoff — the
    // wake path can now pick it up. Pre-fix this row stayed 'processing'.
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-proc') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('force-fails a processing-stranded message too (circuit-breaker drains the codex-wedge row)', () => {
    // Same strand shape, but the circuit-breaker has tripped. Force-fail
    // must terminate the 'processing' row (not skip it) so a repeated
    // codex-deadlock loop cannot keep the session immortal.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-proc-ff', 1, 'chat', ?, 'processing', 0, '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc-ff', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck', /* forceFail */ true);

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-proc-ff'").get() as { status: string };
    expect(row.status).toBe('failed');
  });

  it('does NOT resurrect a terminal (completed/failed) message even if a stale claim lingers', () => {
    // Guard the other direction: getRecoverableMessage must exclude
    // terminal states. A finished message with a leftover processing_ack
    // (e.g. ack write raced the completion) must stay terminal — only the
    // orphan claim is swept, the message is not re-dispatched.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-done', 1, 'chat', ?, 'completed', 0, '{}')",
      )
      .run(claimedAt);
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-failed', 2, 'chat', ?, 'failed', 3, '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'processing', ?)").run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-failed', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const rows = inDb
      .prepare("SELECT id, status FROM messages_in WHERE id IN ('m-done', 'm-failed') ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: 'm-done', status: 'completed' },
      { id: 'm-failed', status: 'failed' },
    ]);
  });
});

describe('failed-message user notification (Nicole Paik doodle 429, 2026-07-03)', () => {
  // A stub adapter that records every deliver() call. deliver resolves so the
  // fire-and-forget `.then()` in the notifier runs; we flush microtasks after.
  function stubAdapter(): { adapter: ChannelDeliveryAdapter; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const adapter: ChannelDeliveryAdapter = {
      async deliver(...args: unknown[]) {
        calls.push(args);
        return 'platform-msg-id';
      },
    };
    return { adapter, calls };
  }

  // Insert a message row already at MAX_TRIES so the reset path force-fails it
  // via the tries>=MAX_TRIES branch (not the circuit-breaker), then assert the
  // notification. MAX_TRIES is 5.
  function seedExhaustedMessage(
    inDb: Database.Database,
    outDb: Database.Database,
    id: string,
    fields: { kind?: string; trigger?: number; channel_type?: string | null; platform_id?: string | null } = {},
  ) {
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, trigger, channel_type, platform_id, thread_id, content)
         VALUES (?, ?, ?, ?, 'processing', 5, ?, ?, ?, NULL, '{}')`,
      )
      .run(
        id,
        Math.floor(Math.random() * 1e9),
        fields.kind ?? 'chat',
        claimedAt,
        fields.trigger ?? 1,
        fields.channel_type ?? 'telegram',
        fields.platform_id ?? 'chat-123',
      );
    outDb.prepare('INSERT INTO processing_ack VALUES (?, ?, ?)').run(id, 'processing', claimedAt);
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('delivers a friendly apology to the origin chat when a chat message is force-failed', async () => {
    _resetFailedNotifyDedupForTesting();
    const { adapter, calls } = stubAdapter();
    setDeliveryAdapter(adapter);
    const { inDb, outDb } = makeSessionDbs();
    seedExhaustedMessage(inDb, outDb, 'm-fail-notify');

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');
    await flush();

    expect(inDb.prepare("SELECT status FROM messages_in WHERE id='m-fail-notify'").get()).toEqual({ status: 'failed' });
    expect(calls).toHaveLength(1);
    const [channelType, platformId, threadId, kind, content] = calls[0] as string[];
    expect(channelType).toBe('telegram');
    expect(platformId).toBe('chat-123');
    expect(threadId).toBeNull();
    expect(kind).toBe('chat');
    expect(JSON.parse(content).text).toContain('send it again');
  });

  it('does NOT notify for system/task rows or accumulate-only (trigger=0) rows', async () => {
    _resetFailedNotifyDedupForTesting();
    const { adapter, calls } = stubAdapter();
    setDeliveryAdapter(adapter);
    const { inDb, outDb } = makeSessionDbs();
    seedExhaustedMessage(inDb, outDb, 'm-system', { kind: 'system' });
    seedExhaustedMessage(inDb, outDb, 'm-task', { kind: 'task' });
    seedExhaustedMessage(inDb, outDb, 'm-accumulate', { trigger: 0 });
    seedExhaustedMessage(inDb, outDb, 'm-agent', { channel_type: 'agent' });

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');
    await flush();

    // All four failed, none notified.
    expect(calls).toHaveLength(0);
  });

  it('dedupes: a batch of failed chat rows yields exactly one notification', async () => {
    _resetFailedNotifyDedupForTesting();
    const { adapter, calls } = stubAdapter();
    setDeliveryAdapter(adapter);
    const { inDb, outDb } = makeSessionDbs();
    seedExhaustedMessage(inDb, outDb, 'm-a');
    seedExhaustedMessage(inDb, outDb, 'm-b');
    seedExhaustedMessage(inDb, outDb, 'm-c');

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');
    await flush();

    expect(calls).toHaveLength(1);
  });

  it('also notifies when the circuit-breaker force-fails the batch', async () => {
    _resetFailedNotifyDedupForTesting();
    const { adapter, calls } = stubAdapter();
    setDeliveryAdapter(adapter);
    const { inDb, outDb } = makeSessionDbs();
    // tries below MAX so only forceFail path can fail it.
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, trigger, channel_type, platform_id, content)
         VALUES ('m-cb', 1, 'chat', ?, 'processing', 0, 1, 'telegram', 'chat-999', '{}')`,
      )
      .run(claimedAt);
    outDb.prepare('INSERT INTO processing_ack VALUES (?, ?, ?)').run('m-cb', 'processing', claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck', /* forceFail */ true);
    await flush();

    expect(inDb.prepare("SELECT status FROM messages_in WHERE id='m-cb'").get()).toEqual({ status: 'failed' });
    expect(calls).toHaveLength(1);
    expect((calls[0] as string[])[1]).toBe('chat-999');
  });
});

describe('claim-stuck circuit-breaker (2026-05-17 Degenerates infinite loop)', () => {
  it('shouldForceFail is false below the cap, true at/after it', () => {
    expect(_shouldForceFailClaimStuckForTesting(0)).toBe(false);
    expect(_shouldForceFailClaimStuckForTesting(_MAX_CONSECUTIVE_CLAIM_STUCK_KILLS_FOR_TESTING - 1)).toBe(false);
    expect(_shouldForceFailClaimStuckForTesting(_MAX_CONSECUTIVE_CLAIM_STUCK_KILLS_FOR_TESTING)).toBe(true);
    expect(_shouldForceFailClaimStuckForTesting(_MAX_CONSECUTIVE_CLAIM_STUCK_KILLS_FOR_TESTING + 9)).toBe(true);
  });

  it('kill counter bumps per call and clears in one shot, keyed per session', () => {
    const h = _claimStuckHelpersForTesting();
    h.reset();
    expect(h.count('sess-A')).toBe(0);
    expect(h.bump('sess-A')).toBe(1);
    expect(h.bump('sess-A')).toBe(2);
    expect(h.count('sess-A')).toBe(2);
    // Independent per session.
    expect(h.count('sess-B')).toBe(0);
    // A clean idle stop (or a tripped breaker) clears it in one shot.
    h.clear('sess-A');
    expect(h.count('sess-A')).toBe(0);
  });

  it('a clean idle stop resets progress so transient slowness never trips the breaker', () => {
    // The realistic non-bug path: a session stalls a few times, then a
    // container drains and idle-stops (clear), then stalls again. It must
    // NEVER reach the cap because each clean idle resets the count — only
    // an UNINTERRUPTED run of claim-stuck kills is a real loop.
    const h = _claimStuckHelpersForTesting();
    h.reset();
    for (let cycle = 0; cycle < 20; cycle++) {
      // a couple of stalls...
      h.bump('s');
      h.bump('s');
      expect(_shouldForceFailClaimStuckForTesting(h.count('s'))).toBe(false);
      // ...then the container recovers and idle-stops.
      h.clear('s');
    }
    expect(h.count('s')).toBe(0);
  });

  it('an uninterrupted run of claim-stuck kills trips the breaker at the cap', () => {
    const h = _claimStuckHelpersForTesting();
    h.reset();
    let tripped = false;
    for (let kill = 1; kill <= _MAX_CONSECUTIVE_CLAIM_STUCK_KILLS_FOR_TESTING; kill++) {
      const n = h.bump('s');
      if (_shouldForceFailClaimStuckForTesting(n)) tripped = true;
    }
    expect(tripped).toBe(true);
    expect(h.count('s')).toBe(_MAX_CONSECUTIVE_CLAIM_STUCK_KILLS_FOR_TESTING);
  });

  it('force-fail drains the poison batch regardless of tries OR pending backoff', () => {
    // The crux of the 2026-05-17 bug: the normal path skips in-backoff
    // rows (process_after in the future) WITHOUT bumping tries, so a
    // busy chat's tries=0 rows never reach MAX_TRIES and the loop never
    // ends. Force-fail must ignore both gates and fail every claimed row.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    // Row A: fresh (tries=0), no backoff — normal path would reset+backoff.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-fresh', 1, 'chat', ?, 'pending', 0, '{}')",
      )
      .run(claimedAt);
    // Row B: tries=0 but mid-backoff — normal path SKIPS it (never fails).
    //         This is the exact row class that made the loop immortal.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-backoff', 2, 'chat', ?, 'pending', ?, 0, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fresh', 'processing', ?)").run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-backoff', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck', /* forceFail */ true);

    // Both rows failed — including the in-backoff one the normal path
    // would have skipped forever — and orphan claims cleared.
    const rows = inDb
      .prepare("SELECT id, status FROM messages_in WHERE id IN ('m-fresh', 'm-backoff') ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: 'm-backoff', status: 'failed' },
      { id: 'm-fresh', status: 'failed' },
    ]);
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('without force-fail the in-backoff row still survives (proves the bug, and that the fix is opt-in)', () => {
    // Same setup, forceFail=false: the in-backoff row is skipped and
    // stays pending (the immortal-loop row). This pins WHY the
    // circuit-breaker is necessary — the normal path cannot drain it.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-immortal', 1, 'chat', ?, 'pending', ?, 0, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-immortal', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck' /* forceFail defaults false */);

    const row = inDb.prepare("SELECT status, tries FROM messages_in WHERE id = 'm-immortal'").get() as {
      status: string;
      tries: number;
    };
    expect(row.status).toBe('pending'); // survived — would re-stall the next container
    expect(row.tries).toBe(0); // never bumped — MAX_TRIES unreachable
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

describe('pickIdleTimeoutMs — adaptive keep-warm (2026-05-19, the "why is it so slow" fix)', () => {
  const BASE_IDLE = 120_000; // 2 min
  const ACTIVE_IDLE = 900_000; // 15 min
  const WINDOW = 900_000; // 15 min
  const NOW = 10_000_000;

  it('no human message ever (lastHumanInboundMs=0) ⇒ short timeout (background session, no RAM hoard)', () => {
    expect(
      pickIdleTimeoutMs({
        now: NOW,
        lastHumanInboundMs: 0,
        baseIdleMs: BASE_IDLE,
        activeIdleMs: ACTIVE_IDLE,
        activeWindowMs: WINDOW,
      }),
    ).toBe(BASE_IDLE);
  });

  it('human message just now ⇒ wide keep-warm (live conversation reuses warm app-server)', () => {
    expect(
      pickIdleTimeoutMs({
        now: NOW,
        lastHumanInboundMs: NOW - 30_000, // 30s ago
        baseIdleMs: BASE_IDLE,
        activeIdleMs: ACTIVE_IDLE,
        activeWindowMs: WINDOW,
      }),
    ).toBe(ACTIVE_IDLE);
  });

  it('human message exactly at the window edge ⇒ still wide (inclusive)', () => {
    expect(
      pickIdleTimeoutMs({
        now: NOW,
        lastHumanInboundMs: NOW - WINDOW,
        baseIdleMs: BASE_IDLE,
        activeIdleMs: ACTIVE_IDLE,
        activeWindowMs: WINDOW,
      }),
    ).toBe(ACTIVE_IDLE);
  });

  it('last human message older than the window ⇒ falls back to short timeout (conversation went idle)', () => {
    expect(
      pickIdleTimeoutMs({
        now: NOW,
        lastHumanInboundMs: NOW - (WINDOW + 1),
        baseIdleMs: BASE_IDLE,
        activeIdleMs: ACTIVE_IDLE,
        activeWindowMs: WINDOW,
      }),
    ).toBe(BASE_IDLE);
  });
});

describe('getLatestHumanInboundMs — only chat-sdk counts as "human"', () => {
  it('returns 0 when there are no messages at all', () => {
    const { inDb } = makeSessionDbs();
    expect(getLatestHumanInboundMs(inDb)).toBe(0);
  });

  it('returns 0 when the only rows are engine-internal (task/reflection/appr-note) — NOT a live conversation', () => {
    // The whole point: a background recurring-task session must NOT look
    // active, or it would keep its container warm forever.
    const { inDb } = makeSessionDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('t1', 1, 'task', '2026-05-19T00:00:00.000Z', 'pending', '{}')",
      )
      .run();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('r1', 2, 'reflection', '2026-05-19T00:01:00.000Z', 'completed', '{}')",
      )
      .run();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('a1', 3, 'appr-note', '2026-05-19T00:02:00.000Z', 'completed', '{}')",
      )
      .run();
    expect(getLatestHumanInboundMs(inDb)).toBe(0);
  });

  it('returns the latest chat-sdk timestamp, ignoring later engine-internal rows', () => {
    const { inDb } = makeSessionDbs();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('c1', 1, 'chat-sdk', '2026-05-19T00:00:00.000Z', 'completed', '{}')",
      )
      .run();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('c2', 2, 'chat-sdk', '2026-05-19T00:05:00.000Z', 'completed', '{}')",
      )
      .run();
    // A LATER task row must not move the "last human" needle.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('t9', 3, 'task', '2026-05-19T00:09:00.000Z', 'pending', '{}')",
      )
      .run();
    expect(getLatestHumanInboundMs(inDb)).toBe(Date.parse('2026-05-19T00:05:00.000Z'));
  });
});

describe('withTimeout — per-session sweep isolation (2026-05-19 group-wide freeze)', () => {
  // Root cause of the AI Friends RSS escalation: the sweep loop awaits
  // sessions sequentially, so one sweepSession() blocked on a wedged
  // inbound.db under VirtioFS stranded the entire tick and
  // setTimeout(sweep) never re-armed — every recurring task + due-wake
  // group-wide froze 3h45m. withTimeout bounds each session so the loop
  // abandons a hung one and continues.

  it('resolves with the value when the wrapped promise wins the race', async () => {
    const fast = Promise.resolve('swept');
    await expect(_withTimeoutForTesting(fast, 1000, 'sess-fast')).resolves.toBe('swept');
  });

  it('propagates the wrapped promise rejection unchanged (not masked as a timeout)', async () => {
    const boom = Promise.reject(new Error('sweepSession real failure'));
    await expect(_withTimeoutForTesting(boom, 1000, 'sess-err')).rejects.toThrow('sweepSession real failure');
  });

  it('rejects with SweepTimeoutError when the wrapped promise hangs past ms', async () => {
    vi.useFakeTimers();
    try {
      // A promise that never settles models the wedged-inbound.db
      // sweepSession that caused the outage.
      const hang = new Promise<void>(() => {});
      const raced = _withTimeoutForTesting(hang, 20_000, 'sess-wedged');
      const assertion = expect(raced).rejects.toBeInstanceOf(_SweepTimeoutErrorForTesting);
      await vi.advanceTimersByTimeAsync(20_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('SweepTimeoutError message names the session and the bound', async () => {
    vi.useFakeTimers();
    try {
      const hang = new Promise<void>(() => {});
      const raced = _withTimeoutForTesting(hang, 20_000, 'sess-xyz');
      const caught: Promise<Error> = raced.then(
        () => {
          throw new Error('expected timeout, got resolve');
        },
        (e: unknown) => e as Error,
      );
      await vi.advanceTimersByTimeAsync(20_001);
      const err = await caught;
      expect(err).toBeInstanceOf(_SweepTimeoutErrorForTesting);
      expect(err.message).toContain('sess-xyz');
      expect(err.message).toContain('20000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timeout timer on fast resolve (no leaked pending handle)', async () => {
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      await _withTimeoutForTesting(Promise.resolve(1), 50_000, 'sess-clean');
      // .finally(clearTimeout) ran — a leaked timer would otherwise keep
      // the event loop armed for 50s after the sweep moved on.
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
