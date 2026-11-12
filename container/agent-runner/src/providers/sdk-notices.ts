/**
 * The Claude CLI's own fixed failure notices (exact strings), safe to show in
 * a channel, and the hint added to each. Kept free of SDK imports so the
 * user-facing failure-notice sanitizer can recognise them.
 */
export const OWNER_FIX_HINT =
  "Whoever runs this NanoClaw needs to fix this outside the chat. Please don't send keys or passwords here.";

export const SDK_NOTICES = new Map([
  ['Not logged in · Please run /login', OWNER_FIX_HINT],
  ['Invalid API key · Fix external API key', OWNER_FIX_HINT],
  ['Invalid auth token · Fix external auth token', OWNER_FIX_HINT],
  ['Credit balance is too low', OWNER_FIX_HINT],
  ['Prompt is too long', 'This conversation got too long. An admin can send /clear to start a new one.'],
]);

/** The exact text a fixed SDK notice is delivered as: notice first, hint on its own line. */
export function sdkNoticeText(notice: string): string | undefined {
  const hint = SDK_NOTICES.get(notice);
  return hint ? `${notice}\n${hint}` : undefined;
}

/** True when text is exactly one of the fixed SDK notices as delivered. */
export function isFixedSdkNoticeText(text: string): boolean {
  const [notice, ...rest] = text.split('\n');
  return rest.length > 0 && sdkNoticeText(notice) === text;
}
