/**
 * Tico Dashboard Server
 *
 * Fastify HTTP server serving a financial dashboard UI and
 * proxying data from the Lunch Money API with local caching.
 *
 * Run as: npx tsx src/dashboard/server.ts
 * Or via launchd for persistent operation.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import closeWithGrace from 'close-with-grace';
import fs from 'fs';
import path from 'path';

import authPlugin, { render404Page } from './plugins/auth.js';
import financeRoutes from './routes/finance.js';
import homeRoutes from './routes/home.js';
import healthRoutes from './routes/health.js';
import { initDashboardDb } from './dashboard-db.js';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3002', 10);
const HOST = process.env.DASHBOARD_HOST || '0.0.0.0';

// Resolve static file directory (React build output)
const REACT_DIST = path.resolve(
  process.cwd(),
  'src',
  'dashboard',
  'ui',
  'dist',
);
const LEGACY_PUBLIC = path.resolve(process.cwd(), 'src', 'dashboard', 'public');
const STATIC_DIR = fs.existsSync(REACT_DIST)
  ? REACT_DIST
  : fs.existsSync(LEGACY_PUBLIC)
    ? LEGACY_PUBLIC
    : LEGACY_PUBLIC;

// Initialize database
initDashboardDb();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  },
  trustProxy: true,
  requestTimeout: 30000,
  bodyLimit: 1048576, // 1MB
});

// --- Plugins ---

// Auth (registers /auth/* routes and onRequest guard)
await app.register(authPlugin);

// --- API Routes ---

await app.register(financeRoutes);
await app.register(homeRoutes);
await app.register(healthRoutes);

// --- Static files (React SPA) ---

await app.register(fastifyStatic, {
  root: STATIC_DIR,
  wildcard: false, // We handle SPA fallback ourselves
});

// SPA fallback — serve index.html for all non-API, non-file routes
app.setNotFoundHandler(async (request, reply) => {
  // API 404s return JSON
  if (request.url.startsWith('/api/')) {
    reply.code(404);
    return { error: 'Not found' };
  }

  // Non-file routes get the SPA index.html (React Router handles routing)
  const indexPath = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    return reply.type('text/html').send(fs.readFileSync(indexPath));
  }

  // If no index.html, return styled 404
  reply.code(404).type('text/html');
  return render404Page();
});

// --- Graceful shutdown ---

closeWithGrace({ delay: 5000 }, async ({ signal, err }) => {
  if (err) {
    app.log.error({ err }, 'Server closing due to error');
  } else {
    app.log.info({ signal }, 'Server closing due to signal');
  }
  await app.close();
});

// --- Start ---

await app.listen({ port: PORT, host: HOST });
app.log.info(`💰 Tico Dashboard serving from ${STATIC_DIR}`);
