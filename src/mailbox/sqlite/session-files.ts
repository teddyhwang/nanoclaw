/**
 * Per-session mailbox files, reached without following container-made links.
 *
 * Layout (session folder = data/v2-sessions/<group>/<session>, mounted
 * read-write at /workspace):
 *   mailbox/inbound.db  host-written; `mailbox/` is bind-mounted read-only over
 *                     /workspace/mailbox, so the container can read it but can
 *                     neither write it nor replace the name.
 *   outbound.db       container-written; the host opens it only through
 *                     openAnchoredDb (regular file, no link, same inode).
 *
 * Sessions created before the mailbox existed keep inbound.db directly in the
 * session folder. migrateSessionLayout() moves it once, with VACUUM INTO so a
 * hot journal is rolled back first and every queued row is kept, then commits
 * by renaming inside the fresh mailbox. A session is "current" exactly when
 * mailbox/inbound.db is a regular file; after that a legacy-named file is
 * container-made and is discarded, never migrated again.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { AnchoredDir } from '../../anchored-dir.js';
import { log } from '../../log.js';
import type { MailboxSessionKey } from '../types.js';
import { createEmptyDbFile, openAnchoredDb, UnsafeSessionDbError } from './anchored-db.js';
import { INBOUND_DB, MAILBOX_DIR, OUTBOUND_DB, sessionMailboxDir } from './paths.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { isRegular, layoutOf, type SessionLayout } from './session-readers.js';

export type { SessionLayout };
export { openInboundReadonlyAt, openOutboundReadonlyAt } from './session-readers.js';

const SQLITE_SIDE_FILES = ['', '-journal', '-wal', '-shm'] as const;
const MIGRATING = `${INBOUND_DB}.migrating`;

function openSession(key: MailboxSessionKey, create = false): AnchoredDir | null {
  return AnchoredDir.open(sessionMailboxDir(key), [], create);
}

function openMailbox(key: MailboxSessionKey): AnchoredDir {
  const mailbox = AnchoredDir.open(sessionMailboxDir(key), [MAILBOX_DIR]);
  if (!mailbox) throw new Error(`session mailbox is missing: ${key.agentGroupId}/${key.sessionId}`);
  return mailbox;
}

/** Layout of a session's mailbox files. Reads only. */
export function sessionLayout(key: MailboxSessionKey): SessionLayout {
  const session = openSession(key);
  if (!session) return 'absent';
  try {
    return layoutOf(session);
  } finally {
    session.close();
  }
}

/**
 * Remove the session-root inbound.db and its side files. `origin` says whose
 * file it is: the session's own pre-migration file right after its rows were
 * copied (routine), or a file that appeared after migration, which only the
 * container can have made (suspicious).
 */
function discardLegacyInbound(
  session: AnchoredDir,
  key: MailboxSessionKey,
  origin: 'migrated' | 'container-made',
): void {
  for (const suffix of SQLITE_SIDE_FILES) {
    const name = `${INBOUND_DB}${suffix}`;
    if (!session.lstatExact(name)) continue;
    if (suffix === '') {
      const fields = { agentGroupId: key.agentGroupId, sessionId: key.sessionId };
      if (origin === 'migrated') log.info('Removed the pre-migration inbound.db after copying it', fields);
      else log.warn('Discarding a container-made inbound.db in a migrated session folder', fields);
    }
    session.removeTree(name);
  }
}

/** Folder names under v2-sessions (and under an agent group) that are never sessions: `.claude-shared`, `.context`, `_by-name`, ... */
export function isReservedSessionDirName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_');
}

/**
 * Bring a session folder to the mailbox layout. No-op (besides discarding a
 * container-made legacy-named file) once migrated. Must run with no container
 * on the legacy layout for this session: callers stop those first.
 */
export function migrateSessionLayout(key: MailboxSessionKey): void {
  const session = openSession(key);
  if (!session) return;
  try {
    if (layoutOf(session) === 'current') {
      discardLegacyInbound(session, key, 'container-made');
      return;
    }
    // Not migrated: an existing `mailbox` entry is either an interrupted earlier
    // attempt or container-made. Neither is trusted; start from an empty one.
    session.removeTree(MAILBOX_DIR);
    const legacy = session.lstatExact(INBOUND_DB);
    if (!legacy) return;
    session.openDir(MAILBOX_DIR, true)!.close();
    if (!legacy.isFile()) {
      log.warn('Legacy inbound.db is not a regular file (symlink or other); starting an empty mailbox', {
        agentGroupId: key.agentGroupId,
        sessionId: key.sessionId,
      });
    } else {
      // The copy gets the host's own schema; only the rows (columns the host
      // schema knows) come from the container-writable legacy file, read
      // through the guarded opener. Its schema is never copied: it becomes
      // the trusted, unguarded inbound.db.
      const mailboxDir = openMailbox(key);
      try {
        createEmptyDbFile(mailboxDir, MIGRATING);
      } finally {
        mailboxDir.close();
      }
      const copy = openAnchoredDb(openMailbox(key), MIGRATING, 'readwrite', { schema: 'host' });
      let rows = 0;
      try {
        copy.pragma('journal_mode = DELETE');
        copy.exec(INBOUND_SCHEMA);
        try {
          rows = copyLegacyRows(key, copy);
        } catch (err) {
          if (!(err instanceof UnsafeSessionDbError)) throw err;
          // A container-made schema: the rows are not the host's to trust.
          log.warn('Legacy inbound.db has an unsafe schema; starting an empty mailbox', {
            agentGroupId: key.agentGroupId,
            sessionId: key.sessionId,
            err: err.message,
          });
          for (const t of tablesOf(copy)) copy.prepare(`DELETE FROM ${quoteName(t)}`).run();
          rows = 0;
        }
      } finally {
        copy.close();
      }
      const mailbox = openMailbox(key);
      try {
        mailbox.rename(MIGRATING, INBOUND_DB);
      } finally {
        mailbox.close();
      }
      log.info('Moved session inbound.db into the read-only mailbox', {
        agentGroupId: key.agentGroupId,
        sessionId: key.sessionId,
        rows,
      });
    }
    discardLegacyInbound(session, key, 'migrated');
  } finally {
    session.close();
  }
}

/**
 * Migrate every session still on the old layout. Run at boot after adoption
 * stopped old-layout containers and before inbound routing starts, so readers
 * and writers only ever see the mailbox folder. Failures are logged per
 * session; session()/prepare() retry them lazily.
 */
export function upgradeAllSessionLayouts(sessionsRoot: string): { migrated: number; failed: number } {
  let migrated = 0;
  let failed = 0;
  const dirs = (root: string) =>
    fs.existsSync(root)
      ? fs
          .readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !isReservedSessionDirName(entry.name))
          .map((entry) => entry.name)
      : [];
  for (const agentGroupId of dirs(sessionsRoot)) {
    for (const sessionId of dirs(`${sessionsRoot}/${agentGroupId}`)) {
      const key = { agentGroupId, sessionId };
      try {
        if (sessionLayout(key) !== 'legacy') continue;
        migrateSessionLayout(key);
        migrated += 1;
      } catch (err) {
        failed += 1;
        log.warn('Session mailbox layout migration failed; will retry on next use', { ...key, err });
      }
    }
  }
  return { migrated, failed };
}

function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function tablesOf(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

/**
 * Copy the legacy inbound.db's rows into `copy` (host schema already
 * applied), table by table, for the columns both share. Read-write so
 * SQLite can roll back a hot journal first. Returns the messages_in count.
 */
function copyLegacyRows(key: MailboxSessionKey, copy: Database.Database): number {
  const source = openAnchoredDb(openSession(key)!, INBOUND_DB, 'readwrite');
  try {
    const present = new Set(tablesOf(source));
    const move = copy.transaction(() => {
      for (const table of tablesOf(copy)) {
        if (!present.has(table)) continue;
        const theirs = new Set(
          (source.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map(
            (c) => c.name,
          ),
        );
        const cols = (copy.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>)
          .map((c) => c.name)
          .filter((c) => theirs.has(c));
        if (!cols.length) continue;
        const list = cols.map(quoteName).join(', ');
        const insert = copy.prepare(
          `INSERT OR IGNORE INTO ${quoteName(table)} (${list}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        for (const row of source
          .prepare(`SELECT ${list} FROM ${quoteName(table)}`)
          .raw()
          .iterate())
          insert.run(...(row as unknown[]));
      }
    });
    move();
  } finally {
    source.close();
  }
  return (copy.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
}

function ensureDb(dir: AnchoredDir, name: string, schema: 'inbound' | 'outbound'): void {
  try {
    const created = createEmptyDbFile(dir, name);
    const st = dir.lstatExact(name);
    if (!created && st && st.isFile() && st.size > 0n) return;
  } catch (err) {
    dir.close();
    throw err;
  }
  // openAnchoredDb refuses a non-regular leaf and takes ownership of dir.
  const db = openAnchoredDb(dir, name, 'readwrite', { schema: schema === 'inbound' ? 'host' : 'container' });
  try {
    db.pragma('journal_mode = DELETE');
    db.exec(schema === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  } finally {
    db.close();
  }
}

/** Provision (and if needed migrate) a session's mailbox files. Idempotent. */
export function prepareSessionFiles(key: MailboxSessionKey): void {
  fs.mkdirSync(sessionMailboxDir(key), { recursive: true });
  migrateSessionLayout(key);
  const session = openSession(key, true)!;
  try {
    session.openDir(MAILBOX_DIR, true)!.close();
  } finally {
    session.close();
  }
  ensureDb(openMailbox(key), INBOUND_DB, 'inbound');
  ensureDb(openSession(key)!, OUTBOUND_DB, 'outbound');
}

/** True when both mailbox files exist (a legacy session counts; session() migrates it). */
export function sessionFilesExist(key: MailboxSessionKey): boolean {
  const session = openSession(key);
  if (!session) return false;
  try {
    return layoutOf(session) !== 'absent' && isRegular(session, OUTBOUND_DB);
  } catch {
    return false;
  } finally {
    session.close();
  }
}

export function openSessionInbound(key: MailboxSessionKey): Database.Database {
  const db = openAnchoredDb(openMailbox(key), INBOUND_DB, 'readwrite', { schema: 'host' });
  db.pragma('journal_mode = DELETE');
  // busy_timeout: openAnchoredDb's short SESSION_DB_BUSY_TIMEOUT_MS (busy.ts).
  return db;
}

export function openSessionOutbound(key: MailboxSessionKey, mode: 'readonly' | 'readwrite'): Database.Database {
  const session = openSession(key);
  if (!session) throw new Error(`session folder is missing: ${key.agentGroupId}/${key.sessionId}`);
  const db = openAnchoredDb(session, OUTBOUND_DB, mode);
  if (mode === 'readwrite') db.pragma('journal_mode = DELETE');
  return db;
}

/** Remove the mailbox files; links are removed themselves, never followed. */
export function destroySessionFiles(key: MailboxSessionKey): void {
  const session = openSession(key);
  if (!session) return;
  try {
    session.removeTree(MAILBOX_DIR);
    for (const base of [INBOUND_DB, OUTBOUND_DB]) {
      for (const suffix of SQLITE_SIDE_FILES) session.removeTree(`${base}${suffix}`);
    }
  } finally {
    session.close();
  }
}
