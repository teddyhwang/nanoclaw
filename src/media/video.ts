/**
 * Channel-agnostic video processing. Host-side only — the container never
 * fetches video bytes (frames + transcript are produced here and ride the
 * existing inbound rails into the container).
 *
 * Pipeline:
 *   1. Probe duration (ffprobe).
 *   2. Extract N keyframes (ffmpeg) at duration-adaptive timestamps, resized
 *      to MAX_IMAGE_DIMENSION JPEGs written into `opts.frameDir`.
 *   3. Submit the video to Gemini for transcript + visual summary in one call
 *      (inline data ≤18MB; ffmpeg-downscale to fit otherwise).
 *
 * Ported from v1 `apps/nanoclaw/src/video.ts` (deleted in the v2 cutover,
 * commit d55d3d22). v2 reshape:
 *   - Frames are written into a caller-supplied `frameDir` (the session inbox
 *     message dir) rather than v1's per-group `attachments/`. The host then
 *     appends synthetic `type:'image'` attachments pointing at them, so they
 *     flow through the container's existing `extractImageAttachments` vision
 *     rail with no per-harness branching. Same shape as v1's "frames ride the
 *     image rail" design.
 *   - The Gemini API key arrives via an injected `getCredential` reader (the
 *     submodule has no cybertron DB access), mirroring `transcribeAudio`. v1
 *     called `getPlatformCredential` directly from `@cybertron/core`.
 *
 * Returns transcript + visual summary + frame paths. Same shape as voice
 * transcription but two text outputs (transcript + summary) plus frames.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { log } from '../log.js';

import { MAX_IMAGE_DIMENSION } from './image-processing.js';
import { transcribeAudio, VOICE_TRANSCRIPTION_FAILED, VOICE_TRANSCRIPTION_UNAVAILABLE } from './transcription.js';

const execFileAsync = promisify(execFile);

export const VIDEO_PROCESSING_UNAVAILABLE = '[Video Message - processing unavailable]';
export const VIDEO_PROCESSING_FAILED = '[Video Message - processing failed]';

/** Gemini inline-data ceiling. Files API kicks in beyond this; we ffmpeg-
 *  downscale instead so we stay on the cheap inline path. */
const GEMINI_INLINE_BYTES_LIMIT = 18 * 1024 * 1024;

/** ffmpeg downscale targets a 720p H.264 re-encode at ~1Mbps which fits
 *  comfortably under the 18MB inline cap for clips up to ~2 min. Anything
 *  longer is rare in chat — we still try and emit FAILED if it's still too big. */
const DOWNSCALE_HEIGHT = 720;
const DOWNSCALE_VIDEO_BITRATE = '1000k';
const DOWNSCALE_AUDIO_BITRATE = '64k';
const TRANSCRIPTION_AUDIO_BITRATE = '48k';
const SILENCE_MEAN_VOLUME_DB = -55;
const DOWNSCALE_TOTAL_BITS_PER_SECOND = 1_064_000;

export type VideoTranscriptStatus = 'transcribed' | 'no_audio' | 'silent' | 'failed';

export interface ProcessVideoOpts {
  /** Directory the extracted keyframe JPEGs are written into. The caller is
   *  responsible for surfacing them to the container (e.g. as synthetic
   *  image attachments with a `localPath` relative to `/workspace`). */
  frameDir: string;
  /** Source MIME type for the Gemini call. Defaults to `video/mp4`. */
  mimeType?: string;
  /** Host-injected credential reader (provider → secret). Looked up for
   *  `gemini_api_key`. Without it (standalone NanoClaw) the env fallback in
   *  the reader, if any, applies; otherwise processing is skipped. Mirrors
   *  `transcribeAudio`'s `getCredential`. */
  getCredential?: (provider: string) => string | null | undefined;
}

export interface ProcessVideoFrame {
  /** Absolute path of the written frame JPEG. */
  absolutePath: string;
  /** Basename of the written frame JPEG. */
  filename: string;
}

export interface ProcessVideoResult {
  /** Spoken-content transcript. Empty string if the video has no speech. */
  transcript: string;
  /** Why `transcript` is populated or empty. Callers must use this instead
   *  of treating every empty string as proof that the video was silent. */
  transcriptStatus: VideoTranscriptStatus;
  /** Short visual summary covering the parts the frames can't show
   *  (motion, on-screen text changes, scene transitions). Always populated
   *  when Gemini succeeds. */
  summary: string;
  /** Extracted keyframes, in order (start → end). */
  frames: ProcessVideoFrame[];
  /** Source video duration, in seconds. */
  durationSeconds: number;
  /** True when the inline-data ceiling forced an ffmpeg downscale before the
   *  Gemini call. Mostly informational for logs. */
  downscaled: boolean;
}

/**
 * Pick N frame timestamps for a video of length D seconds.
 *
 * Tiered, not per-second: more static frames don't help the agent understand
 * a long tutorial — the visual summary carries the temporal information, and
 * each frame costs vision tokens downstream.
 */
export function pickFrameCount(durationSeconds: number): number {
  if (durationSeconds <= 10) return 2;
  if (durationSeconds <= 60) return 3;
  if (durationSeconds <= 180) return 5;
  if (durationSeconds <= 600) return 8;
  return 10;
}

export function pickFrameTimestamps(durationSeconds: number, count: number): number[] {
  if (count <= 0 || durationSeconds <= 0) return [];
  if (count === 1) return [durationSeconds / 2];
  // Spread evenly between 0 and durationSeconds inclusive of both ends.
  // For count=3 on a 60s clip that's [0, 30, 60] — but we offset away from
  // the absolute end (-0.1s) since ffmpeg seek-to-EOF can return blackness.
  const last = Math.max(0, durationSeconds - 0.1);
  const frames: number[] = [];
  for (let i = 0; i < count; i++) {
    frames.push((i * last) / (count - 1));
  }
  return frames;
}

export function canDownscaleFitGeminiInline(durationSeconds: number): boolean {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  const estimatedBytes = (durationSeconds * DOWNSCALE_TOTAL_BITS_PER_SECOND) / 8;
  return estimatedBytes <= GEMINI_INLINE_BYTES_LIMIT;
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return stdout.trim() === 'audio';
}

export function parseMeanVolumeDb(output: string): number | null {
  const match = /mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i.exec(output);
  if (!match) return null;
  if (match[1].toLowerCase() === '-inf') return Number.NEGATIVE_INFINITY;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

async function extractAudioForTranscription(inputPath: string): Promise<{
  bytes: Buffer;
  silent: boolean;
  path: string;
} | null> {
  const out = `${inputPath}.transcription.mp3`;
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      TRANSCRIPTION_AUDIO_BITRATE,
      out,
    ]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) return null;
    let silent = false;
    try {
      const { stderr } = await execFileAsync('ffmpeg', ['-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
      const meanVolume = parseMeanVolumeDb(stderr);
      silent = meanVolume !== null && meanVolume <= SILENCE_MEAN_VOLUME_DB;
    } catch {
      // Volume detection is diagnostic only. If it fails, attempt
      // transcription and conservatively report failure rather than silence.
    }
    return { bytes: fs.readFileSync(out), silent, path: out };
  } catch (err) {
    log.warn('video: audio extraction failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function extractFrame(inputPath: string, timestamp: number, outputPath: string): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      timestamp.toFixed(3),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
      '-q:v',
      '3',
      outputPath,
    ]);
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch (err) {
    log.warn('video: frame extraction failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function downscaleForGemini(inputPath: string): Promise<string | null> {
  const out = `${inputPath}.downscaled.mp4`;
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-vf',
      `scale=-2:'min(${DOWNSCALE_HEIGHT},ih)'`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      DOWNSCALE_VIDEO_BITRATE,
      '-c:a',
      'aac',
      '-b:a',
      DOWNSCALE_AUDIO_BITRATE,
      '-movflags',
      '+faststart',
      out,
    ]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) return null;
    return out;
  } catch (err) {
    log.warn('video: ffmpeg downscale failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface GeminiVideoOutput {
  transcript: string;
  summary: string;
}

/**
 * Parse Gemini's response into `{ transcript, summary }`. With
 * `responseSchema` the response is guaranteed-valid JSON, but this stays
 * defensive in two ways so a long transcript is never silently lost (the
 * failure that motivated the structured-output switch):
 *   1. strip stray ```json fences if a model/route ignores responseMimeType;
 *   2. if JSON.parse still throws, fall back to a lenient field extraction
 *      so we recover whatever transcript/summary text we can rather than
 *      returning null and dropping the whole analysis.
 */
export function parseGeminiVideoOutput(text: string): GeminiVideoOutput | null {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  if (!stripped) return null;

  try {
    const parsed = JSON.parse(stripped) as Partial<GeminiVideoOutput>;
    return {
      transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  } catch {
    // Lenient recovery: pull the first string value for each key. Matches a
    // JSON string literal (handling escaped quotes) so a malformed trailing
    // field can't lose a well-formed leading transcript.
    const grab = (key: string): string => {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(stripped);
      if (!m) return '';
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1];
      }
    };
    const transcript = grab('transcript');
    const summary = grab('summary');
    if (!transcript && !summary) return null;
    log.warn('video: Gemini output was not valid JSON, recovered fields', {
      recoveredTranscript: transcript.length,
      recoveredSummary: summary.length,
    });
    return { transcript, summary };
  }
}

async function analyseWithGemini(
  videoBytes: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<GeminiVideoOutput | null> {
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const genai = new GoogleGenAI({ apiKey });

    const result = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      // Force structured JSON output. Without this the model hand-writes a
      // JSON string, and a long transcript containing quotes/newlines
      // routinely produces malformed JSON that `JSON.parse` rejects —
      // observed live on a ~30-min interview clip where the whole
      // transcript was lost to a parse error. `responseSchema` makes the
      // API emit guaranteed-valid JSON for these two fields.
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            transcript: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['transcript', 'summary'],
        },
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: videoBytes.toString('base64'),
              },
            },
            {
              text:
                'You are processing a video shared in a chat. Return a JSON object with two keys:\n' +
                '  - "transcript": verbatim transcription of any spoken content (empty string if there is no speech)\n' +
                '  - "summary": a 1–3 sentence description of what is visually happening — motion, on-screen text changes, scene transitions, anything a few static frames would miss. Be specific, no preamble.',
            },
          ],
        },
      ],
    });

    const text = (result.text ?? '').trim();
    if (!text) return null;

    return parseGeminiVideoOutput(text);
  } catch (err) {
    log.error('video: Gemini analysis failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Build the `[Video: ...]` text marker. Format:
 *   - both → `[Video: <transcript> | Summary: <summary>]`
 *   - transcript only → `[Video: <transcript>]`
 *   - summary only → `[Video: Summary: <summary>]`
 *   - neither → `[Video: (no speech, no visual summary)]`
 */
export function formatVideoMarker(
  transcript: string,
  summary: string,
  transcriptStatus?: VideoTranscriptStatus,
): string {
  const t = transcript.trim();
  const s = summary.trim();
  if (t && s) return `[Video: ${t} | Summary: ${s}]`;
  if (t) return `[Video: ${t}]`;
  const audioOutcome =
    transcriptStatus === 'no_audio'
      ? 'no audio track'
      : transcriptStatus === 'silent'
        ? 'silent audio track'
        : transcriptStatus === 'failed'
          ? 'audio transcription failed'
          : '';
  if (audioOutcome && s) return `[Video: ${audioOutcome} | Summary: ${s}]`;
  if (audioOutcome) return `[Video: ${audioOutcome}]`;
  if (s) return `[Video: Summary: ${s}]`;
  return '[Video: (no speech, no visual summary)]';
}

/**
 * Process a video buffer end-to-end. Returns `null` when no Gemini API key
 * is configured or every step failed; callers should emit
 * VIDEO_PROCESSING_UNAVAILABLE / VIDEO_PROCESSING_FAILED in that case.
 *
 * The key comes from the injected `getCredential('gemini_api_key')` reader.
 */
export async function processVideo(videoBuffer: Buffer, opts: ProcessVideoOpts): Promise<ProcessVideoResult | null> {
  if (!videoBuffer || videoBuffer.length === 0) {
    log.warn('processVideo received empty buffer');
    return null;
  }

  let apiKey: string | null | undefined;
  try {
    apiKey = opts.getCredential?.('gemini_api_key');
  } catch (err) {
    log.warn('video: platform-credential reader threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    apiKey = undefined;
  }
  if (!apiKey) log.warn('Gemini API key not set — skipping joint video analysis');

  const mimeType = opts.mimeType ?? 'video/mp4';
  const tag = `${Date.now()}-${Math.round(videoBuffer.length % 1e6)
    .toString(36)
    .padStart(4, '0')}`;
  const tmpInput = path.join(opts.frameDir, `.video-${tag}.bin`);

  let downscaled = false;
  let bytesForGemini = videoBuffer;
  let mimeForGemini = mimeType;

  try {
    fs.mkdirSync(opts.frameDir, { recursive: true });
    fs.writeFileSync(tmpInput, videoBuffer);

    const durationSeconds = await probeDurationSeconds(tmpInput);
    if (durationSeconds <= 0) {
      log.warn('video: ffprobe could not determine duration, skipping', {
        bytes: videoBuffer.length,
      });
      return null;
    }

    // Frame extraction first — these are needed even if Gemini fails so the
    // agent has at least static visual context.
    const count = pickFrameCount(durationSeconds);
    const timestamps = pickFrameTimestamps(durationSeconds, count);
    const frames: ProcessVideoFrame[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const filename = `frame-${tag}-${i + 1}.jpg`;
      const filePath = path.join(opts.frameDir, filename);
      const ok = await extractFrame(tmpInput, timestamps[i], filePath);
      if (ok) frames.push({ absolutePath: filePath, filename });
    }

    // Downscale for Gemini if needed. Frames were already extracted from the
    // original (higher-quality source) above.
    if (videoBuffer.length > GEMINI_INLINE_BYTES_LIMIT) {
      const downscaledPath = canDownscaleFitGeminiInline(durationSeconds) ? await downscaleForGemini(tmpInput) : null;
      if (!downscaledPath && !canDownscaleFitGeminiInline(durationSeconds)) {
        log.warn('video: duration cannot fit Gemini inline limit after downscale, using audio-only fallback', {
          originalBytes: videoBuffer.length,
          durationSeconds,
        });
      }
      if (downscaledPath) {
        const downscaledBuf = fs.readFileSync(downscaledPath);
        if (downscaledBuf.length <= GEMINI_INLINE_BYTES_LIMIT) {
          bytesForGemini = downscaledBuf;
          mimeForGemini = 'video/mp4';
          downscaled = true;
        } else {
          log.warn('video: downscaled output still exceeds inline limit, dropping audio analysis', {
            originalBytes: videoBuffer.length,
            downscaledBytes: downscaledBuf.length,
          });
        }
        try {
          fs.rmSync(downscaledPath, { force: true });
        } catch {
          /* ignore */
        }
      }
    }

    let analysis: GeminiVideoOutput | null = null;
    if (apiKey && bytesForGemini.length <= GEMINI_INLINE_BYTES_LIMIT) {
      analysis = await analyseWithGemini(bytesForGemini, mimeForGemini, apiKey);
    }

    let transcript = analysis?.transcript.trim() ?? '';
    let transcriptStatus: VideoTranscriptStatus = transcript ? 'transcribed' : 'failed';
    let extractedAudioPath: string | null = null;
    if (!transcript) {
      const hasAudio = await hasAudioStream(tmpInput);
      if (!hasAudio) {
        transcriptStatus = 'no_audio';
      } else {
        const audio = await extractAudioForTranscription(tmpInput);
        extractedAudioPath = audio?.path ?? null;
        if (audio?.silent) {
          transcriptStatus = 'silent';
        } else if (audio) {
          const fallbackTranscript = await transcribeAudio(audio.bytes, {
            filename: 'video-audio.mp3',
            mimeType: 'audio/mpeg',
            // Long-form file transcription is OpenAI's dedicated use case.
            // transcribeAudio automatically falls back to Gemini when the
            // OpenAI credential is absent or the request fails.
            backend: 'openai',
            getCredential: opts.getCredential,
          });
          if (
            fallbackTranscript !== VOICE_TRANSCRIPTION_FAILED &&
            fallbackTranscript !== VOICE_TRANSCRIPTION_UNAVAILABLE
          ) {
            transcript = fallbackTranscript;
            transcriptStatus = 'transcribed';
          }
        }
      }
    }

    if (extractedAudioPath) {
      try {
        fs.rmSync(extractedAudioPath, { force: true });
      } catch {
        /* ignore */
      }
    }

    log.info('video: processed', {
      bytes: videoBuffer.length,
      durationSeconds,
      frames: frames.length,
      downscaled,
      hasAnalysis: !!analysis,
      transcriptStatus,
    });

    return {
      transcript,
      transcriptStatus,
      summary: analysis?.summary ?? '',
      frames,
      durationSeconds,
      downscaled,
    };
  } catch (err) {
    log.error('video: processVideo threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    try {
      fs.rmSync(tmpInput, { force: true });
    } catch {
      /* ignore */
    }
  }
}
