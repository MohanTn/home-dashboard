import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PASSWORD = 'changeme';

const FALLBACK_NETWORKS = [{ id: 'lan', label: 'LAN', hint: '' }];

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
      links,
      healthUrl: isSafeUrl(app.healthUrl) ? app.healthUrl : links[0].url,
    });
  }

  return {
    title: String(source.title ?? 'Home Server').trim(),
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

/** Append a user-created card to the raw catalog. Throws on invalid input. */
export function addApp(raw, input = {}) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Name is required');
  const url = normalizeUrl(input.url);
  if (!url) throw new Error('Enter a valid http or https URL');

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
    urls: { [network]: url },
  };
  raw.apps.push(entry);
  return entry;
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
    port: Number(env.PORT || 80),
    host: env.HOST || '0.0.0.0',
    password,
    usingDefaultPassword: password === DEFAULT_PASSWORD,
    sessionTtlMs: Number(env.SESSION_HOURS || 720) * 60 * 60 * 1000,
    secureCookie: env.SECURE_COOKIE === 'true',
  };
}
