/**
 * `sensitive_mcp_confirm` approval handler — the engine-side Confirm
 * outcome for the sensitive-action confirmation gate (Phase 1).
 *
 * Flow (see knowledge/projects/sensitive-action-approvals.md, v6):
 *   1. The dashboard-server MCP preHandler classified a tools/call as
 *      sensitive, short-circuited it with a "pending confirmation"
 *      JSON-RPC result, and signalled the host over the dashboard-bridge.
 *   2. The host called `requestConfirmation()`, which delivered an
 *      in-channel Confirm/Cancel card and recorded a `pending_approvals`
 *      row with action `sensitive_mcp_confirm` and `payload.actorId`.
 *   3. On a Cancel (or unauthorized / no click / expiry) the generic
 *      response-handler path already notifies + drops the row WITHOUT
 *      reaching this handler — so this handler is the **Confirm** path
 *      only (the response handler invokes registered handlers solely on
 *      the positive option).
 *
 * Re-entry is **grant-based, not transport-replay**: the engine cannot
 * re-run the credentialed MCP call (it lives in the dashboard-server
 * process). On Confirm we (a) create/refresh the (session_id, actor_id)
 * confirmation grant and (b) tell the agent the action is approved. The
 * agent re-issues the tool call; the preHandler finds the live grant and
 * passes it straight through. The grant *is* the re-entry mechanism —
 * deliberately avoiding a host→dashboard HTTP loopback.
 */
import { registerApprovalHandler } from './primitive.js';
import { upsertConfirmationGrant } from '../../db/sessions.js';
import { log } from '../../log.js';

interface SensitiveMcpConfirmPayload {
  actorId?: string;
  integration?: string;
  tool?: string;
}

registerApprovalHandler('sensitive_mcp_confirm', async ({ session, payload, userId, notify }) => {
  const p = payload as SensitiveMcpConfirmPayload;
  // actorId is force-merged onto the row by requestConfirmation(); it is
  // also the value the response handler already authorized the clicker
  // against, so by the time we get here userId === actorId. Prefer the
  // recorded actorId; fall back to the (authorized) clicker id.
  const actorId = p.actorId || userId;
  if (!actorId) {
    // Should be unreachable (requestConfirmation always records actorId),
    // but never create an unkeyed grant — fail closed, agent re-prompts.
    notify(
      'Your action was confirmed, but it could not be remembered for this session (no actor id); you may be asked again.',
    );
    log.warn('sensitive_mcp_confirm: missing actorId, grant skipped', {
      sessionId: session.id,
      integration: p.integration,
      tool: p.tool,
    });
    return;
  }

  upsertConfirmationGrant(session.id, actorId, new Date().toISOString());
  log.info('sensitive_mcp_confirm: grant created/refreshed', {
    sessionId: session.id,
    actorId,
    integration: p.integration,
    tool: p.tool,
  });

  // Grant-based re-entry: the agent re-issues the tool call; the preHandler
  // now finds the live grant and lets it through. Tell it explicitly so it
  // does, rather than waiting (cli_command parity — system message).
  const what = p.tool ? `\`${p.tool}\`${p.integration ? ` (${p.integration})` : ''}` : 'the requested action';
  notify(
    `Confirmed. ${what} is approved for this session — re-issue the call and it will go through (no further confirmation needed for the rest of this session).`,
  );
});
