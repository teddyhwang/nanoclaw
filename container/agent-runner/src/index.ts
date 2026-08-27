/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All message IO goes through the registered mailbox.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     mailbox state     ← selected implementation
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       CLAUDE.md       ← composed project document (RO nested mount)
 *       container.json  ← per-group config (RO nested mount)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import './modules/index.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts. Hosts that ship
// providers from outside the submodule register them via
// `loadProviderPlugins()` (awaited in main() before createProvider).
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { resolvePluginServer } from './plugin-mcp.js';
import type { AgentProvider, McpServerConfig, ProviderOptions } from './providers/types.js';
import { resolveUsageLimitFallback, UsageLimitFallbackProvider } from './providers/usage-limit-fallback.js';
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
  const mailbox = getAgentMailbox();

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Every provider shares the provider-neutral memory scaffold. Legacy imports
  // remain an explicit operator migration, never an automatic startup action.
  ensureMemoryScaffold();

  await mailbox.start(await readMailboxContext());
  try {
    // Runtime-generated system-prompt addendum: agent identity (name),
    // the resolved runtime model (so "what model are you on?" has a truthful
    // answer), plus the live destinations map. Everything else is loaded from
    // /workspace/agent/CLAUDE.md — one flat file the host composes per spawn
    // with every instruction source inlined, no imports. Per-group memory lives
    // in /workspace/agent/CLAUDE.local.md and is loaded by the provider hook.
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
      // Plugin-shipped servers get ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion and
      // the two injected env vars; everything else passes through untouched.
      // Runs BEFORE the bearer-header injection below so a plugin-shipped HTTP
      // server still gets the Authorization header layered on its resolved form.
      const resolved = resolvePluginServer(serverConfig);
      if (resolved.type === 'http' && mcpBearer) {
        mcpServers[name] = {
          ...resolved,
          headers: {
            ...(resolved.headers ?? {}),
            Authorization: `Bearer ${mcpBearer}`,
          },
        };
      } else {
        mcpServers[name] = resolved;
      }
      const detail = resolved.type === 'http' ? `http ${resolved.url}` : `stdio ${resolved.command}`;
      log(`Additional MCP server: ${name} (${detail})`);
    }

    // Host-shipped providers (pi_rpc, codex, etc.) register here via the
    // /agent/provider-plugins.json manifest. Awaited so the registry is
    // populated before createProvider() looks the name up.
    await loadProviderPlugins();

    const providerOptions: ProviderOptions = {
      assistantName: config.assistantName || undefined,
      mcpServers,
      env: { ...process.env },
      additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
      model: config.model,
      effort: config.effort,
    };
    const standingProvider = createProvider(providerName, providerOptions);
    let provider: AgentProvider = standingProvider;

    // Optional transparent account-quota failover. The host enables this and
    // supplies the alternate family model through spawn env. Only explicit
    // classification:'quota' events trigger it; transport failures keep their
    // normal retry behavior. The alternate continuation is ephemeral, so a
    // Claude thread id can never be persisted under Codex (or vice versa).
    const fallback = resolveUsageLimitFallback(providerName);
    if (fallback) {
      const alternate = createProvider(fallback.providerName, {
        ...providerOptions,
        model: fallback.model,
      });
      provider = new UsageLimitFallbackProvider({
        primaryName: providerName,
        fallbackName: fallback.providerName,
        fallbackModel: fallback.model,
        primary: standingProvider,
        fallback: alternate,
      });
      log(
        `Usage-limit failover armed: ${providerName} → ${fallback.providerName}` +
          (fallback.model ? ` (${fallback.model})` : ''),
      );
    }

    // Every provider receives the shared memory lifecycle hook. Wrapper
    // providers forward registration to their active provider implementation.
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    await runPollLoop({
      provider,
      providerName,
      cwd: CWD,
      systemContext: { instructions },
      isDreamRun: config.isDreamRun,
    });
  } finally {
    await mailbox.stop();
  }
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
