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
 * The payload is bounded metadata only: a sanitized error class and the
 * provider name. Never message text or raw provider error payloads.
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
      }),
    });
  } catch (err) {
    console.error(`[failure-notice-alert] alert write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
