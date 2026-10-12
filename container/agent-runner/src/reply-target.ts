/**
 * Native platform reply targets.
 *
 * Only chat rows that came from a real platform message can become a native
 * reply reference. Host-synthesized wake rows (operator nudges
 * `chief-nudge:*`, escalation resumes `sys-escresume-*`, approval notes,
 * Chats bridge wakes, …) carry the chat's coordinates so the agent answers
 * there, but their ids are not platform message ids: inheriting one as
 * `in_reply_to` made Discord reject every post (`"chief-nudge" is not
 * snowflake`, 2026-10-11 ai-friends). Every host writer marks these rows
 * with `sender`/`senderId: 'system'`; that convention is the boundary.
 */
export function isHostSyntheticContent(content: string | null | undefined): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as { sender?: unknown; senderId?: unknown } | null;
    return parsed?.senderId === 'system' || parsed?.sender === 'system';
  } catch {
    return false;
  }
}

/**
 * Inherited (implicit) reply target: the newest waking row, unless the host
 * synthesized it. Reaction rows stay eligible — their router id resolves to
 * the reacted-to message, which is the established reply anchor.
 */
export function isInheritableReplyTarget(row: { kind: string; content: string | null | undefined }): boolean {
  return (
    (row.kind === 'chat' || row.kind === 'chat-sdk' || row.kind === 'reaction') && !isHostSyntheticContent(row.content)
  );
}

/** Explicit `reply_to_message_id`: only a real chat message, never a reaction/system/task row. */
export function isPlatformReplyTarget(row: { kind: string; content: string | null | undefined }): boolean {
  return (row.kind === 'chat' || row.kind === 'chat-sdk') && !isHostSyntheticContent(row.content);
}
