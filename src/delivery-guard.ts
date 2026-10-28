/**
 * The guard-consult path for privileged delivery actions.
 *
 * The registry itself — registration, lookup, approved-replay re-entry —
 * stays in delivery.ts, close to main's shape. This file holds the new
 * guard logic: the spec a privileged registration carries, and runGuarded,
 * the precheck → guard → deny/hold/allow pipeline every consult runs.
 */
import { AsyncLocalStorage } from 'async_hooks';

import { guard, type GuardedAction } from './guard/index.js';
import { log } from './log.js';
import type { PendingApproval, Session } from './types.js';

/** The delivered row an action came from (see delivery.ts DeliveryActionContext). */
export interface GuardedDeliveryContext {
  messageId: string;
}

/** Handler shape for guard-wrapped actions — must not touch inDb (replays run without one).
 * `context` is the originating outbound row, on a fresh dispatch and on an
 * approved replay alike. */
export type GuardedDeliveryHandler = (
  content: Record<string, unknown>,
  session: Session,
  context?: GuardedDeliveryContext,
) => Promise<void>;

/**
 * Payload key under which an approval hold remembers the originating row id,
 * so the approved replay hands the handler the same context. Added by
 * requestApproval while a hold is being created (holdContext) and stripped
 * before the replay reaches the guard or the handler.
 */
export const DELIVERY_MESSAGE_ID_KEY = '__deliveryMessageId';
const holdStorage = new AsyncLocalStorage<GuardedDeliveryContext>();

/** The originating row of the hold being created right now, if any. */
export function holdContext(): GuardedDeliveryContext | undefined {
  return holdStorage.getStore();
}

/** Split a stored approval payload into the action payload and its context. */
export function splitReplayPayload(payload: Record<string, unknown>): {
  content: Record<string, unknown>;
  context?: GuardedDeliveryContext;
} {
  const { [DELIVERY_MESSAGE_ID_KEY]: messageId, ...content } = payload;
  return typeof messageId === 'string' && messageId ? { content, context: { messageId } } : { content };
}

export interface DeliveryGuardSpec {
  /** Guard action consulted before the handler runs — the defined value, not a name. */
  guardAction: GuardedAction;
  /**
   * Domain validation that runs before the guard — malformed requests are
   * answered (notify) without ever creating a hold. Return false to stop.
   */
  precheck?: (content: Record<string, unknown>, session: Session) => boolean | Promise<boolean>;
  /** Create the hold (the domain's requestApproval call — card text lives with the domain). */
  requestHold: (content: Record<string, unknown>, session: Session) => Promise<void>;
  /** Tell the requester about a deny. */
  onDeny?: (content: Record<string, unknown>, session: Session, reason: string) => void | Promise<void>;
}

/**
 * Run a guarded delivery action: precheck, consult the guard, then route the
 * decision — deny → onDeny, hold → requestHold, allow → handler. A fresh
 * dispatch passes grant=null; an approved replay passes the approval row,
 * which satisfies a hold but never a deny (the structural checks re-run
 * live, so approve-then-revoke does not execute).
 */
export async function runGuarded(
  action: string,
  spec: DeliveryGuardSpec,
  handler: GuardedDeliveryHandler,
  content: Record<string, unknown>,
  session: Session,
  grant: PendingApproval | null,
  context?: GuardedDeliveryContext,
): Promise<void> {
  if (spec.precheck && !(await spec.precheck(content, session))) return;

  const decision = await guard(spec.guardAction, {
    actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
    payload: content,
    grant,
  });

  if (decision.effect === 'deny') {
    log.warn('Delivery action denied by guard', { action, reason: decision.reason });
    await spec.onDeny?.(content, session, decision.reason);
    return;
  }
  if (decision.effect === 'hold') {
    await (context
      ? holdStorage.run(context, () => spec.requestHold(content, session))
      : spec.requestHold(content, session));
    return;
  }
  await handler(content, session, context);
}
