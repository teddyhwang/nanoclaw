import { beforeEach } from 'vitest';

beforeEach(async () => {
  await import('./mailbox/compose.js');

  // Upstream registry payloads isolate their filesystem through vi.mock(config).
  // The embedded fork also resolves paths through the engine registry. Align
  // those test-only fallback roots, without changing production path precedence
  // or replacing a host's workspace-aware resolver. Import inside the hook so
  // each test file's hoisted mocks have already been registered.
  const config = await import('./config.js');
  const { setEnginePaths } = await import('./engine/paths.js');
  setEnginePaths({
    ...('DATA_DIR' in config ? { dataDir: config.DATA_DIR } : {}),
    ...('GROUPS_DIR' in config ? { groupsDir: config.GROUPS_DIR } : {}),
  });
});
