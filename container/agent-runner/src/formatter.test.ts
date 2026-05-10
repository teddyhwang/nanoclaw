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
  extractImageAttachments,
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

  it('header comes before the <messages> block', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const msgsIdx = result.indexOf('<messages>');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(msgsIdx).toBeGreaterThan(ctxIdx);
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
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
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
  function row(id: string, trigger: 0 | 1, seq: number): MessageInRow {
    return {
      id,
      seq,
      kind: 'chat-sdk',
      timestamp: '2026-05-09T20:36:00.000Z',
      status: 'pending',
      process_after: null,
      recurrence: null,
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

  it('falls back to the newest row when no trigger=1 is present', () => {
    // Defensive: shouldn't normally happen because the accumulate gate
    // upstream rejects all-trigger=0 batches. But if we ever get one,
    // return *something* rather than null so callers writing
    // `in_reply_to` always have an id.
    const messages = [row('latest', 0, 70), row('older', 0, 68)];
    const m = pickInReplyToMessage(messages);
    expect(m?.id).toBe('latest');
  });

  it('handles a mix where multiple trigger=1 rows exist', () => {
    // When two trigger=1 rows are in the batch (both real engages), the
    // newest wins — that's the agent's most recent reason to be active.
    const messages = [row('newer-mention', 1, 70), row('drive-by', 0, 68), row('older-mention', 1, 64)];
    const m = pickInReplyToMessage(messages);
    expect(m?.id).toBe('newer-mention');
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
