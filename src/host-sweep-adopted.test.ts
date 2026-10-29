/**
 * Idle stop and hard limit for containers adopted across a host restart.
 *
 * Adoption re-claims the session, so the claim time is the adoption. The SLA
 * used to discard every heartbeat older than the claim, which zeroed an idle
 * adopted container's heartbeat: the idle stop needs a real heartbeat, and the
 * ceiling fell back to the adoption time. A run of restarts less than 30 min
 * apart kept an idle Stanielle container up for over an hour (2026-10-29).
 * The adopted container's own start is now the heartbeat floor and the
 * ceiling clock. Drives the real sweep against real session DBs, mocking only
 * the container runner.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-host-sweep-adopted',
    ABSOLUTE_CEILING_MS_RAW: '',
    CLAIM_STUCK_MS_RAW: '',
  };
});

const runtime = vi.hoisted(() => ({ startedAtMs: 0, adopted: true }));
vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => runtime.startedAtMs),
  getContainerActivityFloorMs: vi.fn(() => (runtime.adopted ? runtime.startedAtMs : undefined)),
  isContainerRunning: vi.fn().mockReturnValue(true),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: vi.fn(() => null) }));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { tryClaimSession } from './db/coordination.js';
import { createSession } from './db/sessions.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { heartbeatPath, initSessionFolder } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-adopted';
const AG = 'ag-test';
const SESS = 'sess-test';
const SWEEP_INTERVAL_MS = 60_000;
const MIN = 60 * 1000;

const sweepCallbacks: Array<() => void> = [];
const realSetTimeout = global.setTimeout;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

async function runSweepTick(): Promise<void> {
  const before = sweepCallbacks.length;
  if (before === 0) startHostSweep();
  else sweepCallbacks[before - 1]();
  await vi.waitFor(() => expect(sweepCallbacks.length).toBe(before + 1));
}

function touchHeartbeat(ageMs: number): void {
  const file = heartbeatPath(AG, SESS);
  fs.writeFileSync(file, '');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

function seedClaim(messageId: string, ageMs: number): void {
  const db = new Database(outboundDbPath(AG, SESS));
  db.prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)").run(
    messageId,
    new Date(Date.now() - ageMs).toISOString(),
  );
  db.close();
}

beforeEach(async () => {
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(true);
  vi.mocked(killContainer).mockReset();
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);
  runtime.adopted = true;
  runtime.startedAtMs = Date.now() - 60 * MIN;

  sweepCallbacks.length = 0;
  setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === SWEEP_INTERVAL_MS) {
      sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  const created = new Date().toISOString();
  await createAgentGroup({
    id: AG,
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: created,
  });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: created,
  });
  initSessionFolder(AG, SESS);
  // The host just restarted and adopted the container: claimed_at = now.
  await tryClaimSession({ sessionId: SESS, instanceId: 'new-host', expectedIncarnation: 0, now: created });
});

afterEach(async () => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('adopted container SLA', () => {
  it('stops an adopted container idle past the timeout, using its pre-restart heartbeat', async () => {
    touchHeartbeat(20 * MIN);
    await runSweepTick();
    expect(killContainer).toHaveBeenCalledWith(SESS, 'idle-timeout');
  });

  it('stops an adopted container past the hard limit even with no heartbeat since it started', async () => {
    // Heartbeat left by an earlier container: not this one's evidence.
    touchHeartbeat(90 * MIN);
    runtime.startedAtMs = Date.now() - 40 * MIN;
    await runSweepTick();
    expect(killContainer).toHaveBeenCalledWith(SESS, 'absolute-ceiling');
  });

  it('leaves a busy adopted container alone', async () => {
    seedClaim('m-1', 3 * MIN);
    touchHeartbeat(10 * 1000);
    await runSweepTick();
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('keeps the claim-time grace for a spawned container (no adoption floor)', async () => {
    runtime.adopted = false;
    runtime.startedAtMs = Date.now();
    touchHeartbeat(20 * MIN);
    await runSweepTick();
    // The stale heartbeat predates this incarnation's claim: no idle stop.
    expect(killContainer).not.toHaveBeenCalled();
  });
});
