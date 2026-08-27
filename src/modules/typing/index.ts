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
import { unguarded } from '../../guard/index.js';
import { heartbeatPath, withExistingMailboxSession } from '../../session-manager.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';

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
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  checking: boolean;
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

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance);
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
async function hasPendingUserFacingOutbound(agentGroupId: string, sessionId: string): Promise<boolean> {
  try {
    return (
      (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => {
        const delivered = mailbox.getDeliveredIds();
        return mailbox
          .getDueMessages(delivered)
          .some((message) => message.kind !== 'system' && message.channelType !== 'agent');
      })) ?? false
    );
  } catch {
    return false;
  }
}

/**
 * True if the container's currently-processing inbound rows are ALL
 * non-user (kind='task' / 'system') — i.e. this is a maintenance /
 * recurring-task / reflection turn, not a user-conversation turn.
 *
 * Why (screenshot 2026-05-15, ai-friends): the agent answered a user
 * message, then a *deferred maintenance task* was re-processed as a
 * separate ~24s turn that emitted only `<internal>`. The typing
 * refresher (started for the user turn) stays alive on heartbeat
 * freshness, and `hasPendingUserFacingOutbound` is false for a silent
 * task turn (it produces no outbound) — so `triggerTyping` fired for
 * the whole task turn and the user saw "Optimus is typing…" with no
 * message coming. S290's `silent_turn_complete` only stops typing
 * *after* the silent turn ends — it can't suppress the indicator
 * *during* a long deferred-task turn. This is the precise gate for
 * "don't show typing for a turn that isn't answering the user."
 *
 * Mirrors the cross-process `processing_ack` signal used by the
 * scheduled-task reply-pill fix (mcp-tools/core.ts isTaskOnlyTurn):
 * poll-loop marks the in-flight batch processing before the agent
 * runs, so during a task-only turn every processing row maps to a
 * kind='task'/'system' messages_in row.
 *
 * Fails OPEN (returns false → typing shows) on any error or when no
 * row is processing: a DB hiccup must never silently suppress the
 * indicator for a genuine user turn. Pure read-only peek; handles
 * closed in finally. Local fork patch (Optimus): upstream doesn't run
 * deferred maintenance/reflection turns so doesn't hit this.
 */
/**
 * Pure decision split out so the suppression rule is unit-testable
 * without real session-DB files (same rationale as host-sweep's
 * `decideStuckAction`). `processingCount` = rows currently in
 * processing_ack; `hasUserKindProcessing` = at least one of those maps
 * to a kind in ('chat','chat-sdk') messages_in row.
 *
 * Suppress (true) ONLY when there IS an active turn (>0 processing)
 * and NONE of it is user-conversation work. No processing rows →
 * false (let the grace/heartbeat logic decide; not our concern).
 */
export function decideSuppressTypingForNonUserTurn(processingCount: number, hasUserKindProcessing: boolean): boolean {
  if (processingCount === 0) return false;
  return !hasUserKindProcessing;
}

async function isNonUserProcessingTurn(agentGroupId: string, sessionId: string): Promise<boolean> {
  try {
    return (
      (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => {
        const claims = mailbox.getProcessingClaims();
        const ids = claims.map((claim) => claim.messageId);
        return decideSuppressTypingForNonUserTurn(ids.length, mailbox.hasUserConversationMessages(ids));
      })) ?? false
    );
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    // Keep the stored entry self-consistent: a re-trigger can arrive from
    // a different chat address (agent-shared sessions span messaging
    // groups, possibly on different platforms/instances), so the address
    // fields and the owning instance must move together — a torn entry
    // (old address + new instance) would hand e.g. a telegram platformId
    // to a Slack instance's setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry || entry.checking) return;
    entry.checking = true;
    void (async () => {
      // Inside a post-delivery pause: skip setTyping but keep the interval
      // running so it resumes automatically once the pause expires.
      if (entry.pausedUntil > Date.now()) return;

      // Avoid racing a typing request behind an imminent outbound delivery.
      if (await hasPendingUserFacingOutbound(entry.agentGroupId, sessionId)) return;

      // Silent maintenance/task work must not advertise a user-facing reply.
      if (await isNonUserProcessingTurn(entry.agentGroupId, sessionId)) return;

      const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
      if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
        await triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance);
        return;
      }

      // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
      clearInterval(entry.interval);
      typingRefreshers.delete(sessionId);
    })().finally(() => {
      entry.checking = false;
    });
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
    pausedUntil: 0,
    checking: false,
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
/**
 * Telemetry: classify WHY a turn ended silent.
 *
 * Without this, every silent turn collapses to one indistinguishable
 * `silent_turn_complete` log line — "agent correctly stayed quiet on
 * ambient group chatter" reads identically to "agent ignored a user who
 * @mentioned it or DM'd it." That ambiguity is exactly what made the
 * 2026-05-16 Barret incident take a full reverse log-correlation to
 * diagnose. (Container-crash turns do NOT reach here at all — the runner
 * only emits silent_turn_complete on a *completed* result with zero
 * deliverable output, so a silent turn is always agent-chosen; the crash
 * case is the separate "wake with no terminal action" gap, visible via
 * `Container exited`.)
 *
 * Resolves the turn's wake cause from the most-recent trigger=1 inbound
 * row and emits a single structured line with `addressed` — true when the
 * agent stayed silent on a turn a human directly aimed at it (DM, a
 * mention token, or a reply-to-bot). `addressed=true` silent turns are
 * the suspicious ones; grep `Silent turn classified` + `addressed=true`
 * to surface them fleet-wide instead of guessing.
 */
export type SilentWakeCause =
  | 'task'
  | 'dm'
  | 'pattern'
  | 'group-mention'
  | 'reply-to-bot'
  | 'group-ambient'
  | 'unknown';

/**
 * Pure classification of why a silent turn ended, split out so the rule
 * is unit-testable without real session-DB files (same approach as
 * `decideSuppressTypingForNonUserTurn` / host-sweep's `decideStuckAction`).
 *
 *   triggerRow  — the most-recent trigger=1, non-system messages_in row
 *                 for this turn (or null if none resolvable).
 *   isDm        — true when the session's messaging group is a 1:1 DM
 *                 (is_group === 0). A silent turn in a DM is almost
 *                 always wrong: one human, who typed to this agent.
 *
 * `addressed` is the signal that matters — true when a human aimed this
 * turn directly at the agent (DM, a platform mention token, or a
 * reply-to-bot). `addressed && silent` is the suspicious combination the
 * Barret incident needed reverse log-correlation to even see.
 */
export function classifyWakeCause(
  triggerRow: { kind: string; content: string } | null,
  isDm: boolean,
): { wakeCause: SilentWakeCause; addressed: boolean } {
  if (!triggerRow) return { wakeCause: 'unknown', addressed: false };

  // Scheduled/recurring task wake — silence here is normal (a
  // maintenance reflection with nothing to report). Never "addressed."
  if (triggerRow.kind === 'task') return { wakeCause: 'task', addressed: false };

  // Mention / reply-to-bot detection from the persisted content. The
  // routing-time isMention boolean isn't stored, so we read the same
  // signals the channel adapter wrote: a platform mention token in the
  // text, or a replyTo block (reply-to-bot is resolved host-side at
  // routing but the parent ref is what's persisted here).
  let hasMentionToken = false;
  let isReply = false;
  try {
    const parsed = JSON.parse(triggerRow.content) as {
      text?: string;
      engageMode?: string;
      replyTo?: { messageId?: string };
    };
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    // Discord <@id> / <@!id>, Slack <@U…>, Telegram @name — any platform
    // mention token. Coarse on purpose: this is a telemetry signal, not
    // an auth gate, and false-positives here only over-flag.
    hasMentionToken = /<@!?\w+>|(^|\s)@\w/.test(text);
    isReply = typeof parsed.replyTo?.messageId === 'string';
    if (parsed.engageMode === 'pattern') {
      return { wakeCause: 'pattern', addressed: true };
    }
  } catch {
    // Non-JSON / unexpected shape — fall through with both false.
  }

  const addressed = isDm || hasMentionToken || isReply;
  const wakeCause: SilentWakeCause = isDm
    ? 'dm'
    : hasMentionToken
      ? 'group-mention'
      : isReply
        ? 'reply-to-bot'
        : 'group-ambient';
  return { wakeCause, addressed };
}

async function classifySilentTurn(session: {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
}): Promise<void> {
  try {
    const row =
      (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.getLatestTriggeringInbound(),
      )) ?? null;
    const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const { wakeCause, addressed } = classifyWakeCause(row, mg?.is_group === 0);
    log.info('Silent turn classified', {
      sessionId: session.id,
      wakeCause,
      addressed,
      ...(addressed ? { warn: 'agent stayed silent on a directly-addressed turn' } : {}),
    });
  } catch (err) {
    // Telemetry must never break delivery. Swallow and move on.
    log.debug('Silent turn classification failed', { sessionId: session.id, err: String(err) });
  }
}

registerDeliveryAction(
  'silent_turn_complete',
  async (_content, session) => {
    stopTypingRefresh(session.id);
    await classifySilentTurn(session);
  },
  unguarded('Telemetry-only action that stops typing and classifies an already-completed turn.'),
);
