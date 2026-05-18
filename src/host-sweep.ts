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

import {
  getActiveSessions,
  getAgentGroupIdsWithClosedNoActiveSessions,
  getSessionsByAgentGroup,
  findSessionByAgentGroup,
} from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { hasDueStrandedRecurringTask } from './modules/scheduling/strand-detect.js';
import { resolveSession } from './session-manager.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getDueTaskRows,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { IDLE_TIMEOUT } from './config.js';
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

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    // Prune S405 defer tracker for sessions that left the active set
    // (closed/deleted between sweeps) so the Map can't grow unbounded
    // over a long-lived host process. Active sessions self-clear via
    // clearRecurrenceDefer on their next idle sweep; this only catches
    // the active→gone transition that never gets that sweep.
    if (recurrenceDefers.size > 0) {
      const activeIds = new Set(sessions.map((s) => s.id));
      for (const id of recurrenceDefers.keys()) {
        if (!activeIds.has(id)) recurrenceDefers.delete(id);
      }
    }
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // Independent of the active-session loop: revive recurring tasks
  // stranded in closed sessions of agents that have no active session
  // (and thus no inbound to trigger the carry-forward plugins). Own
  // try/catch so a failure here never aborts the main sweep.
  try {
    await reviveStrandedRecurringTasks();
  } catch (err) {
    log.error('Stranded-task revival error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

/**
 * Revive recurring tasks stranded in closed sessions.
 *
 * The bug this closes: a scheduled-only agent whose session was closed
 * (operator clear-session, restart-induced close, v1-migration legacy) and
 * which receives no further inbound has no path to ever emit
 * `session.created`. The host sweep only iterates ACTIVE sessions, so a due
 * recurring task in the closed session's inbound.db never wakes a container;
 * the carry-forward (apps/optimus task-carry-forward.ts) and maintenance
 * (maintenance-task.ts) re-seed plugins only fire on `session.created`, so
 * the series strands forever. Real instance: the daily `dream-<agId>` task
 * silently stopped firing for days once its session was cleared.
 *
 * Fix: each sweep tick, for every agent group that has a closed session and
 * NO active session, probe each closed session's inbound.db READ-ONLY for a
 * due recurring task. If one exists, create a fresh session via the canonical
 * `resolveSession` path and emit `session.created` — exactly the contract
 * (`router.ts` inbound + `backfill-on-register.ts`) the re-seed plugins
 * already key off. The plugins then carry the series into the fresh session
 * with a freshly-computed `process_after`, the next sweep sees it due in an
 * active session, and the normal wake path fires it.
 *
 * Invariants preserved:
 *  - S405: detection is read-only; the only host write is the plugins'
 *    insert into the BRAND-NEW session's inbound.db, which no container has
 *    ever polled — the torn-page hazard requires a container mid-poll of the
 *    same file and there is none.
 *  - No double-create: `getAgentGroupIdsWithClosedNoActiveSessions` excludes
 *    groups with an active session, the in-loop `findSessionByAgentGroup`
 *    recheck closes the inbound-arrived-mid-tick race, and `resolveSession`
 *    returning `created:false` short-circuits before emit.
 *  - No double-fire: the re-seed plugins are idempotent (match by
 *    id/series_id) and seed exactly one future occurrence from the cron, not
 *    the overdue stranded row. The stranded row stays in the still-closed old
 *    session's inbound.db, which is never swept again, so it cannot fire.
 */
interface ReviveStrandedDeps {
  getAgentGroupIdsWithClosedNoActiveSessions: typeof getAgentGroupIdsWithClosedNoActiveSessions;
  getAgentGroup: typeof getAgentGroup;
  findSessionByAgentGroup: typeof findSessionByAgentGroup;
  getSessionsByAgentGroup: typeof getSessionsByAgentGroup;
  inboundDbPath: typeof inboundDbPath;
  existsSync: (p: string) => boolean;
  openInboundReadonly: (p: string) => Database.Database;
  hasDueStrandedRecurringTask: typeof hasDueStrandedRecurringTask;
  resolveSession: typeof resolveSession;
  emitEngineEvent: typeof emitEngineEvent;
  now: () => string;
}

const defaultReviveStrandedDeps: ReviveStrandedDeps = {
  getAgentGroupIdsWithClosedNoActiveSessions,
  getAgentGroup,
  findSessionByAgentGroup,
  getSessionsByAgentGroup,
  inboundDbPath,
  existsSync: fs.existsSync,
  openInboundReadonly: (p) => new Database(p, { readonly: true, fileMustExist: true }),
  hasDueStrandedRecurringTask,
  resolveSession,
  emitEngineEvent,
  now: () => new Date().toISOString(),
};

async function reviveStrandedRecurringTasks(deps: ReviveStrandedDeps = defaultReviveStrandedDeps): Promise<void> {
  const now = deps.now();

  for (const agentGroupId of deps.getAgentGroupIdsWithClosedNoActiveSessions()) {
    const agentGroup = deps.getAgentGroup(agentGroupId);
    if (!agentGroup) continue;

    // Race guard: an inbound message could have created an active session
    // between the v2.db candidate query and now. If so, the normal
    // active-sweep path owns this group — skip.
    if (deps.findSessionByAgentGroup(agentGroupId)) continue;

    let needRevive = false;
    let strandedSessionId: string | undefined;
    for (const session of deps.getSessionsByAgentGroup(agentGroupId)) {
      if (session.status !== 'closed') continue;
      const inPath = deps.inboundDbPath(agentGroupId, session.id);
      if (!deps.existsSync(inPath)) continue;
      // READ-ONLY — the host never writes a closed session's inbound.db.
      const db = deps.openInboundReadonly(inPath);
      try {
        if (deps.hasDueStrandedRecurringTask(db, now)) {
          needRevive = true;
          strandedSessionId = session.id;
          break;
        }
      } finally {
        db.close();
      }
    }
    if (!needRevive) continue;

    // Channel-less, agent-scoped session — matches how maintenance-task.ts
    // seeds the dream series (null messaging group / thread). The
    // carry-forward plugin permits a null-messaging-group session for
    // series re-seed.
    const { session, created } = deps.resolveSession(agentGroupId, null, null, 'agent-shared');
    if (!created) continue; // an active session appeared concurrently — let the normal path own it
    deps.emitEngineEvent('session.created', { session, created });
    log.info('Revived stranded recurring task: created session for closed-only agent group', {
      agentGroupId,
      newSessionId: session.id,
      strandedSessionId,
    });
  }
}

/** Test seam: inject fakes for the engine deps; no DB / filesystem mocking. */
export function _reviveStrandedRecurringTasksForTesting(deps: Partial<ReviveStrandedDeps>): Promise<void> {
  return reviveStrandedRecurringTasks({ ...defaultReviveStrandedDeps, ...deps });
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

    // 5. Recurrence fanout for completed recurring tasks.
    //
    // S405 lever 2 — host write quiescing. handleRecurrence INSERTs the
    // next occurrence into inbound.db. inbound.db is journal_mode=DELETE
    // read by the container over VirtioFS; a host write that lands while
    // the container is mid-poll can be observed as a torn page →
    // SQLITE_CORRUPT in the runner (the proven S405 crash-loop on the
    // merged Degenerates session: an every-5-min recurrence written into
    // a continuously-polled agent-shared inbound.db). The recurrence row
    // stays status='completed' with recurrence intact until processed
    // (getCompletedRecurring + clearRecurrence), so deferring one sweep
    // loses nothing — the next occurrence just inserts ~60s later, after
    // the (typically task-only, ~2-min) container has idle-killed and
    // the DB has exactly one accessor again. Container retry-on-corrupt
    // (lever 1) is the inner safety net; this removes the collision at
    // the source for the common case.
    //
    // Bounded so a continuously-alive session can't defer forever: after
    // MAX_RECURRENCE_DEFERS consecutive alive-sweeps we let the write
    // through and rely on lever 1's retry. A session that never idles is
    // already pathological for a recurring task; unbounded deferral
    // would silently stop its schedule, which is worse than a
    // retried-corrupt read.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence, getDueRecurringSeriesIds } = await import('./modules/scheduling/recurrence.js');
    const dueSeries = getDueRecurringSeriesIds(inDb);
    if (dueSeries.length > 0) {
      // Force the (per-session, corruption-safe) write if the container
      // is dead OR ANY due series has independently hit its cap. Keying
      // the cap per series — not per session — is the 2026-05-16 fix:
      // the old per-session counter was reset to 0 every time the write
      // went through for ANY reason, so a high-frequency recurring task
      // (5-min poller) sharing the inbound.db perpetually reset a
      // co-resident low-frequency task's (dream, 04:00) progress toward
      // the cap. The dream series sat completed-with-recurrence for
      // 8 min (vs the ~5-min design bound) because the shared counter
      // never reached 5: it climbed 1→4, an unrelated gate-open reset
      // it, repeat (29 consecutive defer log lines, observed). Per
      // series, each independently reaches the cap within
      // MAX_RECURRENCE_DEFERS sweeps regardless of co-resident traffic,
      // so the orphan window is bounded to ~5 min for EVERY series.
      const capped = dueSeries.some((s) => recurrenceDeferCount(session.id, s) >= MAX_RECURRENCE_DEFERS);
      if (!alive || capped) {
        // The write services every due series at once (one inbound.db
        // write window — preserves S405 per-session quiescing); clear
        // each serviced series' counter.
        for (const s of dueSeries) clearRecurrenceDefer(session.id, s);
        await handleRecurrence(inDb, session);
      } else {
        // Defer: every due series accrues pressure independently. No
        // cross-series reset — that was the starvation bug.
        for (const s of dueSeries) {
          const n = bumpRecurrenceDefer(session.id, s);
          log.debug('Deferred recurrence: container mid-poll (S405 quiescing)', {
            sessionId: session.id,
            seriesId: s,
            consecutiveDefers: n,
            maxDefers: MAX_RECURRENCE_DEFERS,
          });
        }
      }
    }
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

// S405 lever 2 — bounded recurrence-deferral tracker. Keyed by
// (sessionId, seriesId): counts consecutive sweeps where a given
// series' recurrence fanout was skipped because a container was
// actively polling that session's inbound.db. Per-series (not
// per-session) so a high-frequency recurring task can't reset a
// co-resident low-frequency one's progress toward the cap (the
// 2026-05-16 degenerate dream-task 8-min orphan). Cleared the moment
// that series' write goes through (container idle, or its cap reached).
// 60s sweep × MAX_RECURRENCE_DEFERS=5 caps worst-case schedule slip at
// ~5 min PER SERIES — acceptable vs. the corrupt crash-loop it
// prevents; lever 1 still covers the post-cap write.
const MAX_RECURRENCE_DEFERS = 5;
const recurrenceDefers = new Map<string, number>();

function deferKey(sessionId: string, seriesId: string): string {
  // \x1f (unit separator) can't appear in a session or series id, so
  // it's a collision-free composite key.
  return `${sessionId}\x1f${seriesId}`;
}
function recurrenceDeferCount(sessionId: string, seriesId: string): number {
  return recurrenceDefers.get(deferKey(sessionId, seriesId)) ?? 0;
}
function bumpRecurrenceDefer(sessionId: string, seriesId: string): number {
  const k = deferKey(sessionId, seriesId);
  const n = (recurrenceDefers.get(k) ?? 0) + 1;
  recurrenceDefers.set(k, n);
  return n;
}
function clearRecurrenceDefer(sessionId: string, seriesId: string): void {
  recurrenceDefers.delete(deferKey(sessionId, seriesId));
}

/**
 * Test seam for the S405 lever-2 defer gate. Pure decision: given
 * whether a container is alive and the current consecutive-defer
 * count, should the recurrence write run this sweep? Mirrors the
 * inline condition in sweepSession so the bounded-defer invariant is
 * unit-tested without mocking the container runner / filesystem.
 */
export function _shouldRunRecurrenceForTesting(alive: boolean, consecutiveDefers: number): boolean {
  return !alive || consecutiveDefers >= MAX_RECURRENCE_DEFERS;
}
export const _MAX_RECURRENCE_DEFERS_FOR_TESTING = MAX_RECURRENCE_DEFERS;
export function _recurrenceDeferHelpersForTesting() {
  return {
    count: recurrenceDeferCount,
    bump: bumpRecurrenceDefer,
    clear: clearRecurrenceDefer,
    reset: () => recurrenceDefers.clear(),
  };
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
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
    dueCount,
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
    const msg = getMessageForRetry(inDb, message_id, 'pending');
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
