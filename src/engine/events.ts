/**
 * Engine event bus.
 *
 * Typed pub/sub for engine lifecycle events. Plugins subscribe via
 * `ctx.events.on(name, handler)`; engine code emits via `emitEngineEvent`.
 *
 * Designed to add only single-line tap points to existing files, so upstream
 * refactors of router.ts / delivery.ts / container-runner.ts / host-sweep.ts
 * never collide with us. The emit calls are no-ops when no listener is
 * registered (zero overhead for the standalone v2 case).
 */
import { log } from '../log.js';
import type { InboundEvent } from '../channels/adapter.js';
import type { Session } from '../types.js';

export interface EngineEventMap {
  'session.created': { session: Session; created: boolean };
  'session.resolved': { session: Session };
  'session.cleared': { sessionId: string; agentGroupId: string };
  'inbound.routed': { event: InboundEvent; userId: string | null };
  'inbound.written': { sessionId: string; agentGroupId: string; messageId: string; trigger: boolean };
  /**
   * Fires when the host applies a `schedule_task` delivery action, after
   * the `messages_in` row is written. Symmetric with `task.fired`: lets
   * plugins capture per-task creator state at schedule-time (e.g. owner
   * identity) before the container ever fires the task.
   *
   * `taskId` and `seriesId` are equal on schedule (insertTask sets
   * `series_id = id`); they diverge only when the recurrence loop
   * creates the next occurrence. `taskContent` is the same JSON blob
   * persisted to `messages_in.content` — readers should parse defensively.
   */
  'task.scheduled': { agentGroupId: string; sessionId: string; taskId: string; seriesId: string; taskContent: string };
  /**
   * Fires when a scheduled task row (`messages_in.kind='task'`) becomes
   * due and the host is about to wake the container to run it. Emitted
   * once per due task row per sweep tick, before `wakeContainer`. Plugins
   * use this to stamp per-task state (e.g. sender-identity) that the
   * fresh container poll will read on its first iteration.
   *
   * `taskId` is the `messages_in.id` of the due row. `seriesId` is the
   * recurrence series root id (same as `taskId` for one-shot tasks and
   * for the first row of a recurring series). `taskContent` is the
   * raw content blob — readers should parse defensively since the
   * shape evolves with the scheduling-tools contract.
   */
  'task.fired': {
    sessionId: string;
    agentGroupId: string;
    taskId: string;
    seriesId: string | null;
    taskContent: string;
  };
  'inbound.dropped': { reason: string; channelType: string; platformId: string; userId: string | null };
  /**
   * Fires once per row a backfill writer (e.g. Optimus's deep-history
   * plugin via discrawl) stamps into a session's `inbound.db` via
   * `writeSessionMessage` — i.e. the bulk-write path that skips the
   * router. Symmetric to `inbound.routed` in *intent* (a new message is
   * known to the host) but separate in *origin* so projection / indexer
   * plugins can opt into bulk indexing without conflating it with live
   * routing semantics (engage evaluation, sender resolution, etc.).
   *
   * `ts` is the message's source timestamp (the Discord/Telegram/WhatsApp
   * message timestamp), not the import wall clock — backfilled rows
   * should sort by their real authoring time in any cross-session index.
   * `content` is the same JSON blob persisted to `messages_in.content`;
   * downstream listeners should parse defensively (text + sender shape
   * varies per channel adapter).
   */
  'backfill.written': {
    sessionId: string;
    agentGroupId: string;
    channelType: string;
    platformId: string;
    threadId: string | null;
    messageId: string;
    kind: string;
    ts: string;
    content: string;
  };
  /**
   * Fires when a channel adapter reports metadata (display name, group
   * flag) for a `platformId`. WhatsApp's Baileys adapter emits one event
   * per group via `groupFetchAllParticipating` on every reconnect, plus
   * per-chat events when group subjects change; Discord's adapter emits
   * on guild/channel/DM discovery. Used by inventory plugins to keep the
   * dashboard Add-Agent picker fresh without polling the channel API
   * from a sidecar.
   *
   * `isGroup=true` means this is a chat with multiple participants
   * (WhatsApp `@g.us` JID, Discord guild channel, etc.); `false` means a
   * DM. `name` may be empty when only existence is being signaled.
   */
  'channel.metadata': {
    channelType: string;
    platformId: string;
    name: string | undefined;
    isGroup: boolean | undefined;
  };
  /**
   * Fires when a channel adapter observes a message — typed for either a
   * live receive (`messages.upsert`-equivalent) or a history sync burst
   * from the platform (e.g. WhatsApp's `messaging-history.set` event
   * during the initial pair-time sync). Fires regardless of whether the
   * chat is currently registered with any agent group, so indexers can
   * build a persistent store ahead of registration.
   *
   * Symmetric in *intent* with `inbound.routed` but earlier in the
   * pipeline: `inbound.routed` fires only for messages the router
   * accepts; `channel.message_observed` fires for every message the
   * adapter sees, including ones that get dropped by the registration
   * filter or `unknown_sender_policy`. Host plugins (e.g. Optimus's
   * `whatsapp-history`) persist the observed stream so a later
   * `whatsapp_chat_history` delivery action can replay it into a
   * freshly registered chat's session inbound.db.
   *
   * `historical` distinguishes a live receive (`false`) from a pair-time
   * / reconnect bulk sync (`true`). Indexers may want to count or
   * rate-limit differently between the two.
   *
   * `content` is the platform-shaped chat-sdk content blob the adapter
   * was about to emit via `onInbound` — same JSON the router writes into
   * `messages_in.content`. Carrying it on the event lets a host plugin
   * persist the canonical shape without a platform-specific re-parse
   * later.
   */
  'channel.message_observed': {
    channelType: string;
    platformId: string;
    threadId: string | null;
    messageId: string;
    /** Sender's stable platform id (e.g. WhatsApp JID, Discord snowflake). */
    senderId: string;
    /** Best-effort display name at observation time. */
    senderName: string | null;
    /** ISO 8601 from the platform's timestamp. */
    ts: string;
    isGroup: boolean;
    isFromMe: boolean;
    isBotMessage: boolean;
    historical: boolean;
    /** Full chat-sdk content blob, JSON-stringified. */
    content: string;
  };
  /**
   * Fires after the engine has rewritten `messaging_groups.platform_id`
   * and refreshed per-session routing in response to a platform-driven
   * chat-id reassignment (today: Telegram supergroup upgrades, signaled
   * via `migrate_to_chat_id`). Host plugins that maintain their own
   * platform-id-keyed state (history indexers, inventory caches, etc.)
   * should listen and rewrite their copies under `newPlatformId` —
   * without that, plugin-owned state stays pinned to the dead id even
   * though the router/delivery now resolve the new one. `sessionsRefreshed`
   * counts how many per-session inbound.db `session_routing` rows the
   * engine refreshed (0 when the migrate hit a wired-but-no-session group).
   */
  'channel.migrated': {
    channelType: string;
    oldPlatformId: string;
    newPlatformId: string;
    messagingGroupId: string;
    sessionsRefreshed: number;
  };
  'outbound.delivered': { sessionId: string; agentGroupId: string; channelType: string; platformId: string };
  /**
   * Fires after any host caller successfully sends, edits, or deletes a
   * platform message through the shared delivery adapter. Unlike
   * `outbound.delivered`, this covers plugin-originated traffic (dev bridge,
   * watchers, approval cards) and carries the platform message id/content so
   * projections can upsert edits instead of retaining creation snapshots.
   */
  'channel.outbound_observed': {
    channelType: string;
    platformId: string;
    threadId: string | null;
    messageId: string;
    operation: 'send' | 'edit' | 'delete';
    text: string | null;
    ts: string;
  };
  'outbound.failed': { sessionId: string; agentGroupId: string; channelType: string; platformId: string; err: unknown };
  'container.spawn': { sessionId: string; agentGroupId: string };
  'container.stop': {
    sessionId: string;
    agentGroupId: string;
    reason: 'idle' | 'shutdown' | 'killed' | 'crashed';
  };
  'container.stuck': { sessionId: string; agentGroupId: string };
  'tool.started': { sessionId: string; agentGroupId: string; tool: string };
  'tool.completed': { sessionId: string; agentGroupId: string; tool: string; ok: boolean };
}

export type EngineEventName = keyof EngineEventMap;
export type EngineEventHandler<K extends EngineEventName> = (payload: EngineEventMap[K]) => void | Promise<void>;

const listeners = new Map<EngineEventName, Set<EngineEventHandler<EngineEventName>>>();

export interface EngineEventBus {
  on<K extends EngineEventName>(event: K, handler: EngineEventHandler<K>): () => void;
  off<K extends EngineEventName>(event: K, handler: EngineEventHandler<K>): void;
  emit<K extends EngineEventName>(event: K, payload: EngineEventMap[K]): void;
}

export const engineEvents: EngineEventBus = {
  on(event, handler) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler as EngineEventHandler<EngineEventName>);
    return () => engineEvents.off(event, handler);
  },
  off(event, handler) {
    listeners.get(event)?.delete(handler as EngineEventHandler<EngineEventName>);
  },
  emit(event, payload) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        const r = handler(payload);
        if (r && typeof (r as Promise<void>).then === 'function') {
          (r as Promise<void>).catch((err) => {
            log.error('engine event handler threw', { event, err });
          });
        }
      } catch (err) {
        log.error('engine event handler threw', { event, err });
      }
    }
  },
};

/** Convenience for tap-point emitters. Single-line at call sites. */
export function emitEngineEvent<K extends EngineEventName>(event: K, payload: EngineEventMap[K]): void {
  engineEvents.emit(event, payload);
}

/** Test-only — clear all subscriptions. */
export function _clearEngineEventsForTests(): void {
  listeners.clear();
}
