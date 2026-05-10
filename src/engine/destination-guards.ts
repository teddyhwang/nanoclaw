/**
 * Outbound destination guards — composable hooks called by `delivery.ts`
 * after the static `agent_destinations` ACL passes, before the message
 * is actually delivered.
 *
 * Why this exists separately from `router-hooks.ts`:
 *   - router-hooks gates inbound (sender resolution, access checks,
 *     sender-scope, channel-request, message interception). They wrap
 *     pre-existing singleton setters in `router.ts`.
 *   - destination guards are an outbound concern with no upstream
 *     singleton to wrap, so this module is the registration surface
 *     itself rather than a composer over an existing one.
 *
 * The static `agent_destinations` row is sufficient for operator-pinned
 * destinations whose validity is time-invariant. It is NOT sufficient
 * for projected rows (e.g. Optimus's `shared:<folder>:<channel>` rows
 * derived from membership): membership can flip mid-session, which
 * makes the static row a stale claim. A guard re-validates the dynamic
 * claim at send-time.
 *
 * Semantics: any deny is final, the first denying guard wins. All
 * `{ allowed: true }` returns mean the message is permitted to deliver.
 * Guards are async-friendly so hosts can hit cybertron / external
 * sources of truth if needed.
 *
 * Failure handling: a deny throws inside `runDestinationGuards`. Same
 * shape as the static unauthorized-channel-destination throw — the
 * outer retry loop in `deliverSessionMessages` marks the message
 * `failed` after retries exhaust, so the operator sees a real error
 * instead of a silent drop.
 */
import type { MessagingGroup } from '../types.js';

export interface DestinationGuardCtx {
  /** Source agent group attempting to send. */
  agentGroupId: string;
  /** Owning session id (lets guards consult session-scoped state). */
  sessionId: string;
  /** Resolved messaging group the message is targeting. */
  messagingGroup: MessagingGroup;
  /** Static `agent_destinations` row matched by the ACL. */
  destination: {
    localName: string;
    targetType: 'channel' | 'agent';
    targetId: string;
  };
}

export type DestinationGuardResult = { allowed: true } | { allowed: false; reason: string };

export type DestinationGuardFn = (ctx: DestinationGuardCtx) => DestinationGuardResult | Promise<DestinationGuardResult>;

const guards: DestinationGuardFn[] = [];

/**
 * Register a guard. Returns an unregister function. Guards run in
 * registration order; first deny wins.
 */
export function addDestinationGuard(fn: DestinationGuardFn): () => void {
  guards.push(fn);
  return () => {
    const i = guards.indexOf(fn);
    if (i >= 0) guards.splice(i, 1);
  };
}

/**
 * Run all registered guards. Returns the first deny, or `{ allowed: true }`
 * when nothing rejects. Caller is responsible for translating a deny
 * into the right thrown error / drop-with-reason behavior.
 */
export async function runDestinationGuards(ctx: DestinationGuardCtx): Promise<DestinationGuardResult> {
  for (const g of guards) {
    const r = await g(ctx);
    if (!r.allowed) return r;
  }
  return { allowed: true };
}

/** Test-only. */
export function _resetDestinationGuardsForTests(): void {
  guards.length = 0;
}
