import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { decodeXmlEscapedMessageBody as decode } from './message-body-entities.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// The model's verbatim line from the Nov 15 2026 Tico week-ahead digest
// (Pi transcript, assistant text inside <message to="tico">).
const DIGEST_LINE = '• 5:30 PM — Boys Night — Wings, VR &amp; Drinks (optional food at 5:30; VR at 7)';

describe('decodeXmlEscapedMessageBody', () => {
  it('decodes the incident line to the calendar title', () => {
    expect(decode(DIGEST_LINE)).toBe('• 5:30 PM — Boys Night — Wings, VR & Drinks (optional food at 5:30; VR at 7)');
  });

  it.each([
    ['plain &, < and >', 'Tom &amp; Jerry: 3 &lt; 5 &gt; 2', 'Tom & Jerry: 3 < 5 > 2'],
    ['bold', '**Wings &amp; Drinks** at &lt;7&gt;', '**Wings & Drinks** at <7>'],
    ['link text and URL', '[Q&amp;A](https://example.com/?a=1&amp;b=2)', '[Q&A](https://example.com/?a=1&b=2)'],
    ['quotes and numeric escapes', '&quot;hi&quot; &apos;x&apos; &#38; &#x26;', '"hi" \'x\' & &'],
    [
      'an escaped existing &amp; in the source, decoded once',
      'AT&amp;amp;T &amp;lt;tag&amp;gt;',
      'AT&amp;T &lt;tag&gt;',
    ],
  ])('decodes %s', (_label, input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  it.each([
    ['raw ampersand', 'Wings, VR & Drinks'],
    ['raw & beside an entity (author wrote literal text)', 'Use &amp; in HTML; Tom & Jerry'],
    ['an existing &amp; written literally next to raw text', 'AT&T writes &amp; as AT&amp;T'],
    ['raw < and >', '3 < 5 > 2'],
    ['HTML-only named entity', 'a&nbsp;b'],
    ['no ampersand', 'hello'],
    ['invalid code point', '&#0; &#xD800;'],
  ])('leaves %s unchanged', (_label, input) => {
    expect(decode(input)).toBe(input);
  });

  it('never decodes inside inline code or fenced blocks', () => {
    expect(decode('Tom &amp; Jerry: `a &amp;&amp; b`')).toBe('Tom & Jerry: `a &amp;&amp; b`');
    const fence = '```html\n<p>Fish &amp; Chips</p>\n```';
    expect(decode(`Menu &amp; code:\n${fence}`)).toBe(`Menu & code:\n${fence}`);
    expect(decode('only code: `&amp;`')).toBe('only code: `&amp;`');
  });
});

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function resultQuery(text: string): AgentQuery {
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield { type: 'result', text };
  }
  return { push: () => {}, end: () => {}, events: events(), abort: () => {} };
}

describe('escaped <message> body reaches messages_out as visible text (wiring)', () => {
  it('stores and sends the decoded text', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('tico', 'tico', 'channel', 'telegram', 'telegram:-100', NULL)`,
      )
      .run();
    const routing = {
      platformId: 'telegram:-100',
      channelType: 'telegram',
      threadId: null,
      inReplyTo: 'm1',
      taskFire: false,
    };

    await processQuery(
      resultQuery(`<message to="tico">Friday, Nov 20\n${DIGEST_LINE}</message>`),
      routing,
      ['m1'],
      'pi',
      undefined,
      'prompt',
      undefined,
    );

    const out = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text as string;
    expect(text).toContain('Wings, VR & Drinks');
    expect(text).not.toContain('&amp;');
  });
});
