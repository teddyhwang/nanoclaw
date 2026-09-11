import { afterEach, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { loadConfiguredProvider } from './provider-plugins.js';
import { getProviderFactory, registerProvider, requireProviderName } from '../providers/provider-registry.js';
import { MockProvider } from '../providers/mock.js';

const dirs: string[] = [];
const originalManifest = process.env.NANOCLAW_PROVIDER_PLUGINS_MANIFEST;
afterEach(() => {
  if (originalManifest === undefined) delete process.env.NANOCLAW_PROVIDER_PLUGINS_MANIFEST;
  else process.env.NANOCLAW_PROVIDER_PLUGINS_MANIFEST = originalManifest;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('loads external factories before validating the configured provider', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-plugin-'));
  dirs.push(dir);
  const name = 'embedded-provider-load-order';
  const registry = pathToFileURL(path.resolve(import.meta.dir, '../providers/provider-registry.ts')).href;
  const mock = pathToFileURL(path.resolve(import.meta.dir, '../providers/mock.ts')).href;
  const entry = path.join(dir, 'provider.ts');
  fs.writeFileSync(
    entry,
    `import { registerProvider } from ${JSON.stringify(registry)};\nimport { MockProvider } from ${JSON.stringify(mock)};\nregisterProvider('${name}', options => new MockProvider(options));\n`,
  );
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ providers: [{ module: entry }] }));
  process.env.NANOCLAW_PROVIDER_PLUGINS_MANIFEST = manifest;
  expect(() => requireProviderName(name)).toThrow('Unknown provider');
  expect(await loadConfiguredProvider(name)).toBe(name);
  expect(getProviderFactory(name)({})).toBeInstanceOf(MockProvider);
});

it('keeps the persisted pi_rpc plugin ID while rejecting new underscore IDs', () => {
  registerProvider('pi_rpc', (options) => new MockProvider(options));
  expect(requireProviderName('pi_rpc')).toBe('pi_rpc');
  expect(() => registerProvider('new_snake_case', (options) => new MockProvider(options))).toThrow('kebab-case');
});
