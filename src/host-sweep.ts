/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getDueTaskRows,
  getLatestHumanInboundMs,
  getRecoverableMessage,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  gcStaleSystemRows,
  type ContainerState,
} from './db/session-db.js';
import { ACTIVE_CONVERSATION_WINDOW_MS, ACTIVE_IDLE_TIMEOUT, IDLE_TIMEOUT } from './config.js';
import { emitEngineEvent } from './engine/events.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, openOutboundDbRw, inboundDbPath, heartbeatPath } from './session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
/**
 * Per-session sweep timeout. `sweepSession` opens/writes a session's
 * inbound.db; for a continuously-alive container holding that DB under
 * VirtioFS, the host-side better-sqlite3 op can block indefinitely (the
 * S405 hazard). The sweep loop awaits sessions sequentially, so one
 * hung session strands the whole tick and `setTimeout(sweep)` never
 * re-arms — every recurring task + due-wake group-wide then freezes
 * until a manual restart (observed 2026-05-19, 3h45m outage). Racing
 * each session against this bound lets the loop abandon a hung session
 * and continue. The abandoned op is NOT cancelled (better-sqlite3 is
 * synchronous; nothing can interrupt it) — its promise just settles
 * later, ignored. Generous vs the ~1s healthy sweepSession so a slow-
 * but-progressing session is never falsely skipped.
 */
const SWEEP_SESSION_TIMEOUT_MS = 20_000;
/**
 * If no sweep tick has COMPLETED in this long, the loop is presumed
 * wedged (every plausible single-session stall is bounded by
 * SWEEP_SESSION_TIMEOUT_MS × #sessions, far under this) and the
 * independent watchdog re-arms a fresh sweep. Defense-in-depth analogous
 * to the dev-agent queue-poll watchdog (super-repo 5339ada6).
 */
const SWEEP_STALL_THRESHOLD_MS = 5 * 60 * 1000;

class SweepTimeoutError extends Error {
  constructor(sessionId: string, ms: number) {
    super(`sweepSession(${sessionId}) exceeded ${ms}ms — abandoned this tick`);
    this.name = 'SweepTimeoutError';
  }
}

/**
 * Resolve `p`, or reject with SweepTimeoutError after `ms`. The timer is
 * always cleared so a fast resolve never leaks a pending handle.
 */
function withTimeout<T>(p: Promise<T>, ms: number, sessionId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SweepTimeoutError(sessionId, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Test seam for the per-session sweep-isolation primitive (Task #3). */
export const _withTimeoutForTesting = withTimeout;
export { SweepTimeoutError as _SweepTimeoutErrorForTesting };
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Widened ceiling applied while a non-Bash MCP tool is in flight. MCP tools
// don't expose a declared timeout the way Bash does, but we know real work is
// happening (PreToolUse hook recorded current_tool, hasn't fired PostToolUse
// yet). Without this, a genuinely long single MCP call — e.g. gws-docs on a
// large doc — gets SIGKILL'd at 30 min and the partial work is lost.
export const MCP_TOOL_CEILING_MS = 60 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
// Startup grace for a claim whose container has NOT yet written its first
// heartbeat (heartbeatMtimeMs === 0). The agent-runner only touches the
// heartbeat once the provider SDK stream opens (poll-loop.ts:731) — i.e.
// AFTER provider cold start. The codex provider's cold start (bubblewrap +
// ~19k-char kernel compose + camoufox prewarm + `codex app-server` spawn +
// thread resume) routinely runs 2–4 min, far past CLAIM_STUCK_MS. Without a
// wider window for the pre-first-heartbeat phase, decideStuckAction's
// `heartbeatMtimeMs > claimedAt` guard is structurally unsatisfiable (0 is
// never > a real claim time), so every codex-backed session that claims a
// message is SIGKILL'd ~60s in, mid-cold-start, forever — the message is
// never answered (observed 2026-05-18: Teddy DM silent ~12h, every respawn
// claim-stuck-killed during codex startup). Only applies while no heartbeat
// exists yet; once the container writes one, the normal CLAIM_STUCK_MS +
// heartbeat-freshness logic takes over, so a genuinely hung post-startup
// container is still caught on the normal timeline.
export const CLAIM_STARTUP_GRACE_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'stop-idle'; idleAgeMs: number; idleTimeoutMs: number }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for the adaptive keep-warm idle timeout. While the
 * session has had a HUMAN (chat-sdk) message within
 * activeWindowMs, the operator is actively conversing — keep the
 * container warm for activeIdleMs so the next turn reuses the warm
 * (codex) app-server + already-handshaked MCP servers instead of a full
 * cold start (the real "why is it so slow"). A session with no recent
 * human turn (background/recurring-task only) falls back to the short
 * baseIdleMs so idle sessions don't hoard RAM. lastHumanInboundMs=0
 * (never a human msg) ⇒ always the short timeout.
 */
export function pickIdleTimeoutMs(args: {
  now: number;
  lastHumanInboundMs: number;
  baseIdleMs: number;
  activeIdleMs: number;
  activeWindowMs: number;
}): number {
  const { now, lastHumanInboundMs, baseIdleMs, activeIdleMs, activeWindowMs } = args;
  if (lastHumanInboundMs <= 0) return baseIdleMs;
  const sinceHuman = now - lastHumanInboundMs;
  return sinceHuman <= activeWindowMs ? activeIdleMs : baseIdleMs;
}

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  dueCount?: number;
  idleTimeoutMs?: number;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims, dueCount = 0, idleTimeoutMs = IDLE_TIMEOUT } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    if (!containerState?.current_tool && claims.length === 0 && dueCount === 0 && heartbeatAge > idleTimeoutMs) {
      return { action: 'stop-idle', idleAgeMs: heartbeatAge, idleTimeoutMs };
    }

    const mcpInFlight =
      typeof containerState?.current_tool === 'string' && containerState.current_tool.startsWith('mcp__')
        ? MCP_TOOL_CEILING_MS
        : 0;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0, mcpInFlight);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const mcpInFlightTolerance =
    typeof containerState?.current_tool === 'string' && containerState.current_tool.startsWith('mcp__')
      ? MCP_TOOL_CEILING_MS
      : 0;
  // No heartbeat written yet ⇒ the container is still in provider cold start
  // (the runner's first touchHeartbeat is gated behind the SDK stream open).
  // Use the wider startup grace so codex's multi-minute boot isn't mistaken
  // for a stuck claim. Once any heartbeat exists, fall back to the normal
  // tolerance + heartbeat-freshness check below — a container that booted and
  // then hung is still caught on the steady-state timeline.
  const inStartup = heartbeatMtimeMs === 0;
  const tolerance = inStartup
    ? Math.max(CLAIM_STARTUP_GRACE_MS, declaredBashMs ?? 0, mcpInFlightTolerance)
    : Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0, mcpInFlightTolerance);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    // Heartbeat newer than the claim ⇒ the container showed life since it
    // claimed this message; not stuck. (Never true while inStartup, by
    // construction — the startup grace above is what protects that phase.)
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let running = false;
/**
 * Wall-clock of the last sweep tick that ran to completion (reached the
 * `setTimeout(sweep)` re-arm). The watchdog compares against this; the
 * normal chain bumps it every tick.
 */
let lastSweepCompletedAt = Date.now();
/** Generation token so a watchdog re-arm retires any stale chain link. */
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
  sweep(sweepGeneration);
}

export function stopHostSweep(): void {
  running = false;
}

/**
 * Independent liveness watchdog for the sweep loop. The chain re-arms
 * via setTimeout outside per-session error handling, so it "can't"
 * break — but a hung sequential `await sweepSession` did exactly that
 * (2026-05-19, group-wide 3h45m freeze). SWEEP_SESSION_TIMEOUT_MS now
 * bounds each session, but this is the structural backstop: if no tick
 * has completed in SWEEP_STALL_THRESHOLD_MS, log loudly and re-arm a
 * fresh generation (the old chain's next link sees a generation
 * mismatch and dies, so there is never a double chain). `unref()`'d so
 * it never holds the process open by itself.
 */
function startSweepWatchdog(): void {
  if (sweepWatchdogStarted) return;
  sweepWatchdogStarted = true;
  const iv = setInterval(() => {
    if (!running) return;
    const since = Date.now() - lastSweepCompletedAt;
    if (since > SWEEP_STALL_THRESHOLD_MS) {
      log.error('Host sweep stalled — re-arming a fresh sweep chain', {
        sinceLastCompletedMs: since,
        thresholdMs: SWEEP_STALL_THRESHOLD_MS,
      });
      sweepGeneration += 1;
      lastSweepCompletedAt = Date.now(); // avoid immediate re-fire if the re-arm is also slow
      sweep(sweepGeneration);
    }
  }, SWEEP_STALL_THRESHOLD_MS);
  iv.unref?.();
}

async function sweep(generation: number): Promise<void> {
  if (!running) return;
  if (generation !== sweepGeneration) return; // superseded by a watchdog re-arm

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      // Per-session isolation + timeout: a session whose inbound.db is
      // wedged under VirtioFS must not strand the whole tick (the
      // 2026-05-19 group-wide freeze). A timeout or throw on one
      // session is logged and skipped; the loop continues.
      try {
        await withTimeout(sweepSession(session), SWEEP_SESSION_TIMEOUT_MS, session.id);
      } catch (err) {
        if (err instanceof SweepTimeoutError) {
          log.error('Sweep skipped a session (timed out) — continuing tick', {
            sessionId: session.id,
            timeoutMs: SWEEP_SESSION_TIMEOUT_MS,
          });
        } else {
          log.error('sweepSession threw — continuing tick', {
            sessionId: session.id,
            err,
          });
        }
      }
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // (Stranded-recurring-task revival removed.) That band-aid existed
  // because a series LIVED in a session's inbound.db: when the session
  // closed with no active successor, the sweep — which only iterates
  // active sessions — never saw the row and the series stranded forever.
  // The schedule is now the agent-group-scoped, host-only schedule.db,
  // independent of any session's lifecycle. A closed session no longer
  // strands its series: the next sweep of ANY active session in the
  // agent group materializes the due occurrence from schedule.db, and
  // the one-time boot migration (migrate-legacy-series.ts) imports any
  // pre-existing series out of old inbound.dbs. The whole stranded class
  // is gone with the storage move — there is nothing left to revive.

  // Tick completed — the loop is alive. Bump the watchdog heartbeat and
  // re-arm under our generation (a watchdog re-arm would have bumped the
  // generation, retiring this link).
  lastSweepCompletedAt = Date.now();
  if (generation === sweepGeneration) {
    setTimeout(() => sweep(generation), SWEEP_INTERVAL_MS);
  }
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 1b. GC stranded kind='system' MCP round-trip rows whose consumer
    // timed out before acking (search_conversations / ask_user_question /
    // generate_image). Past the grace window no live turn can still be
    // awaiting them; left pending they accumulate unbounded. Cheap UPDATE,
    // independent of outDb so it runs even before a container has started.
    const gcd = gcStaleSystemRows(inDb);
    if (gcd > 0) {
      log.debug('GC stranded system rows', { sessionId: session.id, count: gcd });
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      // Fire one `task.fired` per due task row before the wake so plugins
      // can stamp per-task pre-wake state (e.g. sender-identity) that
      // the fresh container poll reads on its first iteration. This is
      // emitted unconditionally — plugins are no-ops when no listener
      // is registered (`emitEngineEvent` short-circuits).
      const dueTasks = getDueTaskRows(inDb);
      for (const t of dueTasks) {
        emitEngineEvent('task.fired', {
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
          taskId: t.id,
          seriesId: t.series_id,
          taskContent: t.content,
        });
      }
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      await wakeContainer(session);
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: idle timeout + stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id, dueCount);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Fire-time materialization of due scheduled series.
    //
    // The schedule (series, recurrence, next-fire, status) lives in the
    // host-only agent-group schedule.db (schedule-store.ts), NOT in this
    // session's inbound.db. handleRecurrence reads the due series from
    // schedule.db (host owns it alone — no VirtioFS reader, so the
    // torn-page class is structurally impossible there), INSERTs ONE
    // pending occurrence into inbound.db per due series, then advances
    // each series in schedule.db.
    //
    // This is the S405 structural fix: the every-sweep-tick recurrence
    // churn against a container-polled inbound.db is gone. The only
    // inbound.db scheduling write is the single fire-time occurrence
    // INSERT — the same one unavoidable write the wake path already
    // performs, container-side lever-1 (withInboundDb retry) still covers
    // it, and the materializer is idempotent (skips if a prior
    // unconsumed occurrence is still live + ON CONFLICT(id) DO NOTHING).
    // The S405 lever-2 recurrence-defer machinery + stranded-task
    // revival are retired with this change — both fought the race this
    // removes at the source.
    //
    // Also project a read-only task_series snapshot of the agent group's
    // live series into inbound.db in this same bounded write window so
    // the container's list_tasks can read its task list locally without
    // ever opening the host-only schedule.db.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    try {
      const { openScheduleDb, listLiveSeries } = await import('./modules/scheduling/schedule-store.js');
      const { projectSeriesSnapshot } = await import('./modules/scheduling/db.js');
      const sched = openScheduleDb(session.agent_group_id);
      try {
        projectSeriesSnapshot(inDb, listLiveSeries(sched));
      } finally {
        sched.close();
      }
    } catch (err) {
      // A snapshot failure only degrades list_tasks freshness for one
      // tick; it must never abort the sweep or block materialization.
      log.error('Failed to project task_series snapshot', { sessionId: session.id, err });
    }
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

// Session-level claim-stuck circuit-breaker. The per-message MAX_TRIES
// poison-pill cap in resetStuckProcessingRows is structurally unable to
// break a *session-level* stall: a warm session whose container can't
// drain its backlog within the claim tolerance gets killed
// (reason='claim-stuck'), its rows reset to pending, respawns, re-claims,
// re-stalls — and a busy group chat keeps refilling the backlog with
// fresh tries=0 messages, so no single row ever climbs to MAX_TRIES
// before being superseded. Observed 2026-05-17 in the merged Degenerates
// session: ~45 min / 20+ consecutive claim-stuck kills, zero
// 'marked as failed', only a human session-restart broke it.
//
// Mirrors the MAX_RECURRENCE_DEFERS lever above: an in-memory per-session
// consecutive-count, bumped on each claim-stuck kill, CLEARED the moment
// the session shows progress (a clean idle stop — the container drained
// and went quiet). At the cap we stop resetting the stuck batch back to
// pending and instead fail it outright (regardless of per-message tries),
// which drains the poison backlog so the session can accept fresh work
// instead of looping forever. 5 × ~2min claim tolerance ≈ ~10 min
// worst-case loop before the breaker trips — bounded, and unambiguous
// (5 consecutive claim-stuck kills with no intervening idle = a stuck
// loop, not transient slowness).
const MAX_CONSECUTIVE_CLAIM_STUCK_KILLS = 5;
const claimStuckKills = new Map<string, number>();

function claimStuckKillCount(sessionId: string): number {
  return claimStuckKills.get(sessionId) ?? 0;
}
function bumpClaimStuckKill(sessionId: string): number {
  const n = (claimStuckKills.get(sessionId) ?? 0) + 1;
  claimStuckKills.set(sessionId, n);
  return n;
}
function clearClaimStuckKill(sessionId: string): void {
  claimStuckKills.delete(sessionId);
}

/**
 * Test seam: pure decision for the claim-stuck circuit-breaker. Given the
 * consecutive claim-stuck-kill count for a session, should this kill
 * force-fail the stuck batch (true) instead of the normal reset-with-
 * backoff (false)? Mirrors _shouldRunRecurrenceForTesting.
 */
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

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
  dueCount: number,
): void {
  const now = Date.now();
  // Adaptive keep-warm: if the operator has sent a human (chat-sdk)
  // message recently, this is a live conversation — keep the container
  // warm so the next turn reuses the warm app-server + handshaked MCP
  // servers instead of a full cold start. Falls back to the short
  // timeout for background/recurring-task-only sessions.
  const idleTimeoutMs = pickIdleTimeoutMs({
    now,
    lastHumanInboundMs: getLatestHumanInboundMs(inDb),
    baseIdleMs: IDLE_TIMEOUT,
    activeIdleMs: ACTIVE_IDLE_TIMEOUT,
    activeWindowMs: ACTIVE_CONVERSATION_WINDOW_MS,
  });
  const decision = decideStuckAction({
    now,
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
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
    // Progress signal: a container that idled out cleanly drained its
    // work and went quiet, so any prior claim-stuck loop is broken.
    // Reset the circuit-breaker so a later, unrelated transient stall
    // starts counting fresh rather than inheriting stale strikes.
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
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  const consecutiveClaimStuckKills = bumpClaimStuckKill(session.id);
  const forceFail = consecutiveClaimStuckKills >= MAX_CONSECUTIVE_CLAIM_STUCK_KILLS;
  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
    consecutiveClaimStuckKills,
    ...(forceFail ? { circuitBreaker: 'tripped — force-failing stuck batch to break the claim-stuck loop' } : {}),
  });
  killContainer(session.id, 'claim-stuck');
  emitEngineEvent('container.stuck', { sessionId: session.id, agentGroupId: session.agent_group_id });
  // Normal path: reset the stuck rows with backoff and let a fresh
  // container retry. Circuit-breaker tripped (MAX consecutive
  // claim-stuck kills with no intervening clean idle): the per-message
  // MAX_TRIES cap can't end this loop (a busy chat keeps refilling the
  // backlog with tries=0 rows), so force-fail the currently-claimed
  // batch regardless of tries — that drains the poison backlog so the
  // session can take fresh work instead of looping forever. Clear the
  // counter so the now-unstuck session starts from a clean slate.
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck', undefined, forceFail);
  if (forceFail) {
    log.warn('Claim-stuck circuit-breaker tripped — force-failed stuck batch', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      consecutiveClaimStuckKills,
    });
    clearClaimStuckKill(session.id);
  }
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  forceFail = false,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb, forceFail);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDbForTesting?: Database.Database,
  // Circuit-breaker tripped: fail every currently-claimed row outright,
  // ignoring per-message tries AND the in-backoff skip below. This is
  // the ONLY way to drain a session-level claim-stuck loop — the normal
  // per-message path can't, because the in-backoff skip never bumps
  // tries (so MAX_TRIES is never reached) and a busy chat keeps adding
  // fresh tries=0 rows. Caller (enforceRunningContainerSla) gates this
  // on MAX_CONSECUTIVE_CLAIM_STUCK_KILLS.
  forceFail = false,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    // Recover a message stuck in EITHER 'pending' or 'processing'. A
    // codex resume deadlock leaves the row at 'processing' (the in-
    // container agent-runner claimed it, then the turn hung and the
    // container was reaped). The old 'pending'-only lookup returned
    // undefined for that row, so it was skipped here while its orphan
    // processing_ack got deleted below — stranding the message at
    // 'processing' with no path to ever pick it up (silent multi-hour
    // wedge, Teddy DM 2026-05-18). 'completed'/'failed' stay excluded.
    const msg = getRecoverableMessage(inDb, message_id);
    if (!msg) continue;

    if (forceFail) {
      // Drop the poison row regardless of tries or pending backoff.
      // Skipping in-backoff rows here (as the normal path does) would
      // leave them to re-stall the next container — exactly the loop
      // the circuit-breaker exists to end.
      markMessageFailed(inDb, msg.id);
      log.warn('Message force-failed by claim-stuck circuit-breaker', {
        messageId: msg.id,
        sessionId: session.id,
        tries: msg.tries,
        reason,
      });
      continue;
    }

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  // We're safe to write outbound.db here because we just killed the container
  // that owned it (or it crashed and left no writer behind).
  // outDb was opened readonly for reads above; reopen with write access for this delete.
  // Tests pass an in-memory writable DB, so let the test-only wrapper inject
  // that handle instead of reopening the session path.
  const ownsDb = !writableOutDbForTesting;
  let outDbRw: Database.Database | null = writableOutDbForTesting ?? null;
  try {
    if (!outDbRw) outDbRw = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(outDbRw);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) outDbRw?.close();
  }
}
