import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  describe('deliver operations', () => {
    type Call = { method: string; args: unknown[] };

    function makeBridgeWithRecorder(): { bridge: ReturnType<typeof createChatSdkBridge>; calls: Call[] } {
      const calls: Call[] = [];
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({
          editMessage: async (...args: unknown[]) => {
            calls.push({ method: 'editMessage', args });
            return {} as never;
          },
          addReaction: async (...args: unknown[]) => {
            calls.push({ method: 'addReaction', args });
          },
          removeReaction: async (...args: unknown[]) => {
            calls.push({ method: 'removeReaction', args });
          },
          deleteMessage: async (...args: unknown[]) => {
            calls.push({ method: 'deleteMessage', args });
          },
          postMessage: async (...args: unknown[]) => {
            calls.push({ method: 'postMessage', args });
            return { id: 'posted-1' } as never;
          },
        }),
        supportsThreads: true,
      });
      return { bridge, calls };
    }

    it('routes operation: edit through adapter.editMessage', async () => {
      const { bridge, calls } = makeBridgeWithRecorder();
      await bridge.deliver('discord:g:c', null, {
        kind: 'chat',
        content: { operation: 'edit', messageId: 'm1', text: 'updated' },
      });
      expect(calls.map((c) => c.method)).toEqual(['editMessage']);
      expect(calls[0].args[1]).toBe('m1');
    });

    it('routes operation: reaction through adapter.addReaction', async () => {
      const { bridge, calls } = makeBridgeWithRecorder();
      await bridge.deliver('discord:g:c', null, {
        kind: 'chat',
        content: { operation: 'reaction', messageId: 'm1', emoji: '🤔' },
      });
      expect(calls).toEqual([{ method: 'addReaction', args: ['discord:g:c', 'm1', '🤔'] }]);
    });

    it('routes operation: remove_reaction through adapter.removeReaction', async () => {
      const { bridge, calls } = makeBridgeWithRecorder();
      await bridge.deliver('discord:g:c', null, {
        kind: 'chat',
        content: { operation: 'remove_reaction', messageId: 'm1', emoji: '🤔' },
      });
      expect(calls).toEqual([{ method: 'removeReaction', args: ['discord:g:c', 'm1', '🤔'] }]);
    });

    it('routes operation: delete through adapter.deleteMessage', async () => {
      const { bridge, calls } = makeBridgeWithRecorder();
      await bridge.deliver('discord:g:c', null, {
        kind: 'chat',
        content: { operation: 'delete', messageId: 'm1' },
      });
      expect(calls).toEqual([{ method: 'deleteMessage', args: ['discord:g:c', 'm1'] }]);
    });
  });

  describe('recoverMissedMessages', () => {
    it('returns 0 when called before setup (no setupConfig closure)', async () => {
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fetchMessages: (async () => ({ messages: [] })) as any,
          channelIdFromThreadId: (t: string) => t,
        }),
        supportsThreads: false,
      });
      const result = await bridge.recoverMissedMessages!({
        platformId: 'telegram:1',
        lookbackMs: 60_000,
        limit: 50,
      });
      expect(result).toEqual({ recoveredCount: 0 });
    });

    it('returns 0 when the underlying adapter has no fetchMessages', async () => {
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({
          channelIdFromThreadId: (t: string) => t,
        }),
        supportsThreads: false,
      });
      const result = await bridge.recoverMissedMessages!({
        platformId: 'telegram:1',
        lookbackMs: 60_000,
        limit: 50,
      });
      expect(result).toEqual({ recoveredCount: 0 });
    });

    // Replay-through-onInbound is covered end-to-end by the apps/optimus
    // channel-recovery test (Port #4), which drives a real CompositeAdapter
    // with a stub sub-adapter — `setupConfig` lives in the bridge's closure
    // so unit tests that bypass setup() can't exercise the replay path.
  });
});
