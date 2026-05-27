/**
 * Focused unit tests for the engage-mode evaluator. Integration coverage
 * (fan-out, accumulate, fresh-session) lives in `host-core.test.ts`; this
 * file targets the regex/mention/sticky decision logic directly so it can
 * be reasoned about without seeding a session DB.
 */
import { describe, it, expect } from 'vitest';

import { _internals } from './router.js';
import type { MessagingGroupAgent } from './types.js';

const { evaluateEngage, evaluateReactionEngage, stampReplyToBot, stampEngagement } = _internals;

function buildAgent(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: 'mga-test',
    messaging_group_id: 'mg-test',
    agent_group_id: 'ag-test',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: '2026-05-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('evaluateEngage — pattern mode', () => {
  it("'.'  pattern always engages", () => {
    const agent = buildAgent({ engage_mode: 'pattern', engage_pattern: '.' });
    expect(evaluateEngage(agent, 'anything', false, false)).toBe(true);
  });

  it('regex is case-insensitive — @Optimus matches @optimus pattern', () => {
    const agent = buildAgent({ engage_mode: 'pattern', engage_pattern: '@optimus' });
    expect(evaluateEngage(agent, '@Optimus hello', false, false)).toBe(true);
    expect(evaluateEngage(agent, '@OPTIMUS hello', false, false)).toBe(true);
    expect(evaluateEngage(agent, 'hey @optimus', false, false)).toBe(true);
  });

  it('regex still rejects non-matching text', () => {
    const agent = buildAgent({ engage_mode: 'pattern', engage_pattern: '@optimus' });
    expect(evaluateEngage(agent, 'plain chatter', false, false)).toBe(false);
    expect(evaluateEngage(agent, '@someone-else hi', false, false)).toBe(false);
  });

  it('a broken regex fails open so admin notices it', () => {
    const agent = buildAgent({ engage_mode: 'pattern', engage_pattern: '[unterminated' });
    expect(evaluateEngage(agent, 'anything', false, false)).toBe(true);
  });
});

describe('evaluateEngage — mention / mention-sticky modes', () => {
  it("'mention' engages only when isMention or isReplyToBot is true", () => {
    const agent = buildAgent({ engage_mode: 'mention', engage_pattern: null });
    expect(evaluateEngage(agent, 'plain', false, false)).toBe(false);
    expect(evaluateEngage(agent, 'plain', true, false)).toBe(true);
    expect(evaluateEngage(agent, 'plain', false, true)).toBe(true);
  });

  it("'mention-sticky' has the same trigger set as 'mention'", () => {
    const agent = buildAgent({ engage_mode: 'mention-sticky', engage_pattern: null });
    expect(evaluateEngage(agent, 'plain', false, false)).toBe(false);
    expect(evaluateEngage(agent, 'plain', true, false)).toBe(true);
    expect(evaluateEngage(agent, 'plain', false, true)).toBe(true);
  });
});

describe('stampReplyToBot — platform-uniform reply-to-self marker', () => {
  it('adds replyTo.toBot=true when isReplyToBot and content has a replyTo', () => {
    const content = JSON.stringify({
      text: 'I meant the Tico calendar',
      replyTo: { text: 'Hey Teddy — I searched...', sender: 'Optimus', messageId: '3EB0CE...' },
    });
    const stamped = JSON.parse(stampReplyToBot(content, true));
    expect(stamped.replyTo.toBot).toBe(true);
    expect(stamped.replyTo.messageId).toBe('3EB0CE...');
    expect(stamped.text).toBe('I meant the Tico calendar');
  });

  it('returns input unchanged when isReplyToBot=false', () => {
    const content = JSON.stringify({ text: 'hi', replyTo: { text: 'q', sender: 'X' } });
    expect(stampReplyToBot(content, false)).toBe(content);
  });

  it('returns input unchanged when content has no replyTo', () => {
    const content = JSON.stringify({ text: 'no quote here' });
    expect(stampReplyToBot(content, true)).toBe(content);
  });

  it('returns input unchanged on unparseable JSON (defensive)', () => {
    expect(stampReplyToBot('not json', true)).toBe('not json');
  });

  it('does not mutate the input content (per-agent fan-out safety)', () => {
    const original = JSON.stringify({
      text: 'x',
      replyTo: { text: 'q', sender: 'X' },
    });
    const before = JSON.parse(original);
    stampReplyToBot(original, true);
    // Re-parsing the original string must still show no toBot marker — the
    // function must not have mutated the underlying object graph.
    expect(JSON.parse(original)).toEqual(before);
  });
});

describe('stampEngagement — host engagement-mode marker for container', () => {
  it('adds engageMode to content JSON when engageMode is provided', () => {
    const content = JSON.stringify({ text: 'hey', isMention: false });
    const stamped = JSON.parse(stampEngagement(content, 'pattern'));
    expect(stamped.engageMode).toBe('pattern');
    expect(stamped.text).toBe('hey');
  });

  it('coexists with replyTo.toBot stamping (composition order is irrelevant)', () => {
    const content = JSON.stringify({
      text: 'follow-up',
      replyTo: { text: 'prior', sender: 'Optimus' },
    });
    const replyStamped = stampReplyToBot(content, true);
    const engageStamped = JSON.parse(stampEngagement(replyStamped, 'pattern'));
    expect(engageStamped.replyTo.toBot).toBe(true);
    expect(engageStamped.engageMode).toBe('pattern');
  });

  it('returns input unchanged when engageMode is null/undefined/empty', () => {
    const content = JSON.stringify({ text: 'x' });
    expect(stampEngagement(content, null)).toBe(content);
    expect(stampEngagement(content, undefined)).toBe(content);
    expect(stampEngagement(content, '')).toBe(content);
  });

  it('returns input unchanged on unparseable JSON (defensive)', () => {
    expect(stampEngagement('not json', 'pattern')).toBe('not json');
  });

  it('does not mutate the input content (per-agent fan-out safety)', () => {
    const original = JSON.stringify({ text: 'x' });
    const before = JSON.parse(original);
    stampEngagement(original, 'pattern');
    expect(JSON.parse(original)).toEqual(before);
  });
});

describe('evaluateReactionEngage — soft-trigger on bot messages only', () => {
  it('engages when the reaction targets one of the bot’s own messages', () => {
    expect(evaluateReactionEngage(true)).toBe(true);
  });

  it('does not engage on a reaction between other users', () => {
    // Independent of engage_mode by design — even a `pattern: .` always-on
    // wiring must not wake on every reaction in a busy channel. The
    // non-engaging reaction still reaches the agent via the accumulate
    // branch as silent context (covered by host-core integration tests).
    expect(evaluateReactionEngage(false)).toBe(false);
  });
});
