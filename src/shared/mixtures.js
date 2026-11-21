import { hexToRgb, rgbToHex } from './mosaicCore.js';
import { srgbToLab, labToSrgb, createMulberry32, quantizeWithDithering } from './colorLab.js';

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function parseColorStop(stop, fallbackHex) {
  if (typeof stop === 'string') {
    const { r, g, b } = hexToRgb(stop);
    return { r, g, b, hex: rgbToHex(r, g, b) };
  }
  if (stop && typeof stop === 'object') {
    if (typeof stop.hex === 'string') {
      const { r, g, b } = hexToRgb(stop.hex);
      return { r, g, b, hex: rgbToHex(r, g, b) };
    }
    if (Number.isFinite(stop.r) && Number.isFinite(stop.g) && Number.isFinite(stop.b)) {
      const r = clamp(Math.round(stop.r), 0, 255);
      const g = clamp(Math.round(stop.g), 0, 255);
      const b = clamp(Math.round(stop.b), 0, 255);
      return { r, g, b, hex: rgbToHex(r, g, b) };
    }
  }
  const { r, g, b } = hexToRgb(fallbackHex);
  return { r, g, b, hex: rgbToHex(r, g, b) };
}

function getBoundsFromCells(cells, widthCm, heightCm) {
  if (Number.isFinite(widthCm) && widthCm > 0 && Number.isFinite(heightCm) && heightCm > 0) {
    return { widthCm, heightCm };
  }
  let maxX = 1;
  let maxY = 1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (Array.isArray(c?.centroidCm)) {
      if (c.centroidCm[0] > maxX) maxX = c.centroidCm[0];
      if (c.centroidCm[1] > maxY) maxY = c.centroidCm[1];
    }
    if (Array.isArray(c?.polygonCm)) {
      for (let j = 0; j < c.polygonCm.length; j++) {
        if (c.polygonCm[j][0] > maxX) maxX = c.polygonCm[j][0];
        if (c.polygonCm[j][1] > maxY) maxY = c.polygonCm[j][1];
      }
    }
  }
  return { widthCm: maxX, heightCm: maxY };
}

/**
 * Halton base-2 / base-3 o R2 secuencia de baja discrepancia para ordenación espacial uniforme sin grumos.
 */
function lowDiscrepancyKey(xNorm, yNorm, cellIdx, seedOffset) {
  // Matriz de Bayer 4x4 sobre cuadrícula fina + secuencia cuasi-aleatoria R2 (phi_2)
  const gx = Math.floor(xNorm * 64);
  const gy = Math.floor(yNorm * 64);
  const bayer = (BAYER_4X4[((gy % 4) + 4) % 4][((gx % 4) + 4) % 4] + 0.5) / 16;

  // Coordenadas en el toroide con secuencia R2 de Roberts para romper periodicidad
  const g = 1.324717957244746;
  const a1 = 1 / g;
  const a2 = 1 / (g * g);
  const r2 = ((gx * a1 + gy * a2 + cellIdx * 0.000137 + seedOffset) % 1 + 1) % 1;

  return 0.72 * bayer + 0.28 * r2;
}

/**
 * Genera asignaciones de mezcla porcentual (e.g. 50% / 30% / 20%) distribuidas de manera
 * espacialmente uniforme sin grumos sobre las celdas proporcionadas.
 *
 * @param {Array<import('./contracts.js').CellGeometry>} cells
 * @param {Array<{ hex?: string, r?: number, g?: number, b?: number, percent?: number }>} mixtureStops
 * @param {{ seed?: number }} [options={}]
 * @returns {{ palette: Array<import('./contracts.js').PaletteEntry>, grid: Uint8Array }}
 */
export function generateMixtureAssignments(cells, mixtureStops, { seed = 20261120 } = {}) {
  const cellList = Array.isArray(cells) ? cells : [];
  const rawStops =
    Array.isArray(mixtureStops) && mixtureStops.length > 0
      ? mixtureStops
      : [
          { hex: '#36594D', percent: 50 },
          { hex: '#E9BF8A', percent: 30 },
          { hex: '#BD754E', percent: 20 },
        ];

  const validStops = rawStops
    .map((s) => {
      const rgb = parseColorStop(s, '#36594D');
      const pct = Math.max(0, Number(s?.percent ?? 1));
      return { ...rgb, pct };
    })
    .filter((s) => s.pct > 0);

  if (validStops.length === 0) {
    const rgb = parseColorStop(rawStops[0], '#36594D');
    validStops.push({ ...rgb, pct: 100 });
  }

  const pctSum = validStops.reduce((acc, s) => acc + s.pct, 0);
  const normalizedStops = validStops.map((s) => ({
    ...s,
    ratio: s.pct / pctSum,
  }));

  const n = cellList.length;
  const K = normalizedStops.length;
  const grid = new Uint8Array(n);

  if (n === 0) {
    return {
      palette: normalizedStops.map((s, idx) => ({
        id: idx + 1,
        r: s.r,
        g: s.g,
        b: s.b,
        hex: s.hex,
        lab: srgbToLab(s.r, s.g, s.b),
        count: 0,
      })),
      grid,
    };
  }

  // Método de restos mayores (Hamilton / Largest Remainder) para conteos exactos sumando n
  const exactQuotas = normalizedStops.map((s) => s.ratio * n);
  const targetCounts = exactQuotas.map((q) => Math.floor(q));
  let remainder = n - targetCounts.reduce((acc, c) => acc + c, 0);

  const fracOrder = exactQuotas
    .map((q, idx) => ({ idx, frac: q - Math.floor(q) }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.idx - b.idx));

  for (let i = 0; i < remainder; i++) {
    targetCounts[fracOrder[i % K].idx]++;
  }

  // Ordenar celdas por clave espacial de baja discrepancia (Bayer + R2) para garantizar
  // distribución homogénea sin grumos en toda la superficie del mural.
  const { widthCm, heightCm } = getBoundsFromCells(cellList);
  const rng = createMulberry32(seed);
  const seedOffset = rng();

  // Particionar el rango [0, 1) usando un orden espacial determinista de baja discrepancia:
  // si asignamos mediante una permutación espacial ordenada por Hilbert/Morton o clave espacial,
  // los bloques contiguos recibirían el mismo color! Para EVITAR grumos, ordenamos las celdas
  // por la clave de dispersión `lowDiscrepancyKey` (donde celdas vecinas tienen claves muy distintas)
  // y luego repartimos los bloques estratificados en ese orden disperso, o asignamos por cuantil.
  const scoredCells = cellList.map((cell, idx) => {
    const cx = Array.isArray(cell.centroidCm) ? cell.centroidCm[0] : (cell.col ?? idx) + 0.5;
    const cy = Array.isArray(cell.centroidCm) ? cell.centroidCm[1] : (cell.row ?? 0) + 0.5;
    const xNorm = clamp(cx / Math.max(1e-6, widthCm), 0, 1);
    const yNorm = clamp(cy / Math.max(1e-6, heightCm), 0, 1);
    return {
      idx,
      score: lowDiscrepancyKey(xNorm, yNorm, idx, seedOffset),
      tie: rng(),
    };
  });

  scoredCells.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.tie - b.tie));

  // Asignación intercalada usando Error-Diffusion / Bresenham multi-clase sobre la lista ordenada
  // por umbral de baja discrepancia, o reparto por bandas acumuladas de score.
  // Para evitar que una sola banda espacial acapare un color, usamos acumulador de error por cada parada
  // recorriendo las celdas en orden espacial de lectura y eligiendo entre las clases con cuota restante
  // moduladas por el umbral Bayer local!
  const readingOrder = cellList.map((cell, idx) => {
    const cx = Array.isArray(cell.centroidCm) ? cell.centroidCm[0] : (cell.col ?? idx) + 0.5;
    const cy = Array.isArray(cell.centroidCm) ? cell.centroidCm[1] : (cell.row ?? 0) + 0.5;
    return { idx, cx, cy, xNorm: cx / Math.max(1e-6, widthCm), yNorm: cy / Math.max(1e-6, heightCm) };
  });
  readingOrder.sort((a, b) => (Math.abs(a.cy - b.cy) > 1e-4 ? a.cy - b.cy : a.cx - b.cx));

  // Construimos una permutación por estratos en score de baja discrepancia:
  // Como `lowDiscrepancyKey` oscila rápidamente entre vecinos inmediatos (ej. 0, 8, 2, 10 en Bayer 4x4),
  // dividir el arreglo `scoredCells` por umbrales acumulados de `targetCounts` distribuye cada color
  // en la fase Bayer correspondiente a su porcentaje exacto, logrando 0 grumos y conteos exactos!
  const counts = new Uint32Array(K);
  let cursor = 0;
  for (let k = 0; k < K; k++) {
    const cnt = targetCounts[k];
    for (let j = 0; j < cnt; j++) {
      const cellIdx = scoredCells[cursor++].idx;
      grid[cellIdx] = k;
      counts[k]++;
    }
  }

  const palette = normalizedStops.map((s, idx) => ({
    id: idx + 1,
    r: s.r,
    g: s.g,
    b: s.b,
    hex: s.hex,
    lab: srgbToLab(s.r, s.g, s.b),
    count: counts[idx],
  }));

  return { palette, grid };
}

/**
 * Genera un degradado direccional continuo en espacio CIELAB a lo largo de `angleDeg`
 * y lo cuantiza a los colores de parada (o una paleta expandida si `paletteSteps` es provisto)
 * con dithering espacial opcional (por defecto `'bayer'`).
 *
 * @param {Array<import('./contracts.js').CellGeometry>} cells
 * @param {Array<{ hex?: string, r?: number, g?: number, b?: number, position?: number }>} gradientStops
 * @param {{
 *   angleDeg?: number,
 *   widthCm?: number,
 *   heightCm?: number,
 *   ditherMode?: 'none' | 'bayer' | 'floyd-steinberg',
 *   ditherStrength?: number,
 *   seed?: number,
 *   paletteSteps?: number
 * }} [options={}]
 * @returns {{ palette: Array<import('./contracts.js').PaletteEntry>, grid: Uint8Array }}
 */
export function generateGradientAssignments(
  cells,
  gradientStops,
  {
    angleDeg = 135,
    widthCm,
    heightCm,
    ditherMode = 'bayer',
    ditherStrength = 0.65,
    seed = 20261120,
    paletteSteps = 0,
  } = {}
) {
  const cellList = Array.isArray(cells) ? cells : [];
  const rawStops =
    Array.isArray(gradientStops) && gradientStops.length > 0
      ? gradientStops
      : [
          { hex: '#263F36', position: 0 },
          { hex: '#E9BF8A', position: 0.55 },
          { hex: '#C45B3E', position: 1 },
        ];

  const stops = rawStops
    .map((s, i) => {
      const rgb = parseColorStop(s, '#263F36');
      const pos = Number.isFinite(Number(s?.position))
        ? clamp(Number(s.position), 0, 1)
        : rawStops.length === 1
        ? 0
        : i / (rawStops.length - 1);
      return {
        ...rgb,
        pos,
        lab: srgbToLab(rgb.r, rgb.g, rgb.b),
      };
    })
    .sort((a, b) => a.pos - b.pos);

  // Construir paleta destino (paradas directas o interpolación uniforme si paletteSteps > stops.length)
  let basePalette;
  if (Number.isInteger(paletteSteps) && paletteSteps > stops.length && paletteSteps <= 48) {
    basePalette = [];
    for (let i = 0; i < paletteSteps; i++) {
      const t = i / (paletteSteps - 1);
      const lab = interpolateStopsLab(stops, t);
      const { r, g, b } = labToSrgb(lab.L, lab.a, lab.b);
      basePalette.push({
        id: i + 1,
        r,
        g,
        b,
        hex: rgbToHex(r, g, b),
        lab,
        count: 0,
      });
    }
  } else {
    basePalette = stops.map((s, idx) => ({
      id: idx + 1,
      r: s.r,
      g: s.g,
      b: s.b,
      hex: s.hex,
      lab: s.lab,
      count: 0,
    }));
  }

  const n = cellList.length;
  if (n === 0) {
    return { palette: basePalette, grid: new Uint8Array(0) };
  }

  const bounds = getBoundsFromCells(cellList, widthCm, heightCm);
  const rad = ((Number(angleDeg) || 0) * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);

  // Proyección de las 4 esquinas de [0, W] x [0, H] sobre el vector dirección (ux, uy)
  const corners = [
    [0, 0],
    [bounds.widthCm, 0],
    [bounds.widthCm, bounds.heightCm],
    [0, bounds.heightCm],
  ];
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const [cx, cy] of corners) {
    const p = cx * ux + cy * uy;
    if (p < minProj) minProj = p;
    if (p > maxProj) maxProj = p;
  }
  const span = Math.max(1e-6, maxProj - minProj);

  // Evaluar color Lab continuo en cada centroide
  const labSamples = cellList.map((cell, idx) => {
    const cx = Array.isArray(cell.centroidCm) ? cell.centroidCm[0] : (cell.col ?? idx) + 0.5;
    const cy = Array.isArray(cell.centroidCm) ? cell.centroidCm[1] : (cell.row ?? 0) + 0.5;
    const proj = cx * ux + cy * uy;
    const t = clamp((proj - minProj) / span, 0, 1);
    const lab = interpolateStopsLab(stops, t);
    return {
      ...cell,
      lab,
    };
  });

  const effectiveMode =
    ditherStrength <= 0 ? 'none' : ditherMode || 'bayer';

  const quantized = quantizeWithDithering(labSamples, basePalette, {
    ditherMode: effectiveMode,
    ditherStrength,
    seed,
  });

  return {
    palette: quantized.palette,
    grid: quantized.assignments,
  };
}

function interpolateStopsLab(stops, t) {
  if (stops.length === 1 || t <= stops[0].pos) return { ...stops[0].lab };
  const last = stops[stops.length - 1];
  if (t >= last.pos) return { ...last.lab };

  for (let i = 0; i < stops.length - 1; i++) {
    const s0 = stops[i];
    const s1 = stops[i + 1];
    if (t >= s0.pos && t <= s1.pos) {
      const denom = Math.max(1e-9, s1.pos - s0.pos);
      const f = (t - s0.pos) / denom;
      return {
        L: s0.lab.L + (s1.lab.L - s0.lab.L) * f,
        a: s0.lab.a + (s1.lab.a - s0.lab.a) * f,
        b: s0.lab.b + (s1.lab.b - s0.lab.b) * f,
      };
    }
  }
  return { ...last.lab };
}
