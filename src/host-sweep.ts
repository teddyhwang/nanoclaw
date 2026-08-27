/**
 * Periodic host maintenance over the selected semantic mailbox.
 *
 * Host code never opens inbound.db/outbound.db directly. A sweep action owns
 * one mailbox session at a time, closes it before waking a container, and only
 * then opens a second session for post-wake maintenance.
 */
import fs from 'fs';

import { ACTIVE_CONVERSATION_WINDOW_MS, ACTIVE_IDLE_TIMEOUT, IDLE_TIMEOUT } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getActiveSessions, isTaskThread, updateSession } from './db/sessions.js';
import { getDeliveryAdapter } from './delivery.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { emitEngineEvent } from './engine/events.js';
import { log } from './log.js';
import type { ContainerState, InboundMailbox, MailboxSession, OutboundMailbox } from './mailbox/index.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_SESSION_TIMEOUT_MS = 20_000;
const SWEEP_STALL_THRESHOLD_MS = 5 * 60 * 1000;

class SweepTimeoutError extends Error {
  constructor(sessionId: string, ms: number) {
    super(`sweepSession(${sessionId}) exceeded ${ms}ms — abandoned this tick`);
    this.name = 'SweepTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, sessionId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SweepTimeoutError(sessionId, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export const _withTimeoutForTesting = withTimeout;
export { SweepTimeoutError as _SweepTimeoutErrorForTesting };

export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
export const MCP_TOOL_CEILING_MS = 60 * 60 * 1000;
export const CLAIM_STUCK_MS = 60 * 1000;
export const CLAIM_STARTUP_GRACE_MS = 5 * 60 * 1000;
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
    ? Math.max(CLAIM_STARTUP_GRACE_MS, declaredBashMs ?? 0, mcpInFlight)
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

let running = false;
let lastSweepCompletedAt = Date.now();
let sweepGeneration = 0;
let sweepWatchdogStarted = false;

export function _getLastSweepCompletedAtForTests(): number {
  return lastSweepCompletedAt;
}

export function startHostSweep(): void {
  if (running) return;
  running = true;
  lastSweepCompletedAt = Date.now();
  startSweepWatchdog();
  void sweep(sweepGeneration);
}

export function stopHostSweep(): void {
  running = false;
}

function startSweepWatchdog(): void {
  if (sweepWatchdogStarted) return;
  sweepWatchdogStarted = true;
  const interval = setInterval(() => {
    if (!running) return;
    const since = Date.now() - lastSweepCompletedAt;
    if (since <= SWEEP_STALL_THRESHOLD_MS) return;
    log.error('Host sweep stalled — re-arming a fresh sweep chain', {
      sinceLastCompletedMs: since,
      thresholdMs: SWEEP_STALL_THRESHOLD_MS,
    });
    sweepGeneration += 1;
    lastSweepCompletedAt = Date.now();
    void sweep(sweepGeneration);
  }, SWEEP_STALL_THRESHOLD_MS);
  interval.unref?.();
}

async function sweep(generation: number): Promise<void> {
  if (!running || generation !== sweepGeneration) return;

  try {
    ensureEgressNetwork();
  } catch (err) {
    log.error('Egress lockdown re-heal failed', { err });
  }

  try {
    const sessions = await getActiveSessions();
    for (const session of sessions) {
      try {
        await withTimeout(sweepSession(session), SWEEP_SESSION_TIMEOUT_MS, session.id);
      } catch (err) {
        if (err instanceof SweepTimeoutError) {
          log.error('Sweep skipped a session (timed out) — continuing tick', {
            sessionId: session.id,
            timeoutMs: SWEEP_SESSION_TIMEOUT_MS,
          });
        } else {
          log.error('sweepSession threw — continuing tick', { sessionId: session.id, err });
        }
      }
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // MODULE-HOOK:approvals-reason-sweep:start
  try {
    const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
    await sweepAwaitingReasonRejects();
  } catch (err) {
    log.error('Reject-with-reason sweep failed', { err });
  }
  // MODULE-HOOK:approvals-reason-sweep:end

  lastSweepCompletedAt = Date.now();
  if (generation === sweepGeneration) setTimeout(() => void sweep(generation), SWEEP_INTERVAL_MS);
}

export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

async function maintainScheduling(mailbox: InboundMailbox, session: Session): Promise<void> {
  // MODULE-HOOK:scheduling-recurrence:start
  const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
  await handleRecurrence(mailbox, session);

  try {
    const { listLiveSeries, openScheduleDb } = await import('./modules/scheduling/schedule-store.js');
    const schedule = openScheduleDb(session.agent_group_id);
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

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let dueCount = 0;
  let dueTasks: ReturnType<InboundMailbox['getDueTasks']> = [];
  let shouldWake = false;

  try {
    // Phase 1: one existing mailbox action. No external wake while this key is
    // open; recurrence writes and snapshot replacement go through this mailbox.
    const exists = await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      const gcCount = mailbox.gcStaleSystemRows();
      if (gcCount > 0) log.debug('GC stranded system rows', { sessionId: session.id, count: gcCount });

      await maintainScheduling(mailbox, session);
      dueCount = mailbox.countDueMessages();
      dueTasks = mailbox.getDueTasks();
      shouldWake = dueCount > 0 && !isContainerRunning(session.id);
      if (!shouldWake) await maintainSessionMailbox(mailbox, session, agentGroup.id, false, dueCount);
      return true;
    });
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
    const woke = await wakeContainer(session);

    // Phase 3: post-wake maintenance uses a fresh, sequential mailbox action.
    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      await maintainSessionMailbox(mailbox, session, agentGroup.id, woke, dueCount);
    });
  } catch (err) {
    log.error('Session mailbox sweep failed', { agentGroupId: agentGroup.id, sessionId: session.id, err });
  }
}

async function maintainSessionMailbox(
  mailbox: MailboxSession,
  session: Session,
  agentGroupId: string,
  justWoke: boolean,
  dueCount: number,
): Promise<void> {
  const alive = isContainerRunning(session.id);
  if (alive && !justWoke) enforceRunningContainerSla(mailbox, mailbox, session, agentGroupId, dueCount);
  if (!alive) resetStuckProcessingRows(mailbox, mailbox, session, 'container not running');

  if (isTaskThread(session.thread_id)) {
    const liveTasks = mailbox.countLiveTasks();
    if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
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

function enforceRunningContainerSla(
  inbox: InboundMailbox,
  outbox: OutboundMailbox,
  session: Session,
  agentGroupId: string,
  dueCount: number,
): void {
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
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerStartedAtMs: getContainerStartedAtMs(session.id),
    containerState: outbox.getContainerState(),
    claims: outbox.getProcessingClaims(),
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
): void {
  resetStuckProcessingRows(inbox, outbox, session, reason, forceFail);
}

function resetStuckProcessingRows(
  inbox: InboundMailbox,
  outbox: OutboundMailbox,
  session: Session,
  reason: string,
  forceFail = false,
): void {
  const now = Date.now();
  for (const { messageId } of outbox.getProcessingClaims()) {
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
