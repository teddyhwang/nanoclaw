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
 * ## Policy (single-sourced here; the dashboard-server copy is deleted)
 *
 * Ordered rules, from the v6 doc:
 *   1. write / destructive  → require_confirmation  (ANY chat)
 *   2. read & pii & public  → require_confirmation  (public channel only)
 *   3. else                 → allow
 * Unmapped tool → require_confirmation UNCONDITIONALLY (operator
 *   decision: strictest; no name heuristic; "let the LLM judge" rejected
 *   as a confused-deputy hole). Phase 1 ships the registry EMPTY, so
 *   every tool is gated (fail-closed) until Phase 2 fills it.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { findSessionByAgentGroup, getConfirmationGrant, touchConfirmationGrant } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { requestConfirmation } from './primitive.js';

// ─── Policy (pure data + pure functions; zero side effects) ───────────

export type Classification = 'read' | 'write' | 'destructive';

export interface ToolClass {
  classification: Classification;
  /** Read-only relevance: does this tool's read output carry PII? */
  pii?: boolean;
  /**
   * For multiplexer tools (one MCP tool spanning many methods, e.g.
   * `google_call`): refine classification from the call arguments.
   * Returns null to fall back to `classification`.
   */
  argPredicate?: (args: unknown) => Classification | null;
}

/**
 * Per-integration tool classification registry. Phase 1 ships it EMPTY
 * on purpose: with no entries every tool is unmapped and therefore gated
 * (fail-closed). Phase 2 fills these maps; until then the gate is
 * maximally conservative, which is the intended security posture.
 */
export const CLASSIFICATION_REGISTRY: Record<string, Record<string, ToolClass>> = {
  // google: { google_call: { classification: 'read', pii: true, argPredicate: classifyGoogleCall }, ... },
  // lunchmoney: { ... }, ixact: { ... }, ...
};

export interface PolicyContext {
  integration: string;
  tool: string;
  args: unknown;
  /** messaging_group.is_group === 1 — a multi-person ("public") chat. */
  isPublicChannel: boolean;
}

export type PolicyDecision = 'allow' | 'require_confirmation';

/** Resolve a tool's classification, or null if it is unmapped. */
export function classifyTool(integration: string, tool: string, args: unknown): ToolClass | null {
  const entry = CLASSIFICATION_REGISTRY[integration]?.[tool];
  if (!entry) return null;
  if (entry.argPredicate) {
    const refined = entry.argPredicate(args);
    if (refined) return { ...entry, classification: refined };
  }
  return entry;
}

/** The ordered policy. Unmapped → require_confirmation (fail-closed). */
export function evaluatePolicy(ctx: PolicyContext): PolicyDecision {
  const cls = classifyTool(ctx.integration, ctx.tool, ctx.args);
  if (!cls) return 'require_confirmation'; // unmapped → strictest
  if (cls.classification === 'write' || cls.classification === 'destructive') {
    return 'require_confirmation'; // rule 1 — any chat
  }
  if (cls.classification === 'read' && cls.pii && ctx.isPublicChannel) {
    return 'require_confirmation'; // rule 2 — PII read in a public channel
  }
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
  /** JSON-RPC `params.arguments` (opaque; only the argPredicate inspects it). */
  args: unknown;
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
}

export type SensitiveGateDecision =
  | { decision: 'allow'; reason: 'policy_allow' | 'live_grant' }
  | { decision: 'confirm' }
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
  const { groupFolder, integration, tool, args, rawSenderId, senderDisplayName } = input;

  const agentGroup = getAgentGroupByFolder(groupFolder);
  if (!agentGroup) {
    return { decision: 'fail_closed', reason: `no agent group for folder ${groupFolder}` };
  }
  const session: Session | undefined = findSessionByAgentGroup(agentGroup.id);
  if (!session) {
    return { decision: 'fail_closed', reason: `no active session for agent group ${agentGroup.id}` };
  }
  if (!session.messaging_group_id) {
    // Self-confirm is in-channel only — a session with no originating
    // chat has nowhere to deliver the card, so it cannot be confirmed.
    return { decision: 'fail_closed', reason: `session ${session.id} has no originating chat` };
  }
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    return {
      decision: 'fail_closed',
      reason: `messaging group ${session.messaging_group_id} not found for session ${session.id}`,
    };
  }

  // Channel comes from the session's messaging group, NOT from the
  // caller — so the actor-id namespacing is single-sourced here and can
  // never drift from clicker-auth via a wrong caller-supplied channel.
  const actorId = namespaceActorId(mg.channel_type, rawSenderId);
  const isPublicChannel = mg.is_group === 1;
  const nowMs = Date.now();

  // 1. Live grant short-circuits everything (the re-entry mechanism).
  const grant = getConfirmationGrant(session.id, actorId);
  if (grant && grantIsLive(grant.granted_at, grant.last_used_at, nowMs)) {
    // Bump last_used_at on every silent allow (keeps idle-layer enable-able
    // later without a backfill; does NOT extend the hard cap).
    touchConfirmationGrant(session.id, actorId, new Date(nowMs).toISOString());
    return { decision: 'allow', reason: 'live_grant' };
  }

  // 2. No live grant — evaluate the policy.
  const policy = evaluatePolicy({ integration, tool, args, isPublicChannel });
  if (policy === 'allow') {
    return { decision: 'allow', reason: 'policy_allow' };
  }

  // 3. require_confirmation — fire the in-channel card and tell the
  //    preHandler to short-circuit. The actor's Confirm click creates
  //    the grant (sensitive-mcp-confirm.ts); the re-issued call then
  //    finds the live grant above and passes.
  const what = `\`${tool}\`${integration ? ` (${integration})` : ''}`;
  await requestConfirmation({
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
  });
  log.info('sensitive-gate: confirmation required', {
    sessionId: session.id,
    actorId,
    integration,
    tool,
    isPublicChannel,
  });
  return { decision: 'confirm' };
}
