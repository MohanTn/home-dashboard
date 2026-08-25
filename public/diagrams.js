const $ = (id) => document.getElementById(id);

const codeEl = $('code');
const configEl = $('config');
const gutter = $('gutter');
const statusEl = $('status');
const stage = $('stage');
const canvas = $('canvas');
const zoomLevel = $('zoom-level');
const panzoomToggle = $('panzoom');

const DEFAULT_CONFIG = '{\n  "flowchart": {\n    "curve": "basis"\n  }\n}';

const SAMPLES = {
  Flowchart: `graph TD
    A[Christmas] -->|Get money| B(Go shopping)
    B --> C{Let me think}
    C -->|One| D[Laptop]
    C -->|Two| E[iPhone]
    C -->|Three| F[fa:fa-car Car]`,
  Sequence: `sequenceDiagram
    autonumber
    Alice->>John: Hello John, how are you?
    loop Healthcheck
        John->>John: Fight against hypochondria
    end
    Note right of John: Rational thoughts!
    John-->>Alice: Great!
    John->>Bob: How about you?
    Bob-->>John: Jolly good!`,
  Class: `classDiagram
    Animal <|-- Duck
    Animal <|-- Fish
    Animal <|-- Zebra
    Animal : +int age
    Animal : +String gender
    Animal: +isMammal()
    class Duck{
      +String beakColor
      +swim()
      +quack()
    }`,
  State: `stateDiagram-v2
    [*] --> Still
    Still --> [*]
    Still --> Moving
    Moving --> Still
    Moving --> Crash
    Crash --> [*]`,
  'Entity Relationship': `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER }|..|{ DELIVERY-ADDRESS : uses`,
  Gantt: `gantt
    title A Gantt Diagram
    dateFormat YYYY-MM-DD
    section Section
    A task           :a1, 2014-01-01, 30d
    Another task     :after a1, 20d
    section Another
    Task in Another  :2014-01-12, 12d
    another task     :24d`,
  Pie: `pie title Pets adopted by volunteers
    "Dogs" : 386
    "Cats" : 85
    "Rats" : 15`,
  'Git graph': `gitGraph
    commit
    commit
    branch develop
    checkout develop
    commit
    commit
    checkout main
    merge develop
    commit`,
  Mindmap: `mindmap
  root((mindmap))
    Origins
      Long history
      Popularisation
    Research
      On effectiveness
    Tools
      Pen and paper
      Mermaid`,
};

let view = { scale: 1, x: 0, y: 0 };
let lastGoodSvg = '';
let renderToken = 0;

/* ---------- editor chrome ---------- */

function syncGutter() {
  const lines = codeEl.value.split('\n').length;
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  gutter.scrollTop = codeEl.scrollTop;
}

codeEl.addEventListener('scroll', () => {
  gutter.scrollTop = codeEl.scrollTop;
});

/** Tab inserts spaces instead of leaving the textarea, like a real editor. */
codeEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const { selectionStart: start, selectionEnd: end, value } = codeEl;
  codeEl.value = `${value.slice(0, start)}  ${value.slice(end)}`;
  codeEl.selectionStart = codeEl.selectionEnd = start + 2;
  scheduleRender();
});

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs button')) {
      other.classList.toggle('active', other === tab);
    }
    for (const pane of document.querySelectorAll('[data-pane]')) {
      pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    }
  });
}

/* ---------- rendering ---------- */

function setStatus(message, kind = 'ok') {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function parseConfig() {
  const text = configEl.value.trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function renderDiagram() {
  const token = ++renderToken;
  const source = codeEl.value.trim();
  syncGutter();
  updateHash();

  if (!source) {
    stage.replaceChildren();
    lastGoodSvg = '';
    setStatus('Nothing to render');
    return;
  }

  let config;
  try {
    config = parseConfig();
  } catch (err) {
    setStatus(`Config is not valid JSON: ${err.message}`, 'error');
    return;
  }

  try {
    mermaid.initialize({
      startOnLoad: false,
      // Diagram text is untrusted input, so labels stay sanitized.
      securityLevel: 'strict',
      theme: $('theme').value,
      ...config,
    });
    const id = `mmd-${token}`;
    const { svg } = await mermaid.render(id, source);
    if (token !== renderToken) return;
    lastGoodSvg = svg;
    stage.innerHTML = svg;
    prepareSvg();
    setStatus('Rendered');
  } catch (err) {
    if (token !== renderToken) return;
    // mermaid drops a stray error node into the body when parsing fails.
    document.getElementById(`dmmd-${token}`)?.remove();
    document.getElementById(`mmd-${token}`)?.remove();
    setStatus(cleanError(err), 'error');
  }
}

function cleanError(err) {
  const message = String(err?.str || err?.message || err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** Strip mermaid's responsive sizing so our own zoom controls the scale. */
function prepareSvg() {
  const svg = stage.querySelector('svg');
  if (!svg) return;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.maxWidth = 'none';
  const box = svg.viewBox?.baseVal;
  if (box?.width) {
    svg.style.width = `${box.width}px`;
    svg.style.height = `${box.height}px`;
  }
  fitToView();
}

let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderDiagram, 300);
}

codeEl.addEventListener('input', scheduleRender);
configEl.addEventListener('input', scheduleRender);
$('theme').addEventListener('change', renderDiagram);

/* ---------- pan and zoom ---------- */

function applyView() {
  stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomLevel.textContent = `${Math.round(view.scale * 100)}%`;
}

function zoomBy(factor, originX, originY) {
  if (!panzoomToggle.checked) return;
  const next = Math.min(8, Math.max(0.1, view.scale * factor));
  const rect = canvas.getBoundingClientRect();
  const cx = (originX ?? rect.width / 2) - view.x;
  const cy = (originY ?? rect.height / 2) - view.y;
  const ratio = next / view.scale;
  view.x -= cx * (ratio - 1);
  view.y -= cy * (ratio - 1);
  view.scale = next;
  applyView();
}

function fitToView() {
  const svg = stage.querySelector('svg');
  if (!svg) return;
  const box = svg.viewBox?.baseVal;
  const width = box?.width || svg.getBoundingClientRect().width;
  const height = box?.height || svg.getBoundingClientRect().height;
  if (!width || !height) return;
  const rect = canvas.getBoundingClientRect();
  const padding = 32;
  const scale = Math.min(
    (rect.width - padding) / width,
    (rect.height - padding) / height,
    2,
  );
  view.scale = Math.max(scale, 0.1);
  view.x = (rect.width - width * view.scale) / 2;
  view.y = (rect.height - height * view.scale) / 2;
  applyView();
}

canvas.addEventListener(
  'wheel',
  (event) => {
    if (!panzoomToggle.checked) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomBy(
      event.deltaY < 0 ? 1.12 : 1 / 1.12,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  },
  { passive: false },
);

let drag = null;
canvas.addEventListener('pointerdown', (event) => {
  if (!panzoomToggle.checked) return;
  drag = { x: event.clientX - view.x, y: event.clientY - view.y };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('grabbing');
});

canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  view.x = event.clientX - drag.x;
  view.y = event.clientY - drag.y;
  applyView();
});

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  canvas.addEventListener(type, () => {
    drag = null;
    canvas.classList.remove('grabbing');
  });
}

$('zoom-in').addEventListener('click', () => zoomBy(1.25));
$('zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
$('fit').addEventListener('click', fitToView);
$('reset').addEventListener('click', () => {
  view = { scale: 1, x: 0, y: 0 };
  applyView();
});
panzoomToggle.addEventListener('change', () => {
  canvas.classList.toggle('static', !panzoomToggle.checked);
});

/* ---------- export and sharing ---------- */

/** navigator.clipboard needs a secure context, which a LAN http:// host is not. */
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${label} copied`);
    return;
  } catch {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.append(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    setStatus(ok ? `${label} copied` : `Could not copy ${label}`, ok ? 'ok' : 'error');
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('copy-code').addEventListener('click', () => copyText(codeEl.value, 'Code'));
$('copy-svg').addEventListener('click', () => {
  if (!lastGoodSvg) return setStatus('Nothing rendered yet', 'error');
  copyText(lastGoodSvg, 'SVG');
});

$('save-svg').addEventListener('click', () => {
  if (!lastGoodSvg) return setStatus('Nothing rendered yet', 'error');
  download(new Blob([lastGoodSvg], { type: 'image/svg+xml' }), 'diagram.svg');
});

$('save-png').addEventListener('click', async () => {
  const svg = stage.querySelector('svg');
  if (!svg) return setStatus('Nothing rendered yet', 'error');
  const box = svg.viewBox?.baseVal;
  const width = Math.ceil(box?.width || svg.getBoundingClientRect().width);
  const height = Math.ceil(box?.height || svg.getBoundingClientRect().height);
  const scale = 2;

  const source = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  const image = new Image();
  image.decoding = 'sync';
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('render failed'));
    image.src = url;
  }).catch(() => setStatus('Could not rasterize this diagram', 'error'));

  const target = document.createElement('canvas');
  target.width = width * scale;
  target.height = height * scale;
  const ctx = target.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(image, 0, 0, target.width, target.height);
  URL.revokeObjectURL(url);
  target.toBlob((blob) => {
    if (!blob) return setStatus('Could not rasterize this diagram', 'error');
    download(blob, 'diagram.png');
    setStatus('PNG saved');
  }, 'image/png');
});

/* ---------- shareable state in the URL ---------- */

function updateHash() {
  const state = {
    code: codeEl.value,
    config: configEl.value,
    theme: $('theme').value,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  history.replaceState(null, '', `#state=${base64}`);
}

function readHash() {
  const match = /#state=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

$('share').addEventListener('click', () => {
  updateHash();
  copyText(window.location.href, 'Link');
});

/* ---------- layout ---------- */

$('toggle-editor').addEventListener('click', (event) => {
  const hidden = document.body.classList.toggle('editor-hidden');
  event.target.textContent = hidden ? 'Show editor' : 'Hide editor';
  setTimeout(fitToView, 60);
});

let splitDrag = false;
$('splitter').addEventListener('pointerdown', (event) => {
  splitDrag = true;
  $('splitter').setPointerCapture(event.pointerId);
});
window.addEventListener('pointermove', (event) => {
  if (!splitDrag) return;
  const percent = Math.min(75, Math.max(15, (event.clientX / window.innerWidth) * 100));
  $('split').style.gridTemplateColumns = `${percent}% 6px 1fr`;
});
window.addEventListener('pointerup', () => {
  if (!splitDrag) return;
  splitDrag = false;
  fitToView();
});

window.addEventListener('resize', () => fitToView());

/* ---------- boot ---------- */

for (const name of Object.keys(SAMPLES)) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  $('sample').append(option);
}

$('sample').addEventListener('change', (event) => {
  const sample = SAMPLES[event.target.value];
  if (!sample) return;
  codeEl.value = sample;
  event.target.value = '';
  renderDiagram();
});

const saved = readHash();
codeEl.value = saved?.code ?? SAMPLES.Flowchart;
configEl.value = saved?.config ?? DEFAULT_CONFIG;
if (saved?.theme) $('theme').value = saved.theme;
$('lib').textContent = `mermaid ${mermaid.version?.() ?? ''}`.trim();

applyView();
renderDiagram();
