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

  it('a FIFO planted at -journal (read-only, read-write) does not hang the first read', () => {
    for (const mode of ['readonly', 'readwrite'] as const) {
      seed('outbound.db', "CREATE TABLE IF NOT EXISTS t (v); DELETE FROM t; INSERT INTO t VALUES ('x')");
      const journal = path.join(root, 'outbound.db-journal');
      fs.rmSync(journal, { force: true });
      execFileSync('mkfifo', [journal]);
      const started = Date.now();
      const db = open('outbound.db', mode);
      try {
        // Released: SQLite reads nothing from it (an I/O error at worst).
        db.prepare('SELECT v FROM t').all();
      } catch (err) {
        expect(String(err)).toMatch(/disk I\/O error/);
      } finally {
        db.close();
      }
      expect(Date.now() - started).toBeLessThan(10_000);
      fs.rmSync(journal);
    }
  });

  it('a read-only (0444) FIFO planted at -wal of a WAL database does not hang', () => {
    seed('outbound.db', "PRAGMA journal_mode = WAL; CREATE TABLE t (v); INSERT INTO t VALUES ('x')");
    for (const side of ['-wal', '-shm']) fs.rmSync(path.join(root, `outbound.db${side}`), { force: true });
    execFileSync('mkfifo', ['-m', '0444', path.join(root, 'outbound.db-wal')]);
    const started = Date.now();
    try {
      const db = open('outbound.db');
      try {
        db.prepare('SELECT v FROM t').all();
      } catch {
        /* an error is fine; a hang is not */
      } finally {
        db.close();
      }
    } catch {
      /* refusing at open is fine too */
    }
    expect(Date.now() - started).toBeLessThan(10_000);
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

  it('refuses a virtual table, even with its CREATE rewritten', () => {
    seed('outbound.db', 'CREATE VIRTUAL TABLE t USING fts5(v)');
    let db = open('outbound.db');
    expect(() => db.prepare('SELECT 1').get()).toThrow(/non-plain table/);
    db.close();
    const raw = new Database(path.join(root, 'outbound.db'));
    raw.unsafeMode(true);
    raw.pragma('writable_schema = ON');
    raw
      .prepare(
        "UPDATE sqlite_master SET sql = replace(sql, 'CREATE VIRTUAL', 'CREATE' || char(10) || 'VIRTUAL') WHERE name = 't'",
      )
      .run();
    raw.close();
    db = open('outbound.db');
    expect(() => db.prepare('SELECT * FROM t').all()).toThrow(UnsafeSessionDbError);
    db.close();
  });

  it.each([
    ['a generated column', 'CREATE TABLE t (a, b AS (length(hex(zeroblob(1000)))))'],
    ['an expression default', "CREATE TABLE t (a, b DEFAULT (strftime('%s','now')))"],
    ['a CHECK', 'CREATE TABLE t (a CHECK (length(a) < 10))'],
    ['an expression index', 'CREATE TABLE t (a); CREATE INDEX i ON t (lower(a))'],
    ['a partial index', 'CREATE TABLE t (a); CREATE INDEX i ON t (a) WHERE a > 0'],
  ])('refuses %s', (_label, sql) => {
    seed('outbound.db', sql);
    const db = open('outbound.db', 'readwrite');
    expect(() => db.prepare('SELECT * FROM t').all()).toThrow(UnsafeSessionDbError);
    expect(() => db.prepare('INSERT INTO t (a) VALUES (1)').run()).toThrow(UnsafeSessionDbError);
    db.close();
  });

  it('allows the host and runner schemas (literal defaults, single-row CHECK, column indexes)', () => {
    seed(
      'outbound.db',
      `CREATE TABLE s (id INTEGER PRIMARY KEY CHECK (id = 1), v TEXT NOT NULL DEFAULT '[]', n INTEGER DEFAULT 0, f REAL DEFAULT -1.5, x DEFAULT NULL);
       CREATE TABLE u (a TEXT UNIQUE, b); CREATE INDEX u_b ON u (b, a);`,
    );
    const db = open('outbound.db', 'readwrite');
    db.prepare('INSERT INTO s (id) VALUES (1)').run();
    expect(db.prepare('SELECT v, n FROM s').get()).toEqual({ v: '[]', n: 0 });
    // RETURNING writes take the write lock up front.
    expect(db.prepare("INSERT INTO u VALUES ('k', 1) RETURNING a").get()).toEqual({ a: 'k' });
    db.close();
  });

  // Rename a plain table to `name` in sqlite_master (writable_schema), the way
  // a container can plant an object under SQLite's reserved prefix.
  const rename = (from: string, to: string) => {
    const raw = new Database(path.join(root, 'outbound.db'));
    raw.unsafeMode(true);
    raw.pragma('writable_schema = ON');
    raw
      .prepare('UPDATE sqlite_master SET name = ?, tbl_name = ?, sql = replace(sql, ?, ?) WHERE name = ?')
      .run(to, to, `TABLE ${from}`, `TABLE ${to}`, from);
    raw.close();
  };

  it('refuses any sqlite_-named table except sqlite_sequence/stat1/stat4', () => {
    seed('outbound.db', 'CREATE TABLE evil (a CHECK (length(a) < 10)); CREATE TABLE t (v)');
    rename('evil', 'sqlite_evil');
    let db = open('outbound.db');
    expect(() => db.prepare('SELECT * FROM t').all()).toThrow(/reserved-name table "sqlite_evil"/);
    db.close();
    // A reserved-name virtual table is refused too (no prefix exemption).
    fs.rmSync(path.join(root, 'outbound.db'));
    seed('outbound.db', 'CREATE VIRTUAL TABLE vt USING fts5(v); CREATE TABLE t (v)');
    rename('vt', 'sqlite_vt');
    db = open('outbound.db');
    expect(() => db.prepare('SELECT * FROM t').all()).toThrow(UnsafeSessionDbError);
    db.close();
  });

  it("still checks SQLite's own tables as plain tables", () => {
    seed(
      'outbound.db',
      'CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, v); CREATE INDEX a_v ON a (v); INSERT INTO a (v) VALUES (1); ANALYZE',
    );
    const db = open('outbound.db');
    expect(db.prepare('SELECT v FROM a').all()).toEqual([{ v: 1 }]);
    db.close();
    // sqlite_sequence rewritten to carry an expression CHECK is refused.
    const raw = new Database(path.join(root, 'outbound.db'));
    raw.unsafeMode(true);
    raw.pragma('writable_schema = ON');
    raw
      .prepare(
        "UPDATE sqlite_master SET sql = 'CREATE TABLE sqlite_sequence(name CHECK (length(name) < 99),seq)' WHERE name = 'sqlite_sequence'",
      )
      .run();
    raw.close();
    const again = open('outbound.db');
    expect(() => again.prepare('SELECT v FROM a').all()).toThrow(/CHECK on table "sqlite_sequence"/);
    again.close();
  });

  it('waits only briefly on a container-held lock instead of 5 s', () => {
    seed('outbound.db', 'CREATE TABLE t (v)');
    const holder = new Database(path.join(root, 'outbound.db'));
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const db = open('outbound.db');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(20);
      const started = Date.now();
      expect(() => db.prepare('SELECT * FROM t').all()).toThrow(/locked|busy/i);
      expect(Date.now() - started).toBeLessThan(1000);
      db.close();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
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
