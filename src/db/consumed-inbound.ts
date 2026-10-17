/**
 * Inbound messages a host prompt consumed (migration 027).
 *
 * A host prompt (new-agent name step, reject-with-reason) captures its reply
 * in a router interceptor, so the reply never lands in any session's
 * inbound.db and channel recovery's session dedup can't recognise it. Each
 * prompt records the reply here at the moment it consumes it; routeInbound
 * drops any event already recorded, so a recovered copy is never dispatched.
 */
import type { InboundEvent } from '../channels/adapter.js';
import { getDb } from './connection.js';

/** Far beyond the 2h startup recovery lookback; bounds the table. */
export const CONSUMED_INBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function key(event: InboundEvent): [string, string, string] {
  return [event.instance ?? event.channelType, event.platformId, event.message.id];
}

/**
 * Record that `consumedBy` consumed this inbound message. Idempotent. Safe to
 * call inside a central transaction (DB calls only, issued sequentially).
 */
export async function markInboundConsumed(event: InboundEvent, consumedBy: string, now = Date.now()): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO consumed_inbound_messages (instance, platform_id, message_id, consumed_by, consumed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (instance, platform_id, message_id) DO NOTHING`,
    ...key(event),
    consumedBy,
    new Date(now).toISOString(),
  );
  await db.run(
    'DELETE FROM consumed_inbound_messages WHERE consumed_at < ?',
    new Date(now - CONSUMED_INBOUND_RETENTION_MS).toISOString(),
  );
}

/** The prompt that consumed this message, or undefined if none did. */
export async function getInboundConsumer(event: InboundEvent): Promise<string | undefined> {
  const row = await getDb().get<{ consumed_by: string }>(
    'SELECT consumed_by FROM consumed_inbound_messages WHERE instance = ? AND platform_id = ? AND message_id = ?',
    ...key(event),
  );
  return row?.consumed_by;
}
