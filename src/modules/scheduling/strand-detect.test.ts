/**
 * Unit tests for the stranded-recurring-task detection predicate. Pure:
 * runs against an in-memory messages_in table, no filesystem / sweep mocks.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasDueStrandedRecurringTask } from './strand-detect.js';

let db: Database.Database;

const NOW = '2026-05-16T12:00:00.000Z';
const PAST = '2026-05-13T08:00:00.000Z'; // overdue relative to NOW
const FUTURE = '2026-05-20T08:00:00.000Z'; // not yet due

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
});

afterEach(() => db.close());

let seq = 0;
function insert(row: {
  id: string;
  kind?: string;
  status?: string;
  process_after?: string | null;
  recurrence?: string | null;
  series_id?: string | null;
}) {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content)
     VALUES (@id, @seq, @kind, @timestamp, @status, @process_after, @recurrence, @series_id, @content)`,
  ).run({
    id: row.id,
    seq: seq++,
    kind: row.kind ?? 'task',
    timestamp: NOW,
    status: row.status ?? 'pending',
    process_after: row.process_after === undefined ? PAST : row.process_after,
    recurrence: row.recurrence === undefined ? '0 4 * * *' : row.recurrence,
    series_id: row.series_id === undefined ? 'dream-ag-x' : row.series_id,
    content: '{"prompt":"x"}',
  });
}

describe('hasDueStrandedRecurringTask', () => {
  it('true: pending recurring task with process_after in the past (the real bug)', () => {
    insert({ id: 'task-1' });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(true);
  });

  it('true: process_after exactly equal to now (boundary is inclusive)', () => {
    insert({ id: 'task-1', process_after: NOW });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(true);
  });

  it('false: paused series must NOT be revived', () => {
    insert({ id: 'task-1', status: 'paused' });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('false: cancelled series (recurrence NULL) must NOT be revived', () => {
    insert({ id: 'task-1', recurrence: null });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('false: already-completed occurrence does not trigger revival', () => {
    insert({ id: 'task-1', status: 'completed' });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('false: recurring task not yet due (process_after in the future)', () => {
    insert({ id: 'task-1', process_after: FUTURE });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('false: no series_id (non-recurring one-shot)', () => {
    insert({ id: 'task-1', series_id: null });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('false: null process_after (never scheduled)', () => {
    insert({ id: 'task-1', process_after: null });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('false: non-task kind (e.g. msg) is ignored', () => {
    insert({ id: 'm-1', kind: 'msg' });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('false: empty table', () => {
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(false);
  });

  it('true: at least one due row among a mix of non-qualifying rows', () => {
    insert({ id: 'paused', status: 'paused' });
    insert({ id: 'future', process_after: FUTURE });
    insert({ id: 'cancelled', recurrence: null });
    insert({ id: 'due', process_after: PAST });
    expect(hasDueStrandedRecurringTask(db, NOW)).toBe(true);
  });
});
