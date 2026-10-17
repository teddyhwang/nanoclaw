import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnchoredDir } from '../anchored-dir.js';

import { processVideo } from './video.js';

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every((bin) => spawnSync(bin, ['-version']).status === 0);

// Exercise the real decoder + filesystem, including /.vol aliases on macOS.
// No audio stream or API credential: this suite never calls a paid service.
describe.skipIf(!hasFfmpeg)('video publication into an agent-writable directory', () => {
  let root: string;
  let video: Buffer;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ncl-video-fs-'));
    const source = path.join(root, 'source.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-an', source]);
    video = fs.readFileSync(source);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps frames on the pinned directory after a swap, using private scratch for all subprocess I/O', async () => {
    const frameDir = path.join(root, 'inbox', 'msg');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const output = AnchoredDir.open(root, ['inbox', 'msg'], true)!;
    const write = fs.writeFileSync;
    let scratch: string | undefined;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === 'string' && path.basename(args[0]) === 'input.bin') {
        scratch = path.dirname(args[0]);
        expect(scratch.startsWith(frameDir)).toBe(false);
        expect(fs.statSync(scratch).mode & 0o777).toBe(0o700);
        fs.renameSync(path.join(root, 'inbox'), path.join(root, 'moved'));
        fs.symlinkSync(outside, path.join(root, 'inbox'));
      }
      return write(...args);
    }) as typeof fs.writeFileSync);
    try {
      const result = await processVideo(video, { frameDir, frameOutput: output, getCredential: () => null });
      expect(result?.transcriptStatus).toBe('no_audio');
      expect(result?.frames).toHaveLength(2);
      for (const frame of result!.frames) {
        const bytes = output.readFile(frame.filename);
        expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        expect(fs.readFileSync(path.join(root, 'moved', 'msg', frame.filename))).toEqual(bytes);
      }
      // processVideo borrows, never closes the caller's descriptor.
      output.writeNewFile('still-open', Buffer.from('yes'));
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(scratch).toBeDefined();
      expect(fs.existsSync(scratch!)).toBe(false);
    } finally {
      spy.mockRestore();
      output.close();
    }
  });

  it('refuses planted symlink/FIFO frames without blocking or losing the video outcome', async () => {
    const output = AnchoredDir.open(root, ['frames'], true)!;
    const frameDir = path.join(root, 'frames');
    const hostFile = path.join(root, 'host-secret');
    fs.writeFileSync(hostFile, 'keep');
    const publish = output.writeNewFile.bind(output);
    let count = 0;
    vi.spyOn(output, 'writeNewFile').mockImplementation((name, bytes) => {
      if (count++ === 0) fs.symlinkSync(hostFile, path.join(frameDir, name));
      else execFileSync('mkfifo', [path.join(frameDir, name)]);
      publish(name, bytes);
    });
    try {
      const result = await processVideo(video, { frameDir, frameOutput: output, getCredential: () => null });
      expect(count).toBe(2);
      expect(result?.transcriptStatus).toBe('no_audio');
      expect(result?.frames).toEqual([]);
      expect(fs.readFileSync(hostFile, 'utf8')).toBe('keep');
    } finally {
      output.close();
    }
  });

  it('anchors string-only callers too, refusing a symlinked ancestor', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'inbox'));
    expect(
      await processVideo(video, { frameDir: path.join(root, 'inbox', 'msg'), getCredential: () => null }),
    ).toBeNull();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('retains string-only caller output on a normal volume', async () => {
    const frameDir = path.join(root, 'normal', 'frames');
    const result = await processVideo(video, { frameDir, getCredential: () => null });
    expect(result?.frames).toHaveLength(2);
    for (const frame of result!.frames) expect(fs.statSync(frame.absolutePath).size).toBeGreaterThan(0);
    expect(fs.readdirSync(frameDir).sort()).toEqual(result!.frames.map((f) => f.filename).sort());
  });
});
