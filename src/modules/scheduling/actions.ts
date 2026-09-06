/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write the schedule (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change here.
 *
 * Source of truth: the agent-group-scoped, host-only `schedule.db`
 * (schedule-store.ts), NOT the session's inbound.db. This is the S405
 * structural fix — see schedule-store.ts header. The v2.3 delivery registry
 * invokes handlers without holding a mailbox session; these actions only touch
 * the agent-group schedule. Host sweep materializes a due occurrence into a
 * mailbox separately at fire time.
 */
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { emitEngineEvent } from '../../engine/events.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  cancelSeries,
  openScheduleDb,
  pauseSeries,
  resumeSeries,
  updateSeries,
  upsertSeries,
  type SeriesUpdate,
} from './schedule-store.js';

export async function handleScheduleTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;
  const expiresAt = typeof content.expiresAt === 'string' ? content.expiresAt : null;
  // Optional dashboard-account id the agent captured from sender-identity
  // at schedule-time. Plugins use this at task.fired-time to stamp a
  // per-task identity so the task runs as the creator, not "whoever last
  // messaged the group." Pass-through field — engine never reads it.
  const createdByUserId = typeof content.createdByUserId === 'string' ? content.createdByUserId : null;

  const taskContent = JSON.stringify({
    prompt,
    script,
    ...(expiresAt ? { expiresAt } : {}),
    createdByUserId,
  });
  const db = openScheduleDb(session.agent_group_id);
  try {
    upsertSeries(db, {
      seriesId: taskId,
      agentGroupId: session.agent_group_id,
      recurrence,
      processAfter,
      content: taskContent,
      platformId: (content.platformId as string) ?? null,
      channelType: (content.channelType as string) ?? null,
      threadId: (content.threadId as string) ?? null,
    });
  } finally {
    db.close();
  }
  log.info('Scheduled task created', { taskId, processAfter, recurrence, createdByUserId });
  // Notify plugins. seriesId equals taskId on schedule (the series id is
  // the original task id and is stable across recurrence occurrences).
  // Host-side owner tracking listens here to persist
  // (agentGroupId, seriesId) → accountId. Contract unchanged from the
  // pre-schedule.db implementation.
  emitEngineEvent('task.scheduled', {
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    taskId,
    seriesId: taskId,
    taskContent,
  });
}

export async function handleCancelTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const taskId = content.taskId as string;
  const db = openScheduleDb(session.agent_group_id);
  try {
    cancelSeries(db, taskId);
  } finally {
    db.close();
  }
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const taskId = content.taskId as string;
  const db = openScheduleDb(session.agent_group_id);
  try {
    pauseSeries(db, taskId);
  } finally {
    db.close();
  }
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const taskId = content.taskId as string;
  const db = openScheduleDb(session.agent_group_id);
  try {
    resumeSeries(db, taskId);
  } finally {
    db.close();
  }
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const taskId = content.taskId as string;
  const update: SeriesUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  if (content.expiresAt === null || typeof content.expiresAt === 'string') {
    update.expiresAt = content.expiresAt as string | null;
  }
  const db = openScheduleDb(session.agent_group_id);
  let touched: number;
  try {
    touched = updateSeries(db, taskId, update);
  } finally {
    db.close();
  }
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = await getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
