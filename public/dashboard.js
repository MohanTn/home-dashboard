const grid = document.getElementById('grid');
const search = document.getElementById('search');
const networksEl = document.getElementById('networks');
const emptyEl = document.getElementById('empty');
const dialog = document.getElementById('dialog');
const addForm = document.getElementById('add-form');
const addError = document.getElementById('add-error');
const iconDialog = document.getElementById('icon-dialog');
const iconGrid = document.getElementById('icon-grid');
const composeDialog = document.getElementById('compose-dialog');
const overlay = document.getElementById('overlay');

const NETWORK_KEY = 'home-dashboard:network';
const POLL_MS = 1500;
const START_TIMEOUT_MS = 150_000;

let catalog = { networks: [], apps: [], icons: [], defaultNetwork: 'lan', idleHours: 6 };
let network = null;
let query = '';
let statuses = {};
let composeDirs = [];
let composePorts = {};
let composeApp = null;
let autoPort = '';

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const goUrl = (id, net) => `/go/${encodeURIComponent(id)}?net=${encodeURIComponent(net)}`;

async function api(url, options) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.replace('/login');
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------- starting overlay ---------- */

function showOverlay(app, message) {
  document.getElementById('overlay-icon').textContent = app.icon;
  document.getElementById('overlay-title').textContent = `Starting ${app.name}`;
  document.getElementById('overlay-msg').textContent = message;
  document.getElementById('overlay-spinner').hidden = false;
  document.getElementById('overlay-retry').hidden = true;
  overlay.hidden = false;
}

function overlayFailed(message) {
  document.getElementById('overlay-title').textContent = 'Could not start';
  document.getElementById('overlay-msg').textContent = message;
  document.getElementById('overlay-spinner').hidden = true;
  document.getElementById('overlay-retry').hidden = false;
}

function hideOverlay() {
  overlay.hidden = true;
  document.getElementById('overlay-retry').onclick = null;
}

/**
 * Managed app: bring the stack up, hold the user on a loader while the
 * containers boot, then hand them over. Unmanaged cards just open.
 */
async function openApp(app, net) {
  if (!app.compose) {
    window.open(goUrl(app.id, net), '_blank', 'noopener');
    return;
  }
  if (statuses[app.id] === 'running' || statuses[app.id] === 'up') {
    window.location.href = goUrl(app.id, net);
    return;
  }

  showOverlay(app, 'Bringing the containers up…');
  document.getElementById('overlay-retry').onclick = () => openApp(app, net);
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}/start`, { method: 'POST' });
  } catch (err) {
    overlayFailed(err.message);
    return;
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let state;
    try {
      state = await api(`/api/apps/${encodeURIComponent(app.id)}/state`);
    } catch {
      continue;
    }
    statuses[app.id] = state.status;
    if (state.status === 'running') {
      document.getElementById('overlay-msg').textContent = `${app.name} is up, taking you there…`;
      window.location.href = goUrl(app.id, net);
      return;
    }
    if (state.status === 'error') {
      overlayFailed(state.error || 'The stack failed to start');
      return;
    }
  }
  overlayFailed('Timed out waiting for the app to answer');
}

/* ---------- icon picker ---------- */

function iconButtons(target, selected, onPick) {
  target.replaceChildren();
  for (const icon of catalog.icons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `icon-option${icon === selected ? ' selected' : ''}`;
    button.textContent = icon;
    button.title = icon;
    button.addEventListener('click', () => onPick(icon, button));
    target.append(button);
  }
}

function openIconPicker(app) {
  iconButtons(iconGrid, app.icon, async (icon) => {
    iconDialog.close();
    try {
      await api(`/api/apps/${encodeURIComponent(app.id)}/icon`, {
        method: 'POST',
        body: JSON.stringify({ icon }),
      });
      await load();
    } catch (err) {
      alert(err.message);
    }
  });
  iconDialog.showModal();
}

/* ---------- compose folder picker ---------- */

async function ensureComposeDirs() {
  if (composeDirs.length) return;
  try {
    const data = await api('/api/compose-dirs');
    composeDirs = data.dirs || [];
    composePorts = data.ports || {};
  } catch {
    composeDirs = [];
    composePorts = {};
  }
}

function fillComposeSelect(select, selected) {
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None (plain link card)';
  none.selected = !selected;
  select.append(none);
  for (const dir of composeDirs) {
    const option = document.createElement('option');
    option.value = dir;
    option.textContent = dir;
    option.selected = dir === selected;
    select.append(option);
  }
}

async function openComposeDialog(app) {
  composeApp = app;
  document.getElementById('compose-app').textContent = app.name;
  document.getElementById('compose-error').hidden = true;
  await ensureComposeDirs();
  fillComposeSelect(document.getElementById('compose-select'), app.compose);
  composeDialog.showModal();
}

/* ---------- cards ---------- */

const STATE_LABEL = {
  running: 'Running',
  up: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  down: 'Offline',
  error: 'Error',
  unknown: 'Unknown',
};

function card(app) {
  const el = document.createElement('article');
  el.className = 'card';
  el.tabIndex = 0;
  el.setAttribute('role', 'link');
  el.setAttribute('aria-label', `Open ${app.name}`);

  const hasNetwork = app.links.some((l) => l.network === network);
  const target = hasNetwork ? network : app.links[0].network;
  const missing = catalog.networks.find((n) => n.id === network && !hasNetwork);
  const state = statuses[app.id] || 'unknown';

  const chips = app.links
    .map(
      (link) =>
        `<a class="chip${link.network === target ? ' chip-active' : ''}" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`,
    )
    .join('');

  el.innerHTML = `
    <div class="card-head">
      <button class="card-icon" type="button" title="Change icon" aria-label="Change icon for ${escapeHtml(app.name)}">${escapeHtml(app.icon)}</button>
      <span class="card-tools">
        <span class="status" data-app="${escapeHtml(app.id)}" data-state="${escapeHtml(state)}" title="${escapeHtml(STATE_LABEL[state] ?? state)}" aria-hidden="true"></span>
        <button class="remove" type="button" title="Remove card" aria-label="Remove ${escapeHtml(app.name)}">×</button>
      </span>
    </div>
    <h3>${escapeHtml(app.name)}</h3>
    <p class="muted">${escapeHtml(app.description)}</p>
    ${
      app.compose
        ? `<p class="stack"><span class="state state-${escapeHtml(state)}" data-state-app="${escapeHtml(app.id)}">${escapeHtml(STATE_LABEL[state] ?? state)}</span><code title="compose folder">${escapeHtml(app.compose)}</code><button class="compose-edit" type="button" title="Change compose folder" aria-label="Change compose folder for ${escapeHtml(app.name)}">📁</button></p>`
        : '<p class="stack"><span class="state state-link">Link only</span></p>'
    }
    <div class="chips">
      ${chips}
      ${missing ? `<button class="chip chip-add" type="button">+ ${escapeHtml(missing.label)}</button>` : ''}
      ${app.compose ? '<button class="chip chip-stop" type="button">Stop</button>' : ''}
    </div>
  `;

  el.querySelector('.card-icon').addEventListener('click', (event) => {
    event.stopPropagation();
    openIconPicker(app);
  });

  el.querySelector('.remove').addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!confirm(`Remove ${app.name} from the dashboard?`)) return;
    await api(`/api/apps/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
    await load();
  });

  el.querySelector('.chip-stop')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!confirm(`Stop the ${app.name} containers now?`)) return;
    try {
      const state = await api(`/api/apps/${encodeURIComponent(app.id)}/stop`, {
        method: 'POST',
      });
      statuses[app.id] = state.status;
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  el.querySelector('.compose-edit')?.addEventListener('click', (event) => {
    event.stopPropagation();
    openComposeDialog(app);
  });

  el.querySelector('.chip-add')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const url = prompt(`${missing.label} URL for ${app.name}`, '');
    if (!url) return;
    try {
      await api(`/api/apps/${encodeURIComponent(app.id)}/url`, {
        method: 'POST',
        body: JSON.stringify({ network: missing.id, url }),
      });
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  el.addEventListener('click', (event) => {
    if (event.target.closest('.chip, .remove, .card-icon, .compose-edit')) return;
    openApp(app, target);
  });
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openApp(app, target);
    }
  });
  return el;
}

function addTile() {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card card-add';
  el.innerHTML =
    '<span class="card-icon">＋</span><h3>Add app</h3><p class="muted">Name, address, port and compose folder</p>';
  el.addEventListener('click', openDialog);
  return el;
}

function visibleApps() {
  const q = query.trim().toLowerCase();
  if (!q) return catalog.apps;
  return catalog.apps.filter((app) =>
    `${app.name} ${app.description} ${app.category} ${app.compose}`.toLowerCase().includes(q),
  );
}

function render() {
  const apps = visibleApps();
  grid.replaceChildren();
  emptyEl.hidden = apps.length > 0;

  const categories = [...new Set(apps.map((a) => a.category))];
  categories.forEach((category, index) => {
    const section = document.createElement('section');
    section.className = 'group';
    const heading = document.createElement('h2');
    heading.textContent = category;
    const row = document.createElement('div');
    row.className = 'cards';
    for (const app of apps.filter((a) => a.category === category)) {
      row.append(card(app));
    }
    if (index === categories.length - 1 && !query) row.append(addTile());
    section.append(heading, row);
    grid.append(section);
  });
  if (!categories.length && !query) {
    const row = document.createElement('div');
    row.className = 'cards';
    row.append(addTile());
    grid.append(row);
  }
}

function renderNetworks() {
  networksEl.replaceChildren();
  for (const net of catalog.networks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = net.label;
    button.title = net.hint || net.label;
    button.className = net.id === network ? 'active' : '';
    button.addEventListener('click', () => {
      network = net.id;
      localStorage.setItem(NETWORK_KEY, net.id);
      renderNetworks();
      render();
    });
    networksEl.append(button);
  }
}

/* ---------- add dialog ---------- */

async function openDialog() {
  await ensureComposeDirs();
  addError.hidden = true;
  addForm.reset();
  autoPort = '';
  const select = document.getElementById('network-select');
  select.replaceChildren();
  for (const net of catalog.networks) {
    const option = document.createElement('option');
    option.value = net.id;
    option.textContent = net.label;
    option.selected = net.id === network;
    select.append(option);
  }
  const chosen = catalog.icons[0] ?? '📦';
  addForm.elements.icon.value = chosen;
  iconButtons(document.getElementById('add-icons'), chosen, (icon, button) => {
    addForm.elements.icon.value = icon;
    for (const other of button.parentElement.children) other.classList.remove('selected');
    button.classList.add('selected');
  });
  fillComposeSelect(addForm.elements.compose, '');
  dialog.showModal();
  addForm.elements.name.focus();
}

document.getElementById('add-compose').addEventListener('change', (event) => {
  const port = composePorts[event.target.value];
  if (autoPort && addForm.elements.port.value === autoPort) {
    addForm.elements.port.value = '';
  }
  autoPort = port ? String(port) : '';
  if (port) addForm.elements.port.value = port;
});

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  addError.hidden = true;
  const body = Object.fromEntries(new FormData(addForm));
  try {
    await api('/api/apps', { method: 'POST', body: JSON.stringify(body) });
    dialog.close();
    await load();
  } catch (err) {
    addError.textContent = err.message;
    addError.hidden = false;
  }
});

async function refreshHealth() {
  try {
    const data = await api('/api/health');
    statuses = data.statuses;
    for (const dot of document.querySelectorAll('.status')) {
      const state = statuses[dot.dataset.app] || 'unknown';
      dot.dataset.state = state;
      dot.title = STATE_LABEL[state] ?? state;
    }
    for (const pill of document.querySelectorAll('[data-state-app]')) {
      const state = statuses[pill.dataset.stateApp];
      if (!state) continue;
      pill.className = `state state-${state}`;
      pill.textContent = STATE_LABEL[state] ?? state;
    }
  } catch {
    /* health is decoration, never block the launcher on it */
  }
}

async function load() {
  catalog = await api('/api/apps');
  document.getElementById('title').textContent = catalog.title;
  document.getElementById('subtitle').textContent = catalog.subtitle;
  document.getElementById('warning').hidden = !catalog.usingDefaultPassword;
  document.getElementById('idle-note').textContent =
    `Idle stacks shut down after ${catalog.idleHours}h`;
  const saved = localStorage.getItem(NETWORK_KEY);
  network = catalog.networks.some((n) => n.id === saved) ? saved : catalog.defaultNetwork;
  renderNetworks();
  render();
  await refreshHealth();
  render();
  ensureComposeDirs();
}

search.addEventListener('input', () => {
  query = search.value;
  render();
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== search && !dialog.open) {
    event.preventDefault();
    search.focus();
  }
});

document.getElementById('add').addEventListener('click', openDialog);
document.getElementById('cancel').addEventListener('click', () => dialog.close());
document.getElementById('icon-cancel').addEventListener('click', () => iconDialog.close());
document.getElementById('compose-cancel').addEventListener('click', () => composeDialog.close());
document.getElementById('compose-save').addEventListener('click', async () => {
  if (!composeApp) return;
  const error = document.getElementById('compose-error');
  error.hidden = true;
  try {
    await api(`/api/apps/${encodeURIComponent(composeApp.id)}/compose`, {
      method: 'POST',
      body: JSON.stringify({ compose: document.getElementById('compose-select').value }),
    });
    composeDialog.close();
    await load();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});
document.getElementById('overlay-close').addEventListener('click', hideOverlay);

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.replace('/login');
});

load();
setInterval(refreshHealth, 30_000);
