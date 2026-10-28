/**
 * N3: a container that floods outbound.db or holds a session DB lock must not
 * stall the host. getDueOutboundMessages is bounded in SQL, and async writes
 * wait out a lock without blocking the event loop.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSqliteBusy, retryWhileBusy } from './busy.js';
import { OUTBOUND_SCHEMA, INBOUND_SCHEMA } from './schema.js';
import { DUE_OUTBOUND_PAGE, getDueOutboundMessages, insertMessage, openInboundDb } from './session-db.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-busy-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('getDueOutboundMessages', () => {
  const seed = (n: number) => {
    const db = new Database(':memory:');
    db.exec(OUTBOUND_SCHEMA);
    const insert = db.prepare(
      "INSERT INTO messages_out (id, seq, timestamp, deliver_after, kind, content) VALUES (?, ?, ?, ?, 'chat', ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < n; i++)
        insert.run(`m${i}`, i * 2 + 2, new Date(1_700_000_000_000 + i * 1000).toISOString(), null, `{"i":${i}}`);
    })();
    return db;
  };

  it('returns at most one page of the oldest due rows from a flooded queue', () => {
    const db = seed(5000);
    const rows = getDueOutboundMessages(db);
    expect(rows).toHaveLength(DUE_OUTBOUND_PAGE);
    expect(rows[0]!.id).toBe('m0');
    expect(rows.at(-1)!.id).toBe(`m${DUE_OUTBOUND_PAGE - 1}`);
    db.close();
  });

  it('excludes delivered ids in SQL, so the page still holds undelivered rows, in order', () => {
    const db = seed(500);
    const delivered = new Set(Array.from({ length: 300 }, (_, i) => `m${i}`));
    const rows = getDueOutboundMessages(db, false, delivered, 50);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${300 + i}`));
    db.close();
  });

  it('pages by excluding seen ids, and keeps the not-yet-due filter', () => {
    const db = seed(10);
    db.prepare("UPDATE messages_out SET deliver_after = '2999-01-01T00:00:00Z' WHERE id = 'm1'").run();
    const seen = new Set<string>();
    const pages: string[][] = [];
    for (;;) {
      const page = getDueOutboundMessages(db, false, seen, 4).map((r) => r.id);
      if (!page.length) break;
      page.forEach((id) => seen.add(id));
      pages.push(page);
    }
    expect(pages.flat()).toEqual(['m0', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(getDueOutboundMessages(db, true, new Set(), 2).map((r) => r.id)).toEqual(['m0', 'm1']);
    db.close();
  });
});

describe('busy session DB', () => {
  const inboundPath = () => {
    const file = path.join(root, 'inbound.db');
    const db = new Database(file);
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    db.close();
    return file;
  };
  const message = (id: string) => ({
    id,
    kind: 'chat' as const,
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: '{}',
    processAfter: null,
    recurrence: null,
    trigger: true,
    sourceSessionId: null,
    onWake: false,
  });

  it('a container read lock fails a host write fast instead of stalling 5 s', () => {
    const file = inboundPath();
    // A container reader holding its read transaction open (SHARED lock).
    const reader = new Database(file, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM messages_in').get();
    const host = openInboundDb(file);
    try {
      const started = Date.now();
      let err: unknown;
      try {
        insertMessage(host, message('m1'), 2);
      } catch (e) {
        err = e;
      }
      expect(isSqliteBusy(err)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      reader.exec('COMMIT');
      reader.close();
      host.close();
    }
  });

  it('retryWhileBusy waits a lock out asynchronously: the event loop keeps running', async () => {
    const file = inboundPath();
    const reader = new Database(file, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM messages_in').get();
    const host = openInboundDb(file);
    let last = Date.now();
    let maxGap = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    setTimeout(() => {
      reader.exec('COMMIT');
      reader.close();
    }, 400);
    try {
      await expect(retryWhileBusy(() => insertMessage(host, message('m1'), 2))).resolves.toBe(true);
      // ~400 ms of waiting, yet the loop was never blocked for long (a
      // 5 s busy_timeout blocked it for the whole wait).
      expect(maxGap).toBeLessThan(200);
      expect(host.prepare('SELECT id FROM messages_in').pluck().all()).toEqual(['m1']);
    } finally {
      clearInterval(ticker);
      host.close();
    }
  });

  it('retryWhileBusy gives up after its deadline and never retries other errors', async () => {
    let calls = 0;
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    await expect(
      retryWhileBusy(
        () => {
          calls++;
          throw busy;
        },
        50,
        async () => {},
      ),
    ).rejects.toBe(busy);
    expect(calls).toBeGreaterThan(1);
    calls = 0;
    await expect(
      retryWhileBusy(() => {
        calls++;
        throw new Error('constraint');
      }),
    ).rejects.toThrow('constraint');
    expect(calls).toBe(1);
  });
});
