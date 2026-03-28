import type { FastifyInstance } from 'fastify';
import {
  getDashboardData,
  getBalances,
  getBalancesCachedAt,
  getMeta,
  getSummary,
  getTransactions,
} from '../lunchmoney.js';
import {
  loadInvestmentData,
  saveInvestmentData,
  updateYearField,
} from '../investments.js';
import { getLiveCurrentYear } from '../live-accounts.js';
import { matchTransactions, hasAmazonData } from '../amazon-matcher.js';

export default async function financeRoutes(fastify: FastifyInstance) {
  // GET /api/dashboard
  fastify.get('/api/dashboard', async (request) => {
    const query = request.query as {
      refresh?: string;
      refreshBalances?: string;
    };
    const forceRefresh =
      query.refresh === 'true' || query.refreshBalances === 'true';
    return getDashboardData(forceRefresh);
  });

  // GET /api/balances
  fastify.get('/api/balances', async () => {
    return getBalances(true);
  });

  // GET /api/transactions
  fastify.get('/api/transactions', async (request) => {
    const query = request.query as { force?: string };
    const force = query.force === 'true';
    return getTransactions(force);
  });

  // GET /api/properties
  fastify.get('/api/properties', async () => {
    const data = loadInvestmentData();
    return data?.properties || [];
  });

  // POST /api/properties/save
  fastify.post('/api/properties/save', async (request) => {
    const props = request.body as unknown[];
    const data = loadInvestmentData();
    if (data) {
      data.properties = props;
      saveInvestmentData(data);
    }
    return { ok: true };
  });

  // GET /api/investments
  fastify.get('/api/investments', async (request, reply) => {
    const query = request.query as { refresh?: string };
    const forceRefresh = query.refresh === 'true';
    const data = loadInvestmentData();
    if (!data) {
      reply.code(404);
      return { error: 'No investment data. Run import-spreadsheet first.' };
    }
    try {
      const liveYear = await getLiveCurrentYear(forceRefresh);
      if (liveYear) {
        data.years[String(new Date().getFullYear())] = liveYear;
      }
    } catch (err) {
      console.error('Failed to get live account data:', err);
    }
    const balCachedAt = getBalancesCachedAt();
    return { ...data, cachedAt: { balances: balCachedAt } };
  });

  // POST /api/investments/update
  fastify.post('/api/investments/update', async (request, reply) => {
    const {
      year,
      path: fieldPath,
      value,
    } = request.body as {
      year: string;
      path: string;
      value: unknown;
    };
    const updated = updateYearField(year, fieldPath, value);
    if (!updated) {
      reply.code(400);
      return { error: 'Invalid update' };
    }
    return { ok: true };
  });

  // POST /api/investments/save
  fastify.post('/api/investments/save', async (request) => {
    const data = request.body as Record<string, unknown>;
    saveInvestmentData(data);
    return { ok: true };
  });

  // GET /api/amazon-matches
  fastify.get('/api/amazon-matches', async () => {
    const txResp = await getTransactions();
    if (!hasAmazonData()) {
      return {};
    }
    return matchTransactions(txResp.transactions);
  });

  // GET /api/finance/meta
  fastify.get('/api/finance/meta', async () => {
    return getMeta();
  });

  // GET /api/finance/accounts
  fastify.get('/api/finance/accounts', async () => {
    return getBalances();
  });

  // GET /api/finance/transactions
  fastify.get('/api/finance/transactions', async (request) => {
    const query = request.query as {
      start?: string;
      end?: string;
      category?: string;
      status?: string;
      payee?: string;
      account_id?: string;
      limit?: string;
    };
    const { start, end, category, status, payee } = query;
    const accountId = query.account_id;
    const limit = parseInt(query.limit || '0', 10);

    const txData = await getTransactions();
    let filtered = txData.transactions;

    if (start) filtered = filtered.filter((t) => t.date >= start);
    if (end) filtered = filtered.filter((t) => t.date <= end);
    if (status) filtered = filtered.filter((t) => t.status === status);
    if (accountId) {
      const aid = parseInt(accountId, 10);
      filtered = filtered.filter((t) => t.plaid_account_id === aid);
    }
    if (category) {
      const meta = await getMeta();
      const lowerCat = category.toLowerCase();
      const matchIds = new Set<number>();
      for (const cat of meta.categories) {
        if (cat.name.toLowerCase().includes(lowerCat)) matchIds.add(cat.id);
        if (cat.children) {
          for (const child of cat.children) {
            if (child.name.toLowerCase().includes(lowerCat))
              matchIds.add(child.id);
          }
        }
      }
      filtered = filtered.filter(
        (t) => t.category_id !== null && matchIds.has(t.category_id),
      );
    }
    if (payee) {
      const lowerPayee = payee.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.payee.toLowerCase().includes(lowerPayee) ||
          t.original_name.toLowerCase().includes(lowerPayee),
      );
    }

    filtered.sort((a, b) => b.date.localeCompare(a.date));
    if (limit > 0) filtered = filtered.slice(0, limit);

    const meta = await getMeta();
    const catMap = new Map<number, string>();
    for (const cat of meta.categories) {
      catMap.set(cat.id, cat.name);
      if (cat.children) {
        for (const child of cat.children) catMap.set(child.id, child.name);
      }
    }
    const acctMap = new Map<number, string>();
    const balances = await getBalances();
    for (const a of balances.accounts) acctMap.set(a.id, a.display_name);

    const hydrated = filtered.map((t) => ({
      ...t,
      category_name: t.category_id ? (catMap.get(t.category_id) ?? null) : null,
      account_name: t.plaid_account_id
        ? (acctMap.get(t.plaid_account_id) ?? null)
        : null,
    }));

    return {
      transactions: hydrated,
      count: hydrated.length,
      totalCount: txData.transactions.length,
      dateRange: { start: txData.startDate, end: txData.endDate },
    };
  });

  // GET /api/finance/summary
  fastify.get('/api/finance/summary', async (request, reply) => {
    const query = request.query as { start?: string; end?: string };
    const { start, end } = query;
    if (!start || !end) {
      reply.code(400);
      return { error: 'start and end query params required' };
    }
    return getSummary(start, end);
  });
}
