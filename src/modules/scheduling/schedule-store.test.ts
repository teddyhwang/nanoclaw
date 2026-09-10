/**
 * Tests for the agent-group-scoped schedule store (host-only schedule.db).
 *
 * The store is the S405 structural fix: the schedule lives in a host-only
 * WAL DB instead of a container-polled inbound.db, so these tests assert
 * the series lifecycle (schedule → due → advance/cancel one-shot →
 * pause/resume/update → live projection → migration idempotency) that the
 * sweep and MCP tools depend on.
 *
 * We exercise the DAL against a real on-disk SQLite file (WAL, like prod)
 * built with the exported SCHEDULE_SCHEMA, rather than through
 * openScheduleDb's path resolution — that keeps the test hermetic from
 * engine path/config wiring while still proving the SQL.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  SCHEDULE_SCHEMA,
  advanceRecurrence,
  cancelSeries,
  getDueSeries,
  hasSeries,
  listLiveSeries,
  pauseSeries,
  resumeSeries,
  updateSeries,
  upsertSeries,
} from './schedule-store.js';

const TEST_DIR = '/tmp/nanoclaw-schedule-store-test';
const DB_PATH = path.join(TEST_DIR, 'schedule.db');

function freshDb(): Database.Database {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEDULE_SCHEMA);
  return db;
}

function schedule(
  db: Database.Database,
  seriesId: string,
  opts: { recurrence?: string | null; processAfter?: string | null; prompt?: string } = {},
) {
  upsertSeries(db, {
    seriesId,
    agentGroupId: 'ag-test',
    recurrence: opts.recurrence ?? null,
    processAfter: opts.processAfter ?? new Date(Date.now() - 1000).toISOString(),
    content: JSON.stringify({ prompt: opts.prompt ?? 'do the thing', script: null, createdByUserId: null }),
    platformId: null,
    channelType: null,
    threadId: null,
  });
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('schedule-store — series lifecycle (S405 structural fix)', () => {
  it('schedules a series and surfaces it as due once process_after has elapsed', () => {
    const db = freshDb();
    schedule(db, 'task-1', { recurrence: '*/5 * * * *' });
    const due = getDueSeries(db, new Date().toISOString());
    expect(due.map((s) => s.series_id)).toEqual(['task-1']);
    expect(due[0].status).toBe('pending');
    db.close();
  });

  it('does NOT surface a not-yet-due series', () => {
    const db = freshDb();
    schedule(db, 'task-future', {
      recurrence: '*/5 * * * *',
      processAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(getDueSeries(db, new Date().toISOString())).toEqual([]);
    db.close();
  });

  it('advanceRecurrence on a recurring series moves process_after forward, stays pending', () => {
    const db = freshDb();
    schedule(db, 'task-rec', { recurrence: '*/5 * * * *' });
    const next = new Date(Date.now() + 300_000).toISOString();
    const firedAt = new Date().toISOString();
    advanceRecurrence(db, 'task-rec', next, firedAt);

    expect(getDueSeries(db, new Date().toISOString())).toEqual([]); // moved into the future
    const row = db.prepare(`SELECT * FROM task_series WHERE series_id = ?`).get('task-rec') as {
      status: string;
      process_after: string;
      last_fired_at: string;
    };
    expect(row.status).toBe('pending');
    expect(row.process_after).toBe(next);
    expect(row.last_fired_at).toBe(firedAt);
    db.close();
  });

  it('advanceRecurrence with null nextRun cancels a one-shot (never fires twice)', () => {
    const db = freshDb();
    schedule(db, 'task-oneshot', { recurrence: null });
    advanceRecurrence(db, 'task-oneshot', null, new Date().toISOString());

    expect(getDueSeries(db, new Date().toISOString())).toEqual([]);
    const row = db.prepare(`SELECT status, process_after FROM task_series WHERE series_id = ?`).get('task-oneshot') as {
      status: string;
      process_after: string | null;
    };
    expect(row.status).toBe('cancelled');
    expect(row.process_after).toBeNull();
    db.close();
  });

  it('pause stops a series from firing; resume restores it', () => {
    const db = freshDb();
    schedule(db, 'task-p', { recurrence: '*/5 * * * *' });

    expect(pauseSeries(db, 'task-p')).toBe(1);
    expect(getDueSeries(db, new Date().toISOString())).toEqual([]);

    expect(resumeSeries(db, 'task-p')).toBe(1);
    expect(getDueSeries(db, new Date().toISOString()).map((s) => s.series_id)).toEqual(['task-p']);
    db.close();
  });

  it('cancel is terminal — resume cannot revive a cancelled series', () => {
    const db = freshDb();
    schedule(db, 'task-c', { recurrence: '*/5 * * * *' });
    expect(cancelSeries(db, 'task-c')).toBe(1);
    expect(resumeSeries(db, 'task-c')).toBe(0);
    expect(getDueSeries(db, new Date().toISOString())).toEqual([]);
    db.close();
  });

  it('updateSeries merges prompt into content JSON without clobbering, only for live series', () => {
    const db = freshDb();
    schedule(db, 'task-u', { recurrence: '*/5 * * * *', prompt: 'original' });

    const touched = updateSeries(db, 'task-u', {
      prompt: 'updated',
      recurrence: '0 9 * * *',
      expiresAt: '2026-09-06T00:00:00.000Z',
    });
    expect(touched).toBe(1);
    const row = db.prepare(`SELECT content, recurrence FROM task_series WHERE series_id = ?`).get('task-u') as {
      content: string;
      recurrence: string;
    };
    expect(JSON.parse(row.content).prompt).toBe('updated');
    expect(JSON.parse(row.content).script).toBeNull(); // untouched
    expect(JSON.parse(row.content).expiresAt).toBe('2026-09-06T00:00:00.000Z');
    expect(row.recurrence).toBe('0 9 * * *');

    cancelSeries(db, 'task-u');
    expect(updateSeries(db, 'task-u', { prompt: 'too late' })).toBe(0); // not live
    db.close();
  });

  it('listLiveSeries returns pending+paused, excludes cancelled, ordered by next fire', () => {
    const db = freshDb();
    schedule(db, 'task-b', { processAfter: new Date(Date.now() + 200_000).toISOString() });
    schedule(db, 'task-a', { processAfter: new Date(Date.now() + 100_000).toISOString() });
    schedule(db, 'task-x');
    cancelSeries(db, 'task-x');
    pauseSeries(db, 'task-b');

    expect(listLiveSeries(db).map((s) => s.series_id)).toEqual(['task-a', 'task-b']);
    db.close();
  });

  it('upsertSeries is idempotent on series_id (re-schedule replaces, not duplicates)', () => {
    const db = freshDb();
    schedule(db, 'task-dup', { prompt: 'first' });
    schedule(db, 'task-dup', { prompt: 'second' });
    const rows = db.prepare(`SELECT content FROM task_series WHERE series_id = ?`).all('task-dup') as Array<{
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).prompt).toBe('second');
    db.close();
  });

  it('hasSeries gates migration idempotency (true for any status incl cancelled)', () => {
    const db = freshDb();
    expect(hasSeries(db, 'task-mig')).toBe(false);
    schedule(db, 'task-mig');
    expect(hasSeries(db, 'task-mig')).toBe(true);
    cancelSeries(db, 'task-mig');
    expect(hasSeries(db, 'task-mig')).toBe(true); // still present → migration won't re-import
    db.close();
  });
});

describe('schedule-store timestamp boundaries', () => {
  const instant = '2026-09-10T17:20:00.000Z';
  const equivalents = ['2026-09-10T13:20:00-04:00', '2026-09-10T22:50:00+05:30', '2026-09-10T17:20:00Z', instant];

  it.each(equivalents)('canonicalizes writes without changing the instant: %s', (value) => {
    const db = freshDb();
    try {
      schedule(db, 'task', { processAfter: value });
      expect(db.prepare('SELECT process_after FROM task_series').get()).toEqual({ process_after: instant });
      updateSeries(db, 'task', { processAfter: value });
      expect(db.prepare('SELECT process_after FROM task_series').get()).toEqual({ process_after: instant });
    } finally {
      db.close();
    }
  });

  it.each(equivalents)('reads legacy rows as canonical snapshots and fires at the exact instant: %s', (value) => {
    const db = freshDb();
    try {
      schedule(db, 'task', { processAfter: instant });
      db.prepare('UPDATE task_series SET process_after = ?').run(value);
      expect(listLiveSeries(db)[0].process_after).toBe(instant);
      expect(getDueSeries(db, '2026-09-10T17:19:59.999Z')).toEqual([]);
      expect(getDueSeries(db, instant).map((row) => row.series_id)).toEqual(['task']);
      expect(getDueSeries(db, instant)[0].process_after).toBe(instant);
      // Projection/selection must not rewrite the source schedule or advance it.
      expect(db.prepare('SELECT process_after, status, last_fired_at FROM task_series').get()).toEqual({
        process_after: value,
        status: 'pending',
        last_fired_at: null,
      });
    } finally {
      db.close();
    }
  });

  it.each(['garbage', '', '2026-09-10', '2026-09-10T13:20:00', '2026-02-30T13:20:00Z'])(
    'rejects invalid/ambiguous timestamps before any write: %s',
    (value) => {
      const db = freshDb();
      try {
        expect(() => schedule(db, 'invalid', { processAfter: value })).toThrow();
        expect(hasSeries(db, 'invalid')).toBe(false);
        schedule(db, 'valid', { processAfter: instant, prompt: 'original' });
        expect(() => updateSeries(db, 'valid', { processAfter: value, prompt: 'changed' })).toThrow();
        expect(JSON.parse(listLiveSeries(db)[0].content).prompt).toBe('original');
        expect(listLiveSeries(db)[0].process_after).toBe(instant);
      } finally {
        db.close();
      }
    },
  );

  it('orders legacy offsets chronologically and preserves null/paused semantics', () => {
    const db = freshDb();
    try {
      schedule(db, 'later', { processAfter: instant });
      schedule(db, 'earlier', { processAfter: instant });
      schedule(db, 'paused', { processAfter: instant });
      schedule(db, 'null', { processAfter: instant });
      db.prepare('UPDATE task_series SET process_after = ? WHERE series_id = ?').run(
        '2026-09-10T13:20:00-04:00',
        'later',
      );
      db.prepare('UPDATE task_series SET process_after = ? WHERE series_id = ?').run(
        '2026-09-10T19:00:00+05:30',
        'earlier',
      );
      pauseSeries(db, 'paused');
      db.prepare("UPDATE task_series SET process_after = NULL WHERE series_id = 'null'").run();
      expect(getDueSeries(db, '2026-09-10T18:00:00Z').map((r) => r.series_id)).toEqual(['earlier', 'later']);
      expect(listLiveSeries(db).find((r) => r.series_id === 'null')?.process_after).toBeNull();
      expect(listLiveSeries(db).find((r) => r.series_id === 'paused')?.status).toBe('paused');
    } finally {
      db.close();
    }
  });
});
