/**
 * The session folder is mounted read-write into the container, so the
 * container can plant a symlink under any name the host later opens. These
 * tests plant one at each mailbox write path and require that the host never
 * creates, modifies or migrates through it, plus the one-time move of
 * inbound.db into the read-only-mounted mailbox folder without losing rows.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-session-files';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-files/data' };
});

import { AnchoredDir } from '../../anchored-dir.js';
import { openAnchoredDb } from './anchored-db.js';
import { SqliteAgentMailbox } from './index.js';
import { openInboundReadonlyAt } from './session-files.js';
import { INBOUND_SCHEMA } from './schema.js';

const KEY = { agentGroupId: 'ag-a', sessionId: 'sess-a' };
const SESSION = path.join(ROOT, 'data', 'v2-sessions', 'ag-a', 'sess-a');
const OUTSIDE = path.join(ROOT, 'outside');
const MAILBOX = path.join(SESSION, 'mailbox');

function writeLegacyInbound(file: string, ids: string[]): void {
  const db = new Database(file);
  db.pragma('journal_mode = DELETE');
  db.exec(INBOUND_SCHEMA);
  const insert = db.prepare(
    "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', ?)",
  );
  ids.forEach((id, index) => insert.run(id, (index + 1) * 2, `{"text":"${id}"}`));
  db.close();
}

function ids(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
}

function insert(mailbox: SqliteAgentMailbox, id: string): Promise<void> {
  return mailbox.session(KEY, (m) =>
    m.insertMessage({
      id,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
      processAfter: null,
      recurrence: null,
    }),
  );
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SESSION, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('planted symlinks at mailbox write paths', () => {
  it('prepare() does not create the target of a dangling outbound.db symlink', () => {
    const target = path.join(OUTSIDE, 'created-by-host.db');
    fs.symlinkSync(target, path.join(SESSION, 'outbound.db'));

    expect(() => new SqliteAgentMailbox().prepare(KEY)).toThrow(/symlink/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('a writer session never opens or re-modes a database outbound.db links to', async () => {
    const mailbox = new SqliteAgentMailbox();
    mailbox.prepare(KEY);
    const victim = path.join(OUTSIDE, 'victim.db');
    const v = new Database(victim);
    v.pragma('journal_mode = WAL');
    v.exec('CREATE TABLE t (a)');
    v.close();
    fs.rmSync(path.join(SESSION, 'outbound.db'));
    fs.symlinkSync(victim, path.join(SESSION, 'outbound.db'));

    await expect(
      mailbox.session(KEY, (m) =>
        m.writeDirect({
          id: 'out-1',
          kind: 'chat',
          platformId: null,
          channelType: null,
          threadId: null,
          content: '{}',
        }),
      ),
    ).rejects.toThrow(/symlink|not prepared/);
    const check = new Database(victim, { readonly: true });
    expect(check.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_out'").get()).toBeUndefined();
    check.close();
  });

  it('new sessions keep inbound.db in the mailbox folder and expose it read-only', async () => {
    const mailbox = new SqliteAgentMailbox();
    mailbox.prepare(KEY);
    await insert(mailbox, 'm1');
    expect(ids(path.join(MAILBOX, 'inbound.db'))).toEqual(['m1']);
    expect(fs.existsSync(path.join(SESSION, 'inbound.db'))).toBe(false);
    expect(mailbox.readonlyMounts(KEY)).toEqual([{ hostPath: MAILBOX, containerPath: '/workspace/mailbox' }]);
    expect(mailbox.needsLayoutUpgrade(KEY)).toBe(false);
  });

  it('a legacy inbound.db symlink to another session is neither followed nor migrated', async () => {
    const otherSession = path.join(ROOT, 'data', 'v2-sessions', 'ag-b', 'sess-b');
    fs.mkdirSync(otherSession, { recursive: true });
    const victim = path.join(otherSession, 'inbound.db');
    writeLegacyInbound(victim, ['victim-row']);
    fs.symlinkSync(victim, path.join(SESSION, 'inbound.db'));

    const mailbox = new SqliteAgentMailbox();
    mailbox.prepare(KEY);
    await insert(mailbox, 'attacker-row');

    expect(ids(victim)).toEqual(['victim-row']);
    expect(ids(path.join(MAILBOX, 'inbound.db'))).toEqual(['attacker-row']);
    expect(fs.existsSync(path.join(SESSION, 'inbound.db'))).toBe(false);
  });

  it('a symlink planted at mailbox/ before migration is replaced, not written through', () => {
    writeLegacyInbound(path.join(SESSION, 'inbound.db'), ['queued']);
    fs.symlinkSync(OUTSIDE, MAILBOX);

    new SqliteAgentMailbox().prepare(KEY);

    expect(fs.readdirSync(OUTSIDE)).toEqual([]);
    expect(fs.lstatSync(MAILBOX).isDirectory()).toBe(true);
    expect(ids(path.join(MAILBOX, 'inbound.db'))).toEqual(['queued']);
  });
});

describe('openAnchoredDb', () => {
  it('refuses a link swapped in between the regular-file check and the open', () => {
    const leaf = path.join(SESSION, 'x.db');
    new Database(leaf).close();
    const victim = path.join(OUTSIDE, 'v.db');
    const v = new Database(victim);
    v.pragma('journal_mode = WAL');
    v.close();
    const dir = AnchoredDir.open(SESSION, [])!;
    const real = dir.lstatExact.bind(dir);
    let swapped = false;
    vi.spyOn(dir, 'lstatExact').mockImplementation((name: string) => {
      const st = real(name);
      if (!swapped) {
        swapped = true;
        fs.rmSync(leaf);
        fs.symlinkSync(victim, leaf);
      }
      return st;
    });

    expect(() => openAnchoredDb(dir, 'x.db', 'readwrite')).toThrow(/symlink|changed/);
    const check = new Database(victim, { readonly: true });
    expect(check.pragma('journal_mode', { simple: true })).toBe('wal');
    check.close();
  });
});

describe('legacy layout migration', () => {
  it('moves every queued row and removes the old file', async () => {
    writeLegacyInbound(path.join(SESSION, 'inbound.db'), ['a', 'b', 'c']);
    const mailbox = new SqliteAgentMailbox();
    expect(await mailbox.exists(KEY)).toBe(false); // no outbound.db yet
    fs.writeFileSync(path.join(SESSION, 'outbound.db'), '');
    expect(await mailbox.exists(KEY)).toBe(true);
    expect(mailbox.needsLayoutUpgrade(KEY)).toBe(true);

    mailbox.prepare(KEY);
    await insert(mailbox, 'd');

    expect(ids(path.join(MAILBOX, 'inbound.db'))).toEqual(['a', 'b', 'c', 'd']);
    expect(fs.existsSync(path.join(SESSION, 'inbound.db'))).toBe(false);
    expect(mailbox.needsLayoutUpgrade(KEY)).toBe(false);
  });

  it('the boot pass migrates every legacy session and leaves current ones alone', () => {
    writeLegacyInbound(path.join(SESSION, 'inbound.db'), ['a']);
    const other = path.join(ROOT, 'data', 'v2-sessions', 'ag-b', 'sess-b');
    fs.mkdirSync(other, { recursive: true });
    writeLegacyInbound(path.join(other, 'inbound.db'), ['b']);
    const mailbox = new SqliteAgentMailbox();

    mailbox.upgradeStoredLayouts();
    mailbox.upgradeStoredLayouts();

    expect(ids(path.join(MAILBOX, 'inbound.db'))).toEqual(['a']);
    expect(ids(path.join(other, 'mailbox', 'inbound.db'))).toEqual(['b']);
    expect(fs.existsSync(path.join(other, 'inbound.db'))).toBe(false);
  });

  it('session() migrates a legacy session that was never re-prepared', async () => {
    writeLegacyInbound(path.join(SESSION, 'inbound.db'), ['a']);
    new Database(path.join(SESSION, 'outbound.db')).close();
    const mailbox = new SqliteAgentMailbox();
    await insert(mailbox, 'b');
    expect(ids(path.join(MAILBOX, 'inbound.db'))).toEqual(['a', 'b']);
  });

  it('a legacy-named file the container writes after migration is discarded, never migrated', async () => {
    const mailbox = new SqliteAgentMailbox();
    mailbox.prepare(KEY);
    await insert(mailbox, 'real');
    writeLegacyInbound(path.join(SESSION, 'inbound.db'), ['forged']);

    mailbox.prepare(KEY);

    expect(ids(path.join(MAILBOX, 'inbound.db'))).toEqual(['real']);
    expect(fs.existsSync(path.join(SESSION, 'inbound.db'))).toBe(false);
  });

  it('readers find inbound.db in either layout without following links', () => {
    expect(openInboundReadonlyAt(SESSION)).toBeNull();
    writeLegacyInbound(path.join(SESSION, 'inbound.db'), ['legacy']);
    const legacy = openInboundReadonlyAt(SESSION)!;
    expect(legacy.prepare('SELECT id FROM messages_in').all()).toEqual([{ id: 'legacy' }]);
    legacy.close();
    fs.rmSync(path.join(SESSION, 'inbound.db'));
    fs.symlinkSync(path.join(OUTSIDE, 'x.db'), path.join(SESSION, 'inbound.db'));
    expect(() => openInboundReadonlyAt(SESSION)).toThrow(/symlink/);
  });

  it('destroy() removes mailbox files but not what a planted link points at', async () => {
    const mailbox = new SqliteAgentMailbox();
    mailbox.prepare(KEY);
    const victim = path.join(OUTSIDE, 'keep.txt');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(SESSION, 'outbound.db-journal'));

    await mailbox.destroy(KEY);

    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    expect(fs.existsSync(MAILBOX)).toBe(false);
    expect(fs.existsSync(path.join(SESSION, 'outbound.db'))).toBe(false);
  });
});
