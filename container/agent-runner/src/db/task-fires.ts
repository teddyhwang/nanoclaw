/**
 * task_fires writer (container side).
 *
 * Records one row per scheduled-task-triggered turn so the dashboard can
 * surface "what did this recurring task do?" history. The host reads this
 * table read-only — same mount pattern as messages_out.
 *
 * Schema lives in src/db/schema.ts (OUTBOUND_SCHEMA) and is also defined
 * inline on lazy outbound.db open for forward-compat (see connection.ts).
 *
 * series_id is the load-bearing key: a recurring task's row id changes per
 * occurrence (host-sweep clones on completion) but series_id is stable, so
 * grouping by series_id reconstructs the per-task fire history.
 */
import { getOutboundDb } from './connection.js';

/**
 * Per-series retention cap. After each write we trim older fires for the
 * same series_id beyond this count. Per-series rather than time-based
 * because task cadences vary by ~5 orders of magnitude in practice (5-min
 * RSS pollers up through monthly maintenance), so a single TTL is either
 * too generous for the fast tasks or too aggressive for the slow ones.
 *
 * At cap=100: a 5-min task keeps ~8h of history; a 4h task keeps ~17 days;
 * a daily task keeps ~3 months. Enough in every regime to answer "did
 * this work recently?" without unbounded growth.
 */
const FIRES_PER_SERIES_CAP = 100;

export interface TaskFireDispatch {
  /** Destination name as written by the agent (`<message to="X">`). */
  destination: string;
  /** Body that was actually sent (post-strip). */
  body: string;
}

// 'gated' = the task's pre-task script ran and returned wakeAgent=false
// (or errored/produced no output), so the agent was never invoked. The
// task DID fire on schedule — recording it keeps a quiet script-gated
// task distinguishable from one that never ran at all. 'silent' is
// reserved for the agent running but emitting nothing.
export type TaskFireStatus = 'completed' | 'silent' | 'error' | 'gated';

export interface WriteTaskFire {
  id: string;
  seriesId: string;
  taskId: string;
  status: TaskFireStatus;
  /** Full SDK result text (raw, pre-dispatch). Null on errors before any
   *  result event arrived. */
  assistantText: string | null;
  dispatched: TaskFireDispatch[];
  /** Error message when status='error'. */
  errorMessage?: string | null;
}

export function writeTaskFire(fire: WriteTaskFire): void {
  const db = getOutboundDb();
  db.prepare(
    `INSERT INTO task_fires
       (id, series_id, task_id, fired_at, status, assistant_text, dispatched, error_message)
     VALUES
       ($id, $series_id, $task_id, datetime('now'), $status, $assistant_text, $dispatched, $error_message)`,
  ).run({
    $id: fire.id,
    $series_id: fire.seriesId,
    $task_id: fire.taskId,
    $status: fire.status,
    $assistant_text: fire.assistantText,
    $dispatched: JSON.stringify(fire.dispatched),
    $error_message: fire.errorMessage ?? null,
  });

  // Trim older fires for this series beyond the cap. NOT IN over the
  // newest-N keeps the most recent rows regardless of fired_at ties
  // (rowid acts as the tiebreaker via the subquery's implicit ORDER).
  // Scoped per series_id so a fast-firing task can't crowd a slow
  // sibling task out of its own history.
  db.prepare(
    `DELETE FROM task_fires
      WHERE series_id = $series_id
        AND id NOT IN (
          SELECT id FROM task_fires
           WHERE series_id = $series_id
           ORDER BY fired_at DESC
           LIMIT $cap
        )`,
  ).run({ $series_id: fire.seriesId, $cap: FIRES_PER_SERIES_CAP });
}
