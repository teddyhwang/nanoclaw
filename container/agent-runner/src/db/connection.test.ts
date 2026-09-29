import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, isTransientInboundError, withInboundDb } from '../mailbox/sqlite/connection.js';

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

// The host commits inbound.db writes in journal_mode=DELETE, so between
// its page writes and the journal delete an `inbound.db-journal` is on
// disk. A reader that opens then sees a *hot journal*; rolling it back is
// a write, which a readonly handle refuses — so a plain SELECT throws
// `attempt to write a readonly database` (SQLITE_READONLY_ROLLBACK).
// Unclassified, that escaped withInboundDb and killed the runner from the
// idle poll (`Fatal error: attempt to write a readonly database`).
describe('withInboundDb — hot-journal READONLY retry', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * Freeze a writer mid-transaction by copying the db + its rollback
   * journal: the copy has a hot journal and no process holding its lock —
   * exactly what a readonly reader sees in the host's commit window.
   */
  function realHotJournalError(): unknown {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-journal-'));
    const live = path.join(dir, 'live.db');
    const writer = new Database(live);
    writer.exec('PRAGMA journal_mode = DELETE');
    writer.exec('CREATE TABLE t (v TEXT)');
    const insert = writer.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 200; i++) insert.run(`${i}`.padEnd(1000, 'x'));
    // A tiny cache spills modified pages to the db file mid-transaction,
    // so the frozen copy holds new pages with their originals in the journal.
    writer.exec('PRAGMA cache_size = 2');
    writer.exec('BEGIN');
    writer.exec("UPDATE t SET v = v || 'y'");
    const frozen = path.join(dir, 'inbound.db');
    fs.copyFileSync(live, frozen);
    fs.copyFileSync(`${live}-journal`, `${frozen}-journal`);
    // SQLite leaves the header magic zeroed until it syncs the journal at
    // commit (the host's commit window is exactly post-sync, pre-delete).
    // Stamp the real magic + nRec=0xffffffff ("size from file") to freeze
    // that synced state.
    const fd = fs.openSync(`${frozen}-journal`, 'r+');
    fs.writeSync(fd, Buffer.from('d9d505f920a163d7ffffffff', 'hex'), 0, 12, 0);
    fs.closeSync(fd);
    writer.exec('ROLLBACK');
    writer.close();
    const reader = new Database(frozen, { readonly: true });
    try {
      reader.prepare('SELECT count(*) FROM t').get();
      return null;
    } catch (err) {
      return err;
    } finally {
      reader.close();
    }
  }

  test('the real bun:sqlite hot-journal error is classified transient', () => {
    const err = realHotJournalError();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('attempt to write a readonly database');
    expect((err as { code?: string }).code).toBe('SQLITE_READONLY_ROLLBACK');
    expect(isTransientInboundError(err)).toBe(true);
  });

  test('retries a hot-journal READONLY read, then succeeds', () => {
    const hot = realHotJournalError();
    let calls = 0;
    const result = withInboundDb(() => {
      calls++;
      if (calls < 3) throw hot;
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  test.each([
    ['message text', 'attempt to write a readonly database', undefined],
    ['code in message', 'SQLITE_READONLY_ROLLBACK: attempt to write a readonly database', undefined],
    ['code property only', 'readonly', 'SQLITE_READONLY_RECOVERY'],
  ])('classifies READONLY variant as transient: %s', (_label, message, code) => {
    const err = Object.assign(new Error(message), code ? { code } : {});
    expect(isTransientInboundError(err)).toBe(true);
  });

  test('still does not classify an unrelated error as transient', () => {
    expect(isTransientInboundError(Object.assign(new Error('no such table: x'), { code: 'SQLITE_ERROR' }))).toBe(false);
  });
});
