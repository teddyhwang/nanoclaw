/**
 * Platform-credential reader injection.
 *
 * The engine needs to call host-side APIs (currently: voice transcription
 * via Gemini/OpenAI) at request-handling time, but the submodule has no
 * access to a cybertron-backed credential store — only env vars. Standalone
 * NanoClaw works with env-only; Optimus stores keys in `platform_credentials`
 * (cybertron.db) and wants the engine to read them through.
 *
 * This module exposes a single-slot reader that the host injects at boot:
 *
 *   import { setPlatformCredentialReader } from 'nanoclaw/engine';
 *   setPlatformCredentialReader((provider) => readFromCybertron(provider));
 *
 * Engine callers (today: `session-manager.extractAttachmentFiles`'s
 * transcription pass via `media/transcription.ts:transcribeAudio`) call
 * `getPlatformCredentialReader()` and pass the result through as the
 * `getCredential` option. The transcribeAudio helper checks the reader
 * first, then falls back to env. Both surfaces are no-op-safe when the
 * reader is unset (standalone runs).
 *
 * Shape mirrors `apps/optimus/src/util/transcription.ts:VoiceTranscriptionContext.getCredential`
 * — a sync `(provider: string) => string | null` callback. Sync because
 * the cybertron-backed reader is a synchronous DB lookup; making it
 * async would force every transcribe call to await it twice (once for
 * the key, once for the API). Hosts that need async credential
 * resolution can prefetch + cache and return the cached value sync.
 */

export type PlatformCredentialReader = (provider: string) => string | null | undefined;

let _reader: PlatformCredentialReader | null = null;

export function setPlatformCredentialReader(reader: PlatformCredentialReader): void {
  _reader = reader;
}

export function getPlatformCredentialReader(): PlatformCredentialReader | null {
  return _reader;
}

/** Test-only. */
export function _resetPlatformCredentialReaderForTests(): void {
  _reader = null;
}
