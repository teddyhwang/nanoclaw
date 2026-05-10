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
 * Non-image media types are passed through unchanged.
 */
import sharp from 'sharp';

import { log } from '../log.js';

/** Max single-axis dimension after resize. Anthropic recommends ≤1568px on the long edge for cost; 1024 is a tighter quality/size sweet spot for screenshots. */
export const MAX_IMAGE_DIMENSION = 1024;

/** Threshold above which we resize. 3.5 MB raw → ~4.7 MB base64, safely under the 5 MB API cap. */
export const RESIZE_THRESHOLD_BYTES = 3.5 * 1024 * 1024;

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
  // motion. Pass them through — the API takes a still image either way; if
  // the agent really needs the animation, that's a separate ffmpeg path.
  // Static-friendly formats only: JPEG, PNG, WebP (still).
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
