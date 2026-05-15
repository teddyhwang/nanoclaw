import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import { writeTaskFire } from './task-fires.js';

interface TaskFireRow {
  id: string;
  series_id: string;
  task_id: string;
  fired_at: string;
  status: string;
  assistant_text: string | null;
  dispatched: string;
  error_message: string | null;
}

function listFires(seriesId: string): TaskFireRow[] {
  return getOutboundDb()
    .prepare('SELECT * FROM task_fires WHERE series_id = ? ORDER BY fired_at')
    .all(seriesId) as TaskFireRow[];
}

beforeEach(() => {
  initTestSessionDb();
});

describe('task_fires writer', () => {
  test('completed fire round-trips with dispatched payload', () => {
    writeTaskFire({
      id: 'fire-1',
      seriesId: 'series-abc',
      taskId: 'task-row-1',
      status: 'completed',
      assistantText: '<message to="discord-x">hello</message>',
      dispatched: [{ destination: 'discord-x', body: 'hello' }],
    });

    const rows = listFires('series-abc');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].task_id).toBe('task-row-1');
    expect(rows[0].assistant_text).toBe('<message to="discord-x">hello</message>');
    expect(JSON.parse(rows[0].dispatched)).toEqual([{ destination: 'discord-x', body: 'hello' }]);
    expect(rows[0].error_message).toBeNull();
  });

  test("silent fire stores empty dispatched array and null text", () => {
    writeTaskFire({
      id: 'fire-2',
      seriesId: 'series-quiet',
      taskId: 'task-row-2',
      status: 'silent',
      assistantText: null,
      dispatched: [],
    });

    const rows = listFires('series-quiet');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('silent');
    expect(rows[0].assistant_text).toBeNull();
    expect(rows[0].dispatched).toBe('[]');
  });

  test('error fire captures error_message', () => {
    writeTaskFire({
      id: 'fire-3',
      seriesId: 'series-err',
      taskId: 'task-row-3',
      status: 'error',
      assistantText: null,
      dispatched: [],
      errorMessage: 'provider exploded',
    });

    const rows = listFires('series-err');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toBe('provider exploded');
  });

  test('gated fire records the gate reason in error_message', () => {
    writeTaskFire({
      id: 'fire-gate',
      seriesId: 'series-gated',
      taskId: 'task-row-g',
      status: 'gated',
      assistantText: null,
      dispatched: [],
      errorMessage: 'script error/no output',
    });

    const rows = listFires('series-gated');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('gated');
    expect(rows[0].error_message).toBe('script error/no output');
    expect(rows[0].dispatched).toBe('[]');
  });

  test('gated fire for wakeAgent=false leaves error_message null', () => {
    writeTaskFire({
      id: 'fire-gate-2',
      seriesId: 'series-gated-quiet',
      taskId: 'task-row-gq',
      status: 'gated',
      assistantText: null,
      dispatched: [],
      errorMessage: null,
    });

    const rows = listFires('series-gated-quiet');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('gated');
    expect(rows[0].error_message).toBeNull();
  });

  test('multiple fires for the same series_id co-exist and order by fired_at', () => {
    writeTaskFire({
      id: 'fire-a',
      seriesId: 'series-recurring',
      taskId: 'task-1',
      status: 'completed',
      assistantText: null,
      dispatched: [{ destination: 'd1', body: 'first run' }],
    });
    writeTaskFire({
      id: 'fire-b',
      seriesId: 'series-recurring',
      taskId: 'task-2',
      status: 'silent',
      assistantText: null,
      dispatched: [],
    });

    const rows = listFires('series-recurring');
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.task_id)).toEqual(['task-1', 'task-2']);
  });

  test('per-series cap prunes older fires once the cap is exceeded', () => {
    // Cap is 100 (module-private const). Push 105 fires; the 5
    // oldest must be gone. Padded ids keep lexicographic order
    // aligned with insertion order so the survivor assertions read
    // cleanly.
    for (let i = 0; i < 105; i++) {
      writeTaskFire({
        id: `fire-${String(i).padStart(3, '0')}`,
        seriesId: 'series-capped',
        taskId: `task-${i}`,
        status: 'completed',
        assistantText: null,
        dispatched: [],
      });
    }

    const remaining = getOutboundDb()
      .prepare('SELECT id FROM task_fires WHERE series_id = ? ORDER BY id')
      .all('series-capped') as Array<{ id: string }>;

    expect(remaining.length).toBe(100);
    const ids = remaining.map((r) => r.id);
    // Newest 100 win. The cap uses `NOT IN (… ORDER BY fired_at DESC
    // LIMIT 100)`; bun:sqlite's datetime('now') resolves to the same
    // second across this loop, so SQLite breaks the tie on rowid,
    // which matches insertion order. So the first 5 inserts are the
    // ones evicted.
    expect(ids).not.toContain('fire-000');
    expect(ids).not.toContain('fire-004');
    expect(ids).toContain('fire-005');
    expect(ids).toContain('fire-104');
  });

  test('cap is scoped per series_id — sibling series unaffected', () => {
    // 105 fires on a chatty series; one on a slow sibling. The slow
    // sibling must survive even though the cap is exceeded next door.
    for (let i = 0; i < 105; i++) {
      writeTaskFire({
        id: `chatty-${i}`,
        seriesId: 'series-chatty',
        taskId: `t-${i}`,
        status: 'completed',
        assistantText: null,
        dispatched: [],
      });
    }
    writeTaskFire({
      id: 'sibling-1',
      seriesId: 'series-slow',
      taskId: 't-slow',
      status: 'completed',
      assistantText: null,
      dispatched: [],
    });

    const slowCount = (
      getOutboundDb()
        .prepare('SELECT count(*) AS n FROM task_fires WHERE series_id = ?')
        .get('series-slow') as { n: number }
    ).n;
    const chattyCount = (
      getOutboundDb()
        .prepare('SELECT count(*) AS n FROM task_fires WHERE series_id = ?')
        .get('series-chatty') as { n: number }
    ).n;

    expect(slowCount).toBe(1);
    expect(chattyCount).toBe(100);
  });
});
