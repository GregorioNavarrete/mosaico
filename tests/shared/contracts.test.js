import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PT_PER_CM,
  PAPER_FORMATS,
  PATTERN_TYPES,
  createDefaultConfig,
  validateMosaicConfig,
} from '../../src/shared/contracts.js';

test('PT_PER_CM cumple exactamente 72 / 2.54', () => {
  assert.ok(Math.abs(PT_PER_CM - 28.3464566929) < 1e-8);
  assert.ok(Math.abs(10 * PT_PER_CM - 283.464567) < 1e-5);
});

test('createDefaultConfig produce una configuración válida', () => {
  const cfg = createDefaultConfig();
  const res = validateMosaicConfig(cfg);
  assert.equal(res.valid, true);
  assert.deepEqual(res.errors, []);
  assert.ok('A4' in PAPER_FORMATS);
  assert.ok(PATTERN_TYPES.includes('trencadis_voronoi'));
});

test('validateMosaicConfig rechaza parámetros fuera de rango', () => {
  const res = validateMosaicConfig({
    widthCm: 1,
    pattern: 'patron_inexistente',
    colorCount: 1,
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.length >= 3);
});
