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
import {
  getCache,
  setCache,
  isCacheValid,
  getCacheFetchedAt,
  getInvestments,
} from './dashboard-db.js';

const TOKEN_PATH = path.join(
  process.env.HOME || '',
  '.config',
  'lunchmoney',
  'token',
);
const API_BASE = 'https://api.lunchmoney.dev/v2';

// Cache TTLs
const TX_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const BALANCE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const META_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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
  const CACHE_KEY = 'lm-meta';
  if (!forceRefresh && isCacheValid(CACHE_KEY, META_CACHE_TTL)) {
    return getCache<LMMeta>(CACHE_KEY)!.data;
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
  setCache(CACHE_KEY, meta);
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

export function getBalancesCachedAt(): string | null {
  return getCacheFetchedAt('lm-balances');
}

export async function getBalances(forceRefresh = false): Promise<LMBalances> {
  const CACHE_KEY = 'lm-balances';
  if (!forceRefresh && isCacheValid(CACHE_KEY, BALANCE_CACHE_TTL)) {
    return getCache<LMBalances>(CACHE_KEY)!.data;
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
  setCache(CACHE_KEY, balances);
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
  const CACHE_KEY = 'lm-transactions';
  if (!forceRefresh && isCacheValid(CACHE_KEY, TX_CACHE_TTL)) {
    return getCache<LMTransactions>(CACHE_KEY)!.data;
  }

  // Fetch all transactions from LM account start
  const endDate = new Date();
  const startDate = new Date('2020-01-01');

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
  setCache(CACHE_KEY, data);
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
  properties: { name: string; value: number }[];
  txDateRange: { start: string; end: string };
  cachedAt: {
    meta: string | null;
    balances: string | null;
    transactions: string | null;
  };
}

export async function getDashboardData(
  forceRefresh = false,
): Promise<DashboardData> {
  const [meta, balances, txData] = await Promise.all([
    getMeta(forceRefresh),
    getBalances(forceRefresh),
    getTransactions(forceRefresh),
  ]);

  // Load properties from investment data
  let properties: { name: string; value: number }[] = [];
  const investData = getInvestments();
  if (investData) {
    properties = investData.properties || [];
  }

  return {
    user: meta.user,
    categories: meta.categories,
    accounts: balances.accounts,
    transactions: txData.transactions,
    properties,
    txDateRange: { start: txData.startDate, end: txData.endDate },
    cachedAt: {
      meta: getCacheFetchedAt('lm-meta'),
      balances: getCacheFetchedAt('lm-balances'),
      transactions: getCacheFetchedAt('lm-transactions'),
    },
  };
}
