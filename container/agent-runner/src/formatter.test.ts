/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages, type MessageInRow } from './db/messages-in.js';
import {
  formatMessages,
  stripInternalTags,
  extractMessageSender,
  pickInReplyToMessage,
  extractRouting,
  extractImageAttachments,
  formatAttachments,
  isAddressedTurn,
} from './formatter.js';
import { TIMEZONE } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, kind: string, content: object, opts?: { timestamp?: string }) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the first <message> block when multiple are present', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const firstMsgIdx = result.indexOf('<message ');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThan(ctxIdx);
  });
});

describe('multi-message chat batches', () => {
  // Regression guard for #2555: an outer `<messages>` envelope around
  // multiple chat messages caused the Claude Agent SDK to emit a synthetic
  // `No response requested.` stub instead of calling the API. Each
  // `<message>` block is self-contained; concatenating them is enough.
  it('does NOT wrap multiple chat messages in an outer <messages> envelope', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('<messages>');
    expect(result).not.toContain('</messages>');
  });

  it('emits one <message> block per inbound row, in order', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'first' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'second' });
    insertMessage('m3', 'chat', { sender: 'Carol', text: 'third' });
    const result = formatMessages(getPendingMessages());
    const matches = result.match(/<message [^>]*>/g) ?? [];
    expect(matches.length).toBe(3);
    const firstIdx = result.indexOf('first');
    const secondIdx = result.indexOf('second');
    const thirdIdx = result.indexOf('third');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob" message_id="42">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('uses replyTo.messageId when the host stores Discord reply IDs there', () => {
    insertMessage('m1', 'chat', {
      sender: 'Teddy',
      text: 'track that headcount',
      replyTo: {
        messageId: '1511352887429693580',
        sender: 'William Yoo',
        text: 'Thumbs up if you in',
      },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="1511352887429693580"');
    expect(result).toContain(
      '<quoted_message from="William Yoo" message_id="1511352887429693580">Thumbs up if you in</quoted_message>',
    );
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });

  it('renders mine="true" on quoted_message when replyTo.toBot is set by the host', () => {
    insertMessage('m1', 'chat', {
      sender: 'Teddy',
      text: 'I meant the Tico calendar',
      replyTo: {
        id: '42',
        sender: 'Optimus',
        text: 'Hey Teddy — I searched...',
        toBot: true,
      },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(
      '<quoted_message from="Optimus" message_id="42" mine="true">Hey Teddy — I searched...</quoted_message>',
    );
  });

  it('omits mine attribute when replyTo.toBot is not set (regular pill-reply to a peer)', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'agree',
      replyTo: { id: '42', sender: 'Bob', text: 'Anyone in?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<quoted_message from="Bob" message_id="42">Anyone in?</quoted_message>');
    expect(result).not.toContain('mine="true"');
  });

  // H-D2: deeper reply ancestors embedded in replyTo.ancestors render as
  // stacked <quoted_message depth="N"> blocks, oldest-first, above the
  // direct parent — so a multi-level thread reads top-down and survives
  // session rotation (the chain is in the row, not the prompt window).
  it('renders ancestors[] as stacked quoted_message depth blocks, oldest-first', () => {
    insertMessage('m1', 'chat', {
      sender: 'Carol',
      text: 'so what do we do?',
      replyTo: {
        id: '7',
        sender: 'Bob',
        text: 'I think we should ship',
        ancestors: [
          { messageId: '6', sender: 'Dave', text: 'the deadline is friday' }, // grandparent (depth 2)
          { messageId: '5', sender: 'Erin', text: 'who owns this?' }, // great-grand (depth 3)
        ],
      },
    });
    const result = formatMessages(getPendingMessages());
    // Oldest ancestor first, deepest depth.
    expect(result).toContain('<quoted_message from="Erin" message_id="5" depth="3">who owns this?</quoted_message>');
    expect(result).toContain(
      '<quoted_message from="Dave" message_id="6" depth="2">the deadline is friday</quoted_message>',
    );
    // Direct parent labelled depth 1 when ancestors are present.
    expect(result).toContain(
      '<quoted_message from="Bob" message_id="7" depth="1">I think we should ship</quoted_message>',
    );
    // Chronological top-down order: Erin (oldest) → Dave → Bob (parent).
    const erinIdx = result.indexOf('who owns this?');
    const daveIdx = result.indexOf('the deadline is friday');
    const bobIdx = result.indexOf('I think we should ship');
    expect(erinIdx).toBeGreaterThan(0);
    expect(daveIdx).toBeGreaterThan(erinIdx);
    expect(bobIdx).toBeGreaterThan(daveIdx);
  });

  it('does not add depth attribute when there are no ancestors (depth-1 unchanged)', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ok',
      replyTo: { id: '9', sender: 'Bob', text: 'ready?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<quoted_message from="Bob" message_id="9">ready?</quoted_message>');
    expect(result).not.toContain('depth=');
  });

  it('preserves mine="true" on the parent block alongside ancestors', () => {
    insertMessage('m1', 'chat', {
      sender: 'Teddy',
      text: 'continue',
      replyTo: {
        id: '5',
        sender: 'Optimus',
        text: 'here is the plan',
        toBot: true,
        ancestors: [{ sender: 'Teddy', text: 'draft a plan' }],
      },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<quoted_message from="Teddy" depth="2">draft a plan</quoted_message>');
    expect(result).toContain(
      '<quoted_message from="Optimus" message_id="5" mine="true" depth="1">here is the plan</quoted_message>',
    );
  });

  it('skips malformed ancestor entries (missing sender/text)', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'hm',
      replyTo: {
        id: '3',
        sender: 'Bob',
        text: 'parent',
        ancestors: [
          { sender: 'Dave' }, // no text
          { text: 'orphan text' }, // no sender
          { sender: 'Erin', text: 'valid one' },
        ],
      },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('valid one');
    expect(result).not.toContain('orphan text');
    // Only the one valid ancestor + the parent = 2 quoted_message blocks.
    expect(result.match(/<quoted_message/g)?.length).toBe(2);
  });

  it('XML-escapes ancestor sender and text', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'x',
      replyTo: {
        id: '3',
        sender: 'Bob',
        text: 'parent',
        ancestors: [{ sender: 'A&B', text: '<script>"hi"</script>' }],
      },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A&amp;B"');
    expect(result).toContain('&lt;script&gt;&quot;hi&quot;&lt;/script&gt;');
  });
});

describe('sender attribute precedence', () => {
  it('prefers senderName over sender (raw platform id)', () => {
    insertMessage('m1', 'chat', {
      sender: '255593654804579@lid',
      senderName: 'Janice Kimchi',
      text: 'hi',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="Janice Kimchi"');
    expect(result).not.toContain('sender="255593654804579@lid"');
  });

  it('falls back to sender when senderName is absent', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="Alice"');
  });

  it('prefers author.fullName over sender when senderName is absent', () => {
    insertMessage('m1', 'chat', {
      sender: 'raw-id',
      author: { fullName: 'Author Full' },
      text: 'hi',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="Author Full"');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe('The answer is 42');
  });
});

describe('extractMessageSender', () => {
  it('returns namespaced sender for chat-sdk content with author.userId', () => {
    insertMessage('m1', 'chat-sdk', { author: { userId: '123' } });
    const msgs = getPendingMessages();
    const m = msgs.find((m) => m.id === 'm1')!;
    m.channel_type = 'discord';
    expect(extractMessageSender(m)).toBe('discord:123');
  });

  it('returns already-namespaced senderId untouched', () => {
    insertMessage('m1', 'chat', { senderId: 'discord:@me:abc' });
    const msgs = getPendingMessages();
    const m = msgs.find((m) => m.id === 'm1')!;
    expect(extractMessageSender(m)).toBe('discord:@me:abc');
  });

  it('returns null when no sender info is present', () => {
    insertMessage('m1', 'chat', { text: 'hi' });
    const msgs = getPendingMessages();
    const m = msgs.find((m) => m.id === 'm1')!;
    expect(extractMessageSender(m)).toBeNull();
  });

  it('returns null when content is malformed JSON', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m-bad', 'chat', ?, 'pending', 'not-json')`,
      )
      .run(new Date().toISOString());
    const msgs = getPendingMessages();
    const m = msgs.find((m) => m.id === 'm-bad')!;
    expect(extractMessageSender(m)).toBeNull();
  });
});

describe('pickInReplyToMessage', () => {
  // Build a minimal MessageInRow inline. The function only inspects `id`
  // and `trigger`, so other fields are stub values.
  function row(id: string, trigger: 0 | 1, seq: number, kind: string = 'chat-sdk'): MessageInRow {
    return {
      id,
      seq,
      kind,
      timestamp: '2026-05-09T20:36:00.000Z',
      status: 'pending',
      process_after: null,
      recurrence: null,
      series_id: null,
      tries: 0,
      trigger,
      platform_id: 'discord:1158397269079506955:1192937484582142012',
      channel_type: 'discord',
      thread_id: null,
      content: '{}',
    };
  }

  it('returns null on empty batch', () => {
    expect(pickInReplyToMessage([])).toBeNull();
  });

  it('picks the only trigger=1 row when batch has one trigger', () => {
    const m = pickInReplyToMessage([row('a', 1, 64)]);
    expect(m?.id).toBe('a');
  });

  it('picks the newest trigger=1 row, skipping a newer trigger=0', () => {
    // Caller passes seq DESC, so newer rows come first. The function must
    // walk the array (in order) and pick the first trigger=1, skipping
    // the trigger=0 drive-by ("Sorta") that arrived between a question
    // and the agent's reply.
    const messages = [
      row('sorta', 0, 66), // newest, but a non-trigger drive-by
      row('question', 1, 64), // older but the actual @mention/reply-to-bot
      row('context', 0, 62), // older still, accumulate-only
    ];
    const m = pickInReplyToMessage(messages);
    expect(m?.id).toBe('question');
  });

  it('returns null when no trigger=1 row is present', () => {
    // A batch of only trigger=0 rows means the agent woke for some other
    // reason (a task fire) and these rows are accumulate-only context.
    // The reply pill must NOT point at any of them — null is the
    // authoritative "no pill" signal. (Old behavior fell back to the
    // newest row, which is the AI-Friends RSS reply-pill regression.)
    const messages = [row('latest', 0, 70), row('older', 0, 68)];
    expect(pickInReplyToMessage(messages)).toBeNull();
  });

  it('handles a mix where multiple trigger=1 rows exist', () => {
    // When two trigger=1 rows are in the batch (both real engages), the
    // newest wins — that's the agent's most recent reason to be active.
    const messages = [row('newer-mention', 1, 70), row('drive-by', 0, 68), row('older-mention', 1, 64)];
    const m = pickInReplyToMessage(messages);
    expect(m?.id).toBe('newer-mention');
  });

  it('returns null for a task row + a trigger=0 accumulated chat row', () => {
    // The live AI-Friends RSS regression (2026-05-21 in #ai): a recurring
    // task fired while a human's earlier trigger=0 message sat accumulated
    // in the same batch. The task row is correctly excluded — but the old
    // `trigger ?? chatLike[0]` fallback then picked the human's
    // non-trigger message, so the RSS/status post reply-pilled onto it.
    // A trigger=0 chat row is NOT a valid reply target: null.
    const messages = [
      row('t-task', 1, 70, 'task'),
      row('m-chat-old', 0, 64), // accumulated chat, trigger=0
    ];
    expect(pickInReplyToMessage(messages)).toBeNull();
  });

  it('returns null when batch has only task rows', () => {
    const messages = [row('t-task-1', 1, 70, 'task'), row('t-task-2', 1, 68, 'task')];
    const m = pickInReplyToMessage(messages);
    expect(m).toBeNull();
  });

  it('picks a real chat trigger over a task row', () => {
    const messages = [row('t-task', 1, 80, 'task'), row('m-mention', 1, 72), row('m-context', 0, 64)];
    const m = pickInReplyToMessage(messages);
    expect(m?.id).toBe('m-mention');
  });

  it('extractRouting uses the triggering row channel, not the first accumulated context row', () => {
    const messages = [
      {
        ...row('ai-context', 0, 80),
        platform_id: 'discord:guild:ai-friends',
        thread_id: 'discord:guild:ai-friends',
      },
      {
        ...row('general-trigger', 1, 78),
        platform_id: 'discord:guild:general',
        thread_id: 'discord:guild:general',
      },
    ];

    expect(extractRouting(messages)).toEqual({
      platformId: 'discord:guild:general',
      channelType: 'discord',
      threadId: 'discord:guild:general',
      inReplyTo: 'general-trigger',
    });
  });

  it('matches the boysnight repro: question + Sorta drive-by', () => {
    // Live failure shape from 2026-05-09 ~8:36 PM ET in boys-night:
    // - seq 60 trigger=1 (Teddy's @Optimus question — earlier turn, completed)
    // - seq 64 trigger=1 ("What makes you think I'm busy on June 19?")
    // - seq 66 trigger=0 ("Sorta" — drive-by reply to mackchiu, no @mention)
    // The agent's correction reply should land on seq 64, not seq 66.
    const messages = [row('seq66-sorta', 0, 66), row('seq64-question', 1, 64)];
    const m = pickInReplyToMessage(messages);
    expect(m?.id).toBe('seq64-question');
  });
});

describe('extractImageAttachments', () => {
  function row(id: string, content: object): MessageInRow {
    return {
      id,
      seq: 1,
      kind: 'chat-sdk',
      timestamp: '2026-05-09T20:00:00.000Z',
      status: 'pending',
      process_after: null,
      recurrence: null,
      series_id: null,
      tries: 0,
      trigger: 1,
      platform_id: 'discord:abc',
      channel_type: 'discord',
      thread_id: null,
      content: JSON.stringify(content),
    };
  }

  it('returns empty array on no attachments', () => {
    expect(extractImageAttachments([row('a', { text: 'hi' })])).toEqual([]);
  });

  it('extracts a single image with localPath and accepted mediaType', () => {
    const refs = extractImageAttachments([
      row('msg1', {
        text: 'see attached',
        attachments: [
          {
            type: 'image',
            name: 'screenshot.png',
            mimeType: 'image/png',
            localPath: 'inbox/msg1/screenshot.png',
            size: 12345,
          },
        ],
      }),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      messageId: 'msg1',
      name: 'screenshot.png',
      absolutePath: '/workspace/inbox/msg1/screenshot.png',
      mediaType: 'image/png',
    });
  });

  it('skips attachments without localPath (download failed host-side)', () => {
    expect(
      extractImageAttachments([
        row('msg1', {
          attachments: [
            {
              type: 'image',
              name: 'broken.png',
              mimeType: 'image/png',
              size: 100,
              // no localPath
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it('skips non-image attachment types', () => {
    expect(
      extractImageAttachments([
        row('msg1', {
          attachments: [
            { type: 'file', name: 'doc.pdf', localPath: 'inbox/msg1/doc.pdf' },
            { type: 'video', name: 'clip.mp4', localPath: 'inbox/msg1/clip.mp4' },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it('normalizes image/jpg → image/jpeg', () => {
    const refs = extractImageAttachments([
      row('msg1', {
        attachments: [
          {
            type: 'image',
            name: 'photo.jpg',
            mimeType: 'image/jpg',
            localPath: 'inbox/msg1/photo.jpg',
          },
        ],
      }),
    ]);
    expect(refs[0].mediaType).toBe('image/jpeg');
  });

  it('drops images with unsupported mediaType (e.g. heic)', () => {
    expect(
      extractImageAttachments([
        row('msg1', {
          attachments: [
            {
              type: 'image',
              name: 'photo.heic',
              mimeType: 'image/heic',
              localPath: 'inbox/msg1/photo.heic',
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it('handles multiple messages with multiple images', () => {
    const refs = extractImageAttachments([
      row('msg1', {
        attachments: [
          { type: 'image', name: 'a.png', mimeType: 'image/png', localPath: 'inbox/msg1/a.png' },
          { type: 'image', name: 'b.jpg', mimeType: 'image/jpeg', localPath: 'inbox/msg1/b.jpg' },
        ],
      }),
      row('msg2', {
        attachments: [{ type: 'image', name: 'c.gif', mimeType: 'image/gif', localPath: 'inbox/msg2/c.gif' }],
      }),
    ]);
    expect(refs.map((r) => r.name)).toEqual(['a.png', 'b.jpg', 'c.gif']);
    expect(refs.map((r) => r.messageId)).toEqual(['msg1', 'msg1', 'msg2']);
  });

  it('handles malformed JSON content gracefully', () => {
    const m: MessageInRow = {
      id: 'bad',
      seq: 1,
      kind: 'chat-sdk',
      timestamp: '2026-05-09T20:00:00.000Z',
      status: 'pending',
      process_after: null,
      recurrence: null,
      series_id: null,
      tries: 0,
      trigger: 1,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: 'not-json',
    };
    expect(extractImageAttachments([m])).toEqual([]);
  });
});

describe('formatAttachments — text inlining', () => {
  it('inlines decoded text from att.data (chat-sdk-bridge path)', () => {
    const text = 'hello world\nline two';
    const out = formatAttachments([
      {
        type: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        data: Buffer.from(text, 'utf8').toString('base64'),
      },
    ]);
    expect(out).toContain('[Attached file content: notes.txt]');
    expect(out).toContain('<attached_file name="notes.txt"');
    expect(out).toContain('hello world\nline two');
    expect(out).toContain('</attached_file>');
  });

  it('inlines from disk via localPath (native-adapter path)', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const pathMod = require('path') as typeof import('path');
    const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fmt-test-'));
    const abs = pathMod.join(tmpDir, 'data.csv');
    fs.writeFileSync(abs, 'a,b,c\n1,2,3\n');
    try {
      const out = formatAttachments([
        {
          type: 'file',
          name: 'data.csv',
          mimeType: 'text/csv',
          // Absolute localPath bypasses the `/workspace/` prefix.
          localPath: abs,
        },
      ]);
      expect(out).toContain('[Attached file content: data.csv]');
      expect(out).toContain('a,b,c');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('inlines a WA documentMessage shape: localPath + Baileys mimetype, no data', () => {
    // WhatsApp's native adapter writes the file to disk and reports
    // `mimetype` from Baileys' documentMessage. The agent should see the
    // bytes inline rather than a bare marker, even when the upload's
    // filename has no recognizable extension.
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const pathMod = require('path') as typeof import('path');
    const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fmt-wa-test-'));
    const abs = pathMod.join(tmpDir, 'meeting-notes');
    fs.writeFileSync(abs, 'topic: standup\nattendees: 3\n');
    try {
      const out = formatAttachments([
        {
          type: 'document',
          name: 'meeting-notes',
          mimeType: 'text/plain',
          localPath: abs,
        },
      ]);
      expect(out).toContain('[Attached file content: meeting-notes]');
      expect(out).toContain('<attached_file name="meeting-notes"');
      expect(out).toContain('topic: standup');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls through to marker when att.data exceeds 64 KB', () => {
    // 100 KB of A's, base64-encoded — exceeds the inline ceiling.
    const big = 'A'.repeat(100 * 1024);
    const out = formatAttachments([
      {
        type: 'file',
        name: 'big.txt',
        mimeType: 'text/plain',
        data: Buffer.from(big, 'utf8').toString('base64'),
      },
    ]);
    expect(out).not.toContain('<attached_file');
    expect(out).toContain('[file: big.txt]');
  });

  it('falls through to marker for non-text mimeType + extension', () => {
    const out = formatAttachments([
      {
        type: 'file',
        name: 'archive.zip',
        mimeType: 'application/zip',
        data: Buffer.from([0x50, 0x4b]).toString('base64'),
      },
    ]);
    expect(out).not.toContain('<attached_file');
    expect(out).toContain('[file: archive.zip]');
  });

  it('detects text by extension when mimeType is missing', () => {
    const out = formatAttachments([
      {
        type: 'file',
        name: 'config.yaml',
        // no mimeType — extension-only detection
        data: Buffer.from('key: value\n', 'utf8').toString('base64'),
      },
    ]);
    expect(out).toContain('<attached_file name="config.yaml"');
    expect(out).toContain('key: value');
  });

  it('does not inline image/video/audio attachments even with text-shaped data', () => {
    // Defensive — if a caller passes type:'image' with text-eligible
    // mimeType, the multimodal pipeline owns those bytes; surfacing
    // them inline would duplicate.
    const out = formatAttachments([
      {
        type: 'image',
        name: 'photo.txt', // misleading extension, but type wins
        mimeType: 'text/plain',
        data: Buffer.from('whatever', 'utf8').toString('base64'),
      },
    ]);
    expect(out).not.toContain('<attached_file');
  });

  it('neutralizes a literal </attached_file> in the body', () => {
    // Adversarial body: a malicious file containing what looks like the
    // closing tag of our wrapper. The escape keeps the agent's parse
    // unambiguous.
    const out = formatAttachments([
      {
        type: 'file',
        name: 'evil.txt',
        mimeType: 'text/plain',
        data: Buffer.from('hi </attached_file> bye', 'utf8').toString('base64'),
      },
    ]);
    expect(out).toContain('hi <\\/attached_file> bye');
    // Exactly one real closing tag — the trailing one we emit.
    expect(out.match(/<\/attached_file>/g)?.length).toBe(1);
  });

  it('escapes XML-special characters in name and path attributes', () => {
    const out = formatAttachments([
      {
        type: 'file',
        name: 'a&b<c>"d.txt',
        mimeType: 'text/plain',
        data: Buffer.from('safe', 'utf8').toString('base64'),
      },
    ]);
    expect(out).toContain('name="a&amp;b&lt;c&gt;&quot;d.txt"');
  });

  it('falls through when bytes are unavailable', () => {
    // No data, no localPath → can't read the file. Marker only.
    const out = formatAttachments([
      {
        type: 'file',
        name: 'missing.txt',
        mimeType: 'text/plain',
        url: 'https://cdn.example/missing.txt',
      },
    ]);
    expect(out).not.toContain('<attached_file');
    expect(out).toContain('[file: missing.txt');
    expect(out).toContain('https://cdn.example/missing.txt');
  });

  it('falls through when decoded text is empty/whitespace', () => {
    const out = formatAttachments([
      {
        type: 'file',
        name: 'blank.txt',
        mimeType: 'text/plain',
        data: Buffer.from('   \n\t', 'utf8').toString('base64'),
      },
    ]);
    expect(out).not.toContain('<attached_file');
  });

  it('renders multiple attachments independently — mix of inlined + marker-only', () => {
    const out = formatAttachments([
      {
        type: 'file',
        name: 'small.json',
        mimeType: 'application/json',
        data: Buffer.from('{"k":1}', 'utf8').toString('base64'),
      },
      {
        type: 'image',
        name: 'pic.png',
        mimeType: 'image/png',
        localPath: 'inbox/m/pic.png',
      },
    ]);
    expect(out).toContain('<attached_file name="small.json"');
    expect(out).toContain('{"k":1}');
    expect(out).toContain('[image: pic.png — saved to /workspace/inbox/m/pic.png]');
    // Image marker should NOT be wrapped in attached_file.
    expect(out.match(/<attached_file/g)?.length).toBe(1);
  });

  it('surfaces a host-computed videoMarker for video attachments', () => {
    const out = formatAttachments([
      {
        type: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        localPath: 'inbox/m/clip.mp4',
        videoMarker: '[Video: hello there | Summary: a cat jumps off a table]',
      },
    ]);
    expect(out).toContain('[video: clip.mp4 — saved to /workspace/inbox/m/clip.mp4]');
    expect(out).toContain('[Video: hello there | Summary: a cat jumps off a table]');
    // Frames flow separately via extractImageAttachments, not inlined here.
    expect(out).not.toContain('<attached_file');
  });

  it('falls back to transcript/summary fields when no videoMarker present', () => {
    const out = formatAttachments([
      {
        type: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        localPath: 'inbox/m/clip.mp4',
        transcript: 'spoken words',
        summary: 'someone waves',
      },
    ]);
    expect(out).toContain('[Video: spoken words]');
    expect(out).toContain('[Video Summary: someone waves]');
  });

  it('emits only the base marker for an unprocessed video (no transcript/summary)', () => {
    const out = formatAttachments([
      {
        type: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        localPath: 'inbox/m/clip.mp4',
      },
    ]);
    expect(out.trim()).toBe('[video: clip.mp4 — saved to /workspace/inbox/m/clip.mp4]');
  });

  it('escapes XML-special characters in the video marker', () => {
    const out = formatAttachments([
      {
        type: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        localPath: 'inbox/m/clip.mp4',
        videoMarker: '[Video: <script> & "quotes"]',
      },
    ]);
    expect(out).toContain('&lt;script&gt; &amp; &quot;quotes&quot;');
  });
});

describe('reaction rendering', () => {
  it('renders an added reaction as a self-closing <reaction> element', () => {
    insertMessage('rx1', 'reaction', {
      operation: 'reaction_received',
      added: true,
      emoji: 'thumbs_up',
      senderName: 'Alice',
    });
    const out = formatMessages(getPendingMessages());
    expect(out).toContain('<reaction');
    expect(out).toContain('by="Alice"');
    expect(out).toContain('added="true"');
    expect(out).toContain('emoji="thumbs_up"');
    expect(out).toContain('/>');
    // No body / closing tag — a reaction is the act, not content.
    expect(out).not.toContain('</reaction>');
  });

  it('renders a removed reaction with added="false"', () => {
    insertMessage('rx2', 'reaction', {
      operation: 'reaction_received',
      added: false,
      emoji: 'eyes',
      senderName: 'Bob',
    });
    const out = formatMessages(getPendingMessages());
    expect(out).toContain('added="false"');
    expect(out).toContain('emoji="eyes"');
  });

  it('marks on_mine="true" when the router stamped replyTo.toBot', () => {
    insertMessage('rx3', 'reaction', {
      operation: 'reaction_received',
      added: true,
      emoji: 'heart',
      senderName: 'Carol',
      replyTo: { messageId: 'plat-9', toBot: true },
    });
    const out = formatMessages(getPendingMessages());
    expect(out).toContain('on_mine="true"');
  });

  it('omits on_mine when the reaction did not target a bot message', () => {
    insertMessage('rx4', 'reaction', {
      operation: 'reaction_received',
      added: true,
      emoji: 'fire',
      senderName: 'Dave',
      replyTo: { messageId: 'plat-3' },
    });
    const out = formatMessages(getPendingMessages());
    expect(out).not.toContain('on_mine');
  });

  it('escapes emoji and sender values', () => {
    insertMessage('rx5', 'reaction', {
      operation: 'reaction_received',
      added: true,
      emoji: '<x>&"',
      senderName: 'A<b>&"',
    });
    const out = formatMessages(getPendingMessages());
    expect(out).not.toContain('<x>');
    expect(out).toContain('&lt;x&gt;');
    expect(out).toContain('A&lt;b&gt;');
  });

  it('falls back to rawEmoji and renders raw unicode (WhatsApp native path)', () => {
    insertMessage('rx6', 'reaction', {
      operation: 'reaction_received',
      added: true,
      rawEmoji: '👍',
      senderName: 'Eve',
    });
    const out = formatMessages(getPendingMessages());
    expect(out).toContain('emoji="👍"');
  });
});

describe('isAddressedTurn', () => {
  // Complete MessageInRow factory (includes series_id, unlike the older
  // partial `row` helpers above — those predate the column and only
  // typecheck loosely). Mirrors the persisted container content shape:
  // top-level `isMention` + `replyTo:{toBot,sender,messageId}`.
  function row(content: object, opts: { kind?: string; trigger?: 0 | 1 } = {}): MessageInRow {
    return {
      id: 'm1',
      seq: 1,
      kind: opts.kind ?? 'chat-sdk',
      timestamp: '2026-05-17T20:37:21.000Z',
      status: 'pending',
      process_after: null,
      recurrence: null,
      series_id: null,
      tries: 0,
      trigger: opts.trigger ?? 1,
      platform_id: 'discord:abc',
      channel_type: 'discord',
      thread_id: null,
      content: JSON.stringify(content),
    };
  }

  it('true when a chat row @mentions the agent (isMention flag)', () => {
    expect(isAddressedTurn([row({ text: '<@123> hey', isMention: true })], 'Optimus')).toBe(true);
  });

  it('true on a reply whose parent sender is this agent (name match)', () => {
    // The exact 2026-05-17 AI Friends incident shape: reply to the bot's
    // own recap, replyTo.toBot was NULL in that data, sender="Optimus".
    expect(
      isAddressedTurn(
        [row({ text: 'you over-extended again', replyTo: { sender: 'Optimus', messageId: 'x' } })],
        'Optimus',
      ),
    ).toBe(true);
  });

  it('true on a reply with replyTo.toBot === true (bonus path, name not needed)', () => {
    expect(isAddressedTurn([row({ text: 'thoughts?', replyTo: { toBot: true } })], '')).toBe(true);
  });

  it('name match is case/whitespace-insensitive', () => {
    expect(isAddressedTurn([row({ text: 'q', replyTo: { sender: '  optimus ' } })], 'Optimus')).toBe(true);
  });

  it('false on a reply to ANOTHER human (not addressed to the agent)', () => {
    // Host classifier treats any replyTo as addressed — we deliberately
    // do not reproduce that bug. seq 714 in the incident session.
    expect(isAddressedTurn([row({ text: 'lol', replyTo: { sender: 'bigdee_', messageId: 'y' } })], 'Optimus')).toBe(
      false,
    );
  });

  it('false for ambient chatter: no mention, no reply', () => {
    expect(isAddressedTurn([row({ text: 'random group message' })], 'Optimus')).toBe(false);
  });

  it('true on host-stamped engageMode=pattern (dedicated-bot wiring)', () => {
    // The 2026-05-27 Nook incident: telegram `pattern='.'` wiring (every
    // message goes to this bot) but no @mention/replyTo. Before
    // stampEngagement, this read as ambient and the agent silent-turn-
    // completed on a direct question.
    expect(isAddressedTurn([row({ text: "What's going on did you fix it?", engageMode: 'pattern' })], 'Optimus')).toBe(
      true,
    );
  });

  it('mention-sticky engagement WITHOUT a this-bot mention is NOT addressed (multi-bot channel safety)', () => {
    // AI Friends shape: shared channel where the host woke this bot for an
    // @other-bot mention. engageMode='mention-sticky' must not bypass the
    // botUserId discriminator — only engageMode='pattern' is sufficient.
    expect(
      isAddressedTurn(
        [
          row({
            text: '<@456> hey',
            isMention: true,
            botUserId: '123',
            engageMode: 'mention-sticky',
          }),
        ],
        'Optimus',
      ),
    ).toBe(false);
  });

  it('engageMode=pattern still respects trigger=0 (accumulate gating)', () => {
    expect(isAddressedTurn([row({ text: 'ambient', engageMode: 'pattern' }, { trigger: 0 })], 'Optimus')).toBe(false);
  });

  it('false for trigger=0 accumulate-only rows even if they look addressed', () => {
    expect(isAddressedTurn([row({ text: '<@123>', isMention: true }, { trigger: 0 })], 'Optimus')).toBe(false);
  });

  it('ignores non-chat rows (task / system / reaction)', () => {
    expect(
      isAddressedTurn(
        [
          row({ prompt: 'maintenance' }, { kind: 'task' }),
          row({ action: 'search_conversations_response' }, { kind: 'system' }),
        ],
        'Optimus',
      ),
    ).toBe(false);
  });

  it('true when ANY eligible row in a mixed batch is addressed', () => {
    expect(
      isAddressedTurn(
        [row({ text: 'ambient' }), row({ text: '<@123> ping', isMention: true }), row({ text: 'more ambient' })],
        'Optimus',
      ),
    ).toBe(true);
  });

  it('empty assistantName skips the sender-name path (no false positive)', () => {
    expect(isAddressedTurn([row({ text: 'q', replyTo: { sender: 'Optimus' } })], '')).toBe(false);
  });

  it('malformed JSON content is skipped, not thrown', () => {
    const bad: MessageInRow = { ...row({}), content: '{not json' };
    expect(isAddressedTurn([bad], 'Optimus')).toBe(false);
  });

  it('false on empty batch', () => {
    expect(isAddressedTurn([], 'Optimus')).toBe(false);
  });

  // --- botUserId mention-target discrimination (Discord) -----------------
  // Regression for the spurious "[degraded — addressed turn produced no
  // output]" in AI Friends (2026-05-19). chat-sdk Discord sets
  // isMention=true for `<@anyone>`; a message @mentioning a DIFFERENT bot
  // made Optimus look addressed → silent turn → safety-net false alarm.
  // The bridge now stamps content.botUserId; isMention only counts when
  // the text explicitly mentions THIS bot.
  const OPTIMUS_ID = '1485390229526413444';
  const OTHER_BOT_ID = '1505612898188398835';

  it('true when an isMention row explicitly mentions THIS bot id', () => {
    expect(
      isAddressedTurn(
        [row({ text: `<@${OPTIMUS_ID}> hellooooo?`, isMention: true, botUserId: OPTIMUS_ID })],
        'Optimus',
      ),
    ).toBe(true);
  });

  it('true for the `<@!id>` nickname-mention form', () => {
    expect(
      isAddressedTurn([row({ text: `<@!${OPTIMUS_ID}> ping`, isMention: true, botUserId: OPTIMUS_ID })], 'Optimus'),
    ).toBe(true);
  });

  it('FALSE when isMention is true but the mention targets a DIFFERENT bot', () => {
    // The exact incident row (seq 72): bigdee_ told degen_ai to look
    // into something; isMention=true, but the only <@id> is degen_ai's.
    // Pre-fix this returned true → silent turn → spurious [degraded].
    expect(
      isAddressedTurn(
        [
          row({
            text: `<@${OTHER_BOT_ID}> look into this. send me a personal dm`,
            isMention: true,
            botUserId: OPTIMUS_ID,
          }),
        ],
        'Optimus',
      ),
    ).toBe(false);
  });

  it('still addressed via reply-to-bot even when the mention is for someone else', () => {
    // A message can @mention another bot AND be a reply to Optimus — the
    // reply path must still mark it addressed (defense in depth).
    expect(
      isAddressedTurn(
        [
          row({
            text: `<@${OTHER_BOT_ID}> fyi`,
            isMention: true,
            botUserId: OPTIMUS_ID,
            replyTo: { toBot: true },
          }),
        ],
        'Optimus',
      ),
    ).toBe(true);
  });

  it('keeps permissive isMention behavior when botUserId is absent (non-Discord)', () => {
    // Telegram/Slack etc. don't stamp botUserId; their SDK isMention is
    // already self-specific, so the historical behavior is preserved.
    expect(isAddressedTurn([row({ text: '@bot hey', isMention: true })], 'Optimus')).toBe(true);
  });

  it('mixed batch: addressed only if SOME row mentions this bot', () => {
    expect(
      isAddressedTurn(
        [
          row({ text: 'ambient' }),
          row({ text: `<@${OTHER_BOT_ID}> not for us`, isMention: true, botUserId: OPTIMUS_ID }),
        ],
        'Optimus',
      ),
    ).toBe(false);
    expect(
      isAddressedTurn(
        [
          row({ text: `<@${OTHER_BOT_ID}> not for us`, isMention: true, botUserId: OPTIMUS_ID }),
          row({ text: `<@${OPTIMUS_ID}> but this is`, isMention: true, botUserId: OPTIMUS_ID }),
        ],
        'Optimus',
      ),
    ).toBe(true);
  });
});
