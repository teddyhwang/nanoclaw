import { describe, expect, it } from 'bun:test';

import { resolveClaudeMcpServers } from './claude-config.js';

describe('resolveClaudeMcpServers — per-server tool timeout', () => {
  it('passes a host-validated timeout straight through to the Claude SDK (ms)', () => {
    const { mcpServers } = resolveClaudeMcpServers(
      {
        slow: { type: 'http', url: 'http://host.docker.internal:3002/mcp/golfthe6ix/g', timeout: 600_000 },
        fast: { type: 'http', url: 'http://host.docker.internal:3002/mcp/tpl/g' },
      },
      {},
    );
    expect(mcpServers.slow).toEqual({
      type: 'http',
      url: 'http://host.docker.internal:3002/mcp/golfthe6ix/g',
      timeout: 600_000,
    });
    expect(mcpServers.fast).not.toHaveProperty('timeout');
  });
});
