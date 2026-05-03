/**
 * Workspace bridge.
 *
 * NanoClaw's entity model has agent_groups, messaging_groups, and users — no
 * notion of a workspace. Multi-tenant hosts (Optimus) need to bind those
 * entities to a workspace identity for per-workspace credential lookups, ACL,
 * and dashboard projection.
 *
 * The bridge is a single resolver function the host registers. The engine
 * itself never branches on workspace; it just forwards `workspaceId` to
 * plugin context (credentials, spawn contributions, event payloads) when
 * resolved. Without a registered resolver, every lookup returns null and
 * the engine behaves identically to standalone v2.
 */
import type { InboundEvent } from '../channels/adapter.js';

export interface WorkspaceContext {
  workspaceId: string;
  /** Optional opaque slug for human-facing logs. */
  slug?: string;
}

export type WorkspaceResolverFn = (input: {
  agentGroupId?: string;
  userId?: string | null;
  event?: InboundEvent;
}) => WorkspaceContext | null | Promise<WorkspaceContext | null>;

let resolver: WorkspaceResolverFn | null = null;

export function setWorkspaceResolver(fn: WorkspaceResolverFn): void {
  resolver = fn;
}

export async function resolveWorkspace(input: Parameters<WorkspaceResolverFn>[0]): Promise<WorkspaceContext | null> {
  if (!resolver) return null;
  return resolver(input);
}

/** Test-only. */
export function _resetWorkspaceResolverForTests(): void {
  resolver = null;
}
