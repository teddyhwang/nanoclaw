/** Embedders may defer cold starts without consuming pending inbound work.
 * Serialize admission decisions, not runtime startup. Reservations cover the
 * async setup gap until the runtime enters the host's active set.
 */
import type { Session } from '../types.js';

export type SpawnAdmissionGuard = (
  session: Session,
  occupiedSessionIds: readonly string[],
) => boolean | Promise<boolean>;
const guards: SpawnAdmissionGuard[] = [];
const reserved = new Set<string>();
let checking: Promise<void> = Promise.resolve();

export function addSpawnAdmissionGuard(guard: SpawnAdmissionGuard): () => void {
  guards.push(guard);
  return () => {
    const i = guards.indexOf(guard);
    if (i >= 0) guards.splice(i, 1);
  };
}

export async function acquireSpawnAdmission(
  session: Session,
  running: () => readonly string[],
): Promise<(() => void) | null> {
  const previous = checking;
  let unlock!: () => void;
  checking = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    const occupied = [...new Set([...running(), ...reserved])].filter((id) => id !== session.id);
    for (const guard of guards) {
      // A broken plugin lookup must not hold the global admission queue forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const allowed = await Promise.race([
          guard(session, occupied),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Spawn admission lookup timed out')), 5000);
            timer.unref();
          }),
        ]);
        if (!allowed) return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    reserved.add(session.id);
    return () => {
      reserved.delete(session.id);
    };
  } finally {
    unlock();
  }
}
