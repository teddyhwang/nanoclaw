/**
 * Sensitive-action gate — the engine-side decision for the fleet-wide MCP
 * confirmation gate (Phase 1 of
 * knowledge/projects/sensitive-action-approvals.md, v6 → v7 seam).
 *
 * ## Why this lives in the engine, not in dashboard-server
 *
 * The credentialed MCP tool call executes in the **dashboard-server**
 * process; the confirmation primitive (`requestConfirmation`), the
 * delivery adapter, the response registry, and `confirmation_grants`
 * all live in the **engine/optimus-host** process. The v6 doc's split
 * (preHandler reads v2.db + namespaces the actor itself) was rejected
 * by the operator: the actor-id namespacing rule MUST match the engine's
 * clicker-auth exactly, and duplicating it in dashboard-server is a
 * silent-break drift risk (a mismatched actor id = the actor's own
 * Confirm click never authorizes, and nobody can ever confirm).
 *
 * So the seam is **bridge-decides**: the dashboard-server preHandler
 * forwards every `tools/call` to the optimus dashboard-bridge, which
 * calls `decideSensitiveGate()` here — in-process with the engine, where
 * every input (session, namespaced actor, live grant, policy) has a
 * single source of truth and zero drift. One localhost round-trip per
 * gated call buys correctness; the operator chose this explicitly.
 *
 * `decideSensitiveGate()` returns `'allow'` (preHandler falls through to
 * the real route) or `'confirm'` (preHandler short-circuits with a
 * "pending confirmation" JSON-RPC result; this function has already
 * fired the in-channel Confirm/Cancel card via `requestConfirmation`).
 * Re-entry is grant-based: on Confirm the `sensitive_mcp_confirm`
 * handler writes the `(session, actor)` grant; the agent re-issues the
 * tool call; the next decision finds the live grant and returns
 * `'allow'`. See sensitive-mcp-confirm.ts.
 *
 * ## Policy
 *
 * Ordered rules, from the v6 doc:
 *   1. write / external / destructive → require_confirmation (ANY chat)
 *   2. read & pii & public            → require_confirmation (public channel only)
 *   3. else                           → allow
 * Unclassified call → require_confirmation UNCONDITIONALLY (operator
 *   decision: strictest; no name heuristic; "let the LLM judge" rejected
 *   as a confused-deputy hole).
 *
 * ## Where the classification comes from (2026-10-08)
 *
 * The tool's risk is declared ONCE, on the tool definition in
 * dashboard-server (`mcp/kit/policy.ts`: risk, pii, argument classifier
 * for multiplexers such as `google_call`). The dashboard classifies the
 * concrete call and sends `classification` with the bridge request; this
 * module only applies the ordered policy above. The former per-tool
 * `CLASSIFICATION_REGISTRY` here duplicated (and disagreed with) the tool
 * definitions and silently gated every unlisted read (home, health,
 * investments, tpl); it is gone. The bridge is host-only (localhost +
 * shared secret), so the classification is as trusted as the tool
 * definition itself.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSensitiveGateMode } from '../../db/container-configs.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { findSessionByAgentGroup, getConfirmationGrant, touchConfirmationGrant } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { requestConfirmation } from './primitive.js';

// ─── Policy (pure data + pure functions; zero side effects) ───────────

/** Risk of one concrete tool call, as classified by the tool's definition. */
export type ToolRisk = 'read' | 'write' | 'external' | 'destructive';

export interface CallClassification {
  risk: ToolRisk;
  /** A read whose output carries personal data. */
  pii: boolean;
}

const TOOL_RISKS: ReadonlySet<string> = new Set(['read', 'write', 'external', 'destructive']);

/** Strict shape check for a classification received over the bridge. */
export function parseCallClassification(value: unknown): CallClassification | null {
  if (!value || typeof value !== 'object') return null;
  const { risk, pii } = value as { risk?: unknown; pii?: unknown };
  if (typeof risk !== 'string' || !TOOL_RISKS.has(risk)) return null;
  if (typeof pii !== 'boolean') return null;
  return { risk: risk as ToolRisk, pii };
}

export interface PolicyContext {
  /** The call's classification; null/undefined ⇒ unclassified (strictest). */
  classification: CallClassification | null | undefined;
  /** messaging_group.is_group === 1 — a multi-person ("public") chat. */
  isPublicChannel: boolean;
}

export type PolicyDecision = 'allow' | 'require_confirmation';

/** The ordered policy. Unclassified → require_confirmation (fail-closed). */
export function evaluatePolicy(ctx: PolicyContext): PolicyDecision {
  const cls = ctx.classification;
  if (!cls) return 'require_confirmation'; // unclassified → strictest
  if (cls.risk !== 'read') return 'require_confirmation'; // rule 1 — any chat
  if (cls.pii && ctx.isPublicChannel) return 'require_confirmation'; // rule 2
  return 'allow'; // rule 3
}

// ─── Actor-id namespacing (single source, mirrors clicker-auth) ───────

/**
 * Namespace a raw platform sender id into the `users(id)` /
 * `confirmation_grants.actor_id` form. This MUST stay byte-identical to
 * the engine's clicker-auth (modules/permissions/index.ts:233-237 and
 * platform-id.ts:24): only prefix when the raw id has no colon — some
 * platforms (Teams `29:xxx`, WhatsApp `...@lid`-with-channel) already
 * carry a namespace. Centralised here so dashboard-server never has to
 * reproduce it (the whole reason for bridge-decides).
 */
export function namespaceActorId(channelType: string, rawSenderId: string): string {
  return rawSenderId.includes(':') ? rawSenderId : `${channelType}:${rawSenderId}`;
}

// ─── Grant TTL ────────────────────────────────────────────────────────

/**
 * Single 30-minute hard cap (operator decision, 2026-05-17). A grant is
 * live only while `now - granted_at < HARD_TTL`. No idle layer in the
 * shipped default; `IDLE_TTL` is the one remaining tunable (default
 * disabled — `last_used_at` is still bumped so it can be enabled later
 * without a backfill).
 */
export const HARD_TTL_MS = 30 * 60 * 1000;
/** Optional idle layer under the hard cap. `null` = disabled (default). */
export const IDLE_TTL_MS: number | null = null;

function grantIsLive(grantedAt: string, lastUsedAt: string, nowMs: number): boolean {
  const gAt = Date.parse(grantedAt);
  if (!Number.isFinite(gAt) || nowMs - gAt >= HARD_TTL_MS) return false;
  if (IDLE_TTL_MS !== null) {
    const uAt = Date.parse(lastUsedAt);
    if (!Number.isFinite(uAt) || nowMs - uAt >= IDLE_TTL_MS) return false;
  }
  return true;
}

// ─── Decision orchestrator ────────────────────────────────────────────

export interface SensitiveGateInput {
  /** `agent_groups.folder` from the MCP route URL (`/mcp/:integration/:groupFolder`). */
  groupFolder: string;
  /** URL `:integration` param (google, lunchmoney, ...). */
  integration: string;
  /** JSON-RPC `params.name`. */
  tool: string;
  /** JSON-RPC `params.arguments` (opaque here; logged by nobody). */
  args: unknown;
  /**
   * The call's classification from the tool definition (dashboard
   * `mcp/kit/policy.ts`). Absent ⇒ unclassified ⇒ require_confirmation.
   */
  classification?: CallClassification | null;
  /**
   * Raw platform sender id from the host-written sender-identity.json
   * (e.g. `159867859914790@lid`, `1234567890`). NOT namespaced — this
   * function namespaces it (using the channel resolved from the session's
   * messaging group, NOT a caller-supplied value) so the form matches
   * clicker-auth exactly. dashboard-server only knows the raw id; the
   * channel is single-sourced here from the session.
   */
  rawSenderId: string;
  /** Optional human label for the @-mention on the card. */
  senderDisplayName?: string | null;
  /**
   * Source-chat coordinates of the triggering message, stamped by the host
   * from the inbound event (`sender-identity.json`). For a merged
   * `agent-shared` agent group, the shared session's `messaging_group_id` is
   * a single canonical channel, so resolving the confirmation-card target
   * from the session alone delivers the card to the wrong chat when the
   * trigger came from a sibling channel (boys-night → ai-friends, 2026-06-15).
   * When these resolve to a registered messaging group, the gate scopes the
   * card AND the actor-id namespacing to that source chat. Absent/unresolvable
   * ⇒ fall back to the session's group (legacy single-channel path). Mirrors
   * the search-conversations / escalation `d49e2fdd` source-coords stamp.
   */
  sourceChannelType?: string | null;
  sourcePlatformId?: string | null;
}

export type SensitiveGateDecision =
  | { decision: 'allow'; reason: 'policy_allow' | 'live_grant' | 'gate_disabled_by_admin' }
  | { decision: 'confirm'; approvalId: string }
  | { decision: 'fail_closed'; reason: string };

/**
 * The whole gate, engine-side. Resolves the session from the group
 * folder, namespaces the actor, checks the live `(session, actor)`
 * grant (30-min hard cap), evaluates the policy, and on
 * `require_confirmation` fires the in-channel Confirm/Cancel card via
 * `requestConfirmation()` before returning `'confirm'`.
 *
 * Fail-closed: any resolution failure (no agent group, no active
 * session, no originating chat) returns `'fail_closed'`. The preHandler
 * maps that to a JSON-RPC error telling the agent it can't proceed —
 * NEVER a silent allow. A security gate that fails open is not a gate.
 */
export async function decideSensitiveGate(input: SensitiveGateInput): Promise<SensitiveGateDecision> {
  const { groupFolder, integration, tool, rawSenderId, senderDisplayName, sourceChannelType, sourcePlatformId } = input;
  const classification = parseCallClassification(input.classification);

  const agentGroup = await getAgentGroupByFolder(groupFolder);
  if (!agentGroup) {
    return { decision: 'fail_closed', reason: `no agent group for folder ${groupFolder}` };
  }

  // Phase 5 — admin-controlled per-agent disable. A workspace owner/global-
  // admin can mark a trusted agent group 'off'; container-side `ncl` can
  // NEVER write this (dispatch.ts blocks it for caller==='agent' regardless
  // of cli_scope), so an injected agent cannot disable its own gate. This
  // check is AFTER agentGroup resolution on purpose: an unresolvable folder
  // still fail-closes above — disabling requires a real, admin-configured
  // group, not a forged/missing one. NULL/unset ⇒ 'enforce' (fail-safe).
  // Logged loud on every bypass so a disabled gate is never silent.
  if ((await getSensitiveGateMode(agentGroup.id)) === 'off') {
    log.warn('sensitive-gate: BYPASSED — admin-disabled for this agent group', {
      agentGroupId: agentGroup.id,
      agentGroupName: agentGroup.name,
      groupFolder,
      integration,
      tool,
    });
    return { decision: 'allow', reason: 'gate_disabled_by_admin' };
  }

  const session: Session | undefined = await findSessionByAgentGroup(agentGroup.id);
  if (!session) {
    return { decision: 'fail_closed', reason: `no active session for agent group ${agentGroup.id}` };
  }
  if (!session.messaging_group_id) {
    // Self-confirm is in-channel only — a session with no originating
    // chat has nowhere to deliver the card, so it cannot be confirmed.
    return { decision: 'fail_closed', reason: `session ${session.id} has no originating chat` };
  }
  // Resolve the chat this confirmation belongs to. Prefer the SOURCE chat the
  // triggering message came from (stamped by the host) so a merged
  // `agent-shared` agent group delivers the card to the channel the user
  // actually messaged in — not the shared session's single canonical channel
  // (the boys-night → ai-friends misroute, 2026-06-15). The source coords are
  // only honored when they resolve to a real registered messaging group;
  // anything else falls back to the session's group. The same chat is the
  // single source for BOTH actor-id namespacing AND card delivery, so
  // clicker-auth can never drift from where the card was posted — and because
  // both the confirm-issuing pass and the re-issued post-Confirm call run
  // through here with the same source coords, the `(session, actorId)` grant
  // key stays stable across the round-trip.
  const sourceMg =
    sourceChannelType && sourcePlatformId
      ? await getMessagingGroupByPlatform(sourceChannelType, sourcePlatformId)
      : undefined;
  const mg = sourceMg ?? (await getMessagingGroup(session.messaging_group_id));
  if (!mg) {
    return {
      decision: 'fail_closed',
      reason: `messaging group ${session.messaging_group_id} not found for session ${session.id}`,
    };
  }

  // Channel comes from the resolved (source-preferred) messaging group, NOT
  // from a free caller-supplied value — so the actor-id namespacing is
  // single-sourced here and can never drift from clicker-auth.
  const actorId = namespaceActorId(mg.channel_type, rawSenderId);
  const isPublicChannel = mg.is_group === 1;
  const nowMs = Date.now();

  // 1. Live grant short-circuits everything (the re-entry mechanism).
  const grant = await getConfirmationGrant(session.id, actorId);
  if (grant && grantIsLive(grant.granted_at, grant.last_used_at, nowMs)) {
    // Bump last_used_at on every silent allow (keeps idle-layer enable-able
    // later without a backfill; does NOT extend the hard cap).
    await touchConfirmationGrant(session.id, actorId, new Date(nowMs).toISOString());
    return { decision: 'allow', reason: 'live_grant' };
  }

  // 2. No live grant — evaluate the policy.
  const policy = evaluatePolicy({ classification, isPublicChannel });
  if (policy === 'allow') {
    return { decision: 'allow', reason: 'policy_allow' };
  }

  // 3. require_confirmation — fire the in-channel card and tell the
  //    preHandler to short-circuit. The actor's Confirm click creates
  //    the grant (sensitive-mcp-confirm.ts); the re-issued call then
  //    finds the live grant above and passes.
  const what = `\`${tool}\`${integration ? ` (${integration})` : ''}`;
  const approvalId = await requestConfirmation({
    session,
    agentName: agentGroup.name,
    action: 'sensitive_mcp_confirm',
    actorId,
    actorName: senderDisplayName ?? undefined,
    payload: { integration, tool, groupFolder },
    title: `Confirm: ${what}`,
    question:
      `wants to run ${what}` +
      (isPublicChannel ? ' in this channel' : '') +
      `. Confirm to allow it (and all further sensitive actions you trigger this session, for up to 30 minutes), or Cancel to block it.`,
    // Deliver the card to the resolved chat (source chat for merged groups).
    deliverTo: { channel_type: mg.channel_type, platform_id: mg.platform_id },
  });
  if (!approvalId) {
    return {
      decision: 'fail_closed',
      reason: 'confirmation card could not be delivered',
    };
  }
  log.info('sensitive-gate: confirmation required', {
    sessionId: session.id,
    actorId,
    integration,
    tool,
    approvalId,
    isPublicChannel,
    risk: classification?.risk ?? 'unclassified',
  });
  return { decision: 'confirm', approvalId };
}
