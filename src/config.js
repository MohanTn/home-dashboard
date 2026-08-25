import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PASSWORD = 'changeme';

const FALLBACK_NETWORKS = [{ id: 'lan', label: 'LAN', hint: '' }];

/** The icon set a card can pick from, so every tile looks like it belongs. */
export const ICONS = [
  '📦', '🐳', '🎬', '🖼️', '☁️', '🔐', '🏠', '🛡️', '🖥️', '📈',
  '⬇️', '🎵', '📚', '📝', '🗂️', '🗄️', '📷', '🎮', '🤖', '🧠',
  '🔧', '🌐', '📡', '🔎', '💾', '🧾', '📺', '🧪', '⚙️', '🔔',
];

function isSafeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Accept `host:port` the way a browser bar does, reject anything not http(s). */
export function normalizeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null;
  const candidate = hasScheme ? raw : `http://${raw}`;
  return isSafeUrl(candidate) ? candidate.replace(/\/+$/, '') : null;
}

export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Turn raw apps.json into the shape the UI and the /go router consume.
 * Unknown networks, unsafe URLs and nameless apps are dropped rather than
 * crashing the dashboard, so one bad edit never locks you out of the rest.
 */
export function normalizeCatalog(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const networks = (
    Array.isArray(source.networks) && source.networks.length
      ? source.networks
      : FALLBACK_NETWORKS
  )
    .filter((n) => n && typeof n.id === 'string' && n.id.trim() !== '')
    .map((n) => ({
      id: n.id.trim(),
      label: String(n.label ?? n.id).trim(),
      hint: String(n.hint ?? '').trim(),
    }));

  const knownNetworks = new Set(networks.map((n) => n.id));
  const defaultNetwork = knownNetworks.has(source.defaultNetwork)
    ? source.defaultNetwork
    : networks[0].id;

  const seen = new Set();
  const apps = [];
  for (const app of Array.isArray(source.apps) ? source.apps : []) {
    if (!app || typeof app !== 'object') continue;
    const id = String(app.id ?? '').trim();
    const name = String(app.name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;

    const links = networks
      .filter((n) => isSafeUrl(app.urls?.[n.id]))
      .map((n) => ({
        network: n.id,
        label: n.label,
        url: String(app.urls[n.id]).trim(),
      }));
    if (links.length === 0) continue;

    seen.add(id);
    apps.push({
      id,
      name,
      description: String(app.description ?? '').trim(),
      icon: String(app.icon ?? '📦').trim(),
      category: String(app.category ?? 'Apps').trim(),
      custom: app.custom === true,
      compose: String(app.compose ?? '').trim(),
      links,
      healthUrl: isSafeUrl(app.healthUrl) ? app.healthUrl : links[0].url,
    });
  }

  return {
    title: String(source.title ?? 'Container Manager').trim(),
    subtitle: String(source.subtitle ?? '').trim(),
    networks,
    defaultNetwork,
    apps,
  };
}

/** Pick the URL for a requested network, falling back to the app's best link. */
export function resolveLink(app, network, defaultNetwork) {
  if (!app) return null;
  const order = [network, defaultNetwork];
  for (const wanted of order) {
    const hit = app.links.find((l) => l.network === wanted);
    if (hit) return hit;
  }
  return app.links[0] ?? null;
}

export function readCatalog(file) {
  return normalizeCatalog(readRaw(file));
}

export function readRaw(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeRaw(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Copy the bundled catalog into the writable data volume on first boot, so a
 * container restart keeps the cards you added through the UI.
 */
export function ensureCatalogFile(seedFile, targetFile) {
  if (!fs.existsSync(targetFile)) {
    writeRaw(targetFile, readRaw(seedFile));
  }
  return targetFile;
}

function uniqueId(apps, base) {
  const taken = new Set(apps.map((a) => a?.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** A compose folder is a relative path under the stacks root, or nothing. */
export function normalizeCompose(value) {
  const raw = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return '';
  if (raw.split('/').includes('..')) throw new Error('Compose folder cannot contain ..');
  return raw.slice(0, 120);
}

/**
 * Combine the add-app address and optional port into the URL stored in the
 * catalog. Bare addresses use http, matching the old single URL field.
 */
export function addressPortUrl(address, port) {
  const rawAddress = String(address ?? '').trim();
  if (!rawAddress) return null;
  const rawPort = String(port ?? '').trim();
  if (rawPort && !/^\d{1,5}$/.test(rawPort)) return null;
  if (rawPort && (Number(rawPort) < 1 || Number(rawPort) > 65535)) return null;

  let candidate = rawAddress;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const host = candidate.includes(':') && !candidate.startsWith('[')
      ? `[${candidate}]`
      : candidate;
    candidate = `http://${host}`;
  }

  try {
    const parsed = new URL(candidate);
    if (rawPort) parsed.port = rawPort;
    return normalizeUrl(parsed.toString());
  } catch {
    return null;
  }
}

/** Append a user-created card to the raw catalog. Throws on invalid input. */
export function addApp(raw, input = {}) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Name is required');
  const url = input.address !== undefined
    ? addressPortUrl(input.address, input.port)
    : normalizeUrl(input.url);
  if (!url) throw new Error('Enter a valid http or https URL');
  const compose = normalizeCompose(input.compose);

  const networks = Array.isArray(raw.networks) ? raw.networks : [];
  const known = networks.map((n) => n.id);
  const network = known.includes(input.network)
    ? input.network
    : (raw.defaultNetwork ?? known[0] ?? 'lan');

  if (!Array.isArray(raw.apps)) raw.apps = [];
  const base = slugify(name) || 'app';
  const entry = {
    id: uniqueId(raw.apps, base),
    name: name.slice(0, 60),
    description: String(input.description ?? '').trim().slice(0, 120),
    icon: String(input.icon ?? '📦').trim().slice(0, 4) || '📦',
    category: String(input.category ?? '').trim().slice(0, 40) || 'Apps',
    custom: true,
    compose,
    urls: { [network]: url },
  };
  raw.apps.push(entry);
  return entry;
}

/** Swap a card's icon for another one from the preset set. */
export function setAppIcon(raw, id, icon) {
  const app = (raw.apps ?? []).find((a) => a?.id === id);
  if (!app) throw new Error('Unknown app');
  const clean = String(icon ?? '').trim();
  if (!ICONS.includes(clean)) throw new Error('Pick an icon from the set');
  app.icon = clean;
  return app;
}

/** Point a card at the folder holding its docker-compose file. */
export function setAppCompose(raw, id, compose) {
  const app = (raw.apps ?? []).find((a) => a?.id === id);
  if (!app) throw new Error('Unknown app');
  app.compose = normalizeCompose(compose);
  return app;
}

/** Add or replace one network URL on an existing app. */
export function setAppUrl(raw, id, network, url) {
  const app = (raw.apps ?? []).find((a) => a?.id === id);
  if (!app) throw new Error('Unknown app');
  const clean = normalizeUrl(url);
  if (!clean) throw new Error('Enter a valid http or https URL');
  app.urls = { ...app.urls, [network]: clean };
  return app;
}

export function removeApp(raw, id) {
  const apps = Array.isArray(raw.apps) ? raw.apps : [];
  const index = apps.findIndex((a) => a?.id === id);
  if (index === -1) return false;
  apps.splice(index, 1);
  return true;
}

/** Persist a random signing secret so sessions survive a restart. */
export function loadSecret(dataDir) {
  const file = path.join(dataDir, 'session.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function readSettings(env = process.env) {
  const password = env.DASHBOARD_PASSWORD || DEFAULT_PASSWORD;
  return {
    port: Number(env.PORT || 5000),
    host: env.HOST || '0.0.0.0',
    password,
    usingDefaultPassword: password === DEFAULT_PASSWORD,
    sessionTtlMs: Number(env.SESSION_HOURS || 720) * 60 * 60 * 1000,
    secureCookie: env.SECURE_COOKIE === 'true',
    stacksRoot: env.STACKS_DIR || '/stacks',
    idleMs: Number(env.IDLE_HOURS || 6) * 60 * 60 * 1000,
    startTimeoutMs: Number(env.START_TIMEOUT_SEC || 120) * 1000,
  };
}
