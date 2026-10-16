import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import type { RoutingContext } from './formatter.js';
import {
  FAILED_TURN_EXCERPT_CHARS,
  FAILED_TURN_KEY,
  FAILED_TURN_TTL_MS,
  buildFailedTurnRecord,
  clearFailedTurn,
  consumeFailedTurnNotice,
  decideFailedTurn,
  failedTurnEligible,
  recordFailedTurn,
} from './failed-turn-notice.js';

beforeEach(() => {
  initTestSessionDb();
});

const nicole: RoutingContext = {
  platformId: 'telegram:8669837947',
  channelType: 'telegram',
  threadId: null,
  inReplyTo: '8669837947:2264',
  taskFire: false,
};
const prompt =
  '<message id="1948" sender="Nicole">What are top dishes</message>\n' +
  '<message id="1950" sender="Nicole">https://maps.app.goo.gl/x</message>';
const t0 = new Date('2026-10-14T12:09:14.000Z');

function stored(): string | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(FAILED_TURN_KEY) as
    { value: string } | undefined;
  return row?.value;
}

describe('failedTurnEligible', () => {
  test('human chat route qualifies', () => {
    expect(failedTurnEligible(nicole, false)).toBe(true);
  });
  test('task turns, task fires, a2a, failure-notice wakes and routeless batches do not', () => {
    expect(failedTurnEligible(nicole, true)).toBe(false);
    expect(failedTurnEligible({ ...nicole, taskFire: true }, false)).toBe(false);
    expect(failedTurnEligible({ ...nicole, channelType: 'agent' }, false)).toBe(false);
    expect(failedTurnEligible({ ...nicole, failureNoticeWake: true }, false)).toBe(false);
    expect(failedTurnEligible({ ...nicole, platformId: null }, false)).toBe(false);
  });
});

describe('buildFailedTurnRecord', () => {
  test('bounds the stored excerpt', () => {
    const record = buildFailedTurnRecord(nicole, 'x'.repeat(FAILED_TURN_EXCERPT_CHARS + 500), t0)!;
    expect(record.excerpt.length).toBe(FAILED_TURN_EXCERPT_CHARS + 1);
    expect(record.failedAt).toBe(t0.toISOString());
  });
});

describe('decideFailedTurn', () => {
  const record = buildFailedTurnRecord(nicole, prompt, t0)!;
  test('same route within TTL delivers', () => {
    expect(decideFailedTurn(record, nicole, new Date(t0.getTime() + 28 * 60_000))).toBe('deliver');
  });
  test('expired or future-dated markers drop', () => {
    expect(decideFailedTurn(record, nicole, new Date(t0.getTime() + FAILED_TURN_TTL_MS + 1))).toBe('drop');
    expect(decideFailedTurn(record, nicole, new Date(t0.getTime() - 1000))).toBe('drop');
  });
  test('another route in a shared session keeps it for its own chat', () => {
    const other = { ...nicole, platformId: 'telegram:999' };
    expect(decideFailedTurn(record, other, t0)).toBe('keep');
    expect(decideFailedTurn(record, { ...nicole, threadId: 't1' }, t0)).toBe('keep');
  });
  test('null record drops', () => {
    expect(decideFailedTurn(null, nicole, t0)).toBe('drop');
  });
});

describe('consumeFailedTurnNotice (session_state)', () => {
  test('delivers once on the same route, then is gone', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, prompt, t0)!);
    const later = new Date(t0.getTime() + 28 * 60_000);
    const notice = consumeFailedTurnNotice({ ...nicole, inReplyTo: '8669837947:2267' }, later);
    expect(notice).toContain('What are top dishes');
    expect(notice).toContain('<failed_request>');
    expect(notice).toContain('Do not repeat any action');
    expect(stored()).toBeUndefined();
    expect(consumeFailedTurnNotice(nicole, later)).toBeUndefined();
  });

  test('other route leaves the marker untouched', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, prompt, t0)!);
    expect(consumeFailedTurnNotice({ ...nicole, platformId: 'telegram:999' }, t0)).toBeUndefined();
    expect(stored()).toBeDefined();
  });

  test('expired marker is deleted without delivery', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, prompt, t0)!);
    expect(consumeFailedTurnNotice(nicole, new Date(t0.getTime() + FAILED_TURN_TTL_MS + 1))).toBeUndefined();
    expect(stored()).toBeUndefined();
  });

  test('malformed marker is deleted without delivery', () => {
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(FAILED_TURN_KEY, '{not json', t0.toISOString());
    expect(consumeFailedTurnNotice(nicole, t0)).toBeUndefined();
    expect(stored()).toBeUndefined();
  });

  test('latest failure wins and clearFailedTurn (/clear) removes it', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, 'first', t0)!);
    recordFailedTurn(buildFailedTurnRecord(nicole, 'second', t0)!);
    expect(stored()).toContain('second');
    clearFailedTurn();
    expect(stored()).toBeUndefined();
  });
});
