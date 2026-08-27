/**
 * Optimus fork patch — adds one column to `container_configs` that Optimus
 * uses but upstream does not. Kept as a fork-local migration to keep the
 * upstream-merge diff small (same isolation pattern as migration 016).
 *
 * `sensitive_gate_mode` — per-agent-group control for the sensitive-action
 * confirmation gate (Phase 5). A workspace owner/global-admin can mark a
 * trusted agent group `'off'` so its dashboard MCP tool calls are not gated.
 *
 *   - NULL / unset  ⇒ ENFORCE (fail-safe default — a security control that
 *     defaults to off is not a security control; an unset value must mean
 *     the gate is on).
 *   - 'enforce'     ⇒ gate runs normally (grant + policy + confirm card).
 *   - 'off'         ⇒ `decideSensitiveGate()` short-circuits to allow with
 *     reason `gate_disabled_by_admin` BEFORE policy. Logged loud on every
 *     bypass; never silent.
 *
 * The column is intentionally nullable with NO default: existing rows stay
 * NULL (⇒ enforce), and the read path (`gateMode()` in container-configs)
 * treats NULL/unknown as 'enforce'. Only a deliberate admin write sets
 * 'off'. Container-side `ncl` can never write this column (dispatch.ts
 * blocks it for `caller === 'agent'` regardless of cli_scope) — an injected
 * agent disabling its own gate is exactly the threat the gate exists to
 * stop.
 */
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'optimus-sensitive-gate-mode',
  async up(db) {
    await db.run('ALTER TABLE container_configs ADD COLUMN sensitive_gate_mode TEXT');
  },
};
