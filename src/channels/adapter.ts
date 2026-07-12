/**
 * v2 Channel Adapter interface.
 *
 * Channel adapters bridge NanoClaw with messaging platforms (Discord, Slack, etc.).
 * Two patterns: native adapters (implement directly) or Chat SDK bridge (wrap a Chat SDK adapter).
 */

/** Passed to the adapter at setup time. */
export interface ChannelSetup {
  /** Called when an inbound message arrives from the platform. */
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;

  /**
   * Called by admin-transport adapters (CLI) that want to route a message to
   * an arbitrary channel/platform and optionally redirect replies elsewhere.
   * Regular chat adapters should use `onInbound`; `onInboundEvent` skips the
   * adapter-channel-type injection so the caller can target any wired mg.
   */
  onInboundEvent(event: InboundEvent): void | Promise<void>;

  /** Called when the adapter discovers metadata about a conversation. */
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;

  /** Called when a user clicks a button/action in a card (e.g., ask_user_question response). */
  onAction(questionId: string, selectedOption: string, userId: string): void;

  /**
   * Called when the platform reassigns a chat to a new platform id under
   * us. Today the only emitter is the Telegram chat-sdk bridge, on a
   * `migrate_to_chat_id` service event (basic-group → supergroup upgrade).
   * The host is expected to rewrite `messaging_groups.platform_id` and
   * refresh per-session routing/destination rows so subsequent inbound
   * updates under the new id resolve and outbound replies target it.
   *
   * Optional: hosts that don't subscribe will silently lose routing for
   * the chat until an operator rewrites the DB by hand (the failure mode
   * before this hook existed).
   */
  onChatMigrated?(channelType: string, oldPlatformId: string, newPlatformId: string): void | Promise<void>;
}

/** Delivery address used for reply-to overrides and (normally) the inbound's own origin. */
export interface DeliveryAddress {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/**
 * Full inbound event handed to the router.
 *
 * `channelType` + `platformId` + `threadId` identify which messaging group /
 * session receives the message. `replyTo`, when set, overrides where the
 * agent's reply is delivered — used by the CLI admin transport when the
 * operator wants a message routed to one channel but replies echoed back to
 * their terminal. Agents cannot set `replyTo`; it is a router-layer concept
 * set only by external adapters carrying operator intent.
 */
export interface InboundEvent {
  channelType: string;
  /** Receiving adapter instance; stamped host-side (src/index.ts onInbound).
   *  Absent (e.g. CLI onInboundEvent) means the default instance (= channelType). */
  instance?: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat' | 'chat-sdk' | 'reaction';
    content: string; // JSON blob
    timestamp: string;
    /**
     * Platform-confirmed bot-mention signal forwarded from the adapter.
     * See InboundMessage.isMention for the full explanation.
     */
    isMention?: boolean;
    /** True when the source is a group/channel thread, false for DMs. */
    isGroup?: boolean;
    /**
     * True when this inbound is the bot's own outbound message bouncing
     * back from the platform (shared-number WhatsApp, fromMe loopback,
     * etc.). The router stores the message so the agent has self-context
     * but skips engagement evaluation — without this gate the bot's reply
     * triggers itself in a tight loop.
     *
     * Adapters that can't observe loopback (or whose platform doesn't
     * loop bot outputs back) leave this undefined.
     */
    isBotMessage?: boolean;
    /**
     * True when this inbound is *this bot's own outbound* bouncing back
     * (the connected client identity — `isMe` on the chat-sdk author), as
     * opposed to merely any-bot (`isBotMessage`, which also covers a
     * *different* bot in the channel). Self-messages are pure status spam
     * with zero useful self-context, so the router drops them entirely
     * rather than storing them as accumulate context — unbounded
     * self-echo otherwise piles up `pending` in the dev-DM inbound queue
     * (Teddy DM 2026-06-03: 98 of 100 pending rows were the bot's own
     * escalation/status messages). Engagement is still skipped via
     * `isBotMessage` (set alongside this); `isSelfMessage` only governs
     * the *store*. Other-bot messages (`isBotMessage && !isSelfMessage`)
     * are still stored as legitimate channel context.
     */
    isSelfMessage?: boolean;
    /**
     * True when this inbound is replayed historical context, not a live
     * arrival. Set by deep-backfill callers (e.g. on-registration channel
     * history sync) that want messages stored as accumulated context
     * without triggering engagement evaluation — otherwise a historical
     * @-mention or reply-to-bot would wake the agent for a year-old
     * conversation. The router stores the row with trigger=0 unconditionally
     * when this is true and never invokes `evaluateEngage`. Live adapters
     * leave this undefined.
     */
    isBackfill?: boolean;
  };
  replyTo?: DeliveryAddress;
}

/** Inbound message from adapter to host. */
export interface InboundMessage {
  id: string;
  /**
   * `'reaction'` carries an emoji reaction a user added to / removed from a
   * message (any platform that supports reactions). Its `content` is a
   * `ReactionInboundContent` JSON object — see `chat-sdk-bridge.ts`
   * `reactionToInbound`. The router treats a reaction on one of the bot's
   * own messages as a soft trigger (same machinery as reply-to-bot) and a
   * reaction between other users as silent accumulate-only context.
   */
  kind: 'chat' | 'chat-sdk' | 'reaction';
  content: unknown; // JS object — host will JSON.stringify before writing to session DB
  timestamp: string;
  /**
   * Platform-confirmed signal that this message is a mention of the bot.
   *
   * Set by adapters that know the platform's own mention semantics — e.g.
   * the Chat SDK bridge sets it true from `onNewMention` / `onDirectMessage`
   * and forwards `message.isMention` from `onSubscribedMessage`. Use this
   * in the router instead of agent-name regex matching, which breaks on
   * platforms where the mention text is the bot's platform username (e.g.
   * Telegram's `@nanoclaw_v2_refactr_1_bot`) rather than the agent_group
   * display name (e.g. `@Andy`).
   *
   * Adapters that don't set it (native / legacy) leave it undefined — the
   * router treats undefined as "not a mention" (`isMention === true` check,
   * src/router.ts). There is no text-match fallback.
   */
  isMention?: boolean;
  /** True when the source is a group/channel thread, false for DMs. */
  isGroup?: boolean;
  /**
   * True when this inbound is the bot's own outbound bouncing back. See
   * `InboundEvent.message.isBotMessage` for the full contract. The router
   * stores the message but skips engagement so the bot does not loop on
   * its own replies.
   */
  isBotMessage?: boolean;
  /**
   * True when this inbound is *this bot's own* outbound bouncing back (vs
   * any-bot via `isBotMessage`). The router drops it instead of storing it
   * as accumulate context. See `InboundEvent.message.isSelfMessage` for
   * the full contract.
   */
  isSelfMessage?: boolean;
  /**
   * True when this inbound is replayed historical context, not a live
   * arrival. See `InboundEvent.message.isBackfill` for the full contract.
   * Deep-backfill callers (on-registration history sync) set this so the
   * router stores the row with trigger=0 and skips `evaluateEngage`.
   */
  isBackfill?: boolean;
}

/** A file attachment to deliver alongside a message. */
export interface OutboundFile {
  filename: string;
  data: Buffer;
}

/** Outbound message from host to adapter. */
export interface OutboundMessage {
  kind: string;
  content: unknown; // parsed JSON from messages_out
  files?: OutboundFile[]; // file attachments from the session outbox
  inReplyTo?: string | null; // platform message id we're replying to (for native reply chains)
  /**
   * Per-session assistant name resolved from the agent group's
   * container.json. Adapters that prefix outbound text (WhatsApp
   * shared-number) substitute this for the host-wide ASSISTANT_NAME.
   * Optional — adapters that don't prefix can ignore it.
   */
  assistantName?: string;
  /**
   * Separator between assistantName and message body. Defaults to `": "`
   * when undefined. Adapters that don't prefix can ignore it.
   */
  assistantPrefixSeparator?: string;
  /**
   * Suppress link previews / unfurls on platforms that support it
   * (Discord: message flag 4 = SUPPRESS_EMBEDS). Adapters whose platform
   * has no embed concept (WhatsApp, Telegram) ignore this field. Source
   * of truth lives in cybertron.workspace_agent_groups.suppress_embeds —
   * the host resolves it per agent group at delivery time.
   */
  suppressEmbeds?: boolean;
}

/** Discovered conversation info (from syncConversations). */
export interface ConversationInfo {
  platformId: string;
  name: string;
  isGroup: boolean;
}

/** Wiring/mg defaults for one conversation context (DM vs group/channel). */
export interface ChannelContextDefaults {
  /** Default engage_mode for wirings created in this context. */
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  /**
   * Default engage_pattern when engageMode === 'pattern'. May contain the
   * literal token `{name}`: creation helpers replace it with the regex-escaped
   * agent_group name (for platforms with no group-mention metadata, e.g.
   * iMessage/DeltaChat groups, WhatsApp shared-number mode). Required iff
   * engageMode === 'pattern'.
   */
  engagePattern?: string;
  /**
   * Whether thread ids are honored in this context by default.
   *  true  — inbound thread ids flow into messages_in and (in groups) force
   *          per-thread session identity; replies, typing, and cards land
   *          in-thread.
   *  false — thread ids are nulled per-wiring at router fanout; sessions
   *          collapse; replies land top-level.
   * MUST be false when `supportsThreads` is false (capability bound; the
   * router treats supportsThreads=false as a hard pre-strip regardless).
   * Per-wiring override: messaging_group_agents.threads (NULL = inherit).
   */
  threads: boolean;
  /**
   * unknown_sender_policy stamped on messaging_groups rows auto-created by
   * the router or created by wizard/CLI paths in this context.
   */
  unknownSenderPolicy: 'strict' | 'request_approval' | 'public';
}

/**
 * Static per-channel declaration of wiring-time defaults. Exactly two levels
 * exist: this declaration, and the per-wiring/per-mg values chosen at
 * creation. Install-wide changes = edit the adapter copy (skill-installed,
 * user-owned). Never persisted to the central DB.
 */
export interface ChannelDefaults {
  dm: ChannelContextDefaults;
  group: ChannelContextDefaults;
  /**
   * Which mention signal the adapter emits (InboundMessage.isMention):
   *  'platform' — platform-confirmed mentions in groups; DMs flagged too.
   *  'dm-only'  — only DMs flagged (no group mention metadata).
   *  'never'    — isMention never set: auto-create/registration card never
   *               fires; 'mention'/'mention-sticky' wirings never engage.
   * Creation surfaces must reject/warn on mention modes that can never fire.
   */
  mentions: 'platform' | 'dm-only' | 'never';
}

/** The v2 channel adapter contract. */
export interface ChannelAdapter {
  name: string;
  channelType: string;

  /**
   * Adapter-instance name — distinguishes N adapters of one platform
   * (e.g. three Slack apps in one workspace). Defaults to channelType.
   * channelType stays the SEMANTIC platform key (user ids '<channelType>:<handle>',
   * formatting, container config); instance is a host-side routing key only.
   * Must be unique across active adapters and URL-safe (no '/', '?', ':').
   */
  instance?: string;

  /**
   * Whether this adapter models conversations as threads.
   *
   * true  — adapter's platform uses threads as the primary conversation unit
   *         (Discord, Slack, Linear, GitHub). One thread = one session; the
   *         agent replies into the originating thread.
   * false — adapter's platform treats the channel itself as the conversation
   *         (Telegram, WhatsApp, iMessage). Thread ids are stripped at the
   *         router; agent replies go to the channel.
   */
  supportsThreads: boolean;

  // Lifecycle
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // Outbound delivery — returns the platform message ID if available
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  resolveChannelName?(platformId: string): Promise<string | null>;

  /**
   * Subscribe the bot to a thread so follow-up messages route via the
   * platform's "subscribed message" path (onSubscribedMessage in Chat SDK).
   * Called by the router when a mention-sticky wiring first engages in a
   * thread. Idempotent: calling twice on the same thread is a no-op.
   *
   * Platforms without a subscription concept can omit this; the router
   * treats absence as a no-op.
   */
  subscribe?(platformId: string, threadId: string): Promise<void>;

  /**
   * Open (or fetch) a DM with this user, returning the platform_id of the
   * resulting DM channel. Called by the host on demand to initiate cold
   * DMs — approvals, pairing handshakes, host-initiated notifications — to
   * users who may never have messaged the bot themselves.
   *
   * Omit this method on channels where the user handle IS already the DM
   * chat id (Telegram, WhatsApp, iMessage, email, Matrix). Callers will
   * fall through to using the handle directly.
   *
   * For channels that distinguish user id from DM channel id (Discord,
   * Slack, Teams, Webex, gChat): implement by delegating to Chat SDK's
   * chat.openDM, which hits the platform's idempotent open-DM endpoint.
   * Returning the same platform_id on repeated calls is expected.
   */
  openDM?(userHandle: string): Promise<string>;

  /**
   * Declared wiring-time defaults for this channel. Optional for backward
   * compatibility with stale adapter copies; absent → core fallback
   * (fallbackChannelDefaults(supportsThreads), see channel-registry.ts).
   * May be computed from adapter-internal env at module load (e.g. WhatsApp
   * shared-number mode), but is immutable for the process lifetime.
   */
  defaults?: ChannelDefaults;

  /**
   * Replay missed inbound messages for one platformId by fetching recent
   * history from the platform and re-emitting each through the same
   * `onInbound` callback that live messages use.
   *
   * Called by the host on startup (or after a long disconnect) so messages
   * sent during the gap aren't silently dropped. Adapters that can't fetch
   * history (or whose gateway protocol guarantees resume-from-cursor on
   * reconnect) should omit this method — callers treat absence as a no-op.
   *
   * Implementation contract:
   *   - Fetch the most recent `limit` messages for `platformId`.
   *   - Filter to messages within `lookbackMs` of now.
   *   - Re-emit each through the saved `setupConfig.onInbound` in
   *     chronological order. The router's per-session inbound.db PK
   *     (session_id, message_id) handles same-session dedup; cross-session
   *     replay (same physical message arriving for two agents in a shared
   *     group) routes to both, which is the correct semantic.
   *   - Return `{ recoveredCount, earliestTimestamp }` so callers can log
   *     and reason about gap size.
   *
   * Errors should not propagate — recovery is best-effort. Log and return
   * `{ recoveredCount: 0 }` on failure.
   */
  recoverMissedMessages?(opts: {
    platformId: string;
    lookbackMs: number;
    limit: number;
  }): Promise<{ recoveredCount: number; earliestTimestamp?: string }>;

  /**
   * Fetch the participant roster for a group chat, including each member's
   * profile picture URL when the platform exposes one. Used by host-side
   * member-snapshot plugins to backfill `observed_chat_members.avatar_url`
   * for chats where the inbound message path can't carry an avatar (e.g.,
   * WhatsApp — Baileys delivers `pushName` per message but not a
   * profile-picture URL; the URL has to come from a separate
   * `sock.profilePictureUrl()` call). Adapters whose inbound path already
   * stamps avatars on the `InboundMessage` (Discord, Slack) can omit this
   * — callers treat absence as "no separate roster sync needed."
   *
   * Returns null when the platform id isn't a group, the adapter isn't
   * connected, or the upstream call throws — callers should treat null
   * as a soft miss and retry on the next tick.
   */
  fetchGroupRoster?(platformId: string): Promise<Array<{
    senderId: string;
    displayName: string | null;
    avatarUrl: string | null;
  }> | null>;
}

/** Factory function that creates a channel adapter (returns null if credentials missing). */
export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;

/** Registration entry for a channel adapter. */
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  /**
   * Same declaration as ChannelAdapter.defaults, resolvable WITHOUT
   * instantiating the adapter — offline creation paths (setup/register.ts,
   * scripts/init-first-agent.ts, ncl against a host where the factory
   * returned null for missing creds) read it from the registry. Channel
   * modules pass the same const here and to the adapter/bridge.
   */
  defaults?: ChannelDefaults;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
