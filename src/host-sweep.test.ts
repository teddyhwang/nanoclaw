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
  CLAIM_STUCK_MS,
  MCP_TOOL_CEILING_MS,
  _MAX_RECURRENCE_DEFERS_FOR_TESTING,
  _recurrenceDeferHelpersForTesting,
  _resetStuckProcessingRowsForTesting,
  _reviveStrandedRecurringTasksForTesting,
  _shouldRunRecurrenceForTesting,
  decideStuckAction,
  parseSqliteUtc,
} from './host-sweep.js';
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

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
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

describe('S405 lever 2 — recurrence write quiescing', () => {
  it('runs the recurrence immediately when no container is alive', () => {
    // The common, safe case: container idle-killed, inbound.db has a
    // single accessor, no torn-read risk — write through at 0 defers.
    expect(_shouldRunRecurrenceForTesting(false, 0)).toBe(true);
  });

  it('defers while a container is alive and under the cap', () => {
    expect(_shouldRunRecurrenceForTesting(true, 0)).toBe(false);
    expect(_shouldRunRecurrenceForTesting(true, _MAX_RECURRENCE_DEFERS_FOR_TESTING - 1)).toBe(false);
  });

  it('forces the write through once the defer cap is reached (no infinite defer)', () => {
    // A continuously-alive session must not have its schedule silently
    // frozen forever; at the cap we write and rely on lever 1's retry.
    expect(_shouldRunRecurrenceForTesting(true, _MAX_RECURRENCE_DEFERS_FOR_TESTING)).toBe(true);
    expect(_shouldRunRecurrenceForTesting(true, _MAX_RECURRENCE_DEFERS_FOR_TESTING + 3)).toBe(true);
  });

  it('defer counter bumps per call and clears in one shot', () => {
    const h = _recurrenceDeferHelpersForTesting();
    h.reset();
    expect(h.count('sess-A')).toBe(0);
    expect(h.bump('sess-A')).toBe(1);
    expect(h.bump('sess-A')).toBe(2);
    expect(h.count('sess-A')).toBe(2);
    // Independent per session.
    expect(h.count('sess-B')).toBe(0);
    h.clear('sess-A');
    expect(h.count('sess-A')).toBe(0);
  });

  it('reaching the cap then writing resets the counter so the next alive run defers again', () => {
    const h = _recurrenceDeferHelpersForTesting();
    h.reset();
    // Simulate MAX consecutive alive-sweeps of deferral.
    for (let i = 0; i < _MAX_RECURRENCE_DEFERS_FOR_TESTING; i++) h.bump('s');
    expect(h.count('s')).toBe(_MAX_RECURRENCE_DEFERS_FOR_TESTING);
    expect(_shouldRunRecurrenceForTesting(true, h.count('s'))).toBe(true);
    // sweepSession calls clearRecurrenceDefer when it writes through.
    h.clear('s');
    expect(h.count('s')).toBe(0);
    // Next alive sweep defers from zero again — bounded slip, not a
    // one-shot escape that then writes every sweep under load.
    expect(_shouldRunRecurrenceForTesting(true, h.count('s'))).toBe(false);
  });
});

describe('reviveStrandedRecurringTasks — closed-session revival', () => {
  const CLOSED: Session = {
    id: 'sess-closed',
    agent_group_id: 'ag-strand',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'closed',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-05-12T11:55:00.000Z',
  };
  const FRESH: Session = { ...CLOSED, id: 'sess-fresh', status: 'active' };

  // A real (in-memory) read-only-style handle so the predicate runs for real
  // rather than being stubbed — closer to production behaviour.
  function dbWith(due: boolean): Database.Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT, content TEXT NOT NULL);`);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content)
       VALUES ('t1', 0, 'task', '2026-05-16T12:00:00Z', 'pending', ?, '0 4 * * *', 'dream-ag-strand', '{}')`,
    ).run(due ? '2026-05-13T08:00:00.000Z' : '2026-05-20T08:00:00.000Z');
    return db;
  }

  function baseDeps(overrides: Record<string, unknown> = {}) {
    return {
      getAgentGroupIdsWithClosedNoActiveSessions: () => ['ag-strand'],
      getAgentGroup: () => ({ id: 'ag-strand' }) as never,
      findSessionByAgentGroup: () => undefined,
      getSessionsByAgentGroup: () => [CLOSED],
      inboundDbPath: () => '/fake/inbound.db',
      existsSync: () => true,
      now: () => '2026-05-16T12:00:00.000Z',
      ...overrides,
    };
  }

  it('creates a session and emits session.created when a due stranded task exists', async () => {
    const due = dbWith(true);
    const emit = vi.fn();
    const resolveSession = vi.fn(() => ({ session: FRESH, created: true }));
    await _reviveStrandedRecurringTasksForTesting(
      baseDeps({ openInboundReadonly: () => due, resolveSession, emitEngineEvent: emit }),
    );
    expect(resolveSession).toHaveBeenCalledWith('ag-strand', null, null, 'agent-shared');
    expect(emit).toHaveBeenCalledWith('session.created', { session: FRESH, created: true });
    due.close();
  });

  it('does nothing when the stranded recurring task is not yet due', async () => {
    const notDue = dbWith(false);
    const emit = vi.fn();
    const resolveSession = vi.fn(() => ({ session: FRESH, created: true }));
    await _reviveStrandedRecurringTasksForTesting(
      baseDeps({ openInboundReadonly: () => notDue, resolveSession, emitEngineEvent: emit }),
    );
    expect(resolveSession).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    notDue.close();
  });

  it('skips groups that already have an active session (race guard)', async () => {
    const due = dbWith(true);
    const emit = vi.fn();
    await _reviveStrandedRecurringTasksForTesting(
      baseDeps({
        findSessionByAgentGroup: () => FRESH, // active session appeared
        openInboundReadonly: () => due,
        resolveSession: vi.fn(() => ({ session: FRESH, created: true })),
        emitEngineEvent: emit,
      }),
    );
    expect(emit).not.toHaveBeenCalled();
    due.close();
  });

  it('does not emit when resolveSession reports an existing (not newly created) session', async () => {
    const due = dbWith(true);
    const emit = vi.fn();
    await _reviveStrandedRecurringTasksForTesting(
      baseDeps({
        openInboundReadonly: () => due,
        resolveSession: vi.fn(() => ({ session: FRESH, created: false })),
        emitEngineEvent: emit,
      }),
    );
    expect(emit).not.toHaveBeenCalled();
    due.close();
  });

  it('skips a closed session whose inbound.db is missing on disk', async () => {
    const emit = vi.fn();
    const resolveSession = vi.fn();
    await _reviveStrandedRecurringTasksForTesting(
      baseDeps({
        existsSync: () => false,
        openInboundReadonly: () => {
          throw new Error('should not open a missing db');
        },
        resolveSession,
        emitEngineEvent: emit,
      }),
    );
    expect(resolveSession).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores non-closed sessions returned for the group', async () => {
    const emit = vi.fn();
    await _reviveStrandedRecurringTasksForTesting(
      baseDeps({
        getSessionsByAgentGroup: () => [{ ...CLOSED, status: 'active' }],
        openInboundReadonly: () => {
          throw new Error('should not probe a non-closed session');
        },
        resolveSession: vi.fn(),
        emitEngineEvent: emit,
      }),
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
