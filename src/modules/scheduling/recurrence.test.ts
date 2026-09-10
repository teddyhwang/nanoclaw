/** S405 schedule.db fire-time materialization tests. */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: vi.fn(() => null) }));
vi.mock('../typing/index.js', () => ({ stopTypingRefresh: vi.fn() }));
const timezone = vi.hoisted(() => ({ value: 'UTC' }));
vi.mock('../../container-config.js', () => ({
  resolveGroupTimezone: vi.fn(async () => timezone.value),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { wrapSqliteInbound } from '../../mailbox/sqlite/index.js';
import { ensureSchema, openInboundDb } from '../../mailbox/sqlite/session-db.js';
import type { Session } from '../../types.js';
import { addTaskMaterializationGuard } from '../../engine/task-materialization.js';
import { log } from '../../log.js';
import { handleRecurrence } from './recurrence.js';
import { _maintainSchedulingForTesting } from '../../host-sweep.js';
import { listLiveSeries, openScheduleDbAt, updateSeries, upsertSeries } from './schedule-store.js';

const TEST_ROOT = '/tmp/nanoclaw-recurrence-test';
const AG = 'ag-test';
const SESS = 'sess-test';
const BASE = path.join(TEST_ROOT, 'data', 'v2-sessions');
const SESS_DIR = path.join(BASE, AG, SESS);
const IN_DB = path.join(SESS_DIR, 'inbound.db');

beforeEach(() => {
  timezone.value = 'UTC';
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SESS_DIR, { recursive: true });
  ensureSchema(IN_DB, 'inbound');
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function session(): Session {
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

function seedSeries(
  seriesId: string,
  recurrence: string | null,
  processAfter: string | null,
  content = JSON.stringify({ prompt: 'do it', script: null, createdByUserId: null }),
): void {
  const db = openSchedule();
  try {
    upsertSeries(db, {
      seriesId,
      agentGroupId: AG,
      recurrence,
      processAfter,
      content,
      platformId: null,
      channelType: null,
      threadId: null,
    });
  } finally {
    db.close();
  }
}

function openSchedule(agentGroupId: string = AG) {
  return openScheduleDbAt(BASE, agentGroupId);
}

async function sweep(): Promise<void> {
  const db = openInboundDb(IN_DB);
  try {
    await handleRecurrence(wrapSqliteInbound(db), session(), openSchedule);
  } finally {
    db.close();
  }
}

function inboundTaskRows(): Array<{
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string;
  kind: string;
  trigger: number;
  content: string;
}> {
  const db = openInboundDb(IN_DB);
  try {
    return db
      .prepare(
        `SELECT id, status, process_after, recurrence, series_id, kind, trigger, content
           FROM messages_in WHERE kind = 'task' ORDER BY seq`,
      )
      .all() as ReturnType<typeof inboundTaskRows>;
  } finally {
    db.close();
  }
}

function seriesRow(seriesId: string): {
  status: string;
  process_after: string | null;
  last_fired_at: string | null;
  content: string;
} {
  const db = openSchedule();
  try {
    return db
      .prepare('SELECT status, process_after, last_fired_at, content FROM task_series WHERE series_id = ?')
      .get(seriesId) as ReturnType<typeof seriesRow>;
  } finally {
    db.close();
  }
}

describe('handleRecurrence', () => {
  it('materializes one due occurrence and advances the recurring schedule.db series', async () => {
    seedSeries('task-1', '0 9 * * *', '2020-01-01T00:00:00.000Z');

    await sweep();

    const rows = inboundTaskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      process_after: null,
      recurrence: null,
      series_id: 'task-1',
      kind: 'task',
      trigger: 1,
    });
    expect(rows[0].id).not.toBe('task-1');

    const series = seriesRow('task-1');
    expect(series.status).toBe('pending');
    expect(new Date(series.process_after!).getTime()).toBeGreaterThan(Date.now());
    expect(series.last_fired_at).toBeTruthy();
  });

  it('grounds the next cron fire in the async group timezone', async () => {
    timezone.value = 'Asia/Tokyo';
    seedSeries('task-tz', '0 9 * * *', '2020-01-01T00:00:00.000Z');

    await sweep();

    // Tokyo has no DST: 09:00 local is exactly 00:00 UTC.
    expect(seriesRow('task-tz').process_after).toMatch(/T00:00:00\.000Z$/);
  });

  it('fires a one-shot once, cancels its series, and never fires it again', async () => {
    seedSeries('task-oneshot', null, '2020-01-01T00:00:00.000Z');

    await sweep();
    await sweep();

    expect(inboundTaskRows()).toHaveLength(1);
    expect(seriesRow('task-oneshot')).toMatchObject({ status: 'cancelled', process_after: null });
  });

  it('does not materialize a future series', async () => {
    seedSeries('task-future', '0 9 * * *', new Date(Date.now() + 3_600_000).toISOString());

    await sweep();

    expect(inboundTaskRows()).toEqual([]);
    expect(seriesRow('task-future').status).toBe('pending');
  });

  it('cancels an expired recurring series without materializing it', async () => {
    seedSeries(
      'task-expired',
      '0 9 * * *',
      '2020-01-01T00:00:00.000Z',
      JSON.stringify({ prompt: 'obsolete watch', expiresAt: '2020-01-02T00:00:00.000Z' }),
    );

    await sweep();

    expect(inboundTaskRows()).toEqual([]);
    expect(seriesRow('task-expired')).toMatchObject({ status: 'cancelled', process_after: null });
  });

  it('fires the last eligible occurrence then cancels when the next cron run reaches expiry', async () => {
    seedSeries(
      'task-last-run',
      '0 9 * * *',
      '2020-01-01T00:00:00.000Z',
      JSON.stringify({ prompt: 'bounded watch', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );

    await sweep();

    expect(inboundTaskRows()).toHaveLength(1);
    expect(seriesRow('task-last-run')).toMatchObject({ status: 'cancelled', process_after: null });
  });

  it('does not stack a second occurrence while the prior fire is unconsumed', async () => {
    seedSeries('task-rec', '*/5 * * * *', '2020-01-01T00:00:00.000Z');
    await sweep();
    const firstFiredAt = seriesRow('task-rec').last_fired_at;

    await new Promise((resolve) => setTimeout(resolve, 5));
    seedSeries('task-rec', '*/5 * * * *', '2020-01-01T00:00:00.000Z');
    await sweep();

    expect(inboundTaskRows()).toHaveLength(1);
    expect(seriesRow('task-rec').last_fired_at).not.toBe(firstFiredAt);
  });

  it('keeps an already-materialized due run immutable when the live series is updated', async () => {
    const oldContent = JSON.stringify({ prompt: 'old', script: 'echo old', createdByUserId: null });
    seedSeries('task-update', '0 9 * * *', '2020-01-01T00:00:00.000Z', oldContent);
    await sweep();

    const db = openSchedule();
    try {
      expect(updateSeries(db, 'task-update', { prompt: 'new', script: 'echo new' })).toBe(1);
    } finally {
      db.close();
    }

    expect(JSON.parse(inboundTaskRows()[0].content)).toMatchObject({ prompt: 'old', script: 'echo old' });
    expect(JSON.parse(seriesRow('task-update').content)).toMatchObject({ prompt: 'new', script: 'echo new' });
  });
});

describe('S405 task-series projection', () => {
  it('replaces the container-visible snapshot without exposing schedule.db', () => {
    seedSeries('task-live', '0 9 * * *', '2999-01-01T00:00:00.000Z');
    const schedule = openSchedule();
    const inbound = openInboundDb(IN_DB);
    try {
      const mailbox = wrapSqliteInbound(inbound);
      mailbox.replaceTaskSeriesSnapshot(
        listLiveSeries(schedule).map((series) => ({
          seriesId: series.series_id,
          status: series.status === 'paused' ? 'paused' : 'pending',
          recurrence: series.recurrence,
          processAfter: series.process_after,
          content: series.content,
        })),
      );
      expect(inbound.prepare('SELECT series_id FROM task_series').all()).toEqual([{ series_id: 'task-live' }]);

      mailbox.replaceTaskSeriesSnapshot([]);
      expect(inbound.prepare('SELECT series_id FROM task_series').all()).toEqual([]);
    } finally {
      schedule.close();
      inbound.close();
    }
  });
});

describe('host eligibility guard', () => {
  it('skips silently before materialization, preserves the last real fire, and rechecks after activity', async () => {
    seedSeries('dream-test', '0 4 * * *', '2020-01-01T00:00:00Z');
    const schedule = openSchedule();
    schedule.prepare("UPDATE task_series SET last_fired_at = '2020-01-01T00:00:00Z'").run();
    let eligible = false;
    const remove = addTaskMaterializationGuard(() => eligible);
    try {
      vi.mocked(log.info).mockClear();
      vi.mocked(log.debug).mockClear();
      await sweep();
      const inbound = openInboundDb(IN_DB);
      expect(inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 0 });
      expect(log.info).not.toHaveBeenCalled();
      expect(log.debug).not.toHaveBeenCalled();
      expect(schedule.prepare('SELECT status, last_fired_at FROM task_series').get()).toEqual({
        status: 'pending',
        last_fired_at: '2020-01-01T00:00:00Z',
      });
      eligible = true;
      schedule.prepare("UPDATE task_series SET process_after = '2020-01-01T00:00:00Z'").run();
      await sweep();
      expect(inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
      inbound.close();
    } finally {
      remove();
      schedule.close();
    }
  });

  it('does not swallow lookup errors or consume their due occurrence', async () => {
    seedSeries('guard-failure', '0 4 * * *', '2020-01-01T00:00:00Z');
    const remove = addTaskMaterializationGuard(() => {
      throw new Error('history unavailable');
    });
    try {
      await sweep();
      const schedule = openSchedule();
      expect(schedule.prepare('SELECT process_after, last_fired_at FROM task_series').get()).toEqual({
        process_after: '2020-01-01T00:00:00.000Z',
        last_fired_at: null,
      });
      schedule.close();
    } finally {
      remove();
    }
  });
});

describe('production sweep snapshot timestamp regression', () => {
  it('projects mixed legacy offsets atomically without firing early or changing source rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T13:21:00.000Z'));
    seedSeries('offset-reminder', null, '2026-09-10T17:20:00.000Z');
    seedSeries('paused', null, null);
    seedSeries('dream', '0 4 * * *', '2026-09-11T08:00:00.000Z');
    const schedule = openSchedule();
    const inbound = openInboundDb(IN_DB);
    const legacy = '2026-09-10T13:20:00-04:00';
    try {
      schedule.prepare('UPDATE task_series SET process_after = ? WHERE series_id = ?').run(legacy, 'offset-reminder');
      schedule.prepare("UPDATE task_series SET status = 'paused' WHERE series_id = 'paused'").run();
      vi.mocked(log.error).mockClear();
      const mailbox = wrapSqliteInbound(inbound);
      await _maintainSchedulingForTesting(mailbox, session(), openSchedule);
      expect(log.error).not.toHaveBeenCalled();
      expect(
        inbound.prepare('SELECT series_id, process_after, status FROM task_series ORDER BY series_id').all(),
      ).toEqual([
        { series_id: 'dream', process_after: '2026-09-11T08:00:00.000Z', status: 'pending' },
        { series_id: 'offset-reminder', process_after: '2026-09-10T17:20:00.000Z', status: 'pending' },
        { series_id: 'paused', process_after: null, status: 'paused' },
      ]);
      expect(inboundTaskRows()).toEqual([]);
      expect(seriesRow('offset-reminder').process_after).toBe(legacy);
      vi.setSystemTime(new Date('2026-09-10T17:20:00.000Z'));
      await _maintainSchedulingForTesting(mailbox, session(), openSchedule);
      await _maintainSchedulingForTesting(mailbox, session(), openSchedule);
      expect(inboundTaskRows()).toHaveLength(1);
      expect(seriesRow('offset-reminder').status).toBe('cancelled');
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      schedule.close();
      inbound.close();
    }
  });
});
