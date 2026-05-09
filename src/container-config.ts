/**
 * Per-group container config, stored as a plain JSON file at
 * `groups/<folder>/container.json`. Mounted read-only inside the container
 * at `/workspace/agent/container.json` — the runner reads it at startup but
 * cannot modify it. Config changes go through the self-mod approval flow.
 *
 * All fields are optional — a missing file or a partial file both resolve
 * to sensible defaults. Writes are atomic-enough (write-then-rename is not
 * worth the ceremony here since there's only one writer in practice: the
 * host, from the delivery thread that processes approved system actions).
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupDir, type GroupRef } from './engine/paths.js';

/**
 * MCP server entry inside container.json. Discriminated by `type` so a
 * single map can carry stdio (process-spawned) and http (remote endpoint)
 * shapes. Default is stdio for back-compat with configs that omit `type`.
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
  // Optional always-in-context guidance. When set, the host writes the
  // content to `.claude-fragments/mcp-<name>.md` at spawn and imports it
  // into the composed CLAUDE.md.
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

export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (default). */
  skills: string[] | 'all';
  /** Agent provider name (e.g. "claude", "opencode"). Default: "claude". */
  provider?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /**
   * Separator placed between the assistant name and the message body in
   * shared-number channel adapters (currently WhatsApp). Defaults to `": "`
   * to match the long-standing `Name: text` convention. Set to `" "` for
   * emoji-only marks (`🤖 text`) or `""` to drop entirely.
   */
  assistantPrefixSeparator?: string;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;
  /**
   * Suppress link previews / unfurls on platforms that support it (Discord
   * SUPPRESS_EMBEDS message flag). Default false. Operator-controlled per
   * agent group via the dashboard. The chat-sdk-bridge passes this through
   * to adapters as `OutboundMessage.suppressEmbeds`; adapters whose
   * platform has no embed concept (WhatsApp, Telegram) ignore it.
   */
  suppressEmbeds?: boolean;
}

function emptyConfig(): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
  };
}

function configPath(group: GroupRef): string {
  return path.join(resolveGroupDir(group), 'container.json');
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed files — corruption logs a warning
 * via console.error and falls back to empty.
 */
export function readContainerConfig(group: GroupRef): ContainerConfig {
  const p = configPath(group);
  if (!fs.existsSync(p)) return emptyConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
    return {
      mcpServers: raw.mcpServers ?? {},
      packages: {
        apt: raw.packages?.apt ?? [],
        npm: raw.packages?.npm ?? [],
      },
      imageTag: raw.imageTag,
      additionalMounts: raw.additionalMounts ?? [],
      skills: raw.skills ?? 'all',
      provider: raw.provider,
      groupName: raw.groupName,
      assistantName: raw.assistantName,
      assistantPrefixSeparator: raw.assistantPrefixSeparator,
      agentGroupId: raw.agentGroupId,
      maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
      suppressEmbeds: raw.suppressEmbeds,
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(group: GroupRef, config: ContainerConfig): void {
  const p = configPath(group);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(group: GroupRef, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(group);
  mutate(config);
  writeContainerConfig(group, config);
  return config;
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`.
 */
export function initContainerConfig(group: GroupRef): boolean {
  const p = configPath(group);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(group, emptyConfig());
  return true;
}
