/**
 * Unit tests for the pure helpers that pull mention + reply context out of
 * Baileys' message proto. These are factored out of the adapter callback so
 * the parsing logic can be tested without a live socket.
 */
import { describe, it, expect } from 'vitest';

import {
  extractWhatsAppContextInfo,
  extractWhatsAppReplyContext,
  hasWhatsAppTextMention,
  isWhatsAppBotMentioned,
  processInboundMediaBuffer,
} from './whatsapp.js';

describe('extractWhatsAppContextInfo', () => {
  it('returns null when the normalized envelope has no recognised message type', () => {
    expect(extractWhatsAppContextInfo(null)).toBeNull();
    expect(extractWhatsAppContextInfo({})).toBeNull();
    expect(extractWhatsAppContextInfo({ conversation: 'plain text' })).toBeNull();
  });

  it('pulls contextInfo from extendedTextMessage', () => {
    const ctx = { stanzaId: 'abc' };
    const out = extractWhatsAppContextInfo({ extendedTextMessage: { text: 'hi', contextInfo: ctx } });
    expect(out).toBe(ctx);
  });

  it('falls back to imageMessage / videoMessage for media-with-caption replies', () => {
    const ctx = { stanzaId: 'x' };
    expect(extractWhatsAppContextInfo({ imageMessage: { caption: 'hi', contextInfo: ctx } })).toBe(ctx);
    expect(extractWhatsAppContextInfo({ videoMessage: { caption: 'hi', contextInfo: ctx } })).toBe(ctx);
  });
});

describe('isWhatsAppBotMentioned', () => {
  it('returns false when contextInfo is null or has no mentionedJid', () => {
    expect(isWhatsAppBotMentioned(null, '123', '456')).toBe(false);
    expect(isWhatsAppBotMentioned({}, '123', '456')).toBe(false);
    expect(isWhatsAppBotMentioned({ mentionedJid: [] }, '123', '456')).toBe(false);
  });

  it('matches when the bot LID appears in mentionedJid', () => {
    const ctx = { mentionedJid: ['255593654804579@lid', '159867859914790@lid'] };
    expect(isWhatsAppBotMentioned(ctx, '159867859914790', '16479828334')).toBe(true);
  });

  it('matches when the bot phone JID appears in mentionedJid', () => {
    const ctx = { mentionedJid: ['16479828334@s.whatsapp.net'] };
    expect(isWhatsAppBotMentioned(ctx, '159867859914790', '16479828334')).toBe(true);
  });

  it('returns false when only non-bot participants are mentioned', () => {
    const ctx = { mentionedJid: ['255593654804579@lid', '178224113913906@lid'] };
    expect(isWhatsAppBotMentioned(ctx, '159867859914790', '16479828334')).toBe(false);
  });

  it('does not blow up on malformed entries', () => {
    const ctx = { mentionedJid: [null, 42, undefined, '159867859914790@lid'] };
    expect(isWhatsAppBotMentioned(ctx, '159867859914790', undefined)).toBe(true);
  });
});

describe('hasWhatsAppTextMention', () => {
  it('matches a literal @<name> mention case-insensitively', () => {
    expect(hasWhatsAppTextMention('@optimus look up my flight', 'Optimus')).toBe(true);
    expect(hasWhatsAppTextMention('hey @Optimus, what time?', 'Optimus')).toBe(true);
    expect(hasWhatsAppTextMention('@OPTIMUS', 'optimus')).toBe(true);
  });

  it('requires a word boundary after the name', () => {
    expect(hasWhatsAppTextMention('@optimusly', 'Optimus')).toBe(false);
    expect(hasWhatsAppTextMention('@optimus123', 'Optimus')).toBe(false);
  });

  it('does not match without the @ sigil', () => {
    expect(hasWhatsAppTextMention('hey optimus', 'Optimus')).toBe(false);
    expect(hasWhatsAppTextMention('optimus@example.com', 'Optimus')).toBe(false);
  });

  it('returns false on empty/missing inputs', () => {
    expect(hasWhatsAppTextMention('', 'Optimus')).toBe(false);
    expect(hasWhatsAppTextMention(undefined, 'Optimus')).toBe(false);
    expect(hasWhatsAppTextMention('@optimus', '')).toBe(false);
  });

  it('escapes regex metacharacters in the assistant name', () => {
    expect(hasWhatsAppTextMention('@C.AI hi', 'C.AI')).toBe(true);
    // The dot is escaped, so a different char in that slot does not match.
    expect(hasWhatsAppTextMention('@CXAI hi', 'C.AI')).toBe(false);
  });
});

describe('extractWhatsAppReplyContext', () => {
  it('returns null when contextInfo is null or has no stanzaId', () => {
    expect(extractWhatsAppReplyContext(null)).toBeNull();
    expect(extractWhatsAppReplyContext({})).toBeNull();
    expect(extractWhatsAppReplyContext({ stanzaId: '' })).toBeNull();
  });

  it('returns shape { text, sender, messageId } from a plain quoted text reply', () => {
    const ctx = {
      stanzaId: 'wa-msg-1',
      participant: '159867859914790@lid',
      quotedMessage: { conversation: 'original text' },
    };
    expect(extractWhatsAppReplyContext(ctx)).toEqual({
      text: 'original text',
      sender: '159867859914790@lid',
      messageId: 'wa-msg-1',
    });
  });

  it('extracts text from extendedTextMessage when conversation is absent', () => {
    const ctx = {
      stanzaId: 'wa-msg-2',
      participant: '255593654804579@lid',
      quotedMessage: { extendedTextMessage: { text: 'extended text' } },
    };
    expect(extractWhatsAppReplyContext(ctx)?.text).toBe('extended text');
  });

  it('extracts caption from quoted image/video', () => {
    const imgCtx = {
      stanzaId: 'wa-img',
      participant: 'p@lid',
      quotedMessage: { imageMessage: { caption: 'pic caption' } },
    };
    const vidCtx = {
      stanzaId: 'wa-vid',
      participant: 'p@lid',
      quotedMessage: { videoMessage: { caption: 'video caption' } },
    };
    expect(extractWhatsAppReplyContext(imgCtx)?.text).toBe('pic caption');
    expect(extractWhatsAppReplyContext(vidCtx)?.text).toBe('video caption');
  });

  it('defaults text to empty string when no recognisable body in quotedMessage', () => {
    const ctx = { stanzaId: 'wa-empty', participant: 'p@lid', quotedMessage: {} };
    expect(extractWhatsAppReplyContext(ctx)).toEqual({
      text: '',
      sender: 'p@lid',
      messageId: 'wa-empty',
    });
  });
});

describe('processInboundMediaBuffer', () => {
  // Identity stubs — no-op resize, no-op transcode-needed predicate.
  // Lets us assert the steady-state pipeline shape without spinning up
  // sharp/ffmpeg.
  const passthroughDeps = {
    maybeResizeImage: async (buffer: Buffer) => buffer,
    shouldTranscodeAnimated: () => false,
    maybeTranscodeAnimated: async () => ({ ok: false }),
  };

  it('emits base64 data + the source filename + mimeType on a static image', async () => {
    const buffer = Buffer.from('binary-image-bytes');
    const result = await processInboundMediaBuffer(buffer, 'image', 'image/jpeg', 'photo.jpg', passthroughDeps);
    expect(result).toEqual({
      type: 'image',
      name: 'photo.jpg',
      data: buffer.toString('base64'),
      mimeType: 'image/jpeg',
    });
  });

  it('omits mimeType when the source had none (documentMessage with no mime)', async () => {
    const buffer = Buffer.from('# Markdown report\n\nbody');
    const result = await processInboundMediaBuffer(buffer, 'document', undefined, 'notes-2026-05.md', passthroughDeps);
    expect(result?.type).toBe('document');
    expect(result?.name).toBe('notes-2026-05.md');
    expect(result?.mimeType).toBeUndefined();
    expect(result?.data).toBe(buffer.toString('base64'));
  });

  it('routes images through resize before base64-encoding', async () => {
    const original = Buffer.from('huge-original');
    const resized = Buffer.from('tiny');
    const calls: Array<{ buffer: Buffer; mimeType: string | undefined }> = [];
    const result = await processInboundMediaBuffer(original, 'image', 'image/jpeg', 'big.jpg', {
      maybeResizeImage: async (buffer, mimeType) => {
        calls.push({ buffer, mimeType });
        return resized;
      },
      shouldTranscodeAnimated: () => false,
      maybeTranscodeAnimated: async () => ({ ok: false }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ buffer: original, mimeType: 'image/jpeg' });
    expect(result?.data).toBe(resized.toString('base64'));
  });

  it('skips resize for non-image types', async () => {
    const buffer = Buffer.from('audio-bytes');
    let resizeCalled = false;
    await processInboundMediaBuffer(buffer, 'audio', 'audio/ogg', 'voice.ogg', {
      ...passthroughDeps,
      maybeResizeImage: async (b) => {
        resizeCalled = true;
        return b;
      },
    });
    expect(resizeCalled).toBe(false);
  });

  it('transcodes animated content and rewrites type+mimeType on success', async () => {
    const inputMp4 = Buffer.from('animated-mp4');
    const outputGif = Buffer.from('static-gif');
    const result = await processInboundMediaBuffer(inputMp4, 'video', 'video/mp4', 'tenor.mp4', {
      maybeResizeImage: async (b) => b,
      shouldTranscodeAnimated: () => true,
      maybeTranscodeAnimated: async () => ({
        ok: true,
        buffer: outputGif,
        mimeType: 'image/gif',
      }),
    });
    expect(result).toEqual({
      type: 'image',
      name: 'tenor.mp4',
      data: outputGif.toString('base64'),
      mimeType: 'image/gif',
    });
  });

  it('returns null when animated transcode fails — caller drops the attachment', async () => {
    const input = Buffer.from('oversize-gif');
    const result = await processInboundMediaBuffer(input, 'image', 'image/gif', 'big.gif', {
      maybeResizeImage: async (b) => b,
      shouldTranscodeAnimated: () => true,
      maybeTranscodeAnimated: async () => ({ ok: false, reason: 'ffmpeg-missing' }),
    });
    expect(result).toBeNull();
  });

  it('never emits a localPath field (regression guard for the pre-fix flat-dir shape)', async () => {
    const buffer = Buffer.from('any-bytes');
    const result = await processInboundMediaBuffer(buffer, 'image', 'image/png', 'x.png', passthroughDeps);
    expect(result).not.toHaveProperty('localPath');
  });
});
