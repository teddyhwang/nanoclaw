/**
 * Tests for the one-time legacy-series → schedule.db migration.
 *
 * Covers: import of a live recurring series out of an old session
 * inbound.db; import out of the `.recurring-carryover.json` sidecar;
 * latest-row-wins across multiple sessions; the hasSeries idempotency
 * gate (never clobber a post-cutover schedule.db row, safe to re-run);
 * reserved-prefix exclusion; and the headline real-world case — the live
 * AI Friends RSS series (every-5-min cron) survives the cutover.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { migrateAgentGroup } from './migrate-legacy-series.js';
import { openScheduleDbAt } from './schedule-store.js';

const TEST_ROOT = '/tmp/nanoclaw-migrate-legacy-test';
const AG = 'ag-1778154011329-g9zust'; // the real AI Friends agent group
const BASE = path.join(TEST_ROOT, 'data', 'v2-sessions');

// Drive the migration with an explicit tmp base dir (the
// base-dir-explicit seam) so it is not bound to config.ts's import-time
// DATA_DIR snapshot.
function migrate() {
  migrateAgentGroup(AG, path.join(BASE, AG), BASE);
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(BASE, AG), { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

function seedInboundSeries(
  sess: string,
  row: {
    id: string;
    seriesId: string;
    recurrence: string | null;
    status?: string;
    processAfter?: string | null;
    timestamp?: string;
  },
) {
  const dir = path.join(BASE, AG, sess);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'inbound.db');
  ensureSchema(dbPath, 'inbound');
  const db = openInboundDb(dbPath);
  try {
    // Unique even seq per row (the messages_in seq is UNIQUE); multiple
    // seeds into one session inbound.db must not collide.
    const maxSeq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in`).get() as { m: number }).m;
    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, content, series_id)
       VALUES (@id, @seq, @timestamp, @status, 0, @processAfter, @recurrence, 'task', @content, @seriesId)`,
    ).run({
      seq: maxSeq + 2,
      id: row.id,
      timestamp: row.timestamp ?? new Date().toISOString(),
      status: row.status ?? 'pending',
      processAfter: row.processAfter ?? new Date(Date.now() + 300_000).toISOString(),
      recurrence: row.recurrence,
      content: JSON.stringify({ prompt: 'p', script: null }),
      seriesId: row.seriesId,
    });
  } finally {
    db.close();
  }
}

function schedRows() {
  const sched = openScheduleDbAt(BASE, AG);
  try {
    return sched.prepare(`SELECT series_id, status, recurrence FROM task_series ORDER BY series_id`).all() as Array<{
      series_id: string;
      status: string;
      recurrence: string | null;
    }>;
  } finally {
    sched.close();
  }
}

describe('migrate-legacy-series', () => {
  it('imports a live recurring series out of a session inbound.db', () => {
    seedInboundSeries('sess-1', {
      id: 'task-1777513235917-ui5728',
      seriesId: 'task-1777513235917-ui5728',
      recurrence: '*/5 * * * *',
    });
    migrate();
    expect(schedRows()).toEqual([
      { series_id: 'task-1777513235917-ui5728', status: 'pending', recurrence: '*/5 * * * *' },
    ]);
  });

  it('preserves a paused status through the migration', () => {
    seedInboundSeries('sess-1', {
      id: 'task-paused',
      seriesId: 'task-paused',
      recurrence: '0 9 * * *',
      status: 'paused',
    });
    migrate();
    expect(schedRows()).toEqual([{ series_id: 'task-paused', status: 'paused', recurrence: '0 9 * * *' }]);
  });

  it('latest row per series wins across multiple sessions', () => {
    seedInboundSeries('sess-old', {
      id: 'task-x-old',
      seriesId: 'task-x',
      recurrence: '0 9 * * *',
      timestamp: '2020-01-01T00:00:00.000Z',
    });
    seedInboundSeries('sess-new', {
      id: 'task-x-new',
      seriesId: 'task-x',
      recurrence: '*/10 * * * *',
      timestamp: '2026-05-19T00:00:00.000Z',
    });
    migrate();
    expect(schedRows()).toEqual([{ series_id: 'task-x', status: 'pending', recurrence: '*/10 * * * *' }]);
  });

  it('imports from the .recurring-carryover.json sidecar', () => {
    const agDir = path.join(BASE, AG);
    fs.mkdirSync(agDir, { recursive: true });
    fs.writeFileSync(
      path.join(agDir, '.recurring-carryover.json'),
      JSON.stringify({
        'task-sidecar': {
          series_id: 'task-sidecar',
          recurrence: '0 12 * * *',
          content: JSON.stringify({ prompt: 'sidecar task' }),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          timestamp: '2026-05-18T00:00:00.000Z',
          status: 'pending',
        },
      }),
    );
    migrate();
    expect(schedRows()).toEqual([{ series_id: 'task-sidecar', status: 'pending', recurrence: '0 12 * * *' }]);
  });

  it('is idempotent and never clobbers a series already in schedule.db', () => {
    seedInboundSeries('sess-1', { id: 'task-a', seriesId: 'task-a', recurrence: '*/5 * * * *' });
    migrate();

    // Simulate a post-cutover operator edit landing directly in schedule.db.
    const sched = openScheduleDbAt(BASE, AG);
    sched.prepare(`UPDATE task_series SET recurrence='0 6 * * *' WHERE series_id='task-a'`).run();
    sched.close();

    // Re-run: must NOT overwrite the edited recurrence back to the stale
    // inbound.db value (hasSeries gate), and must not duplicate.
    migrate();
    expect(schedRows()).toEqual([{ series_id: 'task-a', status: 'pending', recurrence: '0 6 * * *' }]);
  });

  it('excludes reserved-prefix transient ids (rotate-/reflection-) but migrates dream-', () => {
    seedInboundSeries('sess-1', { id: 'rotate-x', seriesId: 'rotate-x', recurrence: '*/5 * * * *' });
    seedInboundSeries('sess-1', {
      id: 'reflection-y',
      seriesId: 'reflection-y',
      recurrence: '*/5 * * * *',
    });
    seedInboundSeries('sess-1', {
      id: `dream-${AG}`,
      seriesId: `dream-${AG}`,
      recurrence: '0 4 * * *',
    });
    migrate();
    expect(schedRows()).toEqual([{ series_id: `dream-${AG}`, status: 'pending', recurrence: '0 4 * * *' }]);
  });

  it('ignores non-recurring and completed/cancelled rows', () => {
    seedInboundSeries('sess-1', { id: 'task-oneshot', seriesId: 'task-oneshot', recurrence: null });
    seedInboundSeries('sess-1', {
      id: 'task-done',
      seriesId: 'task-done',
      recurrence: '*/5 * * * *',
      status: 'completed',
    });
    migrate();
    expect(schedRows()).toEqual([]);
  });
});
