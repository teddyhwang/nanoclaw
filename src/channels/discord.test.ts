/**
 * discord channel adapter — unit tests for outbound text transforms.
 * Adapter wiring (createDiscordAdapter etc.) is not exercised here; that
 * lives in the integration suite. Test only the pure helpers.
 */
import { describe, expect, it } from 'vitest';

import { collapseRedundantMarkdownLinks } from './discord.js';

describe('collapseRedundantMarkdownLinks', () => {
  it('collapses [url](url) where label equals href', () => {
    const out = collapseRedundantMarkdownLinks(
      'See [https://status.claude.com/x](https://status.claude.com/x) for details.',
    );
    expect(out).toBe('See https://status.claude.com/x for details.');
  });

  it('collapses with whitespace inside the label', () => {
    const out = collapseRedundantMarkdownLinks(
      '[ https://example.com ](https://example.com)',
    );
    expect(out).toBe('https://example.com');
  });

  it('collapses <url>-suppressor wrapping when label/href match modulo wrappers', () => {
    const out = collapseRedundantMarkdownLinks(
      '[<https://example.com>](<https://example.com>)',
    );
    expect(out).toBe('<https://example.com>');
  });

  it('leaves [different label](url) alone — that markdown carries info', () => {
    const out = collapseRedundantMarkdownLinks(
      'Open the [status page](https://status.claude.com).',
    );
    expect(out).toBe('Open the [status page](https://status.claude.com).');
  });

  it('collapses multiple occurrences in a single message', () => {
    const out = collapseRedundantMarkdownLinks(
      'a [https://a.com](https://a.com) b [https://b.com](https://b.com)',
    );
    expect(out).toBe('a https://a.com b https://b.com');
  });

  it('is a no-op on text without markdown links', () => {
    const out = collapseRedundantMarkdownLinks(
      'Plain text with a bare https://x.com URL.',
    );
    expect(out).toBe('Plain text with a bare https://x.com URL.');
  });

  it('is idempotent', () => {
    const input =
      'See [https://example.com](https://example.com) and [docs](https://example.com/docs).';
    const once = collapseRedundantMarkdownLinks(input);
    const twice = collapseRedundantMarkdownLinks(once);
    expect(twice).toBe(once);
  });

  it('does not collapse if href has trailing punctuation that label lacks', () => {
    // Label `https://x.com` ≠ href `https://x.com/`. Conservative — leave as-is
    // rather than guess which form the user wanted.
    const out = collapseRedundantMarkdownLinks(
      '[https://x.com](https://x.com/)',
    );
    expect(out).toBe('[https://x.com](https://x.com/)');
  });
});
