import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop, processQuery } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-script-'));
  initTestSessionDb();
});
afterEach(() => {
  delete process.env.OPTIMUS_TURN_IDENTITY_FILE;
  closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
});
function task(id: string, script: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
    VALUES (?, 'task', ?, 'pending', 1, ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify({ prompt: 'task', script }));
}
it('binds before a pre-task script and releases even when the script skips the model', async () => {
  const file = path.join(root, 'owner.json');
  const observed = path.join(root, 'observed.json');
  fs.writeFileSync(file, JSON.stringify({ turnId: null }));
  process.env.OPTIMUS_TURN_IDENTITY_FILE = file;
  task('script-only', `cat "$OPTIMUS_TURN_IDENTITY_FILE" > '${observed}'\nprintf '{"wakeAgent":false}'`);
  const controller = new AbortController();
  const seen = new Set<string>();
  let queries = 0;
  const host = setInterval(() => {
    for (const row of getUndeliveredMessages()) {
      if (row.kind !== 'system' || seen.has(row.id)) continue;
      seen.add(row.id);
      const message = JSON.parse(row.content);
      if (message.action === 'identity_turn_begin') fs.writeFileSync(file, JSON.stringify({ turnId: message.turnId }));
      if (message.action === 'identity_turn_end') {
        fs.writeFileSync(file, JSON.stringify({ turnId: null }));
        controller.abort();
      }
    }
  }, 5);
  const provider: AgentProvider = {
    registerMemorySessionHook() {},
    isSessionInvalid: () => false,
    query: () => {
      queries++;
      throw Error('script should not wake model');
    },
  };
  try {
    await runPollLoop({ provider, providerName: 'mock', cwd: root, signal: controller.signal });
    expect(queries).toBe(0);
    expect(JSON.parse(fs.readFileSync(observed, 'utf8')).turnId).toMatch(/^turn-/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).turnId).toBeNull();
  } finally {
    clearInterval(host);
  }
});
it('a new task cannot run its pre-task script inside another bound turn', async () => {
  process.env.OPTIMUS_TURN_IDENTITY_FILE = path.join(root, 'owner.json');
  const forbidden = path.join(root, 'wrong-owner-script');
  task('followup', `touch '${forbidden}'; printf '{"wakeAgent":true}'`);
  let ended = false;
  const query: AgentQuery = {
    events: (async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: '' };
      while (!ended) await new Promise((resolve) => setTimeout(resolve, 20));
    })(),
    push() {
      throw Error('must not push a new task under the old identity');
    },
    end() {
      ended = true;
    },
    abort() {
      ended = true;
    },
  };
  await processQuery(
    query,
    { platformId: null, channelType: null, threadId: null, inReplyTo: null, taskFire: true },
    ['initial'],
    'mock',
    null,
  );
  expect(ended).toBe(true);
  expect(fs.existsSync(forbidden)).toBe(false);
  expect(
    getOutboundDb().prepare("SELECT count(*) AS n FROM processing_ack WHERE message_id = 'followup'").get(),
  ).toEqual({ n: 0 });
});
