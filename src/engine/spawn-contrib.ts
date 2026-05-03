/**
 * Container spawn contribution registry.
 *
 * Plugins (per-channel, per-workspace, per-feature) can add mounts/env to a
 * spawning container without editing `container-runner.ts`. Distinct from
 * `provider-container-registry.ts`, which is keyed by provider name; these
 * contributions run for every spawn and may decide based on the spawn
 * context (agentGroupId, sessionId, channelTypes wired in).
 */
import type { ProviderContainerContribution, VolumeMount } from '../providers/provider-container-registry.js';

export interface SpawnContext {
  sessionId: string;
  agentGroupId: string;
  agentGroupFolder: string;
  /** Per-session host directory: `<dataDir>/v2-sessions/<sessionId>`. */
  sessionDir: string;
  /** Channel types wired into this agent group via `messaging_group_agents`. */
  channelTypes: string[];
}

export type SpawnContribution = (
  ctx: SpawnContext,
) => ProviderContainerContribution | Promise<ProviderContainerContribution>;

const contributors: SpawnContribution[] = [];

export function registerSpawnContribution(fn: SpawnContribution): () => void {
  contributors.push(fn);
  return () => {
    const i = contributors.indexOf(fn);
    if (i >= 0) contributors.splice(i, 1);
  };
}

export async function collectSpawnContributions(
  ctx: SpawnContext,
): Promise<{ mounts: VolumeMount[]; env: Record<string, string> }> {
  const mounts: VolumeMount[] = [];
  const env: Record<string, string> = {};
  for (const fn of contributors) {
    const result = await fn(ctx);
    if (result.mounts) mounts.push(...result.mounts);
    if (result.env) Object.assign(env, result.env);
  }
  return { mounts, env };
}

/** Test-only. */
export function _resetSpawnContributionsForTests(): void {
  contributors.length = 0;
}
