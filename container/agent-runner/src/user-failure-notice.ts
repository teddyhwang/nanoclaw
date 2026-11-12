/**
 * The one door for failure text that reaches a chat channel.
 *
 * Provider and runner errors (API bodies, request ids, model/provider names,
 * stack traces, JSON) are for the operator: they stay in the runner log, the
 * exchange archive and the failure-notice alert. A person in the chat only
 * ever gets one of the short fixed notices below, picked by error class.
 * Escalation 2026-10-14: nine raw provider error results went to users.
 */
import { GENERIC_FAILURE_NOTICE } from './formatter.js';
import { AUTH_FAILURE_USER_TEXT, isProviderAuthFailureText } from './providers/auth-failure.js';
import { isFixedSdkNoticeText } from './providers/sdk-notices.js';

export const RATE_LIMIT_USER_TEXT = "Sorry, I've hit my usage limit for now. Please try again a bit later.";
export const OVERLOADED_USER_TEXT =
  'Sorry, the service I rely on is busy right now. Please try again in a few minutes.';
export const TIMEOUT_USER_TEXT = 'Sorry, that took too long and I had to stop. Please try again.';
export const CONTEXT_TOO_LONG_USER_TEXT =
  'Sorry, this conversation got too long for me to continue. An admin can send /clear to start a new one.';

/** Every text the sanitizer can return. Nothing else reaches a channel as a failure notice. */
export const USER_FAILURE_NOTICES: ReadonlySet<string> = new Set([
  GENERIC_FAILURE_NOTICE,
  AUTH_FAILURE_USER_TEXT,
  RATE_LIMIT_USER_TEXT,
  OVERLOADED_USER_TEXT,
  TIMEOUT_USER_TEXT,
  CONTEXT_TOO_LONG_USER_TEXT,
]);

const CONTEXT_TOO_LONG =
  /prompt is too long|context[ _-]?(length|window)|maximum context|context_length_exceeded|input is too long|too many (input )?tokens/i;
const RATE_LIMIT =
  /usage limit|rate[ _-]?limit|\b429\b|quota|too many requests|billing|spending limit|credit balance|insufficient[ _-]credit/i;
const OVERLOADED =
  /overloaded|\b5\d\d\b|service unavailable|bad gateway|internal server error|server error|\bapi_error\b|upstream/i;
const TIMEOUT = /timed? ?out|timeout|deadline|stalled|no output/i;

/**
 * Map raw provider or runner error text to the clean notice a user sees.
 * Already-clean notices (the generic notice, the auth notice, the Claude CLI's
 * fixed notices) pass through unchanged; everything else is replaced.
 */
export function userFailureNotice(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return GENERIC_FAILURE_NOTICE;
  if (USER_FAILURE_NOTICES.has(text)) return text;
  // Credential failures (including the CLI's "Not logged in" notice) get the auth notice.
  if (isProviderAuthFailureText(text)) return AUTH_FAILURE_USER_TEXT;
  if (isFixedSdkNoticeText(text)) return text;
  if (CONTEXT_TOO_LONG.test(text)) return CONTEXT_TOO_LONG_USER_TEXT;
  if (RATE_LIMIT.test(text)) return RATE_LIMIT_USER_TEXT;
  if (OVERLOADED.test(text)) return OVERLOADED_USER_TEXT;
  if (TIMEOUT.test(text)) return TIMEOUT_USER_TEXT;
  return GENERIC_FAILURE_NOTICE;
}
