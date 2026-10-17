/**
 * CRUD for pending_name_inputs — an approver who clicked "Create new agent"
 * and whose next DM is the agent name. Persisted so the prompt survives a
 * host restart; expires after NAME_INPUT_TTL_MS so a stale prompt never
 * captures a message days later. Rows cascade-delete with their pending
 * channel approval.
 */
import type { InboundEvent } from '../../../channels/adapter.js';
import { getDb } from '../../../db/connection.js';
import { markInboundConsumed } from '../../../db/consumed-inbound.js';

export const NAME_INPUT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingNameInput {
  approver_user_id: string;
  messaging_group_id: string;
  dm_channel_type: string;
  dm_platform_id: string;
  dm_instance: string;
  created_at: string;
}

export function isNameInputExpired(row: PendingNameInput, now = Date.now()): boolean {
  const created = Date.parse(row.created_at);
  return !Number.isFinite(created) || now - created >= NAME_INPUT_TTL_MS;
}

/** One prompt per approver: a later click replaces the earlier prompt. */
export async function setPendingNameInput(row: PendingNameInput): Promise<void> {
  await getDb().run(
    `INSERT INTO pending_name_inputs (
         approver_user_id, messaging_group_id, dm_channel_type,
         dm_platform_id, dm_instance, created_at
       )
       VALUES (
         @approver_user_id, @messaging_group_id, @dm_channel_type,
         @dm_platform_id, @dm_instance, @created_at
       )
       ON CONFLICT (approver_user_id) DO UPDATE SET
         messaging_group_id = excluded.messaging_group_id,
         dm_channel_type = excluded.dm_channel_type,
         dm_platform_id = excluded.dm_platform_id,
         dm_instance = excluded.dm_instance,
         created_at = excluded.created_at`,
    row,
  );
}

export async function getPendingNameInput(approverUserId: string): Promise<PendingNameInput | undefined> {
  return getDb().get<PendingNameInput>('SELECT * FROM pending_name_inputs WHERE approver_user_id = ?', approverUserId);
}

/**
 * Consume exactly this prompt. Returns false when it was already consumed
 * or replaced (a concurrent reply or a newer click), so only one reply wins.
 */
export async function claimPendingNameInput(row: PendingNameInput): Promise<boolean> {
  const result = await getDb().run(
    'DELETE FROM pending_name_inputs WHERE approver_user_id = ? AND messaging_group_id = ? AND created_at = ?',
    row.approver_user_id,
    row.messaging_group_id,
    row.created_at,
  );
  return result.changes === 1;
}

/**
 * Consume exactly this prompt with `reply`, and record the reply as consumed
 * in the same transaction. Either both happen or neither: a restart can never
 * leave the prompt gone while its reply looks unconsumed to channel recovery
 * (which would route the reply to the DM's agent as chat), nor mark a reply
 * whose prompt is still open. Returns false like claimPendingNameInput.
 */
export async function claimPendingNameInputWithReply(row: PendingNameInput, reply: InboundEvent): Promise<boolean> {
  return getDb().transaction(async () => {
    if (!(await claimPendingNameInput(row))) return false;
    await markInboundConsumed(reply, 'new-agent-name');
    return true;
  });
}

export async function deletePendingNameInput(approverUserId: string): Promise<void> {
  await getDb().run('DELETE FROM pending_name_inputs WHERE approver_user_id = ?', approverUserId);
}

export async function deletePendingNameInputsForApproval(messagingGroupId: string): Promise<void> {
  await getDb().run('DELETE FROM pending_name_inputs WHERE messaging_group_id = ?', messagingGroupId);
}
