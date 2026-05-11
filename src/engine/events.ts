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
  'outbound.delivered': { sessionId: string; agentGroupId: string; channelType: string; platformId: string };
  'outbound.failed': { sessionId: string; agentGroupId: string; channelType: string; platformId: string; err: unknown };
  'container.spawn': { sessionId: string; agentGroupId: string };
  'container.stop': { sessionId: string; agentGroupId: string; reason: 'idle' | 'shutdown' | 'killed' };
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
