import { describe, expect, it } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge, htmlToMarkdown, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
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

  it('preserves URLs by splitting before them, not mid-link', () => {
    const head = 'A'.repeat(1900);
    const url = 'https://dashboard.teddyhwang.com/settings/integrations';
    const tail = ' continued sentence here.';
    const text = head + ' ' + url + tail;
    const out = splitForLimit(text, 2000);
    const urlChunk = out.find((c) => c.includes(url));
    expect(urlChunk).toBeDefined();
    const partials = out.filter((c) => c.includes('https') && !c.includes(url));
    expect(partials).toHaveLength(0);
  });

  it('closes and re-opens fenced code blocks across split boundaries', () => {
    const text = 'Intro\n\n```ts\n' + 'code line\n'.repeat(80) + '```\n';
    const out = splitForLimit(text, 200);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      const fenceCount = (chunk.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it('normalizes HTML before chunking', () => {
    const text = 'use <code>foo</code> in your code';
    const out = splitForLimit(text, 1000);
    expect(out[0]).toBe('use `foo` in your code');
  });
});

describe('htmlToMarkdown', () => {
  it('converts <code>X</code> to inline backtick markdown', () => {
    expect(htmlToMarkdown('use <code>foo</code> here')).toBe('use `foo` here');
  });

  it('converts <pre><code> blocks to fenced code', () => {
    expect(htmlToMarkdown('<pre><code>const x = 1</code></pre>')).toBe('\n```\nconst x = 1\n```\n');
  });

  it('converts <b>/<strong> to bold and <i>/<em> to italic', () => {
    expect(htmlToMarkdown('<b>x</b> <strong>y</strong>')).toBe('**x** **y**');
    expect(htmlToMarkdown('<i>x</i> <em>y</em>')).toBe('*x* *y*');
  });

  it('converts <a href> to markdown link', () => {
    expect(htmlToMarkdown('see <a href="https://example.com">site</a> now')).toBe(
      'see [site](https://example.com) now',
    );
  });

  it('converts <br> to newline', () => {
    expect(htmlToMarkdown('a<br>b<br/>c')).toBe('a\nb\nc');
  });

  it('drops unknown tags but keeps inner content', () => {
    expect(htmlToMarkdown('<span class="x">hello</span>')).toBe('hello');
  });

  it('preserves math/comparison < and >', () => {
    expect(htmlToMarkdown('a < b and 5 > 3')).toBe('a < b and 5 > 3');
  });

  it('handles HTML-tag-wrapped Discord mentions', () => {
    expect(htmlToMarkdown('<code><@Barret></code>')).toBe('`<@Barret>`');
  });

  it('idempotent on plain markdown', () => {
    const md = '**bold** and `code` and [link](https://example.com)';
    expect(htmlToMarkdown(md)).toBe(md);
  });

  it('safe on empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
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

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});
