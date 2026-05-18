/**
 * One-time backfill: seed `container_configs` rows from existing
 * `groups/<folder>/container.json` files and `agent_groups.agent_provider`.
 *
 * Runs after migrations, before channel adapters start. Idempotent — skips
 * groups that already have a config row.
 *
 * Optimus fork patch: resolves the on-disk path through `resolveGroupDir` so
 * embedded hosts that nest groups under workspace slugs find the legacy
 * file. Also picks up Optimus-only fields (`suppressEmbeds`,
 * `assistantPrefixSeparator`) added by migration 016.
 */
import fs from 'fs';
import path from 'path';

import type { McpServerConfig, AdditionalMountConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getContainerConfig, createContainerConfig } from './db/container-configs.js';
import { resolveGroupDir } from './engine/paths.js';
import { log } from './log.js';
import type { ContainerConfigRow } from './types.js';

interface LegacyContainerJson {
  mcpServers?: Record<string, McpServerConfig>;
  packages?: { apt?: string[]; npm?: string[] };
  imageTag?: string;
  additionalMounts?: AdditionalMountConfig[];
  skills?: string[] | 'all';
  provider?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
  // Optimus fork-only fields.
  suppressEmbeds?: boolean;
  assistantPrefixSeparator?: string;
}

export function backfillContainerConfigs(): void {
  const groups = getAllAgentGroups();
  let backfilled = 0;

  for (const group of groups) {
    // Skip if already has a config row
    if (getContainerConfig(group.id)) continue;

    // Read legacy container.json from disk via the engine seam so embedded
    // hosts (Optimus) hit the right workspace-nested path.
    const filePath = path.join(resolveGroupDir(group), 'container.json');
    let legacy: LegacyContainerJson = {};
    if (fs.existsSync(filePath)) {
      try {
        legacy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyContainerJson;
      } catch (err) {
        log.warn('Backfill: failed to parse container.json, using defaults', {
          folder: group.folder,
          err: String(err),
        });
      }
    }

    // DB agent_provider wins over file provider (matches old cascade)
    const provider = group.agent_provider || legacy.provider || null;

    const row: ContainerConfigRow = {
      agent_group_id: group.id,
      provider,
      model: null,
      effort: null,
      image_tag: legacy.imageTag ?? null,
      assistant_name: legacy.assistantName ?? null,
      max_messages_per_prompt: legacy.maxMessagesPerPrompt ?? null,
      skills: JSON.stringify(legacy.skills ?? 'all'),
      mcp_servers: JSON.stringify(legacy.mcpServers ?? {}),
      packages_apt: JSON.stringify(legacy.packages?.apt ?? []),
      packages_npm: JSON.stringify(legacy.packages?.npm ?? []),
      additional_mounts: JSON.stringify(legacy.additionalMounts ?? []),
      cli_scope: 'group',
      // Optimus fork patch — preserve `suppressEmbeds` honestly. Default true
      // for new groups (matches the pre-migration `readContainerConfig`
      // behaviour where missing key collapsed to true). `assistant_prefix_separator`
      // stays NULL = legacy `": "` default.
      suppress_embeds: legacy.suppressEmbeds === false ? 0 : 1,
      assistant_prefix_separator: legacy.assistantPrefixSeparator ?? null,
      // Optimus fork patch (migration 017) — backfilled rows start with
      // the gate ENFORCED (fail-safe). NULL would also read as enforce;
      // we leave it NULL rather than writing 'enforce' so a later admin
      // 'off' is distinguishable from "never configured" in audits.
      sensitive_gate_mode: null,
      updated_at: new Date().toISOString(),
    };

    createContainerConfig(row);
    backfilled++;
  }

  if (backfilled > 0) {
    log.info('Backfilled container_configs from disk', { count: backfilled });
  }
}
