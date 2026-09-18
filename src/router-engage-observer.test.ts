/**
 * The engage-decision observer seam.
 *
 * The contract is that an observer is purely passive: it sees the live
 * verdict and cannot change it, delay it, or break delivery by failing. A
 * host uses this to score an alternative engage strategy (a classifier)
 * against the real regex/mention decision on production traffic BEFORE
 * anything is allowed to gate on it.
 *
 * Exercised through the REAL routeInbound path, so the assertions cover the
 * verdict the router actually acted on rather than a direct call to
 * evaluateEngage.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-engage-observer' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { registerEngageObserver, routeInbound, type EngageObservation } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-engage-observer';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: true,
    unknownSenderPolicy: 'public',
  },
  group: {
    engageMode: 'mention-sticky',
    threads: true,
    unknownSenderPolicy: 'public',
  },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', {
    factory: () => makeAdapter(),
    defaults: channelDefaults,
  });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

/**
 * `engage_mode: 'mention'` gives us a wiring whose verdict actually varies
 * with the inbound — a pattern:'.' wiring engages unconditionally and could
 * not distinguish a reported verdict from a hardcoded `true`.
 */
async function seedMentionWiring(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(id: string, text: string, opts: { isMention?: boolean } = {}): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text }),
      timestamp: now(),
      isMention: opts.isMention ?? false,
      isGroup: true,
    },
  });
}

/** Let the fire-and-forget observer microtasks drain before asserting. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const unsubscribers: (() => void)[] = [];

function observe(fn: (obs: EngageObservation) => void | Promise<void>): void {
  unsubscribers.push(registerEngageObserver(fn));
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
});

afterEach(async () => {
  while (unsubscribers.length) unsubscribers.pop()!();
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('engage observer', () => {
  it('reports the live verdict and its inputs for an engaging message', async () => {
    const seen: EngageObservation[] = [];
    observe((obs) => {
      seen.push(obs);
    });
    await activate();
    await seedMentionWiring();

    await inbound('m1', 'hey agent, book a tee time', { isMention: true });
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0].engaged).toBe(true);
    expect(seen[0].isMention).toBe(true);
    expect(seen[0].isReaction).toBe(false);
    expect(seen[0].text).toContain('book a tee time');
    expect(seen[0].agent.id).toBe('mga-1');
    expect(seen[0].agent.engage_mode).toBe('mention');
    expect(seen[0].messagingGroup.id).toBe('mg-1');
    expect(seen[0].event.message.id).toBe('m1');
  });

  it('reports engaged=false for a non-engaging message, so misses are measurable', async () => {
    const seen: EngageObservation[] = [];
    observe((obs) => {
      seen.push(obs);
    });
    await activate();
    await seedMentionWiring();

    // No mention on a 'mention' wiring — the router accumulates instead.
    await inbound('m1', 'just chatting with someone else');
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0].engaged).toBe(false);
    expect(seen[0].isMention).toBe(false);
  });

  it('cannot veto: a throwing observer leaves the engage decision intact', async () => {
    const seen: EngageObservation[] = [];
    observe(() => {
      throw new Error('observer exploded');
    });
    observe((obs) => {
      seen.push(obs);
    });
    await activate();
    await seedMentionWiring();

    // Must not reject — routeInbound swallows observer failures.
    await expect(inbound('m1', 'hey agent', { isMention: true })).resolves.toBeUndefined();
    await flush();

    // The surviving observer still ran and still saw the true verdict.
    expect(seen).toHaveLength(1);
    expect(seen[0].engaged).toBe(true);
  });

  it('cannot veto: a rejecting async observer leaves routing intact', async () => {
    observe(async () => {
      throw new Error('async observer exploded');
    });
    await activate();
    await seedMentionWiring();

    await expect(inbound('m1', 'hey agent', { isMention: true })).resolves.toBeUndefined();
    await flush();
  });

  it('does not await a slow observer', async () => {
    let released = false;
    observe(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            released = true;
            resolve();
          }, 5_000);
        }),
    );
    await activate();
    await seedMentionWiring();

    await inbound('m1', 'hey agent', { isMention: true });

    // routeInbound returned while the observer is still pending — proof the
    // probe can never add its latency to message delivery.
    expect(released).toBe(false);
  });

  it('stops reporting after unsubscribe', async () => {
    const seen: EngageObservation[] = [];
    const off = registerEngageObserver((obs) => {
      seen.push(obs);
    });
    await activate();
    await seedMentionWiring();

    await inbound('m1', 'hey agent', { isMention: true });
    await flush();
    expect(seen).toHaveLength(1);

    off();
    await inbound('m2', 'hey agent again', { isMention: true });
    await flush();
    expect(seen).toHaveLength(1);
  });
});
