/**
 * Container-side provider plugin loader.
 *
 * Symmetric with `engine/tool-plugins.ts`. Hosts that need to ship custom
 * AgentProvider implementations (pi_rpc, codex, ollama-direct, …) without
 * forking the agent-runner barrel can do so by:
 *
 *   1. Mounting a directory containing a built or source provider module
 *      into the container (e.g. `/plugins/optimus-providers`).
 *   2. Writing a manifest at `/agent/provider-plugins.json` (or whichever
 *      path is set in `NANOCLAW_PROVIDER_PLUGINS_MANIFEST`).
 *   3. Each listed module calls `registerProvider(name, factory)` at top
 *      level — same pattern the built-in `claude.ts` and `mock.ts` use.
 *
 * Manifest format (JSON):
 *   {
 *     "providers": [
 *       { "module": "/plugins/optimus-providers/src/pi-rpc.ts" },
 *       { "module": "file:///plugins/finance-providers/src/index.ts" }
 *     ]
 *   }
 *
 * Lifecycle: `main()` in `index.ts` imports the static barrel
 * (`providers/index.js`) at module load time, then awaits this loader
 * BEFORE the first `createProvider(name)` call. That ordering guarantees
 * every plugin's `registerProvider` side effect has fired in time for
 * lookup. Missing manifest = no plugins, identical to the standalone case.
 *
 * Default manifest path: `/agent/provider-plugins.json`. Hosts can override
 * by setting `NANOCLAW_PROVIDER_PLUGINS_MANIFEST` in the container env.
 */
import fs from 'fs';

interface ProviderPluginManifest {
  providers?: { module: string }[];
}

const DEFAULT_MANIFEST_PATH = '/agent/provider-plugins.json';

function log(msg: string): void {
  console.error(`[provider-plugins] ${msg}`);
}

export async function loadProviderPlugins(): Promise<void> {
  const manifestPath =
    process.env.NANOCLAW_PROVIDER_PLUGINS_MANIFEST || DEFAULT_MANIFEST_PATH;
  if (!fs.existsSync(manifestPath)) return;

  let manifest: ProviderPluginManifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as ProviderPluginManifest;
  } catch (err) {
    log(`failed to parse manifest ${manifestPath}: ${String(err)}`);
    return;
  }

  for (const entry of manifest.providers ?? []) {
    try {
      await import(entry.module);
      log(`loaded provider plugin: ${entry.module}`);
    } catch (err) {
      log(`failed to load provider plugin ${entry.module}: ${String(err)}`);
    }
  }
}
