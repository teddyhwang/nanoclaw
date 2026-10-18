import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  gemini: vi.fn(),
  openai: vi.fn(),
}));
vi.mock('../log.js', () => ({ log: state }));
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: state.gemini };
  },
}));
vi.mock('openai', () => ({
  default: class {
    audio = { transcriptions: { create: state.openai } };
  },
  toFile: async (bytes: Buffer) => bytes,
}));
import { transcribeAudio, VOICE_TRANSCRIPTION_FAILED } from './transcription.js';
const marker = 'PRIVATE_TRANSCRIPT_AUDIO_API_KEY_MARKER';
const logs = () =>
  inspect([state.warn.mock.calls, state.error.mock.calls, state.info.mock.calls], { depth: 10, showHidden: true });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  state.gemini.mockRejectedValue(new Error(marker));
  state.openai.mockRejectedValue(
    Object.assign(new Error(marker), { request: { audio: marker }, response: { body: marker } }),
  );
});
afterEach(() => vi.unstubAllEnvs());
describe('private transcription failure logs', () => {
  it.each(['gemini', 'openai'] as const)('omits %s SDK payloads including fallback errors', async (backend) => {
    const result = await transcribeAudio(Buffer.from(marker), {
      backend,
      redactErrors: true,
      getCredential: () => 'fixture-key',
    });
    expect(result).toBe(VOICE_TRANSCRIPTION_FAILED);
    expect(state.gemini).toHaveBeenCalledOnce();
    expect(state.openai).toHaveBeenCalledOnce();
    expect(logs()).not.toContain(marker);
    expect(state.error).toHaveBeenCalled();
  });
  it('omits errors from credential readers before fallback', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
    const result = await transcribeAudio(Buffer.from(marker), {
      backend: 'openai',
      redactErrors: true,
      getCredential: () => {
        throw new Error(marker);
      },
    });
    expect(result).toBe(VOICE_TRANSCRIPTION_FAILED);
    expect(logs()).not.toContain(marker);
    expect(state.warn).toHaveBeenCalled();
  });
  it('preserves existing nonprivate diagnostics by default', async () => {
    await transcribeAudio(Buffer.from(marker), { backend: 'openai', getCredential: () => 'fixture-key' });
    expect(logs()).toContain(marker);
  });
});
