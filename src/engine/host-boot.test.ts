import { expect, it, vi } from 'vitest';
import type { ChannelAdapter, ChannelSetup } from '../channels/adapter.js';

const { order, routed, responses, setups } = vi.hoisted(() => ({
  order: [] as string[],
  routed: vi.fn(),
  responses: vi.fn(async () => true),
  setups: [] as ChannelSetup[],
}));
vi.mock('../circuit-breaker.js', () => ({ enforceStartupBackoff: async () => {}, resetCircuitBreaker: () => {} }));
vi.mock('../db/connection.js', () => ({ initDb: async () => ({}) }));
vi.mock('../db/migrations/index.js', () => ({ runMigrations: async () => order.push('migrations') }));
vi.mock('../backfill-container-configs.js', () => ({ backfillContainerConfigs: async () => {} }));
vi.mock('../container-runner.js', () => ({
  adoptRunningSessions: async () => {
    expect(routed).not.toHaveBeenCalled();
    order.push('adopt');
  },
  abortGatewaySessionObservers: async () => order.push('gateway-detach'),
  resumeGatewaySessionAdmission: vi.fn(),
  stopGatewaySessionsForUnavailability: vi.fn(),
}));
vi.mock('../gateway-approval-coordinator.js', () => ({
  startGatewayApprovalCoordinator: async () => order.push('gateway-ready'),
  stopGatewayApprovalCoordinator: async () => order.push('gateway-stop'),
}));
vi.mock('../gateway-availability.js', () => ({ startGatewayAvailabilityMonitor: async () => () => {} }));
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
vi.mock('../router.js', () => ({ routeInbound: async (event: unknown) => routed(event) }));
vi.mock('../channels/channel-registry.js', () => ({
  initChannelAdapters: async (factory: (adapter: ChannelAdapter) => ChannelSetup) => {
    const setup = factory({ channelType: 'discord', instance: 'bot-one' } as ChannelAdapter);
    setups.push(setup);
    void setup.onInbound('room', 'thread', {
      id: 'm1',
      kind: 'chat',
      content: { text: 'hello' },
      timestamp: '2026-09-25T12:00:00Z',
      isBackfill: true,
    });
    await Promise.resolve();
    expect(routed).not.toHaveBeenCalled();
  },
  teardownChannelAdapters: async () => order.push('channels-stop'),
  getChannelAdapterExact: () => undefined,
}));
vi.mock('../channels/chat-migration.js', () => ({ handleChatMigrated: async () => {} }));
vi.mock('../channels/index.js', () => ({}));
vi.mock('../modules/index.js', () => ({}));
vi.mock('../response-registry.js', () => ({ getResponseHandlers: () => [responses] }));
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
    'gateway-ready',
    'adopt',
    'modules-start',
    'delivery-start',
    'sweep-start',
  ]);
  expect(routed).toHaveBeenCalledWith(
    expect.objectContaining({ instance: 'bot-one', message: expect.objectContaining({ isBackfill: true }) }),
  );
  setups[0].onAction('approval', 'approve', 'user', { messageId: 'card', platformId: 'room', threadId: 'thread' });
  await Promise.resolve();
  expect(responses).toHaveBeenCalledWith(
    expect.objectContaining({ instance: 'bot-one', messageId: 'card', platformId: 'room', threadId: 'thread' }),
  );
  await _shutdownForHost('test');
  expect(order).toEqual(expect.arrayContaining(['modules-abort', 'gateway-stop', 'gateway-detach', 'modules-stop']));
  expect(order.indexOf('gateway-stop')).toBeLessThan(order.indexOf('modules-stop'));
  expect(order.slice(-4)).toEqual(['delivery-stop', 'sweep-stop', 'lease-stop', 'channels-stop']);
});
