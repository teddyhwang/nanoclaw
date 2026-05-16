/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { countDueMessages, getInboundSourceSessionId, insertMessage, migrateMessagesInTable } from './session-db.js';
import { INBOUND_SCHEMA } from './schema.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('countDueMessages', () => {
  it('ignores pending system responses because the runner filters them out', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger)
       VALUES (?, ?, ?, datetime('now'), 'pending', '{}', ?)`,
    ).run('sys-1', 2, 'system', 1);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger)
       VALUES (?, ?, ?, datetime('now'), 'pending', '{}', ?)`,
    ).run('ctx-1', 4, 'chat', 0);

    expect(countDueMessages(db)).toBe(0);

    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger)
       VALUES (?, ?, ?, datetime('now'), 'pending', '{}', ?)`,
    ).run('chat-1', 6, 'chat', 1);

    expect(countDueMessages(db)).toBe(1);
    db.close();
  });
});

describe('insertMessage', () => {
  const baseMsg = {
    kind: 'chat',
    timestamp: '2026-05-16T12:00:00.000Z',
    platformId: 'telegram:123',
    channelType: 'telegram',
    threadId: null,
    content: '{"text":"first"}',
    processAfter: null,
    recurrence: null,
  };

  it('is idempotent on a duplicate message id (no throw, no second row, original content kept)', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);

    insertMessage(db, { id: 'msg-1', ...baseMsg });

    // Same id re-delivered — shared session via two bindings, or a gap-recovery
    // replay of a message the live gateway already wrote. Must NOT throw the
    // `UNIQUE constraint failed: messages_in.id` that failed the route and
    // churned the DB into autoindex corruption pre-fix.
    expect(() => insertMessage(db, { id: 'msg-1', ...baseMsg, content: '{"text":"redelivered"}' })).not.toThrow();

    const rows = db.prepare('SELECT id, content FROM messages_in WHERE id = ?').all('msg-1') as Array<{
      id: string;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    // The first write wins; the duplicate is a no-op, not an upsert.
    expect(rows[0]!.content).toBe('{"text":"first"}');
    db.close();
  });

  it('still inserts a distinct message id after a duplicate is skipped', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);

    insertMessage(db, { id: 'msg-1', ...baseMsg });
    insertMessage(db, { id: 'msg-1', ...baseMsg }); // duplicate — skipped
    insertMessage(db, { id: 'msg-2', ...baseMsg });

    const count = (db.prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c;
    expect(count).toBe(2);
    db.close();
  });
});
