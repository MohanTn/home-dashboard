const grid = document.getElementById('grid');
const search = document.getElementById('search');
const networksEl = document.getElementById('networks');
const emptyEl = document.getElementById('empty');
const dialog = document.getElementById('dialog');
const addForm = document.getElementById('add-form');
const addError = document.getElementById('add-error');

const NETWORK_KEY = 'home-dashboard:network';
let catalog = { networks: [], apps: [], defaultNetwork: 'lan' };
let network = null;
let query = '';

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Open an app in a new tab through the server-side redirect router. */
function openApp(id, net) {
  window.open(`/go/${encodeURIComponent(id)}?net=${encodeURIComponent(net)}`, '_blank', 'noopener');
}

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

function visibleApps() {
  const q = query.trim().toLowerCase();
  if (!q) return catalog.apps;
  return catalog.apps.filter((app) =>
    `${app.name} ${app.description} ${app.category}`.toLowerCase().includes(q),
  );
}

function card(app) {
  const el = document.createElement('article');
  el.className = 'card';
  el.tabIndex = 0;
  el.setAttribute('role', 'link');
  el.setAttribute('aria-label', `Open ${app.name}`);

  const hasNetwork = app.links.some((l) => l.network === network);
  const target = hasNetwork ? network : app.links[0].network;
  const missing = catalog.networks.find((n) => n.id === network && !hasNetwork);

  const chips = app.links
    .map(
      (link) =>
        `<a class="chip${link.network === target ? ' chip-active' : ''}" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`,
    )
    .join('');

  el.innerHTML = `
    <div class="card-head">
      <span class="card-icon" aria-hidden="true">${escapeHtml(app.icon)}</span>
      <span class="card-tools">
        <span class="status" data-app="${escapeHtml(app.id)}" aria-hidden="true"></span>
        <button class="remove" type="button" title="Remove card" aria-label="Remove ${escapeHtml(app.name)}">×</button>
      </span>
    </div>
    <h3>${escapeHtml(app.name)}</h3>
    <p class="muted">${escapeHtml(app.description)}</p>
    <div class="chips">
      ${chips}
      ${missing ? `<button class="chip chip-add" type="button">+ ${escapeHtml(missing.label)}</button>` : ''}
    </div>
  `;

  el.querySelector('.remove').addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!confirm(`Remove ${app.name} from the dashboard?`)) return;
    await api(`/api/apps/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
    await load();
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
    if (event.target.closest('.chip, .remove')) return;
    openApp(app.id, target);
  });
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openApp(app.id, target);
    }
  });
  return el;
}

function addTile() {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card card-add';
  el.innerHTML = '<span class="card-icon">＋</span><h3>Add app</h3><p class="muted">Name and URL</p>';
  el.addEventListener('click', openDialog);
  return el;
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
  refreshHealth();
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

function openDialog() {
  addError.hidden = true;
  addForm.reset();
  const select = document.getElementById('network-select');
  select.replaceChildren();
  for (const net of catalog.networks) {
    const option = document.createElement('option');
    option.value = net.id;
    option.textContent = net.label;
    option.selected = net.id === network;
    select.append(option);
  }
  dialog.showModal();
  addForm.elements.name.focus();
}

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
    const { statuses } = await api('/api/health');
    for (const dot of document.querySelectorAll('.status')) {
      const state = statuses[dot.dataset.app] || 'unknown';
      dot.dataset.state = state;
      dot.title = state === 'up' ? 'Reachable from the server' : 'Not responding';
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
  const saved = localStorage.getItem(NETWORK_KEY);
  network = catalog.networks.some((n) => n.id === saved) ? saved : catalog.defaultNetwork;
  renderNetworks();
  render();
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

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.replace('/login');
});

load();
setInterval(refreshHealth, 30_000);
