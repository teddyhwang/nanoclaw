/**
 * Security regression for the channel-inbound attachment path (#2828 sibling).
 *
 * `extractAttachmentFiles` (via `writeSessionMessage`) hardens the per-message
 * inbox subdir against pre-placed symlinks, but NOT the `inbox` root itself.
 * A compromised container can write inside its own session dir, so it can
 * replace `inbox` with a symlink pointing outside the session sandbox. The
 * existing guard then:
 *   - skips the lstat branch (it only lstats `inbox/<msgId>`, not `inbox`),
 *   - mkdirs `inbox/<msgId>` *through* the symlink,
 *   - passes the containment check, because it compares against
 *     `realpathSync(inboxRoot)` which has already followed the symlink, and
 *   - writes a brand-new file (the `wx` flag only blocks an existing dst).
 *
 * Result: the host writes attacker-influenced bytes outside the session root —
 * the same class of bug fixed for the A2A path in forwardAttachedFiles (#2828).
 *
 * This test asserts the SECURE behaviour (nothing written outside). It FAILS
 * against the current code, demonstrating the gap.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-saveatt-gap' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage, withMailboxSession } from './session-manager.js';
import type { Session } from './types.js';
import { log } from './log.js';

import { transcribeAudio } from './media/transcription.js';
import { processVideo } from './media/video.js';
import { setPlatformCredentialReader, _resetPlatformCredentialReaderForTests } from './engine/platform-credentials.js';

vi.mock('./media/transcription.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media/transcription.js')>()),
  transcribeAudio: vi.fn(),
}));
vi.mock('./media/video.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media/video.js')>()),
  processVideo: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-saveatt-gap';
const AG = 'ag-saveatt';
const SESS = 'sess-saveatt';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: AG, name: 'SaveAtt', folder: 'saveatt', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  await createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(transcribeAudio).mockReset();
  vi.mocked(processVideo).mockReset();
  _resetPlatformCredentialReaderForTests();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/**
 * Let the container win the race: run `swap` once, right before the host's
 * first fs call that creates `leaf`. Every way the host could create the file
 * goes through one of these calls, so the swap lands after every check.
 */
function swapBeforeCreate(leaf: string, swap: () => void): void {
  let fired = false;
  for (const method of ['openSync', 'writeFileSync', 'copyFileSync'] as const) {
    const original = fs[method] as (...args: unknown[]) => unknown;
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      const target = method === 'copyFileSync' ? args[1] : args[0];
      if (!fired && typeof target === 'string' && path.basename(target) === leaf) {
        fired = true;
        swap();
      }
      return original.apply(fs, args);
    }) as never);
  }
}

/** Replace inbox/<messageId> with a symlink to `target`, as a container could. */
function swapInboxDir(messageId: string, target: string): () => void {
  return () => {
    const dir = path.join(sessionDir(AG, SESS), 'inbox', messageId);
    fs.renameSync(dir, `${dir}-moved`);
    fs.symlinkSync(target, dir);
  };
}

function attachmentMessage(id: string, names: string[]) {
  return {
    id,
    kind: 'chat' as const,
    timestamp: now(),
    platformId: 'whatsapp:123',
    channelType: 'whatsapp',
    threadId: null,
    content: JSON.stringify({
      text: 'see attached',
      attachments: names.map((name) => ({ name, data: Buffer.from(`bytes-${name}`).toString('base64') })),
    }),
  };
}

describe('extractAttachmentFiles — inbox dir swapped after the checks', () => {
  it('writes a single attachment into the directory it checked', async () => {
    const canaryDir = path.join(TEST_DIR, 'canary-single');
    fs.mkdirSync(canaryDir, { recursive: true });
    swapBeforeCreate('one.txt', swapInboxDir('race-single', canaryDir));

    await writeSessionMessage(AG, SESS, attachmentMessage('race-single', ['one.txt']));

    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });

  it('writes every attachment of a batch into the directory it checked', async () => {
    const canaryDir = path.join(TEST_DIR, 'canary-batch');
    fs.mkdirSync(canaryDir, { recursive: true });
    swapBeforeCreate('second.txt', swapInboxDir('race-batch', canaryDir));

    await writeSessionMessage(AG, SESS, attachmentMessage('race-batch', ['first.txt', 'second.txt']));

    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });

  it('still saves attachments when nothing interferes', async () => {
    const persisted = await writeSessionMessage(AG, SESS, attachmentMessage('plain', ['a.txt', 'b.txt']));
    // Returned content is exactly the stored row (provenance hashes must match).
    const rows = await withMailboxSession(AG, SESS, (mailbox) => mailbox.getRecentPendingTriggeringChats('2000-01-01'));
    expect(rows[0].content).toBe(persisted);
    expect(persisted).not.toContain('"data"');
    expect(persisted).toContain('localPath');

    const inbox = path.join(sessionDir(AG, SESS), 'inbox', 'plain');
    expect(fs.readFileSync(path.join(inbox, 'a.txt'), 'utf-8')).toBe('bytes-a.txt');
    expect(fs.readFileSync(path.join(inbox, 'b.txt'), 'utf-8')).toBe('bytes-b.txt');
  });
});

describe('extractAttachmentFiles — attachments sharing a name', () => {
  it('saves both photos of a Telegram album whose derived names collide', async () => {
    // Real shape from a Telegram album (two unnamed JPEGs, one message): the
    // bridge sends no name, so both derive attachment-<same ms>.jpg.
    vi.spyOn(Date, 'now').mockReturnValue(1795397221946);
    const photo = (bytes: string, size: number) => ({
      type: 'image',
      mimeType: 'image/jpeg',
      size,
      width: 960,
      height: 1280,
      data: Buffer.from(bytes).toString('base64'),
    });
    const persisted = await writeSessionMessage(AG, SESS, {
      id: '8669837947:3311:ag-x',
      kind: 'chat-sdk',
      timestamp: now(),
      platformId: 'telegram:8669837947',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        text: 'guest washroom',
        attachments: [photo('first', 126425), photo('second', 127895)],
      }),
    });

    const atts = JSON.parse(persisted).attachments;
    expect(persisted).not.toContain('"data"');
    expect(atts.map((a: { localPath: string }) => a.localPath)).toEqual([
      'inbox/8669837947:3311:ag-x/attachment-1795397221946.jpg',
      'inbox/8669837947:3311:ag-x/attachment-1795397221946-2.jpg',
    ]);
    const inbox = path.join(sessionDir(AG, SESS), 'inbox', '8669837947:3311:ag-x');
    expect(fs.readFileSync(path.join(inbox, 'attachment-1795397221946.jpg'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(inbox, 'attachment-1795397221946-2.jpg'), 'utf8')).toBe('second');
  });

  it('saves repeated explicit names under distinct files', async () => {
    const persisted = await writeSessionMessage(
      AG,
      SESS,
      attachmentMessage('dup', ['image.png', 'image.png', 'noext', 'noext']),
    );
    const names = JSON.parse(persisted).attachments.map((a: { name: string }) => a.name);
    expect(names).toEqual(['image.png', 'image-2.png', 'noext', 'noext-2']);
    expect(persisted).not.toContain('"data"');
  });
});

describe('extractAttachmentFiles — attachment that still cannot be saved', () => {
  it('logs the unsaved photo at error level without its bytes and leaves it without a localPath', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    // Real shape of attachment 1 of row 2872 (type image, data only, no name
    // or localPath). Pre-create its target so the exclusive write hits EEXIST.
    vi.spyOn(Date, 'now').mockReturnValue(1795397221946);
    const inbox = path.join(sessionDir(AG, SESS), 'inbox', 'lost-photo');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'attachment-1795397221946.jpg'), 'someone-else');
    const secret = Buffer.from('photo-bytes-secret').toString('base64');

    const persisted = await writeSessionMessage(AG, SESS, {
      id: 'lost-photo',
      kind: 'chat-sdk',
      timestamp: now(),
      platformId: 'telegram:1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        text: 'guest washroom',
        attachments: [{ type: 'image', mimeType: 'image/jpeg', size: 127895, data: secret }],
      }),
    });

    const att = JSON.parse(persisted).attachments[0];
    expect(att.localPath).toBeUndefined();
    const unsaved = errorSpy.mock.calls.filter(([msg]) => String(msg).includes('not saved'));
    expect(unsaved).toHaveLength(1);
    expect(unsaved[0][1]).toMatchObject({ messageId: 'lost-photo', index: 0, type: 'image', hadData: true });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret);
  });

  it('does not log an error when every attachment is saved', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await writeSessionMessage(AG, SESS, attachmentMessage('all-saved', ['a.txt', 'b.txt']));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('extractAttachmentFiles — inbox-root symlink containment (#2828 sibling)', () => {
  it('does not write an attachment outside the session root via a symlinked inbox root', async () => {
    // Attacker-controlled location outside the session sandbox.
    const canaryDir = path.join(TEST_DIR, 'canary-outside');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Container pre-places its whole `inbox` as a symlink pointing outside.
    const inboxRoot = path.join(sessionDir(AG, SESS), 'inbox');
    fs.rmSync(inboxRoot, { recursive: true, force: true });
    fs.symlinkSync(canaryDir, inboxRoot);

    const content = JSON.stringify({
      text: 'see attached',
      attachments: [{ name: 'pwn.txt', data: Buffer.from('attacker-bytes').toString('base64') }],
    });

    await writeSessionMessage(AG, SESS, {
      id: 'evil-inbox-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'whatsapp:123',
      channelType: 'whatsapp',
      threadId: null,
      content,
    });

    // SECURE expectation: nothing was written through the symlink to the
    // attacker-controlled canary location.
    const escaped = path.join(canaryDir, 'evil-inbox-root', 'pwn.txt');
    expect(fs.existsSync(escaped)).toBe(false);
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });
});

describe('media processing keeps the pinned inbox alive across awaits', () => {
  async function savedAttachments() {
    const rows = await withMailboxSession(AG, SESS, (mailbox) => mailbox.getRecentPendingTriggeringChats('2000-01-01'));
    return JSON.parse(rows[0].content).attachments;
  }

  it('transcribes once and writes the audio to the original directory after a mid-transcription swap', async () => {
    const outside = path.join(TEST_DIR, 'voice-outside');
    fs.mkdirSync(outside);
    const reader = vi.fn(() => 'injected-secret');
    setPlatformCredentialReader(reader);
    vi.mocked(transcribeAudio).mockImplementationOnce(async (bytes, opts) => {
      expect(bytes.toString()).toBe('bytes-voice.ogg');
      expect(opts?.getCredential).toBe(reader);
      await Promise.resolve();
      swapInboxDir('voice-race', outside)();
      return 'spoken words';
    });
    const msg = attachmentMessage('voice-race', ['voice.ogg']);
    const body = JSON.parse(msg.content);
    body.attachments[0].type = 'voice';
    msg.content = JSON.stringify(body);
    await writeSessionMessage(AG, SESS, msg);

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(sessionDir(AG, SESS), 'inbox', 'voice-race-moved', 'voice.ogg'), 'utf8')).toBe(
      'bytes-voice.ogg',
    );
    expect((await savedAttachments())[0]).toMatchObject({
      transcript: 'spoken words',
      localPath: 'inbox/voice-race/voice.ogg',
    });
  });

  it('publishes video markers and synthetic frames through the same open handle, then closes it', async () => {
    const outside = path.join(TEST_DIR, 'video-outside');
    fs.mkdirSync(outside);
    let output: import('./anchored-dir.js').AnchoredDir | undefined;
    const closed = vi.fn();
    vi.mocked(processVideo).mockImplementationOnce(async (_bytes, opts) => {
      output = opts.frameOutput;
      expect(output).toBeDefined();
      const close = output!.close.bind(output);
      vi.spyOn(output!, 'close').mockImplementation(() => {
        closed();
        close();
      });
      await Promise.resolve();
      expect(closed).not.toHaveBeenCalled();
      swapInboxDir('video-race', outside)();
      output!.writeNewFile('frame.jpg', Buffer.from('jpeg'));
      return {
        transcript: 'spoken video',
        transcriptStatus: 'transcribed',
        summary: 'a wave',
        frames: [{ filename: 'frame.jpg', absolutePath: path.join(opts.frameDir, 'frame.jpg') }],
        durationSeconds: 5,
        downscaled: false,
      };
    });
    const msg = attachmentMessage('video-race', ['clip.mp4']);
    const body = JSON.parse(msg.content);
    body.attachments[0].type = 'video';
    msg.content = JSON.stringify(body);
    await writeSessionMessage(AG, SESS, msg);

    expect(processVideo).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(outside)).toEqual([]);
    const moved = path.join(sessionDir(AG, SESS), 'inbox', 'video-race-moved');
    expect(fs.readFileSync(path.join(moved, 'clip.mp4'), 'utf8')).toBe('bytes-clip.mp4');
    expect(fs.readFileSync(path.join(moved, 'frame.jpg'), 'utf8')).toBe('jpeg');
    expect(await savedAttachments()).toMatchObject([
      { videoMarker: '[Video: spoken video | Summary: a wave]', localPath: 'inbox/video-race/clip.mp4' },
      { type: 'image', localPath: 'inbox/video-race/frame.jpg', fromVideo: 'clip.mp4' },
    ]);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('does not process media through an unsafe inbox directory', async () => {
    const outside = path.join(TEST_DIR, 'media-outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(sessionDir(AG, SESS), 'inbox'), { recursive: true });
    fs.symlinkSync(outside, path.join(sessionDir(AG, SESS), 'inbox', 'blocked-media'));
    const msg = attachmentMessage('blocked-media', ['clip.mp4']);
    const body = JSON.parse(msg.content);
    body.attachments[0].type = 'video';
    msg.content = JSON.stringify(body);
    await writeSessionMessage(AG, SESS, msg);
    expect(processVideo).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
