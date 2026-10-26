/**
 * Log-safe identifiers.
 *
 * Platform ids (WhatsApp JIDs embed phone numbers), namespaced user ids,
 * DM handles and sender identities must never reach the log raw. Wrap them
 * in `logId()` instead: it returns a short keyed hash that stays stable for
 * the life of the hasher, so log lines can still be correlated.
 *
 * Hosts inject their own hasher (`setLogIdHasher`, or the
 * `logIdHasher` option of `createNanoClawHost`) so the engine's ids match
 * the host's other privacy-safe logs across restarts. Without one, ids are
 * an HMAC under a per-process random key: stable within a run, never raw.
 */
import crypto from 'crypto';

export type LogIdHasher = (raw: string) => string;

const HASH_HEX = 10;
const processKey = crypto.randomBytes(32);

function defaultHasher(raw: string): string {
  return crypto.createHmac('sha256', processKey).update(raw).digest('hex').slice(0, HASH_HEX);
}

let hasher: LogIdHasher = defaultHasher;

/** Replace the hasher (host injection). Pass `undefined` to restore the default. */
export function setLogIdHasher(fn: LogIdHasher | undefined): void {
  hasher = fn ?? defaultHasher;
}

/**
 * Hash an identifier for logging. `null`/`undefined`/empty pass through
 * (absence is useful and not identifying); anything else is hashed. Never
 * throws and never returns the raw value.
 */
export function logId(raw: string | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return raw;
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw or fall back to the raw id */
  try {
    const hashed = hasher(String(raw));
    if (typeof hashed === 'string' && hashed && hashed !== raw) return hashed;
  } catch {
    /* fall through to the default */
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return defaultHasher(String(raw));
}
