/**
 * Phase 2 — per-integration classification registry + multiplexer arg
 * predicates.
 *
 * Pure: exercises classifyGoogleCall / classifyLunchMoneyCall /
 * classifyTool / evaluatePolicy directly (no DB, no engine). Asserts the
 * three locked policy outcomes against the REAL registered tool surface
 * of all 6 dashboard MCP routes (enumerated 2026-05-17):
 *   rule 1  write|destructive          → require_confirmation (ANY chat)
 *   rule 2  read & pii & publicChannel → require_confirmation (public only)
 *   rule 3  read non-pii / read pii in a 1:1 → allow
 * plus: unmapped tool stays fail-closed; predicates are fail-safe
 * (never silent-read a mutating/novel/unparseable verb).
 */
import { describe, expect, it } from 'vitest';

import {
  classifyGoogleCall,
  classifyLunchMoneyCall,
  classifyTool,
  evaluatePolicy,
  CLASSIFICATION_REGISTRY,
  type PolicyDecision,
} from './sensitive-gate.js';

const CONFIRM: PolicyDecision = 'require_confirmation';
const ALLOW: PolicyDecision = 'allow';

function decide(integration: string, tool: string, args: unknown, isPublicChannel: boolean): PolicyDecision {
  return evaluatePolicy({ integration, tool, args, isPublicChannel });
}

describe('classifyGoogleCall (fail-safe verb predicate)', () => {
  it('known read verbs → read', () => {
    for (const m of ['get', 'list', 'search', 'GET', 'List', 'aggregatedList', 'watch', 'export']) {
      expect(classifyGoogleCall({ service: 'gmail', resource: 'users messages', method: m })).toBe('read');
    }
  });
  it('delete → destructive', () => {
    expect(classifyGoogleCall({ service: 'drive', resource: 'files', method: 'delete' })).toBe('destructive');
  });
  it('mutating verbs → write', () => {
    for (const m of ['insert', 'create', 'update', 'patch', 'batchUpdate', 'send', 'copy']) {
      expect(classifyGoogleCall({ service: 'drive', resource: 'files', method: m })).toBe('write');
    }
  });
  it('the headline public-share (drive.permissions.create, type anyone) → write (gated any chat)', () => {
    const args = {
      service: 'drive',
      resource: 'permissions',
      method: 'create',
      body: '{"type":"anyone","role":"reader"}',
    };
    expect(classifyGoogleCall(args)).toBe('write');
    expect(decide('google', 'google_call', args, /* private */ false)).toBe(CONFIRM);
  });
  it('novel / missing / non-object / non-string method → write (never silent-read)', () => {
    expect(classifyGoogleCall({ service: 'x', resource: 'y', method: 'frobnicate' })).toBe('write');
    expect(classifyGoogleCall({ service: 'x', resource: 'y' })).toBe('write');
    expect(classifyGoogleCall({ method: 123 })).toBe('write');
    expect(classifyGoogleCall(null)).toBe('write');
    expect(classifyGoogleCall('not-an-object')).toBe('write');
  });
});

describe('classifyLunchMoneyCall (HTTP-method predicate)', () => {
  it('GET → read; DELETE → destructive; POST/PUT/unknown/unparseable → write', () => {
    expect(classifyLunchMoneyCall({ method: 'GET' })).toBe('read');
    expect(classifyLunchMoneyCall({ method: 'get' })).toBe('read');
    expect(classifyLunchMoneyCall({ method: 'DELETE' })).toBe('destructive');
    expect(classifyLunchMoneyCall({ method: 'POST' })).toBe('write');
    expect(classifyLunchMoneyCall({ method: 'PUT' })).toBe('write');
    expect(classifyLunchMoneyCall({ method: 'PATCH' })).toBe('write');
    expect(classifyLunchMoneyCall({})).toBe('write');
    expect(classifyLunchMoneyCall(null)).toBe('write');
  });
});

describe('google integration policy', () => {
  it('google_call read (GET) — PII: allow in 1:1, confirm in public', () => {
    const a = { service: 'gmail', resource: 'users messages', method: 'list' };
    expect(decide('google', 'google_call', a, false)).toBe(ALLOW);
    expect(decide('google', 'google_call', a, true)).toBe(CONFIRM);
  });
  it('google_call write — confirm in ANY chat', () => {
    const a = { service: 'calendar', resource: 'events', method: 'insert' };
    expect(decide('google', 'google_call', a, false)).toBe(CONFIRM);
    expect(decide('google', 'google_call', a, true)).toBe(CONFIRM);
  });
  it('google_schema / google_capabilities — non-PII read, always allow', () => {
    expect(decide('google', 'google_schema', {}, true)).toBe(ALLOW);
    expect(decide('google', 'google_capabilities', {}, true)).toBe(ALLOW);
  });
  it('google_workspace_members — PII read (names+emails), confirm public only', () => {
    expect(decide('google', 'google_workspace_members', {}, false)).toBe(ALLOW);
    expect(decide('google', 'google_workspace_members', {}, true)).toBe(CONFIRM);
  });
});

describe('lunchmoney integration policy', () => {
  it('GET = financial PII read (public-only); POST = write (any); DELETE = destructive (any)', () => {
    expect(decide('lunchmoney', 'lunchmoney_call', { method: 'GET' }, false)).toBe(ALLOW);
    expect(decide('lunchmoney', 'lunchmoney_call', { method: 'GET' }, true)).toBe(CONFIRM);
    expect(decide('lunchmoney', 'lunchmoney_call', { method: 'POST' }, false)).toBe(CONFIRM);
    expect(decide('lunchmoney', 'lunchmoney_call', { method: 'DELETE' }, false)).toBe(CONFIRM);
  });
  it('lunchmoney_workspace_members — PII read, public only', () => {
    expect(decide('lunchmoney', 'lunchmoney_workspace_members', {}, false)).toBe(ALLOW);
    expect(decide('lunchmoney', 'lunchmoney_workspace_members', {}, true)).toBe(CONFIRM);
  });
});

describe('ixact integration policy', () => {
  it('contact/task reads = PII (public-only)', () => {
    for (const t of ['ixact_search_contacts', 'ixact_get_contact', 'ixact_get_today_tasks', 'ixact_get_task']) {
      expect(decide('ixact', t, {}, false)).toBe(ALLOW);
      expect(decide('ixact', t, {}, true)).toBe(CONFIRM);
    }
  });
  it('all mutations = write (confirm ANY chat)', () => {
    for (const t of [
      'ixact_create_contact',
      'ixact_update_contact',
      'ixact_add_follow_up',
      'ixact_create_task',
      'ixact_update_task',
    ]) {
      expect(decide('ixact', t, {}, false)).toBe(CONFIRM);
      expect(decide('ixact', t, {}, true)).toBe(CONFIRM);
    }
  });
  it('ixact_workspace_members = PII read, public only', () => {
    expect(decide('ixact', 'ixact_workspace_members', {}, false)).toBe(ALLOW);
    expect(decide('ixact', 'ixact_workspace_members', {}, true)).toBe(CONFIRM);
  });
});

describe('opentable integration policy', () => {
  it('public restaurant reads → always allow', () => {
    for (const t of ['opentable_search', 'opentable_availability', 'opentable_restaurant']) {
      expect(decide('opentable', t, {}, true)).toBe(ALLOW);
    }
  });
  it('opentable_reservations = personal PII read (public-only)', () => {
    expect(decide('opentable', 'opentable_reservations', {}, false)).toBe(ALLOW);
    expect(decide('opentable', 'opentable_reservations', {}, true)).toBe(CONFIRM);
  });
  it('book = write (any), cancel = destructive (any)', () => {
    expect(decide('opentable', 'opentable_book', {}, false)).toBe(CONFIRM);
    expect(decide('opentable', 'opentable_cancel', {}, false)).toBe(CONFIRM);
  });
});

describe('resy integration policy', () => {
  it('public restaurant reads → always allow', () => {
    for (const t of ['resy_search', 'resy_availability', 'resy_venue']) {
      expect(decide('resy', t, {}, true)).toBe(ALLOW);
    }
  });
  it('resy_reservations = personal PII read (public-only)', () => {
    expect(decide('resy', 'resy_reservations', {}, false)).toBe(ALLOW);
    expect(decide('resy', 'resy_reservations', {}, true)).toBe(CONFIRM);
  });
  it('book = write (any), cancel = destructive (any)', () => {
    expect(decide('resy', 'resy_book', {}, false)).toBe(CONFIRM);
    expect(decide('resy', 'resy_cancel', {}, false)).toBe(CONFIRM);
  });
  it('resy_workspace_members = PII read, public only', () => {
    expect(decide('resy', 'resy_workspace_members', {}, false)).toBe(ALLOW);
    expect(decide('resy', 'resy_workspace_members', {}, true)).toBe(CONFIRM);
  });
});

describe('housesigma + realtorca — all public reads → always allow (except members)', () => {
  it('housesigma listing reads allow even in public', () => {
    for (const t of [
      'housesigma_search_map',
      'housesigma_listing_preview',
      'housesigma_address_suggest',
      'housesigma_listing_detail',
    ]) {
      expect(decide('housesigma', t, {}, true)).toBe(ALLOW);
    }
  });
  it('housesigma_workspace_members = PII read, public only', () => {
    expect(decide('housesigma', 'housesigma_workspace_members', {}, true)).toBe(CONFIRM);
    expect(decide('housesigma', 'housesigma_workspace_members', {}, false)).toBe(ALLOW);
  });
  it('realtorca search/suggest allow even in public', () => {
    expect(decide('realtorca', 'realtorca_location_suggest', {}, true)).toBe(ALLOW);
    expect(decide('realtorca', 'realtorca_search', {}, true)).toBe(ALLOW);
  });
});

describe('unmapped tools stay fail-closed (Phase 2 did not weaken the default)', () => {
  it('an unknown tool in a known integration → require_confirmation', () => {
    expect(decide('google', 'google_some_future_tool', {}, false)).toBe(CONFIRM);
    expect(classifyTool('google', 'google_some_future_tool', {})).toBeNull();
  });
  it('an unknown integration → require_confirmation', () => {
    expect(decide('stripe', 'charge', {}, false)).toBe(CONFIRM);
  });
  it('every registered read-pii entry actually carries pii:true (guards against a typo silently un-gating)', () => {
    // Sanity sweep: nothing classified `read` without an explicit pii
    // decision — a missing pii on a sensitive read would silently allow
    // it in public. Public/reference reads are pii:false|undefined by
    // intent; this asserts the *shape* is deliberate, not that every
    // read is pii.
    for (const [integration, tools] of Object.entries(CLASSIFICATION_REGISTRY)) {
      for (const [tool, cls] of Object.entries(tools)) {
        if (tool.endsWith('_workspace_members')) {
          expect(cls).toMatchObject({ classification: 'read', pii: true });
        }
        expect(['read', 'write', 'destructive']).toContain(cls.classification);
      }
      expect(integration).toMatch(/^[a-z]+$/);
    }
  });
});
