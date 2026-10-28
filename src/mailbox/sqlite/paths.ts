import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { MailboxSessionKey } from '../types.js';
import { MAILBOX_DIR, INBOUND_DB, OUTBOUND_DB } from './names.js';

export { MAILBOX_DIR, INBOUND_DB, OUTBOUND_DB };
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
