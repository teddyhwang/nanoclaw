/**
 * Fire-time materialization of host-owned scheduled task series.
 *
 * The series, recurrence clock, next fire, and status live only in the agent
 * group's host-only `schedule.db`. A due series copies one transient occurrence
 * into the active session mailbox, then advances (or cancels, for a one-shot)
 * in schedule.db. The container never opens schedule.db.
 */
import type Database from 'better-sqlite3';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import type { InboundMailbox } from '../../mailbox/index.js';
import type { Session } from '../../types.js';
import { advanceRecurrence, getDueSeries, openScheduleDb, type TaskSeriesRow } from './schedule-store.js';

/** Compute the next cron occurrence in the owning group's effective timezone. */
async function computeNextRun(recurrence: string | null, agentGroupId: string): Promise<string | null> {
  if (!recurrence) return null;
  const { CronExpressionParser } = await import('cron-parser');
  const timezone = await resolveGroupTimezone(agentGroupId);
  return CronExpressionParser.parse(recurrence, { tz: timezone }).next().toISOString();
}

/**
 * Materialize every due series for this agent group through the narrow mailbox
 * capability. `openSchedule` is injectable so tests can use a hermetic sessions
 * base without changing process-global engine paths.
 */
export async function handleRecurrence(
  mailbox: InboundMailbox,
  session: Session,
  openSchedule: (agentGroupId: string) => Database.Database = openScheduleDb,
): Promise<void> {
  const schedule = openSchedule(session.agent_group_id);
  let due: TaskSeriesRow[];
  try {
    due = getDueSeries(schedule, new Date().toISOString());
    for (const series of due) {
      try {
        // Do not stack a second fire while an earlier occurrence is still
        // unconsumed. The schedule still advances so its cron clock does not
        // drift behind a slow/cold container.
        const alreadyLive = mailbox.hasLiveTaskOccurrence(series.series_id);
        const firedAt = new Date().toISOString();

        if (!alreadyLive) {
          if (series.kind !== 'task') throw new Error(`unsupported scheduled series kind: ${series.kind}`);
          const occurrenceId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await mailbox.materializeTaskOccurrence({
            id: occurrenceId,
            seriesId: series.series_id,
            kind: 'task',
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
        advanceRecurrence(schedule, series.series_id, nextRun, firedAt);
        log.info('Advanced series', {
          seriesId: series.series_id,
          nextRun: nextRun ?? '(one-shot — cancelled)',
          sessionId: session.id,
        });
        // Per-series isolation: leave this row due and continue the set.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        // One malformed cron or mailbox write must not strand the rest of the
        // due set. Leaving this series due makes the next sweep retry it.
        log.error('Failed to materialize/advance series', {
          seriesId: series.series_id,
          recurrence: series.recurrence,
          err,
        });
      }
    }
  } finally {
    schedule.close();
  }
}
