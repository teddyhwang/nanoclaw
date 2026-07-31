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
    const create = vi.fn(async () => ({ text: 'mocked transcript' }));
    vi.doMock('openai', () => ({
      default: class {
        audio = {
          transcriptions: {
            create,
          },
        };
        constructor(_: unknown) {}
      },
      toFile: async (b: Buffer) => b,
    }));
    const out = await transcribeAudio(Buffer.from('a'));
    expect(out).toBe('mocked transcript');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-transcribe',
        response_format: 'json',
      }),
    );
  });

  it('retries with openai when gemini returns an empty transcript', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.VOICE_TRANSCRIPTION_BACKEND = 'gemini';
    vi.doMock('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContent: async () => ({ text: '' }),
        };
        constructor(_: unknown) {}
      },
    }));
    vi.doMock('openai', () => ({
      default: class {
        audio = {
          transcriptions: {
            create: async () => ({ text: 'fallback transcript' }),
          },
        };
        constructor(_: unknown) {}
      },
      toFile: async (b: Buffer) => b,
    }));

    const out = await transcribeAudio(Buffer.from('a'));
    expect(out).toBe('fallback transcript');
  });

  it('uses opts.getCredential before falling back to env (Optimus posture)', async () => {
    // No env keys — only the injected reader has one.
    vi.doMock('openai', () => ({
      default: class {
        audio = {
          transcriptions: {
            create: async () => ({ text: 'injected-cred transcript' }),
          },
        };
        constructor(_: unknown) {}
      },
      toFile: async (b: Buffer) => b,
    }));
    const out = await transcribeAudio(Buffer.from('a'), {
      backend: 'openai',
      getCredential: (provider) => (provider === 'openai_api_key' ? 'sk-from-cybertron' : null),
    });
    expect(out).toBe('injected-cred transcript');
  });

  it('returns UNAVAILABLE when injected reader has nothing and env is also empty', async () => {
    const out = await transcribeAudio(Buffer.from('a'), {
      getCredential: () => null,
    });
    expect(out).toBe(VOICE_TRANSCRIPTION_UNAVAILABLE);
  });

  it('does not crash when the injected reader throws — falls back to env', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-fallback';
    vi.doMock('openai', () => ({
      default: class {
        audio = {
          transcriptions: {
            create: async () => ({ text: 'env-fallback transcript' }),
          },
        };
        constructor(_: unknown) {}
      },
      toFile: async (b: Buffer) => b,
    }));
    const out = await transcribeAudio(Buffer.from('a'), {
      backend: 'openai',
      getCredential: () => {
        throw new Error('cybertron-db-down');
      },
    });
    expect(out).toBe('env-fallback transcript');
  });
});
