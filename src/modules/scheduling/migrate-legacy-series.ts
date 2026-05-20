/**
 * One-time, idempotent migration: legacy per-session inbound.db task
 * series → agent-group-scoped schedule.db.
 *
 * Before the S405 structural fix a recurring task SERIES lived as a
 * `messages_in` row (kind='task', recurrence IS NOT NULL) inside whatever
 * session's inbound.db happened to be active when it was last seeded, and
 * a `.recurring-carryover.json` sidecar rescued series whose inbound.db
 * was about to be deleted by clear-session. The schedule now lives in
 * `<sessionsBaseDir>/<agentGroupId>/schedule.db` (host-only). Existing
 * deployments have live series stranded in the old locations; this
 * imports them once so nothing stops firing across the cutover.
 *
 * Idempotent by construction:
 *  - `hasSeries(scheduleDb, seriesId)` gate: a series already in
 *    schedule.db (because actions.ts wrote it post-cutover, or a prior
 *    migration run imported it) is never re-imported, so an operator
 *    edit / cancel made after cutover is never clobbered by a stale
 *    inbound.db row.
 *  - Re-running scans the same sources and finds everything already
 *    present → no-ops.
 *
 * Read-only against inbound.db (open `{ readonly: true }`), so it cannot
 * trigger the very torn-write race the whole change removes. Per-source
 * failures are logged and skipped — a single unreadable inbound.db must
 * not abort the migration or boot.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { hasSeries, openScheduleDbAt } from './schedule-store.js';

const RESERVED_PREFIXES = ['rotate-', 'reflection-'];

/**
 * `dream-<ag>` is intentionally NOT reserved here: the dream series is a
 * real recurring series that must survive the cutover (maintenance-task
 * re-seeds it into schedule.db going forward, but an existing one only
 * lives in an old inbound.db until then). `rotate-`/`reflection-` are
 * transient one-shots that should not be resurrected as series.
 *
 * `dream-<other-ag>` rows ARE rejected: a merge that absorbs another
 * agent group's session dirs (e.g. discord_degenerates pulling in AI
 * Friends + Boys Night) leaves inbound.dbs whose dream rows carry the
 * pre-merge ag in the series_id. Migrating those into the post-merge
 * schedule.db produced orphan duplicates that surfaced as multiple
 * "agent-wide scheduled tasks" rows in the dashboard. The dream series
 * for the post-merge ag is re-seeded by maintenance-task on host boot,
 * so dropping the pre-merge ones here loses nothing.
 */
function shouldMigrate(seriesId: string, agentGroupId: string): boolean {
  if (!seriesId) return false;
  if (RESERVED_PREFIXES.some((p) => seriesId.startsWith(p))) return false;
  if (seriesId.startsWith('dream-') && seriesId !== `dream-${agentGroupId}`) {
    return false;
  }
  return true;
}

interface LegacySeries {
  series_id: string;
  status: string;
  recurrence: string | null;
  process_after: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  // Ordering key to pick the freshest row per series across many
  // inbound.dbs / the sidecar. inbound.db rows use messages_in.timestamp;
  // sidecar entries carry their own `timestamp`.
  _ts: string;
}

function collectFromInboundDb(dbPath: string): LegacySeries[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT series_id, status, recurrence, process_after, content,
                platform_id, channel_type, thread_id,
                COALESCE(timestamp, '') AS _ts
           FROM messages_in
          WHERE kind = 'task'
            AND recurrence IS NOT NULL
            AND series_id IS NOT NULL
            AND status IN ('pending', 'paused')`,
      )
      .all() as LegacySeries[];
  } finally {
    db.close();
  }
}

function collectFromSidecar(sidecarPath: string): LegacySeries[] {
  if (!fs.existsSync(sidecarPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const out: LegacySeries[] = [];
  for (const row of Object.values(parsed as Record<string, Record<string, unknown>>)) {
    const seriesId = typeof row.series_id === 'string' ? row.series_id : '';
    const recurrence = typeof row.recurrence === 'string' ? row.recurrence : null;
    const content = typeof row.content === 'string' ? row.content : null;
    if (!seriesId || !recurrence || !content) continue;
    out.push({
      series_id: seriesId,
      // Sidecars predate a typed status — historical default is 'pending'.
      status: typeof row.status === 'string' ? row.status : 'pending',
      recurrence,
      process_after: typeof row.process_after === 'string' ? row.process_after : null,
      content,
      platform_id: typeof row.platform_id === 'string' ? row.platform_id : null,
      channel_type: typeof row.channel_type === 'string' ? row.channel_type : null,
      thread_id: typeof row.thread_id === 'string' ? row.thread_id : null,
      _ts: typeof row.timestamp === 'string' ? row.timestamp : '',
    });
  }
  return out;
}

/**
 * Migrate one agent group's legacy series into its schedule.db. Returns
 * the count imported. Exposed for the test; `migrateLegacySeries` drives
 * it across every agent group dir.
 */
export function migrateAgentGroup(agentGroupId: string, agentGroupDir: string, baseDir: string): number {
  // Latest row per series wins (an operator edit produced a newer row in
  // a later session; a cancel removed it from the live set so it won't
  // appear here at all — correctly NOT migrated).
  const latest = new Map<string, LegacySeries>();
  const consider = (rows: LegacySeries[]) => {
    for (const r of rows) {
      if (!shouldMigrate(r.series_id, agentGroupId)) continue;
      const prev = latest.get(r.series_id);
      if (!prev || r._ts > prev._ts) latest.set(r.series_id, r);
    }
  };

  for (const entry of fs.readdirSync(agentGroupDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('sess-')) continue;
    const inPath = path.join(agentGroupDir, entry.name, 'inbound.db');
    if (!fs.existsSync(inPath)) continue;
    try {
      consider(collectFromInboundDb(inPath));
    } catch (err) {
      log.warn('migrate-legacy-series: skipped unreadable inbound.db', { inPath, err });
    }
  }
  consider(collectFromSidecar(path.join(agentGroupDir, '.recurring-carryover.json')));

  if (latest.size === 0) return 0;

  const sched = openScheduleDbAt(baseDir, agentGroupId);
  let imported = 0;
  try {
    for (const s of latest.values()) {
      if (hasSeries(sched, s.series_id)) continue; // already owned by schedule.db — never clobber
      sched
        .prepare(
          `INSERT INTO task_series
             (series_id, agent_group_id, kind, recurrence, process_after, content,
              platform_id, channel_type, thread_id, status, created_at, updated_at)
           VALUES (@series_id, @agent_group_id, 'task', @recurrence, @process_after, @content,
              @platform_id, @channel_type, @thread_id, @status, @now, @now)
           ON CONFLICT(series_id) DO NOTHING`,
        )
        .run({
          series_id: s.series_id,
          agent_group_id: agentGroupId,
          recurrence: s.recurrence,
          process_after: s.process_after,
          content: s.content,
          platform_id: s.platform_id,
          channel_type: s.channel_type,
          thread_id: s.thread_id,
          // Only 'paused' is preserved as a non-default; anything else
          // (incl. legacy 'completed' that slipped the live filter)
          // becomes an active 'pending' series.
          status: s.status === 'paused' ? 'paused' : 'pending',
          now: new Date().toISOString(),
        });
      imported += 1;
      log.info('migrate-legacy-series: imported series into schedule.db', {
        agentGroupId,
        seriesId: s.series_id,
        recurrence: s.recurrence,
        status: s.status,
      });
    }
  } finally {
    sched.close();
  }
  return imported;
}

/**
 * Run the migration across every agent group under the sessions base
 * dir. Called once at host boot before the sweep starts. Never throws —
 * a migration failure must not block boot.
 */
export function migrateLegacySeries(): void {
  const base = sessionsBaseDir();
  if (!fs.existsSync(base)) return;
  let total = 0;
  let groups = 0;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('ag-')) continue;
    try {
      const n = migrateAgentGroup(entry.name, path.join(base, entry.name), base);
      if (n > 0) {
        groups += 1;
        total += n;
      }
    } catch (err) {
      log.error('migrate-legacy-series: agent group migration failed — continuing', {
        agentGroupId: entry.name,
        err,
      });
    }
  }
  if (total > 0) {
    log.info('migrate-legacy-series: migration complete', { groups, series: total });
  } else {
    log.info('migrate-legacy-series: nothing to migrate (already converged)');
  }
}
