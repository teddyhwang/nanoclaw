/**
 * WhatsApp channel adapter (v2) — native Baileys v7 implementation.
 *
 * Implements ChannelAdapter directly (no Chat SDK bridge) using
 * @whiskeysockets/baileys v7. Ports proven v1 infrastructure:
 * getMessage fallback, outgoing queue, group metadata cache, LID mapping,
 * reconnection with backoff.
 *
 * Auth credentials persist in store/auth/. On first run:
 * - If WHATSAPP_PHONE_NUMBER is set → pairing code (printed to log)
 * - Otherwise → QR code (printed to log)
 * Subsequent restarts reuse the saved session automatically.
 */
import fs from 'fs';
import path from 'path';
// Named import (not default) — pino's .d.ts under NodeNext resolution
// exports `{ pino as default, pino }`, but the namespace/function merge at
// `declare namespace pino` + `declare function pino` makes the default
// resolve to `typeof pino` (the namespace type), which isn't callable.
// The named export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, WAMessageKey, WAMessage, WASocket } from '@whiskeysockets/baileys';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { getEnginePaths } from '../engine/paths.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';

// proto is not available as a named ESM export — use createRequire (same as v1)
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { proto } = _require('@whiskeysockets/baileys') as { proto: any };

const baileysLogger = pino({ level: 'silent' });

/**
 * Resolve the WhatsApp auth dir. v2 hosts route this under the install's
 * data dir (`<dataDir>/whatsapp/auth`) so each install has its own
 * Baileys credential store, not a process-cwd-relative `store/auth`
 * symlink shared with v1. `getEnginePaths()` returns sensible defaults
 * when no host has called `setEnginePaths`, so this stays safe in
 * standalone runs too.
 */
function resolveAuthDir(): string {
  return path.join(getEnginePaths().dataDir, 'whatsapp', 'auth');
}

/**
 * Look up the text of a previously-sent WhatsApp message by Baileys'
 * `key.id` and the chat's JID. Used by Baileys' `getMessage` callback when
 * a peer asks us to re-encrypt a message — without a content fallback,
 * recipients see indefinite "Waiting for this message" prompts when the
 * in-memory `sentMessageCache` has aged out (or when sender-key state was
 * stale on the recipient at original-send time, common after a re-pair).
 *
 * Source of truth in v2: per-session SQLite under
 * `<dataDir>/v2-sessions/<agentGroupId>/<sessionId>/{inbound,outbound}.db`.
 *   - `inbound.db.delivered(message_out_id, platform_message_id)` —
 *     records Baileys' `key.id` next to our internal id at delivery time.
 *   - `outbound.db.messages_out(id, platform_id, content)` — the message
 *     proto's text, indexed by chat JID for disambiguation.
 *
 * Strategy: scan the v2-sessions tree, opening each `inbound.db` once
 * (cached read-only handle) to find the row whose `platform_message_id`
 * matches `key.id`. Hits are rare (only fire on retry-request), so the
 * fan-out is acceptable. For hits, look up the content in the matching
 * session's `outbound.db` filtered by `platform_id = chat JID` (rules out
 * the rare cross-session id collision).
 */
type Db = import('better-sqlite3').Database;
const _sessionDbHandles = new Map<string, { inbound: Db; outbound: Db }>();
function getSessionDirs(): string[] {
  const root = path.join(getEnginePaths().dataDir, 'v2-sessions');
  if (!fs.existsSync(root)) return [];
  const dirs: string[] = [];
  for (const agentGroup of fs.readdirSync(root)) {
    const agentDir = path.join(root, agentGroup);
    if (!fs.statSync(agentDir).isDirectory()) continue;
    for (const session of fs.readdirSync(agentDir)) {
      const sessionDir = path.join(agentDir, session);
      const inDb = path.join(sessionDir, 'inbound.db');
      const outDb = path.join(sessionDir, 'outbound.db');
      if (fs.existsSync(inDb) && fs.existsSync(outDb)) dirs.push(sessionDir);
    }
  }
  return dirs;
}
function openSessionDbs(sessionDir: string): { inbound: Db; outbound: Db } | null {
  const cached = _sessionDbHandles.get(sessionDir);
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const inbound = new Database(path.join(sessionDir, 'inbound.db'), { readonly: true, fileMustExist: true });
    const outbound = new Database(path.join(sessionDir, 'outbound.db'), { readonly: true, fileMustExist: true });
    const handles = { inbound, outbound };
    _sessionDbHandles.set(sessionDir, handles);
    return handles;
  } catch {
    return null;
  }
}
interface SentLookupResult {
  text: string;
  /**
   * The assistant name that was used as a prefix at original-send time.
   * Resolved from the owning agent group's container.json so retry-encrypt
   * matches the original ciphertext even when the host-wide
   * ASSISTANT_NAME has changed.
   */
  assistantName?: string;
  /** Separator between assistantName and message body (default `": "`). */
  assistantPrefixSeparator?: string;
}
function getMessageContentLookup(): ((id: string, jid: string) => SentLookupResult | undefined) | null {
  return (platformMessageId, chatJid) => {
    for (const sessionDir of getSessionDirs()) {
      const dbs = openSessionDbs(sessionDir);
      if (!dbs) continue;
      try {
        const deliveredRow = dbs.inbound
          .prepare('SELECT message_out_id FROM delivered WHERE platform_message_id = ? LIMIT 1')
          .get(platformMessageId) as { message_out_id: string } | undefined;
        if (!deliveredRow) continue;
        const outRow = dbs.outbound
          .prepare('SELECT content FROM messages_out WHERE id = ? AND platform_id = ? LIMIT 1')
          .get(deliveredRow.message_out_id, chatJid) as { content: string } | undefined;
        if (!outRow?.content) continue;
        // sessionDir layout: <dataDir>/v2-sessions/<agent_group_id>/<session_id>
        // Resolve the per-group assistantName via the host's normal lookup
        // path: agent_groups DB row → on-disk container.json. Imported
        // lazily here because the lookup is exercised only on the rare
        // retry path.
        const agentGroupId = path.basename(path.dirname(sessionDir));
        let assistantName: string | undefined;
        let assistantPrefixSeparator: string | undefined;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getAgentGroup } = require('../db/agent-groups.js') as typeof import('../db/agent-groups.js');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { readContainerConfig } = require('../container-config.js') as typeof import('../container-config.js');
          const ag = getAgentGroup(agentGroupId);
          if (ag) {
            const cfg = readContainerConfig(ag);
            assistantName = cfg.assistantName;
            assistantPrefixSeparator = cfg.assistantPrefixSeparator;
          }
        } catch {
          // host DB / container-config unavailable in this context —
          // caller will fall back to env-level ASSISTANT_NAME.
        }
        let text: string;
        try {
          const parsed = JSON.parse(outRow.content) as { text?: string; markdown?: string };
          text = parsed.markdown || parsed.text || outRow.content;
        } catch {
          text = outRow.content;
        }
        return { text, assistantName, assistantPrefixSeparator };
      } catch {
        continue;
      }
    }
    return undefined;
  };
}
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const GROUP_METADATA_CACHE_TTL_MS = 60_000; // 1 min for outbound sends
const SENT_MESSAGE_CACHE_MAX = 256;
const RECONNECT_DELAY_MS = 5000;
const PENDING_QUESTIONS_MAX = 64;

/** Normalize an option label to a slash command: "Approve" → "/approve" */
function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

// --- Markdown → WhatsApp formatting ---

interface TextSegment {
  content: string;
  isProtected: boolean;
}

/** Split text into code-block-protected and unprotected regions. */
function splitProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

/** Apply WhatsApp-native formatting to an unprotected text segment. */
function transformForWhatsApp(text: string): string {
  // Order matters: italic before bold to avoid **bold** → *bold* → _bold_
  // 1. Italic: *text* (not **) → _text_
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');
  // 2. Bold: **text** → *text*
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  // 3. Headings: ## Title → *Title*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 4. Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 5. Horizontal rules: --- / *** / ___ → stripped
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
  return text;
}

/** Convert Claude's markdown to WhatsApp-native formatting. */
function formatWhatsApp(text: string): string {
  const segments = splitProtectedRegions(text);
  return segments.map(({ content, isProtected }) => (isProtected ? content : transformForWhatsApp(content))).join('');
}

/** Map file extension to Baileys media message type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMediaMessage(data: Buffer, filename: string, ext: string, caption?: string): any {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv'];
  const audioExts = ['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus'];

  if (imageExts.includes(ext)) {
    return { image: data, caption, mimetype: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}` };
  }
  if (videoExts.includes(ext)) {
    return { video: data, caption, mimetype: `video/${ext.slice(1)}` };
  }
  if (audioExts.includes(ext)) {
    return { audio: data, mimetype: `audio/${ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1)}` };
  }
  // Default: send as document
  return { document: data, fileName: filename, caption, mimetype: 'application/octet-stream' };
}

registerChannelAdapter('whatsapp', {
  factory: () => {
    const env = readEnvFile(['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_ENABLED']);
    const phoneNumber = env.WHATSAPP_PHONE_NUMBER;
    const authDir = resolveAuthDir();

    // Skip if no existing auth, no phone number for pairing, and not explicitly enabled (QR mode)
    const hasAuth = fs.existsSync(path.join(authDir, 'creds.json'));
    if (!hasAuth && !phoneNumber && !env.WHATSAPP_ENABLED) return null;

    fs.mkdirSync(authDir, { recursive: true });

    // State
    let sock: WASocket;
    let connected = false;
    let setupConfig: ChannelSetup;

    // LID → phone JID mapping (WhatsApp's new ID system)
    const lidToPhoneMap: Record<string, string> = {};
    let botLidUser: string | undefined;

    // Outgoing queue for messages sent while disconnected
    const outgoingQueue: Array<{ jid: string; text: string }> = [];
    let flushing = false;

    // Sent message cache for retry/re-encrypt requests
    const sentMessageCache = new Map<string, any>();

    // Group metadata cache with TTL
    const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();

    // Pending questions: chatJid → { questionId, options }
    // User replies with /approve, /reject, etc. to answer
    const pendingQuestions = new Map<
      string,
      {
        questionId: string;
        options: NormalizedOption[];
      }
    >();

    // Group sync tracking
    let lastGroupSync = 0;
    let groupSyncTimerStarted = false;

    // First-connect promise
    let resolveFirstOpen: (() => void) | undefined;
    let rejectFirstOpen: ((err: Error) => void) | undefined;

    // Pairing code file for the setup skill to poll
    const pairingCodeFile = path.join(process.cwd(), 'store', 'pairing-code.txt');

    // --- Helpers ---

    function setLidPhoneMapping(lidUser: string, phoneJid: string): void {
      if (lidToPhoneMap[lidUser] === phoneJid) return;
      lidToPhoneMap[lidUser] = phoneJid;
      // Cached group metadata depends on participant IDs — invalidate
      groupMetadataCache.clear();
    }

    async function translateJid(jid: string): Promise<string> {
      if (!jid.endsWith('@lid')) return jid;
      const lidUser = jid.split('@')[0].split(':')[0];

      const cached = lidToPhoneMap[lidUser];
      if (cached) return cached;

      // Query Baileys' signal repository
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pn = await (sock.signalRepository as any)?.lidMapping?.getPNForLID(jid);
        if (pn) {
          const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
          setLidPhoneMapping(lidUser, phoneJid);
          log.info('Translated LID to phone JID', { lidJid: jid, phoneJid });
          return phoneJid;
        }
      } catch (err) {
        log.debug('Failed to resolve LID via signalRepository', { jid, err });
      }

      return jid;
    }

    async function getNormalizedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
      if (!jid.endsWith('@g.us')) return undefined;

      const cached = groupMetadataCache.get(jid);
      if (cached && cached.expiresAt > Date.now()) return cached.metadata;

      const metadata = await sock.groupMetadata(jid);
      const participants = await Promise.all(
        metadata.participants.map(async (p) => ({
          ...p,
          id: await translateJid(p.id),
        })),
      );
      const normalized = { ...metadata, participants };
      groupMetadataCache.set(jid, {
        metadata: normalized,
        expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
      });
      return normalized;
    }

    async function syncGroupMetadata(force = false): Promise<void> {
      if (!force && lastGroupSync && Date.now() - lastGroupSync < GROUP_SYNC_INTERVAL_MS) {
        return;
      }
      try {
        log.info('Syncing group metadata from WhatsApp...');
        const groups = await sock.groupFetchAllParticipating();
        let count = 0;
        for (const [jid, metadata] of Object.entries(groups)) {
          if (metadata.subject) {
            setupConfig.onMetadata(jid, metadata.subject, true);
            count++;
          }
        }
        lastGroupSync = Date.now();
        log.info('Group metadata synced', { count });
      } catch (err) {
        log.error('Failed to sync group metadata', { err });
      }
    }

    async function flushOutgoingQueue(): Promise<void> {
      if (flushing || outgoingQueue.length === 0) return;
      flushing = true;
      try {
        log.info('Flushing outgoing message queue', { count: outgoingQueue.length });
        while (outgoingQueue.length > 0) {
          const item = outgoingQueue.shift()!;
          const sent = await sock.sendMessage(item.jid, { text: item.text });
          if (sent?.key?.id && sent.message) {
            sentMessageCache.set(sent.key.id, sent.message);
          }
        }
      } finally {
        flushing = false;
      }
    }

    /** Download media from an inbound message, save to /workspace/attachments/. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function downloadInboundMedia(
      msg: WAMessage,
      normalized: any,
    ): Promise<Array<{ type: string; name: string; localPath: string }>> {
      const mediaTypes: Array<{ key: string; type: string; ext: string }> = [
        { key: 'imageMessage', type: 'image', ext: '.jpg' },
        { key: 'videoMessage', type: 'video', ext: '.mp4' },
        { key: 'audioMessage', type: 'audio', ext: '.ogg' },
        { key: 'documentMessage', type: 'document', ext: '' },
      ];
      const results: Array<{ type: string; name: string; localPath: string }> = [];
      for (const { key, type, ext } of mediaTypes) {
        if (!normalized[key]) continue;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          // documentMessage.fileName is attacker-controlled and rides through
          // WhatsApp's E2E channel — Meta can't sanitize it server-side. Without
          // this guard, a `..`-laden fileName escapes attachDir on path.join.
          const rawFilename = normalized[key].fileName;
          const fallback = `${type}-${Date.now()}${ext}`;
          const filename = isSafeAttachmentName(rawFilename) ? rawFilename : fallback;
          if (rawFilename && filename !== rawFilename) {
            log.warn('Refused unsafe attachment filename — would escape attachments dir', {
              rawFilename,
              replacement: filename,
            });
          }
          const attachDir = path.join(DATA_DIR, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          const filePath = path.join(attachDir, filename);
          fs.writeFileSync(filePath, buffer);
          results.push({ type, name: filename, localPath: `attachments/${filename}` });
          log.info('Media downloaded', { type, filename });
        } catch (err) {
          log.warn('Failed to download media', { type, err });
        }
      }
      return results;
    }

    async function sendRawMessage(jid: string, text: string): Promise<string | undefined> {
      if (!connected) {
        outgoingQueue.push({ jid, text });
        log.info('WA disconnected, message queued', { jid, queueSize: outgoingQueue.length });
        return;
      }
      try {
        const sent = await sock.sendMessage(jid, { text });
        if (sent?.key?.id && sent.message) {
          sentMessageCache.set(sent.key.id, sent.message);
          if (sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
            const oldest = sentMessageCache.keys().next().value!;
            sentMessageCache.delete(oldest);
          }
        }
        return sent?.key?.id ?? undefined;
      } catch (err) {
        outgoingQueue.push({ jid, text });
        log.warn('Failed to send, message queued', { jid, err, queueSize: outgoingQueue.length });
        return undefined;
      }
    }

    // --- Socket creation ---

    async function connectSocket(): Promise<void> {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
        log.warn('Failed to fetch latest WA Web version, using default', { err });
        return { version: undefined };
      });

      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
        defaultQueryTimeoutMs: 60_000,
        connectTimeoutMs: 20_000,
        keepAliveIntervalMs: 30_000,
        cachedGroupMetadata: async (jid: string) => getNormalizedGroupMetadata(jid),
        getMessage: async (key: WAMessageKey) => {
          // Check in-memory cache first (recently sent messages).
          const cached = sentMessageCache.get(key.id || '');
          if (cached) return cached;
          // Fall back to per-session outbound.db so retries survive after the
          // in-memory cache ages out or the host restarts. Must apply the
          // same formatWhatsApp + assistant prefix transformation that
          // `sendRawMessage` applied at original-send time, otherwise the
          // re-encrypted content won't match the original ciphertext and
          // peers will reject the retry.
          const lookup = getMessageContentLookup();
          if (lookup && key.id && key.remoteJid) {
            const hit = lookup(key.id, key.remoteJid);
            if (hit) {
              const formatted = formatWhatsApp(hit.text);
              const name = hit.assistantName ?? ASSISTANT_NAME;
              const sep = hit.assistantPrefixSeparator ?? ': ';
              const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `${name}${sep}${formatted}`;
              return proto.Message.fromObject({ conversation: prefixed });
            }
          }
          // Return empty message rather than undefined to prevent the
          // protocol getting stuck — peers fall back to "this message
          // can't be displayed" instead of an indefinite spinner.
          return proto.Message.fromObject({});
        },
      });

      // Request pairing code if phone number is set and not yet registered
      if (phoneNumber && !state.creds.registered) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            log.info(`WhatsApp pairing code: ${code}`);
            log.info('Enter in WhatsApp > Linked Devices > Link with phone number');
            fs.writeFileSync(pairingCodeFile, code, 'utf-8');
          } catch (err) {
            log.error('Failed to request pairing code', { err });
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) {
          // QR code auth — print to terminal AND write a scannable PNG to
          // <authDir>/qr.png so the operator can open it from a file
          // browser / image viewer if their terminal mangles the ANSI
          // QR (logger word-wrap, narrow window, copy-paste artifacts).
          (async () => {
            try {
              const QRCode = await import('qrcode');
              const qrText = await QRCode.toString(qr, { type: 'terminal', small: true });
              log.info('WhatsApp QR code — scan with WhatsApp > Linked Devices:\n' + qrText);
              const pngPath = path.join(authDir, 'qr.png');
              await QRCode.toFile(pngPath, qr, { width: 512, margin: 2 });
              log.info('WhatsApp QR code also written as PNG', { path: pngPath });
            } catch (err) {
              log.info('WhatsApp QR code (raw)', { qr, err: String(err) });
            }
          })();
        }

        if (connection === 'close') {
          connected = false;
          const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const shouldReconnect = reason !== DisconnectReason.loggedOut;

          log.info('WhatsApp connection closed', { reason, shouldReconnect });

          if (shouldReconnect) {
            log.info('Reconnecting...');
            connectSocket().catch((err) => {
              log.error('Failed to reconnect, retrying in 5s', { err });
              setTimeout(() => {
                connectSocket().catch((err2) => {
                  log.error('Reconnection retry failed', { err: err2 });
                });
              }, RECONNECT_DELAY_MS);
            });
          } else {
            log.info('WhatsApp logged out');
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp logged out'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          }
        } else if (connection === 'open') {
          connected = true;
          log.info('Connected to WhatsApp');

          // Clean up pairing code file after successful connection
          try {
            if (fs.existsSync(pairingCodeFile)) fs.unlinkSync(pairingCodeFile);
          } catch {
            /* ignore */
          }

          // Announce availability for presence updates
          sock.sendPresenceUpdate('available').catch((err) => {
            log.warn('Failed to send presence update', { err });
          });

          // Build LID → phone mapping from auth state
          if (sock.user) {
            const phoneUser = sock.user.id.split(':')[0];
            const lidUser = sock.user.lid?.split(':')[0];
            if (lidUser && phoneUser) {
              setLidPhoneMapping(lidUser, `${phoneUser}@s.whatsapp.net`);
              botLidUser = lidUser;
            }
          }

          // Flush queued messages
          flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

          // Group sync
          syncGroupMetadata().catch((err) => log.error('Initial group sync failed', { err }));
          if (!groupSyncTimerStarted) {
            groupSyncTimerStarted = true;
            setInterval(() => {
              syncGroupMetadata().catch((err) => log.error('Periodic group sync failed', { err }));
            }, GROUP_SYNC_INTERVAL_MS);
          }

          // Signal first open
          if (resolveFirstOpen) {
            resolveFirstOpen();
            resolveFirstOpen = undefined;
            rejectFirstOpen = undefined;
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // Inbound messages
      sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          try {
            if (!msg.message) continue;
            const normalized = normalizeMessageContent(msg.message);
            if (!normalized) continue;
            const rawJid = msg.key.remoteJid;
            if (!rawJid || rawJid === 'status@broadcast') continue;

            // Translate LID → phone JID
            let chatJid = await translateJid(rawJid);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (chatJid.endsWith('@lid') && (msg.key as any).senderPn) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const pn = (msg.key as any).senderPn as string;
              const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
              setLidPhoneMapping(rawJid.split('@')[0].split(':')[0], phoneJid);
              chatJid = phoneJid;
            }

            const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
            const isGroup = chatJid.endsWith('@g.us');

            // Notify metadata for group discovery
            setupConfig.onMetadata(chatJid, undefined, isGroup);

            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Normalize bot LID mention → assistant name for trigger matching
            if (botLidUser && content.includes(`@${botLidUser}`)) {
              content = content.replace(`@${botLidUser}`, `@${ASSISTANT_NAME}`);
            }

            // Download media attachments (images, video, audio, documents)
            const attachments = await downloadInboundMedia(msg, normalized);

            // Skip empty protocol messages (no text and no attachments)
            if (!content && attachments.length === 0) continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];
            const fromMe = msg.key.fromMe || false;
            // fromMe semantics differ between deployment modes:
            //
            //   - ASSISTANT_HAS_OWN_NUMBER=true (Optimus has its own
            //     WhatsApp number): fromMe means the bot itself sent it.
            //     Drop to prevent echo loop.
            //   - ASSISTANT_HAS_OWN_NUMBER=false (shared-number, the
            //     assistant runs on the human's linked device):
            //     EVERY message the human sends is fromMe because
            //     Baileys sees the link from the human's phone. We
            //     can't drop, or the bot never hears its operator.
            //     The bot's own outbound messages get a sentinel prefix
            //     (`${ASSISTANT_NAME}:` or 🤖) which `isBotMessage`
            //     below catches; downstream router uses that flag to
            //     prevent echoes.
            if (fromMe && ASSISTANT_HAS_OWN_NUMBER) continue;

            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`) || content.startsWith('🤖');

            // Check if this reply answers a pending question via slash command
            const pending = pendingQuestions.get(chatJid);
            if (pending && content.startsWith('/')) {
              const cmd = content.trim().toLowerCase();
              const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
              if (matched) {
                const voterName = msg.pushName || sender.split('@')[0];
                setupConfig.onAction(pending.questionId, matched.value, sender);
                pendingQuestions.delete(chatJid);
                await sendRawMessage(chatJid, `${matched.selectedLabel} by ${voterName}`);
                log.info('Question answered', {
                  questionId: pending.questionId,
                  value: matched.value,
                  voterName,
                });
                continue; // Don't forward this reply to the agent
              }
            }

            const inbound: InboundMessage = {
              id: msg.key.id || `wa-${Date.now()}`,
              kind: 'chat',
              content: {
                text: content,
                sender,
                senderName,
                ...(attachments.length > 0 && { attachments }),
                fromMe,
                isBotMessage,
                isGroup,
                chatJid,
              },
              timestamp,
              // Hoist isBotMessage to the top-level InboundMessage so the
              // router can gate engagement without parsing content. Same
              // value as the nested copy — kept in both places because
              // existing readers expect content.isBotMessage.
              isBotMessage,
              isGroup,
            };

            // WhatsApp doesn't use threads — threadId is null
            setupConfig.onInbound(chatJid, null, inbound);
          } catch (err) {
            log.error('Error processing incoming WhatsApp message', {
              err,
              remoteJid: msg.key?.remoteJid,
            });
          }
        }
      });
    }

    // --- ChannelAdapter implementation ---

    const adapter: ChannelAdapter = {
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,

      async setup(hostConfig: ChannelSetup) {
        setupConfig = hostConfig;

        // Connect and wait for first open
        await new Promise<void>((resolve, reject) => {
          resolveFirstOpen = resolve;
          rejectFirstOpen = reject;
          connectSocket().catch(reject);
        });

        log.info('WhatsApp adapter initialized');
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const content = message.content as Record<string, unknown>;

        // Ask question → text with slash command replies
        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          const question = content.question as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options: NormalizedOption[] = normalizeOptions(content.options as never);

          const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
          const text = `*${title}*\n\n${question}\n\nReply with:\n${optionLines}`;
          const msgId = await sendRawMessage(platformId, text);
          if (msgId) {
            pendingQuestions.set(platformId, { questionId, options });
            if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
              const oldest = pendingQuestions.keys().next().value!;
              pendingQuestions.delete(oldest);
            }
          }
          return msgId;
        }

        // Reaction → emoji on a message
        if (content.operation === 'reaction' && content.messageId && content.emoji) {
          try {
            await sock.sendMessage(platformId, {
              react: {
                text: content.emoji as string,
                key: { remoteJid: platformId, id: content.messageId as string, fromMe: false },
              },
            });
          } catch (err) {
            log.debug('Failed to send reaction', { platformId, err });
          }
          return;
        }

        // Normal message (with optional file attachments)
        const text = (content.markdown as string) || (content.text as string);
        const hasFiles = message.files && message.files.length > 0;

        if (!text && !hasFiles) return;

        // Send file attachments (first file gets the caption, rest are captionless)
        if (hasFiles) {
          let captionUsed = false;
          for (const file of message.files!) {
            try {
              const ext = path.extname(file.filename).toLowerCase();
              const caption = !captionUsed ? text : undefined;
              const mediaMsg = buildMediaMessage(file.data, file.filename, ext, caption);
              const sent = await sock.sendMessage(platformId, mediaMsg);
              if (sent?.key?.id && sent.message) {
                sentMessageCache.set(sent.key.id, sent.message);
              }
              if (caption) captionUsed = true;
            } catch (err) {
              log.error('Failed to send file', { platformId, filename: file.filename, err });
            }
          }
          if (captionUsed) return; // Text was sent as caption
        }

        if (text) {
          const formatted = formatWhatsApp(text);
          const name = message.assistantName ?? ASSISTANT_NAME;
          const sep = message.assistantPrefixSeparator ?? ': ';
          const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `${name}${sep}${formatted}`;
          return sendRawMessage(platformId, prefixed);
        }
      },

      async setTyping(platformId: string) {
        try {
          await sock.sendPresenceUpdate('composing', platformId);
        } catch (err) {
          log.debug('Failed to update typing status', { jid: platformId, err });
        }
      },

      async teardown() {
        connected = false;
        sock?.end(undefined);
        log.info('WhatsApp adapter shut down');
      },

      isConnected() {
        return connected;
      },

      async syncConversations(): Promise<ConversationInfo[]> {
        try {
          const groups = await sock.groupFetchAllParticipating();
          return Object.entries(groups)
            .filter(([, m]) => m.subject)
            .map(([jid, m]) => ({
              platformId: jid,
              name: m.subject,
              isGroup: true,
            }));
        } catch (err) {
          log.error('Failed to sync WhatsApp conversations', { err });
          return [];
        }
      },
    };

    return adapter;
  },
});
