/**
 * Audio transcription. Channel-agnostic — callers supply a Buffer.
 * Ported from apps/nanoclaw/src/transcription.ts (v1 host).
 *
 * Submodule has no cybertron access, so credentials come from env only:
 * GEMINI_API_KEY, OPENAI_API_KEY. Backend selection via
 * VOICE_TRANSCRIPTION_BACKEND (gemini|openai), default gemini.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

export const VOICE_TRANSCRIPTION_UNAVAILABLE = '[Voice Message - transcription unavailable]';
export const VOICE_TRANSCRIPTION_FAILED = '[Voice Message - transcription failed]';

export type TranscriptionBackend = 'gemini' | 'openai';

interface TranscribeOpts {
  filename?: string;
  mimeType?: string;
  model?: string;
  backend?: TranscriptionBackend;
}

export async function transcribeAudio(audioBuffer: Buffer, opts: TranscribeOpts = {}): Promise<string> {
  if (!audioBuffer || audioBuffer.length === 0) {
    log.warn('transcribeAudio received empty buffer');
    return VOICE_TRANSCRIPTION_FAILED;
  }

  const env = readEnvFile(['VOICE_TRANSCRIPTION_BACKEND', 'GEMINI_API_KEY', 'OPENAI_API_KEY']);
  const geminiKey = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || undefined;
  const openaiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || undefined;

  const requested: TranscriptionBackend =
    opts.backend ?? (env.VOICE_TRANSCRIPTION_BACKEND === 'openai' ? 'openai' : 'gemini');

  const effective = resolveBackend(requested, { geminiKey, openaiKey });
  if (!effective) {
    log.warn('Neither GEMINI_API_KEY nor OPENAI_API_KEY set — skipping voice transcription');
    return VOICE_TRANSCRIPTION_UNAVAILABLE;
  }

  const mimeType = opts.mimeType ?? 'audio/ogg';

  if (effective === 'gemini') {
    return transcribeWithGemini(audioBuffer, {
      apiKey: geminiKey!,
      mimeType,
      model: opts.model ?? 'gemini-2.5-flash',
    });
  }

  return transcribeWithOpenAI(audioBuffer, {
    apiKey: openaiKey!,
    filename: opts.filename ?? 'voice.ogg',
    mimeType,
    model: opts.model ?? 'whisper-1',
  });
}

function resolveBackend(
  requested: TranscriptionBackend,
  keys: { geminiKey?: string; openaiKey?: string },
): TranscriptionBackend | null {
  const hasKey = (b: TranscriptionBackend) => (b === 'gemini' ? !!keys.geminiKey : !!keys.openaiKey);

  if (hasKey(requested)) return requested;

  const other: TranscriptionBackend = requested === 'gemini' ? 'openai' : 'gemini';
  if (hasKey(other)) {
    log.error(`Voice transcription backend "${requested}" has no API key — falling back to "${other}"`, {
      requested,
      fallback: other,
    });
    return other;
  }

  return null;
}

async function transcribeWithGemini(
  audioBuffer: Buffer,
  { apiKey, mimeType, model }: { apiKey: string; mimeType: string; model: string },
): Promise<string> {
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const genai = new GoogleGenAI({ apiKey });

    const result = await genai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBuffer.toString('base64'),
              },
            },
            {
              text: 'Transcribe the spoken audio verbatim. Output only the transcript text, no preamble or labels. If the audio has no speech, output an empty string.',
            },
          ],
        },
      ],
    });

    const text = (result.text ?? '').trim();
    log.info('Transcribed voice message', {
      backend: 'gemini',
      bytes: audioBuffer.length,
      chars: text.length,
    });
    return text || VOICE_TRANSCRIPTION_FAILED;
  } catch (err) {
    log.error('Gemini transcription failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return VOICE_TRANSCRIPTION_FAILED;
  }
}

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  { apiKey, filename, mimeType, model }: { apiKey: string; filename: string; mimeType: string; model: string },
): Promise<string> {
  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });
    const file = await toFile(audioBuffer, filename, { type: mimeType });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model,
      response_format: 'text',
    });

    const text = (transcription as unknown as string).trim();
    log.info('Transcribed voice message', {
      backend: 'openai',
      bytes: audioBuffer.length,
      chars: text.length,
    });
    return text || VOICE_TRANSCRIPTION_FAILED;
  } catch (err) {
    log.error('OpenAI transcription failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return VOICE_TRANSCRIPTION_FAILED;
  }
}
