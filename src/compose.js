import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

/**
 * Turn an app's `compose` folder into a real compose file path, refusing
 * anything that escapes the stacks root. Every docker command runs against the
 * file this returns, so the jail here is what keeps a catalog edit from
 * pointing the manager at an arbitrary directory.
 */
export function resolveComposeDir(dir, root) {
  const raw = String(dir ?? '').trim();
  if (!raw) throw new Error('This app has no compose folder');
  const base = path.resolve(root);
  const full = path.resolve(base, raw);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Compose folder must stay inside ${base}`);
  }
  const file = COMPOSE_FILES.map((name) => path.join(full, name)).find((f) =>
    fs.existsSync(f),
  );
  if (!file) throw new Error(`No compose file in ${full}`);
  return { dir: full, file };
}

const SKIP_DIRS = new Set([
  '.ai-memory',
  '.cache',
  '.claude',
  '.git',
  '.hg',
  '.next',
  '.pipeline-worker',
  '.svn',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'out',
  'target',
  'venv',
]);
const MAX_DEPTH = 5;

/**
 * Every folder under the stacks root that holds a compose file, as paths
 * relative to the root, for the UI's folder picker. Generated and dependency
 * folders are skipped so the walk stays fast on a large root.
 */
export function listComposeDirs(root) {
  const base = path.resolve(root);
  const dirs = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== base && COMPOSE_FILES.some((name) => fs.existsSync(path.join(dir, name)))) {
      dirs.push(path.relative(base, dir));
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(base, 0);
  return dirs.sort();
}

function firstPortNumber(value) {
  const match = String(value).trim().match(/^(\d{1,5})(?:-\d{1,5})?$/);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Read the first published host port from a Compose file. Supports short
 * syntax (`8080:80`, `127.0.0.1:8080:80`) and long syntax (`published: 8080`).
 */
export function firstComposeHostPort(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }

  let portsIndent = -1;
  for (const line of lines) {
    const content = line.replace(/\s+#.*$/, '');
    if (!content.trim()) continue;
    const indent = content.match(/^\s*/)[0].length;
    const trimmed = content.trim();
    const portsHeader = trimmed.match(/^ports\s*:\s*(.*)$/);

    if (portsHeader) {
      portsIndent = indent;
      const inline = portsHeader[1].trim();
      if (inline.startsWith('[')) {
        const first = inline.match(/["']([^"']+)["']/);
        if (first) {
          const parts = first[1].split('/')[0].split(':');
          const port = parts.length === 2
            ? firstPortNumber(parts[0])
            : parts.length >= 3
              ? firstPortNumber(parts[parts.length - 2])
              : null;
          if (port) return port;
        }
      }
      if (!inline) continue;
    }
    if (portsIndent < 0) continue;
    if (indent <= portsIndent) {
      portsIndent = -1;
      continue;
    }

    const published = trimmed.match(/^published\s*:\s*["']?(\d{1,5})/);
    if (published) return firstPortNumber(published[1]);

    const short = trimmed.match(/^[-]\s*["']?([^"']+?)["']?\s*$/);
    if (!short) continue;
    const value = short[1].trim().split('/')[0];
    const parts = value.split(':');
    const hostPort = parts.length === 2
      ? firstPortNumber(parts[0])
      : parts.length >= 3
        ? firstPortNumber(parts[parts.length - 2])
        : null;
    if (hostPort) return hostPort;
  }
  return null;
}

/** Return folders and their first published host-port defaults for the picker. */
export function listComposePorts(root) {
  const base = path.resolve(root);
  const ports = {};
  for (const dir of listComposeDirs(base)) {
    try {
      const { file } = resolveComposeDir(dir, base);
      const port = firstComposeHostPort(file);
      if (port) ports[dir] = port;
    } catch {
      // A compose file may disappear between the directory scan and read.
    }
  }
  return ports;
}

/** Default runner: `docker compose -f <file> <args...>` in the stack folder. */
export async function dockerCompose(file, args) {
  const { stdout } = await execFileAsync('docker', ['compose', '-f', file, ...args], {
    cwd: path.dirname(file),
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/** Return true when Compose reports at least one service in the stack running. */
export async function dockerComposeRunning(file) {
  try {
    const output = await dockerCompose(file, ['ps', '--status', 'running', '--services']);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

async function httpProbe(url) {
  try {
    await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tracks one compose stack per app id: brings it up on demand, reports what it
 * is doing while the containers boot, and takes it back down once nobody has
 * opened it for `idleMs`. State lives in memory only, a manager restart just
 * means the next click re-runs `up -d` on an already-running stack, which is a
 * no-op.
 */
export class StackManager {
  constructor(options = {}) {
    this.root = options.root ?? process.cwd();
    this.run = options.run ?? dockerCompose;
    this.probe = options.probe ?? httpProbe;
    this.running = options.running ?? dockerComposeRunning;
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 6 * 60 * 60 * 1000;
    this.startTimeoutMs = options.startTimeoutMs ?? 120_000;
    this.pollMs = options.pollMs ?? 1500;
    this.stacks = new Map();
  }

  entry(id) {
    let entry = this.stacks.get(id);
    if (!entry) {
      entry = { status: 'unknown', error: '', lastUsedAt: 0, pending: null, generation: 0 };
      this.stacks.set(id, entry);
    }
    return entry;
  }

  /** What the UI shows: unknown | starting | running | stopping | stopped | error. */
  snapshot(id) {
    const { status, error, lastUsedAt } = this.entry(id);
    return { status, error, lastUsedAt };
  }

  /** Record that someone used the app, so the idle sweep leaves it alone. */
  touch(id) {
    this.entry(id).lastUsedAt = this.now();
  }

  /**
   * Bring the stack up and wait until Compose reports a running service or the
   * app health URL answers. Concurrent clicks share one start, so a double-click
   * never runs `up -d` twice.
   */
  start(app) {
    const entry = this.entry(app.id);
    entry.lastUsedAt = this.now();
    if (entry.pending) return entry.pending;
    entry.status = 'starting';
    entry.error = '';
    entry.generation += 1;
    const generation = entry.generation;
    entry.pending = this.#bringUp(app, generation).finally(() => {
      entry.pending = null;
    });
    return entry.pending;
  }

  /**
   * A stop that lands while this is still booting bumps the generation, and
   * the stale start then leaves the recorded state alone.
   */
  async #bringUp(app, generation) {
    const entry = this.entry(app.id);
    const stale = () => entry.generation !== generation;
    try {
      const { file } = resolveComposeDir(app.compose, this.root);
      await this.run(file, ['up', '-d']);
      const deadline = this.now() + this.startTimeoutMs;
      while (this.now() < deadline) {
        if (stale()) return this.snapshot(app.id);
        const reachable = await this.probe(app.healthUrl);
        const composeRunning = await this.running(file);
        if (reachable || composeRunning) {
          if (stale()) return this.snapshot(app.id);
          entry.status = 'running';
          entry.lastUsedAt = this.now();
          return this.snapshot(app.id);
        }
        await this.sleep(this.pollMs);
      }
      throw new Error('Containers started but the app never answered');
    } catch (err) {
      if (stale()) return this.snapshot(app.id);
      entry.status = 'error';
      entry.error = err.message;
      return this.snapshot(app.id);
    }
  }

  async stop(app) {
    const entry = this.entry(app.id);
    entry.status = 'stopping';
    entry.generation += 1;
    try {
      const { file } = resolveComposeDir(app.compose, this.root);
      await this.run(file, ['down']);
      entry.status = 'stopped';
      entry.error = '';
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
    }
    return this.snapshot(app.id);
  }

  /** Apps that are up but untouched for longer than the idle window. */
  idleApps(apps) {
    const cutoff = this.now() - this.idleMs;
    return apps.filter((app) => {
      if (!app.compose) return false;
      const entry = this.stacks.get(app.id);
      return Boolean(entry) && entry.status === 'running' && entry.lastUsedAt <= cutoff;
    });
  }

  /** Take every idle stack down. Returns the ids it stopped. */
  async sweep(apps) {
    const targets = this.idleApps(apps);
    for (const app of targets) await this.stop(app);
    return targets.map((app) => app.id);
  }

  /**
   * Fold HTTP and Compose observations into the tracked state. A stack that is
   * still starting stays there until Compose confirms a running service.
   */
  observe(id, reachable, composeRunning = false) {
    const entry = this.entry(id);
    if (entry.status === 'stopping') return entry.status;
    if (entry.status === 'starting' && !composeRunning) return entry.status;
    if (reachable || composeRunning) {
      if (entry.status !== 'running') entry.status = 'running';
      if (!entry.lastUsedAt) entry.lastUsedAt = this.now();
      entry.error = '';
    } else if (entry.status !== 'error') {
      entry.status = 'stopped';
    }
    return entry.status;
  }

  /** Reconcile a managed app against both Compose and its optional URL. */
  async observeApp(app, reachable) {
    let composeRunning = false;
    try {
      const { file } = resolveComposeDir(app.compose, this.root);
      composeRunning = await this.running(file);
    } catch {
      // Startup will surface an invalid compose folder as an error; health
      // refresh should remain best-effort for the rest of the dashboard.
    }
    return this.observe(app.id, reachable, composeRunning);
  }
}
