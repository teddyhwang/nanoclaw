import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { writeMessageOut } from './db/messages-out.js';

interface BindingDeps {
  file?: string;
  read(): { turnId?: string | null } | null;
  send(action: string, turnId: string, triggerIds?: string[]): Promise<void>;
  wait(): Promise<void>;
}
function defaults(): BindingDeps {
  const file = process.env.OPTIMUS_TURN_IDENTITY_FILE;
  return {
    file,
    read() {
      try {
        return JSON.parse(fs.readFileSync(file!, 'utf8'));
      } catch {
        return null;
      }
    },
    async send(action, turnId, triggerIds) {
      await writeMessageOut({
        id: `identity-${randomUUID()}`,
        kind: 'system',
        content: JSON.stringify({ action, turnId, triggerIds }),
      });
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 50)),
  };
}

/** Upstream runners need no host binding. Optimus opts in at spawn; once
 * enabled, no provider code runs until the host acknowledges this batch.
 * The host-only snapshot, not any container-supplied account, is published. */
export async function bindIdentityTurn(triggerIds: string[], deps = defaults()): Promise<() => Promise<void>> {
  if (!deps.file) return async () => {};
  const turnId = `turn-${randomUUID()}`;
  await deps.send('identity_turn_begin', turnId, triggerIds);
  for (let i = 0; i < 600; i++) {
    if (deps.read()?.turnId === turnId) {
      return async () => {
        await deps.send('identity_turn_end', turnId);
        for (let j = 0; j < 600; j++) {
          if (deps.read()?.turnId === null) return;
          await deps.wait();
        }
        throw new Error('Host did not release turn identity');
      };
    }
    await deps.wait();
  }
  throw new Error('Host did not bind turn identity; refusing to start provider query');
}
