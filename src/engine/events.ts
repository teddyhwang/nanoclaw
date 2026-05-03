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
