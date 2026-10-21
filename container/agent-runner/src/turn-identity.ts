import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { writeMessageOut } from './db/messages-out.js';

interface BindingDeps {
  file?: string;
  read(): { turnId?: string | null; followupRequestId?: string; followupAccepted?: boolean } | null;
  send(action: string, turnId: string, triggerIds?: string[], requestId?: string): Promise<void>;
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
    async send(action, turnId, triggerIds, requestId) {
      await writeMessageOut({
        id: `identity-${randomUUID()}`,
        kind: 'system',
        content: JSON.stringify({ action, turnId, triggerIds, requestId }),
      });
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 50)),
  };
}

let activeBinding: { turnId: string; deps: BindingDeps } | null = null;
/** Same-actor warm inputs require their own host-selected immutable extension
 * before scripts/provider push. An opaque request id is only an ACK reference. */
export async function extendIdentityTurn(triggerIds: string[]): Promise<boolean> {
  if (!process.env.OPTIMUS_TURN_IDENTITY_FILE && !activeBinding) return true;
  const binding = activeBinding;
  if (!binding) return false;
  const requestId = `followup-${randomUUID()}`;
  await binding.deps.send('identity_turn_followup', binding.turnId, triggerIds, requestId);
  for (let i = 0; i < 600; i++) {
    if (activeBinding?.turnId !== binding.turnId) return false;
    const ack = binding.deps.read();
    if (ack && ack.turnId !== binding.turnId) return false;
    if (ack?.turnId === binding.turnId && ack.followupRequestId === requestId) return ack.followupAccepted === true;
    await binding.deps.wait();
  }
  return false;
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
      activeBinding = { turnId, deps };
      return async () => {
        if (activeBinding?.turnId === turnId) activeBinding = null;
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
