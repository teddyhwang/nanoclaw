import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bindIdentityTurn } from './turn-identity.js';
import { runPollLoop } from './poll-loop.js';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import type { AgentProvider } from './providers/types.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-turn-'));
  initTestSessionDb();
});
afterEach(() => {
  delete process.env.OPTIMUS_TURN_IDENTITY_FILE;
  closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
});
it('does not start a turn without a host acknowledgement', async () => {
  let sent = false;
  await expect(
    bindIdentityTurn(['trigger'], {
      file: '/not-a-real-file',
      read: () => null,
      send: async () => {
        sent = true;
      },
      wait: async () => {},
    }),
  ).rejects.toThrow('refusing to start provider query');
  expect(sent).toBe(true);
});
it('waits for its own generation rather than accepting the previous turn', async () => {
  let binding: { turnId: string | null } = { turnId: 'old-turn' };
  let requested = '';
  let waits = 0;
  const release = await bindIdentityTurn(['trigger'], {
    file: 'fixture',
    read: () => binding,
    send: async (action, turnId) => {
      if (action === 'identity_turn_begin') requested = turnId;
      else binding = { turnId: null };
    },
    wait: async () => {
      waits++;
      binding = { turnId: requested };
    },
  });
  expect(waits).toBe(1);
  expect(requested).not.toBe('old-turn');
  await release();
});
it('the real poll loop binds its selected batch before provider.query and releases it afterward', async () => {
  const file = path.join(root, 'sender-identity.json');
  fs.writeFileSync(file, JSON.stringify({ turnId: null }));
  process.env.OPTIMUS_TURN_IDENTITY_FILE = file;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
    VALUES ('trigger-one', 'chat', ?, 'pending', 1, ?)`,
    )
    .run(new Date().toISOString(), JSON.stringify({ senderId: 'alice', text: 'hello' }));
  const controller = new AbortController();
  let queries = 0;
  let began = false;
  let ended = false;
  const seen = new Set<string>();
  const host = setInterval(() => {
    for (const message of getUndeliveredMessages()) {
      if (message.kind !== 'system' || seen.has(message.id)) continue;
      seen.add(message.id);
      const request = JSON.parse(message.content);
      if (request.action === 'identity_turn_begin') {
        expect(queries).toBe(0);
        expect(request.triggerIds).toEqual(['trigger-one']);
        began = true;
        fs.writeFileSync(file, JSON.stringify({ turnId: request.turnId }));
      }
      if (request.action === 'identity_turn_end') {
        ended = true;
        fs.writeFileSync(file, JSON.stringify({ turnId: null }));
      }
    }
  }, 5);
  const provider: AgentProvider = {
    registerMemorySessionHook() {},
    isSessionInvalid: () => false,
    query: () => {
      expect(began).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).turnId).toMatch(/^turn-/);
      queries++;
      controller.abort();
      return { events: (async function* () {})(), push() {}, end() {}, abort() {} };
    },
  };
  try {
    await runPollLoop({ provider, providerName: 'mock', cwd: root, signal: controller.signal });
    expect(queries).toBe(1);
    expect(ended).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).turnId).toBeNull();
  } finally {
    clearInterval(host);
  }
});
