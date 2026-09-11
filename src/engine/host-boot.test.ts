import { expect, it, vi } from 'vitest';

const { order } = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../circuit-breaker.js', () => ({ enforceStartupBackoff: async () => {}, resetCircuitBreaker: () => {} }));
vi.mock('../db/connection.js', () => ({ initDb: async () => ({}) }));
vi.mock('../db/migrations/index.js', () => ({ runMigrations: async () => order.push('migrations') }));
vi.mock('../backfill-container-configs.js', () => ({ backfillContainerConfigs: async () => {} }));
vi.mock('../container-runner.js', () => ({ adoptRunningSessions: async () => order.push('adopt') }));
vi.mock('../drivers/index.js', () => ({ getSessionDriver: () => ({ ensureReady: async () => order.push('ready') }) }));
vi.mock('../host-instance.js', () => ({
  startHostInstanceLease: async () => order.push('lease-start'),
  stopHostInstanceLease: async () => order.push('lease-stop'),
}));
vi.mock('../delivery.js', () => ({
  startActiveDeliveryPoll: () => order.push('delivery-start'),
  startSweepDeliveryPoll: () => {},
  setDeliveryAdapter: () => {},
  stopDeliveryPolls: () => order.push('delivery-stop'),
}));
vi.mock('../host-sweep.js', () => ({
  startHostSweep: () => order.push('sweep-start'),
  stopHostSweep: () => order.push('sweep-stop'),
}));
vi.mock('../router.js', () => ({ routeInbound: async () => {} }));
vi.mock('../channels/channel-registry.js', () => ({
  initChannelAdapters: async () => {},
  teardownChannelAdapters: async () => order.push('channels-stop'),
  getChannelAdapter: () => undefined,
}));
vi.mock('../channels/chat-migration.js', () => ({ handleChatMigrated: async () => {} }));
vi.mock('../channels/index.js', () => ({}));
vi.mock('../modules/index.js', () => ({}));
vi.mock('../response-registry.js', () => ({ getResponseHandlers: () => [] }));
vi.mock('../host-lifecycle.js', () => ({
  startHostModules: async ({ signal }: { signal: AbortSignal }) => {
    expect(signal.aborted).toBe(false);
    signal.addEventListener('abort', () => order.push('modules-abort'));
    order.push('modules-start');
  },
  stopHostModules: async () => order.push('modules-stop'),
}));
vi.mock('../modules/scheduling/migrate-legacy-series.js', () => ({ migrateLegacySeries: () => {} }));

it('the embedded boot owns a durable lease before adoption and releases it after stopping reconciliation', async () => {
  const { _bootForHost, _shutdownForHost } = await import('./host-boot.js');
  await _bootForHost({ managedSignals: false });
  await _bootForHost({ managedSignals: false });
  expect(order).toEqual([
    'migrations',
    'ready',
    'lease-start',
    'adopt',
    'modules-start',
    'delivery-start',
    'sweep-start',
  ]);
  await _shutdownForHost('test');
  expect(order.slice(-6, -4)).toEqual(['modules-abort', 'modules-stop']);
  expect(order.slice(-4)).toEqual(['delivery-stop', 'sweep-stop', 'lease-stop', 'channels-stop']);
});
