import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { JsonStore } from './models/jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export async function bootstrapRuntimeDirs() {
  await fs.mkdir(path.join(ROOT_DIR, 'storage/uploads'), { recursive: true });
  await fs.mkdir(path.join(ROOT_DIR, 'storage/exports'), { recursive: true });
  await fs.mkdir(path.join(ROOT_DIR, 'storage/projects'), { recursive: true });

  await Promise.all([
    new JsonStore(path.join(ROOT_DIR, 'data/projects.json'), []).ensureInitialized(),
    new JsonStore(path.join(ROOT_DIR, 'data/catalogs.json'), []).ensureInitialized(),
    new JsonStore(path.join(ROOT_DIR, 'data/stock.json'), []).ensureInitialized(),
    new JsonStore(path.join(ROOT_DIR, 'data/gallery.json'), []).ensureInitialized(),
  ]);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectExecution) {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '0.0.0.0';

  await bootstrapRuntimeDirs();
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`GuíaMosaico MVC ejecutándose en http://localhost:${PORT}`);
  });
}
