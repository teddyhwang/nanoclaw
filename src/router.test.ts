/**
 * Focused unit tests for the engage-mode evaluator. Integration coverage
 * (fan-out, accumulate, fresh-session) lives in `host-core.test.ts`; this
 * file targets the regex/mention/sticky decision logic directly so it can
 * be reasoned about without seeding a session DB.
 */
import { describe, it, expect } from 'vitest';

import { _internals } from './router.js';
import type { MessagingGroupAgent } from './types.js';

const { evaluateEngage } = _internals;

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
