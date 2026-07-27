/**
 * Fire-time materialization of scheduled task series.
 *
 * The schedule (series, recurrence, next-fire, status) is the host-only
 * agent-group `schedule.db` (schedule-store.ts). This hook runs each sweep
 * tick for an active session and does exactly one thing:
 *
 *   For every series in the agent group's schedule.db that is DUE as of
 *   now, INSERT exactly one pending `kind='task'` occurrence row into THIS
 *   session's inbound.db, then advance the series in schedule.db (compute
 *   the next cron occurrence, or cancel a one-shot).
 *
 * Why this replaces the old handleRecurrence:
 *
 *   The old model stored the series IN the session inbound.db and
 *   re-INSERTed the next occurrence into that same inbound.db every sweep
 *   tick. inbound.db is `journal_mode=DELETE` and continuously read by the
 *   container over a non-atomic VirtioFS mount, so the every-tick host
 *   write raced the container poll → torn pages → S405 crash-loop on the
 *   never-idling merged session. The fork accreted ~8 band-aid systems
 *   (recurrence-defer cap, per-series starvation tracker, stranded-task
 *   revival, strand-detect, sweep watchdog) all fighting that one race.
 *
 *   Now: recurrence math + next-fire bookkeeping happen in schedule.db,
 *   which the host owns alone (no VirtioFS reader → no torn-page class).
 *   The only inbound.db write is the single fire-time occurrence INSERT —
 *   the same one unavoidable write the wake path already performs, already
 *   guarded by container-side lever-1 (withInboundDb retry) and made
 *   idempotent here (skip if a live occurrence for the series already
 *   exists, plus ON CONFLICT(id) DO NOTHING on the occurrence id). A slow
 *   container can no longer get a duplicate fire, and a host process that
 *   misses ticks can't lose a series — schedule.db remembers it.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 */
import type Database from 'better-sqlite3';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { materializeOccurrence, sessionHasLiveSeriesRow } from './db.js';
import { advanceRecurrence, getDueSeries, openScheduleDb, type TaskSeriesRow } from './schedule-store.js';

/**
 * Compute the next cron occurrence for a series in the configured
 * timezone, or null for a one-shot (no recurrence). v1 interpreted the
 * cron expression in the user's TZ (src/v1/task-scheduler.ts); without it
 * a "0 9 * * *" task written by an agent in a user-local TZ fires at
 * 09:00 UTC instead of 09:00 user-local.
 */
async function computeNextRun(recurrence: string | null, agentGroupId: string): Promise<string | null> {
  if (!recurrence) return null;
  const { CronExpressionParser } = await import('cron-parser');
  const interval = CronExpressionParser.parse(recurrence, { tz: resolveGroupTimezone(agentGroupId) });
  return interval.next().toISOString();
}

/**
 * Materialize all due series for `session`'s agent group into this
 * session's inbound.db, then advance each in schedule.db. One schedule.db
 * open per call (host-only WAL DB — no race), closed in finally.
 *
 * `openSchedule` is an injectable seam (default: `openScheduleDb`, which
 * resolves through `config.ts`'s import-time `DATA_DIR` snapshot). Tests
 * pass a base-dir-explicit opener so they aren't bound to that snapshot;
 * production never passes it.
 */
export async function handleRecurrence(
  inDb: Database.Database,
  session: Session,
  openSchedule: (agentGroupId: string) => Database.Database = openScheduleDb,
): Promise<void> {
  const sched = openSchedule(session.agent_group_id);
  let due: TaskSeriesRow[];
  try {
    due = getDueSeries(sched, new Date().toISOString());
    for (const series of due) {
      try {
        // Idempotency: if this session's inbound.db still holds an
        // unconsumed occurrence for the series (a prior fire the container
        // hasn't picked up yet), don't stack another — just advance the
        // schedule so the cron clock doesn't drift. Belt: the occurrence
        // id is unique per fire and the INSERT is ON CONFLICT DO NOTHING.
        const alreadyLive = sessionHasLiveSeriesRow(inDb, series.series_id);

        const firedAt = new Date().toISOString();
        if (!alreadyLive) {
          const prefix = series.kind === 'task' ? 'task' : 'msg';
          const occurrenceId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          materializeOccurrence(inDb, {
            id: occurrenceId,
            seriesId: series.series_id,
            kind: series.kind,
            content: series.content,
            platformId: series.platform_id,
            channelType: series.channel_type,
            threadId: series.thread_id,
          });
          log.info('Materialized due task occurrence', {
            seriesId: series.series_id,
            occurrenceId,
            sessionId: session.id,
          });
        } else {
          log.debug('Skipped duplicate occurrence — prior fire still live', {
            seriesId: series.series_id,
            sessionId: session.id,
          });
        }

        const nextRun = await computeNextRun(series.recurrence, session.agent_group_id);
        advanceRecurrence(sched, series.series_id, nextRun, firedAt);
        log.info('Advanced series', {
          seriesId: series.series_id,
          nextRun: nextRun ?? '(one-shot — cancelled)',
          sessionId: session.id,
        });
      } catch (err) {
        // A bad cron string or a single-series write failure must not
        // strand the rest of the due set. Leave the series due; next tick
        // retries it. (A permanently-bad cron would log every tick — that
        // is visible and correct, vs silently dropping the series.)
        log.error('Failed to materialize/advance series', {
          seriesId: series.series_id,
          recurrence: series.recurrence,
          err,
        });
      }
    }
  } finally {
    sched.close();
  }
}
