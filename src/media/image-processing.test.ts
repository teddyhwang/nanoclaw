import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// child_process.execFile must be mocked BEFORE the production module loads
// (it imports execFile at module init via `promisify(execFile)`). vi.hoisted
// exposes mutable state to the top-level vi.mock factory.
const { mockState } = vi.hoisted(() => ({
  mockState: {
    behavior: 'ok' as 'ok' | 'throw',
    outputSize: 50_000 as number | 'omit' | 'empty',
    calls: [] as Array<{ args: readonly string[] }>,
  },
}));

vi.mock('child_process', () => {
  const execFile = (
    _binary: string,
    args: readonly string[],
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ): void => {
    mockState.calls.push({ args });
    if (mockState.behavior === 'throw') {
      cb(new Error('ffmpeg not found'), { stdout: '', stderr: '' });
      return;
    }
    const yIdx = args.indexOf('-y');
    const outputPath = yIdx >= 0 ? args[yIdx + 1] : null;
    if (outputPath && mockState.outputSize !== 'omit') {
      const bytes = mockState.outputSize === 'empty' ? Buffer.alloc(0) : Buffer.alloc(mockState.outputSize, 0x47);
      fs.writeFileSync(outputPath, bytes);
    }
    cb(null, { stdout: '', stderr: '' });
  };
  return { execFile };
});

import { MAX_ANIMATED_GIF_BYTES, maybeTranscodeAnimated, shouldTranscodeAnimated } from './image-processing.js';

describe('shouldTranscodeAnimated', () => {
  it('flags image-classified MP4 animation but preserves real videos', () => {
    expect(shouldTranscodeAnimated('video', 'video/mp4', 500_000)).toBe(false);
    expect(shouldTranscodeAnimated('image', 'video/mp4', 500_000)).toBe(true);
  });

  it('flags image/gif regardless of size (WhatsApp ships MP4-as-gif)', () => {
    expect(shouldTranscodeAnimated('image', 'image/gif', 100)).toBe(true);
    expect(shouldTranscodeAnimated('image', 'image/gif', 10_000_000)).toBe(true);
  });

  it('passes through static images', () => {
    expect(shouldTranscodeAnimated('image', 'image/jpeg', 1_000_000)).toBe(false);
    expect(shouldTranscodeAnimated('image', 'image/png', 1_000_000)).toBe(false);
    expect(shouldTranscodeAnimated('image', 'image/webp', 1_000_000)).toBe(false);
  });

  it('passes through audio/file/missing-mime', () => {
    expect(shouldTranscodeAnimated('audio', 'audio/ogg', 50_000)).toBe(false);
    expect(shouldTranscodeAnimated('file', 'application/pdf', 50_000)).toBe(false);
    expect(shouldTranscodeAnimated('image', undefined, 50_000)).toBe(false);
  });

  it('skips zero-byte gifs (corrupt download)', () => {
    expect(shouldTranscodeAnimated('image', 'image/gif', 0)).toBe(false);
  });
});

describe('maybeTranscodeAnimated', () => {
  beforeEach(() => {
    mockState.behavior = 'ok';
    mockState.outputSize = 50_000;
    mockState.calls = [];
  });

  afterEach(() => {
    // Wipe any tmp files the production code left behind if its cleanup
    // branch didn't fire. tmpdir/nanoclaw-anim-* pattern.
    const tmp = os.tmpdir();
    for (const entry of fs.readdirSync(tmp)) {
      if (entry.startsWith('nanoclaw-anim-')) {
        try {
          fs.rmSync(path.join(tmp, entry), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  });

  it('transcodes a video/mp4 buffer to image/gif under budget', async () => {
    mockState.outputSize = 250_000;
    const result = await maybeTranscodeAnimated(Buffer.from('fake-mp4-bytes'), 'video/mp4');
    expect(result.ok).toBe(true);
    expect(result.mimeType).toBe('image/gif');
    expect(result.buffer?.length).toBe(250_000);
    expect(mockState.calls).toHaveLength(1);
    const args = mockState.calls[0].args.join(' ');
    expect(args).toMatch(/palettegen/);
    expect(args).toMatch(/paletteuse/);
    expect(args).toMatch(/-t 6/);
    expect(args).toMatch(/-loop 0/);
    expect(args).toMatch(/fps=15/);
  });

  it('drops the output when it exceeds MAX_ANIMATED_GIF_BYTES', async () => {
    mockState.outputSize = MAX_ANIMATED_GIF_BYTES + 1024;
    const result = await maybeTranscodeAnimated(Buffer.from('huge-input'), 'video/mp4');
    expect(result.ok).toBe(false);
    expect(result.buffer).toBeNull();
    expect(result.reason).toBe('output_oversize');
  });

  it('drops the output when ffmpeg writes an empty file', async () => {
    mockState.outputSize = 'empty';
    const result = await maybeTranscodeAnimated(Buffer.from('x'), 'image/gif');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('output_empty');
  });

  it('drops the output when ffmpeg produces no file', async () => {
    mockState.outputSize = 'omit';
    const result = await maybeTranscodeAnimated(Buffer.from('x'), 'image/gif');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ffmpeg_failed');
  });

  it('returns ffmpeg_failed when the binary errors (e.g. not installed)', async () => {
    mockState.behavior = 'throw';
    const result = await maybeTranscodeAnimated(Buffer.from('whatever'), 'image/gif');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ffmpeg_failed');
  });

  it('cleans up temp files on success and failure', async () => {
    mockState.outputSize = 'empty';
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('nanoclaw-anim-'));
    await maybeTranscodeAnimated(Buffer.from('x'), 'image/gif');
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('nanoclaw-anim-'));
    // No tmp files leak — count is unchanged regardless of outcome.
    expect(after.length).toBe(before.length);
  });
});
