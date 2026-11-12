/**
 * Operator alert for a failure notice delivered to a user.
 *
 * Only provider auth failures used to alert the operator. Every other class
 * (a provider stall at the no-output deadline, a dual usage limit, a failed
 * alternate after failover, an unclassified throw) sent the user a failure
 * notice and told nobody, so the user waited until someone noticed (Danielle
 * DM, 2026-11-10: about 12 hours). The host dedupes and routes this to the
 * operator's existing alert destination.
 *
 * The payload is bounded metadata (a sanitized error class, the provider and
 * channel type) plus a bounded excerpt of the raw provider/runner error, which
 * the user never sees (see user-failure-notice.ts). Never message text: the
 * excerpt comes from the provider error field or thrown error, not the
 * assistant's result text.
 */
import { writeMessageOut } from './db/messages-out.js';

/** Channels whose failure notice reaches a person rather than an agent or the local CLI. */
const NON_USER_CHANNELS = new Set(['agent', 'cli']);

const TOKEN = /^[a-z0-9_]{1,40}$/;

function token(value: string | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v && TOKEN.test(v) ? v : null;
}

/**
 * Bounded failure class from a provider error. Reads the structured
 * `Provider diagnostic` when present (classification plus its code or
 * no-retry reason), otherwise falls back to coarse keyword classes.
 */
export function classifyFailureCause(detail: string): string {
  const text = detail ?? '';
  const classification = token(/"classification"\s*:\s*"([^"]+)"/.exec(text)?.[1]);
  if (classification) {
    const sub =
      token(/"code"\s*:\s*"([^"]+)"/.exec(text)?.[1]) ?? token(/"noRetryReason"\s*:\s*"([^"]+)"/.exec(text)?.[1]);
    return sub ? `${classification}/${sub}` : classification;
  }
  if (/have reached their usage limits/i.test(text)) return 'quota/both_providers';
  if (/usage limit|rate limit|\b429\b|quota/i.test(text)) return 'quota';
  if (/retryable provider error/i.test(text)) return 'retryable_no_result';
  if (/timed? ?out|deadline/i.test(text)) return 'timeout';
  if (/overloaded|\b5\d\d\b/i.test(text)) return 'upstream_unavailable';
  return 'unclassified';
}

export interface FailureNoticeAlert {
  channelType: string | null | undefined;
  provider: string;
  /** Raw error text, used only to derive the class; never forwarded. */
  detail: string;
  /** Raw provider/runner error for the operator; excerpted, never shown to the user. */
  rawError?: string | null;
}

/** Longest raw-error excerpt an operator alert carries. */
export const RAW_ERROR_EXCERPT_MAX = 500;

/** One line, no control characters, bounded. Empty when there is nothing to report. */
export function rawErrorExcerpt(raw: string | null | undefined): string {
  const line = (raw ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(line);
  return chars.length > RAW_ERROR_EXCERPT_MAX ? `${chars.slice(0, RAW_ERROR_EXCERPT_MAX - 1).join('')}…` : line;
}

/** True when a failure notice on this channel reached a person. */
export function isUserFacingFailureChannel(channelType: string | null | undefined): boolean {
  return !!channelType && !NON_USER_CHANNELS.has(channelType);
}

/**
 * Tell the host a failure notice reached a user. Like the auth alert, a write
 * failure is logged and swallowed: the alert must never break the turn.
 */
export async function emitFailureNoticeAlert(alert: FailureNoticeAlert): Promise<void> {
  if (!isUserFacingFailureChannel(alert.channelType)) return;
  try {
    await writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      in_reply_to: null,
      kind: 'system',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: JSON.stringify({
        action: 'failure_notice_delivered',
        errorClass: classifyFailureCause(alert.detail),
        provider: token(alert.provider) ?? 'unknown',
        channelType: token(alert.channelType ?? undefined) ?? 'unknown',
        ...(rawErrorExcerpt(alert.rawError) ? { rawError: rawErrorExcerpt(alert.rawError) } : {}),
      }),
    });
  } catch (err) {
    console.error(`[failure-notice-alert] alert write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
