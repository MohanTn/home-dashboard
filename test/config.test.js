import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PASSWORD,
  addApp,
  normalizeCatalog,
  readSettings,
  normalizeUrl,
  removeApp,
  resolveLink,
  setAppUrl,
  slugify,
} from '../src/config.js';

const base = () => ({
  defaultNetwork: 'lan',
  networks: [
    { id: 'lan', label: 'LAN' },
    { id: 'wan', label: 'Internet' },
  ],
  apps: [
    { id: 'a', name: 'Alpha', urls: { lan: 'http://10.0.0.1:80', wan: 'https://a.example.com' } },
  ],
});

test('normalizeCatalog builds one link per configured network', () => {
  const catalog = normalizeCatalog(base());
  assert.equal(catalog.apps.length, 1);
  assert.deepEqual(
    catalog.apps[0].links.map((l) => l.network),
    ['lan', 'wan'],
  );
  assert.equal(catalog.apps[0].healthUrl, 'http://10.0.0.1:80');
});

test('normalizeCatalog drops unusable apps instead of throwing', () => {
  const raw = base();
  raw.apps.push(
    { id: 'no-name', urls: { lan: 'http://x' } },
    { id: 'bad-url', name: 'Bad', urls: { lan: 'javascript:alert(1)' } },
    { id: 'unknown-net', name: 'Ghost', urls: { vpn: 'http://x' } },
    { id: 'a', name: 'Duplicate', urls: { lan: 'http://y' } },
  );
  const catalog = normalizeCatalog(raw);
  assert.deepEqual(catalog.apps.map((a) => a.id), ['a']);
});

test('normalizeCatalog falls back when networks or defaults are missing', () => {
  const catalog = normalizeCatalog({ defaultNetwork: 'nope', apps: [] });
  assert.equal(catalog.defaultNetwork, 'lan');
  assert.equal(catalog.networks.length, 1);
});

test('resolveLink prefers the asked network, then the default, then anything', () => {
  const app = normalizeCatalog(base()).apps[0];
  assert.equal(resolveLink(app, 'wan', 'lan').url, 'https://a.example.com');
  assert.equal(resolveLink(app, 'vpn', 'lan').url, 'http://10.0.0.1:80');
  assert.equal(resolveLink(app, 'vpn', 'vpn').url, 'http://10.0.0.1:80');
  assert.equal(resolveLink(undefined, 'lan', 'lan'), null);
});

test('normalizeUrl accepts host:port and rejects other schemes', () => {
  assert.equal(normalizeUrl('192.168.1.10:8989'), 'http://192.168.1.10:8989');
  assert.equal(normalizeUrl('https://x.example.com/'), 'https://x.example.com');
  assert.equal(normalizeUrl('homeserver:8096'), 'http://homeserver:8096');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('ftp://files'), null);
  assert.equal(normalizeUrl('  '), null);
});

test('slugify makes a url-safe id', () => {
  assert.equal(slugify('Home Assistant!'), 'home-assistant');
  assert.equal(slugify('***'), '');
});

test('addApp appends a usable card and de-duplicates ids', () => {
  const raw = base();
  const first = addApp(raw, { name: 'Sonarr', url: '10.0.0.5:8989', network: 'wan' });
  assert.equal(first.id, 'sonarr');
  assert.equal(first.urls.wan, 'http://10.0.0.5:8989');
  assert.equal(first.custom, true);

  const second = addApp(raw, { name: 'Sonarr', url: 'http://10.0.0.9' });
  assert.equal(second.id, 'sonarr-2', 'same name gets a suffixed id');

  const catalog = normalizeCatalog(raw);
  assert.equal(catalog.apps.length, 3);
});

test('addApp defaults an unknown network to the catalog default', () => {
  const raw = base();
  const entry = addApp(raw, { name: 'X', url: 'http://x', network: 'moon' });
  assert.deepEqual(Object.keys(entry.urls), ['lan']);
});

test('addApp rejects a missing name or bad url', () => {
  assert.throws(() => addApp(base(), { url: 'http://x' }), /Name is required/);
  assert.throws(() => addApp(base(), { name: 'X', url: 'ftp://x' }), /valid http/);
});

test('setAppUrl adds a network url to an existing app', () => {
  const raw = base();
  setAppUrl(raw, 'a', 'wan', 'https://new.example.com');
  assert.equal(raw.apps[0].urls.wan, 'https://new.example.com');
  assert.throws(() => setAppUrl(raw, 'missing', 'wan', 'http://x'), /Unknown app/);
});

test('readSettings defaults to port 80 and flags the default password', () => {
  const settings = readSettings({});
  assert.equal(settings.port, 80);
  assert.equal(settings.password, DEFAULT_PASSWORD);
  assert.equal(settings.usingDefaultPassword, true);

  const custom = readSettings({ PORT: '8787', DASHBOARD_PASSWORD: 'hunter2' });
  assert.equal(custom.port, 8787);
  assert.equal(custom.usingDefaultPassword, false);
});

test('removeApp reports whether it deleted anything', () => {
  const raw = base();
  assert.equal(removeApp(raw, 'a'), true);
  assert.equal(removeApp(raw, 'a'), false);
  assert.equal(raw.apps.length, 0);
});
