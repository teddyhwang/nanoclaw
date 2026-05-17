/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on reject, we notify the agent and move on.
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      via an in-memory Promise — see onecli-approvals.ts.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 *
 * Clicker authorization (Phase 0, sensitive-action-approvals design): a card
 * is delivered to an eligible approver's DM, but the response plumbing does
 * not intrinsically bind the click to that approver — historically ANY user
 * whose click carried the card's questionId could approve/reject. That made
 * the security of an approval contingent purely on the delivery channel
 * staying private (security-by-delivery, not authorization-on-click). We now
 * additionally re-verify, on every click, that the clicking user is in
 * `pickApprover(approval.agent_group_id)` for module-initiated approvals.
 * An unauthorized click (including a click with no resolvable user id) is
 * ignored and the row is LEFT PENDING so a real approver can still act —
 * it is never consumed, so a bystander cannot deny a legitimate request by
 * clicking Reject either. OneCLI credential approvals keep their existing
 * in-memory-promise path (the card is short-id'd and DM-only; the registered
 * pending row is dropped without dispatch — see `handleApprovalsResponse`).
 */
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import { getApprovalHandler, pickApprover } from './primitive.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  // OneCLI credential approvals — resolved via in-memory Promise first.
  if (resolveOneCLIApproval(payload.questionId, payload.value)) {
    return true;
  }

  // DB-backed pending_approvals.
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (approval.action === ONECLI_ACTION) {
    // Row exists but the in-memory resolver is gone (timer fired or the process
    // was in a weird state). Nothing to do — just drop the row.
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, payload.userId ?? '');
  return true;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!approval.session_id) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  const notify = (text: string): void => {
    // Fire-and-forget — system text notifications never carry audio
    // attachments, so the engine's transcription pass is a no-op.
    void writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    }).catch((err) => log.error('writeSessionMessage failed in notify', { err }));
  };

  // Clicker authorization. A click only carries a questionId + the clicking
  // user's id, so without this check any user who can reach the card's
  // callback could resolve it (approve/reject/confirm/cancel). Two trust
  // models, keyed by the row's action:
  //
  //   - sensitive_mcp_confirm (self-confirm gate): the authorized clicker
  //     is the recorded actor (the triggering sender), NOT an approver.
  //     The card is delivered in-channel where every member can see it, so
  //     a bystander clicking Confirm must be a no-op. Authorize against
  //     payload.actorId.
  //   - everything else (CLI / OneCLI / self-mod admin-approval): the card
  //     is in an approver's DM; authorize against pickApprover.
  //
  // An unauthorized click (or one with no resolvable user id) is dropped
  // WITHOUT consuming the row — it stays pending so a legitimate actor /
  // approver can still act, and a bystander cannot deny it by clicking the
  // negative option. No wakeContainer: nothing changed for the agent.
  let authorized: boolean;
  if (approval.action === 'sensitive_mcp_confirm') {
    let actorId = '';
    try {
      actorId = (JSON.parse(approval.payload) as { actorId?: string }).actorId ?? '';
    } catch {
      actorId = '';
    }
    authorized = !!userId && !!actorId && userId === actorId;
  } else {
    const eligible = pickApprover(approval.agent_group_id);
    authorized = !!userId && eligible.includes(userId);
  }
  if (!authorized) {
    log.warn('Approval click from unauthorized user ignored — row left pending', {
      approvalId: approval.approval_id,
      action: approval.action,
      clickerUserId: userId || '(none)',
      selectedOption,
    });
    return;
  }

  // Positive option is action-dependent: admin-approval cards use
  // 'approve'; the self-confirm gate uses 'confirm'. Anything else is the
  // negative path (reject / cancel) — drop the row, tell the agent.
  const positiveValue = approval.action === 'sensitive_mcp_confirm' ? 'confirm' : 'approve';
  if (selectedOption !== positiveValue) {
    const verb = approval.action === 'sensitive_mcp_confirm' ? 'cancelled' : 'rejected by admin';
    notify(`Your ${approval.action} request was ${verb}.`);
    log.info('Approval not granted', {
      approvalId: approval.approval_id,
      action: approval.action,
      selectedOption,
      userId,
    });
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  deletePendingApproval(approval.approval_id);
  await wakeContainer(session);
}
