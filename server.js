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
  ICONS,
  addApp,
  ensureCatalogFile,
  loadSecret,
  readCatalog,
  readRaw,
  readSettings,
  removeApp,
  resolveLink,
  setAppCompose,
  setAppIcon,
  setAppUrl,
  writeRaw,
} from './src/config.js';
import { StackManager, listComposeDirs, listComposePorts } from './src/compose.js';

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
// Check for idle stacks often enough that a short idle window still means what
// it says, and never more than once every five minutes.
const SWEEP_INTERVAL_MS = Math.min(5 * 60_000, Math.max(1000, settings.idleMs));
const secret = loadSecret(DATA_DIR);
const passwordHash = hashPassword(settings.password);
const limiter = new LoginLimiter();
const stacks = new StackManager({
  root: settings.stacksRoot,
  idleMs: settings.idleMs,
  startTimeoutMs: settings.startTimeoutMs,
});

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

/**
 * Probe every app once, then serve the cached result for HEALTH_TTL_MS.
 * Managed apps report their stack state (running, starting, stopped, error),
 * plain link cards keep the old up/down answer.
 */
async function checkHealth() {
  const now = Date.now();
  if (now - health.checkedAt < HEALTH_TTL_MS) return health.statuses;
  const apps = currentCatalog().apps;
  const results = await Promise.all(
    apps.map(async (app) => {
      let reachable = false;
      try {
        await fetch(app.healthUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(3000),
        });
        reachable = true;
      } catch {
        reachable = false;
      }
      if (!app.compose) return [app.id, reachable ? 'up' : 'down'];
      return [app.id, await stacks.observeApp(app, reachable)];
    }),
  );
  health = { checkedAt: now, statuses: Object.fromEntries(results) };
  return health.statuses;
}

/** Take every stack nobody has opened for the idle window back down. */
async function sweepIdle() {
  try {
    const stopped = await stacks.sweep(currentCatalog().apps);
    if (stopped.length) {
      health = { checkedAt: 0, statuses: {} };
      console.log(`idle sweep stopped: ${stopped.join(', ')}`);
    }
  } catch (err) {
    console.error(`idle sweep failed: ${err.message}`);
  }
}

function findApp(id) {
  return currentCatalog().apps.find((a) => a.id === id) ?? null;
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

/** Serve a file from public/, refusing anything that escapes that directory. */
function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  if (!MIME[path.extname(file)]) return send(res, 404, 'Not found');
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
      icons: ICONS,
      idleHours: Math.round(settings.idleMs / 3_600_000),
      usingDefaultPassword: settings.usingDefaultPassword,
    });
  }

  // Folders under the stacks root that hold a compose file, for the picker.
  if (req.method === 'GET' && pathname === '/api/compose-dirs') {
    return sendJson(res, 200, {
      dirs: listComposeDirs(settings.stacksRoot),
      ports: listComposePorts(settings.stacksRoot),
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

  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/icon$/.test(pathname)) {
    const id = pathname.split('/')[3];
    return mutate(req, res, (raw, input) => setAppIcon(raw, id, input.icon));
  }

  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/compose$/.test(pathname)) {
    const id = pathname.split('/')[3];
    return mutate(req, res, (raw, input) => setAppCompose(raw, id, input.compose));
  }

  // Kick off `compose up -d` and answer straight away, the UI polls /state.
  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/start$/.test(pathname)) {
    const app = findApp(pathname.split('/')[3]);
    if (!app) return sendJson(res, 404, { error: 'Unknown app' });
    if (!app.compose) return sendJson(res, 400, { error: 'This app has no compose folder' });
    stacks.start(app).catch((err) => console.error(`start ${app.id}: ${err.message}`));
    health = { checkedAt: 0, statuses: {} };
    return sendJson(res, 202, stacks.snapshot(app.id));
  }

  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/stop$/.test(pathname)) {
    const app = findApp(pathname.split('/')[3]);
    if (!app) return sendJson(res, 404, { error: 'Unknown app' });
    if (!app.compose) return sendJson(res, 400, { error: 'This app has no compose folder' });
    const state = await stacks.stop(app);
    health = { checkedAt: 0, statuses: {} };
    return sendJson(res, 200, state);
  }

  if (req.method === 'GET' && /^\/api\/apps\/[^/]+\/state$/.test(pathname)) {
    const app = findApp(pathname.split('/')[3]);
    if (!app) return sendJson(res, 404, { error: 'Unknown app' });
    return sendJson(res, 200, stacks.snapshot(app.id));
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
    if (app.compose) stacks.touch(app.id);
    return send(res, 302, '', { location: link.url, 'cache-control': 'no-store' });
  }

  return send(res, 404, 'Not found');
});

const sweepTimer = setInterval(sweepIdle, SWEEP_INTERVAL_MS);
sweepTimer.unref();

server.listen(settings.port, settings.host, () => {
  console.log(`Container manager on http://${settings.host}:${settings.port}`);
  console.log(`${catalog.apps.length} apps loaded from ${CATALOG_FILE}`);
  console.log(
    `stacks root ${settings.stacksRoot}, idle shutdown after ${Math.round(settings.idleMs / 3_600_000)}h`,
  );
  if (settings.usingDefaultPassword) {
    console.warn('WARNING: using the default master password. Set DASHBOARD_PASSWORD.');
  }
});
