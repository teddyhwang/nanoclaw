/**
 * Multi-instance channel adapter wrapper.
 *
 * v2's `ChannelAdapterFactory` returns a single `ChannelAdapter`. Hosts that
 * run per-workspace (or per-credential) bots need to spawn N adapter
 * instances from one logical registration without modifying the registry's
 * iteration loop.
 *
 * The wrapper lets a plugin call `registerMultiChannelAdapter(name, factory)`
 * with a factory that yields an array. Internally we register each adapter
 * with a unique synthetic registration name (`<name>:<channelType>`) so the
 * existing registry contract is preserved unchanged.
 *
 * Native single-instance adapters (cli, telegram, whatsapp) keep using
 * `registerChannelAdapter` directly — this is opt-in.
 */
import { registerChannelAdapter } from '../channels/channel-registry.js';
import type { ChannelAdapter, ChannelRegistration } from '../channels/adapter.js';

export type MultiChannelFactory = () => ChannelAdapter[] | Promise<ChannelAdapter[]> | null;

export interface MultiChannelRegistration {
  factory: MultiChannelFactory;
  containerConfig?: ChannelRegistration['containerConfig'];
}

/**
 * Resolve the factory once at registration time, then register each returned
 * adapter under its own synthetic name. The registry's setup loop calls each
 * factory once on `initChannelAdapters`, so we wrap the upstream factory in
 * a memoized resolver and split the result.
 *
 * Note: factory is invoked twice in the worst case — once at registration to
 * discover instance count, and once per resolved adapter at setup time
 * (returning the cached instance). Most factories are credential-cheap
 * (read env, instantiate) so this is fine.
 */
export async function registerMultiChannelAdapter(name: string, registration: MultiChannelRegistration): Promise<void> {
  const adapters = await registration.factory();
  if (!adapters || adapters.length === 0) return;

  for (const adapter of adapters) {
    const subName = `${name}:${adapter.channelType}`;
    registerChannelAdapter(subName, {
      factory: () => adapter,
      containerConfig: registration.containerConfig,
    });
  }
}
