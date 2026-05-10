/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 *
 * Optimus fork patch: `McpServerConfig` is a discriminated union (stdio | http),
 * and the materialized JSON carries two extra fields populated from DB columns
 * added by migration 016: `suppressEmbeds` and `assistantPrefixSeparator`.
 */
import fs from 'fs';
import path from 'path';

import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { resolveGroupDir } from './engine/paths.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * MCP server entry inside container.json. Discriminated by `type` so a single
 * map can carry stdio (process-spawned) and http (remote endpoint) shapes.
 * Default is stdio for back-compat with configs that omit `type`.
 *
 * Mirrors `McpServerConfig` in
 * container/agent-runner/src/providers/types.ts. Update both together.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpStdioServerConfig {
  /** Optional discriminant. Omitted = 'stdio' for back-compat. */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  /** Optional bearer / custom headers. */
  headers?: Record<string, string>;
  /** Same instructions hook as stdio servers. */
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  /**
   * Suppress link previews / unfurls on platforms that support it (Discord
   * SUPPRESS_EMBEDS message flag). Default true. Operator-controlled per
   * agent group via the dashboard. The chat-sdk-bridge passes this through
   * to adapters as `OutboundMessage.suppressEmbeds`; adapters whose platform
   * has no embed concept (WhatsApp, Telegram) ignore it.
   */
  suppressEmbeds?: boolean;
  /**
   * Separator placed between the assistant name and the message body in
   * shared-number channel adapters (currently WhatsApp). Defaults to `": "`
   * to match the long-standing `Name: text` convention. Set to `" "` for
   * emoji-only marks (`🤖 text`) or `""` to drop entirely.
   */
  assistantPrefixSeparator?: string;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    // Optimus fork patch — both undefined and 0/null collapse to false; defaults
    // baked in at the migration layer (suppress_embeds=1, separator=NULL).
    suppressEmbeds: row.suppress_embeds === 1,
    assistantPrefixSeparator: row.assistant_prefix_separator ?? undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 *
 * Path goes through `resolveGroupDir` so embedded hosts (e.g. Optimus,
 * which nests groups under workspace slugs) write to the correct dir
 * via the registered `groupDirResolver`.
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const dir = resolveGroupDir(group);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(config, null, 2) + '\n');

  return config;
}
