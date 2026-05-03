/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();
/** Maps registration name → channelType used as the activeAdapters key.
 * Set when initChannelAdapters or addChannelAdapterAtRuntime sets up an
 * adapter. Used by unregisterChannelAdapter to find the live adapter without
 * re-running the factory or parsing synthetic names. */
const nameToChannelType = new Map<string, string>();
/**
 * Boot-time setupFn captured during initChannelAdapters. The host's setup
 * builder closes over routeInbound/dispatchResponse — internal to host-boot
 * and not part of the plugin surface. Stash it here so addChannelAdapterAtRuntime
 * can wire newly-added adapters into the same router pipeline that boot
 * adapters use. Cleared on teardownChannelAdapters().
 */
let bootSetupFn: ((adapter: ChannelAdapter) => ChannelSetup) | null = null;

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  bootSetupFn = setupFn;
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      activeAdapters.set(adapter.channelType, adapter);
      nameToChannelType.set(name, adapter.channelType);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/**
 * Register, set up, and add a single adapter post-boot. Mirrors the per-adapter
 * branch of `initChannelAdapters` (factory → setup with retry → activeAdapters)
 * for hosts that add channels at runtime (e.g. credential-driven multi-instance
 * plugins reconciling against a dashboard DB).
 *
 * Returns the registered name on success, null if the factory yielded nothing.
 * Throws if setup fails after retries — caller decides how to back off.
 */
export async function addChannelAdapterAtRuntime(
  name: string,
  registration: ChannelRegistration,
  setupFn?: (adapter: ChannelAdapter) => ChannelSetup,
): Promise<string | null> {
  // Plugins called from outside the engine can't construct a real ChannelSetup
  // (it closes over the host's router/dispatch internals). Fall back to the
  // setupFn captured during initChannelAdapters so newly-added adapters wire
  // into the same router pipeline as boot-time adapters.
  const effectiveSetup = setupFn ?? bootSetupFn;
  if (!effectiveSetup) {
    throw new Error(
      'addChannelAdapterAtRuntime: no setupFn available. Call from a plugin running after initChannelAdapters, or pass an explicit setupFn (test contexts only).',
    );
  }
  registry.set(name, registration);
  const adapter = await registration.factory();
  if (!adapter) {
    log.warn('Channel credentials missing, skipping', { channel: name });
    return null;
  }
  const setup = effectiveSetup(adapter);
  let attempt = 0;
  while (true) {
    try {
      await adapter.setup(setup);
      break;
    } catch (err) {
      if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
        const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
        log.warn('Channel adapter setup failed with network error, retrying', {
          channel: name,
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  activeAdapters.set(adapter.channelType, adapter);
  nameToChannelType.set(name, adapter.channelType);
  log.info('Channel adapter started', { channel: name, type: adapter.channelType });
  return name;
}

/**
 * Tear down and remove a single adapter by registration name. Mirrors
 * `addChannelAdapterAtRuntime`. Idempotent — unknown names are a no-op.
 */
export async function unregisterChannelAdapter(name: string): Promise<void> {
  const channelType = nameToChannelType.get(name);
  registry.delete(name);
  nameToChannelType.delete(name);
  if (!channelType) return;
  const adapter = activeAdapters.get(channelType);
  if (!adapter) return;
  try {
    await adapter.teardown();
    log.info('Channel adapter stopped', { channel: name });
  } catch (err) {
    log.error('Failed to stop channel adapter', { channel: name, err });
  }
  activeAdapters.delete(channelType);
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
  nameToChannelType.clear();
  bootSetupFn = null;
}
