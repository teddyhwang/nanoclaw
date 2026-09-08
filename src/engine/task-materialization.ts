/** Host-only eligibility checks, before an occurrence or runtime exists.
 * False skips this tick silently; throws leave it due for retry. Guards must
 * not re-enter the current session mailbox (the scheduling sweep owns it).
 */
import type { Session } from '../types.js';
import type { TaskSeriesRow } from '../modules/scheduling/schedule-store.js';

export type TaskMaterializationGuard = (
  series: Readonly<TaskSeriesRow>,
  session: Readonly<Session>,
) => boolean | Promise<boolean>;
const guards: TaskMaterializationGuard[] = [];

export function addTaskMaterializationGuard(guard: TaskMaterializationGuard): () => void {
  guards.push(guard);
  return () => {
    const index = guards.indexOf(guard);
    if (index >= 0) guards.splice(index, 1);
  };
}

export async function mayMaterializeTask(series: TaskSeriesRow, session: Session): Promise<boolean> {
  for (const guard of guards) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const allowed = await Promise.race([
        guard(series, session),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Task eligibility lookup timed out')), 5000);
          timer.unref();
        }),
      ]);
      if (!allowed) return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return true;
}
