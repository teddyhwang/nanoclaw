/**
 * One-shot "your previous reply failed" note (prototype, B(ii)).
 *
 * When an interactive chat turn ends in a non-retryable provider failure the
 * user sees a failure notice and the inbound rows are marked completed, so the
 * request is never picked up again. Sessions that resume the same provider
 * thread can still answer it when the user next writes (Nicole / Sanuki Udon,
 * 2026-10-14: the answer rode in 29 minutes later on an unrelated message),
 * but only by chance, and not at all after a rotation.
 *
 * This records a small marker in session_state (outbound.db, so it is
 * session-scoped and never crosses chats) and prepends a <system> note to the
 * NEXT interactive turn on the SAME route, at most once, within a TTL. It
 * never wakes the agent and never sends anything by itself: it only changes
 * what the next user-initiated turn knows.
 */
import { getAgentMailbox } from './mailbox/index.js';
import type { RoutingContext } from './formatter.js';

export const FAILED_TURN_KEY = 'failed_turn_notice';
/** Older failures are stale: the user has moved on or re-asked. */
export const FAILED_TURN_TTL_MS = 6 * 60 * 60 * 1000;
/** Bound on the stored request text (the formatted <message> envelope). */
export const FAILED_TURN_EXCERPT_CHARS = 1500;

export interface FailedTurnRecord {
  platformId: string;
  channelType: string;
  threadId: string | null;
  inReplyTo: string | null;
  failedAt: string;
  excerpt: string;
}

/** Only human chat routes qualify: no tasks, no a2a, no failure-notice chains. */
export function failedTurnEligible(routing: RoutingContext, isTaskTurn: boolean): boolean {
  return (
    !isTaskTurn &&
    !routing.taskFire &&
    !routing.failureNoticeWake &&
    !!routing.platformId &&
    !!routing.channelType &&
    routing.channelType !== 'agent'
  );
}

export function buildFailedTurnRecord(
  routing: RoutingContext,
  prompt: string,
  now: Date = new Date(),
): FailedTurnRecord | null {
  if (!routing.platformId || !routing.channelType) return null;
  const trimmed = prompt.trim();
  const excerpt =
    trimmed.length > FAILED_TURN_EXCERPT_CHARS ? `${trimmed.slice(0, FAILED_TURN_EXCERPT_CHARS)}…` : trimmed;
  return {
    platformId: routing.platformId,
    channelType: routing.channelType,
    threadId: routing.threadId ?? null,
    inReplyTo: routing.inReplyTo ?? null,
    failedAt: now.toISOString(),
    excerpt,
  };
}

function sameRoute(record: FailedTurnRecord, routing: RoutingContext): boolean {
  return (
    record.platformId === routing.platformId &&
    record.channelType === routing.channelType &&
    (record.threadId ?? null) === (routing.threadId ?? null)
  );
}

function parseRecord(value: string | undefined): FailedTurnRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<FailedTurnRecord>;
    if (
      typeof parsed.platformId !== 'string' ||
      typeof parsed.channelType !== 'string' ||
      typeof parsed.failedAt !== 'string' ||
      typeof parsed.excerpt !== 'string'
    )
      return null;
    return {
      platformId: parsed.platformId,
      channelType: parsed.channelType,
      threadId: typeof parsed.threadId === 'string' ? parsed.threadId : null,
      inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : null,
      failedAt: parsed.failedAt,
      excerpt: parsed.excerpt,
    };
  } catch {
    return null;
  }
}

/** Latest failure wins; one marker per session. */
export function recordFailedTurn(record: FailedTurnRecord): void {
  getAgentMailbox().operations.setState(FAILED_TURN_KEY, JSON.stringify(record));
}

export function clearFailedTurn(): void {
  getAgentMailbox().operations.deleteState(FAILED_TURN_KEY);
}

/**
 * Pure decision: what to do with a stored marker for this turn.
 * - deliver: same route, fresh -> prepend once and delete
 * - drop: malformed or expired -> delete silently
 * - keep: different route in a shared session -> leave for its own chat
 */
export function decideFailedTurn(
  record: FailedTurnRecord | null,
  routing: RoutingContext,
  now: Date,
  ttlMs: number = FAILED_TURN_TTL_MS,
): 'deliver' | 'drop' | 'keep' {
  if (!record) return 'drop';
  const age = now.getTime() - Date.parse(record.failedAt);
  if (!Number.isFinite(age) || age < 0 || age > ttlMs) return 'drop';
  return sameRoute(record, routing) ? 'deliver' : 'keep';
}

export function buildFailedTurnNotice(record: FailedTurnRecord): string {
  return (
    `Your previous turn in this chat (failed at ${record.failedAt}) ended with a provider error before ` +
    `you finished replying, and the user was shown a failure notice. The request you were answering was:\n` +
    `<failed_request>\n${record.excerpt}\n</failed_request>\n` +
    `If it is still relevant and not already answered in this conversation, answer it together with the ` +
    `current message. Do not repeat any action that could have had an effect (sending, booking, writing, ` +
    `scheduling) without first checking whether it already happened; if you cannot check, ask the user. ` +
    `Do not mention this note.`
  );
}

/**
 * Called once per interactive turn before the prompt goes to the provider.
 * Never called for Dream or task-only turns.
 */
export function consumeFailedTurnNotice(routing: RoutingContext, now: Date = new Date()): string | undefined {
  const ops = getAgentMailbox().operations;
  const stored = ops.getState(FAILED_TURN_KEY)?.value;
  if (stored === undefined) return undefined;
  const record = parseRecord(stored);
  const decision = decideFailedTurn(record, routing, now);
  if (decision === 'keep') return undefined;
  ops.deleteState(FAILED_TURN_KEY);
  return decision === 'deliver' && record ? buildFailedTurnNotice(record) : undefined;
}
