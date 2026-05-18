import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { MockProvider } from './providers/mock.js';
import { shouldSendErrorResponseForBatch, dispatchResultText, isAwaitingSensitiveConfirmation } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';
import type { ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1; timestamp?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      opts?.timestamp ?? new Date().toISOString(),
      opts?.processAfter ?? null,
      opts?.trigger ?? 1,
      opts?.onWake ?? 0,
      JSON.stringify(content),
    );
}

/**
 * Insert + read-back as a plain MessageInRow shape. Used by tests that
 * need to exercise the formatter on row kinds that `getPendingMessages`
 * filters out (notably `kind='system'`, which is excluded at the SQL
 * layer so unconsumed MCP-tool responses can't starve the LIMIT —
 * production code never reaches formatMessages with a system row).
 */
function readMessageInRow(id: string, kind: string, content: object) {
  insertMessage(id, kind, content);
  return getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as Parameters<
    typeof formatMessages
  >[0][number];
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    // System rows are MCP-tool responses that don't reach the agent
    // via the poll loop (it strips them, and `getPendingMessages` now
    // excludes them at the SQL layer to keep them from counting toward
    // the LIMIT). The formatter retains a kind='system' branch for
    // tests / future use; call it directly here.
    const messages = [
      readMessageInRow('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } }),
    ];
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    const chatMessages = getPendingMessages();
    // System row read directly — see above re: getPendingMessages
    // excluding kind='system'.
    const systemMessage = readMessageInRow('m2', 'system', { action: 'test', status: 'ok', result: null });
    const prompt = formatMessages([...chatMessages, systemMessage]);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('age-out: trigger=0 row older than 24h is excluded', () => {
    // Stale accumulate context shouldn't ride along forever. Without
    // the age cap, sessions that accumulate weeks/months of group
    // chatter compete with fresh context inside the LIMIT and waste
    // prompt budget on dead messages — observed S331 in #boysnight.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    insertMessage(
      'old-noise',
      'chat',
      { sender: 'A', text: 'ancient chitchat' },
      { trigger: 0, timestamp: twoDaysAgo },
    );
    insertMessage('fresh-trigger', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });

    const messages = getPendingMessages();
    expect(messages.map((m) => m.id)).toEqual(['fresh-trigger']);
  });

  it('age-out: trigger=1 row older than 24h is still included (due work, age does not matter)', () => {
    // Trigger=1 represents work the host queued (recurring tasks like
    // dream-* maintenance, or replayed wake messages). Even if a
    // recurring task fired hours/days ago and never got picked up
    // (the bug S331 fixed), the row should still be visible — it
    // represents work that needs to happen, not context that's gone
    // stale. The age cap only applies to trigger=0 accumulate rows.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    insertMessage('old-task', 'task', { prompt: 'maintenance' }, { trigger: 1, timestamp: threeDaysAgo });

    const messages = getPendingMessages();
    expect(messages.map((m) => m.id)).toEqual(['old-task']);
  });

  it('age-out: trigger=0 row inside 24h window is included normally', () => {
    // Sanity check that the age cap doesn't drop recent context.
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    insertMessage(
      'recent-noise',
      'chat',
      { sender: 'A', text: 'recent chitchat' },
      { trigger: 0, timestamp: oneHourAgo },
    );
    insertMessage('fresh-trigger', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });

    const messages = getPendingMessages();
    expect(messages.map((m) => m.id).sort()).toEqual(['fresh-trigger', 'recent-noise']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    // Same caveat as the formatter > system messages test: getPendingMessages
    // excludes kind='system' at the SQL layer to prevent unconsumed MCP-tool
    // responses from starving the LIMIT. Pull the row directly for the
    // formatter check.
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const row = getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get('s1') as Parameters<
      typeof formatMessages
    >[0][number];
    const prompt = formatMessages([row]);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: ProviderEvent[] = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    const resultEvent = typed[1];
    expect(resultEvent.type).toBe('result');
    expect(resultEvent.type === 'result' ? resultEvent.text : undefined).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: ProviderEvent[] = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e): e is Extract<ProviderEvent, { type: 'result' }> => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('error response gating', () => {
  it('suppresses user-visible errors for task-only batches', () => {
    insertMessage('m1', 'task', { prompt: 'Silent maintenance' });
    expect(shouldSendErrorResponseForBatch(getPendingMessages())).toBe(false);
  });

  it('keeps user-visible errors for chat-triggered batches', () => {
    insertMessage('m1', 'chat', { sender: 'User', text: 'Help' });
    expect(shouldSendErrorResponseForBatch(getPendingMessages())).toBe(true);
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('dispatchResultText safety net (local fork patch)', () => {
  const ROUTING: RoutingContext = {
    platformId: 'discord:1158397269079506955:1192937484582142012',
    channelType: 'discord',
    threadId: null,
    inReplyTo: 'm1',
  };

  function insertChannelDestination(name: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, ROUTING.channelType!, ROUTING.platformId!);
  }

  it('emits bare result text to the originating channel with a degraded label when no <message> block is present', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('Calendar event created and the knowledge base updated.', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('[degraded — agent did not wrap reply in <message> block]');
    expect(text).toContain('Calendar event created and the knowledge base updated.');
    expect(out[0].channel_type).toBe(ROUTING.channelType);
    expect(out[0].platform_id).toBe(ROUTING.platformId);
  });

  it('does not invoke safety net when at least one <message> block is dispatched (mixed turn)', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('Some scratchpad notes.\n<message to="boys-night">Booked.</message>\nMore scratchpad.', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toBe('Booked.');
    expect(text).not.toContain('[degraded');
  });

  it('emits silent_turn_complete control row (no chat) for empty/whitespace-only result text', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('   \n\n   ', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(out[0].channel_type).toBeNull();
    expect(out[0].platform_id).toBeNull();
    expect(JSON.parse(out[0].content)).toEqual({ action: 'silent_turn_complete' });
  });

  it('SUPPRESSES the scary degraded fallback on an addressed turn that is awaiting sensitive-gate confirmation', () => {
    // 2026-05-18 confidence-killer: a gated request makes the model end
    // its turn with only `<internal>Waiting for X confirmation.</internal>`
    // (zero <message>) — an addressed, zero-output turn. Pre-fix this hit
    // the "[degraded — likely tool failure] this is a bug, try again"
    // safety-net BEFORE the user even tapped Confirm; the real answer
    // arrived ~20s later. It is an EXPECTED pause, not a failure: must
    // emit a quiet silent_turn_complete, NOT a chat message.
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<internal>Waiting for Google Calendar confirmation.</internal>',
      ROUTING,
      true, // addressed
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(JSON.parse(out[0].content)).toEqual({
      action: 'silent_turn_complete',
    });
    // Crucially: NO scary "this is a bug / tool failure" chat message.
    const anyChat = out.find((m) => m.channel_type !== null);
    expect(anyChat).toBeUndefined();
  });

  it('REGRESSION GUARD: a genuine no-output addressed turn (not confirm) STILL emits the degraded fallback', () => {
    // The real tool-failure case (2026-05-17 AI Friends) must keep
    // surfacing the visible-degraded message — the confirm-suppression
    // must be precise, not a blanket silencer of addressed-silent turns.
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<internal>search_conversations returned nothing and I have no answer.</internal>',
      ROUTING,
      true, // addressed
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain("couldn't produce a reply this turn");
    expect(out[0].channel_type).toBe(ROUTING.channelType);
  });

  it('emits silent_turn_complete (not safety-net chat) for <internal>-only output (private maintenance turn)', () => {
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<internal>Nothing new to save. The Tico calendar preference and the security rule were already saved in the previous maintenance task.</internal>',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(JSON.parse(out[0].content).action).toBe('silent_turn_complete');
    // Must NOT have produced a chat message — the indicator-clear is the
    // only outbound; nothing user-facing.
    expect(out[0].channel_type).toBeNull();
  });

  it('emits silent_turn_complete when only <internal> tags + whitespace remain after strip', () => {
    insertChannelDestination('boys-night');

    dispatchResultText(
      '\n  <internal>silent decision</internal>\n  <internal>another silent thought</internal>  \n',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).action).toBe('silent_turn_complete');
  });

  it('does NOT emit silent_turn_complete when a <message> block was sent (typing pause comes from delivery instead)', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('<message to="boys-night">Done.</message>', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(JSON.parse(out[0].content).text).toBe('Done.');
  });

  it('does NOT emit silent_turn_complete when the safety-net fires (chat reply IS being sent)', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('Bare unwrapped reply that should be safety-netted.', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(JSON.parse(out[0].content).text).toContain('[degraded');
  });

  it('dedupes near-duplicate <message> blocks within one turn (whitespace-insensitive)', () => {
    // Real failure 2026-05-12 in Tico+Janathan WA group: the model
    // emitted two <message to="chat"> blocks that differed only by a
    // single trailing space before \n. Without per-turn dedup, both
    // dispatched and the user saw the same Suno-suggestion message
    // twice ~3 sec apart.
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<message to="boys-night">Okay FINE, that\'s fair 😂 \n\nHere — drop them into suno.com.</message>' +
        '<message to="boys-night">Okay FINE, that\'s fair 😂\n\nHere — drop them into suno.com.</message>',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Okay FINE');
  });

  it('still allows two <message> blocks when bodies differ in substance', () => {
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<message to="boys-night">First reply.</message>' +
        '<message to="boys-night">Second, genuinely different reply.</message>',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).text).toBe('First reply.');
    expect(JSON.parse(out[1].content).text).toBe('Second, genuinely different reply.');
  });

  it('drops with log when routing has no origin channel (defensive)', () => {
    const blankRouting: RoutingContext = {
      platformId: null,
      channelType: null,
      threadId: null,
      inReplyTo: null,
    };

    dispatchResultText('I did the thing.', blankRouting);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  // Regression: 2026-05-17 AI Friends. The merged Degenerates agent was
  // @mentioned + replied-to, search_conversations failed (NULL
  // messaging_group_id), the agent produced no output and emitted a bare
  // silent_turn_complete. The user saw nothing and read it as the bot
  // being broken. An addressed turn with zero deliverable output must
  // deliver an explicit visible fallback, never a silent control row.
  it('addressed + zero output: delivers explicit fallback chat, NOT silent_turn_complete', () => {
    insertChannelDestination('boys-night');

    // Empty result (the incident shape: agent had nothing because its
    // tool kept failing) on an addressed turn.
    dispatchResultText('   \n\n   ', ROUTING, /* addressed */ true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    // Visible chat to the origin channel, not a kind=system control row.
    expect(out[0].kind).toBe('chat');
    expect(out[0].channel_type).toBe(ROUTING.channelType);
    expect(out[0].platform_id).toBe(ROUTING.platformId);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('addressed turn produced no output');
    expect(text).toContain("couldn't produce a reply");
    // Must NOT be the silent control row.
    expect(text).not.toContain('silent_turn_complete');
  });

  it('addressed + <internal>-only output: still delivers explicit fallback (not silent)', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('<internal>I cannot answer this, search failed</internal>', ROUTING, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('addressed turn produced no output');
    // The private <internal> content must NOT leak to the user.
    expect(text).not.toContain('search failed');
  });

  it('NOT addressed + zero output: keeps silent_turn_complete (ambient/maintenance unchanged)', () => {
    insertChannelDestination('boys-night');

    // Same empty turn, but not addressed (ambient group lull / task).
    dispatchResultText('   \n\n   ', ROUTING, /* addressed */ false);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(JSON.parse(out[0].content)).toEqual({ action: 'silent_turn_complete' });
  });

  it('addressed defaults to false: omitting the arg preserves prior silent behavior', () => {
    insertChannelDestination('boys-night');

    // No third arg — every pre-existing caller/test path.
    dispatchResultText('<internal>silent</internal>', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).action).toBe('silent_turn_complete');
  });

  it('addressed + a real <message> block: normal delivery, no fallback (addressed satisfied)', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('<message to="boys-night">Here is your answer.</message>', ROUTING, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    const text = JSON.parse(out[0].content).text;
    expect(text).toBe('Here is your answer.');
    expect(text).not.toContain('addressed turn produced no output');
  });

  it('addressed + zero output but no origin channel: drops (cannot fabricate a destination)', () => {
    const blankRouting: RoutingContext = {
      platformId: null,
      channelType: null,
      threadId: null,
      inReplyTo: null,
    };

    dispatchResultText('   ', blankRouting, true);

    // No channel to deliver the fallback to — same defensive drop as the
    // unwrapped path. Nothing is emitted (no silent row either; the turn
    // was addressed so we deliberately do NOT fall back to the control
    // row, but we also cannot invent a destination).
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('isAwaitingSensitiveConfirmation (false-degraded suppression detector)', () => {
  it('matches the model\'s standard "waiting for <provider> confirmation" internal note', () => {
    expect(isAwaitingSensitiveConfirmation('<internal>Waiting for Google Calendar confirmation.</internal>')).toBe(
      true,
    );
    expect(isAwaitingSensitiveConfirmation('Waiting for iXACT confirmation')).toBe(true);
  });

  it("matches the gate's verbatim pending-result language", () => {
    expect(
      isAwaitingSensitiveConfirmation("`google_call` is awaiting the user's confirmation (a prompt is shown in chat)."),
    ).toBe(true);
    expect(isAwaitingSensitiveConfirmation('A confirm prompt has been posted in the chat.')).toBe(true);
  });

  it('does NOT match a genuine tool failure / no-answer turn (the real degraded case must survive)', () => {
    expect(
      isAwaitingSensitiveConfirmation(
        '<internal>search_conversations returned nothing and I have no answer.</internal>',
      ),
    ).toBe(false);
    expect(isAwaitingSensitiveConfirmation('the calendar API returned a 500 error')).toBe(false);
    expect(isAwaitingSensitiveConfirmation('')).toBe(false);
    // Mentions "confirm" but not as a pending-gate pause — must not
    // over-match and silence a real reply.
    expect(isAwaitingSensitiveConfirmation('I booked it. Can you confirm the date works for you?')).toBe(false);
  });
});
