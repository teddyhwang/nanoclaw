import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { MailboxSessionKey } from '../types.js';

/**
 * Host-owned folder inside the session folder that holds inbound.db. The
 * session folder is mounted read-write at /workspace, but this folder is
 * bind-mounted read-only on top of it at /workspace/mailbox, so a running
 * container can neither write inbound.db nor replace the folder or the file
 * name with a symlink (a mountpoint cannot be renamed or unlinked).
 * (Not `inbox/`: that holds inbound attachments.)
 */
export const MAILBOX_DIR = 'mailbox';
export const INBOUND_DB = 'inbound.db';
export const OUTBOUND_DB = 'outbound.db';
/** Where the container sees the mailbox folder. Must match the agent-runner. */
export const CONTAINER_MAILBOX_PATH = `/workspace/${MAILBOX_DIR}`;

export function sessionMailboxDir(key: MailboxSessionKey): string {
  return path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId);
}

/** The read-only-mounted folder holding inbound.db. */
export function sessionReadonlyMailboxDir(key: MailboxSessionKey): string {
  return path.join(sessionMailboxDir(key), MAILBOX_DIR);
}

export function sessionMailboxPath(key: MailboxSessionKey, side: 'inbound' | 'outbound'): string {
  return side === 'inbound'
    ? path.join(sessionReadonlyMailboxDir(key), INBOUND_DB)
    : path.join(sessionMailboxDir(key), OUTBOUND_DB);
}

/**
 * Pre-migration location of inbound.db, directly in the container-writable
 * session folder. Only the one-time layout migration reads it; anything found
 * there after a session is migrated is container-made and ignored.
 */
export function legacyInboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionMailboxDir({ agentGroupId, sessionId }), INBOUND_DB);
}

export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return sessionMailboxPath({ agentGroupId, sessionId }, 'inbound');
}

export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return sessionMailboxPath({ agentGroupId, sessionId }, 'outbound');
}
