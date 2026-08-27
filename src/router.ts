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
  createMessagingGroupIfAbsent,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findMostRecentClosedSessionForAgent, findSessionByAgentGroup, findSessionForAgent } from './db/sessions.js';
import { backfillNewSession, fanInboundMessage } from './modules/cross-session-context/index.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import {
  resolveSession,
  writeSessionMessage,
  writeOutboundDirect,
  withExistingMailboxSession,
} from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from './types.js';
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
export type SenderResolverFn = (event: InboundEvent) => string | null | Promise<string | null>;

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
) => AccessGateResult | Promise<AccessGateResult>;

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
) => AccessGateResult | Promise<AccessGateResult>;

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

/**
 * Session-created hook. When an engaged (waking) message creates a
 * brand-new session, registered hooks are notified after the triggering
 * message is written to the session's inbound DB, with the resolved
 * messaging group, thread id, session mode, and triggering message.
 *
 * Channel modules can use it for platform-specific conversation bootstrap
 * (thread naming, retiring onboarding affordances) without the router
 * carrying platform timing knowledge. The hook fires for every
 * created+engaged session — is_group / session-mode filtering is the
 * consumer's business.
 *
 * Fire-and-forget: hooks are try/caught (and async rejections logged), so
 * a failing hook can never affect routing or the container wake. No-op
 * when nothing is registered.
 */
export interface SessionCreatedEvent {
  /** The just-created session. */
  session: Session;
  /** The messaging group the triggering message arrived on. */
  mg: MessagingGroup;
  /** Platform address of the triggering inbound event. */
  platformId: string;
  /** Resolved thread id after the wiring's thread policy (null = no thread). */
  threadId: string | null;
  /** Resolved session mode after the wiring's thread policy. */
  sessionMode: MessagingGroupAgent['session_mode'];
  /** The triggering inbound message as received from the adapter. */
  message: { id: string; kind: string; content: string; timestamp: string };
}

export type SessionCreatedHook = (event: SessionCreatedEvent) => void | Promise<void>;

const sessionCreatedHooks: SessionCreatedHook[] = [];

export function registerSessionCreatedHook(hook: SessionCreatedHook): void {
  sessionCreatedHooks.push(hook);
}

function dispatchSessionCreated(event: SessionCreatedEvent): void {
  for (const hook of sessionCreatedHooks) {
    try {
      Promise.resolve(hook(event)).catch((err) =>
        log.error('Session-created hook failed', { sessionId: event.session.id, err }),
      );
    } catch (err) {
      log.error('Session-created hook threw', { sessionId: event.session.id, err });
    }
  }
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
  //    WhatsApp, iMessage, email) collapse threads to the channel. Resolved
  //    by the RECEIVING instance — sibling instances of one platform can
  //    differ in thread support.
  const adapter = getChannelAdapter(event.instance ?? event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  } else if (event.threadId !== null && event.threadId === event.platformId) {
    // Chat SDK uses channel id as a top-level pseudo-thread on flat surfaces.
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;
  const isBotLoopback = event.message.isBotMessage === true;
  const isSelfEcho = event.message.isSelfMessage === true;
  const isBackfill = event.message.isBackfill === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam. Exact-on-instance: an unknown named
  //    instance falls through to auto-create rather than hijacking a
  //    sibling instance's row.
  const found = await getMessagingGroupWithAgentCount(
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
    const created = await createMessagingGroupIfAbsent(mg);
    const resolved = await getMessagingGroupWithAgentCount(
      event.channelType,
      event.platformId,
      event.instance ?? event.channelType,
    );
    if (!resolved) throw new Error('Messaging group disappeared after first-message insert');
    mg = resolved.mg;
    agentCount = resolved.agentCount;
    if (created) {
      log.info('Auto-created messaging group', {
        id: mgId,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
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
    await recordDroppedMessage({
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
  const userId: string | null = senderResolver ? await senderResolver(event) : null;
  emitEngineEvent('inbound.routed', { event, userId });

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = await getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session without triggering a wake so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';
  const replyToMessageId =
    typeof (parsed as { replyTo?: { messageId?: string } }).replyTo?.messageId === 'string'
      ? (parsed as { replyTo: { messageId: string } }).replyTo.messageId
      : null;
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
    const agentGroup = await getAgentGroup(agent.agent_group_id);
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

    const isReplyToBotOutbound =
      !isBotLoopback && replyToMessageId
        ? await isReplyToOurBot(agent.agent_group_id, mg.id, effectiveThreadId, replyToMessageId)
        : false;
    const isReplyToBot = !isBotLoopback && (isReplyToBotOutbound || replyBotInChain);
    const isReaction = event.message.kind === 'reaction';
    const engages =
      isBotLoopback || isBackfill
        ? false
        : isReaction
          ? evaluateReactionEngage(isReplyToBotOutbound)
          : evaluateEngage(agent, messageText, isMention, isReplyToBot);

    const accessOk = engages && (!accessGate || (await accessGate(event, userId, mg, agent.agent_group_id)).allowed);
    const scopeOk = engages && (!senderScopeGate || (await senderScopeGate(event, userId, mg, agent)).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(
        agent,
        agentGroup,
        mg,
        event,
        userId,
        threadsEnabled,
        effectiveThreadId,
        true,
        isReplyToBotOutbound,
      );
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
        isReplyToBotOutbound,
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
    const dropReason = isSelfEcho ? 'self_echo' : 'no_agent_engaged';
    await recordDroppedMessage({
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
 *   'mention-sticky' — same host trigger set as mention: platform mention,
 *                      this-agent outbound reply, or bot participation in the
 *                      reply chain. SDK subscription carries real thread
 *                      stickiness; session existence never does.
 */
async function isReplyToOurBot(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
  platformMessageId: string,
): Promise<boolean> {
  const sessions: Array<{ id: string }> = [];
  const active = await findSessionForAgent(agentGroupId, messagingGroupId, threadId);
  if (active) sessions.push(active);

  const activeAgentShared = await findSessionByAgentGroup(agentGroupId);
  if (activeAgentShared && !sessions.some((session) => session.id === activeAgentShared.id)) {
    sessions.push(activeAgentShared);
  }

  const closed = await findMostRecentClosedSessionForAgent(agentGroupId, messagingGroupId, threadId);
  if (closed && !sessions.some((session) => session.id === closed.id)) sessions.push(closed);

  for (const session of sessions) {
    try {
      const delivered = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) =>
        mailbox.wasDeliveredByBot(platformMessageId),
      );
      if (delivered) return true;
    } catch {
      // Audit-preserved closed storage may later be GC'd; treat that as a miss.
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
        return new RegExp(pat, 'i').test(text);
      } catch {
        // Bad regex: fail open so an admin sees the response and can repair it.
        return true;
      }
    }
    case 'mention':
    case 'mention-sticky':
      // SDK subscription supplies real stickiness on threaded platforms.
      // Never use session existence: flat reply surfaces would wake forever.
      return isMention || isReplyToBot;
    default:
      log.warn('Unknown engage_mode — treating as no-engage. Check wiring configuration.', {
        engage_mode: agent.engage_mode,
        wiring_id: agent.id,
      });
      return false;
  }
}

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
  isReplyToOwnOutbound: boolean,
): Promise<void> {
  let effectiveSessionMode = agent.session_mode;
  if (threadsEnabled && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  const { session, created } = await resolveSession(
    agent.agent_group_id,
    mg.id,
    effectiveThreadId,
    effectiveSessionMode,
  );

  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: effectiveThreadId,
  };

  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = await gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      await writeOutboundDirect(session.agent_group_id, session.id, {
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

  if (wake && created) {
    await backfillNewSession(agentGroup, session, mg);
  }

  let content = stampReplyToBot(event.message.content, isReplyToOwnOutbound);
  if (wake) content = stampEngagement(content, agent.engage_mode);

  const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content,
    trigger: wake,
  });
  emitEngineEvent('inbound.written', {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messageId,
    trigger: wake,
  });
  if (created) emitEngineEvent('session.created', { session, created });

  if (wake) {
    await fanInboundMessage({
      session,
      mg,
      messageId,
      kind: event.message.kind,
      channelType: deliveryAddr.channelType,
      content: event.message.content,
      timestamp: event.message.timestamp,
    });
  }

  if (wake && created) {
    dispatchSessionCreated({
      session,
      mg,
      platformId: event.platformId,
      threadId: effectiveThreadId,
      sessionMode: effectiveSessionMode,
      message: {
        id: event.message.id,
        kind: event.message.kind,
        content: event.message.content,
        timestamp: event.message.timestamp,
      },
    });
  }

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
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      event.channelType,
      event.platformId,
      effectiveThreadId,
      mg.instance,
    );
    const freshSession = await getSession(session.id);
    if (freshSession) {
      const woke = await wakeContainer(freshSession);
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

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
  return JSON.stringify({ ...parsed, replyTo: { ...(replyTo as Record<string, unknown>), toBot: true } });
}

function stampEngagement(content: string, engageMode: string | null | undefined): string {
  if (!engageMode) return content;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object') return content;
  return JSON.stringify({ ...parsed, engageMode });
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

export const _internals = {
  evaluateEngage,
  evaluateReactionEngage,
  stampReplyToBot,
  stampEngagement,
};
