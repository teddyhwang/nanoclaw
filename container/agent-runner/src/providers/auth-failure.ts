/**
 * Pure classifier for provider credential failures (revoked/expired OAuth
 * token, bad API key). Kept free of DB imports so the provider wrappers can
 * use it. See ../provider-auth-failure.ts for the runtime behaviour.
 */
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /failed to authenticate/i,
  /authentication_error/i,
  /oauth (access )?token (has been revoked|has expired|is (invalid|expired))/i,
  /invalid (x-api-key|api[ _-]?key|bearer token|authentication credentials)/i,
  /\b401\b[^\n]*\b(unauthori[sz]ed|authenticat\w*|oauth|access token|api key)\b/i,
  /\b(unauthori[sz]ed|authenticat\w*)\b[^\n]*\b401\b/i,
  /not logged in[^\n]*\/login/i,
  /refresh token (was already used|has been revoked|is invalid|expired)/i,
];

/**
 * True when provider error text identifies a credential failure. Only call on
 * text already known to be an error (an `isError` result, a thrown provider
 * error) — an ordinary assistant answer that mentions "401" is not a signal.
 */
export function isProviderAuthFailureText(text: string | null | undefined): boolean {
  if (!text) return false;
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

/** What a chat user sees instead of the raw provider credential error. */
export const AUTH_FAILURE_USER_TEXT =
  "Sorry, I couldn't answer that. My connection to the AI service failed to authenticate, " +
  'so I can’t respond right now. Please try again later or contact the admin.';
