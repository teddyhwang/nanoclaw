/**
 * Lunch Money API client with local file-based caching.
 *
 * Cache strategy:
 *   - Transactions: cached in db/lm-transactions.json, refreshed at most once/day
 *   - Balances (plaid + manual accounts): cached in db/lm-balances.json, refreshed every hour
 *   - Categories/Tags/User: cached in db/lm-meta.json, refreshed daily
 */
import fs from 'fs';
import path from 'path';

const DB_DIR = path.resolve(process.cwd(), 'db');
const TOKEN_PATH = path.join(
  process.env.HOME || '',
  '.config',
  'lunchmoney',
  'token',
);
const API_BASE = 'https://api.lunchmoney.dev/v2';

// Cache TTLs
const TX_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const BALANCE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const META_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface CacheFile<T> {
  fetchedAt: string;
  data: T;
}

function getToken(): string {
  return fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
}

async function apiFetch<T>(
  endpoint: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    throw new Error(
      `Lunch Money API error: ${res.status} ${res.statusText} on ${endpoint}`,
    );
  }
  return res.json() as Promise<T>;
}

function readCache<T>(filename: string): CacheFile<T> | null {
  const filepath = path.join(DB_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache<T>(filename: string, data: T): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const cache: CacheFile<T> = { fetchedAt: new Date().toISOString(), data };
  fs.writeFileSync(path.join(DB_DIR, filename), JSON.stringify(cache, null, 2));
}

function isCacheValid(filename: string, ttlMs: number): boolean {
  const cache = readCache(filename);
  if (!cache) return false;
  const age = Date.now() - new Date(cache.fetchedAt).getTime();
  return age < ttlMs;
}

// ── User / Meta ───────────────────────────────────────────────

export interface LMUser {
  name: string;
  email: string;
  id: number;
  account_id: number;
  budget_name: string;
  primary_currency: string;
  debits_as_negative?: boolean;
}

export interface LMCategory {
  id: number;
  name: string;
  is_income: boolean;
  is_group: boolean;
  group_id: number | null;
  children?: LMCategory[];
}

export interface LMMeta {
  user: LMUser;
  categories: LMCategory[];
  tags: { id: number; name: string }[];
}

export async function getMeta(forceRefresh = false): Promise<LMMeta> {
  const CACHE_FILE = 'lm-meta.json';
  if (!forceRefresh && isCacheValid(CACHE_FILE, META_CACHE_TTL)) {
    return readCache<LMMeta>(CACHE_FILE)!.data;
  }

  const [user, catRes, tagRes] = await Promise.all([
    apiFetch<LMUser>('/me'),
    apiFetch<{ categories: LMCategory[] }>('/categories'),
    apiFetch<{ tags: { id: number; name: string }[] }>('/tags'),
  ]);

  const meta: LMMeta = {
    user,
    categories: catRes.categories,
    tags: tagRes.tags,
  };
  writeCache(CACHE_FILE, meta);
  return meta;
}

// ── Balances ──────────────────────────────────────────────────

export interface LMAccount {
  id: number;
  name?: string;
  display_name: string;
  type: string;
  subtype: string | null;
  balance: string;
  currency: string;
  to_base: number;
  institution_name: string | null;
  status: string;
  source: 'plaid' | 'manual';
}

export interface LMBalances {
  accounts: LMAccount[];
}

export async function getBalances(forceRefresh = false): Promise<LMBalances> {
  const CACHE_FILE = 'lm-balances.json';
  if (!forceRefresh && isCacheValid(CACHE_FILE, BALANCE_CACHE_TTL)) {
    return readCache<LMBalances>(CACHE_FILE)!.data;
  }

  const [plaidRes, manualRes] = await Promise.all([
    apiFetch<{ plaid_accounts: LMAccount[] }>('/plaid_accounts'),
    apiFetch<{ manual_accounts: LMAccount[] }>('/manual_accounts'),
  ]);

  const accounts = [
    ...plaidRes.plaid_accounts.map((a) => ({ ...a, source: 'plaid' as const })),
    ...manualRes.manual_accounts.map((a) => ({
      ...a,
      display_name: a.display_name || a.name || 'Manual Account',
      source: 'manual' as const,
    })),
  ].filter((a) => a.status === 'active');

  const balances: LMBalances = { accounts };
  writeCache(CACHE_FILE, balances);
  return balances;
}

// ── Transactions ──────────────────────────────────────────────

export interface LMTransaction {
  id: number;
  date: string;
  amount: string;
  currency: string;
  to_base: number;
  payee: string;
  original_name: string;
  category_id: number | null;
  notes: string | null;
  status: string;
  is_pending: boolean;
  plaid_account_id: number | null;
  tag_ids: number[];
  source: string;
  is_income: boolean;
  exclude_from_totals: boolean;
}

export interface LMTransactions {
  transactions: LMTransaction[];
  startDate: string;
  endDate: string;
}

export async function getTransactions(
  forceRefresh = false,
): Promise<LMTransactions> {
  const CACHE_FILE = 'lm-transactions.json';
  if (!forceRefresh && isCacheValid(CACHE_FILE, TX_CACHE_TTL)) {
    return readCache<LMTransactions>(CACHE_FILE)!.data;
  }

  // Fetch last 90 days of transactions
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  let allTx: LMTransaction[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await apiFetch<{
      transactions: LMTransaction[];
      has_more: boolean;
    }>('/transactions', {
      start_date: fmt(startDate),
      end_date: fmt(endDate),
      offset: String(offset),
    });
    allTx = allTx.concat(res.transactions);
    hasMore = res.has_more;
    offset += res.transactions.length;
  }

  const data: LMTransactions = {
    transactions: allTx,
    startDate: fmt(startDate),
    endDate: fmt(endDate),
  };
  writeCache(CACHE_FILE, data);
  return data;
}

// ── Summary ───────────────────────────────────────────────────

export interface LMSummaryItem {
  category_id: number;
  category_name?: string;
  amount: number;
  currency: string;
  is_income: boolean;
}

export async function getSummary(
  startDate: string,
  endDate: string,
): Promise<LMSummaryItem[]> {
  // Summary endpoint returns different shape — normalize
  const res = await apiFetch<Record<string, unknown>[]>('/summary', {
    start_date: startDate,
    end_date: endDate,
  });
  // The v2 summary returns an array of objects with category info
  return res as unknown as LMSummaryItem[];
}

// ── Aggregated Dashboard Data ─────────────────────────────────

export interface DashboardData {
  user: LMUser;
  categories: LMCategory[];
  accounts: LMAccount[];
  transactions: LMTransaction[];
  txDateRange: { start: string; end: string };
  cachedAt: {
    meta: string | null;
    balances: string | null;
    transactions: string | null;
  };
}

export async function getDashboardData(
  forceRefreshBalances = false,
): Promise<DashboardData> {
  const [meta, balances, txData] = await Promise.all([
    getMeta(),
    getBalances(forceRefreshBalances),
    getTransactions(),
  ]);

  const metaCache = readCache<LMMeta>('lm-meta.json');
  const balCache = readCache<LMBalances>('lm-balances.json');
  const txCache = readCache<LMTransactions>('lm-transactions.json');

  return {
    user: meta.user,
    categories: meta.categories,
    accounts: balances.accounts,
    transactions: txData.transactions,
    txDateRange: { start: txData.startDate, end: txData.endDate },
    cachedAt: {
      meta: metaCache?.fetchedAt ?? null,
      balances: balCache?.fetchedAt ?? null,
      transactions: txCache?.fetchedAt ?? null,
    },
  };
}
