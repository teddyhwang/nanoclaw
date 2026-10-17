import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { _resetShutdownStateForTests, prependDeliveryFeedback, runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  _resetShutdownStateForTests();
  initTestSessionDb();
  getInboundDb().exec(`
    INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
    VALUES ('test-chat', 'Test', 'channel', 'whatsapp', 'synthetic-chat');
    INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
    VALUES ('request', 'chat', '2026-10-11T06:11:00Z', 'pending', 1, 'synthetic-chat', 'whatsapp',
      '{"sender":"Synthetic","text":"Please prepare the backup plan","isMention":true}');
  `);
});
afterEach(() => {
  closeSessionDb();
  _resetShutdownStateForTests();
});

// Real poll loop + SQLite mailboxes; result-only contract matches Pi RPC.
// Simulate the tool ack before the provider's malformed substantive final.
async function runFixture(
  final: string,
  retry: string,
  streamed = false,
  toolText: string | null = 'I will prepare the plan.',
  delivered = false,
) {
  const pushed: string[] = [];
  let toolCalls = 0;
  const provider: AgentProvider = {
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    query: () => ({
      delivery: { providerName: 'synthetic', emitsMidTurnText: streamed },
      push: (prompt) => {
        pushed.push(prompt);
      },
      end: () => {},
      abort: () => {},
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'synthetic' };
        if (toolText !== null) {
          toolCalls++;
          await writeMessageOut({
            id: 'ack',
            kind: 'chat',
            channel_type: 'whatsapp',
            platform_id: 'synthetic-chat',
            in_reply_to: 'request',
            content: JSON.stringify({ text: toolText }),
          });
          if (delivered)
            getInboundDb()
              .prepare(
                "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES ('ack', 'synthetic-receipt', 'delivered', ?)",
              )
              .run(new Date().toISOString());
        }
        if (streamed) yield { type: 'text', text: final };
        yield { type: 'result', text: final };
        if (pushed.length) {
          if (streamed) yield { type: 'text', text: retry };
          yield { type: 'result', text: retry };
        }
      })(),
    }),
  };
  const controller = new AbortController();
  const exchanges: unknown[] = [];
  // Don't abort on the initial result: its exchange callback precedes pushRetry.
  provider.onExchangeComplete = (exchange) => {
    exchanges.push(exchange);
    if (exchange.status !== 'undelivered' || exchanges.length > 1) controller.abort();
  };
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await runPollLoop({
      provider,
      providerName: 'synthetic',
      providerContract: { textDelivery: streamed ? 'mid-turn-complete' : 'result', commands: { formatting: 'xml' } },
      cwd: '/tmp',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  return {
    pushed,
    toolCalls,
    chat: getUndeliveredMessages().filter((row) => row.kind === 'chat'),
    feedback: prependDeliveryFeedback('next turn'),
  };
}

const answer = 'Backup plan: owner A, deputy B, handover one month.';
const wrapped = `<message to="test-chat">${answer}</message>`;
describe.each([false, true])('acknowledgment must not hide malformed substantive output (streamed=%s)', (streamed) => {
  it.each([`${answer}</message>`, `<message>${answer}</message>`])(
    'retries malformed wrapping after tool ack: %s',
    async (final) => {
      const result = await runFixture(final, wrapped, streamed, 'I will prepare the plan.', true);
      expect(result.pushed).toHaveLength(1);
      expect(result.toolCalls).toBe(1);
      expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual(['I will prepare the plan.', answer]);
      expect(result.chat[1].in_reply_to).toBe('request');
    },
  );

  it.each([`${answer}</message>`, ''])(
    'exhausts one retry with a scoped failure, never raw prose: %s',
    async (retry) => {
      const result = await runFixture(`${answer}</message>`, retry, streamed);
      expect(result.pushed).toHaveLength(1);
      expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual([
        'I will prepare the plan.',
        "I couldn't complete that request or produce a reliable reply. Please try again.",
      ]);
    },
  );

  it('rewraps malformed output without a prior acknowledgment', async () => {
    const result = await runFixture(`${answer}</message>`, wrapped, streamed, null);
    expect(result.pushed).toHaveLength(1);
    expect(result.toolCalls).toBe(0);
    expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual([answer]);
  });

  it.each([false, true])('does not duplicate substance already queued or delivered (receipt=%s)', async (delivered) => {
    const result = await runFixture(`${answer}</message>`, wrapped, streamed, answer, delivered);
    expect(result.pushed).toHaveLength(0);
    expect(result.toolCalls).toBe(1);
    expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual([answer]);
  });

  it.each([
    ['valid', wrapped, [answer]],
    ['internal only', '<internal>Private tool notes <message>SECRET</message></internal>', []],
    ['explicit silence', '<internal>silent turn</internal>', []],
    ['tool echo', 'I will prepare the plan.</message>', []],
    ['valid tool echo', '<message to="test-chat">I will prepare the plan.</message>', []],
  ] as const)('preserves control %s without retry or leak', async (_label, final, expected) => {
    const result = await runFixture(final, wrapped, streamed);
    expect(result.pushed).toHaveLength(0);
    expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual(['I will prepare the plan.', ...expected]);
    expect(result.toolCalls).toBe(1);
  });

  it('informs a retry after bare bookkeeping rather than assuming the tool acknowledgment answered', async () => {
    const result = await runFixture('Tool completed; private bookkeeping.', '<internal>done</internal>', streamed);
    expect(result.pushed).toHaveLength(1);
    expect(result.pushed[0]).toContain('<sent_message to="test-chat">I will prepare the plan.</sent_message>');
    expect(result.pushed[0]).toContain('<undelivered_text>Tool completed; private bookkeeping.</undelivered_text>');
    expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual(['I will prepare the plan.']);
    expect(result.toolCalls).toBe(1);
  });

  it('retains reason-specific refusal diagnostics in an informed retry after an acknowledgment', async () => {
    const result = await runFixture(`<message bogus="x">${answer}</message>`, wrapped, streamed);
    expect(result.pushed).toHaveLength(1);
    expect(result.pushed[0]).toContain('was wrapped, but it was refused');
    expect(result.pushed[0]).toContain('no to=&quot;name&quot; attribute');
    expect(result.pushed[0]).not.toContain('it was not wrapped');
    expect(result.pushed[0]).toContain('<sent_message to="test-chat">I will prepare the plan.</sent_message>');
    expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual(['I will prepare the plan.', answer]);
  });

  it.each([answer, `\n${answer}\n`])(
    'does not send an addressed fallback when the retry repeats its original full tool reply: %s',
    async (body) => {
      const result = await runFixture('Sent.', `<message to="test-chat">${body}</message>`, streamed, body);
      expect(result.pushed).toHaveLength(1);
      expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual([body]);
    },
  );

  it('keeps next-turn refusal feedback when the informed retry is exhausted', async () => {
    const malformed = `<message bogus="x">${answer}</message>`;
    const result = await runFixture(malformed, malformed, streamed);
    expect(result.pushed).toHaveLength(1);
    const feedback = JSON.parse(result.feedback.split('\n')[0]).delivery_feedback.join('\n');
    expect(feedback).toContain('no to="name" attribute');
    expect(feedback).toContain('that block was not posted');
    expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual([
      'I will prepare the plan.',
      "I couldn't complete that request or produce a reliable reply. Please try again.",
    ]);
  });

  it('rewraps only missing output: retry tool echo is deduplicated, internal text stays private', async () => {
    const result = await runFixture(
      `${answer}</message>`,
      `<internal>SECRET</internal><message to="test-chat">I will prepare the plan.</message>${wrapped}${wrapped}`,
      streamed,
    );
    expect(result.pushed).toHaveLength(1);
    expect(result.chat.map((row) => JSON.parse(row.content).text)).toEqual(['I will prepare the plan.', answer]);
    expect(result.toolCalls).toBe(1);
  });
});
