import { describe, expect, it } from 'bun:test';

import { rawErrorExcerpt, RAW_ERROR_EXCERPT_MAX } from './failure-notice-alert.js';
import { GENERIC_FAILURE_NOTICE } from './formatter.js';
import { AUTH_FAILURE_USER_TEXT } from './providers/auth-failure.js';
import { OWNER_FIX_HINT, sdkNoticeText } from './providers/sdk-notices.js';
import {
  CONTEXT_TOO_LONG_USER_TEXT,
  OVERLOADED_USER_TEXT,
  RATE_LIMIT_USER_TEXT,
  TIMEOUT_USER_TEXT,
  USER_FAILURE_NOTICES,
  userFailureNotice,
} from './user-failure-notice.js';

describe('userFailureNotice', () => {
  it.each([
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"},"request_id":"req_1"}', RATE_LIMIT_USER_TEXT],
    [
      'Both claude and codex have reached their usage limits. Please try again after one of the limits resets.',
      RATE_LIMIT_USER_TEXT,
    ],
    ['You exceeded your current quota, please check your plan and billing details.', RATE_LIMIT_USER_TEXT],
    [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      OVERLOADED_USER_TEXT,
    ],
    ['502 Bad Gateway from https://api.openai.com/v1/responses', OVERLOADED_USER_TEXT],
    ['Request timed out after 600000ms', TIMEOUT_USER_TEXT],
    ['Provider stalled: no output before the deadline (gpt-5)', TIMEOUT_USER_TEXT],
    ['API Error: 400 prompt is too long: 215000 tokens > 200000 maximum', CONTEXT_TOO_LONG_USER_TEXT],
    ["This model's maximum context length is 128000 tokens (context_length_exceeded)", CONTEXT_TOO_LONG_USER_TEXT],
    ['Failed to authenticate. API Error: 401 OAuth access token has been revoked.', AUTH_FAILURE_USER_TEXT],
    ['TypeError: Cannot read properties of undefined\n    at run (/app/src/poll-loop.ts:12:3)', GENERIC_FAILURE_NOTICE],
    ['403 billing_error: Spending limit reached. Update your billing settings to continue.', RATE_LIMIT_USER_TEXT],
    ['Incorrect API key', GENERIC_FAILURE_NOTICE],
    ['Please try again later.\n<invoke name="retry"></parameter>', GENERIC_FAILURE_NOTICE],
    ['', GENERIC_FAILURE_NOTICE],
    [undefined, GENERIC_FAILURE_NOTICE],
  ])('maps %p to a clean notice', (raw, expected) => {
    expect(userFailureNotice(raw)).toBe(expected);
  });

  it('only ever returns a fixed notice with no ids, URLs, provider names or JSON', () => {
    for (const notice of USER_FAILURE_NOTICES) {
      expect(notice).not.toMatch(/https?:|req_|[{}]|claude|codex|openai|anthropic|\bgpt|\b\d{3}\b/i);
      expect(notice.length).toBeLessThan(200);
    }
  });

  it('passes existing clean notices through unchanged', () => {
    for (const notice of USER_FAILURE_NOTICES) expect(userFailureNotice(notice)).toBe(notice);
    const credit = sdkNoticeText('Credit balance is too low')!;
    expect(credit).toBe(`Credit balance is too low\n${OWNER_FIX_HINT}`);
    expect(userFailureNotice(credit)).toBe(credit);
    expect(userFailureNotice(sdkNoticeText('Prompt is too long'))).toBe(sdkNoticeText('Prompt is too long'));
    // A credential notice from the CLI still becomes the auth notice, as before.
    expect(userFailureNotice(sdkNoticeText('Not logged in · Please run /login'))).toBe(AUTH_FAILURE_USER_TEXT);
  });
});

describe('rawErrorExcerpt', () => {
  it('keeps the raw detail on one bounded line for the operator', () => {
    expect(rawErrorExcerpt('API Error: 500\n  {"request_id":"req_1"}\u0007')).toBe(
      'API Error: 500 {"request_id":"req_1"}',
    );
    expect(rawErrorExcerpt(undefined)).toBe('');
    expect(Array.from(rawErrorExcerpt('x'.repeat(2000)))).toHaveLength(RAW_ERROR_EXCERPT_MAX);
  });
});
