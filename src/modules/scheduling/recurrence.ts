/**
 * Fire-time materialization of host-owned scheduled task series.
 *
 * The series, recurrence clock, next fire, and status live only in the agent
 * group's host-only `schedule.db`. A due series is first claimed in
 * schedule.db (an atomic compare-and-set that advances it, or cancels a
 * one-shot), then copies one transient occurrence into the claiming session's
 * mailbox. Exactly one active session of the group wins each tick; a failed
 * write gives the claim back for retry. A host crash between claim and write
 * drops that one tick rather than double-firing it. The container never opens
 * schedule.db.
 */
import type Database from 'better-sqlite3';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import { emitEngineEvent } from '../../engine/events.js';
import { mayMaterializeTask } from '../../engine/task-materialization.js';
import type { InboundMailbox } from '../../mailbox/index.js';
import type { Session } from '../../types.js';
import {
  claimDueOccurrence,
  getDueSeries,
  markSeriesFired,
  openScheduleDb,
  releaseOccurrenceClaim,
  type TaskSeriesRow,
} from './schedule-store.js';

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
      // Set once this sweep owns the tick; cleared once its occurrence is
      // written (or deliberately skipped). Still set in `catch` = give it back.
      let claimedAt: string | null = null;
      const observed = series.process_after as string; // non-null: getDueSeries
      try {
        const parsedContent = JSON.parse(series.content) as { expiresAt?: unknown };
        const expiresAt = typeof parsedContent.expiresAt === 'string' ? parsedContent.expiresAt : null;
        const firedAt = new Date().toISOString();

        // Expiry is end-exclusive: a series never materializes at or after
        // its bound. This also safely retires an overdue series after downtime.
        if (expiresAt !== null && firedAt >= expiresAt) {
          if (claimDueOccurrence(schedule, series.series_id, observed, null, firedAt)) {
            markSeriesFired(schedule, series.series_id, firedAt);
            log.info('Expired scheduled series', { seriesId: series.series_id, expiresAt });
          }
          continue;
        }

        const computedNextRun = await computeNextRun(series.recurrence, session.agent_group_id);
        const nextRun =
          computedNextRun !== null && expiresAt !== null && computedNextRun >= expiresAt ? null : computedNextRun;

        // Claim before any further await. Every active session of this agent
        // group sweeps the same schedule.db and read this due set before its
        // first await, so without the compare-and-set two sessions could both
        // pass the guard and materialize the same tick. The loser stops here.
        claimedAt = claimDueOccurrence(schedule, series.series_id, observed, nextRun, new Date().toISOString());
        if (claimedAt === null) {
          log.debug('Scheduled occurrence already claimed or changed elsewhere', {
            seriesId: series.series_id,
            sessionId: session.id,
          });
          continue;
        }

        // Do not stack a second fire while an earlier occurrence is still
        // unconsumed. The schedule still advances so its cron clock does not
        // drift behind a slow/cold container.
        const alreadyLive = mailbox.hasLiveTaskOccurrence(series.series_id);

        if (!alreadyLive && !(await mayMaterializeTask(series, session))) {
          // A deliberate no-op is not a fire: the claim already moved the
          // clock; last_fired_at is preserved and no occurrence is written.
          // Silent here (engine contract); a guard logs its own reason, and
          // only the claiming session ever evaluates it.
          claimedAt = null;
          continue;
        }

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
          emitEngineEvent('principal.input', {
            sessionId: session.id,
            agentGroupId: session.agent_group_id,
            messageId: occurrenceId,
            kind: 'task',
            seriesId: series.series_id,
            scheduledFor: observed,
            scheduleClaimedAt: claimedAt,
            content: series.content,
            channelType: series.channel_type,
            platformId: series.platform_id,
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

        // The occurrence exists: never give this tick back after this point.
        claimedAt = null;
        markSeriesFired(schedule, series.series_id, firedAt);
        log.info('Advanced series', {
          seriesId: series.series_id,
          nextRun: nextRun ?? '(one-shot — cancelled)',
          sessionId: session.id,
        });
        // Per-series isolation: leave this row due and continue the set.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        // One malformed cron, guard or mailbox write must not strand the rest
        // of the due set. Give back an unwritten claim so the next sweep
        // retries this tick; an unclaimed row is still due as it was.
        let released = false;
        if (claimedAt !== null) {
          try {
            released = releaseOccurrenceClaim(schedule, series.series_id, observed, claimedAt);
            // eslint-disable-next-line no-catch-all/no-catch-all -- a failed release must not mask the original error
          } catch (releaseErr) {
            log.error('Failed to release scheduled occurrence claim', { seriesId: series.series_id, releaseErr });
          }
        }
        log.error('Failed to materialize/advance series', {
          seriesId: series.series_id,
          recurrence: series.recurrence,
          claimReleased: released,
          err,
        });
      }
    }
  } finally {
    schedule.close();
  }
}
