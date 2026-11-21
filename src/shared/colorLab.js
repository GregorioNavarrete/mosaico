import { hexToRgb, rgbToHex } from './mosaicCore.js';

const D65_XN = 95.047;
const D65_YN = 100.0;
const D65_ZN = 108.883;
const LAB_EPSILON = 216 / 24389; // 0.008856451679035631
const LAB_KAPPA = 24389 / 27; // 903.2962962962963
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const POW25_7 = 6103515625; // 25^7

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function readRgbArgs(r, g, b) {
  if (r !== null && typeof r === 'object') {
    if (Array.isArray(r)) return [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0];
    return [r.r ?? 0, r.g ?? 0, r.b ?? 0];
  }
  return [r ?? 0, g ?? 0, b ?? 0];
}

function readXyzArgs(x, y, z) {
  if (x !== null && typeof x === 'object') {
    if (Array.isArray(x)) return [x[0] ?? 0, x[1] ?? 0, x[2] ?? 0];
    return [x.x ?? x.X ?? 0, x.y ?? x.Y ?? 0, x.z ?? x.Z ?? 0];
  }
  return [x ?? 0, y ?? 0, z ?? 0];
}

function readLab(lab, fallbackA, fallbackB) {
  if (lab !== null && typeof lab === 'object') {
    if (Array.isArray(lab)) {
      return [Number(lab[0]) || 0, Number(lab[1]) || 0, Number(lab[2]) || 0];
    }
    return [
      Number(lab.L ?? lab.l) || 0,
      Number(lab.a) || 0,
      Number(lab.b) || 0,
    ];
  }
  return [Number(lab) || 0, Number(fallbackA) || 0, Number(fallbackB) || 0];
}

function linearizeSrgbChannel(c255) {
  const v = clamp(c255, 0, 255) / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function compandSrgbChannel(linear) {
  const u = clamp(linear, 0, 1);
  const s = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  return clamp(Math.round(s * 255), 0, 255);
}

/**
 * Convierte sRGB [0..255] a CIE XYZ (iluminante D65, observador 2°, escala 0..100).
 *
 * @param {number | { r: number, g: number, b: number } | [number, number, number]} r
 * @param {number} [g]
 * @param {number} [b]
 * @returns {{ x: number, y: number, z: number }}
 */
export function srgbToXyz(r, g, b) {
  const [rv, gv, bv] = readRgbArgs(r, g, b);
  const R = linearizeSrgbChannel(rv);
  const G = linearizeSrgbChannel(gv);
  const B = linearizeSrgbChannel(bv);

  return {
    x: (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) * 100,
    y: (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) * 100,
    z: (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) * 100,
  };
}

/**
 * Convierte CIE XYZ (escala D65 0..100) a CIE L*a*b*.
 *
 * @param {number | { x: number, y: number, z: number } | [number, number, number]} x
 * @param {number} [y]
 * @param {number} [z]
 * @returns {{ L: number, a: number, b: number }}
 */
export function xyzToLab(x, y, z) {
  const [xv, yv, zv] = readXyzArgs(x, y, z);
  const f = (t) => (t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const fx = f(xv / D65_XN);
  const fy = f(yv / D65_YN);
  const fz = f(zv / D65_ZN);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/**
 * Convierte sRGB [0..255] directamente a CIE L*a*b* (D65).
 *
 * @param {number | { r: number, g: number, b: number } | [number, number, number]} r
 * @param {number} [g]
 * @param {number} [b]
 * @returns {{ L: number, a: number, b: number }}
 */
export function srgbToLab(r, g, b) {
  const { x, y, z } = srgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/**
 * Convierte CIE L*a*b* (D65) a sRGB [0..255].
 *
 * @param {number | { L: number, a: number, b: number } | [number, number, number]} L
 * @param {number} [a]
 * @param {number} [b]
 * @returns {{ r: number, g: number, b: number }}
 */
export function labToSrgb(L, a, b) {
  const [Lv, av, bv] = readLab(L, a, b);
  const fy = (Lv + 16) / 116;
  const fx = av / 500 + fy;
  const fz = fy - bv / 200;

  const fx3 = fx * fx * fx;
  const fz3 = fz * fz * fz;

  const xr = fx3 > LAB_EPSILON ? fx3 : (116 * fx - 16) / LAB_KAPPA;
  const yr = Lv > LAB_KAPPA * LAB_EPSILON ? Math.pow((Lv + 16) / 116, 3) : Lv / LAB_KAPPA;
  const zr = fz3 > LAB_EPSILON ? fz3 : (116 * fz - 16) / LAB_KAPPA;

  const x = (xr * D65_XN) / 100;
  const y = (yr * D65_YN) / 100;
  const z = (zr * D65_ZN) / 100;

  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const G = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  return {
    r: compandSrgbChannel(R),
    g: compandSrgbChannel(G),
    b: compandSrgbChannel(B),
  };
}

/**
 * Cálculo sin asignaciones de distancia perceptual CIEDE2000 (ΔE00) con kL=kC=kH=1.
 * Referencia: Sharma, Wu, Dalal (2005).
 */
function ciede2000Coords(L1, a1, b1, L2, a2, b2) {
  if (L1 === L2 && a1 === a2 && b1 === b2) return 0;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = 0.5 * (C1 + C2);
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  let h1p = b1 === 0 && a1p === 0 ? 0 : Math.atan2(b1, a1p) * RAD_TO_DEG;
  if (h1p < 0) h1p += 360;
  let h2p = b2 === 0 && a2p === 0 ? 0 : Math.atan2(b2, a2p) * RAD_TO_DEG;
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const cProd = C1p * C2p;

  let dhp = 0;
  if (cProd !== 0) {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }

  const dHp = 2 * Math.sqrt(cProd) * Math.sin(0.5 * dhp * DEG_TO_RAD);
  const Lbarp = 0.5 * (L1 + L2);
  const Cbarp = 0.5 * (C1p + C2p);

  let Hbarp = h1p + h2p;
  if (cProd !== 0) {
    if (Math.abs(h1p - h2p) <= 180) Hbarp = 0.5 * (h1p + h2p);
    else if (h1p + h2p < 360) Hbarp = 0.5 * (h1p + h2p + 360);
    else Hbarp = 0.5 * (h1p + h2p - 360);
  }

  const T =
    1 -
    0.17 * Math.cos((Hbarp - 30) * DEG_TO_RAD) +
    0.24 * Math.cos(2 * Hbarp * DEG_TO_RAD) +
    0.32 * Math.cos((3 * Hbarp + 6) * DEG_TO_RAD) -
    0.20 * Math.cos((4 * Hbarp - 63) * DEG_TO_RAD);

  const dTheta = 30 * Math.exp(-Math.pow((Hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));

  const L50 = Lbarp - 50;
  const L50sq = L50 * L50;
  const Sl = 1 + (0.015 * L50sq) / Math.sqrt(20 + L50sq);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * DEG_TO_RAD) * Rc;

  const tL = dLp / Sl;
  const tC = dCp / Sc;
  const tH = dHp / Sh;

  return Math.sqrt(Math.max(0, tL * tL + tC * tC + tH * tH + Rt * tC * tH));
}

/**
 * Calcula la diferencia perceptual CIEDE2000 (ΔE00) entre dos colores Lab.
 * Acepta tanto `{ L, a, b }` como `[L, a, b]`.
 *
 * @param {{ L: number, a: number, b: number } | [number, number, number]} lab1
 * @param {{ L: number, a: number, b: number } | [number, number, number]} lab2
 * @returns {number}
 */
export function ciede2000(lab1, lab2) {
  const [L1, a1, b1] = readLab(lab1);
  const [L2, a2, b2] = readLab(lab2);
  return ciede2000Coords(L1, a1, b1, L2, a2, b2);
}

/**
 * Distancia euclidiana al cuadrado en espacio CIE L*a*b* (ΔE*ab²).
 * Acepta tanto `{ L, a, b }` como `[L, a, b]`.
 *
 * @param {{ L: number, a: number, b: number } | [number, number, number]} lab1
 * @param {{ L: number, a: number, b: number } | [number, number, number]} lab2
 * @returns {number}
 */
export function labDistSq(lab1, lab2) {
  const [L1, a1, b1] = readLab(lab1);
  const [L2, a2, b2] = readLab(lab2);
  const dL = L1 - L2;
  const da = a1 - a2;
  const db = b1 - b2;
  return dL * dL + da * da + db * db;
}

/**
 * Generador pseudoaleatorio determinista Mulberry32 en [0, 1).
 *
 * @param {number} [seed=20261120]
 * @returns {() => number}
 */
export function createMulberry32(seed = 20261120) {
  let state = (Number(seed) || 0) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleToLabTuple(sample) {
  if (!sample) return [0, 0, 0];
  if (sample.lab !== undefined) return readLab(sample.lab);
  if (Number.isFinite(sample.L) && Number.isFinite(sample.a) && Number.isFinite(sample.b)) {
    return [sample.L, sample.a, sample.b];
  }
  if (Array.isArray(sample)) {
    const lab = srgbToLab(sample[0] ?? 0, sample[1] ?? 0, sample[2] ?? 0);
    return [lab.L, lab.a, lab.b];
  }
  if (Number.isFinite(sample.r) && Number.isFinite(sample.g) && Number.isFinite(sample.b)) {
    const lab = srgbToLab(sample.r, sample.g, sample.b);
    return [lab.L, lab.a, lab.b];
  }
  if (typeof sample.hex === 'string') {
    const rgb = hexToRgb(sample.hex);
    const lab = srgbToLab(rgb.r, rgb.g, rgb.b);
    return [lab.L, lab.a, lab.b];
  }
  return [0, 0, 0];
}

function paletteEntryToLabTuple(entry) {
  if (!entry) return [0, 0, 0];
  if (entry.lab !== undefined) return readLab(entry.lab);
  if (Number.isFinite(entry.L) && Number.isFinite(entry.a) && Number.isFinite(entry.b)) {
    return [entry.L, entry.a, entry.b];
  }
  if (Number.isFinite(entry.r) && Number.isFinite(entry.g) && Number.isFinite(entry.b)) {
    const lab = srgbToLab(entry.r, entry.g, entry.b);
    return [lab.L, lab.a, lab.b];
  }
  if (Array.isArray(entry.rgb)) {
    const lab = srgbToLab(entry.rgb[0], entry.rgb[1], entry.rgb[2]);
    return [lab.L, lab.a, lab.b];
  }
  if (typeof entry.hex === 'string') {
    const rgb = hexToRgb(entry.hex);
    const lab = srgbToLab(rgb.r, rgb.g, rgb.b);
    return [lab.L, lab.a, lab.b];
  }
  return [0, 0, 0];
}

/**
 * Agrupamiento K-Means++ probabilístico con Mulberry32 en espacio perceptual CIE L*a*b*.
 *
 * @param {Array<{ r?: number, g?: number, b?: number, hex?: string, lab?: { L: number, a: number, b: number } }>} samples
 * @param {number} K
 * @param {{ seed?: number, maxIter?: number }} [options={}]
 * @returns {{
 *   centroidsLab: Array<{ L: number, a: number, b: number }>,
 *   palette: Array<{ id: number, r: number, g: number, b: number, hex: string, lab: { L: number, a: number, b: number }, count: number }>,
 *   assignments: Uint8Array
 * }}
 */
export function runKMeansLab(samples, K, { seed = 20261120, maxIter = 20 } = {}) {
  const n = Array.isArray(samples) ? samples.length : 0;
  if (n === 0) {
    return {
      centroidsLab: [],
      palette: [],
      assignments: new Uint8Array(0),
    };
  }

  const effectiveK = Math.max(1, Math.min(Math.floor(K) || 1, n, 254));
  const rng = createMulberry32(seed);

  const sampleL = new Float64Array(n);
  const sampleA = new Float64Array(n);
  const sampleB = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const [L, a, b] = sampleToLabTuple(samples[i]);
    sampleL[i] = L;
    sampleA[i] = a;
    sampleB[i] = b;
  }

  // Para murales enormes (> 24 000 muestras), submuestreamos determinísticamente para ajustar centroides rápido
  let trainIdx = null;
  let trainN = n;
  if (n > 24000) {
    const stride = Math.ceil(n / 24000);
    const idxList = [];
    for (let i = 0; i < n; i += stride) {
      idxList.push(i);
    }
    trainIdx = Int32Array.from(idxList);
    trainN = trainIdx.length;
  }

  const getTrain = (ti) => (trainIdx ? trainIdx[ti] : ti);

  // Inicialización K-Means++ probabilística con Mulberry32
  const centL = new Float64Array(effectiveK);
  const centA = new Float64Array(effectiveK);
  const centB = new Float64Array(effectiveK);

  const firstIdx = getTrain(Math.min(trainN - 1, Math.floor(rng() * trainN)));
  centL[0] = sampleL[firstIdx];
  centA[0] = sampleA[firstIdx];
  centB[0] = sampleB[firstIdx];

  const minDists = new Float64Array(trainN).fill(Infinity);
  let activeCentroids = 1;

  for (let k = 1; k < effectiveK; k++) {
    const prevL = centL[k - 1];
    const prevA = centA[k - 1];
    const prevB = centB[k - 1];

    let totalWeight = 0;
    for (let ti = 0; ti < trainN; ti++) {
      const si = getTrain(ti);
      const dL = sampleL[si] - prevL;
      const da = sampleA[si] - prevA;
      const db = sampleB[si] - prevB;
      const dSq = dL * dL + da * da + db * db;
      if (dSq < minDists[ti]) {
        minDists[ti] = dSq;
      }
      totalWeight += minDists[ti];
    }

    if (totalWeight <= 1e-12) {
      break;
    }

    const threshold = rng() * totalWeight;
    let cumulative = 0;
    let chosenTrainIdx = trainN - 1;
    for (let ti = 0; ti < trainN; ti++) {
      cumulative += minDists[ti];
      if (cumulative >= threshold) {
        chosenTrainIdx = ti;
        break;
      }
    }

    const chosenIdx = getTrain(chosenTrainIdx);
    centL[k] = sampleL[chosenIdx];
    centA[k] = sampleA[chosenIdx];
    centB[k] = sampleB[chosenIdx];
    activeCentroids++;
  }

  const trainAssign = new Uint8Array(trainN);
  const iters = Math.max(1, Math.floor(maxIter) || 20);

  for (let iter = 0; iter < iters; iter++) {
    let changed = false;
    const sumL = new Float64Array(activeCentroids);
    const sumA = new Float64Array(activeCentroids);
    const sumB = new Float64Array(activeCentroids);
    const cnt = new Uint32Array(activeCentroids);

    for (let ti = 0; ti < trainN; ti++) {
      const si = getTrain(ti);
      const sL = sampleL[si];
      const sA = sampleA[si];
      const sB = sampleB[si];

      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < activeCentroids; k++) {
        const dL = sL - centL[k];
        const da = sA - centA[k];
        const db = sB - centB[k];
        const dSq = dL * dL + da * da + db * db;
        if (dSq < bestDist) {
          bestDist = dSq;
          bestK = k;
        }
      }

      if (trainAssign[ti] !== bestK) {
        trainAssign[ti] = bestK;
        changed = true;
      }

      sumL[bestK] += sL;
      sumA[bestK] += sA;
      sumB[bestK] += sB;
      cnt[bestK]++;
    }

    let maxShiftSq = 0;
    for (let k = 0; k < activeCentroids; k++) {
      if (cnt[k] > 0) {
        const nextL = sumL[k] / cnt[k];
        const nextA = sumA[k] / cnt[k];
        const nextB = sumB[k] / cnt[k];
        const shiftSq =
          (nextL - centL[k]) * (nextL - centL[k]) +
          (nextA - centA[k]) * (nextA - centA[k]) +
          (nextB - centB[k]) * (nextB - centB[k]);
        if (shiftSq > maxShiftSq) maxShiftSq = shiftSq;
        centL[k] = nextL;
        centA[k] = nextA;
        centB[k] = nextB;
      }
    }

    if (!changed || maxShiftSq < 1e-6) break;
  }

  // Asignación final sobre el 100% de las muestras
  const rawAssignments = new Uint8Array(n);
  const rawCounts = new Uint32Array(activeCentroids);

  if (!trainIdx) {
    for (let i = 0; i < n; i++) {
      const k = trainAssign[i];
      rawAssignments[i] = k;
      rawCounts[k]++;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const sL = sampleL[i];
      const sA = sampleA[i];
      const sB = sampleB[i];
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < activeCentroids; k++) {
        const dL = sL - centL[k];
        const da = sA - centA[k];
        const db = sB - centB[k];
        const dSq = dL * dL + da * da + db * db;
        if (dSq < bestDist) {
          bestDist = dSq;
          bestK = k;
        }
      }
      rawAssignments[i] = bestK;
      rawCounts[bestK]++;
    }
  }

  // Ordenar paleta por frecuencia descendente descartando centroides vacíos
  const ordered = [];
  for (let k = 0; k < activeCentroids; k++) {
    if (rawCounts[k] > 0) {
      ordered.push({
        oldIdx: k,
        L: centL[k],
        a: centA[k],
        b: centB[k],
        count: rawCounts[k],
      });
    }
  }
  ordered.sort((x, y) => (y.count !== x.count ? y.count - x.count : x.oldIdx - y.oldIdx));

  const remap = new Uint8Array(activeCentroids);
  const centroidsLab = [];
  const palette = ordered.map((item, newIdx) => {
    remap[item.oldIdx] = newIdx;
    const lab = { L: item.L, a: item.a, b: item.b };
    centroidsLab.push(lab);
    const { r, g, b } = labToSrgb(item.L, item.a, item.b);
    return {
      id: newIdx + 1,
      r,
      g,
      b,
      hex: rgbToHex(r, g, b),
      lab,
      count: item.count,
    };
  });

  const assignments = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    assignments[i] = remap[rawAssignments[i]];
  }

  return { centroidsLab, palette, assignments };
}

function getCellCenter(cell, idx, virtualCols) {
  if (Array.isArray(cell?.centroidCm) && cell.centroidCm.length >= 2) {
    return [Number(cell.centroidCm[0]) || 0, Number(cell.centroidCm[1]) || 0];
  }
  if (Number.isFinite(cell?.col) && Number.isFinite(cell?.row)) {
    return [cell.col, cell.row];
  }
  return [idx % virtualCols, Math.floor(idx / virtualCols)];
}

function estimateSpatialStep(cells, coords) {
  const n = cells.length;
  if (n <= 1) return 1;

  let areaSum = 0;
  let areaCnt = 0;
  for (let i = 0; i < Math.min(n, 200); i++) {
    const a = cells[i]?.nominalAreaCm2 ?? cells[i]?.areaCm2;
    if (Number.isFinite(a) && a > 1e-6) {
      areaSum += a;
      areaCnt++;
    }
  }
  if (areaCnt > 0 && Array.isArray(cells[0]?.centroidCm)) {
    return Math.max(1e-3, Math.sqrt(areaSum / areaCnt));
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = coords[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
  return Math.max(1e-3, Math.sqrt(spanArea / n));
}

function nearestPaletteIndexCiede2000(L, a, b, palL, palA, palB) {
  let bestK = 0;
  let bestDe = Infinity;
  const kLen = palL.length;
  for (let k = 0; k < kLen; k++) {
    const de = ciede2000Coords(L, a, b, palL[k], palA[k], palB[k]);
    if (de < bestDe) {
      bestDe = de;
      bestK = k;
    }
  }
  return bestK;
}

function computeBayerLabScales(palL, palA, palB) {
  const K = palL.length;
  if (K <= 1) return { scaleL: 0, scaleA: 0, scaleB: 0 };

  const nnL = [];
  const nnA = [];
  const nnB = [];
  for (let i = 0; i < K; i++) {
    let bestSq = Infinity;
    let bestJ = -1;
    for (let j = 0; j < K; j++) {
      if (i === j) continue;
      const dL = palL[i] - palL[j];
      const da = palA[i] - palA[j];
      const db = palB[i] - palB[j];
      const dSq = dL * dL + da * da + db * db;
      if (dSq < bestSq) {
        bestSq = dSq;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      nnL.push(Math.abs(palL[i] - palL[bestJ]));
      nnA.push(Math.abs(palA[i] - palA[bestJ]));
      nnB.push(Math.abs(palB[i] - palB[bestJ]));
    }
  }

  nnL.sort((x, y) => x - y);
  nnA.sort((x, y) => x - y);
  nnB.sort((x, y) => x - y);
  const mid = Math.floor(nnL.length / 2);

  return {
    scaleL: clamp(nnL[mid] ?? 24, 12, 80),
    scaleA: clamp(nnA[mid] ?? 10, 0, 45),
    scaleB: clamp(nnB[mid] ?? 10, 0, 45),
  };
}

/**
 * Cuantiza celdas a una paleta dada en espacio CIE L*a*b* usando CIEDE2000,
 * con soporte para dithering 'none', 'floyd-steinberg' y 'bayer' (4×4).
 *
 * @param {Array<{ r?: number, g?: number, b?: number, hex?: string, lab?: { L: number, a: number, b: number }, row?: number, col?: number, centroidCm?: [number, number], areaCm2?: number, nominalAreaCm2?: number }>} cells
 * @param {Array<{ r?: number, g?: number, b?: number, hex?: string, lab?: { L: number, a: number, b: number } }>} palette
 * @param {{ ditherMode?: 'none' | 'floyd-steinberg' | 'bayer', ditherStrength?: number, seed?: number }} [options={}]
 * @returns {{
 *   assignments: Uint8Array,
 *   palette: Array<{ id: number, r: number, g: number, b: number, hex: string, lab: { L: number, a: number, b: number }, count: number }>,
 *   counts: Uint32Array
 * }}
 */
export function quantizeWithDithering(
  cells,
  palette,
  { ditherMode = 'none', ditherStrength = 0.65, seed = 20261120 } = {}
) {
  const n = Array.isArray(cells) ? cells.length : 0;
  const rawPal = Array.isArray(palette) ? palette : [];

  if (n === 0 || rawPal.length === 0) {
    return {
      assignments: new Uint8Array(n),
      palette: rawPal.map((p, idx) => {
        const [L, a, b] = paletteEntryToLabTuple(p);
        const rgb = Number.isFinite(p?.r) ? { r: p.r, g: p.g, b: p.b } : labToSrgb(L, a, b);
        return {
          ...p,
          id: p?.id ?? idx + 1,
          r: Math.round(rgb.r),
          g: Math.round(rgb.g),
          b: Math.round(rgb.b),
          hex: p?.hex ? p.hex.toUpperCase() : rgbToHex(rgb.r, rgb.g, rgb.b),
          lab: { L, a, b },
          count: 0,
        };
      }),
      counts: new Uint32Array(rawPal.length),
    };
  }

  const K = rawPal.length;
  const palL = new Float64Array(K);
  const palA = new Float64Array(K);
  const palB = new Float64Array(K);
  const normPalette = rawPal.map((p, idx) => {
    const [L, a, b] = paletteEntryToLabTuple(p);
    palL[idx] = L;
    palA[idx] = a;
    palB[idx] = b;
    const rgb =
      Number.isFinite(p?.r) && Number.isFinite(p?.g) && Number.isFinite(p?.b)
        ? { r: Math.round(p.r), g: Math.round(p.g), b: Math.round(p.b) }
        : labToSrgb(L, a, b);
    return {
      ...p,
      id: p?.id ?? idx + 1,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      hex: p?.hex ? p.hex.toUpperCase() : rgbToHex(rgb.r, rgb.g, rgb.b),
      lab: { L, a, b },
      count: 0,
    };
  });

  const strength = clamp(Number.isFinite(ditherStrength) ? ditherStrength : 0.65, 0, 1);
  const mode = ditherMode || 'none';
  const assignments = new Uint8Array(n);
  const counts = new Uint32Array(K);

  const cellL = new Float64Array(n);
  const cellA = new Float64Array(n);
  const cellB = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [L, a, b] = sampleToLabTuple(cells[i]);
    cellL[i] = L;
    cellA[i] = a;
    cellB[i] = b;
  }

  if (mode === 'none' || strength <= 0) {
    for (let i = 0; i < n; i++) {
      const k = nearestPaletteIndexCiede2000(cellL[i], cellA[i], cellB[i], palL, palA, palB);
      assignments[i] = k;
      counts[k]++;
    }
  } else if (mode === 'bayer') {
    const virtualCols = Math.max(1, Math.round(Math.sqrt(n)));
    const coords = new Array(n);
    for (let i = 0; i < n; i++) {
      coords[i] = getCellCenter(cells[i], i, virtualCols);
    }
    const step = estimateSpatialStep(cells, coords);
    const { scaleL, scaleA, scaleB } = computeBayerLabScales(palL, palA, palB);
    const rng = createMulberry32(seed);
    const phaseX = Math.floor(rng() * 4);
    const phaseY = Math.floor(rng() * 4);

    for (let i = 0; i < n; i++) {
      const c = cells[i];
      let gx;
      let gy;
      if (Number.isInteger(c?.col) && Number.isInteger(c?.row)) {
        gx = c.col;
        gy = c.row;
      } else {
        gx = Math.floor(coords[i][0] / step);
        gy = Math.floor(coords[i][1] / step);
      }

      const bx = (((gx + phaseX) % 4) + 4) % 4;
      const by = (((gy + phaseY) % 4) + 4) % 4;
      const threshold = (BAYER_4X4[by][bx] + 0.5) / 16 - 0.5; // [-0.46875, +0.46875]

      const tL = clamp(cellL[i] + threshold * scaleL * strength, 0, 100);
      const tA = clamp(cellA[i] + threshold * scaleA * strength, -128, 127);
      const tB = clamp(cellB[i] + threshold * scaleB * strength, -128, 127);

      const k = nearestPaletteIndexCiede2000(tL, tA, tB, palL, palA, palB);
      assignments[i] = k;
      counts[k]++;
    }
  } else if (mode === 'floyd-steinberg') {
    const virtualCols = Math.max(1, Math.round(Math.sqrt(n)));
    const coords = new Array(n);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < n; i++) {
      const pt = getCellCenter(cells[i], i, virtualCols);
      coords[i] = pt;
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }

    const step = estimateSpatialStep(cells, coords);
    const rowBand = Math.max(1e-4, step * 0.35);

    // Orden de lectura espacial por filas / centroides (arriba -> abajo, izquierda -> derecha)
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((ia, ib) => {
      const ca = cells[ia];
      const cb = cells[ib];
      if (
        !Array.isArray(ca?.centroidCm) &&
        !Array.isArray(cb?.centroidCm) &&
        Number.isFinite(ca?.row) &&
        Number.isFinite(cb?.row) &&
        Number.isFinite(ca?.col) &&
        Number.isFinite(cb?.col)
      ) {
        if (ca.row !== cb.row) return ca.row - cb.row;
        return ca.col - cb.col;
      }
      const ya = coords[ia][1];
      const yb = coords[ib][1];
      const bandA = Math.round(ya / rowBand);
      const bandB = Math.round(yb / rowBand);
      if (bandA !== bandB) return bandA - bandB;
      if (Math.abs(coords[ia][0] - coords[ib][0]) > 1e-6) {
        return coords[ia][0] - coords[ib][0];
      }
      return ya - yb;
    });

    const rankOf = new Int32Array(n);
    for (let p = 0; p < n; p++) {
      rankOf[order[p]] = p;
    }

    // Hash espacial para localizar vecinos inmediatos en O(1)
    const bucketSize = Math.max(1e-4, step);
    const gridCols = Math.max(1, Math.ceil((maxX - minX) / bucketSize) + 1);
    const gridRows = Math.max(1, Math.ceil((maxY - minY) / bucketSize) + 1);
    const buckets = new Array(gridCols * gridRows);
    for (let i = 0; i < n; i++) {
      const bx = clamp(Math.floor((coords[i][0] - minX) / bucketSize), 0, gridCols - 1);
      const by = clamp(Math.floor((coords[i][1] - minY) / bucketSize), 0, gridRows - 1);
      const bi = by * gridCols + bx;
      if (!buckets[bi]) buckets[bi] = [];
      buckets[bi].push(i);
    }

    const errL = new Float64Array(n);
    const errA = new Float64Array(n);
    const errB = new Float64Array(n);
    const maxRadiusSq = (step * 2.1) * (step * 2.1);

    for (let pos = 0; pos < n; pos++) {
      const i = order[pos];
      const tL = clamp(cellL[i] + errL[i], 0, 100);
      const tA = clamp(cellA[i] + errA[i], -128, 127);
      const tB = clamp(cellB[i] + errB[i], -128, 127);

      const bestK = nearestPaletteIndexCiede2000(tL, tA, tB, palL, palA, palB);
      assignments[i] = bestK;
      counts[bestK]++;

      const dL = (tL - palL[bestK]) * strength;
      const dA = (tA - palA[bestK]) * strength;
      const dB = (tB - palB[bestK]) * strength;
      if (Math.abs(dL) + Math.abs(dA) + Math.abs(dB) < 1e-6) continue;

      const cx = coords[i][0];
      const cy = coords[i][1];
      const bx = clamp(Math.floor((cx - minX) / bucketSize), 0, gridCols - 1);
      const by = clamp(Math.floor((cy - minY) / bucketSize), 0, gridRows - 1);

      // 4 sectores direccionales de Floyd-Steinberg: Right (7/16), BottomLeft (3/16), Bottom (5/16), BottomRight (1/16)
      let rIdx = -1;
      let rDist = Infinity;
      let blIdx = -1;
      let blDist = Infinity;
      let bIdx = -1;
      let bDist = Infinity;
      let brIdx = -1;
      let brDist = Infinity;

      const byEnd = Math.min(gridRows - 1, by + 2);
      const bxStart = Math.max(0, bx - 2);
      const bxEnd = Math.min(gridCols - 1, bx + 2);

      for (let ny = by; ny <= byEnd; ny++) {
        for (let nx = bxStart; nx <= bxEnd; nx++) {
          const list = buckets[ny * gridCols + nx];
          if (!list) continue;
          for (let li = 0; li < list.length; li++) {
            const j = list[li];
            if (rankOf[j] <= pos) continue;

            const dx = coords[j][0] - cx;
            const dy = coords[j][1] - cy;
            const distSq = dx * dx + dy * dy;
            if (distSq > maxRadiusSq || distSq < 1e-12) continue;

            if (Math.abs(dy) <= step * 0.48 && dx > 0) {
              if (distSq < rDist) {
                rDist = distSq;
                rIdx = j;
              }
            } else if (dy > step * 0.22) {
              if (dx < -step * 0.35) {
                if (distSq < blDist) {
                  blDist = distSq;
                  blIdx = j;
                }
              } else if (dx > step * 0.35) {
                if (distSq < brDist) {
                  brDist = distSq;
                  brIdx = j;
                }
              } else if (distSq < bDist) {
                bDist = distSq;
                bIdx = j;
              }
            }
          }
        }
      }

      let wSum = 0;
      if (rIdx >= 0) wSum += 7;
      if (blIdx >= 0) wSum += 3;
      if (bIdx >= 0) wSum += 5;
      if (brIdx >= 0) wSum += 1;

      if (wSum > 0) {
        const invSum = 1 / Math.max(16, wSum);
        if (rIdx >= 0) {
          const w = 7 * invSum;
          errL[rIdx] += dL * w;
          errA[rIdx] += dA * w;
          errB[rIdx] += dB * w;
        }
        if (blIdx >= 0) {
          const w = 3 * invSum;
          errL[blIdx] += dL * w;
          errA[blIdx] += dA * w;
          errB[blIdx] += dB * w;
        }
        if (bIdx >= 0) {
          const w = 5 * invSum;
          errL[bIdx] += dL * w;
          errA[bIdx] += dA * w;
          errB[bIdx] += dB * w;
        }
        if (brIdx >= 0) {
          const w = 1 * invSum;
          errL[brIdx] += dL * w;
          errA[brIdx] += dA * w;
          errB[brIdx] += dB * w;
        }
      }
    }
  } else {
    throw new Error(`ditherMode no soportado: ${mode}`);
  }

  for (let k = 0; k < K; k++) {
    normPalette[k].count = counts[k];
  }

  return {
    assignments,
    palette: normPalette,
    counts,
  };
}
