/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { emitEngineEvent } from './engine/events.js';
import { getChannelAdapter, getChannelDefaults } from './channels/channel-registry.js';
import { resolveThreadPolicy, resolveUnknownSenderPolicy } from './channels/channel-defaults.js';
import { gateCommand } from './command-gate.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findMostRecentClosedSessionForAgent, findSessionByAgentGroup, findSessionForAgent } from './db/sessions.js';
import { wasDeliveredByBot } from './db/session-db.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect, openInboundDb } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Message-interceptor hook. Runs at the very top of routeInbound, before
 * messaging-group resolution. When an interceptor returns true the message is
 * consumed and routing stops. Multiple interceptors may register; they run in
 * registration order and the first to claim the message (return true) wins.
 *
 * Used by modules to capture free-text DM replies during multi-step approval
 * flows — the permissions module (agent naming during channel registration)
 * and the approvals module (reject-with-reason capture).
 */
export type MessageInterceptorFn = (event: InboundEvent) => Promise<boolean>;

const messageInterceptors: MessageInterceptorFn[] = [];

export function registerMessageInterceptor(fn: MessageInterceptorFn): void {
  messageInterceptors.push(fn);
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // Pre-route interceptors — let modules consume messages before any routing
  // (e.g. free-text DM replies during multi-step approval flows). They run in
  // registration order; the first to claim the message stops routing. The
  // sequential await is intentional — first-to-claim is order-dependent.
  for (const intercept of messageInterceptors) {
    if (await intercept(event)) return;
  }

  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel. For
  //    threaded adapters (Discord), chat-sdk emits `thread.id = channel_id`
  //    when the message arrives on the channel itself (not inside a real
  //    Discord thread). Treat those as not-a-thread so the per-thread
  //    session-mode forcing in deliverToAgent doesn't shard a single channel
  //    into two parallel sessions — the v1→v2 cutover seed creates sessions
  //    with `thread_id=NULL`, but a live inbound carrying `threadId =
  //    platformId` would otherwise miss that lookup and create a duplicate.
  //    See investigation 2026-05-09: AI Friends, Boys Night, two DMs all had
  //    duplicate sessions until this collapse landed. Resolved by the
  //    RECEIVING instance — sibling instances of one platform can differ in
  //    thread support.
  const adapter = getChannelAdapter(event.instance ?? event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  } else if (event.threadId !== null && event.threadId === event.platformId) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;
  // Loopback gate. Shared-number platforms (and any adapter that can't
  // distinguish "bot's own message bouncing back" at the wire level) flag
  // self-replies via `isBotMessage`. The router stores the message so the
  // agent has self-context, but skips engagement so the bot does not reply
  // to itself in a tight loop — see bug investigated 2026-05-08 where
  // shared-number WhatsApp DMs spammed the user when the agent's own
  // outbound came back as inbound.
  const isBotLoopback = event.message.isBotMessage === true;

  // Self-echo gate. `isSelfMessage` is the narrower signal: THIS bot's own
  // outbound bouncing back (chat-sdk author.isMe), as opposed to any-bot
  // (`isBotMessage`, which also covers a *different* bot in the channel).
  // The bot's own status/escalation spam carries zero useful self-context,
  // so unlike a normal loopback (which we store as accumulate context) we
  // drop it from the store entirely. Without this, a high-traffic channel
  // — the dev-DM especially, which the dev-bridge floods with 🛎️/🤖/⚙️
  // status lines — piles up unbounded trigger=0 self-echo rows that sit
  // `pending` forever (Teddy DM 2026-06-03: 98 of 100 pending inbound were
  // the bot's own messages, dating back two weeks). Engagement is already
  // skipped via isBotLoopback below; this only suppresses the accumulate
  // store. Other-bot context (isBotMessage && !isSelfMessage) is untouched.
  const isSelfEcho = event.message.isSelfMessage === true;

  // Backfill short-circuit: deep-history replay (on-registration channel
  // sync, agent-requested gap heal) writes messages as accumulated context
  // only. Without this gate a year-old @-mention in the replay stream would
  // fire `evaluateEngage` and wake the agent for a stale conversation.
  // The store-with-trigger=0 path below is the same as the
  // `ignored_message_policy='accumulate'` branch, so the agent still sees
  // backfilled rows when it engages on a real future trigger.
  const isBackfill = event.message.isBackfill === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam. Exact-on-instance: an unknown named
  //    instance falls through to auto-create rather than hijacking a
  //    sibling instance's row.
  const found = getMessagingGroupWithAgentCount(
    event.channelType,
    event.platformId,
    event.instance ?? event.channelType,
  );

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    // Loopback also stays silent: a bot self-reply on an unwired channel
    // shouldn't spawn a row. Backfill stays silent too: replaying a
    // historical mention through here would spawn a row for an unwired
    // chat we never had a relationship with.
    if (!isMention || isBotLoopback || isBackfill) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      // Persist the receiving instance — without this, the first bot's row
      // would absorb every sibling instance's traffic.
      instance: event.instance ?? event.channelType,
      name: null,
      is_group: event.message.isGroup ? 1 : 0,
      // Policy from the receiving channel's declared defaults (DM vs group
      // context); undeclared adapters resolve through the behavior-faithful
      // fallback, which is 'request_approval' in both contexts — identical
      // to the historical hardcode.
      unknown_sender_policy: resolveUnknownSenderPolicy(
        event.instance ?? event.channelType,
        event.message.isGroup === true,
        event.channelType,
      ),
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    agentCount = 0;
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval. Loopback never
  //     escalates — the bot's own reply isn't a registration request.
  //     Backfill never escalates — historical mentions in a now-unwired
  //     channel aren't a request to register.
  if (agentCount === 0) {
    if (!isMention || isBotLoopback || isBackfill) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;
  emitEngineEvent('inbound.routed', { event, userId });

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';
  // Reply-to-bot detection: if the inbound carries a parent platform_message_id
  // (extracted by the channel adapter's extractReplyContext hook), check
  // whether that message was a prior bot outbound for this agent group.
  // Drives v1's `requires_trigger` parity in evaluateEngage — replying to a
  // bot message counts as a trigger in mention / mention-sticky modes even
  // without an @mention.
  const replyToMessageId =
    typeof (parsed as { replyTo?: { messageId?: string } }).replyTo?.messageId === 'string'
      ? ((parsed as { replyTo: { messageId: string } }).replyTo.messageId as string)
      : null;
  // A reply-chain-walking extractor sets `botInChain` when an ancestor
  // @-mentions the bot but was human-authored, so there is no bot-outbound
  // id for `isReplyToOurBot`'s wasDeliveredByBot lookup to resolve. It is
  // still a reply continuing a bot-addressed thread, so it counts as a
  // reply-to-bot trigger directly. (#ai-friends 2026-05-16: Mack replied
  // to Barret's "<@Optimus> do X" — the author-only chain walk never woke
  // Optimus even though the sub-thread was addressed to it.)
  const replyBotInChain = (parsed as { replyTo?: { botInChain?: boolean } }).replyTo?.botInChain === true;

  // Per-wiring thread policy inputs, resolved once per event. Each wiring's
  // threads override (NULL = inherit) resolves against the channel's declared
  // defaults, hard-bounded by the live adapter's raw capability. Undeclared
  // adapters resolve through the behavior-faithful fallback, so a NULL-threads
  // wiring reproduces the historical supportsThreads-derived routing exactly.
  const channelDefaults = getChannelDefaults(mg.instance ?? mg.channel_type, mg.channel_type);
  const supportsThreads = adapter?.supportsThreads === true;

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    // Effective thread id for THIS wiring: the event-derived address is
    // policy-stripped when the wiring (or its channel declaration) opts out
    // of threads. event.replyTo is operator intent from the CLI admin
    // transport and is never nulled. Guard: platform thread ids must never
    // collide with the reserved 'system:%' session namespace
    // (src/db/sessions.ts) — they are platform-native identifiers, and this
    // is the only place an inbound thread id enters session resolution.
    const threadsEnabled = resolveThreadPolicy(
      agent.threads ?? null,
      channelDefaults,
      mg.is_group === 1,
      supportsThreads,
    );
    const effectiveThreadId = threadsEnabled ? event.threadId : null;

    // Loopback short-circuit: bot's own message bouncing back never engages,
    // regardless of the wiring's engage_mode. The accumulate branch below
    // still stores the message so the agent retains self-context.
    // wasDeliveredByBot-backed signal: replied-to (or reacted-to) message
    // id is a known bot outbound. Used directly by the reaction rule —
    // a reaction is only a soft trigger on one of OUR messages, never on
    // a human ancestor that merely mentions us.
    const isReplyToBotOutbound =
      !isBotLoopback && replyToMessageId
        ? isReplyToOurBot(agent.agent_group_id, mg.id, effectiveThreadId, replyToMessageId)
        : false;
    // Reply-to-bot trigger for engage_mode: the bot-outbound reply OR a
    // human ancestor that @-mentions the bot (botInChain). The latter is
    // a *reply*-thread signal only, deliberately NOT fed to the reaction
    // rule below.
    const isReplyToBot = !isBotLoopback && (isReplyToBotOutbound || replyBotInChain);
    // Emoji reactions get a dedicated, deliberately quiet engagement rule
    // that bypasses the wiring's engage_mode entirely. A reaction on one
    // of THIS agent's own messages is a soft trigger (reuses the same
    // `wasDeliveredByBot` check as reply-to-bot, via `replyToMessageId`
    // carrying the reacted-to message id). A reaction between other users
    // never wakes the agent regardless of engage_mode — without this, a
    // `pattern: .` (always-on) wiring would fire the agent on every 👍 in
    // a busy channel. It still falls through to the accumulate branch so
    // the agent sees the reaction as silent context next time it engages.
    const isReaction = event.message.kind === 'reaction';
    const engages =
      isBotLoopback || isBackfill
        ? false
        : isReaction
          ? evaluateReactionEngage(isReplyToBotOutbound)
          : evaluateEngage(agent, messageText, isMention, isReplyToBot);

    const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
    const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(agent, agentGroup, mg, event, userId, threadsEnabled, effectiveThreadId, true, isReplyToBot);
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Uses this wiring's OWN effective thread
      // id — a non-null value already implies the adapter supports threads
      // (resolveThreadPolicy hard-ANDs the capability). DMs, non-threaded
      // platforms, and thread-opted-out wirings skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.subscribe &&
        effectiveThreadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, effectiveThreadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: effectiveThreadId, err });
        });
      }
    } else if (isSelfEcho) {
      // The bot's own outbound bounced back. Engagement was already skipped
      // (isBotLoopback), and unlike other accumulate context this carries no
      // value worth storing — it's the bot's own status/escalation spam. Drop
      // it so it never accrues as a trigger=0 `pending` zombie in the inbound
      // queue. See `isSelfEcho` above for the incident.
      log.debug('Self-echo dropped (not stored as accumulate context)', {
        agentGroupId: agent.agent_group_id,
        messageId: event.message.id,
      });
    } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
      // Accumulate stores the message as silent context. We allow it when
      // engagement simply didn't fire, but NOT when engagement fired and
      // the access/scope gate refused — those refusals are security
      // decisions about an untrusted sender, and silently storing their
      // message (which also stages their attachments to disk via
      // writeSessionMessage → extractAttachmentFiles) is exactly what the
      // gate is meant to prevent.
      await deliverToAgent(
        agent,
        agentGroup,
        mg,
        event,
        userId,
        threadsEnabled,
        effectiveThreadId,
        false,
        isReplyToBot,
      );
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    // Self-echo is dropped deliberately above (the bot's own outbound), not
    // a "no agent engaged" miss — label it accurately so the drop telemetry
    // doesn't read as lost human messages.
    const dropReason = isSelfEcho ? 'self_echo' : 'no_agent_engaged';
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: dropReason,
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
    emitEngineEvent('inbound.dropped', {
      reason: dropReason,
      channelType: event.channelType,
      platformId: event.platformId,
      userId,
    });
  }
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR reply-to-bot, same trigger set
 *                      as 'mention'. Stickiness is delegated to the SDK
 *                      subscription path (onSubscribedMessage), which on
 *                      threaded platforms keeps follow-ups flowing through
 *                      isMention=true. We deliberately do NOT fall back to
 *                      session-existence: on flat-reply platforms (e.g.
 *                      Discord, where we use native reply pills instead of
 *                      Discord threads) there is no SDK subscription to
 *                      gate against, and "session exists ⇒ engage" causes
 *                      every message in the channel to wake the agent.
 *                      Reply-to-bot (a408237) is the v1-parity trigger
 *                      that lets a thread stay sticky without a re-mention.
 */
/**
 * Check whether `platformMessageId` was a prior bot outbound for the active
 * session of (agent_group, messaging_group, thread). Returns false if no
 * active session, the session DB doesn't exist, or the message id wasn't
 * one of ours. Used by evaluateEngage to support v1's `requires_trigger`
 * reply-to-bot trigger semantics.
 */
function isReplyToOurBot(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
  platformMessageId: string,
): boolean {
  // Try the active session first — common path during a live conversation.
  // If no active session exists (operator clear-session, or container idle-
  // teardown that closed the row), fall back to the most-recent closed
  // session. The user can quote-reply to a bot message that was delivered
  // in that closed session, and the `inbound.db` is audit-preserved on
  // disk (S330), so `wasDeliveredByBot` can still answer. Without this
  // fallback, `mention`/`mention-sticky` wirings silently drop replies to
  // archived bot messages (wake=false) even though the operator intent is
  // obviously to continue the thread.
  const sessions: Array<{ id: string }> = [];
  const active = findSessionForAgent(agentGroupId, messagingGroupId, threadId);
  if (active) sessions.push(active);
  const activeAgentShared = findSessionByAgentGroup(agentGroupId);
  if (activeAgentShared && !sessions.some((session) => session.id === activeAgentShared.id)) {
    sessions.push(activeAgentShared);
  }
  const closed = findMostRecentClosedSessionForAgent(agentGroupId, messagingGroupId, threadId);
  if (closed) sessions.push(closed);
  for (const session of sessions) {
    try {
      const db = openInboundDb(agentGroupId, session.id);
      if (wasDeliveredByBot(db, platformMessageId)) return true;
    } catch {
      // Closed session dir may have been GC'd by a future cleanup pass.
      // Treat as a miss and keep looking; the active session lookup is
      // already covered above.
    }
  }
  return false;
}

function evaluateEngage(agent: MessagingGroupAgent, text: string, isMention: boolean, isReplyToBot: boolean): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        // Case-insensitive by default. @-mention patterns are the common
        // case ('@optimus'), and platform mentions are case-insensitive
        // everywhere (Discord/Slack/Telegram all match case-insensitively).
        // A case-sensitive regex on a typed `@Optimus` would miss it,
        // which is the kind of footgun that strands operator messages
        // until the container idles out.
        return new RegExp(pat, 'i').test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      // v1 `requires_trigger` parity: @mention OR reply to a prior bot
      // message both count as triggers. extractReplyContext on the channel
      // adapter populates the parent message id; isReplyToOurBot confirms
      // the parent was one of our deliveries before letting it engage.
      return isMention || isReplyToBot;
    case 'mention-sticky':
      // v1 `requires_trigger` parity. Same set as 'mention' — the
      // host-side session-existence fallback was removed because on
      // platforms without real SDK threads (Discord with native reply
      // pills) it engaged on every message in the channel.
      return isMention || isReplyToBot;
    default:
      return false;
  }
}

/**
 * Engagement rule for `kind: 'reaction'` inbounds, deliberately quieter
 * than `evaluateEngage` and independent of the wiring's `engage_mode`.
 *
 * A reaction on one of THIS agent's own messages (`isReplyToBot`, resolved
 * by the same `wasDeliveredByBot` check reply-to-bot uses) is a soft
 * trigger — the user is responding to something the agent said. A reaction
 * between other users never wakes the agent, regardless of engage_mode:
 * without this a `pattern: .` always-on wiring would fire on every 👍 in a
 * busy channel. Non-engaging reactions still fall through to the
 * accumulate branch so the agent sees them as silent context next time it
 * engages for another reason.
 */
function evaluateReactionEngage(isReplyToBot: boolean): boolean {
  return isReplyToBot;
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  threadsEnabled: boolean,
  effectiveThreadId: string | null,
  wake: boolean,
  isReplyToBot: boolean,
): Promise<void> {
  // Apply the resolved thread policy (wiring override AND channel declaration
  // AND adapter capability — resolveThreadPolicy at fanout): thread-enabled
  // wiring in a group chat → per-thread session regardless of wiring
  // session_mode. agent-shared preserved (it's a cross-channel directive the
  // adapter doesn't know about). DMs collapse sub-threads to one session
  // (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (threadsEnabled && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = resolveSession(agent.agent_group_id, mg.id, effectiveThreadId, effectiveSessionMode);

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event, with the wiring's thread policy applied). When
  // the caller supplied `replyTo` (CLI admin transport acting on operator
  // intent), the reply is redirected there — replyTo is exempt from
  // thread-policy stripping.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: effectiveThreadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  // When this inbound is a pill-reply to a prior bot message of THIS agent,
  // stamp `replyTo.toBot=true` on the per-agent content so the formatter can
  // render `<quoted_message mine="true">` and the agent recognizes the message
  // as a continuation of its own prior turn. Shallow-cloned because the same
  // event.message.content is shared across the fan-out — mutating in place
  // would cross-contaminate sibling agents whose isReplyToBot is false.
  //
  // When the host woke this agent for this row (wake=true), also stamp the
  // wiring's engage_mode so the container's `isAddressedTurn` knows the host
  // engagement gate fired with a this-bot-specific signal. Without this, a
  // `engage_mode='pattern'` wiring (every DM and every dedicated-bot group
  // chat — Nook, Tico, all DMs) looks ambient inside the container because
  // the message has no @mention/replyTo, the agent goes silent, and the user
  // sees the bot as broken (2026-05-27 Nook incident).
  let content = stampReplyToBot(event.message.content as string, isReplyToBot);
  if (wake) {
    content = stampEngagement(content, agent.engage_mode);
  }

  const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content,
    trigger: wake ? 1 : 0,
  });
  emitEngineEvent('inbound.written', {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messageId,
    trigger: wake,
  });
  if (created) emitEngineEvent('session.created', { session, created });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    // Typing fires via the adapter instance that owns this chat's row.
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      event.channelType,
      event.platformId,
      effectiveThreadId,
      mg.instance,
    );
    const freshSession = getSession(session.id);
    if (freshSession) {
      const woke = await wakeContainer(freshSession);
      // wakeContainer never throws — it returns false on transient spawn
      // failure (host-sweep retries). Stop the typing indicator we just
      // started so it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

/**
 * If this inbound is a pill-reply to a prior bot message of THIS agent,
 * stamp `replyTo.toBot=true` on a parsed-and-reserialized copy of the
 * content string. The container formatter renders that as
 * `<quoted_message mine="true">`, telling the agent the user is continuing
 * its own prior turn — same signal across Discord / Telegram / WhatsApp
 * regardless of how each platform expresses a pill-reply at the wire level.
 *
 * Reserializing matters because event.message.content is shared across the
 * fan-out loop; mutating in place would cross-contaminate sibling agents
 * for whom isReplyToBot is false. Returns the input untouched when the
 * payload isn't a JSON object, doesn't carry a replyTo, or already lacks
 * a sender/text the formatter would render.
 */
function stampReplyToBot(content: string, isReplyToBot: boolean): string {
  if (!isReplyToBot) return content;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object') return content;
  const replyTo = parsed.replyTo;
  if (!replyTo || typeof replyTo !== 'object') return content;
  const stamped = { ...parsed, replyTo: { ...(replyTo as Record<string, unknown>), toBot: true } };
  return JSON.stringify(stamped);
}

/**
 * Stamp the wiring's `engage_mode` onto the per-agent content JSON so the
 * container can see *why* the host woke this turn. Only called when wake=true
 * (the host's engagement gate fired for THIS row). Pure: returns input
 * untouched if the payload isn't a JSON object.
 *
 * The container's `isAddressedTurn` consumes `engageMode='pattern'` as a
 * sufficient address signal because `evaluateEngage` for `pattern` only
 * returns true when the per-wiring regex matched this bot's text — i.e. the
 * operator's configured signal that "this message is for this agent" already
 * fired. Without this, the in-container safety net only sees @mention /
 * replyTo, missing the entire "dedicated-bot via `pattern='.'`" case.
 */
function stampEngagement(content: string, engageMode: string | null | undefined): string {
  if (!engageMode) return content;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object') return content;
  const stamped = { ...parsed, engageMode };
  return JSON.stringify(stamped);
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}

// Test-only exports.
export const _internals = {
  evaluateEngage,
  evaluateReactionEngage,
  stampReplyToBot,
  stampEngagement,
};
