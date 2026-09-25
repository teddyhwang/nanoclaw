import { describe, expect, it } from 'bun:test';

import { isProviderAuthFailureText } from './auth-failure.js';

describe('isProviderAuthFailureText', () => {
  it('matches credential failures from Claude, Anthropic and Codex', () => {
    for (const text of [
      // Danielle DM, 2026-09-24 — both shapes that reached the user.
      'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'OAuth token has expired. Please obtain a new token or refresh your existing token.',
      'Invalid API key · Please run /login',
      'Invalid bearer token',
      'Not logged in · Please run /login',
      'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      'Your refresh token was already used. Please log out and sign in again.',
    ]) {
      expect(isProviderAuthFailureText(text)).toBe(true);
    }
  });

  it('does not match quota, transport, server or empty errors', () => {
    for (const text of [
      null,
      undefined,
      '',
      'API Error: 429 rate limit exceeded',
      'Both claude and codex have reached their usage limits.',
      'API Error: 500 Internal server error',
      'API Error: 529 Overloaded',
      'Claude Code process exited with code 137',
      'fetch failed: ECONNRESET',
      'Spending limit reached. Add your own key at https://example.com/keys',
      'Error: 4010 widgets processed',
    ]) {
      expect(isProviderAuthFailureText(text)).toBe(false);
    }
  });
});
