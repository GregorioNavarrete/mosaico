import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePatternCells } from '../../src/shared/patterns.js';
import { generateMixtureAssignments, generateGradientAssignments } from '../../src/shared/mixtures.js';
import {
  applyBilateralFilter,
  applyKuwaharaFilter,
  removeBackgroundLocal,
  preprocessRgba,
} from '../../src/shared/preprocess.js';
import { ciede2000, srgbToLab } from '../../src/shared/colorLab.js';

test('generateMixtureAssignments normaliza porcentajes, respeta conteos exactos y evita grumos espaciales', () => {
  const cells = generatePatternCells({
    widthCm: 20,
    heightCm: 20,
    tileSizeCm: 2,
    pattern: 'grid',
  });
  assert.equal(cells.length, 100);

  // Porcentajes no normalizados (5, 3, 2 -> 50%, 30%, 20%)
  const { palette, grid } = generateMixtureAssignments(
    cells,
    [
      { hex: '#36594D', percent: 5 },
      { hex: '#E9BF8A', percent: 3 },
      { hex: '#BD754E', percent: 2 },
    ],
    { seed: 777 }
  );

  assert.equal(grid.length, 100);
  assert.equal(palette.length, 3);
  assert.equal(palette[0].count, 50);
  assert.equal(palette[1].count, 30);
  assert.equal(palette[2].count, 20);

  // Verificar ausencia de grumos: dividir el mural 10x10 en 4 cuadrantes (5x5 cada uno = 25 celdas)
  // Cada cuadrante debe contener presencia representativa del color mayoritario (#0, 50%) y minoritario (#2, 20%)
  const qCounts0 = [0, 0, 0, 0];
  const qCounts2 = [0, 0, 0, 0];
  for (let i = 0; i < cells.length; i++) {
    const qx = cells[i].centroidCm[0] >= 10 ? 1 : 0;
    const qy = cells[i].centroidCm[1] >= 10 ? 2 : 0;
    const q = qx + qy;
    if (grid[i] === 0) qCounts0[q]++;
    if (grid[i] === 2) qCounts2[q]++;
  }
  for (let q = 0; q < 4; q++) {
    assert.ok(qCounts0[q] >= 9 && qCounts0[q] <= 16, `Cuadrante ${q} desequilibrado para 50%: ${qCounts0[q]}`);
    assert.ok(qCounts2[q] >= 2 && qCounts2[q] <= 9, `Cuadrante ${q} desequilibrado para 20%: ${qCounts2[q]}`);
  }
});

test('generateGradientAssignments interpola en CIELAB según ángulo y cuantiza con dithering', () => {
  const cells = generatePatternCells({
    widthCm: 20,
    heightCm: 10,
    tileSizeCm: 2,
    pattern: 'hexagonal',
  });

  const { palette, grid } = generateGradientAssignments(
    cells,
    [
      { hex: '#1F3A32', position: 0 },
      { hex: '#F2D3A2', position: 1 },
    ],
    {
      angleDeg: 0,
      widthCm: 20,
      heightCm: 10,
      ditherStrength: 0.5,
      paletteSteps: 4,
      seed: 123,
    }
  );

  assert.equal(palette.length, 4);
  assert.equal(grid.length, cells.length);

  // Celdas en el extremo izquierdo deben tener índice bajo (oscuro); en el extremo derecho índice alto (claro)
  const leftCells = cells
    .map((c, idx) => ({ c, idx }))
    .filter((item) => item.c.centroidCm[0] < 3);
  const rightCells = cells
    .map((c, idx) => ({ c, idx }))
    .filter((item) => item.c.centroidCm[0] > 17);

  const avgLeft = leftCells.reduce((s, item) => s + grid[item.idx], 0) / leftCells.length;
  const avgRight = rightCells.reduce((s, item) => s + grid[item.idx], 0) / rightCells.length;
  assert.ok(avgLeft < 1.2, `Esperado tonos iniciales a la izquierda, avg=${avgLeft}`);
  assert.ok(avgRight > 2.0, `Esperado tonos finales a la derecha, avg=${avgRight}`);
});

test('applyBilateralFilter y applyKuwaharaFilter suavizan ruido preservando bordes de alto contraste', () => {
  const w = 12;
  const h = 12;
  const rgba = new Uint8ClampedArray(w * h * 4);

  // Mitad izquierda oscura con ruido +/- 12, mitad derecha clara con ruido +/- 12
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const noise = ((x + y) % 2 === 0 ? 12 : -12);
      const base = x < 6 ? 40 : 220;
      rgba[idx] = base + noise;
      rgba[idx + 1] = base + noise;
      rgba[idx + 2] = base + noise;
      rgba[idx + 3] = 255;
    }
  }

  const bilat = applyBilateralFilter(rgba, w, h, { radius: 2, spatialSigma: 2, rangeSigma: 30 });
  assert.equal(bilat.length, rgba.length);
  // Píxeles internos lejos del borde deben acercarse a 40 y 220 (reduciendo oscilación)
  assert.ok(Math.abs(bilat[(5 * w + 2) * 4] - 40) < 6);
  assert.ok(Math.abs(bilat[(5 * w + 9) * 4] - 220) < 6);
  // El borde entre x=5 y x=6 debe mantenerse nítido (contraste > 140)
  const diffBorder = Math.abs(bilat[(5 * w + 6) * 4] - bilat[(5 * w + 5) * 4]);
  assert.ok(diffBorder > 140, `Bilateral borró borde: diff=${diffBorder}`);

  const kuwahara = applyKuwaharaFilter(rgba, w, h, 2);
  assert.equal(kuwahara.length, rgba.length);
  assert.ok(Math.abs(kuwahara[(5 * w + 2) * 4] - 40) < 6);
  assert.ok(Math.abs(kuwahara[(5 * w + 9) * 4] - 220) < 6);
});

test('removeBackgroundLocal limpia fondo conectado al borde y protege isla interior del mismo color', () => {
  const w = 10;
  const h = 10;
  const rgba = new Uint8ClampedArray(w * h * 4);

  // Fondo azul cielo conectado al borde, anillo rojo cerrado en [2..7]x[2..7], centro azul cielo protegido [4..5]x[4..5]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const inOuterRing = x >= 2 && x <= 7 && y >= 2 && y <= 7;
      const inInnerCenter = x >= 4 && x <= 5 && y >= 4 && y <= 5;
      if (inOuterRing && !inInnerCenter) {
        // Sujeto rojo
        rgba[idx] = 210;
        rgba[idx + 1] = 45;
        rgba[idx + 2] = 40;
      } else {
        // Azul cielo (#4A90E2)
        rgba[idx] = 74;
        rgba[idx + 1] = 144;
        rgba[idx + 2] = 226;
      }
      rgba[idx + 3] = 255;
    }
  }

  const cleaned = removeBackgroundLocal(rgba, w, h, { toleranceDeltaE: 12 });
  // Esquina (0,0) debe quedar blanca [255,255,255]
  assert.equal(cleaned[0], 255);
  assert.equal(cleaned[1], 255);
  assert.equal(cleaned[2], 255);

  // Sujeto rojo (2,2) intacto
  const ringIdx = (2 * w + 2) * 4;
  assert.equal(cleaned[ringIdx], 210);

  // Centro (4,4) del mismo color que el fondo pero aislado del borde debe permanecer azul intacto
  const centerIdx = (4 * w + 4) * 4;
  assert.ok(
    ciede2000(
      srgbToLab(cleaned[centerIdx], cleaned[centerIdx + 1], cleaned[centerIdx + 2]),
      srgbToLab(74, 144, 226)
    ) < 1
  );

  // Pipeline preprocessRgba completo
  const pipe = preprocessRgba(rgba, w, h, { preprocessMode: 'bilateral', removeBackground: true });
  assert.equal(pipe.width, w);
  assert.equal(pipe.height, h);
  assert.equal(pipe.data.length, w * h * 4);
});
