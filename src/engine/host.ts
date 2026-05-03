/**
 * Embeddable NanoClaw host.
 *
 * `createNanoClawHost(options)` returns a host handle with `start()` /
 * `stop()` / `reload()` so an embedding process (Optimus) can run the
 * engine without depending on the standalone `src/index.ts` entrypoint
 * (which calls `process.exit()` and reads `process.cwd()`).
 *
 * Standalone v2 still works unchanged — `src/index.ts` itself calls
 * `createNanoClawHost({ managedSignals: true })` under the hood once the
 * cli adapter shifts to it (intentionally deferred — see option 2 of the
 * audit). For now the standalone path is preserved bit-for-bit.
 */
import path from 'path';

import { setEnginePaths, getEnginePaths, type EnginePathOverrides } from './paths.js';
import { applyPlugins, createPluginContext, type NanoClawPlugin, type PluginContext } from './plugin.js';
import { engineEvents, type EngineEventBus } from './events.js';
import { getReadDal, type ReadDal } from './db-extensions.js';

export interface NanoClawHostOptions {
  /** Path overrides. Missing fields fall back to standalone defaults. */
  paths?: EnginePathOverrides;
  /** Plugins to apply at boot. */
  plugins?: NanoClawPlugin[];
  /** Pre-applied event listeners. Convenience over registering them via plugin context. */
  events?: {
    [K in keyof import('./events.js').EngineEventMap]?: (payload: import('./events.js').EngineEventMap[K]) => void;
  };
  /**
   * If true (default), the host installs its own SIGTERM/SIGINT handlers and
   * calls `process.exit(0)` on graceful shutdown. Set false when an outer
   * process owns signal handling (Optimus host).
   */
  managedSignals?: boolean;
}

export interface NanoClawHost {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  reload(): Promise<void>;
  registerPlugin(p: NanoClawPlugin): Promise<void>;
  events: EngineEventBus;
  db: ReadDal;
}

/**
 * Construct a host. Does not start it — the caller invokes `.start()` so
 * tests and embedders can stage state (override credentials, install mock
 * channels) between construction and boot.
 *
 * Calling this function:
 *   - applies path overrides via setEnginePaths();
 *   - builds a plugin context;
 *   - applies the supplied plugins (so their channel adapters / migrations /
 *     gates are registered before .start() runs the existing v2 boot path).
 *
 * Calling `.start()` then runs the existing v2 boot sequence:
 *   - circuit breaker
 *   - initDb + migrations (now also picks up plugin migrations)
 *   - container runtime check
 *   - channel adapters init
 *   - delivery + sweep polls
 *
 * Implementation note: to avoid duplicating the boot sequence, `.start()`
 * delegates to `runStandaloneBoot` (extracted from the existing
 * `src/index.ts` body). That body lands in `src/index.ts` itself in the
 * tap-point patch — the engine module re-exports a `_bootForHost` function
 * the standalone entry calls.
 */
export async function createNanoClawHost(options: NanoClawHostOptions = {}): Promise<NanoClawHost> {
  if (options.paths) setEnginePaths(options.paths);

  const ctx: PluginContext = createPluginContext();

  // Pre-applied event listeners — convenience for embedders that don't want
  // to write a one-off plugin just to subscribe.
  if (options.events) {
    for (const [name, handler] of Object.entries(options.events)) {
      if (handler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        engineEvents.on(name as any, handler as any);
      }
    }
  }

  if (options.plugins && options.plugins.length > 0) {
    await applyPlugins(options.plugins, ctx);
  }

  const plugins: NanoClawPlugin[] = [...(options.plugins ?? [])];
  let started = false;

  return {
    async start() {
      if (started) return;
      started = true;
      // Lazy-import the boot module so constructing a host (e.g. for tests)
      // doesn't pull the full DB/container runtime stack.
      const { _bootForHost } = await import('./host-boot.js');
      await _bootForHost({ managedSignals: options.managedSignals ?? true });
    },
    async stop(reason = 'host.stop') {
      const { _shutdownForHost } = await import('./host-boot.js');
      await _shutdownForHost(reason);
    },
    async reload() {
      // Reload semantics today: re-read container.json / CLAUDE.md fragments
      // on next spawn. No live channel-adapter restart yet; that is a future
      // expansion when hosts need it.
      const { _reloadForHost } = await import('./host-boot.js');
      await _reloadForHost();
    },
    async registerPlugin(p: NanoClawPlugin) {
      plugins.push(p);
      await applyPlugins([p], ctx);
    },
    events: engineEvents,
    db: getReadDal(),
  };
}

/** Re-exports for test ergonomics. */
export { getEnginePaths, path };
