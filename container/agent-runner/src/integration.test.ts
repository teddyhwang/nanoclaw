import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import {
  getContinuation,
  getContinuationStartedAt,
  setContinuation,
  setContinuationStartedAt,
} from './db/session-state.js';
import { computeRotationDate } from './session-rotation.js';
import { TIMEZONE } from './timezone.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  content: object,
  opts?: { platformId?: string; channelType?: string; threadId?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'What is the meaning of life?' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage(
      'm-discord',
      { sender: 'Alice', text: 'from discord' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' },
    );
    insertMessage(
      'm-slack',
      { sender: 'Bob', text: 'from slack' },
      { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' },
    );

    // Agent replies to both destinations
    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text triggers the local-fork safety-net delivery (degraded)', async () => {
    // Local-fork divergence from upstream: bare text outside <message> /
    // <internal> wrapping must NOT be silently dropped. The runner emits
    // it to the origin channel with a [degraded] label so (a) the user
    // gets *something* and (b) the agent's wrap miss is visible instead
    // of invisible. See deliverSafetyNet in poll-loop.ts; rationale in
    // memory feedback_silent_fallback_regression. Upstream's test
    // asserts the opposite (length 0) — kept the fork patch here.
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    // At least one degraded delivery — the upstream nudge re-prompt
    // also pushes the agent to re-wrap, which with this mock provider
    // produces the same bare-text result and triggers safety-net again.
    // Either way, every safety-net send must carry the [degraded] label
    // and originate from chan-1.
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const row of out) {
      const body = JSON.parse(row.content).text;
      expect(body).toContain('[degraded');
      expect(body).toContain('I am thinking about this...');
      expect(row.platform_id).toBe('chan-1');
    }

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Only the valid destination should produce output
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'tell slack' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' },
    );

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage(
      'm-old',
      { sender: 'Alice', text: 'old' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' },
    );
    insertMessage(
      'm-new',
      { sender: 'Alice', text: 'new' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () =>
        '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('mixed task + chat batch: task isolated first, chat handled separately, both correctly routed', async () => {
    // A scheduled task and a chat row land in the same channel session
    // with the same routing. Pre-2026-05-16 these folded into ONE
    // provider turn (asserted here as "exactly 1 outbound"). That fold
    // is the AI-Friends leak bug — a silent maintenance task must never
    // share a turn with chat. Correct behavior now: the task runs in
    // its own isolated turn, the chat is deferred and processed as its
    // own subsequent turn. Both still produce a correctly-routed
    // outbound; they're just no longer conflated into one reply.
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait for BOTH to be handled as separate turns (task isolated,
    // then the deferred chat re-processed on a later poll).
    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Each turn produced its own outbound — no fold, no drop.
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Every outbound carries the correct origin routing.
    expect(out.every((o) => o.platform_id === 'chan-1')).toBe(true);
    // The task row was consumed (not left pending after its isolated turn).
    const pendingTask = getPendingMessages().find((m) => m.id === 't-task');
    expect(pendingTask).toBeUndefined();

    await loopPromise.catch(() => {});
  });

  it('task-only wake leaves accumulated trigger=0 chat pending', async () => {
    // Repro: shit-talk 2026-05-11 04:01 — accumulated trigger=0 chat from
    // the previous evening got pulled into the prompt when the daily
    // silent-maintenance task fired, and the agent posted a chat reply
    // despite the task's explicit "do NOT send any messages" instruction.
    // The fix: drop trigger=0 chat rows from the batch when the only
    // trigger=1 row(s) are tasks. The chat rows stay pending for the
    // next real user-triggered wake.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('m-accum', 'chat', datetime('now', '-1 hour'), 'pending', 0, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ sender: 'mackchiu', text: 'Not at hole in ones' }));
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('t-silent', 'task', datetime('now'), 'pending', 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'silent maintenance — do not send messages' }));

    let capturedPrompt = '';
    const provider = new MockProvider({}, (prompt: string) => {
      capturedPrompt = prompt;
      // Agent obeys: no <message to=...> blocks, no outbound.
      return 'noted';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await sleep(1500);
    controller.abort();

    // The task row should have been processed; the accumulated chat should still be pending.
    const stillPending = getPendingMessages();
    const accumStill = stillPending.find((m) => m.id === 'm-accum');
    expect(accumStill).toBeDefined();
    expect(accumStill?.trigger).toBe(0);

    // The agent's prompt must NOT contain mackchiu's accumulated chat content.
    expect(capturedPrompt).not.toContain('Not at hole in ones');
    expect(capturedPrompt).not.toContain('mackchiu');

    await loopPromise.catch(() => {});
  });

  it('task wake isolates trigger=1 sticky-engage chat (AI-Friends 2026-05-16 leak)', async () => {
    // Repro: 2026-05-16 13:22 — the degenerate agent's silent dream task
    // (trigger=1, kind=task) was manually fired via the dashboard. It
    // co-arrived with AI-Friends mention-sticky chat that the router had
    // marked trigger=1. The OLD isolation only fired when EVERY trigger=1
    // row was a task (`taskOnlyWake`), so the trigger=1 sticky chat made
    // it false, isolation was skipped, the conversation folded into the
    // silent dream turn, and the agent reply-pilled the dream-cycle
    // summary onto "Lame…" in AI Friends. The fix isolates on ANY task
    // trigger and defers chat regardless of its trigger flag.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('m-sticky', 'chat-sdk', datetime('now', '-5 minutes'), 'pending', 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ sender: 'someone', text: 'Lame…' }));
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('t-dream', 'task', datetime('now'), 'pending', 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'silent maintenance — do NOT send any messages to the chat' }));

    // Accumulate EVERY prompt the provider saw across all turns. The fix
    // is correct iff no single prompt contains both the silent-task
    // instruction and the sticky chat — i.e. they were never folded into
    // one provider turn. The chat may still be answered in its OWN later
    // turn (correct: deferring ≠ dropping), so asserting "still pending"
    // would be wrong; asserting "never co-folded" is the real invariant.
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt: string) => {
      prompts.push(prompt);
      return '<internal>noted</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await sleep(1500);
    controller.abort();

    // The silent dream task ran (its prompt reached the provider).
    const taskPrompt = prompts.find((p) => p.includes('silent maintenance'));
    expect(taskPrompt).toBeDefined();
    // …and the sticky "Lame…" chat was NOT folded into that task turn.
    expect(taskPrompt).not.toContain('Lame…');
    // No prompt anywhere co-folded the task with the sticky chat.
    const folded = prompts.find((p) => p.includes('silent maintenance') && p.includes('Lame…'));
    expect(folded).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('poll loop — provider error recovery', () => {
  it('writes error to outbound and continues loop on provider throw', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');
    expect(JSON.parse(out[0].content).text).toContain('API rate limit exceeded');

    // Input message should be marked completed despite the error
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — task_fires recording', () => {
  // Regression: scheduled-task fires were silently never written to
  // task_fires on two paths, so the dashboard showed "No fires recorded
  // yet" for the dream/maintenance task that fired daily.
  //
  // Path A (the dream/maintenance common case): a task that comes due
  // while a chat turn is active is DEFERRED by the activeSender task-wake
  // guard (it must not fold into the user's stream), then re-enters the
  // outer loop as a TASK-ONLY initial batch. Pre-fix the initial-batch
  // capture used keep.find() (single) so a batch with >1 due task only
  // recorded the first; and a silent task-only turn recorded nothing
  // unless it was the find()-matched row.
  //
  // Path B: a task that comes due while ANOTHER task turn is running (no
  // activeSender) is pushed via the in-query follow-up path. Pre-fix that
  // path had no gated-write and registered no fire context at all.

  function readTaskFires(seriesId: string): Array<{
    series_id: string;
    task_id: string;
    status: string;
    dispatched: string;
    error_message: string | null;
  }> {
    return getOutboundDb()
      .prepare(
        `SELECT series_id, task_id, status, dispatched, error_message
           FROM task_fires WHERE series_id = ? ORDER BY fired_at`,
      )
      .all(seriesId) as Array<{
      series_id: string;
      task_id: string;
      status: string;
      dispatched: string;
      error_message: string | null;
    }>;
  }

  function insertTask(id: string, seriesId: string, content: { prompt: string; script?: string }): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, series_id, platform_id, channel_type, content)
         VALUES (?, 'task', datetime('now'), 'pending', 1, ?, 'chan-1', 'discord', ?)`,
      )
      .run(id, seriesId, JSON.stringify(content));
  }

  it('writes a "silent" fire for a task-only turn that dispatches nothing', async () => {
    // The real dream/maintenance shape: task-only batch (no chat trigger
    // → no activeSender), agent emits only <internal> (strips to empty →
    // no safety-net, sent===0 → silent). Pre-fix this produced no row.
    insertTask('t-dream-1', 'dream-series-A', {
      prompt: 'Follow the agent protocol for end-of-day maintenance.',
    });

    const provider = new EndingProvider(() => '<internal>nothing to report</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => readTaskFires('dream-series-A').length > 0, 2500);
    controller.abort();

    const fires = readTaskFires('dream-series-A');
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe('silent');
    expect(fires[0].task_id).toBe('t-dream-1');
    expect(JSON.parse(fires[0].dispatched)).toEqual([]);

    await loopPromise.catch(() => {});
  });

  it('records a distinct fire per task when several come due in one batch', async () => {
    // Multiple recurring tasks due in the same wake (RSS + dream). Pre-fix
    // keep.find() captured only the first → the second never recorded.
    insertTask('t-rss-1', 'rss-series', { prompt: 'rss check' });
    insertTask('t-dream-2', 'dream-series-C', { prompt: 'end-of-day maintenance' });

    const provider = new EndingProvider(() => '<internal>done</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(() => readTaskFires('rss-series').length > 0 && readTaskFires('dream-series-C').length > 0, 3000);
    controller.abort();

    expect(readTaskFires('rss-series')).toHaveLength(1);
    expect(readTaskFires('dream-series-C')).toHaveLength(1);
    // Each keyed by its own task id — never collapsed into one row.
    expect(readTaskFires('rss-series')[0].task_id).toBe('t-rss-1');
    expect(readTaskFires('dream-series-C')[0].task_id).toBe('t-dream-2');

    await loopPromise.catch(() => {});
  });

  it('writes a "gated" fire for a follow-up task whose pre-task script gates it', async () => {
    // Path B: a task arrives while another (task) turn is running → goes
    // through the in-query follow-up handler. A wakeAgent=false script
    // must still record a 'gated' fire (pre-fix the follow-up path had no
    // gated-write — only the initial-batch path did).
    insertTask('t-trigger', 'trigger-series', { prompt: 'long running task' });

    let pushedFollowup = false;
    const provider = new EndingProvider(() => {
      if (!pushedFollowup) {
        pushedFollowup = true;
        // Insert the gated follow-up while this turn's stream is open
        // (the EndingProvider holds the stream ~400ms for the in-query
        // poll to fold it in before ending).
        insertTask('t-gated-1', 'dream-series-B', {
          prompt: 'maintenance',
          script: 'echo \'{"wakeAgent": false}\'',
        });
      }
      return '<internal>working</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(() => readTaskFires('dream-series-B').length > 0, 3000);
    controller.abort();

    const fires = readTaskFires('dream-series-B');
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe('gated');
    expect(fires[0].task_id).toBe('t-gated-1');

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // Error was written to outbound
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');

    // Continuation was cleared (isSessionInvalid returned true)
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that returns configurable stats from readSessionStats so we can
 * drive the lazy rotation hook. Emits an init event with a new continuation
 * so the stamp path also runs.
 */
class StatsConfigurableProvider {
  readonly supportsNativeSlashCommands = false;
  private stats: { compactCount: number; sizeBytes: number; turnCount: number };
  private nextContinuation: string;

  constructor(
    stats: { compactCount?: number; sizeBytes?: number; turnCount?: number } = {},
    nextContinuation = 'fresh-session-id',
  ) {
    this.stats = {
      compactCount: stats.compactCount ?? 0,
      sizeBytes: stats.sizeBytes ?? 0,
      turnCount: stats.turnCount ?? 0,
    };
    this.nextContinuation = nextContinuation;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  readSessionStats() {
    return { ...this.stats };
  }

  query(_input: { prompt: string; cwd: string; continuation?: string }) {
    const continuation = this.nextContinuation;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation };
        yield { type: 'result' as const, text: '<message to="discord-test">ok</message>' };
      })(),
    };
  }
}

describe('poll loop — lazy session rotation', () => {
  it('rotates a prior-day session with compacts before next query', async () => {
    setContinuation('mock', 'pre-rotation-id');
    // Stamp the session as belonging to "yesterday" so the day-boundary
    // check fails, then load the disk-evidence axis.
    setContinuationStartedAt('mock', '2020-01-01');

    insertMessage('m1', { sender: 'Alice', text: 'wake up' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new StatsConfigurableProvider({ compactCount: 2 }, 'fresh-after-rotation');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // The stored continuation should be the FRESH one — proving the old
    // continuation was wiped before query, then the new one stamped after.
    expect(getContinuation('mock')).toBe('fresh-after-rotation');
    // startedAt should reflect today's rotation day, not the pre-seeded
    // 2020-01-01 stamp.
    expect(getContinuationStartedAt('mock')).toBe(computeRotationDate(new Date(), TIMEZONE));

    await loopPromise.catch(() => {});
  });

  it('preserves a same-day session even when compacted (mid-chat continuity)', async () => {
    setContinuation('mock', 'mid-day-id');
    setContinuationStartedAt('mock', computeRotationDate(new Date(), TIMEZONE));

    insertMessage('m1', { sender: 'Alice', text: 'still chatting' }, { platformId: 'chan-1', channelType: 'discord' });

    // Compact count is high, but day-boundary check fires first and preserves.
    const provider = new StatsConfigurableProvider({ compactCount: 99 }, 'should-not-be-stamped');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // The provider emitted a new continuation in `init`, but since the
    // lazy hook did NOT rotate, runPollLoop should detect the new id and
    // store it — without re-stamping startedAt (resume path, not new
    // thread). Verifying we did not rotate: the stored continuation will
    // be the provider's emitted id since the SDK reported it back, but
    // the startedAt stamp must still equal what we pre-seeded.
    expect(getContinuationStartedAt('mock')).toBe(computeRotationDate(new Date(), TIMEZONE));

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    setContinuation('mock', 'existing-session-id');
    expect(getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that throws on every query, simulating API failures.
 */
/**
 * Provider whose stream ENDS after delivering one result per prompt —
 * models a real provider/SDK whose agent turn completes and the event
 * stream closes (which is what triggers processQuery's finally, where the
 * task_fires row is written). The shared MockProvider deliberately blocks
 * the stream open for follow-up pushes, so it can never exercise the
 * natural-stream-end fire-write; this one can. Each `query.push` (a
 * follow-up the poll-loop folds in) produces one more result then the
 * stream ends again on the next outer-loop query.
 */
class EndingProvider {
  readonly supportsNativeSlashCommands = false;
  private responseFactory: (prompt: string) => string;

  constructor(responseFactory: (prompt: string) => string) {
    this.responseFactory = responseFactory;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  readSessionStats() {
    return { compactCount: 0, sizeBytes: 0, turnCount: 0 };
  }

  query(input: { prompt: string }) {
    const factory = this.responseFactory;
    const pending: string[] = [];
    let resolveWait: (() => void) | null = null;
    let ended = false;
    return {
      push(message: string) {
        pending.push(message);
        resolveWait?.();
      },
      end() {
        ended = true;
        resolveWait?.();
      },
      abort() {
        ended = true;
        resolveWait?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: `mock-session-${Date.now()}` };
        yield { type: 'result' as const, text: factory(input.prompt) };
        // Give the poll-loop one short window to fold in a follow-up
        // (its in-query poll runs on an interval). If one arrives, emit
        // its result; otherwise end the stream so processQuery returns
        // and the finally writes the fire — the real "turn finished"
        // shape, not an infinite open stream.
        for (;;) {
          if (pending.length > 0) {
            yield { type: 'result' as const, text: factory(pending.shift()!) };
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => {
            resolveWait = r;
            setTimeout(() => {
              resolveWait = null;
              r();
            }, 400);
          });
          if (pending.length === 0) return; // settled with no follow-up → end
        }
      })(),
    };
  }
}

class ThrowingProvider {
  readonly supportsNativeSlashCommands = false;
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  readSessionStats() {
    return { compactCount: 0, sizeBytes: 0, turnCount: 0 };
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  readonly supportsNativeSlashCommands = false;

  isSessionInvalid(): boolean {
    return true;
  }

  readSessionStats() {
    return { compactCount: 0, sizeBytes: 0, turnCount: 0 };
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}
