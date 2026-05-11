/**
 * Host-side image preprocessing for inbound chat attachments.
 *
 * Anthropic's vision API rejects images whose base64-encoded payload exceeds
 * 5 MB. Base64 inflates by 4/3, so the raw byte budget is ~3.75 MB. We pick a
 * conservative 3.5 MB threshold and resize anything over it down to a 1024px
 * max dimension via sharp's `fit: 'inside'` (preserves aspect ratio, never
 * enlarges). JPEG/JFIF re-encoded at quality 85 — visually indistinguishable
 * from the original at typical screen sizes, but produces ~5–10× smaller
 * files for typical Discord-CDN screenshot uploads.
 *
 * Animated content (Tenor/Giphy `video/mp4` gifv embeds; WhatsApp "GIFs"
 * which are MP4-encoded under `image/gif`; oversized real GIFs) goes
 * through `maybeTranscodeAnimated` — ffmpeg-based, bounded duration/fps,
 * palettegen+paletteuse for color quality, hard cap on output bytes.
 *
 * Non-image media types are passed through unchanged by `maybeResizeImage`.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import sharp from 'sharp';

import { log } from '../log.js';

const execFileAsync = promisify(execFile);

/** Max single-axis dimension after resize. Anthropic recommends ≤1568px on the long edge for cost; 1024 is a tighter quality/size sweet spot for screenshots. */
export const MAX_IMAGE_DIMENSION = 1024;

/** Threshold above which we resize. 3.5 MB raw → ~4.7 MB base64, safely under the 5 MB API cap. */
export const RESIZE_THRESHOLD_BYTES = 3.5 * 1024 * 1024;

/**
 * Hard cap on the raw byte size of an animated GIF we'll hand to Anthropic.
 * Same 3.5 MB budget as the resize threshold — base64-inflated payload stays
 * under the 5 MB per-image cap with headroom for the HTTP/JSON envelope.
 * Animated content that exceeds this after transcode is dropped (caller
 * skips the attachment) rather than silently failing downstream with an
 * opaque API error.
 */
export const MAX_ANIMATED_GIF_BYTES = 3.5 * 1024 * 1024;

/**
 * If the input is a JPEG/PNG/WebP and exceeds RESIZE_THRESHOLD_BYTES, resize
 * to MAX_IMAGE_DIMENSION on the longest edge and re-encode as JPEG quality 85.
 * Returns the (possibly-modified) buffer. Logs at debug for trace, warns and
 * returns original on sharp failure (so an oversized image still gets
 * delivered — Anthropic will reject it, but better that than dropping it
 * silently).
 */
export async function maybeResizeImage(buffer: Buffer, mimeType: string | undefined): Promise<Buffer> {
  if (!mimeType) return buffer;
  if (buffer.length <= RESIZE_THRESHOLD_BYTES) return buffer;

  // Animated formats (GIF, animated WebP, MP4-as-image) need ffmpeg-style
  // re-encoding to preserve animation; sharp can't transcode while preserving
  // motion. Handled separately by `maybeTranscodeAnimated`. Static-friendly
  // formats only here: JPEG, PNG, WebP (still).
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp') {
    return buffer;
  }

  try {
    const resized = await sharp(buffer)
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    log.debug('Resized image attachment', {
      mimeType,
      before: buffer.length,
      after: resized.length,
    });
    return resized;
    // eslint-disable-next-line no-catch-all/no-catch-all -- intentional: any sharp error degrades to passing the original through (Anthropic will reject it loudly). Better than dropping the attachment silently or aborting the message.
  } catch (err) {
    log.warn('Image resize failed; passing through original', {
      mimeType,
      size: buffer.length,
      err: (err as Error).message,
    });
    return buffer;
  }
}

/**
 * Whether a given (type, mimeType) pair looks like an animated payload
 * that needs ffmpeg transcoding before Anthropic will accept it.
 *
 * Three cases motivate this path:
 *   1. Tenor/Giphy "gifv" — Discord serves these as `video/mp4` even
 *      though the user pasted a GIF. Anthropic rejects MP4 bytes with
 *      a 400 "Could not process image".
 *   2. WhatsApp "GIFs" — Baileys delivers these as MP4-encoded video
 *      under `image/gif` mimeType. Same 400 from Anthropic.
 *   3. Real animated GIFs that exceed `MAX_ANIMATED_GIF_BYTES` — sharp
 *      can't shrink them while preserving motion; ffmpeg can.
 *
 * Callers use this to decide whether to invoke `maybeTranscodeAnimated`.
 */
export function shouldTranscodeAnimated(type: string | undefined, mimeType: string | undefined, size: number): boolean {
  if (!mimeType) return false;
  if (mimeType === 'video/mp4') return true;
  if (mimeType === 'image/gif') {
    // Always transcode — the bytes might be MP4-under-gif-mime (WhatsApp).
    // For real GIFs under budget, ffmpeg is a few hundred ms one-way trip
    // that doesn't hurt, and gets us palette consistency for free.
    if (type === 'image' || type === 'video') return size > 0;
  }
  return false;
}

export interface AnimatedTranscodeResult {
  /** True when ffmpeg ran AND produced a result within the byte budget. */
  ok: boolean;
  /** Output bytes if ok; null otherwise. */
  buffer: Buffer | null;
  /** Always `image/gif` on success — caller should rewrite the attachment mimeType. */
  mimeType: 'image/gif' | null;
  /** Reason for skipping, when `ok === false`. Used for diagnostic logging only. */
  reason?: 'ffmpeg_failed' | 'output_oversize' | 'output_empty';
}

/**
 * Normalize an animated input buffer (MP4 from WhatsApp/Tenor/Giphy gifv,
 * or any GIF — including ones already under budget) into a bounded
 * animated GIF, returning the encoded bytes.
 *
 * Encoding choices match v1's `transcodeBufferToAnimatedGif`:
 *   `-t 6`     cap duration at 6s; per-image size budget is tight and most
 *              chat-shared GIFs are short loops anyway.
 *   `fps=15`   smooth motion without ballooning the file.
 *   `scale`    bound long edge to MAX_IMAGE_DIMENSION, lanczos for quality.
 *   `palettegen`+`paletteuse` (single-pass via `split`) — quality palette
 *              so colors survive the 8-bit GIF reduction.
 *   `-loop 0`  infinite loop, matches user expectations for chat GIFs.
 *
 * ffmpeg detects the input format from file contents, so we don't need
 * to set an extension; both MP4 and GIF inputs flow through the same
 * command line.
 *
 * Hard fails if ffmpeg isn't on PATH (caller falls through to dropping
 * the attachment, same as v1).
 */
export async function maybeTranscodeAnimated(buffer: Buffer, mimeType: string): Promise<AnimatedTranscodeResult> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tmpDir = os.tmpdir();
  const tmpInput = path.join(tmpDir, `nanoclaw-anim-${tag}.bin`);
  const tmpOutput = path.join(tmpDir, `nanoclaw-anim-${tag}.gif`);
  try {
    fs.writeFileSync(tmpInput, buffer);
    await execFileAsync('ffmpeg', [
      '-i',
      tmpInput,
      '-t',
      '6',
      '-vf',
      `fps=15,scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
      '-loop',
      '0',
      '-y',
      tmpOutput,
    ]);
    if (!fs.existsSync(tmpOutput)) {
      return { ok: false, buffer: null, mimeType: null, reason: 'ffmpeg_failed' };
    }
    const size = fs.statSync(tmpOutput).size;
    if (size === 0) {
      return { ok: false, buffer: null, mimeType: null, reason: 'output_empty' };
    }
    if (size > MAX_ANIMATED_GIF_BYTES) {
      log.warn('Animated transcode exceeds size budget, dropping', {
        mimeType,
        beforeBytes: buffer.length,
        afterBytes: size,
        limit: MAX_ANIMATED_GIF_BYTES,
      });
      return { ok: false, buffer: null, mimeType: null, reason: 'output_oversize' };
    }
    const out = fs.readFileSync(tmpOutput);
    log.debug('Animated transcode succeeded', {
      sourceMime: mimeType,
      beforeBytes: buffer.length,
      afterBytes: out.length,
    });
    return { ok: true, buffer: out, mimeType: 'image/gif' };
    // eslint-disable-next-line no-catch-all/no-catch-all -- ffmpeg can fail for many reasons (codec issues, missing binary, corrupt input). Caller drops the attachment when ok=false, so degradation is consistent regardless of cause.
  } catch (err) {
    log.warn('Animated transcode (ffmpeg) failed', {
      mimeType,
      size: buffer.length,
      err: (err as Error).message,
    });
    return { ok: false, buffer: null, mimeType: null, reason: 'ffmpeg_failed' };
  } finally {
    try {
      fs.rmSync(tmpInput, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpOutput, { force: true });
    } catch {
      /* ignore */
    }
  }
}
