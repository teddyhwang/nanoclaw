/**
 * Tests for the persistent WhatsApp inbound-key store. Exercises the
 * shape of the data (Baileys-key fields + chain-walk context), the
 * idempotent upsert, and the bounded cleanup (age + row-count).
 *
 * Doesn't cover the wiring into `whatsapp.ts` — that's an integration
 * concern, and Baileys is too heavy to stub in unit tests.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openInboundKeyStore, type InboundKeyStore } from './whatsapp-key-store.js';

const tmpDirs: string[] = [];

function makeStore(): { store: InboundKeyStore; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-keys-'));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'inbound-keys.db');
  return { store: openInboundKeyStore(dbPath), dbPath };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  tmpDirs.length = 0;
});

describe('openInboundKeyStore', () => {
  it('creates the directory and file on first open', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-keys-'));
    tmpDirs.push(dir);
    const nested = path.join(dir, 'whatsapp', 'inbound-keys.db');
    const store = openInboundKeyStore(nested);
    expect(fs.existsSync(nested)).toBe(true);
    store.close();
  });

  it('round-trips a group message with participant', () => {
    const { store } = makeStore();
    store.remember('id-1', {
      remoteJid: '120363@g.us',
      participant: '5511999@s.whatsapp.net',
      fromMe: false,
      ts: '2026-05-12T20:08:00.000Z',
      senderId: '5511999@s.whatsapp.net',
      senderName: 'Jon Cho',
      text: '@optimus, did we tell you which hotel?',
    });
    const rec = store.lookup('id-1');
    expect(rec).toEqual({
      remoteJid: '120363@g.us',
      participant: '5511999@s.whatsapp.net',
      fromMe: false,
      ts: '2026-05-12T20:08:00.000Z',
      senderId: '5511999@s.whatsapp.net',
      senderName: 'Jon Cho',
      text: '@optimus, did we tell you which hotel?',
      replyToMessageId: undefined,
    });
    store.close();
  });

  it('round-trips a DM without participant', () => {
    const { store } = makeStore();
    store.remember('id-dm', {
      remoteJid: '5511999@s.whatsapp.net',
      fromMe: false,
      ts: '2026-05-12T20:00:00.000Z',
      text: 'hi',
    });
    const rec = store.lookup('id-dm');
    expect(rec?.participant).toBeUndefined();
    expect(rec?.remoteJid).toBe('5511999@s.whatsapp.net');
    store.close();
  });

  it('stores reply_to_message_id so a future ancestor walker can chain', () => {
    const { store } = makeStore();
    store.remember('parent', {
      remoteJid: '120363@g.us',
      fromMe: false,
      ts: '2026-05-12T20:00:00.000Z',
      text: 'parent message',
    });
    store.remember('child', {
      remoteJid: '120363@g.us',
      fromMe: false,
      ts: '2026-05-12T20:05:00.000Z',
      text: 'replying to parent',
      replyToMessageId: 'parent',
    });
    expect(store.lookup('child')?.replyToMessageId).toBe('parent');
    // Walker can hop: child → parent → (no further reply) → done.
    const parent = store.lookup(store.lookup('child')!.replyToMessageId!);
    expect(parent?.text).toBe('parent message');
    expect(parent?.replyToMessageId).toBeUndefined();
    store.close();
  });

  it('upsert is idempotent — re-remembering the same id overwrites', () => {
    const { store } = makeStore();
    store.remember('id-1', {
      remoteJid: '120363@g.us',
      fromMe: false,
      ts: '2026-05-12T20:00:00.000Z',
      text: 'first',
    });
    store.remember('id-1', {
      remoteJid: '120363@g.us',
      fromMe: false,
      ts: '2026-05-12T20:05:00.000Z',
      text: 'second',
    });
    expect(store.lookup('id-1')?.text).toBe('second');
    store.close();
  });

  it('lookup returns undefined for unknown ids', () => {
    const { store } = makeStore();
    expect(store.lookup('nope')).toBeUndefined();
    store.close();
  });

  it('survives close + reopen — the whole point of the disk tier', () => {
    const { store, dbPath } = makeStore();
    store.remember('survives', {
      remoteJid: '120363@g.us',
      fromMe: false,
      ts: '2026-05-12T20:00:00.000Z',
      text: 'before restart',
    });
    store.close();

    const reopened = openInboundKeyStore(dbPath);
    expect(reopened.lookup('survives')?.text).toBe('before restart');
    reopened.close();
  });
});

describe('cleanup', () => {
  it('drops rows older than 30 days', () => {
    const { store } = makeStore();
    const now = Date.now();
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 1 * 60 * 60 * 1000).toISOString();
    store.remember('old', { remoteJid: 'jid', fromMe: false, ts: old });
    store.remember('recent', { remoteJid: 'jid', fromMe: false, ts: recent });
    store.cleanup();
    expect(store.lookup('old')).toBeUndefined();
    expect(store.lookup('recent')).toBeDefined();
    store.close();
  });

  it('trims to 10,000 rows when the table overflows', () => {
    const { store } = makeStore();
    // Insert 10,005 rows with monotonically increasing ts. After
    // cleanup, the oldest 5 should be gone.
    const base = Date.now();
    for (let i = 0; i < 10_005; i++) {
      const ts = new Date(base - (10_005 - i) * 1000).toISOString();
      store.remember(`id-${i}`, { remoteJid: 'jid', fromMe: false, ts });
    }
    store.cleanup();
    // Oldest 5 evicted, newest survive.
    expect(store.lookup('id-0')).toBeUndefined();
    expect(store.lookup('id-4')).toBeUndefined();
    expect(store.lookup('id-5')).toBeDefined();
    expect(store.lookup('id-10004')).toBeDefined();
    store.close();
  });

  it('is safe to call when empty', () => {
    const { store } = makeStore();
    expect(() => store.cleanup()).not.toThrow();
    store.close();
  });
});

describe('store path', () => {
  it("creates parent directories that don't exist yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-keys-'));
    tmpDirs.push(dir);
    const deepPath = path.join(dir, 'data-v2', 'optimus', 'whatsapp', 'inbound-keys.db');
    expect(fs.existsSync(path.dirname(deepPath))).toBe(false);
    const store = openInboundKeyStore(deepPath);
    expect(fs.existsSync(deepPath)).toBe(true);
    store.close();
  });
});

// Suppress unused-import warning for beforeEach in case test order
// changes later — keeps the import available without conditional
// imports.
void beforeEach;
