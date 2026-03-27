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
      sendJson(res, data);
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
    } else if (pathname === '/api/health') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const sinceParam = url.searchParams.get('since');
      const daysParam = url.searchParams.get('days');
      const opts = sinceParam
        ? { since: sinceParam }
        : {
            days: Math.min(Math.max(parseInt(daysParam || '90', 10), 1), 5500),
          };
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
