import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LoginLimiter,
  hashPassword,
  readCookie,
  signSession,
  verifyPassword,
  verifySession,
} from './src/auth.js';
import {
  addApp,
  ensureCatalogFile,
  loadSecret,
  readCatalog,
  readRaw,
  readSettings,
  removeApp,
  resolveLink,
  setAppUrl,
  writeRaw,
} from './src/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CATALOG_FILE =
  process.env.APPS_FILE ||
  ensureCatalogFile(path.join(ROOT, 'apps.json'), path.join(DATA_DIR, 'apps.json'));
const COOKIE = 'hd_session';
const HEALTH_TTL_MS = 30_000;
const MAX_BODY_BYTES = 4096;

const settings = readSettings();
const secret = loadSecret(DATA_DIR);
const passwordHash = hashPassword(settings.password);
const limiter = new LoginLimiter();

let catalog = readCatalog(CATALOG_FILE);
let catalogMtime = fs.statSync(CATALOG_FILE).mtimeMs;
let health = { checkedAt: 0, statuses: {} };

/** Re-read apps.json when it changed on disk, so edits need no restart. */
function currentCatalog() {
  try {
    const mtime = fs.statSync(CATALOG_FILE).mtimeMs;
    if (mtime !== catalogMtime) {
      catalog = readCatalog(CATALOG_FILE);
      catalogMtime = mtime;
    }
  } catch (err) {
    console.error(`apps.json reload failed, keeping last good copy: ${err.message}`);
  }
  return catalog;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
  });
}

function isLoggedIn(req) {
  return verifySession(secret, readCookie(req.headers.cookie, COOKIE));
}

function sessionCookie(value, maxAgeSec) {
  const flags = [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (settings.secureCookie) flags.push('Secure');
  return flags.join('; ');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function login(req, res) {
  const key = req.socket.remoteAddress || 'unknown';
  const wait = limiter.retryAfter(key);
  if (wait > 0) {
    return sendJson(res, 429, {
      error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`,
    });
  }

  let password = '';
  try {
    password = JSON.parse(await readBody(req))?.password ?? '';
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  if (!verifyPassword(password, passwordHash)) {
    limiter.fail(key);
    return sendJson(res, 401, { error: 'Wrong master password' });
  }

  limiter.reset(key);
  const token = signSession(secret, settings.sessionTtlMs);
  sendJson(
    res,
    200,
    { ok: true },
    { 'set-cookie': sessionCookie(token, Math.floor(settings.sessionTtlMs / 1000)) },
  );
}

/** Probe every app once, then serve the cached result for HEALTH_TTL_MS. */
async function checkHealth() {
  const now = Date.now();
  if (now - health.checkedAt < HEALTH_TTL_MS) return health.statuses;
  const apps = currentCatalog().apps;
  const results = await Promise.all(
    apps.map(async (app) => {
      try {
        await fetch(app.healthUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(3000),
        });
        return [app.id, 'up'];
      } catch {
        return [app.id, 'down'];
      }
    }),
  );
  health = { checkedAt: now, statuses: Object.fromEntries(results) };
  return health.statuses;
}

/** Read, mutate and rewrite the catalog atomically enough for a single writer. */
function saveCatalog(change) {
  const raw = readRaw(CATALOG_FILE);
  const result = change(raw);
  writeRaw(CATALOG_FILE, raw);
  catalog = readCatalog(CATALOG_FILE);
  catalogMtime = fs.statSync(CATALOG_FILE).mtimeMs;
  health = { checkedAt: 0, statuses: {} };
  return result;
}

/** Parse a JSON body, apply a catalog change, and report validation errors. */
async function mutate(req, res, change) {
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }
  try {
    const entry = saveCatalog((raw) => change(raw, input));
    return sendJson(res, 201, { ok: true, app: entry });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
}

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  sendFile(res, file);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const authed = isLoggedIn(req);

  if (req.method === 'POST' && pathname === '/api/login') return login(req, res);

  if (req.method === 'POST' && pathname === '/api/logout') {
    return sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  }

  if (pathname === '/' || pathname === '/login') {
    const page = authed && pathname === '/' ? 'dashboard.html' : 'login.html';
    if (!authed && pathname === '/') {
      return send(res, 302, '', { location: '/login' });
    }
    if (authed && pathname === '/login') {
      return send(res, 302, '', { location: '/' });
    }
    return sendFile(res, path.join(PUBLIC_DIR, page));
  }

  if (pathname === '/style.css' || pathname === '/dashboard.js' || pathname === '/login.js') {
    return serveStatic(res, pathname);
  }

  if (!authed) {
    if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Unauthorized' });
    return send(res, 302, '', { location: '/login' });
  }

  if (req.method === 'GET' && pathname === '/api/apps') {
    const data = currentCatalog();
    return sendJson(res, 200, {
      ...data,
      usingDefaultPassword: settings.usingDefaultPassword,
    });
  }

  if (req.method === 'POST' && pathname === '/api/apps') {
    return mutate(req, res, (raw, input) => addApp(raw, input));
  }

  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/url$/.test(pathname)) {
    const id = pathname.split('/')[3];
    return mutate(req, res, (raw, input) =>
      setAppUrl(raw, id, input.network, input.url),
    );
  }

  if (req.method === 'DELETE' && /^\/api\/apps\/[^/]+$/.test(pathname)) {
    const id = pathname.split('/')[3];
    try {
      const removed = saveCatalog((raw) => removeApp(raw, id));
      if (!removed) return sendJson(res, 404, { error: 'Unknown app' });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { statuses: await checkHealth() });
  }

  if (pathname.startsWith('/go/')) {
    const data = currentCatalog();
    const app = data.apps.find((a) => a.id === pathname.slice(4));
    const link = resolveLink(app, url.searchParams.get('net'), data.defaultNetwork);
    if (!link) return send(res, 404, 'Unknown app');
    return send(res, 302, '', { location: link.url, 'cache-control': 'no-store' });
  }

  return send(res, 404, 'Not found');
});

server.listen(settings.port, settings.host, () => {
  console.log(`Home dashboard on http://${settings.host}:${settings.port}`);
  console.log(`${catalog.apps.length} apps loaded from ${CATALOG_FILE}`);
  if (settings.usingDefaultPassword) {
    console.warn('WARNING: using the default master password. Set DASHBOARD_PASSWORD.');
  }
});
