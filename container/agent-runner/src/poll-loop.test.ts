import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { isCorruptionError, processQuery } from './poll-loop.js';
import { confirmationGatePaused, noteToolResult, resetConfirmationGateState } from './confirmation-gate-state.js';
import { MockProvider } from './providers/mock.js';
import {
  shouldSendErrorResponseForBatch,
  dispatchResultText,
  isAwaitingSensitiveConfirmation,
  shouldKeepaliveBridge,
} from './poll-loop.js';
import type { RoutingContext } from './formatter.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

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

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
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

  it('cross-channel trigger only carries accumulated rows from that same channel', () => {
    // Degenerates 2026-05-26: a General-channel trigger swept in a
    // stale Cook-channel trigger=0 question from the shared agent session,
    // and the model answered Cook even though General caused the wake.
    // Accumulated context must be route-scoped to the actual chat trigger.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES (?, 'chat-sdk', datetime('now', '-3 minutes'), 'pending', ?, ?, 'discord', ?)`,
      )
      .run('cook-context', 0, 'discord:guild:cook', JSON.stringify({ sender: 'mackchiu', text: 'onion rings?' }));
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES (?, 'chat-sdk', datetime('now', '-2 minutes'), 'pending', ?, ?, 'discord', ?)`,
      )
      .run('general-context', 0, 'discord:guild:general', JSON.stringify({ sender: 'Teddy', text: 'context' }));
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES (?, 'chat-sdk', datetime('now'), 'pending', ?, ?, 'discord', ?)`,
      )
      .run('general-trigger', 1, 'discord:guild:general', JSON.stringify({ sender: 'Teddy', text: '@Optimus ping' }));

    expect(getPendingMessages().map((m) => m.id)).toEqual(['general-context', 'general-trigger']);
  });

  it('cross-channel chat triggers are processed one route at a time', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES (?, 'chat-sdk', datetime('now', '-1 minute'), 'pending', 1, ?, 'discord', ?)`,
      )
      .run('older-cook-trigger', 'discord:guild:cook', JSON.stringify({ text: '@Optimus cook' }));
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES (?, 'chat-sdk', datetime('now'), 'pending', 1, ?, 'discord', ?)`,
      )
      .run('newer-general-trigger', 'discord:guild:general', JSON.stringify({ text: '@Optimus general' }));

    expect(getPendingMessages().map((m) => m.id)).toEqual(['newer-general-trigger']);
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

  it('suppresses bare result text and emits only a silent control row when no <message> block is present', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('Calendar event created and the knowledge base updated.', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(JSON.parse(out[0].content)).toEqual({ action: 'silent_turn_complete' });
    expect(out[0].channel_type).toBeNull();
    expect(out[0].platform_id).toBeNull();
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

  it('strips nested <internal> blocks from delivered <message> bodies', () => {
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<message to="boys-night">Visible line.<internal>private scratchpad</internal>Still visible.</message>',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toBe('Visible line.Still visible.');
    expect(text).not.toContain('<internal>');
    expect(text).not.toContain('private scratchpad');
  });

  it('drops a <message> body that consists entirely of nested <internal> scratchpad', () => {
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<message to="boys-night"><internal>Task aborted: already passed. No post warranted.</internal></message>',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(JSON.parse(out[0].content)).toEqual({ action: 'silent_turn_complete' });
    expect(out[0].channel_type).toBeNull();
    expect(out[0].platform_id).toBeNull();
  });

  it('recovers a final <message> block whose closing </message> was dropped by the model (2026-05-28 epicure pairing)', () => {
    // Long-bodied Claude replies occasionally end without emitting the
    // trailing `</message>`. Pre-fix, the strict regex matched zero blocks
    // and the entire (correct) answer was suppressed as scratchpad,
    // triggering the "no <message to=...> blocks" retry nudge. Tolerate it
    // by treating end-of-text as an implicit close on the trailing opener.
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<message to="boys-night" reply_to_message_id="#1">Epicure pulled the pairing graph for beef + onion and the strongest universal bridges are cumin, paprika, parsley, red pepper, and olive oil.',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('cumin, paprika, parsley');
    expect(text).not.toContain('<message');
    expect(text).not.toContain('</message>');
  });

  it('does not synthesize a close when a properly closed <message> block is followed by unwrapped trailing text', () => {
    // The recovery must not fire when the LAST opener already has its
    // matching `</message>` — trailing scratchpad after a closed block is
    // a normal mixed turn (covered by the test above) and should keep
    // hitting the existing scratchpad path, not get re-wrapped.
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<message to="boys-night">Done.</message>\nSome trailing scratchpad notes that include the substring <message but no real opener.',
      ROUTING,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toBe('Done.');
  });

  it('allows an explicit reply_to_message_id on a task-style <message> block', () => {
    insertChannelDestination('boys-night');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
         VALUES (2, 'incident-start-platform-id', ?, ?, NULL, 'chat-sdk', 1, 'completed', '2026-05-19T12:00:00Z', '{}')`,
      )
      .run(ROUTING.channelType, ROUTING.platformId);

    dispatchResultText('<message to="boys-night" reply_to_message_id="#2">✅ AI status resolved</message>', {
      ...ROUTING,
      inReplyTo: null,
    });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('AI status resolved');
    expect(out[0].in_reply_to).toBe('incident-start-platform-id');
  });

  it('rejects explicit reply_to_message_id targeting an accumulated trigger=0 inbound row', () => {
    insertChannelDestination('boys-night');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
         VALUES (444, 'ambient-side-comment-platform-id', ?, ?, NULL, 'chat-sdk', 0, 'completed', '2026-06-04T14:15:24Z', '{}')`,
      )
      .run(ROUTING.channelType, ROUTING.platformId);

    const result = dispatchResultText(
      '<message to="boys-night" reply_to_message_id="#444">This should not reach chat.</message>',
      ROUTING,
    );

    expect(result.sent).toBe(0);
    expect(result.dispatched).toHaveLength(0);
    const out = getUndeliveredMessages();
    expect(out.every((row) => row.kind !== 'chat')).toBe(true);
  });

  it('same-channel dispatch reply pill stays on the turn-authoritative target even when a NEWER trigger=1 inbound exists in the channel', () => {
    // 2026-05-23 New York Crew WhatsApp regression: while Optimus was
    // answering Jon's older hotel-name request, Nicole sent a new
    // @optimus request. The destination-thread hunt picks "newest
    // trigger=1 in channel" by seq DESC, so destRouting.inReplyTo
    // resolved to Nicole's just-arrived row. The pre-fix fallback
    // `destRouting.inReplyTo ?? routing.inReplyTo` let that shadow the
    // authoritative routing target (Jon's row) and the reply pill
    // attached to Nicole's message — the agent's text addressed Jon
    // about hotels, but the platform reply chain pointed at Nicole's
    // km-conversion request. On a same-channel dispatch routing.inReplyTo
    // must win regardless of what the destination hunt finds.
    insertChannelDestination('boys-night');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
         VALUES (10, 'newer-different-user-msg', ?, ?, NULL, 'chat', 1, 'pending', '2026-05-23T11:01:00Z', '{}')`,
      )
      .run(ROUTING.channelType, ROUTING.platformId);

    dispatchResultText('<message to="boys-night">Done.</message>', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('m1');
    expect(out[0].in_reply_to).not.toBe('newer-different-user-msg');
  });

  it('keeps task-style <message> blocks standalone when no explicit reply target is supplied', () => {
    insertChannelDestination('boys-night');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (seq, id, channel_type, platform_id, thread_id, kind, trigger, status, timestamp, content)
         VALUES (2, 'stale-human-platform-id', ?, ?, NULL, 'chat-sdk', 1, 'completed', '2026-05-19T12:00:00Z', '{}')`,
      )
      .run(ROUTING.channelType, ROUTING.platformId);

    dispatchResultText('<message to="boys-night">🔥 AI status update</message>', { ...ROUTING, inReplyTo: null });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
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

  it('REGRESSION GUARD: a genuine no-output addressed turn gets a non-alarming scoped fallback', () => {
    // The real tool-failure case (2026-05-17 AI Friends) must not silently
    // disappear or synthesize an alarming internal diagnostic.
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<internal>search_conversations returned nothing and I have no answer.</internal>',
      ROUTING,
      true, // addressed
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(JSON.parse(out[0].content).text).toBe(
      "I couldn't complete that request or produce a reliable reply. Please try again.",
    );
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

  it('emits silent_turn_complete when unwrapped text is suppressed', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('Bare unwrapped reply that should be retried, not sent.', ROUTING);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(JSON.parse(out[0].content)).toEqual({
      action: 'silent_turn_complete',
    });
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

  it('dedupes a final <message> block that was already sent through a tool this turn', async () => {
    insertChannelDestination('boys-night');
    const { writeMessageOut } = await import('./db/messages-out.js');
    const turnStartedAt = '2026-06-04 00:00:00';

    writeMessageOut({
      id: 'tool-sent-1',
      kind: 'chat',
      channel_type: ROUTING.channelType,
      platform_id: ROUTING.platformId,
      content: JSON.stringify({
        text: '## Recap — last 24h\n\n- **One thing.** Already sent via send_message.',
      }),
    });

    dispatchResultText(
      '<message to="boys-night">## Recap — last 24h\n\n- **One thing.** Already sent via send_message.</message>',
      ROUTING,
      false,
      turnStartedAt,
    );

    const out = getUndeliveredMessages().filter((m) => m.kind === 'chat');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Already sent via send_message');
  });

  it('drops with log when routing has no origin channel (defensive)', () => {
    const blankRouting: RoutingContext = {
      platformId: null,
      channelType: null,
      threadId: null,
      inReplyTo: null,
    };

    dispatchResultText('I did the thing.', blankRouting);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(out[0].channel_type).toBeNull();
    expect(out[0].platform_id).toBeNull();
    expect(JSON.parse(out[0].content)).toEqual({
      action: 'silent_turn_complete',
    });
  });

  it('addressed + zero output: sends a scoped failure fallback instead of going silent', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('   \n\n   ', ROUTING, /* addressed */ true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(out[0].channel_type).toBe(ROUTING.channelType);
    expect(out[0].platform_id).toBe(ROUTING.platformId);
    expect(out[0].in_reply_to).toBe(ROUTING.inReplyTo);
    expect(JSON.parse(out[0].content).text).toBe(
      "I couldn't complete that request or produce a reliable reply. Please try again.",
    );
  });

  it('addressed + zero <message> blocks but a tool DID deliver a chat row: silent_turn_complete, NO degraded fallback', async () => {
    // The image-generation shape (2026-05-21 Discord Teddy DM): the
    // agent called generate_image then send_file. send_file writes a
    // kind='chat' row straight to outbound.db — no <message> block — so
    // dispatchResultText sees sent===0 on an addressed turn. With a
    // turnStartedAt anchor it must see the tool-delivered chat row and
    // end the turn cleanly instead of firing the scary fallback.
    insertChannelDestination('boys-night');
    const { writeMessageOut } = await import('./db/messages-out.js');
    const turnStartedAt = '2026-05-21T00:00:00';
    // Simulate send_file's outbound row, written DURING the turn.
    writeMessageOut({
      id: 'img-out-1',
      kind: 'chat',
      channel_type: ROUTING.channelType,
      platform_id: ROUTING.platformId,
      content: JSON.stringify({ text: 'Ready to assist.', files: ['x.webp'] }),
    });

    // Agent's result text has no <message> block (it delivered via the
    // tool) — addressed turn, but turnStartedAt is supplied.
    dispatchResultText('   \n\n   ', ROUTING, /* addressed */ true, turnStartedAt);

    const out = getUndeliveredMessages();
    // The send_file row, plus a silent_turn_complete control row — and
    // crucially NO degraded-fallback chat row.
    const degraded = out.filter((m) => JSON.parse(m.content).text?.includes?.('addressed turn produced no output'));
    expect(degraded).toHaveLength(0);
    const control = out.filter((m) => JSON.parse(m.content).action === 'silent_turn_complete');
    expect(control).toHaveLength(1);
  });

  it('tool delivery suppresses a wrapping retry without addressed attribution', async () => {
    const { writeMessageOut } = await import('./db/messages-out.js');
    const turnStartedAt = '2026-08-11T00:00:00';
    writeMessageOut({
      id: 'file-out-with-caption',
      kind: 'chat',
      channel_type: ROUTING.channelType,
      platform_id: ROUTING.platformId,
      content: JSON.stringify({ text: 'Image caption', files: ['image.png'] }),
    });

    const result = dispatchResultText(
      '<internal>File sent with caption.</internal>\n\n<internal-trace>send_file</internal-trace>',
      ROUTING,
      false,
      turnStartedAt,
    );

    expect(result.hasUnwrapped).toBe(false);
    const out = getUndeliveredMessages();
    expect(out.filter((row) => row.kind === 'chat')).toHaveLength(1);
    expect(out.filter((row) => JSON.parse(row.content).action === 'silent_turn_complete')).toHaveLength(1);
  });

  it('task turn: suppresses a final <message> summary to a destination already delivered mid-turn (2026-06-10 AI Friends recap double-post)', async () => {
    // Daily-recap shape: the task agent sent the recap mid-turn via
    // send_message (a kind='chat' row to ai-friends), then appended a final
    // <message to="ai-friends">Recap sent (#29021).</message>. The body text
    // differs from the recap, so the exact-text dedup (hasChatMessageTextSince)
    // misses it and the channel gets a SECOND message. On a task turn we
    // suppress any final block to a destination that already received a
    // tool-sent chat row this turn (one-message task contract).
    insertChannelDestination('ai-friends');
    const { writeMessageOut } = await import('./db/messages-out.js');
    const turnStartedAt = '2026-06-10T00:00:00';
    // Simulate send_message's outbound row — the actual recap, written mid-turn.
    writeMessageOut({
      id: 'recap-out-1',
      kind: 'chat',
      channel_type: ROUTING.channelType,
      platform_id: ROUTING.platformId,
      content: JSON.stringify({ text: 'Daily recap: lots happened today across the channels.' }),
    });

    // Final response: a DIFFERENT-text summary block to the same destination.
    dispatchResultText(
      '<message to="ai-friends">Recap sent (#29021).</message>',
      ROUTING,
      /* addressed */ false,
      turnStartedAt,
      /* compactedDuringTurn */ false,
      /* taskTurn */ true,
    );

    const out = getUndeliveredMessages();
    // The mid-turn recap row, plus a silent_turn_complete control row — and
    // crucially NO second 'Recap sent' chat row to the channel.
    const summaryRows = out.filter((m) => {
      try {
        return JSON.parse(m.content).text?.includes?.('Recap sent');
      } catch {
        return false;
      }
    });
    expect(summaryRows).toHaveLength(0);
    const control = out.filter((m) => JSON.parse(m.content).action === 'silent_turn_complete');
    expect(control).toHaveLength(1);
  });

  it('chat turn (not task): a final <message> after a mid-turn tool send to the same destination is NOT suppressed', async () => {
    // The task-turn suppression must NOT bleed into chat turns: an addressed
    // chat turn may legitimately send a file/message via a tool and then a
    // separate follow-up <message> to the same channel. Only task turns owe
    // "exactly one message".
    insertChannelDestination('boys-night');
    const { writeMessageOut } = await import('./db/messages-out.js');
    const turnStartedAt = '2026-06-10T00:00:00';
    writeMessageOut({
      id: 'tool-out-1',
      kind: 'chat',
      channel_type: ROUTING.channelType,
      platform_id: ROUTING.platformId,
      content: JSON.stringify({ text: 'Here is the file.', files: ['x.pdf'] }),
    });

    dispatchResultText(
      '<message to="boys-night">And here is the follow-up note.</message>',
      ROUTING,
      /* addressed */ true,
      turnStartedAt,
      /* compactedDuringTurn */ false,
      /* taskTurn */ false,
    );

    const out = getUndeliveredMessages();
    const followup = out.filter((m) => {
      try {
        return JSON.parse(m.content).text === 'And here is the follow-up note.';
      } catch {
        return false;
      }
    });
    expect(followup).toHaveLength(1);
  });

  it('addressed + <internal>-only output: sends scoped failure fallback', () => {
    insertChannelDestination('boys-night');

    dispatchResultText('<internal>I cannot answer this, search failed</internal>', ROUTING, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(JSON.parse(out[0].content).text).toBe(
      "I couldn't complete that request or produce a reliable reply. Please try again.",
    );
  });

  it('addressed + compacted + internal-only output: stays silent after tool delivery completed the turn', async () => {
    insertChannelDestination('boys-night');
    const { writeMessageOut } = await import('./db/messages-out.js');
    const turnStartedAt = '2026-06-07 20:04:00';
    writeMessageOut({
      id: 'progress-ack',
      kind: 'chat',
      channel_type: ROUTING.channelType,
      platform_id: ROUTING.platformId,
      content: JSON.stringify({ text: 'Here are the requested photos.', files: ['one.jpg', 'two.jpg'] }),
    });

    dispatchResultText(
      '<internal>Resumed after compaction; the requested action may have completed.</internal>',
      ROUTING,
      true,
      turnStartedAt,
      true,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[1].content)).toEqual({ action: 'silent_turn_complete' });
  });

  it('addressed + compacted + internal-only output: notifies when nothing was delivered', () => {
    insertChannelDestination('boys-night');

    dispatchResultText(
      '<internal>Compacted before the requested action could be confirmed.</internal>',
      ROUTING,
      true,
      '2026-06-07 20:04:00',
      true,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('compacted before I could send a final status update');
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

  it('addressed + zero output but no origin channel: emits only silent control row', () => {
    const blankRouting: RoutingContext = {
      platformId: null,
      channelType: null,
      threadId: null,
      inReplyTo: null,
    };

    dispatchResultText('   ', blankRouting, true);

    // No channel to deliver fallback text to, so the runner emits only an
    // internal control row and does not fabricate a chat destination.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    expect(out[0].channel_type).toBeNull();
    expect(out[0].platform_id).toBeNull();
    expect(JSON.parse(out[0].content)).toEqual({
      action: 'silent_turn_complete',
    });
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

  it('matches the verbatim Boys Night 2026-08-01 text that slipped through', () => {
    // The live false failure. Every pre-fix pattern missed by a word or a
    // sentence boundary: the model wrote "Waiting **on**" (not "waiting
    // for"), and the period right after "prompt" stopped `[^.]*` from
    // reaching a pending-ish qualifier.
    expect(
      isAwaitingSensitiveConfirmation(
        '<internal>Precedent confirmed: same pattern as August. Waiting on the calendarList ' +
          'confirmation prompt. Ending turn without commentary per tool instruction.</internal>',
      ),
    ).toBe(true);
  });

  it('matches common paraphrases of the same pause', () => {
    expect(isAwaitingSensitiveConfirmation('<internal>Waiting on Google confirmation.</internal>')).toBe(true);
    expect(isAwaitingSensitiveConfirmation('Awaiting your confirmation.')).toBe(true);
    expect(isAwaitingSensitiveConfirmation('The confirmation card is up.')).toBe(true);
    expect(isAwaitingSensitiveConfirmation('Ending my turn without commentary.')).toBe(true);
  });
});

describe('confirmation-gate state (authoritative tool-result signal)', () => {
  it('flags the turn from the gate tool result, independent of model prose', () => {
    resetConfirmationGateState();
    expect(confirmationGatePaused()).toBe(false);
    // Verbatim gate pending-result, as the tool returns it.
    noteToolResult(
      "`google_call` is awaiting the user's confirmation (a prompt is already shown in chat). " +
        'Do NOT message the user about it and do NOT re-issue this call. End your turn now without commentary.',
      isAwaitingSensitiveConfirmation,
    );
    expect(confirmationGatePaused()).toBe(true);
  });

  it('ignores ordinary tool results and resets between turns', () => {
    resetConfirmationGateState();
    noteToolResult('{"items":[{"id":"tico","summary":"Tico"}]}', isAwaitingSensitiveConfirmation);
    noteToolResult('', isAwaitingSensitiveConfirmation);
    expect(confirmationGatePaused()).toBe(false);

    noteToolResult("is awaiting the user's confirmation", isAwaitingSensitiveConfirmation);
    expect(confirmationGatePaused()).toBe(true);
    // Reset is load-bearing: a sticky flag would silence the safety net for
    // genuinely broken later turns in the same container.
    resetConfirmationGateState();
    expect(confirmationGatePaused()).toBe(false);
  });
});

describe('shouldKeepaliveBridge', () => {
  // Guards the post-result keep-warm wedge fix (2026-05-20). The
  // keepalive's only job is bridging legitimate LLM-only gaps; past the
  // inactivity window it MUST step aside so host-sweep's stop-idle path
  // can fire on a stalled half-open stream. See STREAM_INACTIVITY_MS in
  // poll-loop.ts for the full incident context.
  const INACTIVITY = 5 * 60_000;

  it('bridges while the stream is freshly active', () => {
    const now = 1_000_000_000;
    expect(shouldKeepaliveBridge({ lastEventAt: now, now, inactivityMs: INACTIVITY })).toBe(true);
    expect(shouldKeepaliveBridge({ lastEventAt: now - 1_000, now, inactivityMs: INACTIVITY })).toBe(true);
  });

  it('bridges up to and including the inactivity boundary (slow LLM-only window stays alive)', () => {
    const now = 1_000_000_000;
    // Exactly at the boundary still counts as "recent enough" — a
    // healthy slow generation must not be killed by an off-by-one.
    expect(shouldKeepaliveBridge({ lastEventAt: now - INACTIVITY, now, inactivityMs: INACTIVITY })).toBe(true);
  });

  it('stops bridging once the inactivity window is exceeded (stalled half-open stream)', () => {
    const now = 1_000_000_000;
    expect(shouldKeepaliveBridge({ lastEventAt: now - INACTIVITY - 1, now, inactivityMs: INACTIVITY })).toBe(false);
    // Two-hour stall — the exact 2026-05-20 incident shape.
    expect(shouldKeepaliveBridge({ lastEventAt: now - 2 * 60 * 60_000, now, inactivityMs: INACTIVITY })).toBe(false);
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(
      query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      null,
      false,
      'TestBot',
      [],
      null,
      undefined,
      'prompt',
      undefined,
    );

    const out = getUndeliveredMessages();
    const delivered = out.filter((row) => row.kind === 'chat');
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0].content).text).toBe(budgetText);
    expect(delivered[0].platform_id).toBe('chan-1');
    expect(delivered[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('suppresses a terminal error result for a task-only turn', async () => {
    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: 'Both claude and codex have reached their usage limits.',
      isError: true,
    });

    await processQuery(
      query,
      ERR_ROUTING,
      ['task-1'],
      'claude',
      null,
      false,
      'TestBot',
      [
        {
          seriesId: 'series-1',
          taskId: 'task-1',
          dispatched: [],
          assistantText: null,
          written: false,
        },
      ],
      null,
      undefined,
      'task prompt',
      undefined,
    );

    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it('still nudges (and does not deliver) a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(
      query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      null,
      false,
      'TestBot',
      [],
      null,
      undefined,
      'prompt',
      undefined,
    );

    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

// --- Task-run turn wiring: the REAL processQuery path (one-door) ---
// These drive the actual call sites (autoAppendTaskLog at result-handling,
// shouldNudgeTaskBlocks gating, and follow-up turn reset). Deleting the wiring
// — not just the helpers — goes red here.

const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

function taskLogRows(): Array<{ text: string }> {
  return (
    getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log' ORDER BY seq").all() as Array<{
      content: string;
    }>
  ).map((r) => JSON.parse(r.content) as { text: string });
}
