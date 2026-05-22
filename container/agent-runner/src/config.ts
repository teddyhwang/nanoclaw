/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { McpServerConfig } from './providers/types.js';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  /** Discriminated union — see providers/types.ts:McpServerConfig. */
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  effort?: string;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 *
 * `NANOCLAW_DREAM_HARNESS` override: container.json `provider` is the
 * agent group's standing harness. When a spawn is a Dream / maintenance
 * pass, the host injects `NANOCLAW_DREAM_HARNESS` (a provider name —
 * `claude`, `codex`, …) so the dream runs on the operator-selected
 * harness regardless of the group's normal provider. The env var is
 * dream-scoped by name; it is only ever set on dream spawns, so there is
 * no risk of it leaking into a normal turn.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  const dreamHarness = process.env.NANOCLAW_DREAM_HARNESS?.trim();
  const provider = dreamHarness || (raw.provider as string) || 'claude';
  if (dreamHarness) {
    console.error(`[config] NANOCLAW_DREAM_HARNESS set — Dream pass overriding provider to "${dreamHarness}"`);
  }

  _config = {
    provider,
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

/** Test-only: clear the memoized config so loadConfig() re-reads. */
export function _resetConfigForTests(): void {
  _config = null;
}
