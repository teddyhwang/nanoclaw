/**
 * Tests for `handleRecurrence` — the fire-time materializer.
 *
 * Post-S405-fix model: the series lives in the host-only agent-group
 * schedule.db. handleRecurrence reads due series from schedule.db, writes
 * ONE pending occurrence into the session inbound.db, and advances the
 * series in schedule.db (next cron occurrence, or cancel a one-shot).
 *
 * Invariants under test:
 *  - a due recurring series materializes exactly one inbound.db occurrence
 *    and the series advances to a FUTURE process_after (still pending);
 *  - cron is interpreted in TIMEZONE, not UTC (ported from v1) — the
 *    advanced process_after is a real future instant;
 *  - a one-shot fires once then the series is cancelled (never fires
 *    twice);
 *  - a not-yet-due series materializes nothing;
 *  - idempotency: a second tick while the prior occurrence is still
 *    unconsumed does NOT stack a duplicate inbound.db row (but the
 *    schedule still advances so the cron clock doesn't drift).
 *
 * schedule.db is opened via the base-dir-explicit seam (openScheduleDbAt
 * + the injectable opener arg on handleRecurrence) so the test is
 * hermetic and not bound to config.ts's import-time DATA_DIR snapshot.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { handleRecurrence } from './recurrence.js';
import { openScheduleDbAt, upsertSeries } from './schedule-store.js';
import type { Session } from '../../types.js';

const TEST_ROOT = '/tmp/nanoclaw-recurrence-test';
const AG = 'ag-test';
const SESS = 'sess-test';
const BASE = path.join(TEST_ROOT, 'data', 'v2-sessions');
const SESS_DIR = path.join(BASE, AG, SESS);
const IN_DB = path.join(SESS_DIR, 'inbound.db');

// Base-dir-explicit opener injected into handleRecurrence so it reads the
// same tmp schedule.db the test seeds.
const openSched = (ag: string) => openScheduleDbAt(BASE, ag);

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(SESS_DIR, { recursive: true });
  ensureSchema(IN_DB, 'inbound');
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

function fakeSession(): Session {
  return {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

function seedSeries(seriesId: string, recurrence: string | null, processAfter: string | null) {
  const sched = openScheduleDbAt(BASE, AG);
  try {
    upsertSeries(sched, {
      seriesId,
      agentGroupId: AG,
      recurrence,
      processAfter,
      content: JSON.stringify({ prompt: 'do it', script: null, createdByUserId: null }),
      platformId: null,
      channelType: null,
      threadId: null,
    });
  } finally {
    sched.close();
  }
}

function inboundTaskRows() {
  const db = openInboundDb(IN_DB);
  try {
    return db
      .prepare(
        `SELECT id, status, process_after, recurrence, series_id, kind, trigger
           FROM messages_in WHERE kind='task' ORDER BY seq`,
      )
      .all() as Array<{
      id: string;
      status: string;
      process_after: string | null;
      recurrence: string | null;
      series_id: string;
      kind: string;
      trigger: number;
    }>;
  } finally {
    db.close();
  }
}

function seriesRow(seriesId: string) {
  const sched = openScheduleDbAt(BASE, AG);
  try {
    return sched
      .prepare(`SELECT status, process_after, last_fired_at FROM task_series WHERE series_id=?`)
      .get(seriesId) as { status: string; process_after: string | null; last_fired_at: string | null };
  } finally {
    sched.close();
  }
}

describe('handleRecurrence — fire-time materialization', () => {
  it('materializes one due occurrence and advances the recurring series into the future', async () => {
    seedSeries('task-1', '0 9 * * *', '2020-01-01T00:00:00.000Z'); // long overdue
    const inDb = openInboundDb(IN_DB);
    try {
      await handleRecurrence(inDb, fakeSession(), openSched);
    } finally {
      inDb.close();
    }

    const rows = inboundTaskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].series_id).toBe('task-1');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].trigger).toBe(1);
    // The occurrence is a fire-now row: recurrence + process_after live in
    // schedule.db, not on the transient inbound row.
    expect(rows[0].recurrence).toBeNull();
    expect(rows[0].process_after).toBeNull();
    expect(rows[0].id).not.toBe('task-1'); // fresh occurrence id, not the series id

    const series = seriesRow('task-1');
    expect(series.status).toBe('pending'); // still live (recurring)
    expect(new Date(series.process_after!).getTime()).toBeGreaterThan(Date.now()); // advanced
    expect(series.last_fired_at).toBeTruthy();
  });

  it('fires a one-shot exactly once then cancels the series', async () => {
    seedSeries('task-oneshot', null, '2020-01-01T00:00:00.000Z');
    const inDb = openInboundDb(IN_DB);
    try {
      await handleRecurrence(inDb, fakeSession(), openSched);
    } finally {
      inDb.close();
    }

    expect(inboundTaskRows()).toHaveLength(1);
    const series = seriesRow('task-oneshot');
    expect(series.status).toBe('cancelled');
    expect(series.process_after).toBeNull();
  });

  it('materializes nothing for a not-yet-due series', async () => {
    seedSeries('task-future', '0 9 * * *', new Date(Date.now() + 3600_000).toISOString());
    const inDb = openInboundDb(IN_DB);
    try {
      await handleRecurrence(inDb, fakeSession(), openSched);
    } finally {
      inDb.close();
    }
    expect(inboundTaskRows()).toHaveLength(0);
    expect(seriesRow('task-future').status).toBe('pending'); // untouched
  });

  it('is idempotent: a second tick with the prior occurrence still live does not stack a duplicate', async () => {
    seedSeries('task-rec', '*/5 * * * *', '2020-01-01T00:00:00.000Z');

    const run = async () => {
      const inDb = openInboundDb(IN_DB);
      try {
        await handleRecurrence(inDb, fakeSession(), openSched);
      } finally {
        inDb.close();
      }
    };

    await run();
    expect(inboundTaskRows()).toHaveLength(1);
    const firstFiredAt = seriesRow('task-rec').last_fired_at;

    // Force the series due again (simulate the next cron tick arriving)
    // while the first occurrence is STILL pending (container hasn't
    // consumed it). The materializer must not add a second inbound row,
    // but must still process the series (advance + restamp last_fired_at)
    // so the cron clock keeps tracking. (process_after can legitimately
    // resolve to the same wall-clock slot for a fixed */5 cron — the
    // advance is observable via last_fired_at, which always restamps.)
    await new Promise((r) => setTimeout(r, 5));
    seedSeries('task-rec', '*/5 * * * *', '2020-01-01T00:00:00.000Z');
    await run();

    expect(inboundTaskRows()).toHaveLength(1); // NO duplicate
    expect(seriesRow('task-rec').last_fired_at).not.toBe(firstFiredAt); // re-processed
  });
});
