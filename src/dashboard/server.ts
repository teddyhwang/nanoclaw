/**
 * Financial Dashboard Server
 *
 * Standalone HTTP server serving a financial dashboard UI and
 * proxying data from the Lunch Money API with local caching.
 *
 * Run as: npx tsx src/dashboard/server.ts
 * Or via launchd for persistent operation.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getDashboardData,
  getBalances,
  getBalancesCachedAt,
  getMeta,
  getSummary,
  getTransactions,
} from './lunchmoney.js';
import {
  loadInvestmentData,
  saveInvestmentData,
  updateYearField,
} from './investments.js';
import { getLiveCurrentYear } from './live-accounts.js';
import { matchTransactions, hasAmazonData } from './amazon-matcher.js';
import { getHealthData } from './health.js';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3002', 10);
const HOST = process.env.DASHBOARD_HOST || '0.0.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Serve from the React build output (Vite dist), falling back to legacy public dir
const REACT_DIST = path.resolve(
  process.cwd(),
  'src',
  'dashboard',
  'ui',
  'dist',
);
const LEGACY_PUBLIC = path.join(__dirname, 'public');
const LEGACY_SRC = path.resolve(process.cwd(), 'src', 'dashboard', 'public');
const STATIC_DIR = fs.existsSync(REACT_DIST)
  ? REACT_DIST
  : fs.existsSync(LEGACY_PUBLIC)
    ? LEGACY_PUBLIC
    : LEGACY_SRC;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, { error: message }, status);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  try {
    if (pathname === '/api/dashboard') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const refreshBalances =
        url.searchParams.get('refreshBalances') === 'true';
      const data = await getDashboardData(refreshBalances);
      sendJson(res, data);
    } else if (pathname === '/api/balances') {
      const data = await getBalances(true);
      sendJson(res, data);
    } else if (pathname === '/api/transactions') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const force = url.searchParams.get('force') === 'true';
      const data = await getTransactions(force);
      sendJson(res, data);
    } else if (pathname === '/api/properties') {
      const data = loadInvestmentData();
      sendJson(res, data?.properties || []);
    } else if (pathname === '/api/properties/save' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      await new Promise<void>((resolve) => req.on('end', resolve));
      const props = JSON.parse(Buffer.concat(chunks).toString());
      const data = loadInvestmentData();
      if (data) {
        data.properties = props;
        saveInvestmentData(data);
      }
      sendJson(res, { ok: true });
    } else if (pathname === '/api/investments') {
      const data = loadInvestmentData();
      if (!data) {
        sendError(
          res,
          404,
          'No investment data. Run import-spreadsheet first.',
        );
        return;
      }
      // Merge live LM data for current year
      try {
        const liveYear = await getLiveCurrentYear();
        if (liveYear) {
          data.years[String(new Date().getFullYear())] = liveYear;
        }
      } catch (err) {
        console.error('Failed to get live account data:', err);
      }
      // Include balance cache timestamp so UI can show sync age
      const balCachedAt = getBalancesCachedAt();
      sendJson(res, { ...data, cachedAt: { balances: balCachedAt } });
    } else if (
      pathname === '/api/investments/update' &&
      req.method === 'POST'
    ) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      await new Promise<void>((resolve) => req.on('end', resolve));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { year, path: fieldPath, value } = body;
      const updated = updateYearField(year, fieldPath, value);
      if (!updated) {
        sendError(res, 400, 'Invalid update');
        return;
      }
      sendJson(res, { ok: true });
    } else if (pathname === '/api/amazon-matches') {
      const txResp = await getTransactions();
      if (!hasAmazonData()) {
        sendJson(res, {});
        return;
      }
      const matches = matchTransactions(txResp.transactions);
      sendJson(res, matches);
    } else if (pathname === '/api/finance/meta') {
      // User info, categories, tags — everything needed to interpret transactions
      const meta = await getMeta();
      sendJson(res, meta);
    } else if (pathname === '/api/finance/accounts') {
      // Active accounts with balances
      const data = await getBalances();
      sendJson(res, data);
    } else if (pathname === '/api/finance/transactions') {
      // Filtered transactions query
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      const category = url.searchParams.get('category');
      const status = url.searchParams.get('status');
      const payee = url.searchParams.get('payee');
      const accountId = url.searchParams.get('account_id');
      const limit = parseInt(url.searchParams.get('limit') || '0', 10);

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
        // Resolve category name to ID(s)
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

      // Sort by date descending (newest first)
      filtered.sort((a, b) => b.date.localeCompare(a.date));

      if (limit > 0) filtered = filtered.slice(0, limit);

      // Hydrate category names
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
        category_name: t.category_id
          ? (catMap.get(t.category_id) ?? null)
          : null,
        account_name: t.plaid_account_id
          ? (acctMap.get(t.plaid_account_id) ?? null)
          : null,
      }));

      sendJson(res, {
        transactions: hydrated,
        count: hydrated.length,
        totalCount: txData.transactions.length,
        dateRange: { start: txData.startDate, end: txData.endDate },
      });
    } else if (pathname === '/api/finance/summary') {
      // Spending summary by category for a date range
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (!start || !end) {
        sendError(res, 400, 'start and end query params required');
        return;
      }
      const summary = await getSummary(start, end);
      sendJson(res, summary);
    } else if (pathname === '/api/health') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const sinceParam = url.searchParams.get('since');
      const untilParam = url.searchParams.get('until');
      const daysParam = url.searchParams.get('days');
      const opts: { since?: string; until?: string; days?: number } = sinceParam
        ? { since: sinceParam }
        : {
            days: Math.min(Math.max(parseInt(daysParam || '90', 10), 1), 5500),
          };
      if (untilParam) opts.until = untilParam;
      const data = getHealthData(opts);
      sendJson(res, data);
    } else if (pathname === '/api/investments/save' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      await new Promise<void>((resolve) => req.on('end', resolve));
      const data = JSON.parse(Buffer.concat(chunks).toString());
      saveInvestmentData(data);
      sendJson(res, { ok: true });
    } else {
      sendError(res, 404, 'Not found');
    }
  } catch (err) {
    console.error('API error:', err);
    sendError(
      res,
      500,
      err instanceof Error ? err.message : 'Internal server error',
    );
  }
}

function serveStatic(res: ServerResponse, pathname: string): void {
  let filePath = path.join(
    STATIC_DIR,
    pathname === '/' ? 'index.html' : pathname,
  );

  // Prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  if (!fs.existsSync(filePath)) {
    if (!path.extname(pathname)) {
      // SPA fallback — serve index.html for all non-file routes
      filePath = path.join(STATIC_DIR, 'index.html');
    } else {
      sendError(res, 404, 'Not found');
      return;
    }
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    sendError(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
  } else {
    serveStatic(res, pathname);
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `💰 Tico Dashboard running at http://${HOST}:${PORT} (serving from ${STATIC_DIR})`,
  );
});
