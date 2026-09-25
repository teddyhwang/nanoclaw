/**
 * Provider authentication failures (revoked/expired OAuth token, bad API key).
 *
 * These are deterministic for the account — retrying the same provider fails
 * the same way until an operator rotates the credential — so they get three
 * behaviours distinct from ordinary errors:
 *
 *   1. The usage-limit failover wrapper treats them like an account quota
 *      failure and replays the turn on the alternate harness.
 *   2. A user never sees the raw provider text ("Failed to authenticate. API
 *      Error: 401 OAuth access token has been revoked.") — they get a plain
 *      notice instead.
 *   3. The host is told via a `provider_auth_failure` system action so the
 *      operator learns about it from the first failed turn, not from a
 *      retrospective audit (Danielle DM, 2026-09-24: a pregnancy-medication
 *      question got the raw 401 twice and nobody was alerted).
 */
import { writeMessageOut } from './db/messages-out.js';

function generateId(): string {
  return `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { AUTH_FAILURE_USER_TEXT, isProviderAuthFailureText } from './providers/auth-failure.js';

export interface ProviderAuthFailureAlert {
  /** Provider whose credential was rejected. */
  provider: string;
  /** Alternate provider being attempted, or null when no failover was started. */
  failedOverTo: string | null;
  /**
   * 'chat' when a user turn was affected, 'task' for scheduled-only turns,
   * 'unknown' from the failover wrapper (which cannot see the batch).
   */
  turnKind: 'chat' | 'task' | 'unknown';
}

/**
 * Tell the host a provider credential was rejected. Host-side handling is
 * optional (an unknown system action only logs), so a failure to write is
 * logged and swallowed — the alert must never break the user's turn.
 */
export async function emitProviderAuthFailureAlert(alert: ProviderAuthFailureAlert): Promise<void> {
  try {
    await writeMessageOut({
      id: generateId(),
      in_reply_to: null,
      kind: 'system',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: JSON.stringify({
        action: 'provider_auth_failure',
        provider: alert.provider,
        failedOverTo: alert.failedOverTo,
        turnKind: alert.turnKind,
      }),
    });
  } catch (err) {
    console.error(`[provider-auth-failure] alert write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
