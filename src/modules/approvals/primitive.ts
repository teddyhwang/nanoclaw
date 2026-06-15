/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the pending_approvals row. Used by any
 *     module that needs admin confirmation before doing something sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too — it used to sit in src/access.ts and got
 * folded in with the PR #7 re-tier. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional (see REFACTOR_PLAN open q #3).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/** Two-button approval UI — the only options the primitive supports today. */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

/**
 * Two-button self-confirmation UI for `requestConfirmation()`. The value
 * strings are what the response handler matches on; keep `confirm`/`cancel`
 * stable (the sensitive-action handler keys off them).
 */
const CONFIRM_OPTIONS: RawOption[] = [
  { label: 'Confirm', selectedLabel: '✅ Confirmed', value: 'confirm' },
  { label: 'Cancel', selectedLabel: '❌ Cancelled', value: 'cancel' },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => void;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break: prefer approvers reachable on the same channel kind as the
 * origin; else first in list. Resolution uses ensureUserDm, which may
 * trigger a platform openDM call on cache miss.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

// ── Request API ──

/** Send a system chat to the agent's session. Used by callers and by the response handler. */
export function notifyAgent(session: Session, text: string): void {
  // Fire-and-forget — system text notifications never carry audio
  // attachments, so the engine's transcription pass is a no-op and we
  // don't need to block the caller on it.
  void writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  }).catch((err) => log.error('writeSessionMessage failed in notifyAgent', { err }));
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** JSON-serializable opaque payload. Carried on the pending_approvals row, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin. */
  title: string;
  /** Card body shown to the admin. */
  question: string;
}

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName } = opts;

  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return;
    }
  }

  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
}

export interface RequestConfirmationOptions {
  session: Session;
  agentName: string;
  /** Free-form action id; must match the key registered via registerApprovalHandler. */
  action: string;
  /**
   * Resolved `<channel>:<senderId>` of the triggering sender — the ONLY
   * user whose click counts (clicker-auth, Phase 0 re-keyed). Carried on
   * the row's payload as `actorId`.
   */
  actorId: string;
  /** Optional human label for the actor, woven into the card text. */
  actorName?: string;
  /** JSON-serializable opaque payload. Carried on the row, handed to the handler on Confirm. */
  payload: Record<string, unknown>;
  /** Card title. */
  title: string;
  /** Card body. */
  question: string;
  /**
   * Optional explicit delivery target. When set, the confirmation card is
   * delivered to THIS messaging group instead of the session's
   * `messaging_group_id`. Required for merged `agent-shared` agent groups:
   * the shared session's `messaging_group_id` is a single canonical channel,
   * so a trigger from a sibling channel would otherwise deliver the card to
   * the wrong chat (boys-night → ai-friends, 2026-06-15). The caller resolves
   * the source chat from the triggering message and passes it here. Falls
   * back to the session group when omitted (legacy single-channel path).
   */
  deliverTo?: { channel_type: string; platform_id: string };
}

/**
 * Self-confirmation sibling of `requestApproval`. Differences:
 *   - Delivers the ask_question card IN-CHANNEL to the originating chat
 *     (`session.messaging_group_id`), NOT to a resolved approver's DM.
 *     No `pickApprover` / `pickApprovalDelivery` / `ensureUserDm`.
 *   - Options are [Confirm, Cancel]; the confirming user must be the
 *     recorded `actorId` (enforced by the response handler / Phase 0).
 *   - `actorId` is stored on the payload so the response handler can both
 *     authorize the clicker and (on Confirm) create the session grant.
 *
 * Runs in the engine/optimus-host process (where the delivery adapter and
 * response registry are live). It is NOT called by the dashboard-server
 * preHandler directly — that process signals the host over the
 * dashboard-bridge IPC, and the host calls this. See
 * knowledge/projects/sensitive-action-approvals.md (v6).
 *
 * Fire-and-forget: the actor's click drives the registered handler for
 * `action` via the response dispatcher.
 */
export async function requestConfirmation(opts: RequestConfirmationOptions): Promise<void> {
  const { session, action, actorId, actorName, payload, title, question, agentName, deliverTo } = opts;

  // Prefer the caller-supplied source chat (merged agent-shared groups); fall
  // back to the session's canonical group for the legacy single-channel path.
  const messagingGroup = deliverTo
    ? { channel_type: deliverTo.channel_type, platform_id: deliverTo.platform_id }
    : session.messaging_group_id
      ? getMessagingGroup(session.messaging_group_id)
      : undefined;
  if (!messagingGroup) {
    // No originating chat to deliver into — self-confirm is in-channel only,
    // there is no DM fallback by design. Tell the agent so the held-back
    // call fails closed rather than silently proceeding.
    notifyAgent(session, `${action} could not be confirmed: no originating chat to deliver the confirmation to.`);
    return;
  }

  const approvalId = `cfm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(CONFIRM_OPTIONS);
  // actorId is force-merged last so a caller can't accidentally shadow the
  // authorization key via the opaque payload.
  const rowPayload = { ...payload, actorId };
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(rowPayload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    const body = actorName ? `${actorName}: ${question}` : question;
    try {
      await adapter.deliver(
        messagingGroup.channel_type,
        messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question: body,
          options: CONFIRM_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver confirmation card', { action, approvalId, err });
      notifyAgent(session, `${action} could not be confirmed: failed to deliver the confirmation card.`);
      return;
    }
  }

  log.info('Confirmation requested', { action, approvalId, agentName, actorId });
}
