/**
 * Shared-groups resolver seam.
 *
 * v1 had a hardcoded query (apps/nanoclaw/src/custom-db/shared-groups.ts) that
 * joined messages.db tables to find which workspace-public groups a DM
 * container's user was a member of, then mounted their memory + identity
 * RO into /workspace/shared-groups/<folder>/.
 *
 * v2's submodule has no cybertron/messages-db access. This module exposes a
 * setter so the embedding host (apps/optimus) can register a resolver that
 * does the cross-DB query and returns the refs. container-runner calls the
 * resolver during buildMounts; null resolver → no shared-groups mounts.
 *
 * Same shape as setEnginePaths — call once at host boot, before first spawn.
 */
import type { AgentGroup } from './types.js';

export interface SharedGroupRef {
  /** Group folder under <projectRoot>/groups/. */
  folder: string;
  /** Display name, surfaced in NANOCLAW_SHARED_GROUPS_JSON. */
  name: string;
  /** Channel type (discord/telegram/whatsapp/etc). */
  channel: string;
  /** Optional QMD collection name; surfaced via env, not mounted. */
  qmdCollection?: string;
}

export type SharedGroupsResolver = (agentGroup: AgentGroup) => SharedGroupRef[];

let _resolver: SharedGroupsResolver | null = null;

export function setSharedGroupsResolver(fn: SharedGroupsResolver | null): void {
  _resolver = fn;
}

export function resolveSharedGroups(agentGroup: AgentGroup): SharedGroupRef[] {
  if (!_resolver) return [];
  try {
    return _resolver(agentGroup);
  } catch {
    return [];
  }
}
