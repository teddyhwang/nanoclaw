import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { getAgentMailbox } from './mailbox/index.js';

export interface ImageDeliveryRoute {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

interface ImageDeliveryRecord {
  inReplyTo: string;
  images: Record<string, string>;
}

// The runner and send_file's MCP subprocess share mailbox state, not memory.
// Keep only the latest addressed request per destination/thread. Null reply
// targets cannot distinguish task turns, so deliberately do not deduplicate them.
function stateKey(route: ImageDeliveryRoute): string | null {
  if (!route.inReplyTo || !route.channelType || !route.platformId) return null;
  const key = createHash('sha256')
    .update(JSON.stringify([route.channelType, route.platformId, route.threadId]))
    .digest('hex');
  return `generated_image_delivery:${key}`;
}

function fingerprint(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytes: number;
    while ((bytes = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function readRecord(key: string, route: ImageDeliveryRoute): ImageDeliveryRecord {
  const saved = getAgentMailbox().operations.getState(key);
  if (saved) {
    const record = JSON.parse(saved.value) as ImageDeliveryRecord;
    if (record.inReplyTo === route.inReplyTo) return record;
  }
  return { inReplyTo: route.inReplyTo!, images: {} };
}

/** Outbox evidence only, not a platform delivery receipt. Copies/renames match. */
export function findQueuedGeneratedImage(file: string, route: ImageDeliveryRoute): string | undefined {
  const key = stateKey(route);
  if (!key) return undefined;
  const record = readRecord(key, route);
  // Ordinary files must not be read/hashed unless this request actually queued
  // a native image; in particular, do not penalize unrelated large artifacts.
  if (Object.keys(record.images).length === 0) return undefined;
  return record.images[fingerprint(file)];
}

/** Record only after the native image's outbox write succeeds. */
export function recordQueuedGeneratedImage(file: string, route: ImageDeliveryRoute, messageId: string): void {
  const key = stateKey(route);
  if (!key) return;
  const record = readRecord(key, route);
  record.images[fingerprint(file)] = messageId;
  getAgentMailbox().operations.setState(key, JSON.stringify(record));
}
