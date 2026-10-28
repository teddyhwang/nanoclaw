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
import { readUndelivered } from '../undelivered.js';
import type { OutboundMessage } from '../types.js';

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

  it('ids returns exactly those rows however deep in the queue (stop notice: recent deliveries)', () => {
    const db = seed(250);
    const recent = new Set(['m249', 'm248', 'm3']);
    const rows = getDueOutboundMessages(db, true, new Set(), recent.size, { ids: recent });
    expect(rows.map((r) => r.id)).toEqual(['m3', 'm248', 'm249']);
    expect(getDueOutboundMessages(db, true, new Set(), 10, { ids: new Set() })).toEqual([]);
    db.close();
  });

  it('destinationless returns only rows delivery never holds per destination', () => {
    const db = seed(5);
    db.prepare("UPDATE messages_out SET channel_type = 'discord', platform_id = 'p' WHERE id != 'm2'").run();
    db.prepare("UPDATE messages_out SET kind = 'system' WHERE id = 'm4'").run();
    const rows = getDueOutboundMessages(db, false, new Set(), 10, { destinationless: true });
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm4']);
    db.close();
  });
});

describe('readUndelivered', () => {
  // A mailbox over a real outbound DB, mapping rows the way the SQLite
  // mailbox does (timestamp/sequence are what readUndelivered orders by).
  const mailboxOver = (db: Database.Database) => ({
    getDueMessages: (
      exclude?: ReadonlySet<string>,
      o?: { includeNotYetDue?: boolean; limit?: number; destinationless?: boolean },
    ) =>
      getDueOutboundMessages(db, o?.includeNotYetDue === true, exclude, o?.limit, o).map(
        (r) => ({ ...r, sequence: r.seq, channelType: r.channel_type }) as unknown as OutboundMessage,
      ),
  });
  const flood = (held: number) => {
    const db = new Database(':memory:');
    db.exec(OUTBOUND_SCHEMA);
    const insert = db.prepare(
      'INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, platform_id, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const at = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();
    db.transaction(() => {
      // A backlog held for an unavailable channel (stays undelivered).
      for (let i = 0; i < held; i++) insert.run(`held${i}`, i + 1, at(i), 'chat', 'discord', 'down', '{}');
      // Written later: a reply elsewhere and the runner's turn bind.
      insert.run('reply', held + 1, at(held), 'chat', 'discord', 'up', '{}');
      insert.run('identity_turn_begin', held + 2, at(held + 1), 'system', null, null, '{}');
    })();
    return db;
  };

  it('a held backlog over one page never hides later rows', () => {
    const db = flood(DUE_OUTBOUND_PAGE + 50);
    const rows = readUndelivered(mailboxOver(db), new Set());
    expect(rows).toHaveLength(DUE_OUTBOUND_PAGE + 52);
    expect(rows.slice(-2).map((r) => r.id)).toEqual(['reply', 'identity_turn_begin']);
    db.close();
  });

  it('past the page cap, system rows are still read, in queue order', () => {
    const db = flood(30);
    const rows = readUndelivered(mailboxOver(db), new Set(['held0']), { maxPages: 1 });
    // Only one page of 200 would fit everything here, so cap via a tiny page.
    expect(rows.at(-1)!.id).toBe('identity_turn_begin');
    const capped = readUndelivered(
      {
        getDueMessages: (exclude, o) => mailboxOver(db).getDueMessages(exclude, { ...o, limit: 5 }),
      },
      new Set(),
      { maxPages: 2 },
    );
    expect(capped.map((r) => r.id)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `held${i}`),
      'identity_turn_begin',
    ]);
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
