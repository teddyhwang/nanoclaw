/**
 * SQLite task helpers used by the SQLite mailbox driver.
 *
 * Session-mailbox task rows remain compatibility primitives for the v2.3
 * mailbox seam. They are not NanoClaw Optimus's scheduling source of truth:
 * live series stay in the host-only, agent-group-scoped `schedule.db`.
 *
 * The three S405 operations at the end of this file are intentionally narrow:
 * one fire-time occurrence insert, one unconsumed-occurrence probe, and one
 * replacement of the container-visible live-series snapshot. They never open
 * `schedule.db`; callers supply rows read by the host scheduling store.
 */
import type Database from 'better-sqlite3';

import { createTaskInboundRecord, createTaskOccurrenceInboundRecord, parseTaskSeriesSnapshotRecord } from '../model.js';
import type { TaskOccurrenceWrite, TaskSeriesSnapshotRecord, TaskWrite } from '../model.js';
import { nextEvenSeq } from './session-db.js';

/**
 * Insert one pending task occurrence. `seriesId` is the series join key — equal
 * to `id` for a brand-new mailbox series, or the existing series for a
 * recurrence clone or an on-demand run.
 */
export function insertTaskRow(db: Database.Database, row: TaskWrite, sequence = nextEvenSeq(db)): void {
  const record = createTaskInboundRecord(row, sequence, new Date().toISOString());
  db.prepare(
    `INSERT INTO messages_in
       (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
        platform_id, channel_type, thread_id, content, source_session_id, on_wake)
     VALUES
       (@id, @sequence, @kind, @timestamp, @status, @processAfter, @recurrence, @seriesId, @tries, @trigger,
        @platformId, @channelType, @threadId, @content, @sourceSessionId, @onWake)`,
  ).run({
    ...record,
    trigger: record.trigger ? 1 : 0,
    onWake: record.onWake ? 1 : 0,
  });
}

// Cancel marks the live row 'cancelled' (not 'completed') so a never-fired
// occurrence is distinguishable from a real run and never inflates run history;
// recurrence is cleared so mailbox compatibility recurrence cannot re-arm it.
export function cancelTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run(taskId, taskId).changes;
}

export function cancelAllTasks(db: Database.Database): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run().changes;
}

export function pauseTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'paused' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'pending'",
    )
    .run(taskId, taskId).changes;
}

export function resumeTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'pending' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'paused'",
    )
    .run(taskId, taskId).changes;
}

export function deleteTask(db: Database.Database, taskId: string): number {
  return db.prepare("DELETE FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task'").run(taskId, taskId)
    .changes;
}

export interface TaskUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

// Merges content JSON in-place so callers can update prompt/script without
// clobbering other fields. Due occurrences are already execution candidates and
// remain immutable; only future pending or paused occurrences are updated.
export function updateTask(db: Database.Database, taskId: string, update: TaskUpdate): number {
  const rows = db
    .prepare(
      `SELECT id, content FROM messages_in
       WHERE (id = ? OR series_id = ?)
         AND kind = 'task'
         AND (status = 'paused' OR (status = 'pending' AND datetime(process_after) > datetime('now')))`,
    )
    .all(taskId, taskId) as Array<{ id: string; content: string }>;

  if (rows.length === 0) return 0;

  const setProcessAfter = update.processAfter !== undefined;
  const setRecurrence = update.recurrence !== undefined;
  const mergeContent = update.prompt !== undefined || update.script !== undefined;

  const tx = db.transaction(() => {
    for (const row of rows) {
      let content = row.content;
      if (mergeContent) {
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        if (update.prompt !== undefined) parsed.prompt = update.prompt;
        if (update.script !== undefined) parsed.script = update.script;
        content = JSON.stringify(parsed);
      }

      const sets: string[] = ['content = ?'];
      const params: unknown[] = [content];
      if (setProcessAfter) {
        sets.push('process_after = ?');
        params.push(update.processAfter);
      }
      if (setRecurrence) {
        sets.push('recurrence = ?');
        params.push(update.recurrence);
      }
      params.push(row.id);

      db.prepare(`UPDATE messages_in SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
  });
  tx();
  return rows.length;
}

export interface RecurringMessage {
  id: string;
  content: string;
  recurrence: string;
  series_id: string;
}

// Failed occurrences re-arm too in the upstream mailbox compatibility model.
// S405 live recurrence never calls this helper; its clock lives in schedule.db.
export function getCompletedRecurring(db: Database.Database): RecurringMessage[] {
  return db
    .prepare("SELECT * FROM messages_in WHERE status IN ('completed', 'failed') AND recurrence IS NOT NULL")
    .all() as RecurringMessage[];
}

export function trailingFailedRuns(db: Database.Database, seriesKey: string): number {
  const rows = db
    .prepare(
      `SELECT status FROM messages_in
        WHERE (series_id = ? OR id = ?) AND kind = 'task' AND status IN ('completed', 'failed')
        ORDER BY seq DESC`,
    )
    .all(seriesKey, seriesKey) as Array<{ status: string }>;
  let streak = 0;
  for (const row of rows) {
    if (row.status !== 'failed') break;
    streak++;
  }
  return streak;
}

export function insertRecurrence(
  db: Database.Database,
  msg: RecurringMessage,
  newId: string,
  nextRun: string | null,
  status: 'pending' | 'paused' = 'pending',
): void {
  insertTaskRow(db, {
    id: newId,
    seriesId: msg.series_id,
    processAfter: nextRun,
    recurrence: msg.recurrence,
    content: msg.content,
    status,
  });
}

export function clearRecurrence(db: Database.Database, messageId: string): void {
  db.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ?').run(messageId);
}

// ---------------------------------------------------------------------------
// S405 host-scheduling mailbox capability
// ---------------------------------------------------------------------------

export type { TaskOccurrenceWrite, TaskSeriesSnapshotRecord } from '../model.js';

/**
 * Materialize one due schedule.db occurrence in a session mailbox. Recurrence
 * and process_after stay null because schedule.db owns both fields.
 */
export function materializeTaskOccurrence(db: Database.Database, occurrence: TaskOccurrenceWrite): void {
  const record = createTaskOccurrenceInboundRecord(occurrence, nextEvenSeq(db), new Date().toISOString());
  db.prepare(
    `INSERT INTO messages_in
       (id, seq, timestamp, status, tries, process_after, recurrence, kind,
        platform_id, channel_type, thread_id, content, series_id, trigger,
        source_session_id, on_wake)
     VALUES
       (@id, @sequence, @timestamp, @status, @tries, @processAfter, @recurrence, @kind,
        @platformId, @channelType, @threadId, @content, @seriesId, @trigger, @sourceSessionId, @onWake)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    ...record,
    trigger: record.trigger ? 1 : 0,
    onWake: record.onWake ? 1 : 0,
  });
}

/** True when an earlier fire of this series is still pending or processing. */
export function hasLiveTaskOccurrence(db: Database.Database, seriesId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM messages_in
          WHERE series_id = ? AND kind = 'task'
            AND status IN ('pending', 'processing') LIMIT 1`,
      )
      .get(seriesId) !== undefined
  );
}

const TASK_SERIES_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_series (
  series_id     TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  recurrence    TEXT,
  process_after TEXT,
  content       TEXT NOT NULL
);`;

interface LegacyTaskSeriesSnapshotRow {
  series_id: string;
  status: string;
  recurrence: string | null;
  process_after: string | null;
  content: string;
}

type TaskSeriesSnapshotInput = TaskSeriesSnapshotRecord | LegacyTaskSeriesSnapshotRow;

function canonicalSnapshot(row: TaskSeriesSnapshotInput): TaskSeriesSnapshotRecord {
  return parseTaskSeriesSnapshotRecord(
    'seriesId' in row
      ? row
      : {
          seriesId: row.series_id,
          status: row.status,
          recurrence: row.recurrence,
          processAfter: row.process_after,
          content: row.content,
        },
  );
}

/** Replace the read-only, container-visible projection of live schedule rows. */
export function replaceTaskSeriesSnapshot(db: Database.Database, series: readonly TaskSeriesSnapshotInput[]): void {
  db.exec(TASK_SERIES_SNAPSHOT_SCHEMA);
  const tx = db.transaction((rows: readonly TaskSeriesSnapshotInput[]) => {
    db.prepare('DELETE FROM task_series').run();
    const insert = db.prepare(
      `INSERT INTO task_series (series_id, status, recurrence, process_after, content)
       VALUES (@seriesId, @status, @recurrence, @processAfter, @content)`,
    );
    for (const row of rows) insert.run(canonicalSnapshot(row));
  });
  tx(series);
}
