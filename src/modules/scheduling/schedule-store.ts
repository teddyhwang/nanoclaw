/**
 * Agent-group-scoped scheduling store (host-only).
 *
 * Source of truth for task *series* (recurrence + next-fire + status).
 * Lives at `data/v2-sessions/<agentGroupId>/schedule.db`, ONE file per
 * agent group, opened ONLY by the host process. It is never bind-mounted
 * into a container and never read across the VirtioFS host↔container
 * boundary.
 *
 * Why this file exists (the S405 structural fix):
 *
 *   Before: a task series was a `messages_in` row in a *session's*
 *   inbound.db. Recurrence fanout (handleRecurrence) re-INSERTed the next
 *   occurrence into that same inbound.db every sweep tick. inbound.db is
 *   `journal_mode=DELETE` and continuously read by the container over a
 *   VirtioFS mount whose page propagation is non-atomic — so a host write
 *   that lands while the container is mid-poll is observed as a torn page
 *   (SQLITE_CORRUPT / CANTOPEN). On the never-idling merged Degenerates
 *   session this fired ~90×/day and crash-looped the runner. The fork
 *   accreted ~8 band-aid systems (S405 lever-2 recurrence-defer + per-series
 *   starvation tracker, stranded-task revival, strand-detect, sweep
 *   watchdog) all fighting that one race.
 *
 *   After: the schedule lives here. The host is the SOLE accessor, so this
 *   DB can be `journal_mode=WAL` and there is no cross-mount reader — the
 *   torn-page class is structurally impossible for the schedule. The host
 *   sweep materializes a single `kind='task'` row into inbound.db ONLY at
 *   fire time (the one unavoidable write, already lever-1 guarded on the
 *   container read side and idempotent per series). The every-tick churn
 *   and the closed-session strand class both disappear.
 *
 * Connection lifecycle: callers open-use-close per op, mirroring
 * session-db.ts. WAL is safe precisely because there is exactly one
 * accessor process; we still close handles promptly so a WAL checkpoint
 * is never starved.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { sessionsBaseDir } from '../../session-manager.js';

export type SeriesStatus = 'pending' | 'paused' | 'cancelled';

/**
 * One row per task *series*. `series_id` is the stable handle the agent
 * sees in list_tasks and passes to update/cancel/pause/resume — it equals
 * the original task id at schedule time and never changes across
 * recurrence occurrences (the inbound.db materialized rows get fresh ids
 * each fire, but they all carry this series_id).
 */
export const SCHEDULE_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_series (
  series_id      TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'task',
  recurrence     TEXT,                       -- cron expr, NULL for one-shot
  process_after  TEXT,                       -- ISO-Z; next fire time
  content        TEXT NOT NULL,              -- JSON {prompt, script, createdByUserId}
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|paused|cancelled
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_fired_at  TEXT                         -- ISO-Z of last materialization
);
CREATE INDEX IF NOT EXISTS idx_task_series_due
  ON task_series (status, process_after);
`;

export interface TaskSeriesRow {
  series_id: string;
  agent_group_id: string;
  kind: string;
  recurrence: string | null;
  process_after: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  status: SeriesStatus;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
}

/**
 * Absolute path to an agent group's schedule.db under an explicit
 * sessions base dir. The base-dir-explicit form exists so callers (and
 * tests) aren't bound to `config.ts`'s import-time `DATA_DIR` snapshot —
 * a host that calls `setEnginePaths()` after module load, or a test
 * pointing at a tmp tree, passes the base in directly.
 */
export function scheduleDbPathAt(baseDir: string, agentGroupId: string): string {
  return path.join(baseDir, agentGroupId, 'schedule.db');
}

/** Absolute path to an agent group's schedule.db (default sessions base). */
export function scheduleDbPath(agentGroupId: string): string {
  return scheduleDbPathAt(sessionsBaseDir(), agentGroupId);
}

/**
 * Open (creating + migrating if needed) an agent group's schedule.db
 * under an explicit sessions base dir. WAL is safe: the host process is
 * the only accessor and the file is never crossed by a VirtioFS mount.
 * Caller owns close().
 */
export function openScheduleDbAt(baseDir: string, agentGroupId: string): Database.Database {
  const dbPath = scheduleDbPathAt(baseDir, agentGroupId);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEDULE_SCHEMA);
  return db;
}

/** Open an agent group's schedule.db (default sessions base). */
export function openScheduleDb(agentGroupId: string): Database.Database {
  return openScheduleDbAt(sessionsBaseDir(), agentGroupId);
}

/** Schedule a new (or replace an existing) task series. */
export function upsertSeries(
  db: Database.Database,
  s: {
    seriesId: string;
    agentGroupId: string;
    kind?: string;
    recurrence: string | null;
    processAfter: string | null;
    content: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    status?: SeriesStatus;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_series
       (series_id, agent_group_id, kind, recurrence, process_after, content,
        platform_id, channel_type, thread_id, status, created_at, updated_at)
     VALUES
       (@seriesId, @agentGroupId, @kind, @recurrence, @processAfter, @content,
        @platformId, @channelType, @threadId, @status, @now, @now)
     ON CONFLICT(series_id) DO UPDATE SET
       recurrence    = excluded.recurrence,
       process_after = excluded.process_after,
       content       = excluded.content,
       platform_id   = excluded.platform_id,
       channel_type  = excluded.channel_type,
       thread_id     = excluded.thread_id,
       status        = excluded.status,
       updated_at    = excluded.updated_at`,
  ).run({
    seriesId: s.seriesId,
    agentGroupId: s.agentGroupId,
    kind: s.kind ?? 'task',
    recurrence: s.recurrence,
    processAfter: s.processAfter,
    content: s.content,
    platformId: s.platformId,
    channelType: s.channelType,
    threadId: s.threadId,
    status: s.status ?? 'pending',
    now,
  });
}

/**
 * Series that are due to fire as of `now` (ISO-Z): pending status with a
 * non-null process_after that has elapsed. Paused/cancelled never fire.
 * Lexical `<=` on ISO-Z strings is a correct chronological comparison
 * (same convention as strand-detect / countDueMessages).
 */
export function getDueSeries(db: Database.Database, now: string): TaskSeriesRow[] {
  return db
    .prepare(
      `SELECT * FROM task_series
        WHERE status = 'pending'
          AND process_after IS NOT NULL
          AND process_after <= @now
        ORDER BY process_after ASC`,
    )
    .all({ now }) as TaskSeriesRow[];
}

/**
 * After materializing a fire: advance a recurring series to its next
 * occurrence, or — for a one-shot — mark it cancelled (it has fired its
 * only occurrence and should never fire again). `nextRun` is null for a
 * one-shot. Always stamps last_fired_at so observability/telemetry can
 * see the series is live.
 */
export function advanceRecurrence(
  db: Database.Database,
  seriesId: string,
  nextRun: string | null,
  firedAt: string,
): void {
  if (nextRun === null) {
    db.prepare(
      `UPDATE task_series
          SET status = 'cancelled', process_after = NULL,
              last_fired_at = @firedAt, updated_at = @firedAt
        WHERE series_id = @seriesId`,
    ).run({ seriesId, firedAt });
    return;
  }
  db.prepare(
    `UPDATE task_series
        SET process_after = @nextRun,
            last_fired_at = @firedAt, updated_at = @firedAt
      WHERE series_id = @seriesId`,
  ).run({ seriesId, nextRun, firedAt });
}

/** Cancel a series (matches by series id). Terminal. */
export function cancelSeries(db: Database.Database, seriesId: string): number {
  return db
    .prepare(
      `UPDATE task_series SET status = 'cancelled', recurrence = NULL,
              updated_at = @now
        WHERE series_id = @seriesId AND status IN ('pending', 'paused')`,
    )
    .run({ seriesId, now: new Date().toISOString() }).changes;
}

/** Pause a pending series so it stops firing until resumed. */
export function pauseSeries(db: Database.Database, seriesId: string): number {
  return db
    .prepare(
      `UPDATE task_series SET status = 'paused', updated_at = @now
        WHERE series_id = @seriesId AND status = 'pending'`,
    )
    .run({ seriesId, now: new Date().toISOString() }).changes;
}

/** Resume a paused series. */
export function resumeSeries(db: Database.Database, seriesId: string): number {
  return db
    .prepare(
      `UPDATE task_series SET status = 'pending', updated_at = @now
        WHERE series_id = @seriesId AND status = 'paused'`,
    )
    .run({ seriesId, now: new Date().toISOString() }).changes;
}

export interface SeriesUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

/**
 * Update a live (pending|paused) series in place. Merges prompt/script
 * into the content JSON without clobbering other fields. Returns rows
 * touched (0 if no live series matched). Mirrors db.ts:updateTask
 * semantics so the MCP-tool contract is unchanged.
 */
export function updateSeries(db: Database.Database, seriesId: string, update: SeriesUpdate): number {
  const row = db
    .prepare(
      `SELECT content FROM task_series
        WHERE series_id = ? AND status IN ('pending', 'paused')`,
    )
    .get(seriesId) as { content: string } | undefined;
  if (!row) return 0;

  const sets: string[] = ['updated_at = @now'];
  const params: Record<string, unknown> = { seriesId, now: new Date().toISOString() };

  if (update.prompt !== undefined || update.script !== undefined) {
    const parsed = JSON.parse(row.content) as Record<string, unknown>;
    if (update.prompt !== undefined) parsed.prompt = update.prompt;
    if (update.script !== undefined) parsed.script = update.script;
    sets.push('content = @content');
    params.content = JSON.stringify(parsed);
  }
  if (update.processAfter !== undefined) {
    sets.push('process_after = @processAfter');
    params.processAfter = update.processAfter;
  }
  if (update.recurrence !== undefined) {
    sets.push('recurrence = @recurrence');
    params.recurrence = update.recurrence;
  }

  return db.prepare(`UPDATE task_series SET ${sets.join(', ')} WHERE series_id = @seriesId`).run(params).changes;
}

/**
 * All live (pending|paused) series for the agent group, latest-first by
 * next fire. Used to project the read-only `task_series` snapshot into
 * each session's inbound.db so the container's list_tasks can read it
 * locally without ever touching schedule.db.
 */
export function listLiveSeries(db: Database.Database): TaskSeriesRow[] {
  return db
    .prepare(
      `SELECT * FROM task_series
        WHERE status IN ('pending', 'paused')
        ORDER BY process_after ASC`,
    )
    .all() as TaskSeriesRow[];
}

/** True iff this series already exists (any status). Migration idempotency. */
export function hasSeries(db: Database.Database, seriesId: string): boolean {
  return db.prepare(`SELECT 1 FROM task_series WHERE series_id = ? LIMIT 1`).get(seriesId) !== undefined;
}
