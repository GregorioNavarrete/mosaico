import fs from 'node:fs/promises';
import path from 'node:path';

const writeQueues = new Map();

/**
 * Almacén JSON local con escritura atómica (.tmp -> rename) y cola serializada por archivo
 * para evitar corrupción ante escrituras concurrentes.
 */
export class JsonStore {
  /**
   * @param {string} filePath
   * @param {any} defaultValue
   */
  constructor(filePath, defaultValue = []) {
    this.filePath = path.resolve(filePath);
    this.defaultValue = defaultValue;
  }

  async ensureInitialized() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write(structuredClone(this.defaultValue));
    }
  }

  async read() {
    await this.ensureInitialized();
    const raw = await fs.readFile(this.filePath, 'utf8');
    return JSON.parse(raw);
  }

  async write(data) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, this.filePath);
    return data;
  }

  /**
   * Ejecuta una actualización secuencial atómica sobre el JSON.
   * @param {(current: any) => any | Promise<any>} mutator
   */
  async update(mutator) {
    const prev = writeQueues.get(this.filePath) || Promise.resolve();
    const next = prev.then(async () => {
      const current = await this.read();
      const updated = await mutator(current);
      await this.write(updated);
      return updated;
    });
    writeQueues.set(
      this.filePath,
      next.catch(() => {})
    );
    return next;
  }
}
