/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { registerDeliveryAction } from '../../delivery.js';
import { getDeliveredIds, getDueOutboundMessages } from '../../db/session-db.js';
import { heartbeatPath, openInboundDb, openOutboundDb } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function triggerTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * True if the session has at least one user-facing outbound message that
 * the host hasn't delivered yet. Used by the refresh tick to skip a
 * `setTyping` call when delivery is imminent — otherwise an in-flight
 * `setTyping` HTTP request started ~1–4s before delivery arrives at the
 * platform *after* the message, and the indicator visibly lingers for
 * several seconds. Pure read-only DB peek; both handles are closed
 * before return.
 *
 * Local fork patch (Optimus): upstream NanoClaw doesn't see the lingering
 * indicator often enough to file it. Kept narrow on purpose.
 */
function hasPendingUserFacingOutbound(agentGroupId: string, sessionId: string): boolean {
  let outDb: ReturnType<typeof openOutboundDb> | null = null;
  let inDb: ReturnType<typeof openInboundDb> | null = null;
  try {
    outDb = openOutboundDb(agentGroupId, sessionId);
    const due = getDueOutboundMessages(outDb);
    if (due.length === 0) return false;
    inDb = openInboundDb(agentGroupId, sessionId);
    const delivered = getDeliveredIds(inDb);
    for (const msg of due) {
      if (delivered.has(msg.id)) continue;
      if (msg.kind === 'system') continue;
      if (msg.channel_type === 'agent') continue;
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      outDb?.close();
    } catch {
      /* best-effort */
    }
    try {
      inDb?.close();
    } catch {
      /* best-effort */
    }
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(channelType, platformId, threadId).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    // A user-facing outbound row is queued and the delivery loop will
    // post it within ~1s. Skip the tick — firing setTyping now risks
    // the HTTP call landing AFTER the message, leaving the indicator
    // visible for several seconds post-delivery (Discord caches the
    // typing event for ~10s). Keep the refresher running; if delivery
    // happens, `pauseTypingRefreshAfterDelivery` extends the skip
    // window. If it doesn't (e.g. delivery fails), the next tick
    // resumes typing normally.
    if (hasPendingUserFacingOutbound(entry.agentGroupId, sessionId)) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId).catch(() => {});
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    interval,
    startedAt,
    pausedUntil: 0,
  });
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}

// Register the silent-turn-complete delivery action here (not in
// delivery.ts) so the handler ships with the module that owns
// stopTypingRefresh — no cross-module wiring, no glue from embedding
// hosts. The action fires when the container finishes a turn that
// produced no user-facing output (e.g. a reflection task that emitted
// only `<internal>` content); without this signal, the typing
// indicator keeps refreshing on heartbeat freshness for the full
// HEARTBEAT_FRESH_MS window after the turn ends, leaving the user
// staring at "is typing…" with no message.
//
// Local fork patch (Optimus): upstream NanoClaw doesn't run reflection
// turns and so doesn't expose this UX gap. Stays in the typing module
// because that's where the fix is — not a behavior other hosts need.
registerDeliveryAction('silent_turn_complete', async (_content, session) => {
  stopTypingRefresh(session.id);
});
