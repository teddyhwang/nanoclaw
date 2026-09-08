import { afterEach, describe, expect, it, vi } from 'vitest';
import { addTaskMaterializationGuard, mayMaterializeTask } from './task-materialization.js';
import type { TaskSeriesRow } from '../modules/scheduling/schedule-store.js';
import type { Session } from '../types.js';
const series = {} as TaskSeriesRow;
const session = {} as Session;
afterEach(() => vi.useRealTimers());
describe('task eligibility hooks', () => {
  it('composes checks and unregisters without changing the default', async () => {
    const later = vi.fn(() => true);
    const remove = addTaskMaterializationGuard(() => false);
    const removeLater = addTaskMaterializationGuard(later);
    try {
      expect(await mayMaterializeTask(series, session)).toBe(false);
      expect(later).not.toHaveBeenCalled();
      remove();
      expect(await mayMaterializeTask(series, session)).toBe(true);
    } finally {
      remove();
      removeLater();
    }
  });
  it('bounds a wedged lookup so the sweep can retry without skipping work', async () => {
    vi.useFakeTimers();
    const remove = addTaskMaterializationGuard(() => new Promise(() => {}));
    try {
      const result = expect(mayMaterializeTask(series, session)).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(5001);
      await result;
    } finally {
      remove();
    }
  });
});
