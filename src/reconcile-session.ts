/** Per-session maintenance, with durable incarnation fencing and Optimus host-only schedules. */
import fs from 'fs';

import { ACTIVE_CONVERSATION_WINDOW_MS, ACTIVE_IDLE_TIMEOUT, IDLE_TIMEOUT } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getSession, isTaskThread, updateSession } from './db/sessions.js';
import { getDeliveryAdapter } from './delivery.js';
import { emitEngineEvent } from './engine/events.js';
import { ABSOLUTE_CEILING_MS_RAW, CLAIM_STUCK_MS_RAW } from './config.js';
import { log } from './log.js';
import type { ContainerState, InboundMailbox, MailboxSession, OutboundMailbox } from './mailbox/index.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer } from './container-runner.js';
import type { Session } from './types.js';

import { getSessionClaim } from './db/coordination.js';
import {
  clearAllPendingCompletions,
  clearPendingCompletions,
  getPendingCompletions,
} from './db/pending-completions.js';
import { requestWake } from './request-wake.js';

export const MCP_TOOL_CEILING_MS = 60 * 60 * 1000;
export const CLAIM_STARTUP_GRACE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// One global env override per timer, read once at host start like every other
// NANOCLAW_* setting. Anything that is not a whole number of ms inside
// [min, 24 h] is refused with a warning and the built-in default is used.
function envOverrideMs(name: string, raw: string, defaultMs: number, minMs: number): number {
  if (raw === '') return defaultMs;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isNaN(parsed) || parsed < minMs || parsed > DAY_MS) {
    log.warn(`Ignoring ${name}=${raw}: expected an integer between ${minMs} and ${DAY_MS} ms; using ${defaultMs}`);
    return defaultMs;
  }
  return parsed;
}

// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound. Override with
// NANOCLAW_ABSOLUTE_CEILING_MS (60 s .. 24 h).
export const ABSOLUTE_CEILING_MS = envOverrideMs(
  'NANOCLAW_ABSOLUTE_CEILING_MS',
  ABSOLUTE_CEILING_MS_RAW,
  30 * 60 * 1000,
  60 * 1000,
);
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?" Override with
// NANOCLAW_CLAIM_STUCK_MS (10 s .. 24 h).
export const CLAIM_STUCK_MS = envOverrideMs('NANOCLAW_CLAIM_STUCK_MS', CLAIM_STUCK_MS_RAW, 60 * 1000, 10 * 1000);
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

/** Legacy test seam. Mailbox timestamps are normalized before decisions. */
export function parseSqliteUtc(value: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
}

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'stop-idle'; idleAgeMs: number; idleTimeoutMs: number }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

export function pickIdleTimeoutMs(args: {
  now: number;
  lastHumanInboundMs: number;
  baseIdleMs: number;
  activeIdleMs: number;
  activeWindowMs: number;
}): number {
  const { now, lastHumanInboundMs, baseIdleMs, activeIdleMs, activeWindowMs } = args;
  if (lastHumanInboundMs <= 0) return baseIdleMs;
  return now - lastHumanInboundMs <= activeWindowMs ? activeIdleMs : baseIdleMs;
}

/** Pure running-container SLA decision. */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number;
  containerStartedAtMs?: number;
  containerState: ContainerState | null;
  claims: Array<{ messageId: string; statusChanged: string }>;
  dueCount?: number;
  idleTimeoutMs?: number;
}): StuckDecision {
  const {
    now,
    heartbeatMtimeMs,
    containerStartedAtMs,
    containerState,
    claims,
    dueCount = 0,
    idleTimeoutMs = IDLE_TIMEOUT,
  } = args;
  const declaredBashMs = bashTimeoutMs(containerState);
  const mcpInFlight =
    typeof containerState?.currentTool === 'string' && containerState.currentTool.startsWith('mcp__')
      ? MCP_TOOL_CEILING_MS
      : 0;

  // Short adaptive idle stop requires a real heartbeat. Driver start time is
  // only the fallback clock for the absolute ceiling; applying it here would
  // kill providers during a cold start before their first SDK heartbeat.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    if (!containerState?.currentTool && claims.length === 0 && dueCount === 0 && heartbeatAge > idleTimeoutMs) {
      return { action: 'stop-idle', idleAgeMs: heartbeatAge, idleTimeoutMs };
    }
  }

  const effectiveHeartbeatMs = heartbeatMtimeMs || containerStartedAtMs || 0;
  if (effectiveHeartbeatMs !== 0) {
    const heartbeatAge = now - effectiveHeartbeatMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0, mcpInFlight);
    if (heartbeatAge > ceiling) return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
  }

  const inStartup = heartbeatMtimeMs === 0;
  const tolerance = inStartup
    ? Math.max(CLAIM_STARTUP_GRACE_MS, CLAIM_STUCK_MS, declaredBashMs ?? 0, mcpInFlight)
    : Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0, mcpInFlight);
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance || heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.messageId, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/**
 * A spent task session closes once its container is gone and no task is live
 * — but never while it still has undelivered DUE outbound rows. A closed
 * session is outside both delivery polls, so closing it would strand a reply
 * that is backing off or held for an unavailable channel (neither delivered
 * nor failed). The hold window bounds how long that keeps the session open.
 * Rows whose `deliver_after` is still in the future are not counted
 * (pre-existing behaviour, unchanged here).
 */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
  undeliveredOutboundCount = 0,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0 && undeliveredOutboundCount === 0;
}

async function maintainScheduling(
  mailbox: InboundMailbox,
  session: Session,
  openSchedule?: typeof import('./modules/scheduling/schedule-store.js').openScheduleDb,
): Promise<void> {
  // MODULE-HOOK:scheduling-recurrence:start
  const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
  try {
    await handleRecurrence(mailbox, session, openSchedule);
    // eslint-disable-next-line no-catch-all/no-catch-all -- schedule failures must not abort the session sweep
  } catch (err) {
    // A schedule-level failure (unopenable schedule.db, failed due query)
    // must not abort the rest of the session sweep: due-message wakes,
    // stuck-claim recovery and delivery maintenance still run this tick.
    log.error('Scheduled series recurrence failed', { sessionId: session.id, err });
  }

  try {
    const { listLiveSeries, openScheduleDb } = await import('./modules/scheduling/schedule-store.js');
    const schedule = (openSchedule ?? openScheduleDb)(session.agent_group_id);
    try {
      mailbox.replaceTaskSeriesSnapshot(
        listLiveSeries(schedule).map((row) => ({
          seriesId: row.series_id,
          status: row.status === 'paused' ? 'paused' : 'pending',
          recurrence: row.recurrence,
          processAfter: row.process_after,
          content: row.content,
        })),
      );
    } finally {
      schedule.close();
    }
  } catch (err) {
    // Snapshot freshness may lag one tick, but recurrence/wake must continue.
    log.error('Failed to project task_series snapshot', { sessionId: session.id, err });
  }
  // MODULE-HOOK:scheduling-recurrence:end
}

export const _maintainSchedulingForTesting = maintainScheduling;

export async function reconcileSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') return;
  await reconcileActiveSession(session);
}

/**
 * Lock waits: host connections to session DBs wait only briefly in SQLite
 * (mailbox/sqlite/busy.ts), and the writes here are NOT retried on purpose.
 * Each is sweep bookkeeping that re-derives its work from the mailbox on the
 * next pass (enqueued reconciles and the 60 s host sweep): ack sync, system
 * row GC, the task_series snapshot (schedule.db is the source of truth),
 * the echo prune, stuck-claim reset (markMessageFailed / retryWithBackoff,
 * after the claimant was killed) and orphan-claim cleanup. A busy lock
 * fails one pass, which is logged, and the next pass repeats it from the
 * same state; nothing a user did is lost.
 */
async function reconcileActiveSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let dueCount = 0;
  let dueTasks: ReturnType<InboundMailbox['getDueTasks']> = [];
  let shouldWake = false;

  try {
    // Completions a host Stop owes (see db/pending-completions.ts): settled
    // first, so nothing below can wake a runner for those inputs.
    // A failed read counts as owing (nothing is cleared, the wake below is
    // refused by spawnContainer's own settle).
    const owed = await getPendingCompletions(session.id);
    let owedSettled = false;
    owedThisPass.set(session.id, new Set(owed));
    // Phase 1: one existing mailbox action. No external wake while this key is
    // open; recurrence writes and snapshot replacement go through this mailbox.
    const exists = await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      // Independent bookkeeping steps: one failing (a busy lock above all)
      // must not skip task arming, the snapshot or the wake below. Unsynced
      // acks only leave acknowledged rows pending a little longer; the runner
      // skips acknowledged rows itself, so a wake for them replays nothing.
      if (owed.length)
        sweepStep(session, 'owed completions', () => {
          mailbox.markMessagesCompleted(owed);
          owedSettled = true;
        });
      sweepStep(session, 'ack sync', () => {
        mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      });
      sweepStep(session, 'system row GC', () => {
        const gcCount = mailbox.gcStaleSystemRows();
        if (gcCount > 0) log.debug('GC stranded system rows', { sessionId: session.id, count: gcCount });
      });

      await maintainScheduling(mailbox, session);
      dueCount = mailbox.countDueMessages();
      dueTasks = mailbox.getDueTasks();
      shouldWake = dueCount > 0 && !isContainerRunning(session.id);
      if (!shouldWake) await maintainSessionMailbox(mailbox, session, agentGroup.id, false, dueCount);
      return true;
    });
    if (owed.length) {
      if (!exists) {
        // The mailbox is gone: nothing left to run or complete.
        await clearAllPendingCompletions(session.id);
        noteOwedSettled(session.id);
      } else if (owedSettled) {
        await clearPendingCompletions(session.id, owed);
        noteOwedSettled(session.id);
      } else {
        noteOwedUnsettled(session, owed.length);
      }
    }
    if (!exists || !shouldWake) return;

    // Phase 2: the mailbox is closed before plugin events and wakeContainer,
    // preventing same-key re-entry through routing/materialization hooks.
    for (const task of dueTasks) {
      emitEngineEvent('task.fired', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        taskId: task.id,
        seriesId: task.seriesId,
        taskContent: task.content,
      });
    }
    log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
    const woke = await requestWake(session, 'due-message');

    // Phase 3: post-wake maintenance uses a fresh, sequential mailbox action.
    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      await maintainSessionMailbox(mailbox, session, agentGroup.id, woke, dueCount);
    });
  } catch (err) {
    log.error('Session mailbox sweep failed', { agentGroupId: agentGroup.id, sessionId: session.id, err });
  } finally {
    owedThisPass.delete(session.id);
  }
}

/** Owed completions read at the start of the current pass, per session:
 * the stuck-claim reset never fails, notifies or re-queues these inputs (a
 * Stop already decided they are done; the settle completes them). */
const owedThisPass = new Map<string, ReadonlySet<string>>();

/** Consecutive sweep passes a session's owed completions stayed unsettled. */
export const OWED_STUCK_ALERT_PASSES = 3;
const owedStuck = new Map<string, { passes: number; since: string; alerted: boolean }>();

function noteOwedUnsettled(session: Session, owedCount: number): void {
  const state = owedStuck.get(session.id) ?? { passes: 0, since: new Date().toISOString(), alerted: false };
  state.passes++;
  owedStuck.set(session.id, state);
  if (state.alerted || state.passes < OWED_STUCK_ALERT_PASSES) return;
  state.alerted = true; // once per stuck episode
  log.error('Owed inbound completions stuck; no runner can start for this session', {
    sessionId: session.id,
    passes: state.passes,
    owedCount,
    since: state.since,
  });
  emitEngineEvent('completions.stuck', {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    passes: state.passes,
    owedCount,
    since: state.since,
  });
}

function noteOwedSettled(sessionId: string): void {
  owedStuck.delete(sessionId);
}

export function _resetOwedStuckForTesting(): void {
  owedStuck.clear();
}

/** Run one sweep bookkeeping step; a failure is logged and the sweep goes on
 * (the step re-runs from the same state next pass). */
function sweepStep(session: Session, step: string, run: () => void): void {
  try {
    run();
    // eslint-disable-next-line no-catch-all/no-catch-all -- one bookkeeping step must not abort the session sweep
  } catch (err) {
    log.warn('Session sweep step failed; continuing', { sessionId: session.id, step, err });
  }
}

async function maintainSessionMailbox(
  mailbox: MailboxSession,
  session: Session,
  agentGroupId: string,
  _justWoke: boolean,
  dueCount: number,
): Promise<void> {
  const alive = isContainerRunning(session.id);
  if (alive) await enforceRunningContainerSla(mailbox, mailbox, session, agentGroupId, dueCount);
  if (!alive) resetStuckProcessingRows(mailbox, mailbox, session, 'container not running');

  if (isTaskThread(session.thread_id)) {
    const liveTasks = mailbox.countLiveTasks();
    const undelivered = mailbox.getDueMessages(mailbox.getDeliveredIds()).length;
    if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks, undelivered)) {
      await updateSession(session.id, { status: 'closed' });
      log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
    }
  }

  // MODULE-HOOK:cross-session-echo-prune:start
  try {
    const { pruneEchoBacklog } = await import('./modules/cross-session-context/index.js');
    const pruned = pruneEchoBacklog(mailbox);
    if (pruned > 0) log.info('Pruned session-echo backlog', { sessionId: session.id, pruned });
  } catch (err) {
    log.error('Echo backlog prune failed', { sessionId: session.id, err });
  }
  // MODULE-HOOK:cross-session-echo-prune:end
}

const MAX_CONSECUTIVE_CLAIM_STUCK_KILLS = 5;
const claimStuckKills = new Map<string, number>();

function claimStuckKillCount(sessionId: string): number {
  return claimStuckKills.get(sessionId) ?? 0;
}
function bumpClaimStuckKill(sessionId: string): number {
  const count = claimStuckKillCount(sessionId) + 1;
  claimStuckKills.set(sessionId, count);
  return count;
}
function clearClaimStuckKill(sessionId: string): void {
  claimStuckKills.delete(sessionId);
}

export function _shouldForceFailClaimStuckForTesting(consecutiveKills: number): boolean {
  return consecutiveKills >= MAX_CONSECUTIVE_CLAIM_STUCK_KILLS;
}
export const _MAX_CONSECUTIVE_CLAIM_STUCK_KILLS_FOR_TESTING = MAX_CONSECUTIVE_CLAIM_STUCK_KILLS;
export function _claimStuckHelpersForTesting() {
  return {
    count: claimStuckKillCount,
    bump: bumpClaimStuckKill,
    clear: clearClaimStuckKill,
    reset: () => claimStuckKills.clear(),
  };
}

const FAILED_NOTIFY_DEDUP_MS = 5 * 60 * 1000;
const lastFailedNotifyAt = new Map<string, number>();
const FAILED_MESSAGE_USER_TEXT =
  "⚠️ I hit a temporary limit and couldn't get to your last message. Nothing was lost on your end — please send it again and I'll pick it right up.";

export function _resetFailedNotifyDedupForTesting(): void {
  lastFailedNotifyAt.clear();
}

function notifyUserOfFailedMessage(inbox: InboundMailbox, session: Session, messageId: string): void {
  try {
    const info = inbox.getFailedMessageNotifyInfo(messageId);
    if (
      !info ||
      info.kind !== 'chat' ||
      !info.trigger ||
      info.channelType === 'agent' ||
      !info.channelType ||
      !info.platformId
    ) {
      return;
    }

    const now = Date.now();
    if (now - (lastFailedNotifyAt.get(session.id) ?? 0) < FAILED_NOTIFY_DEDUP_MS) return;
    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.warn('Cannot notify user of failed message — no delivery adapter', {
        messageId,
        sessionId: session.id,
      });
      return;
    }

    lastFailedNotifyAt.set(session.id, now);
    const content = JSON.stringify({ type: 'text', text: FAILED_MESSAGE_USER_TEXT });
    void adapter.deliver(info.channelType, info.platformId, info.threadId, 'chat', content).then(
      () =>
        log.info('Notified user of failed message', {
          messageId,
          sessionId: session.id,
          channelType: info.channelType,
          platformId: info.platformId,
        }),
      (err: unknown) => {
        if (lastFailedNotifyAt.get(session.id) === now) lastFailedNotifyAt.delete(session.id);
        log.error('Failed to notify user of failed message', { messageId, sessionId: session.id, err });
      },
    );
  } catch (err) {
    log.error('notifyUserOfFailedMessage threw', { messageId, sessionId: session.id, err });
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  try {
    return fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  return state?.currentTool === 'Bash' ? state.toolDeclaredTimeoutMs : null;
}

async function enforceRunningContainerSla(
  inbox: InboundMailbox,
  outbox: OutboundMailbox,
  session: Session,
  agentGroupId: string,
  dueCount: number,
): Promise<void> {
  let incarnationStartMs = 0;
  const claimRow = await getSessionClaim(session.id);
  if (claimRow?.claimed_at) {
    const parsed = Date.parse(claimRow.claimed_at);
    if (!Number.isNaN(parsed)) incarnationStartMs = parsed;
  }

  const rawHeartbeatMs = heartbeatMtimeMs(agentGroupId, session.id);
  const gatedHeartbeatMs = rawHeartbeatMs >= incarnationStartMs ? rawHeartbeatMs : 0;
  const gatedClaims = outbox.getProcessingClaims().map((claim) => {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt) || claimedAt >= incarnationStartMs) return claim;
    return { ...claim, statusChanged: new Date(incarnationStartMs).toISOString() };
  });

  const now = Date.now();
  const idleTimeoutMs = pickIdleTimeoutMs({
    now,
    lastHumanInboundMs: inbox.getLatestHumanInboundMs(),
    baseIdleMs: IDLE_TIMEOUT,
    activeIdleMs: ACTIVE_IDLE_TIMEOUT,
    activeWindowMs: ACTIVE_CONVERSATION_WINDOW_MS,
  });
  const decision = decideStuckAction({
    now,
    heartbeatMtimeMs: gatedHeartbeatMs,
    containerStartedAtMs: getContainerStartedAtMs(session.id),
    containerState: outbox.getContainerState(),
    claims: gatedClaims,
    dueCount,
    idleTimeoutMs,
  });

  if (decision.action === 'ok') return;
  if (decision.action === 'stop-idle') {
    log.info('Stopping idle container', {
      sessionId: session.id,
      idleAgeMs: decision.idleAgeMs,
      idleTimeoutMs: decision.idleTimeoutMs,
    });
    clearClaimStuckKill(session.id);
    killContainer(session.id, 'idle-timeout');
    return;
  }
  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    emitEngineEvent('container.stuck', { sessionId: session.id, agentGroupId: session.agent_group_id });
    resetStuckProcessingRows(inbox, outbox, session, 'absolute-ceiling');
    return;
  }

  const consecutiveClaimStuckKills = bumpClaimStuckKill(session.id);
  const forceFail = _shouldForceFailClaimStuckForTesting(consecutiveClaimStuckKills);
  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
    consecutiveClaimStuckKills,
    ...(forceFail ? { circuitBreaker: 'tripped — force-failing stuck batch' } : {}),
  });
  killContainer(session.id, 'claim-stuck');
  emitEngineEvent('container.stuck', { sessionId: session.id, agentGroupId: session.agent_group_id });
  resetStuckProcessingRows(inbox, outbox, session, 'claim-stuck', forceFail);
  if (forceFail) clearClaimStuckKill(session.id);
}

export function _resetStuckProcessingRowsForTesting(
  inbox: InboundMailbox,
  outbox: OutboundMailbox,
  session: Session,
  reason: string,
  forceFail = false,
  owed?: ReadonlySet<string>,
): void {
  resetStuckProcessingRows(inbox, outbox, session, reason, forceFail, owed);
}

function resetStuckProcessingRows(
  inbox: InboundMailbox,
  outbox: OutboundMailbox,
  session: Session,
  reason: string,
  forceFail = false,
  owed: ReadonlySet<string> = owedThisPass.get(session.id) ?? new Set(),
): void {
  const now = Date.now();
  for (const { messageId } of outbox.getProcessingClaims()) {
    // Stopped by the user: done, never failed, notified or re-queued.
    if (owed.has(messageId)) continue;
    const message = inbox.getRecoverableMessage(messageId);
    if (!message) continue;

    if (forceFail) {
      inbox.markMessageFailed(message.id);
      log.warn('Message force-failed by claim-stuck circuit-breaker', {
        messageId: message.id,
        sessionId: session.id,
        tries: message.tries,
        reason,
      });
      notifyUserOfFailedMessage(inbox, session, message.id);
      continue;
    }

    if (message.processAfter && Date.parse(message.processAfter) > now) continue;
    if (message.tries >= MAX_TRIES) {
      inbox.markMessageFailed(message.id);
      log.warn('Message marked as failed after max retries', {
        messageId: message.id,
        sessionId: session.id,
        reason,
      });
      notifyUserOfFailedMessage(inbox, session, message.id);
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, message.tries);
      inbox.retryWithBackoff(message.id, Math.floor(backoffMs / 1000));
      log.info('Reset stale message with backoff', {
        messageId: message.id,
        tries: message.tries,
        backoffMs,
        reason,
      });
    }
  }

  try {
    const cleared = outbox.deleteOrphanProcessingClaims();
    if (cleared > 0) log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  }
}
