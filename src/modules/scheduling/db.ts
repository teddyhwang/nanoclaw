/**
 * Session-inbound.db helpers for the scheduling module.
 *
 * The task *series* now lives in the host-only agent-group schedule.db
 * (schedule-store.ts) — that is the source of truth and the S405 fix.
 * This file owns only the two things that still legitimately touch a
 * session's inbound.db:
 *
 *   1. `materializeOccurrence` — the single fire-time INSERT of one due
 *      occurrence (the host sweep's only inbound.db scheduling write).
 *   2. `projectSeriesSnapshot` — a read-only `task_series` snapshot the
 *      host writes into inbound.db in the same bounded sweep write window
 *      so the container's `list_tasks` can read its task list locally
 *      without ever touching schedule.db.
 *
 * The legacy `messages_in`-as-series helpers (insertTask / cancelTask /
 * getCompletedRecurring / …) are retained ONLY for the one-time boot
 * migration that imports pre-schedule.db live series out of old session
 * inbound.dbs (see migrate-legacy-series.ts). They are no longer on any
 * live scheduling path.
 */
import type Database from 'better-sqlite3';

import { nextEvenSeq } from '../../db/session-db.js';
import type { TaskSeriesRow } from './schedule-store.js';

export interface TaskContent {
  prompt: string;
  script: string | null;
  originSessionId: string | null;
}

/** Decode a task row's content envelope — the read half of insertTaskRow's encode. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    // LEGACY-COMPAT(v1-tasks): plain-string content from rows that predate the
    // JSON envelope. Removable once no pre-v2 session DBs remain in the wild.
    return { prompt: raw, script: null, originSessionId: null };
  }
}

/**
 * Materialize ONE due occurrence of a series into a session's inbound.db.
 *
 * This is the only scheduling write the host makes to inbound.db. It is a
 * fresh pending `kind='task'`, `trigger=1` row the container picks up
 * exactly like a wake message (countDueMessages / getDueTaskRows /
 * getPendingMessages). `process_after` and `recurrence` are NULL: the
 * occurrence is due *now* (it's only materialized because schedule.db said
 * the series was due), and recurrence bookkeeping belongs to schedule.db,
 * not this transient row. `series_id` carries the stable series handle so
 * task.fired plugins and downstream identity stamping keep working
 * unchanged. ON CONFLICT(id) DO NOTHING — the occurrence id is unique per
 * fire, so this only no-ops on a re-delivered id (defensive).
 */
export function materializeOccurrence(
  db: Database.Database,
  occ: {
    id: string;
    seriesId: string;
    kind: string;
    content: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id, trigger)
     VALUES (@id, @seq, datetime('now'), 'pending', 0, NULL, NULL, @kind, @platformId, @channelType, @threadId, @content, @seriesId, 1)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    id: occ.id,
    seriesId: occ.seriesId,
    kind: occ.kind,
    content: occ.content,
    platformId: occ.platformId,
    channelType: occ.channelType,
    threadId: occ.threadId,
    seq: nextEvenSeq(db),
  });
}

/**
 * True iff this session's inbound.db still holds an UNCONSUMED occurrence
 * for the series (pending or processing). Used by the materializer to
 * avoid stacking a second occurrence on top of a fire the container hasn't
 * picked up yet (slow/cold container) — the schedule still advances so the
 * cron clock doesn't drift, but the inbound.db isn't double-fed.
 */
export function sessionHasLiveSeriesRow(db: Database.Database, seriesId: string): boolean {
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

/**
 * Read-only `task_series` projection table. The container's list_tasks
 * runs inside the sandbox and can only see /workspace/inbound.db — it
 * cannot open the host-only schedule.db. So the host REPLACEs this
 * snapshot of the agent group's live series into the session's inbound.db
 * during the same single-writer sweep window as the fire INSERT (bounded,
 * not a separate per-tick churn path). list_tasks reads it locally; the
 * container never writes it (host-owned, like the rest of inbound.db).
 */
const TASK_SERIES_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_series (
  series_id     TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  recurrence    TEXT,
  process_after TEXT,
  content       TEXT NOT NULL
);`;

export function projectSeriesSnapshot(db: Database.Database, series: TaskSeriesRow[]): void {
  db.exec(TASK_SERIES_SNAPSHOT_SCHEMA);
  const tx = db.transaction((rows: TaskSeriesRow[]) => {
    db.prepare('DELETE FROM task_series').run();
    const stmt = db.prepare(
      `INSERT INTO task_series (series_id, status, recurrence, process_after, content)
       VALUES (@series_id, @status, @recurrence, @process_after, @content)`,
    );
    for (const r of rows) {
      stmt.run({
        series_id: r.series_id,
        status: r.status,
        recurrence: r.recurrence,
        process_after: r.process_after,
        content: r.content,
      });
    }
  });
  tx(series);
}

export function insertTask(
  db: Database.Database,
  task: {
    id: string;
    processAfter: string;
    recurrence: string | null;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    // Defaults to 'pending'. task-carry-forward passes 'paused' when the
    // operator paused a recurring task while its session was dormant —
    // without carrying status through the re-seed the pause silently
    // evaporates the moment a new message reactivates the session.
    status?: 'pending' | 'paused';
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
     VALUES (@id, @seq, datetime('now'), @status, 0, @processAfter, @recurrence, 'task', @platformId, @channelType, @threadId, @content, @id)`,
  ).run({
    ...task,
    status: task.status ?? 'pending',
    seq: nextEvenSeq(db),
  });
}

export function cancelTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE messages_in SET status = 'completed', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
  ).run(taskId, taskId);
}

export function pauseTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE messages_in SET status = 'paused' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'pending'",
  ).run(taskId, taskId);
}

export function resumeTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE messages_in SET status = 'pending' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'paused'",
  ).run(taskId, taskId);
}

export interface TaskUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

// Merges content JSON in-place so callers can update prompt/script without
// clobbering other fields. Matches by id OR series_id so the live next
// occurrence of a recurring task is updated, not just the completed row the
// agent last saw. Returns the number of rows touched.
export function updateTask(db: Database.Database, taskId: string, update: TaskUpdate): number {
  const rows = db
    .prepare(
      "SELECT id, content FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
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

      // Build SET clause dynamically so callers can update fields independently.
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
  kind: string;
  content: string;
  recurrence: string;
  process_after: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  series_id: string;
}

export function getCompletedRecurring(db: Database.Database): RecurringMessage[] {
  return db
    .prepare("SELECT * FROM messages_in WHERE status = 'completed' AND recurrence IS NOT NULL")
    .all() as RecurringMessage[];
}

/**
 * Distinct series_ids that currently have a completed-with-recurrence
 * row (i.e. are awaiting recurrence fanout). Lightweight projection of
 * getCompletedRecurring used by the host-sweep S405 lever-2 gate to
 * track defer pressure PER SERIES, so a high-frequency recurring task
 * sharing an inbound.db can't starve a co-resident low-frequency one
 * (degenerate dream-task 8-min orphan, 2026-05-16). `series_id` is
 * never null on these rows (insertRecurrence/insertTask always set it;
 * pre-migration rows backfilled to id), so no COALESCE needed.
 */
export function getDueRecurringSeriesIds(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT DISTINCT series_id FROM messages_in WHERE status = 'completed' AND recurrence IS NOT NULL")
    .all() as Array<{ series_id: string }>;
  return rows.map((r) => r.series_id);
}

export function insertRecurrence(
  db: Database.Database,
  msg: RecurringMessage,
  newId: string,
  nextRun: string | null,
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, platform_id, channel_type, thread_id, content, series_id)
     VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId,
    nextEvenSeq(db),
    msg.kind,
    nextRun,
    msg.recurrence,
    msg.platform_id,
    msg.channel_type,
    msg.thread_id,
    msg.content,
    msg.series_id,
  );
}

export function clearRecurrence(db: Database.Database, messageId: string): void {
  db.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ?').run(messageId);
}
