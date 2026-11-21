import test from 'node:test';
import assert from 'node:assert/strict';
import {
  srgbToXyz,
  xyzToLab,
  srgbToLab,
  labToSrgb,
  ciede2000,
  labDistSq,
  createMulberry32,
  runKMeansLab,
  quantizeWithDithering,
} from '../../src/shared/colorLab.js';

test('srgbToXyz, xyzToLab, srgbToLab y labToSrgb realizan round-trip exacto', () => {
  const samples = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [54, 89, 77],
    [189, 117, 78],
    [233, 191, 138],
  ];

  const whiteXyz = srgbToXyz(255, 255, 255);
  assert.ok(Math.abs(whiteXyz.x - 95.047) < 0.05);
  assert.ok(Math.abs(whiteXyz.y - 100.0) < 0.05);
  assert.ok(Math.abs(whiteXyz.z - 108.883) < 0.05);

  const whiteLab = xyzToLab(whiteXyz);
  assert.ok(Math.abs(whiteLab.L - 100) < 0.05);
  assert.ok(Math.abs(whiteLab.a) < 0.05);
  assert.ok(Math.abs(whiteLab.b) < 0.05);

  for (const [r, g, b] of samples) {
    const lab = srgbToLab(r, g, b);
    const rt = labToSrgb(lab.L, lab.a, lab.b);
    assert.ok(Math.abs(rt.r - r) <= 1, `R mismatch for ${r},${g},${b}: ${rt.r}`);
    assert.ok(Math.abs(rt.g - g) <= 1, `G mismatch for ${r},${g},${b}: ${rt.g}`);
    assert.ok(Math.abs(rt.b - b) <= 1, `B mismatch for ${r},${g},${b}: ${rt.b}`);
  }
});

test('ciede2000 coincide con Sharma et al. (2005) Pair 1 = 2.0425 ± 0.001 y otros pares de referencia', () => {
  const dePair1 = ciede2000([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485]);
  assert.ok(Math.abs(dePair1 - 2.0425) <= 0.001, `Expected 2.0425, got ${dePair1}`);

  // Par 2 de Sharma et al. 2005: [50.0, 3.1571, -77.2803] vs [50.0, 0.0, -82.7485] => 2.8615
  const dePair2 = ciede2000({ L: 50.0, a: 3.1571, b: -77.2803 }, { L: 50.0, a: 0.0, b: -82.7485 });
  assert.ok(Math.abs(dePair2 - 2.8615) <= 0.001, `Expected 2.8615, got ${dePair2}`);

  assert.equal(ciede2000([60, 10, -20], [60, 10, -20]), 0);
  assert.equal(labDistSq({ L: 50, a: 10, b: -10 }, { L: 53, a: 14, b: -10 }), 25);
});

test('createMulberry32 es determinista para una misma semilla', () => {
  const rng1 = createMulberry32(123456);
  const rng2 = createMulberry32(123456);
  const rng3 = createMulberry32(654321);

  const seq1 = Array.from({ length: 10 }, () => rng1());
  const seq2 = Array.from({ length: 10 }, () => rng2());
  const seq3 = Array.from({ length: 10 }, () => rng3());

  assert.deepEqual(seq1, seq2);
  assert.notDeepEqual(seq1, seq3);
  for (const v of seq1) {
    assert.ok(v >= 0 && v < 1);
  }
});

test('runKMeansLab agrupa colores perceptualmente y ordena paleta por frecuencia descendente', () => {
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push({ r: 220 + (i % 5), g: 40, b: 35 }); // mayoría rojo
  for (let i = 0; i < 20; i++) samples.push({ r: 30, g: 130 + (i % 4), b: 210 }); // medio azul
  for (let i = 0; i < 10; i++) samples.push({ r: 240, g: 220, b: 60 + (i % 3) }); // minoría amarillo

  const res = runKMeansLab(samples, 3, { seed: 42, maxIter: 20 });
  assert.equal(res.palette.length, 3);
  assert.equal(res.centroidsLab.length, 3);
  assert.equal(res.assignments.length, 70);

  // Orden descendente por count: 40, 20, 10
  assert.equal(res.palette[0].count, 40);
  assert.equal(res.palette[1].count, 20);
  assert.equal(res.palette[2].count, 10);
  assert.ok(res.palette[0].r > 190 && res.palette[0].b < 60);
  assert.ok(res.palette[0].lab && Number.isFinite(res.palette[0].lab.L));
  assert.match(res.palette[0].hex, /^#[0-9A-F]{6}$/);

  // Reproducibilidad determinista con la misma semilla
  const res2 = runKMeansLab(samples, 3, { seed: 42, maxIter: 20 });
  assert.deepEqual(res.assignments, res2.assignments);
});

test('quantizeWithDithering soporta none, bayer y floyd-steinberg usando CIEDE2000', () => {
  const palette = [
    { r: 20, g: 20, b: 20, hex: '#141414' },
    { r: 235, g: 235, b: 235, hex: '#EBEBEB' },
  ];

  // Gradiente suave de grises 8x8 en tonos intermedios (110..145)
  const cells = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const v = 115 + Math.round((c / 7) * 25);
      cells.push({
        r: v,
        g: v,
        b: v,
        row: r,
        col: c,
        centroidCm: [c * 2 + 1, r * 2 + 1],
        areaCm2: 4,
      });
    }
  }

  const qNone = quantizeWithDithering(cells, palette, { ditherMode: 'none' });
  assert.equal(qNone.assignments.length, 64);
  assert.equal(qNone.counts[0] + qNone.counts[1], 64);

  const qBayer = quantizeWithDithering(cells, palette, {
    ditherMode: 'bayer',
    ditherStrength: 0.85,
    seed: 99,
  });
  assert.equal(qBayer.counts[0] + qBayer.counts[1], 64);
  assert.ok(qBayer.counts[0] > 0 && qBayer.counts[1] > 0, 'Bayer debe mezclar ambos tonos en grises medios');

  const qFs = quantizeWithDithering(cells, palette, {
    ditherMode: 'floyd-steinberg',
    ditherStrength: 0.9,
  });
  assert.equal(qFs.counts[0] + qFs.counts[1], 64);
  assert.ok(qFs.counts[0] > 0 && qFs.counts[1] > 0, 'Floyd-Steinberg debe difundir error hacia ambos tonos');
});
