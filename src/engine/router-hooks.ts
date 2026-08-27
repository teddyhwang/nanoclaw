/**
 * Composable router gates.
 *
 * v2 ships singleton setters in `router.ts` (setSenderResolver, setAccessGate,
 * setSenderScopeGate, setMessageInterceptor, setChannelRequestGate). One
 * caller per slot is enough for the upstream's single-permissions-module
 * model, but multi-plugin hosts need to chain multiple resolvers/gates.
 *
 * This module wraps the existing singleton setters so multiple plugins can
 * register stacked gates. A composed function is installed into the
 * upstream singleton on every `add*` call. The semantics:
 *
 *   - Sender resolver: first non-null wins; unchanged when all return null.
 *   - Access gate: any deny is final. All `allowed:true` must agree.
 *   - Sender-scope gate: same as access gate.
 *   - Message interceptor: first to return `true` consumes the message.
 *   - Channel-request gate: all run (notifications fan out).
 *
 * No edits to `router.ts` are needed — we install via the existing setters.
 */
import {
  setSenderResolver as _setSenderResolver,
  setAccessGate as _setAccessGate,
  setSenderScopeGate as _setSenderScopeGate,
  registerMessageInterceptor as _registerMessageInterceptor,
  setChannelRequestGate as _setChannelRequestGate,
  type SenderResolverFn,
  type AccessGateFn,
  type SenderScopeGateFn,
  type MessageInterceptorFn,
  type ChannelRequestGateFn,
} from '../router.js';

const senderResolvers: SenderResolverFn[] = [];
const accessGates: AccessGateFn[] = [];
const senderScopeGates: SenderScopeGateFn[] = [];
const messageInterceptors: MessageInterceptorFn[] = [];
const channelRequestGates: ChannelRequestGateFn[] = [];

let installed = {
  sender: false,
  access: false,
  scope: false,
  interceptor: false,
  channelRequest: false,
};

export function addSenderResolver(fn: SenderResolverFn): () => void {
  senderResolvers.push(fn);
  if (!installed.sender) {
    _setSenderResolver(async (event) => {
      for (const r of senderResolvers) {
        const v = await r(event);
        if (v) return v;
      }
      return null;
    });
    installed.sender = true;
  }
  return () => removeFrom(senderResolvers, fn);
}

export function addAccessGate(fn: AccessGateFn): () => void {
  accessGates.push(fn);
  if (!installed.access) {
    _setAccessGate(async (event, userId, mg, agentGroupId) => {
      for (const g of accessGates) {
        const r = await g(event, userId, mg, agentGroupId);
        if (!r.allowed) return r;
      }
      return { allowed: true };
    });
    installed.access = true;
  }
  return () => removeFrom(accessGates, fn);
}

export function addSenderScopeGate(fn: SenderScopeGateFn): () => void {
  senderScopeGates.push(fn);
  if (!installed.scope) {
    _setSenderScopeGate(async (event, userId, mg, agent) => {
      for (const g of senderScopeGates) {
        const r = await g(event, userId, mg, agent);
        if (!r.allowed) return r;
      }
      return { allowed: true };
    });
    installed.scope = true;
  }
  return () => removeFrom(senderScopeGates, fn);
}

export function addMessageInterceptor(fn: MessageInterceptorFn): () => void {
  messageInterceptors.push(fn);
  if (!installed.interceptor) {
    // Upstream's router grew a native multi-interceptor registry
    // (registerMessageInterceptor). We still funnel through ONE registered
    // dispatcher over our own array so addMessageInterceptor keeps its
    // removal semantics (the returned unsubscribe fn).
    _registerMessageInterceptor(async (event) => {
      for (const i of messageInterceptors) {
        if (await i(event)) return true;
      }
      return false;
    });
    installed.interceptor = true;
  }
  return () => removeFrom(messageInterceptors, fn);
}

export function addChannelRequestGate(fn: ChannelRequestGateFn): () => void {
  channelRequestGates.push(fn);
  if (!installed.channelRequest) {
    _setChannelRequestGate(async (mg, event) => {
      for (const g of channelRequestGates) {
        try {
          await g(mg, event);
        } catch {
          // each gate is independent — keep firing
        }
      }
    });
    installed.channelRequest = true;
  }
  return () => removeFrom(channelRequestGates, fn);
}

function removeFrom<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

/** Test-only. */
export function _resetRouterHooksForTests(): void {
  senderResolvers.length = 0;
  accessGates.length = 0;
  senderScopeGates.length = 0;
  messageInterceptors.length = 0;
  channelRequestGates.length = 0;
  installed = { sender: false, access: false, scope: false, interceptor: false, channelRequest: false };
}
