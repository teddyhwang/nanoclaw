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
 * Re-entry is **engine-driven replay** (Fix B, 2026-05-18 — supersedes
 * the original grant-only, model-voluntary-reissue design). The old path
 * created a (session,actor) grant and told the model "re-issue the
 * call"; that relied on the model voluntarily re-emitting the
 * function_call. Codex does NOT reliably do this after the gate's prior
 * tool result, so a confirmed action hung forever (Teddy repro: claude
 * re-issues, codex never does, gate-off works). Now on Confirm we
 * (a) still create/refresh the (session_id, actor_id) grant — kept as
 * defense-in-depth so any OTHER sensitive call this session is
 * friction-free — and (b) call dashboard-server's `/mcp/_replay` so it
 * runs the stashed, now-grant-satisfied credentialed call IN ITS OWN
 * process, then we inject the REAL result back into the session. The
 * model does nothing special; provider/harness-agnostic. This is the
 * deliberate, bounded host→dashboard loopback the original design
 * avoided — the necessary price of correctness across providers.
 */
import { registerApprovalHandler } from './primitive.js';
import { upsertConfirmationGrant } from '../../db/sessions.js';
import { log } from '../../log.js';
import { replayConfirmedMcpCall } from './mcp-replay-client.js';

interface SensitiveMcpConfirmPayload {
  actorId?: string;
  integration?: string;
  tool?: string;
  /** Set by requestConfirmation() — needed to address the replay. */
  groupFolder?: string;
}

/** Flatten an MCP CallToolResult content array to a single text blob for
 *  injection back into the agent session as a system message. */
function renderReplayContent(content: { type: string; text?: string; [k: string]: unknown }[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else parts.push(JSON.stringify(c));
  }
  return parts.join('\n').trim();
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

  const what = p.tool ? `\`${p.tool}\`${p.integration ? ` (${p.integration})` : ''}` : 'the requested action';

  // Fix B (2026-05-18): engine-driven replay, NOT model-voluntary
  // re-issue. The old path told the model "re-issue the call" and relied
  // on it doing so — codex never reliably did (it does not re-emit a
  // function_call after the gate's prior result), so a confirmed action
  // hung forever. Now: we ask dashboard-server to run the stashed,
  // now-grant-satisfied call in its own process and we inject the REAL
  // result back into the session. Provider/harness-agnostic; the model
  // does nothing special. The grant above still stands so any OTHER
  // sensitive call this session is friction-free.
  if (!p.groupFolder || !p.integration || !p.tool) {
    // No replay identity (older/edge payload) — fall back to the legacy
    // model-reissue nudge rather than silently dropping the action.
    notify(
      `Confirmed. ${what} is approved for this session — re-issue the call and it will go through (no further confirmation needed for the rest of this session).`,
    );
    return;
  }

  const outcome = await replayConfirmedMcpCall({
    groupFolder: p.groupFolder,
    integration: p.integration,
    tool: p.tool,
  });

  if (outcome.status === 'ok') {
    const rendered = renderReplayContent(outcome.content) || '(the action returned no output)';
    // Deliver the actual tool result as a system message the agent reads
    // and continues from — exactly as if the tool had returned inline.
    notify(
      `Confirmed — ${what} ran. Result:\n${rendered}\n\n` + `Continue from this result. Do not re-issue the call.`,
    );
    log.info('sensitive_mcp_confirm: engine-driven replay delivered', {
      sessionId: session.id,
      integration: p.integration,
      tool: p.tool,
      isError: outcome.isError,
    });
    return;
  }

  if (outcome.status === 'expired' || outcome.status === 'already_done') {
    // Bounded loop-exit (task #25): the stash GC'd (3-min TTL) or the
    // call already ran. Never silent, never a retry-loop — tell the
    // agent definitively so it can inform the user / move on.
    notify(
      `Confirmed, but ${what} could not be auto-completed ` +
        `(${outcome.status === 'expired' ? 'the confirmation window elapsed' : 'it was already completed'}). ` +
        `If you still need it, ask the user to trigger the action again.`,
    );
    log.warn('sensitive_mcp_confirm: replay not runnable', {
      sessionId: session.id,
      integration: p.integration,
      tool: p.tool,
      status: outcome.status,
    });
    return;
  }

  // outcome.status === 'error' — replay round-trip failed. Surface it;
  // the grant still exists so a manual re-issue would also work.
  notify(
    `Confirmed and approved for this session, but auto-running ${what} ` +
      `failed (${outcome.message}). You may re-issue the call once — the ` +
      `confirmation is now on record so it will go straight through.`,
  );
  log.error('sensitive_mcp_confirm: replay failed', {
    sessionId: session.id,
    integration: p.integration,
    tool: p.tool,
    message: outcome.message,
  });
});
