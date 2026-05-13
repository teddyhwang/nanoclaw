/**
 * Persistent inbound-key store for the WhatsApp adapter.
 *
 * Survives process restarts so the bot's reply can render as a native
 * quote-reply pill even when the inbound was observed in a prior
 * process lifetime. The in-memory `inboundKeyCache` Map in
 * `whatsapp.ts` remains the hot path; this DB is the fallback when the
 * memory cache is empty (cold start, post-restart, or after LRU
 * eviction).
 *
 * Also stores the message text, sender, and parent-message id so a
 * future ancestor walker (`ChannelAdapter.fetchAncestor`) can build
 * reply-chain context for prompt-window backfill without re-fetching
 * via Baileys (Baileys has no synchronous "get message by id" API
 * once a message is past its in-memory store).
 *
 * Bounding: ≤10,000 rows AND age ≤30 days. Cleanup runs at setup time
 * (one-shot) and on a 1h interval. A reply pill that matters is
 * usually a reply to a recent message; older entries are dead weight.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface InboundKeyRecord {
  remoteJid: string;
  participant?: string;
  fromMe: boolean;
  /** ISO timestamp when the message was observed. */
  ts: string;
  senderId?: string;
  senderName?: string;
  text?: string;
  /** WhatsApp `contextInfo.stanzaId` of the parent, if this was a reply. */
  replyToMessageId?: string;
}

export interface InboundKeyStore {
  /** Insert or replace a row. Idempotent on `messageId`. */
  remember(messageId: string, rec: InboundKeyRecord): void;
  /** Return the Baileys-key shape for a known message id, or undefined. */
  lookup(messageId: string): InboundKeyRecord | undefined;
  /** Drop rows older than 30d, then trim to ≤10,000 rows. */
  cleanup(): void;
  /** Close the underlying handle. */
  close(): void;
}

const KEY_STORE_MAX_ROWS = 10_000;
const KEY_STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbound_keys (
    message_id           TEXT PRIMARY KEY,
    remote_jid           TEXT NOT NULL,
    participant          TEXT,
    from_me              INTEGER NOT NULL DEFAULT 0,
    ts                   TEXT NOT NULL,
    sender_id            TEXT,
    sender_name          TEXT,
    text                 TEXT,
    reply_to_message_id  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_keys_ts ON inbound_keys(ts);
  CREATE INDEX IF NOT EXISTS idx_inbound_keys_reply_to
    ON inbound_keys(reply_to_message_id)
    WHERE reply_to_message_id IS NOT NULL;
`;

/** Open (or create) the key store at the given DB path. */
export function openInboundKeyStore(dbPath: string): InboundKeyStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const remember = db.prepare(`
    INSERT OR REPLACE INTO inbound_keys
      (message_id, remote_jid, participant, from_me, ts,
       sender_id, sender_name, text, reply_to_message_id)
    VALUES (@messageId, @remoteJid, @participant, @fromMe, @ts,
            @senderId, @senderName, @text, @replyToMessageId)
  `);

  const lookup = db.prepare<
    [string],
    {
      remote_jid: string;
      participant: string | null;
      from_me: number;
      ts: string;
      sender_id: string | null;
      sender_name: string | null;
      text: string | null;
      reply_to_message_id: string | null;
    }
  >(`
    SELECT remote_jid, participant, from_me, ts, sender_id, sender_name,
           text, reply_to_message_id
      FROM inbound_keys
     WHERE message_id = ?
  `);

  // Two cleanup queries: age-based (predicate) and count-based (LRU by
  // ts). Run age first so the count-trim sees a smaller working set.
  const deleteOld = db.prepare(`DELETE FROM inbound_keys WHERE ts < ?`);
  const deleteOverflow = db.prepare(`
    DELETE FROM inbound_keys WHERE message_id IN (
      SELECT message_id FROM inbound_keys
        ORDER BY ts ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM inbound_keys) - ?)
    )
  `);

  return {
    remember(messageId, rec) {
      remember.run({
        messageId,
        remoteJid: rec.remoteJid,
        participant: rec.participant ?? null,
        fromMe: rec.fromMe ? 1 : 0,
        ts: rec.ts,
        senderId: rec.senderId ?? null,
        senderName: rec.senderName ?? null,
        text: rec.text ?? null,
        replyToMessageId: rec.replyToMessageId ?? null,
      });
    },
    lookup(messageId) {
      const row = lookup.get(messageId);
      if (!row) return undefined;
      return {
        remoteJid: row.remote_jid,
        participant: row.participant ?? undefined,
        fromMe: row.from_me === 1,
        ts: row.ts,
        senderId: row.sender_id ?? undefined,
        senderName: row.sender_name ?? undefined,
        text: row.text ?? undefined,
        replyToMessageId: row.reply_to_message_id ?? undefined,
      };
    },
    cleanup() {
      const cutoff = new Date(Date.now() - KEY_STORE_MAX_AGE_MS).toISOString();
      deleteOld.run(cutoff);
      deleteOverflow.run(KEY_STORE_MAX_ROWS);
    },
    close() {
      db.close();
    },
  };
}
