/**
 * Typed "this channel cannot send right now" signal.
 *
 * A channel adapter (or the delivery bridge) throws this when it KNOWS the
 * send could not have reached the platform: the transport is disconnected,
 * the account is logged out, or no adapter is registered for the instance.
 * Delivery treats it as a hold, not an attempt — the message keeps its retry
 * budget and is re-tried on a fixed cadence until the channel comes back or
 * the hold window expires (see `delivery.ts`).
 *
 * Never throw it once bytes may have left the process. An ambiguous send
 * (timeout after the write, partial multi-part send) must surface as an
 * ordinary Error so the bounded attempt budget applies; holding an ambiguous
 * send would re-send it on every recovery.
 */
export const CHANNEL_UNAVAILABLE = 'CHANNEL_UNAVAILABLE' as const;

export class ChannelUnavailableError extends Error {
  readonly code = CHANNEL_UNAVAILABLE;
  readonly channel: string;

  constructor(channel: string, reason: string, options?: { cause?: unknown }) {
    super(`${channel} unavailable: ${reason}`, options);
    this.name = 'ChannelUnavailableError';
    this.channel = channel;
  }
}

/**
 * Structural check so an error from a second copy of this module (plugins
 * resolving the engine through a separate install) still classifies.
 */
export function isChannelUnavailableError(err: unknown): boolean {
  return (
    err instanceof ChannelUnavailableError ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === CHANNEL_UNAVAILABLE)
  );
}
