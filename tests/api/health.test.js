import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { JsonStore } from '../../src/models/jsonStore.js';

test('Express MVC responde GET /api/health y GET / en HTTP 200', async () => {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthRes.status, 200);
    const body = await healthRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.architecture, 'MVC-Express-JSON');

    const homeRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(homeRes.status, 200);
    const html = await homeRes.text();
    assert.match(html, /GuíaMosaico/);
    assert.match(html, /tokens\.css/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('JsonStore realiza escrituras atómicas concurrentes sin corromper JSON', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gm-store-'));
  const filePath = path.join(tmpDir, 'items.json');
  const store = new JsonStore(filePath, []);

  try {
    await Promise.all([
      store.update((arr) => [...arr, 1]),
      store.update((arr) => [...arr, 2]),
      store.update((arr) => [...arr, 3]),
    ]);
    const final = await store.read();
    assert.deepEqual(final, [1, 2, 3]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
