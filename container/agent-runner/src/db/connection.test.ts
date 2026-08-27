import { beforeEach, describe, expect, test } from 'bun:test';

import { initTestSessionDb, withInboundDb } from '../mailbox/sqlite/connection.js';

// withInboundDb is the S405 fix: a transient SQLITE_CORRUPT on the
// inbound.db read (host writer + VirtioFS non-atomic page propagation
// during a journal_mode=DELETE commit) must be retried with a fresh
// connection rather than crashing the runner code=1 → respawn loop.
// These tests pin the retry orchestration: pass-through, retry-then-
// succeed, immediate throw for non-corrupt errors (no wasted retries),
// and exhaustion still throwing so behavior never silently degrades.

beforeEach(() => {
  initTestSessionDb();
});

function corruptError(): Error {
  // The exact text bun:sqlite surfaces; isTransientCorrupt matches on
  // message, not a driver-specific code.
  return new Error('database disk image is malformed');
}

describe('withInboundDb — S405 corrupt-read retry', () => {
  test('returns the callback result on first success (no retry)', () => {
    let calls = 0;
    const result = withInboundDb((db) => {
      calls++;
      // The db handle is real (test-mode in-memory singleton) so a
      // normal query works through the wrapper too.
      db.prepare('SELECT 1 AS one').get();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries on transient corrupt then succeeds, reopening each time', () => {
    let calls = 0;
    const result = withInboundDb(() => {
      calls++;
      if (calls < 3) throw corruptError();
      return calls;
    });
    // Failed twice (calls 1,2), succeeded on the 3rd.
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });

  test('does NOT retry a non-corrupt error — throws immediately', () => {
    let calls = 0;
    expect(() =>
      withInboundDb(() => {
        calls++;
        throw new Error('some unrelated logic bug');
      }),
    ).toThrow('some unrelated logic bug');
    // Exactly one attempt — retrying a real bug would mask it and
    // waste the backoff.
    expect(calls).toBe(1);
  });

  test('throws the corrupt error after retries are exhausted', () => {
    let calls = 0;
    expect(() =>
      withInboundDb(() => {
        calls++;
        throw corruptError();
      }),
    ).toThrow('database disk image is malformed');
    // INBOUND_CORRUPT_RETRIES=5 → 1 initial + 5 retries = 6 attempts.
    expect(calls).toBe(6);
  });

  test('also classifies a raw "SQLITE_CORRUPT" message as transient', () => {
    let calls = 0;
    const result = withInboundDb(() => {
      calls++;
      if (calls === 1) throw new Error('SQLITE_CORRUPT: malformed');
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  // The VirtioFS torn window also surfaces at *open* time, not only as a
  // malformed-page read: bun:sqlite reports CANTOPEN ("unable to open
  // database file") or NOTADB ("file is not a database") when the reader
  // opens while the host's journal is present or a short/zero file is
  // mid-propagation. These are the same transient race and must retry —
  // before this fix they escaped isTransientCorrupt and crash-looped the
  // Degenerates container (Barret @mentions in AI-chat went unanswered).
  test.each([
    ['unable to open database file', 'CANTOPEN text'],
    ['SQLITE_CANTOPEN: unable to open database file', 'CANTOPEN code'],
    ['file is not a database', 'NOTADB text'],
    ['SQLITE_NOTADB: file is not a database', 'NOTADB code'],
  ])('retries transient torn-open variant: %s', (message) => {
    let calls = 0;
    const result = withInboundDb(() => {
      calls++;
      if (calls === 1) throw new Error(message);
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });
});
