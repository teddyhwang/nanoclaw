/**
 * Google OAuth 2.0 authentication plugin for Fastify.
 *
 * Registers auth routes (/auth/*) and a preHandler hook that
 * protects all other routes. API routes get 401, page routes
 * redirect to Google sign-in.
 *
 * Cross-origin flow (e.g. .local → localhost callback):
 *   Uses one-time claim tokens to bounce the session back
 *   to the original domain after OAuth completes on localhost.
 */

import crypto from 'crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// --- Config ---

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAIL = process.env.DASHBOARD_ALLOWED_EMAIL || '';
const SESSION_SECRET =
  process.env.DASHBOARD_SESSION_SECRET ||
  crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
const OAUTH_REDIRECT_HOST =
  process.env.DASHBOARD_OAUTH_REDIRECT_HOST || 'localhost:3002';

// --- Error page template ---

function renderErrorPage(
  title: string,
  message: string,
  linkHref?: string,
  linkText?: string,
): string {
  const statusCode = title === 'Access Denied' ? '403' : '404';
  const linkHtml =
    linkHref && linkText
      ? `<a href="${linkHref}" style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:10px 20px;background:rgba(89,194,255,0.1);border:1px solid rgba(89,194,255,0.25);border-radius:8px;color:#59c2ff;text-decoration:none;font-size:14px;font-weight:500;transition:all 0.2s"
         onmouseover="this.style.background='rgba(89,194,255,0.18)';this.style.borderColor='rgba(89,194,255,0.4)'"
         onmouseout="this.style.background='rgba(89,194,255,0.1)';this.style.borderColor='rgba(89,194,255,0.25)'">${linkText}</a>`
      : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0e14;color:#bfbdb6;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}
  .container{max-width:420px;padding:40px 24px}
  .code{font-size:72px;font-weight:700;color:#59c2ff;line-height:1;margin-bottom:8px;text-shadow:0 0 40px rgba(89,194,255,0.2)}
  h1{font-size:22px;font-weight:600;color:#e6e1cf;margin-bottom:12px}
  p{font-size:15px;color:#6c7a8a;line-height:1.6;margin-bottom:20px}
  .divider{width:48px;height:2px;background:rgba(89,194,255,0.25);border-radius:1px;margin:20px auto}
</style></head><body>
<div class="container">
  <div class="code">${statusCode}</div>
  <h1>${title}</h1>
  <div class="divider"></div>
  <p>${message}</p>
  ${linkHtml}
</div></body></html>`;
}

export function render404Page(): string {
  return renderErrorPage(
    'Page Not Found',
    "The page you're looking for doesn't exist.",
    '/',
    '← Back to Dashboard',
  );
}

// --- Session store (in-memory) ---

interface Session {
  email: string;
  name: string;
  picture: string;
  createdAt: number;
}

const sessions = new Map<string, Session>();

function createSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

function signValue(value: string): string {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(value);
  return `${value}.${hmac.digest('base64url')}`;
}

function verifySignedValue(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.substring(0, idx);
  if (signValue(value) === signed) return value;
  return null;
}

// --- Cookie helpers ---

function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  const signed = signValue(sessionId);
  reply.header(
    'Set-Cookie',
    `session=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    'Set-Cookie',
    'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
  );
}

// --- Google OAuth helpers ---

/** Known HTTPS domains (served via Cloudflare). */
const HTTPS_DOMAINS = new Set(
  (process.env.DASHBOARD_HTTPS_DOMAINS || 'dashboard.teddyhwang.com')
    .split(',')
    .map((d) => d.trim()),
);

/**
 * Detect the real protocol. Caddy in Flexible SSL mode overwrites
 * X-Forwarded-Proto to "http", so we can't trust it. Instead we
 * check if the forwarded host is a known HTTPS domain.
 */
function getExternalProto(request: FastifyRequest): string {
  const host = (request.headers['x-forwarded-host'] as string) || '';
  if (HTTPS_DOMAINS.has(host)) return 'https';
  const forwarded = request.headers['x-forwarded-proto'] as string | undefined;
  if (forwarded === 'https') return 'https';
  return 'http';
}

function getRedirectUri(request: FastifyRequest): string {
  const proto = getExternalProto(request);
  const forwardedHost = request.headers['x-forwarded-host'] as
    | string
    | undefined;

  if (proto === 'https' && forwardedHost) {
    return `https://${forwardedHost}/auth/google/callback`;
  }

  // Localhost fallback (for LAN/.local access)
  return `http://${OAUTH_REDIRECT_HOST}/auth/google/callback`;
}

function getRequestOrigin(request: FastifyRequest): string {
  const proto = getExternalProto(request);
  const host =
    (request.headers['x-forwarded-host'] as string) ||
    request.headers.host ||
    OAUTH_REDIRECT_HOST;
  return `${proto}://${host}`;
}

function getGoogleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<{ id_token: string; access_token: string }> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }
  return resp.json() as Promise<{ id_token: string; access_token: string }>;
}

function decodeIdToken(idToken: string): {
  email: string;
  name: string;
  picture: string;
} {
  const payload = idToken.split('.')[1];
  const decoded = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf-8'),
  );
  return {
    email: decoded.email || '',
    name: decoded.name || decoded.email || '',
    picture: decoded.picture || '',
  };
}

// --- CSRF state tokens ---

interface PendingState {
  createdAt: number;
  returnOrigin: string;
}

const pendingStates = new Map<string, PendingState>();

function createState(returnOrigin: string): string {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { createdAt: Date.now(), returnOrigin });
  for (const [s, info] of pendingStates) {
    if (Date.now() - info.createdAt > 600_000) pendingStates.delete(s);
  }
  return state;
}

function consumeState(state: string): PendingState | null {
  const info = pendingStates.get(state);
  if (!info) return null;
  pendingStates.delete(state);
  return info;
}

// --- One-time claim tokens ---

interface ClaimToken {
  sessionId: string;
  createdAt: number;
}

const claimTokens = new Map<string, ClaimToken>();

function createClaimToken(sessionId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  claimTokens.set(token, { sessionId, createdAt: Date.now() });
  for (const [t, info] of claimTokens) {
    if (Date.now() - info.createdAt > 120_000) claimTokens.delete(t);
  }
  return token;
}

function consumeClaimToken(token: string): string | null {
  const info = claimTokens.get(token);
  if (!info) return null;
  claimTokens.delete(token);
  if (Date.now() - info.createdAt > 120_000) return null;
  return info.sessionId;
}

// --- Plugin ---

function isAuthEnabled(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function getSession(request: FastifyRequest): Session | null {
  const cookieHeader = request.headers.cookie || '';
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  const signed = cookies.session;
  if (!signed) return null;
  const sessionId = verifySignedValue(signed);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE * 1000) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

async function authPlugin(fastify: FastifyInstance) {
  if (!isAuthEnabled()) {
    fastify.log.warn(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — auth disabled',
    );
    return;
  }

  // --- Auth routes (not protected) ---

  fastify.get('/auth/google', async (request, reply) => {
    const returnOrigin = getRequestOrigin(request);
    const redirectUri = getRedirectUri(request);
    const state = createState(returnOrigin);
    const url = getGoogleAuthUrl(redirectUri, state);
    return reply.redirect(url);
  });

  fastify.get('/auth/google/callback', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const code = query.code;
    const state = query.state;
    const error = query.error;

    if (error) {
      return reply.redirect('/?auth_error=' + error);
    }

    const stateInfo = state ? consumeState(state) : null;
    if (!code || !stateInfo) {
      reply.code(400);
      return 'Invalid OAuth callback';
    }

    const redirectUri = getRedirectUri(request);
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    const user = decodeIdToken(tokens.id_token);

    if (ALLOWED_EMAIL && user.email !== ALLOWED_EMAIL) {
      fastify.log.warn(`Auth rejected: ${user.email} not in allowlist`);
      const returnOrigin = stateInfo.returnOrigin;
      const deniedUrl = `${returnOrigin}/auth/denied?email=${encodeURIComponent(user.email)}`;
      return reply.redirect(deniedUrl);
    }

    const sessionId = createSessionId();
    sessions.set(sessionId, {
      email: user.email,
      name: user.name,
      picture: user.picture,
      createdAt: Date.now(),
    });

    const callbackOrigin = `http://${request.headers.host}`;
    const returnOrigin = stateInfo.returnOrigin;

    if (returnOrigin !== callbackOrigin) {
      const claimToken = createClaimToken(sessionId);
      const claimUrl = `${returnOrigin}/auth/claim?token=${claimToken}`;
      return reply.redirect(claimUrl);
    }

    setSessionCookie(reply, sessionId);
    return reply.redirect('/');
  });

  fastify.get('/auth/denied', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const email = query.email || 'unknown';
    reply.type('text/html').code(403);
    return renderErrorPage(
      'Access Denied',
      `${email} is not authorized to access this dashboard.`,
      '/auth/google',
      'Try a different account',
    );
  });

  fastify.get('/auth/claim', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const token = query.token;

    if (!token) {
      reply.code(400);
      return 'Missing token';
    }

    const sessionId = consumeClaimToken(token);
    if (!sessionId || !sessions.has(sessionId)) {
      reply.code(400);
      return 'Invalid or expired token';
    }

    setSessionCookie(reply, sessionId);
    return reply.redirect('/');
  });

  fastify.get('/auth/me', async (request, reply) => {
    const session = getSession(request);
    if (session) {
      return {
        email: session.email,
        name: session.name,
        picture: session.picture,
      };
    }
    reply.code(401);
    return { error: 'Not authenticated' };
  });

  fastify.get('/auth/logout', async (request, reply) => {
    // Clear server-side session
    const cookieHeader = request.headers.cookie || '';
    for (const pair of cookieHeader.split(';')) {
      const [key, ...rest] = pair.trim().split('=');
      if (key === 'session') {
        const signed = rest.join('=');
        const sessionId = verifySignedValue(signed);
        if (sessionId) sessions.delete(sessionId);
      }
    }
    clearSessionCookie(reply);
    return reply.redirect('/');
  });

  // --- Auth guard hook (protects everything except /auth/*) ---

  fastify.addHook(
    'onRequest',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.url.startsWith('/auth/')) return;

      // Allow static assets through without auth (manifest, icons, CSS, JS)
      // These are public and needed before the SPA can even render the login redirect
      const url = request.url.split('?')[0];
      if (
        url === '/manifest.json' ||
        url === '/favicon.ico' ||
        url.startsWith('/assets/') ||
        url.endsWith('.png') ||
        url.endsWith('.svg') ||
        url.endsWith('.ico') ||
        url.endsWith('.css') ||
        url.endsWith('.js')
      ) {
        return;
      }

      const session = getSession(request);
      if (session) return;

      if (request.url.startsWith('/api/')) {
        reply.code(401);
        reply.send({ error: 'Authentication required' });
        return;
      }

      reply.redirect('/auth/google');
    },
  );
}

export default fp(authPlugin, { name: 'auth' });
