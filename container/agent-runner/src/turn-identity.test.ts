import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bindIdentityTurn, extendIdentityTurn } from './turn-identity.js';
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

for (const permit of [true, false])
  it(`real warm poll loop ${permit ? 'pushes only after acceptance' : 'never pushes refused input'}`, async () => {
    const inbox = getInboundDb();
    inbox.exec(
      "INSERT INTO destinations(name,display_name,type,channel_type,platform_id,agent_group_id) VALUES('channel','Fixture','channel','discord','channel',NULL)",
    );
    const framesSeen = new Set<string>();
    const now = new Date(Date.now() - 1000).toISOString();
    const initial = JSON.stringify({ text: 'hello', author: { userId: 'alice' } });
    inbox
      .prepare(
        "INSERT INTO messages_in(id,kind,content,channel_type,platform_id,timestamp,process_after) VALUES('warm-first','chat-sdk',?,'discord','channel',?,?)",
      )
      .run(initial, now, now);
    const file = path.join(root, 'warm-identity.json');
    process.env.OPTIMUS_TURN_IDENTITY_FILE = file;
    const controller = new AbortController();
    let accepted = false;
    let seen = false;
    let pushes = 0;
    let finish = () => {};
    const host = setInterval(() => {
      const row = getUndeliveredMessages().find((m) => m.kind === 'system' && !framesSeen.has(m.id));
      if (!row) return;
      framesSeen.add(row.id);
      const req = JSON.parse(row.content);
      if (req.action === 'identity_turn_begin') fs.writeFileSync(file, JSON.stringify({ turnId: req.turnId }));
      if (req.action === 'identity_turn_followup' && !seen) {
        seen = true;
        expect(req.triggerIds).toEqual(['warm-second']);
        expect(pushes).toBe(0);
        setTimeout(() => {
          accepted = permit;
          fs.writeFileSync(
            file,
            JSON.stringify({ turnId: req.turnId, followupRequestId: req.requestId, followupAccepted: permit }),
          );
          if (!permit) setTimeout(() => finish(), 100);
        }, 30);
      }
      if (req.action === 'identity_turn_end') fs.writeFileSync(file, JSON.stringify({ turnId: null }));
    }, 5);
    const provider: AgentProvider = {
      registerMemorySessionHook() {},
      isSessionInvalid: () => false,
      query: () => ({
        events: (async function* () {
          yield { type: 'init' as const, continuation: 'warm' };
          const pending = new Promise<void>((resolve) => {
            finish = resolve;
          });
          inbox
            .prepare(
              "INSERT INTO messages_in(id,kind,content,channel_type,platform_id,timestamp,process_after) VALUES('warm-second','chat-sdk',?,'discord','channel',?,?)",
            )
            .run(JSON.stringify({ text: 'followup', author: { userId: 'alice' } }), now, now);
          await pending;
          yield { type: 'result' as const, text: '<message to="channel">done</message>' };
          controller.abort();
        })(),
        push() {
          expect(accepted).toBe(true);
          pushes++;
          finish();
        },
        end() {
          finish();
        },
        abort() {
          finish();
        },
      }),
    };
    try {
      await runPollLoop({ provider, providerName: 'mock', cwd: root, signal: controller.signal });
      expect(seen).toBe(true);
      expect(pushes).toBe(permit ? 1 : 0);
    } finally {
      controller.abort();
      clearInterval(host);
    }
  });

it('warm inputs wait for their own host ACK and cannot use a previous opaque reference', async () => {
  let snapshot: { turnId: string | null; followupRequestId?: string; followupAccepted?: boolean } = { turnId: null };
  let pending: { turnId: string; requestId: string } | null = null;
  let waits = 0;
  const release = await bindIdentityTurn(['first'], {
    file: 'fixture',
    read: () => snapshot,
    send: async (action, turnId, _ids, requestId) => {
      if (action === 'identity_turn_begin') snapshot = { turnId };
      else if (action === 'identity_turn_followup') {
        pending = { turnId, requestId: requestId! };
        snapshot = { turnId, followupRequestId: 'wrong-reference', followupAccepted: true };
      } else snapshot = { turnId: null };
    },
    wait: async () => {
      waits++;
      if (pending) snapshot = { turnId: pending.turnId, followupRequestId: pending.requestId, followupAccepted: true };
    },
  });
  expect(await extendIdentityTurn(['followup'])).toBe(true);
  expect(waits).toBe(1);
  await release();
});
it('a denied followup cannot run under an unchanged previous host principal', async () => {
  let snapshot: { turnId: string | null; followupRequestId?: string; followupAccepted?: boolean } = { turnId: null };
  const release = await bindIdentityTurn(['first'], {
    file: 'fixture',
    read: () => snapshot,
    send: async (action, turnId, _ids, requestId) => {
      snapshot =
        action === 'identity_turn_end'
          ? { turnId: null }
          : {
              turnId,
              ...(action === 'identity_turn_followup' ? { followupRequestId: requestId, followupAccepted: false } : {}),
            };
    },
    wait: async () => {},
  });
  expect(await extendIdentityTurn(['other-user'])).toBe(false);
  await release();
});
