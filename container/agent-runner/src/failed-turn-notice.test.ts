import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import type { RoutingContext } from './formatter.js';
import {
  FAILED_TURN_EXCERPT_CHARS,
  FAILED_TURN_KEY,
  FAILED_TURN_TTL_MS,
  buildFailedTurnNotice,
  buildFailedTurnRecord,
  clearFailedTurn,
  consumeFailedTurnNotice,
  decideFailedTurn,
  failedTurnEligible,
  recordFailedTurn,
  requestExcerpt,
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
const other: RoutingContext = { ...nicole, platformId: 'telegram:999', inReplyTo: 'x' };
const prompt =
  '<context timezone="America/Toronto" />\n' +
  '<message id="1948" from="nicole-dm" sender="Nicole">What are top dishes</message>\n' +
  '<message id="1950" from="nicole-dm" sender="Nicole">https://maps.app.goo.gl/x</message>';
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

describe('requestExcerpt', () => {
  test('keeps only the <message> blocks, dropping the <context> header and runner notices', () => {
    const excerpt = requestExcerpt(`<system>rotated</system>\n\n${prompt}\nsuperseded notice`);
    expect(excerpt).not.toContain('<context');
    expect(excerpt).not.toContain('rotated');
    expect(excerpt).not.toContain('superseded notice');
    expect(excerpt).toContain('What are top dishes</message>');
    expect(excerpt).toContain('maps.app.goo.gl');
  });
  test('falls back to the prompt without header or system notices', () => {
    expect(requestExcerpt('<context timezone="UTC" />\n<system>x</system>\nplain request')).toBe('plain request');
  });
  test('bounds the stored excerpt', () => {
    const long = `<message id="1">${'x'.repeat(FAILED_TURN_EXCERPT_CHARS + 500)}</message>`;
    expect(requestExcerpt(long).length).toBe(FAILED_TURN_EXCERPT_CHARS + 1);
  });
});

describe('buildFailedTurnRecord', () => {
  test('joins several unfinished prompts for one route', () => {
    const record = buildFailedTurnRecord(
      nicole,
      ['<message id="1">first</message>', '<message id="2">second</message>'],
      t0,
    )!;
    expect(record.excerpt).toBe('<message id="1">first</message>\n<message id="2">second</message>');
    expect(record.failedAt).toBe(t0.toISOString());
  });
  test('an empty request records nothing', () => {
    expect(buildFailedTurnRecord(nicole, '<context timezone="UTC" />', t0)).toBeNull();
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
    expect(decideFailedTurn(record, other, t0)).toBe('keep');
    expect(decideFailedTurn(record, { ...nicole, threadId: 't1' }, t0)).toBe('keep');
  });
  test('null record drops', () => {
    expect(decideFailedTurn(null, nicole, t0)).toBe('drop');
  });
});

describe('buildFailedTurnNotice wording', () => {
  test('matches the new user notice, never the old operator copy, and guards effects', () => {
    const notice = buildFailedTurnNotice(buildFailedTurnRecord(nicole, prompt, t0)!);
    expect(notice).not.toMatch(/check the logs/i);
    expect(notice).toContain('short error notice');
    expect(notice).toContain('answer it once');
    expect(notice).toContain('Do not repeat any action that could have had an effect');
    expect(notice).toContain('Do not mention this note.');
  });
});

describe('consumeFailedTurnNotice (session_state)', () => {
  test('delivers once on the same route, then is gone', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, prompt, t0)!);
    const later = new Date(t0.getTime() + 28 * 60_000);
    const notice = consumeFailedTurnNotice({ ...nicole, inReplyTo: '8669837947:2267' }, later);
    expect(notice).toContain('What are top dishes');
    expect(notice).toContain('<failed_request>');
    expect(notice).not.toContain('<context');
    expect(stored()).toBeUndefined();
    expect(consumeFailedTurnNotice(nicole, later)).toBeUndefined();
  });

  test('routes in a shared session keep separate markers', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, prompt, t0)!);
    recordFailedTurn(buildFailedTurnRecord(other, '<message id="9">Bob request</message>', t0)!);
    const nicoleNotice = consumeFailedTurnNotice(nicole, t0);
    expect(nicoleNotice).toContain('What are top dishes');
    expect(nicoleNotice).not.toContain('Bob request');
    expect(stored()).toContain('Bob request');
    expect(consumeFailedTurnNotice(other, t0)).toContain('Bob request');
    expect(stored()).toBeUndefined();
  });

  test('a turn on another route leaves the marker untouched', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, prompt, t0)!);
    expect(consumeFailedTurnNotice(other, t0)).toBeUndefined();
    expect(stored()).toContain('What are top dishes');
  });

  test('expired marker is deleted without delivery, other fresh routes survive', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, prompt, t0)!);
    const late = new Date(t0.getTime() + FAILED_TURN_TTL_MS + 1);
    recordFailedTurn(buildFailedTurnRecord(other, '<message id="9">fresh</message>', late)!);
    expect(consumeFailedTurnNotice(nicole, late)).toBeUndefined();
    expect(stored()).not.toContain('What are top dishes');
    expect(stored()).toContain('fresh');
  });

  test('malformed marker is deleted without delivery', () => {
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(FAILED_TURN_KEY, '{not json', t0.toISOString());
    expect(consumeFailedTurnNotice(nicole, t0)).toBeUndefined();
    expect(stored()).toBeUndefined();
  });

  test('latest failure per route wins and clearFailedTurn (/clear) removes all', () => {
    recordFailedTurn(buildFailedTurnRecord(nicole, '<message id="1">first</message>', t0)!);
    recordFailedTurn(buildFailedTurnRecord(nicole, '<message id="2">second</message>', t0)!);
    expect(stored()).toContain('second');
    expect(stored()).not.toContain('first');
    clearFailedTurn();
    expect(stored()).toBeUndefined();
  });
});
