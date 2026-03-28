/**
 * Dashboard database module.
 *
 * Centralized SQLite storage for all dashboard and dev-agent data,
 * replacing fragmented JSON file stores.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import type { InvestmentData } from './investments.js';

const DB_DIR = path.resolve(process.cwd(), 'store');
const DB_PATH = path.join(DB_DIR, 'nanoclaw.db');

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      last_updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investment_trends (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS amazon_orders (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dev_agent_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS dev_agent_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function initDashboardDb(): void {
  fs.mkdirSync(DB_DIR, { recursive: true });

  db = new Database(DB_PATH);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonFiles();
}

// ── Cache (for lunchmoney) ──────────────────────────────────

export function getCache<T>(
  key: string,
): { data: T; fetchedAt: string } | null {
  const row = db
    .prepare('SELECT data, fetched_at FROM cache WHERE key = ?')
    .get(key) as { data: string; fetched_at: string } | undefined;

  if (!row) return null;

  return {
    data: JSON.parse(row.data) as T,
    fetchedAt: row.fetched_at,
  };
}

export function setCache<T>(key: string, data: T, fetchedAt?: string): void {
  const ts = fetchedAt ?? new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO cache (key, data, fetched_at) VALUES (?, ?, ?)',
  ).run(key, JSON.stringify(data), ts);
}

export function getCacheFetchedAt(key: string): string | null {
  const row = db
    .prepare('SELECT fetched_at FROM cache WHERE key = ?')
    .get(key) as { fetched_at: string } | undefined;
  return row?.fetched_at ?? null;
}

export function isCacheValid(key: string, ttlMs: number): boolean {
  const row = db
    .prepare('SELECT fetched_at FROM cache WHERE key = ?')
    .get(key) as { fetched_at: string } | undefined;

  if (!row) return false;

  const fetchedTime = new Date(row.fetched_at).getTime();
  const now = Date.now();
  return now - fetchedTime < ttlMs;
}

// ── Investments ─────────────────────────────────────────────

export function getInvestments(): InvestmentData | null {
  const row = db.prepare('SELECT data FROM investments WHERE id = 1').get() as
    | { data: string }
    | undefined;

  if (!row) return null;

  return JSON.parse(row.data) as InvestmentData;
}

export function saveInvestments(data: InvestmentData): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO investments (id, data, last_updated) VALUES (1, ?, ?)',
  ).run(JSON.stringify(data), now);
}

// ── Investment Trends ───────────────────────────────────────

export function getTrends<T = unknown>(): T | null {
  const row = db
    .prepare('SELECT data FROM investment_trends WHERE id = 1')
    .get() as { data: string } | undefined;

  if (!row) return null;

  return JSON.parse(row.data) as T;
}

export function saveTrends<T = unknown>(data: T): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO investment_trends (id, data, updated_at) VALUES (1, ?, ?)',
  ).run(JSON.stringify(data), now);
}

// ── Amazon Orders ───────────────────────────────────────────

export function getAmazonOrders<T = unknown>(): T | null {
  const row = db
    .prepare('SELECT data FROM amazon_orders WHERE id = 1')
    .get() as { data: string } | undefined;

  if (!row) return null;

  return JSON.parse(row.data) as T;
}

export function hasAmazonOrders(): boolean {
  const row = db.prepare('SELECT 1 FROM amazon_orders WHERE id = 1').get() as
    | { 1: number }
    | undefined;

  return !!row;
}

export function saveAmazonOrders<T = unknown>(data: T): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO amazon_orders (id, data, imported_at) VALUES (1, ?, ?)',
  ).run(JSON.stringify(data), now);
}

// ── Dev Agent State ─────────────────────────────────────────

export function getDevAgentState(key: string): string | null {
  const row = db
    .prepare('SELECT value FROM dev_agent_state WHERE key = ?')
    .get(key) as { value: string | null } | undefined;

  return row?.value ?? null;
}

export function setDevAgentState(key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM dev_agent_state WHERE key = ?').run(key);
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO dev_agent_state (key, value) VALUES (?, ?)',
    ).run(key, value);
  }
}

export function getAllDevAgentState(): Record<string, string | null> {
  const rows = db
    .prepare('SELECT key, value FROM dev_agent_state')
    .all() as Array<{ key: string; value: string | null }>;

  const result: Record<string, string | null> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ── Dev Agent Status ────────────────────────────────────────

export function getDevAgentStatus<T = unknown>(): T | null {
  const row = db
    .prepare('SELECT data FROM dev_agent_status WHERE id = 1')
    .get() as { data: string } | undefined;

  if (!row) return null;

  return JSON.parse(row.data) as T;
}

export function setDevAgentStatus(data: unknown): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO dev_agent_status (id, data, updated_at) VALUES (1, ?, ?)',
  ).run(JSON.stringify(data), now);
}

// ── JSON Migration ──────────────────────────────────────────

function migrateJsonFiles(): void {
  const migrateFile = (filename: string): unknown | null => {
    const filePath = path.join(DB_DIR, filename);
    if (!fs.existsSync(filePath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate lunchmoney cache files (JSON has { fetchedAt, data } wrapper)
  const migrateLmCache = (filename: string, cacheKey: string) => {
    const raw = migrateFile(filename) as {
      fetchedAt?: string;
      data?: unknown;
    } | null;
    if (raw && raw.data) {
      setCache(cacheKey, raw.data, raw.fetchedAt);
    } else if (raw) {
      // Fallback if structure is unexpected — store as-is
      setCache(cacheKey, raw);
    }
  };

  migrateLmCache('lm-transactions.json', 'lm-transactions');
  migrateLmCache('lm-balances.json', 'lm-balances');
  migrateLmCache('lm-meta.json', 'lm-meta');

  // Migrate investments
  const investments = migrateFile('investments.json') as InvestmentData | null;
  if (investments) {
    saveInvestments(investments);
  }

  // Migrate investment trends
  const trends = migrateFile('investment-trends.json');
  if (trends) {
    saveTrends(trends);
  }

  // Migrate amazon orders
  const amazonOrders = migrateFile('amazon-orders.json');
  if (amazonOrders) {
    saveAmazonOrders(amazonOrders);
  }

  // Migrate dev agent state (key-value pairs — values can be objects, serialize to JSON)
  const devAgentState = migrateFile('dev-agent-state.json') as Record<
    string,
    unknown
  > | null;
  if (devAgentState) {
    for (const [key, value] of Object.entries(devAgentState)) {
      const strValue =
        value === null
          ? null
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      setDevAgentState(key, strValue);
    }
  }

  // Migrate dev agent status
  const devAgentStatus = migrateFile('dev-agent-status.json');
  if (devAgentStatus) {
    setDevAgentStatus(devAgentStatus);
  }
}
