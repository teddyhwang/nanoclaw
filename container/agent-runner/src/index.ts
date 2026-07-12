/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { ensureMemoryScaffold } from './memory-scaffold.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts. Hosts that ship
// providers from outside the submodule register them via
// `loadProviderPlugins()` (awaited in main() before createProvider).
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { loadProviderPlugins } from './engine/provider-plugins.js';
import { runPollLoop, requestGracefulShutdown } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

// Graceful shutdown on host reap. `docker stop` SIGTERMs the runner (tini
// forwards it) before SIGKILLing after the grace window (killContainer's
// REAP_GRACE_SEC). Without this handler the default SIGTERM disposition kills
// the process — and the codex app-server it drives — mid-turn, poisoning
// codex's CODEX_HOME turn-state for the next container (Degenerates
// AI-Friends empty-fire, 2026-06-08). requestGracefulShutdown() ends the
// active query so the in-flight turn drains cleanly, then the poll loop exits.
// Registered at module load so a SIGTERM during early boot (before main()'s
// loop) is still caught and latched. Idempotent across repeated signals.
process.on('SIGTERM', () => {
  log('SIGTERM received — requesting graceful shutdown');
  requestGracefulShutdown();
});

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name),
  // the resolved runtime model (so "what model are you on?" has a
  // truthful answer), plus the live destinations map. Everything else
  // (capabilities, per-module instructions, per-channel formatting) is
  // loaded by Claude Code from /workspace/agent/CLAUDE.md — the composed
  // entry imports the shared base (/app/CLAUDE.md) and each enabled
  // module's fragment. Per-group memory lives in
  // /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined, {
    provider: providerName,
    model: config.model,
  });

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json.
  // The map is a discriminated union (stdio | http) — container.json may
  // carry either shape, see providers/types.ts:McpServerConfig.
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  // Optional bearer token for HTTP MCP servers. The host injects
  // `CYBERTRON_MCP_TOKEN` at spawn for hosts that gate dashboard /mcp/*
  // routes per-group. When present, attach `Authorization: Bearer
  // <token>` to every HTTP entry so the dashboard's verifyMcpToken
  // can match it against `<dataDir>/ipc/<slug>/<folder>/mcp-token`.
  // Stdio entries are unaffected (auth is local to the spawned
  // process). Standalone NanoClaw doesn't set the env var → no
  // header injected → unchanged behavior.
  //
  // `OPTIMUS_MCP_TOKEN` is the pre-S409c name; kept as a fallback so a
  // host that hasn't restarted past the rename (or a rollback) still
  // authenticates instead of silently 401ing every HTTP MCP call.
  const mcpBearer = process.env.CYBERTRON_MCP_TOKEN ?? process.env.OPTIMUS_MCP_TOKEN;
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.type === 'http' && mcpBearer) {
      mcpServers[name] = {
        ...serverConfig,
        headers: {
          ...(serverConfig.headers ?? {}),
          Authorization: `Bearer ${mcpBearer}`,
        },
      };
    } else {
      mcpServers[name] = serverConfig;
    }
    const detail = serverConfig.type === 'http' ? `http ${serverConfig.url}` : `stdio ${serverConfig.command}`;
    log(`Additional MCP server: ${name} (${detail})`);
  }

  // Host-shipped providers (pi_rpc, codex, etc.) register here via the
  // /agent/provider-plugins.json manifest. Awaited so the registry is
  // populated before createProvider() looks the name up.
  await loadProviderPlugins();

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
  });

  // Providers that lack native memory opt in via `usesMemoryScaffold`; for them
  // the runner creates a persistent memory/ tree in its host-backed workspace at
  // boot (idempotent). Default off — the trunk default (Claude) omits the flag
  // and keeps its native memory untouched.
  if (provider.usesMemoryScaffold) ensureMemoryScaffold();

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    isDreamRun: config.isDreamRun,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
