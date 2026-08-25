import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'test-pass-1234';

let child;
let base;
let dataDir;
let cookie = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server did not become ready at ${url}`);
}

/** Every request carries whatever session cookie we currently hold. */
function call(pathname, options = {}) {
  return fetch(base + pathname, {
    redirect: 'manual',
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-dashboard-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DASHBOARD_PASSWORD: PASSWORD },
    stdio: 'ignore',
  });
  await waitForReady(`${base}/login`);
});

after(() => {
  child?.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('anonymous visitors are sent to the login page', async () => {
  const page = await call('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');

  const api = await call('/api/apps');
  assert.equal(api.status, 401);

  const go = await call('/go/jellyfin');
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), '/login', 'the router must not leak app URLs');
});

test('login rejects the wrong password and accepts the right one', async () => {
  const bad = await call('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  const good = await call('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^hd_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  cookie = setCookie.split(';')[0];
});

test('the catalog loads once logged in', async () => {
  const res = await call('/api/apps');
  assert.equal(res.status, 200);
  const catalog = await res.json();
  assert.ok(catalog.apps.length > 0);
  assert.ok(catalog.networks.length > 0);
  assert.ok(catalog.apps.every((a) => a.links.length > 0));
});

test('/go routes per network and falls back', async () => {
  const lan = await call('/go/jellyfin');
  assert.equal(lan.status, 302);
  assert.match(lan.headers.get('location'), /^http:\/\/192\.168\.1\.10:8096/);

  const wan = await call('/go/jellyfin?net=wan');
  assert.equal(wan.headers.get('location'), 'https://media.example.com');

  const fallback = await call('/go/pihole?net=wan');
  assert.match(fallback.headers.get('location'), /192\.168\.1\.2/, 'falls back to the only URL');

  const unknown = await call('/go/does-not-exist');
  assert.equal(unknown.status, 404);
});

test('a card can be added, routed to, extended and removed', async () => {
  const created = await call('/api/apps', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sonarr', url: '192.168.1.10:8989', network: 'lan' }),
  });
  assert.equal(created.status, 201);
  const { app } = await created.json();
  assert.equal(app.id, 'sonarr');
  assert.equal(app.urls.lan, 'http://192.168.1.10:8989');

  const routed = await call('/go/sonarr');
  assert.equal(routed.headers.get('location'), 'http://192.168.1.10:8989');

  const extended = await call('/api/apps/sonarr/url', {
    method: 'POST',
    body: JSON.stringify({ network: 'wan', url: 'https://sonarr.example.com' }),
  });
  assert.equal(extended.status, 201);
  const viaWan = await call('/go/sonarr?net=wan');
  assert.equal(viaWan.headers.get('location'), 'https://sonarr.example.com');

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'apps.json'), 'utf8'));
  assert.ok(saved.apps.some((a) => a.id === 'sonarr'), 'survives in the data volume');

  assert.equal((await call('/api/apps/sonarr', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/apps/sonarr', { method: 'DELETE' })).status, 404);
});

test('invalid card input is rejected with a message', async () => {
  const noName = await call('/api/apps', {
    method: 'POST',
    body: JSON.stringify({ url: 'http://x' }),
  });
  assert.equal(noName.status, 400);
  assert.match((await noName.json()).error, /Name is required/);

  const badUrl = await call('/api/apps', {
    method: 'POST',
    body: JSON.stringify({ name: 'Evil', url: 'javascript:alert(1)' }),
  });
  assert.equal(badUrl.status, 400);
});

test('static assets are served and traversal is refused', async () => {
  const css = await call('/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const escape = await fetch(`${base}/style.css/../../../etc/passwd`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.ok(escape.status >= 400, 'must not serve files outside public/');
});

test('logout invalidates the session', async () => {
  const out = await call('/api/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  cookie = (out.headers.get('set-cookie') ?? '').split(';')[0];
  assert.equal((await call('/api/apps')).status, 401);
});
