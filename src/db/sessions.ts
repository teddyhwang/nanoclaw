import type { ConfirmationGrant, PendingApproval, PendingQuestion, Session } from '../types.js';
import { getDb, hasTable } from './connection.js';

// ── Sessions ──

export function createSession(session: Session): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    )
    .run(session);
}

export function getSession(id: string): Session | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

export function findSession(messagingGroupId: string, threadId: string | null): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id = ? AND status = ?')
      .get(messagingGroupId, threadId, 'active') as Session | undefined;
  }
  return getDb()
    .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL AND status = ?')
    .get(messagingGroupId, 'active') as Session | undefined;
}

/**
 * Session lookup scoped to a specific agent group. Needed when multiple
 * agents are wired to the same messaging group + thread (fan-out) — the
 * plain `findSession` would return whichever agent's session happened to
 * be first and route to the wrong container.
 */
export function findSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare(
        "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'active'",
      )
      .get(agentGroupId, messagingGroupId, threadId) as Session | undefined;
  }
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'",
    )
    .get(agentGroupId, messagingGroupId) as Session | undefined;
}

/**
 * Find the most recently closed session for an agent group + messaging group
 * + thread, ordered by `created_at DESC`. Used by `isReplyToOurBot` when no
 * active session exists — a user can quote-reply to a bot message from a
 * previously-closed session (after operator clear-session, or after an idle
 * teardown that closed the row), and the reply still counts as engagement
 * for `mention`/`mention-sticky` wirings. The closed session's `inbound.db`
 * stays on disk (audit-preserved, S330), so `wasDeliveredByBot` can still
 * answer the question.
 */
export function findMostRecentClosedSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare(
        "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'closed' ORDER BY created_at DESC LIMIT 1",
      )
      .get(agentGroupId, messagingGroupId, threadId) as Session | undefined;
  }
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'closed' ORDER BY created_at DESC LIMIT 1",
    )
    .get(agentGroupId, messagingGroupId) as Session | undefined;
}

/** Find an active session scoped to an agent group (ignoring messaging group). */
export function findSessionByAgentGroup(agentGroupId: string): Session | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(agentGroupId) as Session | undefined;
}

export function getSessionsByAgentGroup(agentGroupId: string): Session[] {
  return getDb().prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all(agentGroupId) as Session[];
}

export function getActiveSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'active'").all() as Session[];
}

/**
 * Agent groups that have at least one closed session and NO active session.
 *
 * These are the only groups that can permanently strand a recurring task: a
 * scheduled-only agent whose session was closed (operator clear-session,
 * restart-induced close, v1-migration legacy) and which receives no further
 * inbound traffic has no path to ever emit `session.created`, so the
 * carry-forward / maintenance re-seed plugins never run and a due recurring
 * task in the closed session's inbound.db never fires. The host sweep's
 * stranded-task revival (host-sweep.ts) consults this set each tick.
 *
 * The `NOT EXISTS active` clause is the no-double-create guard: a group that
 * still has an active session is owned by the normal active-sweep path and
 * its session.created already drove the re-seed — it must not appear here.
 */
export function getAgentGroupIdsWithClosedNoActiveSessions(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT s1.agent_group_id FROM sessions s1
          WHERE s1.status = 'closed'
            AND NOT EXISTS (
              SELECT 1 FROM sessions s2
               WHERE s2.agent_group_id = s1.agent_group_id
                 AND s2.status = 'active')`,
      )
      .all() as Array<{ agent_group_id: string }>
  ).map((r) => r.agent_group_id);
}

export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE container_status IN ('running', 'idle')").all() as Session[];
}

export function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteSession(id: string): void {
  // Cascade: a deleted session must not leave dangling confirmation grants
  // (and a re-created session reusing this id must never inherit them).
  deleteConfirmationGrantsForSession(id);
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ── Pending Questions ──

/**
 * Insert a pending question row. Idempotent: when delivery fails and retries,
 * the second attempt calls this with the same question_id — without `OR
 * IGNORE` that would throw UNIQUE and prevent the retry from reaching the
 * actual send step. Returns true if a new row was inserted.
 */
export function createPendingQuestion(pq: PendingQuestion): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_questions (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES (@question_id, @session_id, @message_out_id, @platform_id, @channel_type, @thread_id, @title, @options_json, @created_at)`,
    )
    .run({
      question_id: pq.question_id,
      session_id: pq.session_id,
      message_out_id: pq.message_out_id,
      platform_id: pq.platform_id,
      channel_type: pq.channel_type,
      thread_id: pq.thread_id,
      title: pq.title,
      options_json: JSON.stringify(pq.options),
      created_at: pq.created_at,
    });
  return result.changes > 0;
}

export function getPendingQuestion(questionId: string): PendingQuestion | undefined {
  const row = getDb().prepare('SELECT * FROM pending_questions WHERE question_id = ?').get(questionId) as
    | (Omit<PendingQuestion, 'options'> & { options_json: string })
    | undefined;
  if (!row) return undefined;
  const { options_json, ...rest } = row;
  return { ...rest, options: JSON.parse(options_json) };
}

export function deletePendingQuestion(questionId: string): void {
  getDb().prepare('DELETE FROM pending_questions WHERE question_id = ?').run(questionId);
}

// ── Pending Approvals ──

/**
 * Insert a pending approval row. Idempotent for the same reason as
 * createPendingQuestion: delivery retries with the same approval_id must not
 * fail on UNIQUE before the send step gets a chance to succeed.
 */
export function createPendingApproval(
  pa: Partial<PendingApproval> &
    Pick<
      PendingApproval,
      'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'
    >,
): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, platform_message_id, expires_at, status,
          title, options_json)
       VALUES
         (@approval_id, @session_id, @request_id, @action, @payload, @created_at,
          @agent_group_id, @channel_type, @platform_id, @platform_message_id, @expires_at, @status,
          @title, @options_json)`,
    )
    .run({
      session_id: null,
      agent_group_id: null,
      channel_type: null,
      platform_id: null,
      platform_message_id: null,
      expires_at: null,
      status: 'pending',
      ...pa,
    });
  return result.changes > 0;
}

export function getPendingApproval(approvalId: string): PendingApproval | undefined {
  return getDb().prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as
    | PendingApproval
    | undefined;
}

export function updatePendingApprovalStatus(approvalId: string, status: PendingApproval['status']): void {
  getDb().prepare('UPDATE pending_approvals SET status = ? WHERE approval_id = ?').run(status, approvalId);
}

export function deletePendingApproval(approvalId: string): void {
  getDb().prepare('DELETE FROM pending_approvals WHERE approval_id = ?').run(approvalId);
}

export function getPendingApprovalsByAction(action: string): PendingApproval[] {
  return getDb().prepare('SELECT * FROM pending_approvals WHERE action = ?').all(action) as PendingApproval[];
}

// ── Confirmation grants (sensitive-action gate, Phase 1) ──
//
// Keyed (session_id, actor_id). See the `confirmation-grants` migration
// for the rationale (not session alone — cross-user leak in shared
// sessions). All four accessors no-op safely when the table is absent
// (the approvals module migration may not have run in a minimal install),
// guarded by hasTable so a host without the gate doesn't crash.

/** Create or fully refresh a grant (called on a successful Confirm click). */
export function upsertConfirmationGrant(sessionId: string, actorId: string, now: string): void {
  const db = getDb();
  if (!hasTable(db, 'confirmation_grants')) return;
  db.prepare(
    `INSERT INTO confirmation_grants (session_id, actor_id, granted_at, last_used_at)
     VALUES (@session_id, @actor_id, @now, @now)
     ON CONFLICT(session_id, actor_id)
     DO UPDATE SET granted_at = @now, last_used_at = @now`,
  ).run({ session_id: sessionId, actor_id: actorId, now });
}

/** Fetch a grant, or undefined if none / table absent. */
export function getConfirmationGrant(sessionId: string, actorId: string): ConfirmationGrant | undefined {
  const db = getDb();
  if (!hasTable(db, 'confirmation_grants')) return undefined;
  return db
    .prepare('SELECT * FROM confirmation_grants WHERE session_id = ? AND actor_id = ?')
    .get(sessionId, actorId) as ConfirmationGrant | undefined;
}

/** Bump last_used_at on a silent live-grant allow (does NOT extend the hard cap). */
export function touchConfirmationGrant(sessionId: string, actorId: string, now: string): void {
  const db = getDb();
  if (!hasTable(db, 'confirmation_grants')) return;
  db.prepare('UPDATE confirmation_grants SET last_used_at = ? WHERE session_id = ? AND actor_id = ?').run(
    now,
    sessionId,
    actorId,
  );
}

/** Drop all grants for a session — engine-authoritative cascade on session clear/reset. */
export function deleteConfirmationGrantsForSession(sessionId: string): void {
  const db = getDb();
  if (!hasTable(db, 'confirmation_grants')) return;
  db.prepare('DELETE FROM confirmation_grants WHERE session_id = ?').run(sessionId);
}

/**
 * Resolve ask_question render metadata (title + normalized options) for any
 * card, regardless of whether it was persisted as a pending_question (generic
 * ask_user_question) or a pending_approval (self-mod / OneCLI credential).
 */
export function getAskQuestionRender(
  id: string,
): { title: string; options: import('../channels/ask-question.js').NormalizedOption[] } | undefined {
  const q = getPendingQuestion(id);
  if (q) return { title: q.title, options: q.options };
  const a = getDb().prepare('SELECT title, options_json FROM pending_approvals WHERE approval_id = ?').get(id) as
    | { title: string; options_json: string }
    | undefined;
  if (a?.title) return { title: a.title, options: JSON.parse(a.options_json) };

  // Channel-registration + unknown-sender approvals persist title/options_json
  // the same way pending_approvals does — just SELECT and return.
  if (hasTable(getDb(), 'pending_channel_approvals')) {
    const c = getDb()
      .prepare('SELECT title, options_json FROM pending_channel_approvals WHERE messaging_group_id = ?')
      .get(id) as { title: string; options_json: string } | undefined;
    if (c?.title) return { title: c.title, options: JSON.parse(c.options_json) };
  }

  if (hasTable(getDb(), 'pending_sender_approvals')) {
    const s = getDb().prepare('SELECT title, options_json FROM pending_sender_approvals WHERE id = ?').get(id) as
      | { title: string; options_json: string }
      | undefined;
    if (s?.title) return { title: s.title, options: JSON.parse(s.options_json) };
  }

  return undefined;
}
