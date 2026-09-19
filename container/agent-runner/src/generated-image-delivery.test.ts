import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { setCurrentBatchReplyTarget } from './db/session-state.js';
import { deliverGeneratedImage } from './poll-loop.js';
import { sendFile } from './mcp-tools/core.js';
import type { RoutingContext } from './formatter.js';

let tmp: string;
let image: string;
const route: RoutingContext = {
  channelType: 'whatsapp',
  platformId: 'tico',
  threadId: null,
  inReplyTo: 'request-1',
  taskFire: false,
};
const contents = () => getUndeliveredMessages().map((row) => JSON.parse(row.content));
beforeEach(() => {
  initTestSessionDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-image-'));
  process.env.NANOCLAW_OUTBOX_ROOT = path.join(tmp, 'outbox');
  image = path.join(tmp, 'native.png');
  fs.writeFileSync(image, 'image-bytes');
  for (const name of ['tico', 'other']) {
    getInboundDb()
      .prepare(
        "INSERT INTO destinations (name, display_name, type, channel_type, platform_id) VALUES (?, ?, 'channel', 'whatsapp', ?)",
      )
      .run(name, name, name);
  }
  setCurrentBatchReplyTarget('request-1');
});
afterEach(() => {
  closeSessionDb();
  delete process.env.NANOCLAW_OUTBOX_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('native image then explicit send_file', () => {
  it('delivers identical renamed bytes once and preserves the caption', async () => {
    await deliverGeneratedImage(image, route, tmp);
    const copy = path.join(tmp, 'renamed.png');
    fs.copyFileSync(image, copy);
    const result = await sendFile.handler({ to: 'tico', path: copy, text: 'Updated layout', filename: 'room.png' });
    expect(result.isError).not.toBe(true);
    expect(contents().flatMap((c) => c.files ?? [])).toEqual(['native.png']);
    expect(contents().map((c) => c.text)).toEqual(['', 'Updated layout']);
    expect(JSON.stringify(result)).toContain('already queued');
  });
  it('does not create an empty second message or replay the native event', async () => {
    await deliverGeneratedImage(image, route, tmp);
    await deliverGeneratedImage(image, route, tmp);
    await sendFile.handler({ to: 'tico', path: image });
    expect(contents()).toHaveLength(1);
  });
  it('does not suppress a changed image, other destination, or later user request', async () => {
    await deliverGeneratedImage(image, route, tmp);
    await sendFile.handler({ to: 'other', path: image });
    setCurrentBatchReplyTarget('request-2');
    await sendFile.handler({ to: 'tico', path: image });
    setCurrentBatchReplyTarget('request-1');
    fs.writeFileSync(image, 'edited-image-bytes');
    await sendFile.handler({ to: 'tico', path: image });
    expect(contents().flatMap((c) => c.files ?? [])).toHaveLength(4);
  });
  it('keeps ordinary host-generated and other explicit file sends intact', async () => {
    await sendFile.handler({ to: 'tico', path: image });
    expect(contents()[0].files).toEqual(['native.png']);
  });
  it('preserves sibling attachments in a duplicate image caption', async () => {
    await deliverGeneratedImage(image, route, tmp);
    const pdf = path.join(tmp, 'shopping.pdf');
    fs.writeFileSync(pdf, 'pdf-bytes');
    await sendFile.handler({
      to: 'tico',
      path: image,
      text: `See [image](sandbox:${image}) and [list](sandbox:${pdf})`,
    });
    expect(contents().flatMap((c) => c.files ?? [])).toEqual(['native.png', 'shopping.pdf']);
    expect(contents()[1].text).toBe('See image and list');
  });
  it('keeps distinct native images in the same request and separates threads', async () => {
    await deliverGeneratedImage(image, route, tmp);
    const second = path.join(tmp, 'second.png');
    fs.writeFileSync(second, 'second-image');
    await deliverGeneratedImage(second, route, tmp);
    await sendFile.handler({ to: 'tico', path: image });
    await sendFile.handler({ to: 'tico', path: second });
    await deliverGeneratedImage(image, { ...route, threadId: 'other-thread' }, tmp);
    expect(contents().flatMap((c) => c.files ?? [])).toEqual(['native.png', 'second.png', 'native.png']);
  });
  it('does not register a rejected native path as queued', async () => {
    const allowedRoot = path.join(tmp, 'allowed');
    fs.mkdirSync(allowedRoot);
    await expect(deliverGeneratedImage(image, route, allowedRoot)).rejects.toThrow('outside provider output root');
    await sendFile.handler({ to: 'tico', path: image });
    expect(contents()[0].files).toEqual(['native.png']);
  });
  it('never conflates unaddressed task turns', async () => {
    await deliverGeneratedImage(image, { ...route, inReplyTo: null, taskFire: true }, tmp);
    setCurrentBatchReplyTarget(null);
    await sendFile.handler({ to: 'tico', path: image });
    expect(contents().flatMap((c) => c.files ?? [])).toHaveLength(2);
  });
});
