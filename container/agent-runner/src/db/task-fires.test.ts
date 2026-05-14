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
});
