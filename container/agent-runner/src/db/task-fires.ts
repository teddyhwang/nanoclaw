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

export interface TaskFireDispatch {
  /** Destination name as written by the agent (`<message to="X">`). */
  destination: string;
  /** Body that was actually sent (post-strip). */
  body: string;
}

export type TaskFireStatus = 'completed' | 'silent' | 'error';

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
}
