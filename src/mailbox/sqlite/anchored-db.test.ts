/**
 * openAnchoredDb against container moves beyond links: a FIFO at open time,
 * a container-authored schema (views, triggers, virtual tables), and a double
 * close reusing the directory descriptor number.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnchoredDir } from '../../anchored-dir.js';
import { assertPlainSchema, openAnchoredDb, UnsafeSessionDbError, withFifoWatchdog } from './anchored-db.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchored-db-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(name: string, sql: string): void {
  const db = new Database(path.join(root, name));
  db.exec(sql);
  db.close();
}
const open = (name: string, mode: 'readonly' | 'readwrite' = 'readonly', schema?: 'host' | 'container') =>
  openAnchoredDb(AnchoredDir.open(root, [])!, name, mode, schema ? { schema } : {});

describe('FIFO watchdog', () => {
  it('releases a read-only open of a FIFO instead of blocking the thread', () => {
    const fifo = path.join(root, 'outbound.db');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    // Without the watchdog this blocks forever (no writer).
    const fd = withFifoWatchdog(fifo, () => fs.openSync(fifo, fs.constants.O_RDONLY));
    fs.closeSync(fd);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('openAnchoredDb refuses a FIFO without hanging', () => {
    execFileSync('mkfifo', [path.join(root, 'outbound.db')]);
    expect(() => open('outbound.db')).toThrow(UnsafeSessionDbError);
  });

  it('never opens a regular file for writing', () => {
    seed('outbound.db', 'CREATE TABLE t (v)');
    const before = fs.statSync(path.join(root, 'outbound.db')).mtimeMs;
    const db = open('outbound.db');
    db.close();
    expect(fs.statSync(path.join(root, 'outbound.db')).mtimeMs).toBe(before);
  });
});

describe('container-authored schema', () => {
  it('reads plain tables normally, in either mode', () => {
    seed('outbound.db', "CREATE TABLE t (v TEXT); CREATE INDEX t_v ON t(v); INSERT INTO t VALUES ('a')");
    const ro = open('outbound.db');
    expect(ro.prepare('SELECT v FROM t').all()).toEqual([{ v: 'a' }]);
    expect([...ro.prepare('SELECT v FROM t').iterate()]).toEqual([{ v: 'a' }]);
    expect(ro.prepare('SELECT v FROM t').pluck().get()).toBe('a');
    expect(ro.inTransaction).toBe(false);
    ro.close();
    const rw = open('outbound.db', 'readwrite');
    rw.prepare("INSERT INTO t VALUES ('b')").run();
    rw.transaction(() => {
      rw.prepare("INSERT INTO t VALUES ('c')").run();
      expect(rw.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
    })();
    rw.pragma('journal_mode = DELETE');
    rw.close();
  });

  it('refuses a queried table swapped for a view (e.g. an endless recursive CTE)', () => {
    seed(
      'outbound.db',
      'CREATE VIEW messages_out AS WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n',
    );
    const db = open('outbound.db');
    expect(() => db.prepare('SELECT * FROM messages_out').get()).toThrow(/schema has a view/);
    expect(() => db.prepare('SELECT * FROM messages_out').all()).toThrow(/schema has a view/);
    expect(() => [...db.prepare('SELECT * FROM messages_out').iterate()]).toThrow(/schema has a view/);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('never fires a container-made trigger on a host write', () => {
    seed(
      'outbound.db',
      `CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT);
       CREATE TABLE log (v TEXT);
       CREATE TRIGGER t AFTER INSERT ON session_state BEGIN INSERT INTO log VALUES ('fired'); END;`,
    );
    const db = open('outbound.db', 'readwrite');
    expect(() => db.prepare("INSERT INTO session_state VALUES ('k', 'v')").run()).toThrow(/schema has a trigger/);
    db.close();
    const check = new Database(path.join(root, 'outbound.db'), { readonly: true });
    expect(check.prepare('SELECT count(*) AS n FROM session_state').get()).toEqual({ n: 0 });
    expect(check.prepare('SELECT count(*) AS n FROM log').get()).toEqual({ n: 0 });
    check.close();
  });

  it('refuses a schema changed after open (checked per statement)', () => {
    seed('outbound.db', 'CREATE TABLE t (v)');
    const db = open('outbound.db');
    const stmt = db.prepare('SELECT * FROM t');
    expect(stmt.all()).toEqual([]);
    seed('outbound.db', 'DROP TABLE t; CREATE VIEW t AS SELECT 1 AS v');
    expect(() => stmt.all()).toThrow(/schema has a view/);
    db.close();
  });

  it('refuses a virtual table', () => {
    seed('outbound.db', 'CREATE VIRTUAL TABLE t USING fts5(v)');
    const db = open('outbound.db');
    expect(() => db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toThrow(/schema has a table/);
    db.close();
  });

  it('host-owned files are not guarded; assertPlainSchema checks them on demand', () => {
    seed('inbound.db', 'CREATE TABLE t (v); CREATE VIEW w AS SELECT v FROM t');
    const db = open('inbound.db', 'readonly', 'host');
    expect(db.prepare('SELECT * FROM w').all()).toEqual([]);
    expect(() => assertPlainSchema(db, 'inbound.db')).toThrow(UnsafeSessionDbError);
    db.close();
  });
});

describe('close', () => {
  it('is idempotent: a second close never closes a reused directory descriptor number', () => {
    seed('outbound.db', 'CREATE TABLE t (v)');
    const db = open('outbound.db');
    db.close();
    // The directory fd number is free now; the next open reuses it.
    const other = fs.openSync(path.join(root, 'outbound.db'), 'r');
    try {
      db.close();
      expect(() => fs.fstatSync(other)).not.toThrow();
    } finally {
      fs.closeSync(other);
    }
  });
});
