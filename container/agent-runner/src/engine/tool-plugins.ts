/**
 * Container-side tool plugin loader.
 *
 * Optimus and other hosts ship MCP tools that need to live in the same
 * `nanoclaw` MCP server (so they can share session DB internals and the
 * tool execution path), without forking the agent-runner barrel.
 *
 * The host writes a manifest file to a known path inside the container
 * mount tree. This loader reads it at startup, dynamically imports each
 * listed module, and lets each module call `registerTools([...])` exactly
 * the way the built-in tool files do. Missing manifest = no plugins (the
 * standalone case).
 *
 * Manifest format (JSON):
 *   {
 *     "tools": [
 *       { "module": "/plugins/optimus-tools/dist/index.js" },
 *       { "module": "file:///plugins/finance/dist/index.js" }
 *     ]
 *   }
 *
 * Each "module" path must be importable inside the container. Hosts mount
 * their plugin trees RO into a known location (e.g. `/plugins`) and write
 * the manifest pointing at the entry files.
 *
 * Default manifest path: `/agent/tool-plugins.json`. Hosts can override by
 * setting `NANOCLAW_TOOL_PLUGINS_MANIFEST` in the container env.
 */
import fs from 'fs';

interface ToolPluginManifest {
  tools?: { module: string }[];
}

const DEFAULT_MANIFEST_PATH = '/agent/tool-plugins.json';

function log(msg: string): void {
  console.error(`[tool-plugins] ${msg}`);
}

export async function loadToolPlugins(): Promise<void> {
  const manifestPath = process.env.NANOCLAW_TOOL_PLUGINS_MANIFEST || DEFAULT_MANIFEST_PATH;
  if (!fs.existsSync(manifestPath)) return;

  let manifest: ToolPluginManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ToolPluginManifest;
  } catch (err) {
    log(`failed to parse manifest ${manifestPath}: ${String(err)}`);
    return;
  }

  for (const entry of manifest.tools ?? []) {
    try {
      await import(entry.module);
      log(`loaded tool plugin: ${entry.module}`);
    } catch (err) {
      log(`failed to load tool plugin ${entry.module}: ${String(err)}`);
    }
  }
}
