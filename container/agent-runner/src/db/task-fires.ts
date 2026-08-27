/**
 * task_fires writer (container side).
 *
 * Records one row per scheduled-task-triggered turn so the dashboard can
 * surface "what did this recurring task do?" history. The host reads this
 * table read-only — same mount pattern as messages_out.
 *
 * Schema lives in the host's OUTBOUND_SCHEMA and is also defined by the
 * SQLite mailbox driver on lazy outbound open for forward compatibility.
 *
 * series_id is the load-bearing key: a recurring task's row id changes per
 * occurrence (host-sweep clones on completion) but series_id is stable, so
 * grouping by series_id reconstructs the per-task fire history.
 */
import { getAgentMailbox } from '../mailbox/index.js';
import type { TaskFireDispatch, TaskFireStatus, TaskFireWrite } from '../mailbox/types.js';

export type { TaskFireDispatch, TaskFireStatus };
export type WriteTaskFire = TaskFireWrite;

/**
 * Write through the registered mailbox so alternate drivers preserve the
 * per-fire history contract without runner code reaching around the seam.
 */
export function writeTaskFire(fire: WriteTaskFire): void {
  getAgentMailbox().operations.writeTaskFire(fire);
}
