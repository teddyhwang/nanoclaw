import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getAgentMailbox } from './mailbox/index.js';
import { processQuery, wrappingRetryPrompt } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// The one wrapping retry used to say "it was not wrapped" whenever nothing was
// delivered — even when the agent had wrapped its reply correctly and a block
// was refused for a specific reason. AI Friends 2026-10-11: the model re-emitted
// the identical, correctly wrapped block and the turn ended in a failure
// fallback. The retry must name the refusal; a block refused in an otherwise
// delivered turn must not vanish silently.

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskFire: false,
};

function seedDest(name = 'ai-friends'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run(name, name);
}

function stubQuery(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return {
    pushes,
    query: { push: (m: string) => void pushes.push(m), end: () => {}, events, abort: () => {} },
  };
}

async function run(texts: { streamed?: string; result: string }, streamed: boolean): Promise<string[]> {
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 's1' };
    if (texts.streamed !== undefined) yield { type: 'text', text: texts.streamed };
    yield { type: 'result', text: texts.result };
  }
  const { query, pushes } = stubQuery(events());
  await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, streamed);
  return pushes;
}

const chatRows = () => getUndeliveredMessages().filter((message) => message.kind === 'chat');
const pendingFeedback = () => getAgentMailbox().operations.getState('delivery_feedback')?.value ?? '';

describe('wrapping retry names why a wrapped block was refused', () => {
  for (const streamed of [true, false]) {
    const door = streamed ? 'streamed door' : 'result door';

    it(`${door}: unknown destination is named, not reported as unwrapped`, async () => {
      seedDest();
      const block = '<message to="ai-friend">Hello all.</message>';
      const pushes = await run({ streamed: streamed ? block : undefined, result: block }, streamed);

      expect(chatRows()).toHaveLength(0);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toContain('was wrapped, but it was refused');
      expect(pushes[0]).toContain('to="ai-friend" is not one of your destinations');
      expect(pushes[0]).toContain('Your destinations: ai-friends.');
      expect(pushes[0]).not.toContain('not wrapped');
      // Named once even though both doors saw the same block.
      expect(pushes[0].match(/is not one of your destinations/g)).toHaveLength(1);
    });

    it(`${door}: a tag with no to= attribute is named`, async () => {
      seedDest();
      const block = '<message channel="ai-friends">Hello all.</message>';
      const pushes = await run({ streamed: streamed ? block : undefined, result: block }, streamed);

      expect(chatRows()).toHaveLength(0);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toContain('a <message> tag had no to="name" attribute');
      expect(pushes[0]).toContain('reply_to_message_id="#N"');
    });

    it(`${door}: single-quoted attributes are the same intent and deliver`, async () => {
      seedDest();
      const block = "<message to='ai-friends'>Hello all.</message>";
      const pushes = await run({ streamed: streamed ? block : undefined, result: block }, streamed);

      expect(pushes).toHaveLength(0);
      expect(chatRows()).toHaveLength(1);
      expect(JSON.parse(chatRows()[0].content).text).toBe('Hello all.');
    });
  }

  it('incident shape: a reply to a non-trigger channel message delivers with no retry', async () => {
    seedDest();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
         VALUES (6508, '1558991246817628182:ag-test', 'discord', 'chan-1', NULL, 'chat-sdk', 0, 'completed', '2026-10-11T23:54:37Z', '{}')`,
      )
      .run();
    const block = '<message to="ai-friends" reply_to_message_id="#6508">Analysis.</message>';
    const pushes = await run({ streamed: block, result: block }, true);

    expect(pushes).toHaveLength(0);
    expect(chatRows()).toHaveLength(1);
    expect(chatRows()[0].in_reply_to).toBe('1558991246817628182:ag-test');
  });

  it('genuinely unwrapped output keeps the original wrapping instruction', async () => {
    seedDest();
    const pushes = await run({ result: 'Bare reply with no message tag.' }, false);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('it was not wrapped in <message to="name">');
    expect(pushes[0]).not.toContain('refused');
  });

  it('a refused block after another delivery gets an informed retry, then next-turn feedback if still refused', async () => {
    seedDest();
    const result = '<message to="ai-friends">Posted.</message>\n<message to="ai-friend">Lost.</message>';
    const { query, pushes } = stubQuery(
      (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'result', text: result };
        yield { type: 'result', text: result };
      })(),
    );
    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined, false);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was wrapped, but it was refused');
    expect(pushes[0]).not.toContain('it was not wrapped');
    expect(pushes[0]).toContain('<sent_message to="ai-friends">Posted.</sent_message>');
    expect(chatRows()).toHaveLength(1);
    expect(pendingFeedback()).toContain('to="ai-friend" is not one of your destinations; that block was not posted.');
  });

  it('a fully delivered turn records no feedback', async () => {
    seedDest();
    await run({ result: '<message to="ai-friends">Posted.</message>' }, false);

    expect(chatRows()).toHaveLength(1);
    expect(pendingFeedback()).toBe('');
  });
});

describe('wrappingRetryPrompt', () => {
  it('lists every refusal and the tag syntax', () => {
    const prompt = wrappingRetryPrompt('a, b', [
      { detail: 'first reason', feedbackRecorded: false },
      { detail: 'second reason', feedbackRecorded: true },
    ]);
    expect(prompt).toStartWith('<system>');
    expect(prompt).toEndWith('</system>');
    expect(prompt).toContain('refused: first reason; second reason.');
    expect(prompt).toContain('to="name" (required)');
    expect(prompt).toContain('Your destinations: a, b.');
  });

  it('falls back to the unwrapped instruction when nothing was refused', () => {
    const prompt = wrappingRetryPrompt('a');
    expect(prompt).toContain('not wrapped');
    expect(prompt).toContain('Your destinations: a.');
  });
});
