/**
 * Plugin contract.
 *
 * A `NanoClawPlugin` is a small object with a `register(ctx)` function. The
 * host's `createNanoClawHost({ plugins: [...] })` invokes each plugin's
 * `register` with a `PluginContext` that exposes typed registries and event
 * subscriptions. Plugins should not import engine internals directly — the
 * context is the entire surface.
 *
 * Lifecycle: plugins register synchronously (or with awaited init work) at
 * boot, before channel adapters spin up. Late-registered plugins (via
 * `host.registerPlugin`) work but skip the channels-not-yet-set-up window.
 */
import { registerChannelAdapter } from '../channels/channel-registry.js';
import type { ChannelRegistration } from '../channels/adapter.js';
import {
  registerProviderContainerConfig,
  type ProviderContainerConfigFn,
} from '../providers/provider-container-registry.js';
import {
  addAccessGate,
  addChannelRequestGate,
  addMessageInterceptor,
  addSenderResolver,
  addSenderScopeGate,
} from './router-hooks.js';
import { registerMultiChannelAdapter, type MultiChannelRegistration } from './channel-multi.js';
import { engineEvents, type EngineEventBus } from './events.js';
import { registerSpawnContribution, type SpawnContribution } from './spawn-contrib.js';
import {
  addContextFragmentProvider,
  addSkillRoot,
  type ContextFragmentProvider,
  type ExtraSkillRoot,
} from './skill-roots.js';
import {
  setSharedBaseProvider,
  setDocsRootProvider,
  setSharedDreamProvider,
  type SharedBaseProvider,
  type DocsRootProvider,
  type SharedDreamProvider,
} from './composer-hooks.js';
import { setWorkspaceResolver, type WorkspaceResolverFn } from './workspace.js';
import { setCredentialProvider, type CredentialProvider } from './credentials.js';
import { registerPluginMigrations, getReadDal, type PluginMigration, type ReadDal } from './db-extensions.js';
import {
  type AccessGateFn,
  type ChannelRequestGateFn,
  type MessageInterceptorFn,
  type SenderResolverFn,
  type SenderScopeGateFn,
} from '../router.js';

export interface PluginContext {
  channels: {
    register(name: string, registration: ChannelRegistration): void;
    /** For plugins that produce N adapters (per-workspace, per-token). */
    registerMulti(name: string, registration: MultiChannelRegistration): Promise<void>;
  };
  providers: {
    registerContainerConfig(name: string, fn: ProviderContainerConfigFn): void;
    registerSpawnContribution(fn: SpawnContribution): () => void;
  };
  router: {
    addSenderResolver(fn: SenderResolverFn): () => void;
    addAccessGate(fn: AccessGateFn): () => void;
    addSenderScopeGate(fn: SenderScopeGateFn): () => void;
    addMessageInterceptor(fn: MessageInterceptorFn): () => void;
    addChannelRequestGate(fn: ChannelRequestGateFn): () => void;
    setWorkspaceResolver(fn: WorkspaceResolverFn): void;
  };
  events: EngineEventBus;
  db: {
    registerMigrations(migrations: PluginMigration[]): void;
    read: ReadDal;
  };
  skills: {
    addSkillRoot(root: ExtraSkillRoot): () => void;
    addContextFragmentProvider(fn: ContextFragmentProvider): () => void;
  };
  composer: {
    /**
     * Override the shared base mounted at /app/CLAUDE.md. When set, the
     * composer mounts the returned host path instead of the default
     * `<container source>/CLAUDE.md`. Last-write-wins.
     */
    setSharedBaseProvider(fn: SharedBaseProvider): () => void;
    /**
     * Provide a host directory to mount RO at /app/docs/. The eager
     * shared-base CLAUDE.md can link to files here for progressive
     * disclosure: lightweight kernel + deep references loaded on demand.
     * Last-write-wins.
     */
    setDocsRootProvider(fn: DocsRootProvider): () => void;
    /**
     * Provide a host path for the canonical DREAM.md, nested RO-mounted
     * at /workspace/agent/DREAM.md in every container. Keeps the
     * consolidation protocol single-source — per-group dirs don't carry
     * their own copies. Last-write-wins.
     */
    setSharedDreamProvider(fn: SharedDreamProvider): () => void;
  };
  credentials: {
    register(p: CredentialProvider): void;
  };
}

export interface NanoClawPlugin {
  name: string;
  register(ctx: PluginContext): void | Promise<void>;
}

/**
 * Build a plugin context. The lifetime is the host process — there is exactly
 * one context shared across plugins, so that registries (event listeners,
 * gates, migrations) accumulate.
 */
export function createPluginContext(): PluginContext {
  return {
    channels: {
      register: (name, registration) => registerChannelAdapter(name, registration),
      registerMulti: (name, registration) => registerMultiChannelAdapter(name, registration),
    },
    providers: {
      registerContainerConfig: (name, fn) => registerProviderContainerConfig(name, fn),
      registerSpawnContribution: (fn) => registerSpawnContribution(fn),
    },
    router: {
      addSenderResolver,
      addAccessGate,
      addSenderScopeGate,
      addMessageInterceptor,
      addChannelRequestGate,
      setWorkspaceResolver,
    },
    events: engineEvents,
    db: {
      registerMigrations: (m) => registerPluginMigrations(m),
      read: getReadDal(),
    },
    skills: {
      addSkillRoot,
      addContextFragmentProvider,
    },
    composer: {
      setSharedBaseProvider: (fn) => setSharedBaseProvider(fn),
      setDocsRootProvider: (fn) => setDocsRootProvider(fn),
      setSharedDreamProvider: (fn) => setSharedDreamProvider(fn),
    },
    credentials: {
      register: (p) => setCredentialProvider(p),
    },
  };
}

/** Apply a list of plugins against a single context. Errors are logged per-plugin. */
export async function applyPlugins(plugins: NanoClawPlugin[], ctx: PluginContext): Promise<void> {
  for (const p of plugins) {
    try {
      await p.register(ctx);
    } catch (err) {
      // log lazily — keep this module independent of log.ts in case plugin loads
      // before the logger is fully wired.
      // eslint-disable-next-line no-console
      console.error(`[plugin ${p.name}] register threw`, err);
    }
  }
}
