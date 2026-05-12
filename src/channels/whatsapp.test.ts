/**
 * Unit tests for the pure helpers that pull mention + reply context out of
 * Baileys' message proto. These are factored out of the adapter callback so
 * the parsing logic can be tested without a live socket.
 */
import { describe, it, expect } from 'vitest';

import { extractWhatsAppContextInfo, extractWhatsAppReplyContext, isWhatsAppBotMentioned } from './whatsapp.js';

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
