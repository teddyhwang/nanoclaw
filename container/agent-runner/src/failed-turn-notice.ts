/**
 * One-shot "your previous reply did not finish" reminder.
 *
 * When an interactive chat turn ends in a non-retryable provider failure the
 * user is told to send it again and the inbound rows are marked completed, so
 * the request is never picked up by itself. Sessions that resume the same
 * provider thread could still answer it when the user next wrote (Nicole /
 * Sanuki Udon, 2026-10-14: the answer rode in 29 minutes later on an unrelated
 * message), but only by chance, and not at all after a rotation.
 *
 * This records a small marker per chat route in session_state (outbound.db, so
 * it is session-scoped and never crosses sessions) and prepends a <system>
 * reminder to the NEXT interactive turn on the SAME route, at most once,
 * within a TTL. Other routes sharing the session keep their own marker. It
 * never wakes the agent and never sends anything by itself: it only changes
 * what the next user-initiated turn knows. Retry policy is untouched.
 */
import { getAgentMailbox } from './mailbox/index.js';
import type { RoutingContext } from './formatter.js';

export const FAILED_TURN_KEY = 'failed_turn_notice';
/** Older failures are stale: the user has moved on or re-asked. */
export const FAILED_TURN_TTL_MS = 6 * 60 * 60 * 1000;
/** Bound on the stored request text (the failed turn's <message> blocks). */
export const FAILED_TURN_EXCERPT_CHARS = 1500;
/** Bound on distinct routes remembered per session. */
const MAX_RECORDS = 8;

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

const MESSAGE_BLOCK = /<message\b[^>]*>[\s\S]*?<\/message>/g;

/**
 * The user's request only: the formatted `<message>` blocks (their text is
 * XML-escaped, so a block can't end early). Drops the `<context>` header and
 * any runner `<system>` notices. Falls back to the prompt with those removed.
 */
export function requestExcerpt(prompt: string): string {
  const blocks = prompt.match(MESSAGE_BLOCK);
  const text = blocks
    ? blocks.join('\n')
    : prompt
        .replace(/<context\b[^>]*\/>/g, '')
        .replace(/<system>[\s\S]*?<\/system>/g, '')
        .trim();
  return text.length > FAILED_TURN_EXCERPT_CHARS ? `${text.slice(0, FAILED_TURN_EXCERPT_CHARS)}…` : text;
}

export function buildFailedTurnRecord(
  routing: RoutingContext,
  prompts: string | string[],
  now: Date = new Date(),
): FailedTurnRecord | null {
  if (!routing.platformId || !routing.channelType) return null;
  const excerpt = requestExcerpt((Array.isArray(prompts) ? prompts : [prompts]).join('\n'));
  if (!excerpt) return null;
  return {
    platformId: routing.platformId,
    channelType: routing.channelType,
    threadId: routing.threadId ?? null,
    inReplyTo: routing.inReplyTo ?? null,
    failedAt: now.toISOString(),
    excerpt,
  };
}

function sameRoute(
  record: Pick<FailedTurnRecord, 'platformId' | 'channelType' | 'threadId'>,
  routing: Pick<RoutingContext, 'platformId' | 'channelType' | 'threadId'>,
): boolean {
  return (
    record.platformId === routing.platformId &&
    record.channelType === routing.channelType &&
    (record.threadId ?? null) === (routing.threadId ?? null)
  );
}

function parseRecord(value: unknown): FailedTurnRecord | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<FailedTurnRecord>;
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
}

/** Malformed storage reads as empty; a single legacy object is accepted. */
function readRecords(): FailedTurnRecord[] {
  const stored = getAgentMailbox().operations.getState(FAILED_TURN_KEY)?.value;
  if (stored === undefined) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(parseRecord).filter((r): r is FailedTurnRecord => r !== null);
  } catch {
    return [];
  }
}

function writeRecords(records: FailedTurnRecord[]): void {
  const ops = getAgentMailbox().operations;
  if (records.length === 0) ops.deleteState(FAILED_TURN_KEY);
  else ops.setState(FAILED_TURN_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
}

/** Latest failure per route wins; other routes' markers are preserved. */
export function recordFailedTurn(record: FailedTurnRecord): void {
  writeRecords([...readRecords().filter((r) => !sameRoute(r, record)), record]);
}

export function clearFailedTurn(): void {
  getAgentMailbox().operations.deleteState(FAILED_TURN_KEY);
}

/**
 * Pure decision for one stored marker against this turn.
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
    `Your previous turn in this chat (at ${record.failedAt}) ended with a technical error before you finished ` +
    `replying, and the user was shown a short error notice instead of your answer. The unfinished request was:\n` +
    `<failed_request>\n${record.excerpt}\n</failed_request>\n` +
    `If it is still relevant and not already answered in this conversation, answer it together with the ` +
    `current message; if the current message repeats it, answer it once. Do not repeat any action that could have had an effect (sending, booking, writing, ` +
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
  let delivered: FailedTurnRecord | undefined;
  const kept: FailedTurnRecord[] = [];
  for (const record of readRecords()) {
    const decision = decideFailedTurn(record, routing, now);
    if (decision === 'keep') kept.push(record);
    else if (decision === 'deliver') delivered = record;
  }
  writeRecords(kept);
  return delivered ? buildFailedTurnNotice(delivered) : undefined;
}
