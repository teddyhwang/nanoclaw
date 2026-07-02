import { describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import {
  createChatSdkBridge,
  createPollVoteDebouncer,
  enrichAttachments,
  htmlToMarkdown,
  isSelfAuthoredChatSdkMessage,
  parsePollVoteGatewayEvent,
  pollUpdateInbound,
  rawAttachmentsToSdkAttachments,
  RECOVERY_PER_PAGE_MAX,
  recoveryPageBudget,
  splitForLimit,
} from './chat-sdk-bridge.js';

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

describe('enrichAttachments', () => {
  it('fetches attachment bytes through fetchData and preserves metadata', async () => {
    const enriched = await enrichAttachments([
      {
        type: 'image',
        name: 'quoted-receipt.jpg',
        mimeType: 'image/jpeg',
        size: 10,
        width: 640,
        height: 480,
        fetchData: async () => Buffer.from('image-bytes'),
      },
    ]);

    expect(enriched).toEqual([
      {
        type: 'image',
        name: 'quoted-receipt.jpg',
        mimeType: 'image/jpeg',
        size: 10,
        width: 640,
        height: 480,
        data: Buffer.from('image-bytes').toString('base64'),
      },
    ]);
  });
});

describe('rawAttachmentsToSdkAttachments', () => {
  it('normalizes Discord raw voice attachments into audio attachments', () => {
    const out = rawAttachmentsToSdkAttachments({
      attachments: [
        {
          filename: 'voice-message.ogg',
          content_type: 'audio/ogg',
          size: 2447,
          url: 'https://cdn.discordapp.com/attachments/c/m/voice-message.ogg',
          duration_secs: 1.48,
          waveform: 'base64-waveform',
        },
      ],
    });

    expect(out).toEqual([
      {
        type: 'audio',
        name: 'voice-message.ogg',
        mimeType: 'audio/ogg',
        size: 2447,
        url: 'https://cdn.discordapp.com/attachments/c/m/voice-message.ogg',
      },
    ]);
  });

  it('returns no attachments for empty or malformed raw payloads', () => {
    expect(rawAttachmentsToSdkAttachments(undefined)).toEqual([]);
    expect(rawAttachmentsToSdkAttachments({ attachments: [] })).toEqual([]);
    expect(rawAttachmentsToSdkAttachments({ attachments: [null] })).toEqual([]);
  });

  it('normalizes forwarded Discord snapshot attachments', () => {
    const out = rawAttachmentsToSdkAttachments({
      message_snapshots: [
        {
          message: {
            attachments: [
              {
                filename: 'SKILL.md',
                content_type: 'text/markdown; charset=utf-8',
                size: 1024,
                url: 'https://cdn.discordapp.com/attachments/c/m/SKILL.md',
              },
            ],
          },
        },
      ],
    });

    expect(out).toEqual([
      {
        type: 'file',
        name: 'SKILL.md',
        mimeType: 'text/markdown; charset=utf-8',
        size: 1024,
        url: 'https://cdn.discordapp.com/attachments/c/m/SKILL.md',
      },
    ]);
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

    // The replay/cursor-walk loop body sits behind the
    // `if (!setupConfig) return` guard, so it isn't reachable without
    // driving the heavy setup() (real Chat + SqliteStateAdapter +
    // chat.initialize()). The high-risk regression — the Discord
    // limit>100 → 400 bug — lives entirely in the page-budget math,
    // which is extracted into the pure recoveryPageBudget() helper and
    // unit-tested directly below. The cursor-walk wiring itself is
    // exercised in production startup recovery.
  });

  describe('recoveryPageBudget', () => {
    it('clamps the page size to the Discord API max (100)', () => {
      // The actual bug: STARTUP_LIMIT was 200, Discord rejects >100 with
      // 400 code 50035 NUMBER_TYPE_MAX, so every startup recovery fetched
      // an out-of-range limit and recovered zero messages.
      expect(recoveryPageBudget(200).pageSize).toBe(100);
      expect(recoveryPageBudget(101).pageSize).toBe(100);
      expect(RECOVERY_PER_PAGE_MAX).toBe(100);
    });

    it('passes through in-range limits unchanged', () => {
      expect(recoveryPageBudget(100).pageSize).toBe(100);
      expect(recoveryPageBudget(50).pageSize).toBe(50);
      expect(recoveryPageBudget(1).pageSize).toBe(1);
    });

    it('floors a non-positive limit at one message per page', () => {
      expect(recoveryPageBudget(0).pageSize).toBe(1);
      expect(recoveryPageBudget(-5).pageSize).toBe(1);
    });

    it('budgets enough pages to cover the requested volume with slack', () => {
      // 200 wanted / 100 per page = 2 pages of content; +5 slack so a
      // clock-skewed or chatty window still terminates the walk.
      expect(recoveryPageBudget(200).maxPages).toBe(7);
      expect(recoveryPageBudget(100).maxPages).toBe(6);
      // Degenerate inputs still yield a finite, >=1 page budget so the
      // for-loop bound can never be 0/NaN.
      expect(recoveryPageBudget(0).maxPages).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(recoveryPageBudget(-5).maxPages)).toBe(true);
    });
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

describe('isSelfAuthoredChatSdkMessage', () => {
  // Regression for the spurious "[degraded — addressed turn produced no
  // output]" with no prompt/trigger (AI Friends, 2026-05-18). Chat-sdk
  // re-ingests the bot's own outbound as a chat-sdk inbound row; its
  // author carried { isMe: true, isBot: true } but the bridge never
  // surfaced isBotMessage, so the router's loopback gate missed it and a
  // reply-shaped self-message self-triggered an empty addressed turn.
  it('is true when the SDK marks the author as the connected client (isMe)', () => {
    expect(isSelfAuthoredChatSdkMessage({ isMe: true })).toBe(true);
  });

  it('is true when the author is flagged as the bot identity (isBot)', () => {
    expect(isSelfAuthoredChatSdkMessage({ isBot: true })).toBe(true);
  });

  it('is true for the exact live shape that caused the spurious degraded post', () => {
    // Verbatim from the AI Friends inbound row (seq 12): the bot's own
    // "My mistake — fixed…" reply bounced back through Discord chat-sdk.
    expect(isSelfAuthoredChatSdkMessage({ isMe: true, isBot: true })).toBe(true);
  });

  it('is false for a normal human message (no self/bot marker)', () => {
    expect(isSelfAuthoredChatSdkMessage({ isMe: false, isBot: false })).toBe(false);
    expect(isSelfAuthoredChatSdkMessage({})).toBe(false);
  });

  it('is false (never silently drops) when the marker is absent', () => {
    expect(isSelfAuthoredChatSdkMessage(undefined)).toBe(false);
    expect(isSelfAuthoredChatSdkMessage(null)).toBe(false);
  });
});

describe('parsePollVoteGatewayEvent', () => {
  const data = {
    user_id: 'u1',
    channel_id: 'c1',
    message_id: 'm1',
    guild_id: 'g1',
    answer_id: 2,
  };

  it('parses a vote-add event', () => {
    expect(parsePollVoteGatewayEvent('GATEWAY_MESSAGE_POLL_VOTE_ADD', data)).toEqual({
      guildId: 'g1',
      channelId: 'c1',
      messageId: 'm1',
      userId: 'u1',
      answerId: 2,
      added: true,
    });
  });

  it('parses a vote-remove event', () => {
    const vote = parsePollVoteGatewayEvent('GATEWAY_MESSAGE_POLL_VOTE_REMOVE', data);
    expect(vote?.added).toBe(false);
  });

  it('returns null for non-poll-vote event types', () => {
    expect(parsePollVoteGatewayEvent('GATEWAY_MESSAGE_CREATE', data)).toBeNull();
    expect(parsePollVoteGatewayEvent('GATEWAY_INTERACTION_CREATE', data)).toBeNull();
  });

  it('returns null when channel or message id is missing', () => {
    expect(parsePollVoteGatewayEvent('GATEWAY_MESSAGE_POLL_VOTE_ADD', { user_id: 'u1' })).toBeNull();
  });

  it('leaves guildId undefined for DM votes', () => {
    const vote = parsePollVoteGatewayEvent('GATEWAY_MESSAGE_POLL_VOTE_ADD', {
      user_id: 'u1',
      channel_id: 'c1',
      message_id: 'm1',
    });
    expect(vote?.guildId).toBeUndefined();
  });
});

describe('pollUpdateInbound', () => {
  const vote = { guildId: 'g1', channelId: 'c1', messageId: 'm1', userId: 'u1', answerId: 1, added: true };

  it('builds an accumulate-only inbound with a content-addressed id', () => {
    const { channelThreadId, inbound } = pollUpdateInbound(
      'discord',
      vote,
      { text: '📊 Poll: lunch?\n- pizza: 2 votes', sender: 'Teddy', senderId: 'u9' },
      '2026-06-09T12:00:00.000Z',
    );
    expect(channelThreadId).toBe('discord:g1:c1');
    expect(inbound.kind).toBe('chat-sdk');
    expect(inbound.isBackfill).toBe(true);
    expect(inbound.isMention).toBe(false);
    expect(inbound.id.startsWith('m1:pollupdate:')).toBe(true);
    const content = inbound.content as Record<string, unknown>;
    expect(content.text).toContain('pizza');
    expect(content.sender).toBe('Teddy');
    expect(content.senderName).toBe('Teddy');
    expect(content.senderId).toBe('u9');
  });

  it('produces the SAME id for identical poll state and a different id when state changes', () => {
    const a = pollUpdateInbound('discord', vote, { text: 'state A' }, 't1').inbound.id;
    const b = pollUpdateInbound('discord', vote, { text: 'state A' }, 't2').inbound.id;
    const c = pollUpdateInbound('discord', vote, { text: 'state B' }, 't1').inbound.id;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('createPollVoteDebouncer', () => {
  const guildVote = (messageId: string) => ({
    guildId: 'g1',
    channelId: 'c1',
    messageId,
    userId: 'u1',
    answerId: 1,
    added: true,
  });

  it('collapses a burst of votes on one poll into a single trailing flush', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      const d = createPollVoteDebouncer(1000, async (v) => {
        flushed.push(v.messageId);
      });
      d.onVote(guildVote('m1'));
      d.onVote(guildVote('m1'));
      d.onVote(guildVote('m1'));
      await vi.advanceTimersByTimeAsync(999);
      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(flushed).toEqual(['m1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces per poll message — two polls flush independently', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      const d = createPollVoteDebouncer(1000, async (v) => {
        flushed.push(v.messageId);
      });
      d.onVote(guildVote('m1'));
      d.onVote(guildVote('m2'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(flushed.sort()).toEqual(['m1', 'm2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops DM votes (no guildId)', async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[] = [];
      const d = createPollVoteDebouncer(1000, async (v) => {
        flushed.push(v.messageId);
      });
      d.onVote({ channelId: 'c1', messageId: 'm1', userId: 'u1', added: true });
      await vi.advanceTimersByTimeAsync(2000);
      expect(flushed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains flush rejections (no unhandled rejection) and clear() cancels pending timers', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const d = createPollVoteDebouncer(1000, async () => {
        calls++;
        throw new Error('rest fetch failed');
      });
      d.onVote(guildVote('m1'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(1);

      d.onVote(guildVote('m2'));
      d.clear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
