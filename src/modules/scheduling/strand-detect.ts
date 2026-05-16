/**
 * Stranded-recurring-task detection (read-only predicate).
 *
 * A recurring `messages_in` task (cron `recurrence`, stable `series_id`,
 * future-then-overdue `process_after`) lives in one session's inbound.db.
 * When that session is closed AND the agent gets no further inbound, the
 * host sweep (which only iterates active sessions) never sees the row, and
 * the carry-forward / maintenance re-seed plugins (which fire on
 * `session.created`) never run — the task strands forever.
 *
 * This predicate answers, for a single closed session's inbound.db opened
 * READ-ONLY: "does this hold a recurring task that is actually due now and
 * should trigger a revival?" It is intentionally pure (db handle injected)
 * so it unit-tests against an in-memory DB with no filesystem or sweep
 * mocking, mirroring host-sweep.ts's `_shouldRunRecurrenceForTesting`
 * convention.
 *
 * The host never writes a closed session's inbound.db — detection is
 * read-only and the actual re-seed write goes to a fresh new session's
 * inbound.db, so the S405 torn-page hazard (host write into a
 * container-polled DB) is not in play here.
 */
import type Database from 'better-sqlite3';

/**
 * Predicate filter rationale (each clause maps to an edge case):
 *  - status = 'pending'       → excludes paused (status='paused') series,
 *                               which must NOT be revived, and
 *                               completed/cancelled rows.
 *  - recurrence IS NOT NULL   → excludes cancelled series (cancelTask nulls
 *                               recurrence on every pending/paused row).
 *  - series_id IS NOT NULL    → only series-bearing rows recur.
 *  - process_after <= @now    → only ACTUALLY-due rows trigger a revival.
 *                               A not-yet-due recurring row is left alone so
 *                               we don't spend a session before it's ready.
 *  - kind = 'task'            → recurring messages_in rows are tasks.
 */
const DUE_STRANDED_RECURRING_SQL = `
  SELECT 1 FROM messages_in
   WHERE kind = 'task'
     AND status = 'pending'
     AND recurrence IS NOT NULL
     AND series_id IS NOT NULL
     AND process_after IS NOT NULL
     AND process_after <= @now
   LIMIT 1`;

/**
 * True iff the given (read-only) inbound.db contains at least one recurring
 * task that is due as of `now` (ISO-8601 UTC, e.g. new Date().toISOString()).
 * SQLite TIMESTAMP columns store UTC without a zone marker; `process_after`
 * is always written as an ISO string with a trailing `Z` by the scheduler
 * and recurrence engine, so a lexical `<=` against an ISO-Z `now` is a
 * correct chronological comparison.
 */
export function hasDueStrandedRecurringTask(db: Database.Database, now: string): boolean {
  return db.prepare(DUE_STRANDED_RECURRING_SQL).get({ now }) !== undefined;
}

/** Test seam: the raw predicate SQL, for query-shape assertions. */
export const _DUE_STRANDED_RECURRING_SQL_FOR_TESTING = DUE_STRANDED_RECURRING_SQL;
