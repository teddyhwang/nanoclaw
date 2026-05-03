/**
 * Credential provider abstraction.
 *
 * Container spawning currently constructs a OneCLI client directly inside
 * `container-runner.ts`. That hardcodes Optimus / multi-user installs to use
 * OneCLI even when they want a workspace vault, a per-user credential store,
 * or a plain `.env` flow.
 *
 * This module introduces a provider interface that the container-runner asks
 * for credentials by `(agentGroupId, userId, kind)`. The default
 * implementation calls OneCLI exactly the way the current code does, so
 * standalone v2 behavior is unchanged.
 */

export interface CredentialContext {
  agentGroupId: string;
  /** End-user identity, when known (sender or workspace member). */
  userId?: string | null;
  /** Kind hint — `'anthropic'`, `'openai'`, `'env'`, etc. */
  kind?: string;
}

export interface CredentialBundle {
  /** Env vars to inject into the spawned container. */
  env?: Record<string, string>;
  /** Optional gateway URL (e.g. OneCLI proxy). */
  gatewayUrl?: string;
}

export interface CredentialProvider {
  name: string;
  /**
   * Resolve credentials for a spawn. Return an empty object if the provider
   * has nothing to contribute — callers merge results, so a no-op provider
   * is fine.
   */
  resolve(ctx: CredentialContext): CredentialBundle | Promise<CredentialBundle>;
}

let _provider: CredentialProvider | null = null;

export function setCredentialProvider(p: CredentialProvider): void {
  _provider = p;
}

export function getCredentialProvider(): CredentialProvider | null {
  return _provider;
}

/** Test-only. */
export function _resetCredentialProviderForTests(): void {
  _provider = null;
}
