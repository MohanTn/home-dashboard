import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  firstComposeHostPort,
  listComposeDirs,
  listComposePorts,
  resolveComposeDir,
  StackManager,
} from '../src/compose.js';

function tree(root, spec) {
  for (const [rel, kind] of Object.entries(spec)) {
    const full = path.join(root, rel);
    if (kind === 'dir') fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
  }
}

test('listComposeDirs finds folders holding a compose file, relative to root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-'));
  tree(root, {
    'ytube-mp3/docker-compose.yml': 'file',
    'home-dashboard/compose.yaml': 'file',
    'nested/app/compose.yml': 'file',
    'no-compose/README.md': 'file',
    'node_modules/pkg/docker-compose.yml': 'file',
    'repo/.git/docker-compose.yml': 'file',
  });
  assert.deepEqual(listComposeDirs(root), ['home-dashboard', 'nested/app', 'ytube-mp3']);
});

test('resolveComposeDir selects the compose file in the app folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-'));
  fs.mkdirSync(path.join(root, 'ytube-mp3'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ytube-mp3', 'docker-compose.yml'), 'services: {}');

  const resolved = resolveComposeDir('ytube-mp3', root);
  assert.equal(resolved.dir, path.join(root, 'ytube-mp3'));
  assert.equal(resolved.file, path.join(root, 'ytube-mp3', 'docker-compose.yml'));
  assert.throws(() => resolveComposeDir('../outside', root), /stay inside/);
});

test('firstComposeHostPort reads short and long Compose port syntax', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-'));
  const short = path.join(root, 'short.yml');
  const long = path.join(root, 'long.yml');
  const inline = path.join(root, 'inline.yml');
  fs.writeFileSync(short, 'services:\n  app:\n    ports:\n      - "127.0.0.1:8989:80"\n');
  fs.writeFileSync(long, 'services:\n  app:\n    ports:\n      - target: 80\n        published: "8080"\n');
  fs.writeFileSync(inline, 'services:\n  app:\n    ports: ["9090:80"]\n');

  assert.equal(firstComposeHostPort(short), 8989);
  assert.equal(firstComposeHostPort(long), 8080);
  assert.equal(firstComposeHostPort(inline), 9090);
  assert.equal(firstComposeHostPort(path.join(root, 'missing.yml')), null);
});

test('listComposePorts returns the first host port per compose folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-'));
  fs.mkdirSync(path.join(root, 'ytube-mp3'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ytube-mp3', 'docker-compose.yml'),
    'services:\n  app:\n    ports:\n      - "8989:80"\n',
  );
  assert.deepEqual(listComposePorts(root), { 'ytube-mp3': 8989 });
});

test('StackManager marks a stack running when Compose reports a service running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-'));
  const folder = path.join(root, 'ytube-mp3');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'docker-compose.yml'), 'services: {}');

  const commands = [];
  const manager = new StackManager({
    root,
    run: async (file, args) => {
      commands.push({ file, args });
      return '';
    },
    probe: async () => false,
    running: async () => true,
    pollMs: 1,
  });

  const state = await manager.start({ id: 'ytube-mp3', compose: 'ytube-mp3', healthUrl: 'http://unreachable' });
  assert.equal(state.status, 'running');
  assert.deepEqual(commands, [
    { file: path.join(folder, 'docker-compose.yml'), args: ['up', '-d'] },
  ]);
});

test('listComposeDirs returns an empty list for a missing root', () => {
  assert.deepEqual(listComposeDirs(path.join(os.tmpdir(), 'does-not-exist-xyz')), []);
});

test('listComposeDirs does not descend beyond MAX_DEPTH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-'));
  const deep = path.join(root, ...Array(7).fill('a'));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'docker-compose.yml'), '');
  assert.deepEqual(listComposeDirs(root), []);
});
