import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });

  it('teaches both <internal> as the private channel AND that unwrapped text is not delivered', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    // <internal> is presented as a hard guarantee, not a soft suggestion.
    expect(prompt).toContain('<internal>...</internal>');
    expect(prompt).toContain('stripped before delivery');
    expect(prompt).toContain('scratchpad');
    expect(prompt).toContain('NOT delivered to any chat');
    expect(prompt).toContain('retry with proper wrapping');
    expect(prompt).not.toContain('[degraded]');
  });
});

describe('buildSystemPromptAddendum — runtime model identity', () => {
  it('states the resolved model + provider as ground truth', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    const prompt = buildSystemPromptAddendum('Casa', {
      provider: 'codex',
      model: 'gpt-5.5',
    });
    expect(prompt).toContain('# Your runtime');
    expect(prompt).toContain('`gpt-5.5` (via the codex provider)');
    // Explicitly told not to hedge — the exact behavior that produced
    // the "I can't honestly say the exact underlying model" reply.
    expect(prompt).toContain('do not hedge, speculate, or claim you cannot tell');
  });

  it('handles model with no provider', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    const prompt = buildSystemPromptAddendum('Casa', { model: 'claude-opus-4-7' });
    expect(prompt).toContain('You are running on `claude-opus-4-7`.');
  });

  it('falls back to provider-only when the model id is unknown', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    const prompt = buildSystemPromptAddendum('Casa', { provider: 'codex' });
    expect(prompt).toContain('the codex provider (exact model id not surfaced');
  });

  it('omits the runtime section entirely when nothing is resolved', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    expect(buildSystemPromptAddendum('Casa')).not.toContain('# Your runtime');
    expect(buildSystemPromptAddendum('Casa', { provider: '', model: '' })).not.toContain('# Your runtime');
  });
});
