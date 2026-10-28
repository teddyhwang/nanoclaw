/**
 * Read a session's undelivered outbound queue through the bounded
 * getDueMessages pages.
 *
 * outbound.db is runner-written and unbounded, so a single unbounded read
 * lets a container stall the host; a single page lets a backlog of rows that
 * stay undelivered (held for an unavailable channel, backing off, queued
 * behind one) hide every later row. This pages, oldest first, up to
 * `maxPages`; if that cap is hit it still reads the destinationless rows
 * (system actions such as identity_turn_begin, task_log) beyond it, because
 * delivery never holds those and turns wait on them. Result is in queue
 * order (timestamp, then sequence): every page takes the oldest rows not yet
 * seen, so each later page's rows follow all earlier ones.
 */
import type { MailboxSession, OutboundMessage } from './types.js';

/** Default page cap: 25 pages of 200 = 5000 rows per read. */
export const UNDELIVERED_MAX_PAGES = 25;

export function readUndelivered(
  mailbox: Pick<MailboxSession, 'getDueMessages'>,
  delivered: ReadonlySet<string>,
  options: { includeNotYetDue?: boolean; maxPages?: number } = {},
): OutboundMessage[] {
  const maxPages = options.maxPages ?? UNDELIVERED_MAX_PAGES;
  const seen = new Set(delivered);
  const out: OutboundMessage[] = [];
  const page = (extra: { destinationless?: boolean }) => {
    const batch = mailbox
      .getDueMessages(seen, { includeNotYetDue: options.includeNotYetDue, ...extra })
      .filter((row) => !seen.has(row.id));
    for (const row of batch) seen.add(row.id);
    out.push(...batch);
    return batch.length;
  };
  for (let pages = 0; pages < maxPages; pages++) if (page({}) === 0) return out;
  // Cap hit: the rest may still hold rows nothing can block.
  for (let extra = 0; extra < maxPages; extra++) if (page({ destinationless: true }) === 0) break;
  return out;
}
