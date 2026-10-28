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
 * delivery never holds those and turns wait on them.
 *
 * Pages follow a cursor (the last row read), so every page sends the same
 * exclusion (the delivered set) and costs the same however deep the backlog.
 * Result is in queue order: each page holds the oldest rows after the cursor.
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
  const out: OutboundMessage[] = [];
  let after: string | undefined;
  const page = (extra: { destinationless?: boolean }) => {
    const batch = mailbox
      .getDueMessages(delivered, { includeNotYetDue: options.includeNotYetDue, after, ...extra })
      .filter((row) => !delivered.has(row.id));
    if (batch.length === 0) return false;
    after = batch[batch.length - 1]!.id;
    out.push(...batch);
    return true;
  };
  for (let pages = 0; pages < maxPages; pages++) if (!page({})) return out;
  // Cap hit: the rest may still hold rows nothing can block.
  for (let extra = 0; extra < maxPages; extra++) if (!page({ destinationless: true })) break;
  return out;
}
