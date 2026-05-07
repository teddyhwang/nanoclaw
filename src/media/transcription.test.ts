import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { transcribeAudio, VOICE_TRANSCRIPTION_FAILED, VOICE_TRANSCRIPTION_UNAVAILABLE } from './transcription.js';

describe('transcribeAudio', () => {
  const origGemini = process.env.GEMINI_API_KEY;
  const origOpenAI = process.env.OPENAI_API_KEY;
  const origBackend = process.env.VOICE_TRANSCRIPTION_BACKEND;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOICE_TRANSCRIPTION_BACKEND;
  });

  afterEach(() => {
    process.env.GEMINI_API_KEY = origGemini;
    process.env.OPENAI_API_KEY = origOpenAI;
    process.env.VOICE_TRANSCRIPTION_BACKEND = origBackend;
    vi.restoreAllMocks();
  });

  it('returns FAILED on empty buffer', async () => {
    const out = await transcribeAudio(Buffer.alloc(0));
    expect(out).toBe(VOICE_TRANSCRIPTION_FAILED);
  });

  it('returns UNAVAILABLE when no keys are set', async () => {
    const out = await transcribeAudio(Buffer.from('audio-bytes'));
    expect(out).toBe(VOICE_TRANSCRIPTION_UNAVAILABLE);
  });

  it('falls back to openai when gemini key missing but openai present', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.VOICE_TRANSCRIPTION_BACKEND = 'gemini';
    vi.doMock('openai', () => ({
      default: class {
        audio = {
          transcriptions: {
            create: async () => 'mocked transcript',
          },
        };
        constructor(_: unknown) {}
      },
      toFile: async (b: Buffer) => b,
    }));
    const out = await transcribeAudio(Buffer.from('a'));
    expect(out).toBe('mocked transcript');
  });
});
