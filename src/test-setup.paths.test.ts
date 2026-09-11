import { afterEach, expect, it, vi } from 'vitest';
import { _resetEnginePathsForTests, getEnginePaths, resolveGroupDir, setEnginePaths } from './engine/paths.js';

// Registry payloads mock core's public config, not Optimus's internal path
// registry. Their fixture directories must own every write in the test.
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/registry-path-fixture/data',
  GROUPS_DIR: '/tmp/registry-path-fixture/groups',
}));

afterEach(_resetEnginePathsForTests);

it('aligns engine fallback paths with the test config before each test', () => {
  expect(getEnginePaths().dataDir).toBe('/tmp/registry-path-fixture/data');
  expect(resolveGroupDir({ id: 'agent', folder: 'sample' })).toBe('/tmp/registry-path-fixture/groups/sample');
});

it('does not replace a workspace-aware group resolver with the flat fixture path', () => {
  setEnginePaths({ groupDirResolver: (group) => `/tmp/registry-path-fixture/groups/workspace/${group.folder}` });
  expect(resolveGroupDir({ id: 'agent', folder: 'sample' })).toBe('/tmp/registry-path-fixture/groups/workspace/sample');
});
