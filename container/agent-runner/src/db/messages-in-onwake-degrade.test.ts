/**
 * Regression: getPendingMessages must gracefully degrade against a
 * pre-migration inbound.db that lacks the `on_wake` column (fix
 * 8ac3cf2). The container opens inbound.db read-only and cannot ALTER,
 * so when a session DB predates v2.0.48 the `on_wake` filter MUST be
 * dropped from the SELECT — referencing the missing column would throw
 * `SqliteError: no such column: on_wake` on every poll, which is a
 * container crash-loop (the exact class of v2-migration regression this
 * audit targets).
 *
 * `hasOnWakeColumn` probes `PRAGMA table_info` and conditionally omits
 * the filter. This was previously untouched by tests: the test harness
 * schema (connection.ts initTestSessionDb) always includes `on_wake`,
 * so the missing-column branch never ran. Here we DROP the column to
 * synthesize the legacy schema and pin both branches:
 *   - no on_wake column  → no crash, rows still returned (degrade).
 *   - on_wake column      → filter still applied (no regression of the
 *                            normal path).
 *
 * The schema-probe result is cached process-wide and has no production
 * reset (correct: one inbound.db per container). Across tests in one
 * process that cache leaks, so we reset it via the test-only export in
 * before/afterEach — without that, this file's result depends on
 * whether poll-loop.test.ts ran first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './connection.js';
import { getPendingMessages, _resetOnWakeCacheForTests, type MessageInRow } from './messages-in.js';

function insertPending(id: string, onWakeCol: boolean) {
  const db = getInboundDb();
  if (onWakeCol) {
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, on_wake, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', 1, 0, '{}')`,
    ).run(id, Math.floor(Math.random() * 1e9));
  } else {
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', 1, '{}')`,
    ).run(id, Math.floor(Math.random() * 1e9));
  }
}

beforeEach(() => {
  _resetOnWakeCacheForTests();
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  _resetOnWakeCacheForTests();
});

describe('getPendingMessages on_wake graceful degrade (8ac3cf2)', () => {
  it('pre-migration schema WITHOUT on_wake: returns rows, does not throw', () => {
    // Synthesize a legacy session DB by dropping the column the test
    // harness always adds. This is exactly the on-disk shape of an
    // inbound.db created before v2.0.48.
    getInboundDb().exec('ALTER TABLE messages_in DROP COLUMN on_wake');
    // Cache must re-probe AFTER the drop, not reuse a true from init.
    _resetOnWakeCacheForTests();

    insertPending('legacy-1', false);
    insertPending('legacy-2', false);

    // Pre-fix: this throws `no such column: on_wake` (crash-loop).
    let rows: MessageInRow[] = [];
    expect(() => {
      rows = getPendingMessages();
    }).not.toThrow();
    expect(rows.map((r) => r.id).sort()).toEqual(['legacy-1', 'legacy-2']);
  });

  it('first-poll on a pre-migration schema also does not throw', () => {
    // isFirstPoll=true is the path that binds ?1 against the on_wake
    // filter — must still be clean when the filter is omitted.
    getInboundDb().exec('ALTER TABLE messages_in DROP COLUMN on_wake');
    _resetOnWakeCacheForTests();

    insertPending('legacy-fp', false);

    let rows: MessageInRow[] = [];
    expect(() => {
      rows = getPendingMessages(true);
    }).not.toThrow();
    expect(rows.map((r) => r.id)).toContain('legacy-fp');
  });

  it('modern schema WITH on_wake: filter still applies (no normal-path regression)', () => {
    // on_wake=1 rows are wake-only: excluded on a non-first poll,
    // included on the first poll. Pins that fixing the degrade did not
    // weaken the real filter.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, on_wake, content)
       VALUES ('wake-only', 1, 'chat', datetime('now'), 'pending', 1, 1, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, on_wake, content)
       VALUES ('normal', 2, 'chat', datetime('now'), 'pending', 1, 0, '{}')`,
    ).run();

    const nonFirst = getPendingMessages(false).map((r) => r.id);
    expect(nonFirst).toContain('normal');
    expect(nonFirst).not.toContain('wake-only');

    const first = getPendingMessages(true).map((r) => r.id);
    expect(first).toContain('normal');
    expect(first).toContain('wake-only');
  });
});
