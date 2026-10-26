import { afterEach, expect, it } from 'vitest';

import { logId, setLogIdHasher } from './log-id.js';

afterEach(() => setLogIdHasher(undefined));

it('hashes ids by default: stable, 10 hex, never the raw value', () => {
  const jid = '15551234567@s.whatsapp.net';
  const a = logId(jid);
  expect(a).toMatch(/^[0-9a-f]{10}$/);
  expect(logId(jid)).toBe(a);
  expect(a).not.toContain('15551234567');
  expect(logId('whatsapp:' + jid)).not.toBe(a);
});

it('passes absence through', () => {
  expect(logId(undefined)).toBeUndefined();
  expect(logId(null)).toBeNull();
  expect(logId('')).toBe('');
});

it('uses the injected host hasher', () => {
  setLogIdHasher((raw) => `h${raw.length}`);
  expect(logId('abc@g.us')).toBe('h8');
});

it('never falls back to the raw id when the injected hasher misbehaves', () => {
  const raw = '15551234567@s.whatsapp.net';
  setLogIdHasher(() => {
    throw new Error('boom');
  });
  expect(logId(raw)).toMatch(/^[0-9a-f]{10}$/);
  setLogIdHasher((r) => r);
  expect(logId(raw)).toMatch(/^[0-9a-f]{10}$/);
  setLogIdHasher(() => '');
  expect(logId(raw)).toMatch(/^[0-9a-f]{10}$/);
});
