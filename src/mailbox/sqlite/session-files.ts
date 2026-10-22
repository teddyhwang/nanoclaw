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
import { createEmptyDbFile, openAnchoredDb } from './anchored-db.js';
import { INBOUND_DB, MAILBOX_DIR, OUTBOUND_DB, sessionMailboxDir } from './paths.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

const SQLITE_SIDE_FILES = ['', '-journal', '-wal', '-shm'] as const;
const MIGRATING = `${INBOUND_DB}.migrating`;

export type SessionLayout = 'current' | 'legacy' | 'absent';

function openSession(key: MailboxSessionKey, create = false): AnchoredDir | null {
  return AnchoredDir.open(sessionMailboxDir(key), [], create);
}

function openMailbox(key: MailboxSessionKey): AnchoredDir {
  const mailbox = AnchoredDir.open(sessionMailboxDir(key), [MAILBOX_DIR]);
  if (!mailbox) throw new Error(`session mailbox is missing: ${key.agentGroupId}/${key.sessionId}`);
  return mailbox;
}

function isRegular(dir: AnchoredDir, name: string): boolean {
  return dir.lstatExact(name)?.isFile() ?? false;
}

function layoutOf(session: AnchoredDir): SessionLayout {
  if (session.lstatExact(MAILBOX_DIR)?.isDirectory()) {
    const mailbox = session.openDir(MAILBOX_DIR);
    if (mailbox) {
      try {
        if (isRegular(mailbox, INBOUND_DB)) return 'current';
      } finally {
        mailbox.close();
      }
    }
  }
  return session.lstatExact(INBOUND_DB) ? 'legacy' : 'absent';
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

function discardLegacyInbound(session: AnchoredDir, key: MailboxSessionKey): void {
  for (const suffix of SQLITE_SIDE_FILES) {
    const name = `${INBOUND_DB}${suffix}`;
    if (!session.lstatExact(name)) continue;
    if (suffix === '') {
      log.warn('Discarding a container-made inbound.db in a migrated session folder', {
        agentGroupId: key.agentGroupId,
        sessionId: key.sessionId,
      });
    }
    session.removeTree(name);
  }
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
      discardLegacyInbound(session, key);
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
      const mailboxForPath = openMailbox(key);
      const target = mailboxForPath.pathOf(MIGRATING);
      try {
        // Read-write so SQLite can roll back a hot journal before copying.
        const source = openAnchoredDb(openSession(key)!, INBOUND_DB, 'readwrite');
        try {
          source.pragma('busy_timeout = 5000');
          source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
        } finally {
          source.close();
        }
      } finally {
        mailboxForPath.close();
      }
      const copy = openAnchoredDb(openMailbox(key), MIGRATING, 'readwrite');
      let rows = 0;
      try {
        copy.pragma('journal_mode = DELETE');
        rows = (copy.prepare('SELECT COUNT(*) AS n FROM messages_in').get() as { n: number }).n;
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
    discardLegacyInbound(session, key);
  } finally {
    session.close();
  }
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
  const db = openAnchoredDb(dir, name, 'readwrite');
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
  const db = openAnchoredDb(openMailbox(key), INBOUND_DB, 'readwrite');
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function openSessionOutbound(key: MailboxSessionKey, mode: 'readonly' | 'readwrite'): Database.Database {
  const session = openSession(key);
  if (!session) throw new Error(`session folder is missing: ${key.agentGroupId}/${key.sessionId}`);
  const db = openAnchoredDb(session, OUTBOUND_DB, mode);
  if (mode === 'readwrite') db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
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

/**
 * Read-only handle on a session folder's inbound.db wherever the layout keeps
 * it (mailbox, or the legacy spot before migration), never through a link.
 * Null when there is none.
 */
export function openInboundReadonlyAt(sessionFolder: string): Database.Database | null {
  const session = AnchoredDir.open(sessionFolder, []);
  if (!session) return null;
  let layout: SessionLayout;
  try {
    layout = layoutOf(session);
  } catch (err) {
    session.close();
    throw err;
  }
  if (layout === 'absent') {
    session.close();
    return null;
  }
  if (layout === 'legacy') return openAnchoredDb(session, INBOUND_DB, 'readonly');
  session.close();
  const mailbox = AnchoredDir.open(sessionFolder, [MAILBOX_DIR]);
  return mailbox ? openAnchoredDb(mailbox, INBOUND_DB, 'readonly') : null;
}
