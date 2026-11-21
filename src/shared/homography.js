/**
 * Motor matemático puro de Homografía 2D (DLT Normalizada de Hartley) y utilidades
 * geométricas/visuales de Realidad Aumentada en pared y piso para GuíaMosaico.
 *
 * Compatible con Node.js y Browser ES Modules sin dependencias externas ni OpenCV WASM.
 */

const EPS = 1e-10;

function isPoint2D(pt) {
  return (
    Array.isArray(pt) &&
    pt.length >= 2 &&
    Number.isFinite(pt[0]) &&
    Number.isFinite(pt[1])
  );
}

function triangleSignedArea2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersectProper(p1, p2, p3, p4) {
  const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = triangleSignedArea2(p3, p4, p1);
  const d2 = triangleSignedArea2(p3, p4, p2);
  const d3 = triangleSignedArea2(p1, p2, p3);
  const d4 = triangleSignedArea2(p1, p2, p4);

  if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
      ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) {
    return true;
  }
  // Colinealidad sobre segmentos no adyacentes
  const onSeg = (a, b, p) =>
    Math.abs(triangleSignedArea2(a, b, p)) <= 1e-9 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9;

  if (Math.abs(d1) <= 1e-9 && onSeg(p3, p4, p1)) return true;
  if (Math.abs(d2) <= 1e-9 && onSeg(p3, p4, p2)) return true;
  if (Math.abs(d3) <= 1e-9 && onSeg(p1, p2, p3)) return true;
  if (Math.abs(d4) <= 1e-9 && onSeg(p1, p2, p4)) return true;
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

/**
 * Verifica 4 puntos `[[x0,y0],[x1,y1],[x2,y2],[x3,y3]]`:
 * - Que sean finitos.
 * - Que no haya 3 puntos colineales (área de cada uno de los 4 triángulos >= minArea * 0.1).
 * - Que no existan cruces degenerados entre lados opuestos (auto-intersección) ni vértices repetidos.
 * - Que el cuadrilátero sea estrictamente convexo y con área >= minArea.
 *
 * @param {Array<[number, number]>} pts
 * @param {number} [minArea=25]
 * @returns {{ valid: boolean, reason: string, area: number }}
 */
export function validateQuadNonCollinear(pts, minArea = 25) {
  if (!Array.isArray(pts) || pts.length !== 4) {
    return {
      valid: false,
      reason: 'Se requieren exactamente 4 puntos [x, y] para definir el cuadrilátero.',
      area: 0,
    };
  }

  for (let i = 0; i < 4; i++) {
    if (!isPoint2D(pts[i])) {
      return {
        valid: false,
        reason: `El punto ${i + 1} contiene coordenadas inválidas o no finitas.`,
        area: 0,
      };
    }
  }

  const minTriArea = Math.max(1e-6, minArea * 0.1);

  // Verificar distancia mínima entre pares de vértices
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const dist = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (dist < 1e-4) {
        return {
          valid: false,
          reason: `Los vértices ${i + 1} y ${j + 1} coinciden o están demasiado cerca.`,
          area: 0,
        };
      }
    }
  }

  // Verificar los 4 triángulos posibles (ninguna terna puede ser colineal en homografía proyectiva)
  const triples = [
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ];
  const triSigns = [];
  for (let t = 0; t < triples.length; t++) {
    const [ia, ib, ic] = triples[t];
    const cross = triangleSignedArea2(pts[ia], pts[ib], pts[ic]);
    const triArea = Math.abs(cross) * 0.5;
    if (triArea < minTriArea) {
      return {
        valid: false,
        reason: `Puntos colineales o casi colineales detectados (triángulo ${ia + 1}-${ib + 1}-${ic + 1}, área ${triArea.toFixed(2)} < ${minTriArea.toFixed(2)}).`,
        area: 0,
      };
    }
    triSigns.push(Math.sign(cross));
  }

  // Área Shoelace
  let twiceArea = 0;
  for (let i = 0; i < 4; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % 4];
    twiceArea += p1[0] * p2[1] - p2[0] * p1[1];
  }
  const area = Math.abs(twiceArea) * 0.5;

  // Cruce de lados opuestos: (0-1 vs 2-3) y (1-2 vs 3-0)
  if (
    segmentsIntersectProper(pts[0], pts[1], pts[2], pts[3]) ||
    segmentsIntersectProper(pts[1], pts[2], pts[3], pts[0])
  ) {
    return {
      valid: false,
      reason: 'El cuadrilátero presenta lados cruzados (auto-intersección en moño).',
      area,
    };
  }

  // Verificar convexidad consistente en los 4 vértices para evitar inversiones proyectivas
  let expectedSign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = triangleSignedArea2(a, b, c);
    const s = Math.sign(cross);
    if (expectedSign === 0) expectedSign = s;
    else if (s !== expectedSign) {
      return {
        valid: false,
        reason: 'El cuadrilátero es cóncavo o está invertido; reordena las esquinas en sentido horario o antihorario.',
        area,
      };
    }
  }

  if (area < minArea) {
    return {
      valid: false,
      reason: `Área del cuadrilátero demasiado pequeña (${area.toFixed(2)} px² < ${minArea} px²).`,
      area,
    };
  }

  return {
    valid: true,
    reason: 'Cuadrilátero proyectivo válido.',
    area,
  };
}

/**
 * Calcula matriz de normalización de Hartley T (3x3 row-major) tal que:
 * - El centroide se traslada al origen (0, 0).
 * - La distancia RMS al origen es exactamente sqrt(2).
 *
 * @param {Array<[number, number]>} pts
 * @returns {{ T: number[], Tinv: number[], normPts: Array<[number, number]> }}
 */
function computeHartleyNormalization(pts) {
  let mx = 0;
  let my = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    mx += pts[i][0];
    my += pts[i][1];
  }
  mx /= n;
  my /= n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i][0] - mx;
    const dy = pts[i][1] - my;
    sumSq += dx * dx + dy * dy;
  }

  const rms = Math.sqrt(sumSq / n);
  if (!Number.isFinite(rms) || rms <= EPS) {
    throw new Error('No se pudo normalizar el cuadrilátero: puntos degenerados o idénticos.');
  }

  const s = Math.SQRT2 / rms;
  const invS = 1 / s;

  // T = [ s, 0, -s*mx; 0, s, -s*my; 0, 0, 1 ]
  const T = [
    s, 0, -s * mx,
    0, s, -s * my,
    0, 0, 1,
  ];
  // Tinv = [ 1/s, 0, mx; 0, 1/s, my; 0, 0, 1 ]
  const Tinv = [
    invS, 0, mx,
    0, invS, my,
    0, 0, 1,
  ];

  const normPts = pts.map(([x, y]) => [(x - mx) * s, (y - my) * s]);
  return { T, Tinv, normPts };
}

function mulMat3(A, B) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    const r3 = r * 3;
    for (let c = 0; c < 3; c++) {
      out[r3 + c] =
        A[r3] * B[c] +
        A[r3 + 1] * B[c + 3] +
        A[r3 + 2] * B[c + 6];
    }
  }
  return out;
}

/**
 * Resuelve sistema lineal Ax = b de NxN mediante eliminación gaussiana con pivoteo parcial.
 *
 * @param {number[][]} A
 * @param {number[]} b
 * @returns {number[]}
 */
function solveLinearSystemGaussian(A, b) {
  const n = b.length;
  const M = A.map((row, idx) => [...row, b[idx]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r][col]);
      if (val > maxAbs) {
        maxAbs = val;
        pivotRow = r;
      }
    }

    if (!Number.isFinite(maxAbs) || maxAbs < 1e-12) {
      throw new Error('Sistema lineal singular al resolver la homografía (puntos colineales o degenerados).');
    }

    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivot = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / pivot;
      if (factor === 0) continue;
      M[r][col] = 0;
      for (let c = col + 1; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let c = r + 1; c < n; c++) {
      sum -= M[r][c] * x[c];
    }
    x[r] = sum / M[r][r];
    if (!Number.isFinite(x[r])) {
      throw new Error('Resultado numérico no finito al resolver la matriz de homografía.');
    }
  }

  return x;
}

/**
 * Aplica la homografía `H` (row-major 3x3) al punto `(x, y)` con división homogénea segura.
 *
 * @param {number[]} H
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]}
 */
export function applyHomographyPoint(H, x, y) {
  if (!Array.isArray(H) || H.length !== 9) {
    throw new Error('La matriz de homografía H debe tener exactamente 9 elementos.');
  }
  const w = H[6] * x + H[7] * y + H[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) {
    throw new Error('División homogénea degenerada (w cercano a 0) al proyectar punto.');
  }
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

/**
 * Calcula la homografía 2D mediante DLT normalizada de Hartley (4 puntos).
 * Normaliza con `H[8] = 1`, valida error de reproyección y rechaza configuraciones colineales.
 *
 * @param {Array<[number, number]>} srcPts
 * @param {Array<[number, number]>} dstPts
 * @returns {{ H: number[], maxErrorPx: number }}
 */
export function solveHomographyDlt(srcPts, dstPts) {
  const srcCheck = validateQuadNonCollinear(srcPts, 1);
  if (!srcCheck.valid) {
    throw new Error(`Cuadrilátero origen inválido: ${srcCheck.reason}`);
  }
  const dstCheck = validateQuadNonCollinear(dstPts, 25);
  if (!dstCheck.valid) {
    throw new Error(`Cuadrilátero destino inválido: ${dstCheck.reason}`);
  }

  const { T: Tsrc, normPts: sNorm } = computeHartleyNormalization(srcPts);
  const { Tinv: TdstInv, normPts: dNorm } = computeHartleyNormalization(dstPts);

  // Construimos el sistema 8x8 con h22 = 1 en espacio normalizado (centroide en 0, RMS = sqrt(2)).
  // x' * (h20*x + h21*y + 1) = h00*x + h01*y + h02
  // y' * (h20*x + h21*y + 1) = h10*x + h11*y + h12
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = sNorm[i];
    const [u, v] = dNorm[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const hVec = solveLinearSystemGaussian(A, b);
  const Hnorm = [
    hVec[0], hVec[1], hVec[2],
    hVec[3], hVec[4], hVec[5],
    hVec[6], hVec[7], 1,
  ];

  // Desnormalizar: H = inv(Tdst) * Hnorm * Tsrc
  const Hraw = mulMat3(TdstInv, mulMat3(Hnorm, Tsrc));
  const scale = Hraw[8];
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) {
    throw new Error('Matriz de homografía degenerada: el elemento H[8] es cercano a cero.');
  }

  const H = Hraw.map((v) => v / scale);

  // Verificar invertibilidad de H
  const det =
    H[0] * (H[4] * H[8] - H[5] * H[7]) -
    H[1] * (H[3] * H[8] - H[5] * H[6]) +
    H[2] * (H[3] * H[7] - H[4] * H[6]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('La matriz de homografía resultante es singular (determinante ~ 0).');
  }

  let maxErrorPx = 0;
  for (let i = 0; i < 4; i++) {
    const [px, py] = applyHomographyPoint(H, srcPts[i][0], srcPts[i][1]);
    const err = Math.hypot(px - dstPts[i][0], py - dstPts[i][1]);
    if (!Number.isFinite(err)) {
      throw new Error('Error de reproyección no finito tras resolver la homografía.');
    }
    if (err > maxErrorPx) maxErrorPx = err;
  }

  if (maxErrorPx > 0.5) {
    throw new Error(
      `Homografía imprecisa: error máximo de reproyección ${maxErrorPx.toFixed(4)} px > 0.5 px.`
    );
  }

  return { H, maxErrorPx };
}

/**
 * Calcula la matriz inversa 3x3 normalizada (`inv[8] = 1` cuando es no nulo).
 *
 * @param {number[]} H
 * @returns {number[]}
 */
export function invertHomography3x3(H) {
  if (!Array.isArray(H) || H.length !== 9) {
    throw new Error('La matriz H debe tener 9 elementos para invertir.');
  }

  const a = H[0], b = H[1], c = H[2];
  const d = H[3], e = H[4], f = H[5];
  const g = H[6], h = H[7], i = H[8];

  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;

  const c10 = -(b * i - c * h);
  const c11 = a * i - c * g;
  const c12 = -(a * h - b * g);

  const c20 = b * f - c * e;
  const c21 = -(a * f - c * d);
  const c22 = a * e - b * d;

  const det = a * c00 + b * c01 + c * c02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('No se puede invertir la matriz de homografía: determinante cercano a cero.');
  }

  const inv = [
    c00 / det, c10 / det, c20 / det,
    c01 / det, c11 / det, c21 / det,
    c02 / det, c12 / det, c22 / det,
  ];

  if (Math.abs(inv[8]) < 1e-12) {
    throw new Error('La matriz inversa tiene inv[8] cercano a cero y no puede normalizarse.');
  }

  const norm = inv[8];
  return inv.map((v) => v / norm);
}

/**
 * Calcula el string CSS `matrix3d(...)` column-major desde el rectángulo fuente
 * `[0,0], [srcW,0], [srcW,srcH], [0,srcH]` hacia las 4 esquinas destino `dstPts`.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {Array<[number, number]>} dstPts
 * @returns {{ matrix3d: string, H: number[], maxErrorPx: number }}
 */
export function computeCssMatrix3d(srcW, srcH, dstPts) {
  if (!Number.isFinite(srcW) || srcW <= 0 || !Number.isFinite(srcH) || srcH <= 0) {
    throw new Error(`Dimensiones de origen inválidas para matrix3d: ${srcW}×${srcH}`);
  }

  const srcPts = [
    [0, 0],
    [srcW, 0],
    [srcW, srcH],
    [0, srcH],
  ];

  const { H, maxErrorPx } = solveHomographyDlt(srcPts, dstPts);

  const fmt = (n) => {
    const clean = Math.abs(n) < 1e-12 ? 0 : n;
    return clean.toFixed(8);
  };

  // matrix3d en CSS es column-major 4x4:
  // [ h00, h10, 0, h20,  h01, h11, 0, h21,  0, 0, 1, 0,  h02, h12, 0, h22(=1) ]
  const values = [
    fmt(H[0]), fmt(H[3]), '0', fmt(H[6]),
    fmt(H[1]), fmt(H[4]), '0', fmt(H[7]),
    '0', '0', '1', '0',
    fmt(H[2]), fmt(H[5]), '0', '1',
  ];

  return {
    matrix3d: `matrix3d(${values.join(', ')})`,
    H,
    maxErrorPx,
  };
}

/**
 * Genera las 4 esquinas iniciales por defecto dentro del escenario AR (`stageW × stageH`)
 * respetando el aspecto físico real del mural (`muralWcm / muralHcm`).
 *
 * @param {number} stageW
 * @param {number} stageH
 * @param {number} muralWcm
 * @param {number} muralHcm
 * @param {'wall' | 'floor'} [preset='wall']
 * @returns {Array<[number, number]>}
 */
export function computeDefaultArCorners(stageW, stageH, muralWcm, muralHcm, preset = 'wall') {
  const sw = Math.max(120, Number(stageW) || 800);
  const sh = Math.max(120, Number(stageH) || 540);
  const mw = Math.max(5, Number(muralWcm) || 120);
  const mh = Math.max(5, Number(muralHcm) || 90);
  const ratio = mw / mh;

  if (preset === 'floor') {
    const topY = sh * 0.36;
    const botY = sh * 0.85;
    const perspH = botY - topY;
    // Anchura base proporcional al alto aparente, limitada para caber cómodamente en escena
    const baseBotW = Math.min(sw * 0.72, Math.max(sw * 0.34, perspH * ratio * 1.12));
    const topW = baseBotW * 0.56;
    const cx = sw * 0.5;

    return [
      [cx - topW * 0.5, topY],
      [cx + topW * 0.5, topY],
      [cx + baseBotW * 0.5, botY],
      [cx - baseBotW * 0.5, botY],
    ];
  }

  // Preset 'wall': rectángulo centrado ~58% del escenario conservando relación exacta W/H
  const maxW = sw * 0.58;
  const maxH = sh * 0.58;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }

  const x0 = (sw - w) * 0.5;
  const y0 = (sh - h) * 0.5;
  return [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
}

/**
 * Calcula métricas de pantalla y etiquetas dimensionales reales para el overlay AR.
 *
 * @param {Array<[number, number]>} dstPts
 * @param {{ widthCm?: number, heightCm?: number }} [config={}]
 * @param {{ totalPages?: number } | null} [printMetrics=null]
 * @param {number} [totalTiles=0]
 * @param {number | null} [referenceWallWidthCm=null]
 */
export function computeRealWorldQuadMetrics(
  dstPts,
  config = {},
  printMetrics = null,
  totalTiles = 0,
  referenceWallWidthCm = null
) {
  const widthCm = Number(config?.widthCm) || 120;
  const heightCm = Number(config?.heightCm) || 90;
  const areaM2 = ((widthCm * heightCm) / 10000).toFixed(2);
  const totalPages = Number(printMetrics?.totalPages) || 0;
  const tilesCount = Math.max(0, Math.round(Number(totalTiles) || 0));

  const formatCm = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));
  const widthLabel = `${formatCm(widthCm)} cm`;
  const heightLabel = `${formatCm(heightCm)} cm`;
  const sheetsLabel = totalPages > 0 ? `${totalPages} ${totalPages === 1 ? 'hoja' : 'hojas'}` : '— hojas';
  const tilesLabel = tilesCount > 0 ? `${tilesCount.toLocaleString('es-AR')} teselas` : 'Modo Póster / Directo';

  const pts = Array.isArray(dstPts) && dstPts.length === 4
    ? dstPts
    : computeDefaultArCorners(800, 540, widthCm, heightCm, 'wall');

  const mid = (a, b) => [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  const topMid = mid(pts[0], pts[1]);
  const rightMid = mid(pts[1], pts[2]);
  const bottomMid = mid(pts[2], pts[3]);
  const leftMid = mid(pts[3], pts[0]);

  const topLenPx = dist(pts[0], pts[1]);
  const rightLenPx = dist(pts[1], pts[2]);
  const bottomLenPx = dist(pts[2], pts[3]);
  const leftLenPx = dist(pts[3], pts[0]);

  let referenceScaleInfo = null;
  if (Number.isFinite(referenceWallWidthCm) && referenceWallWidthCm > 0) {
    const coveragePct = (widthCm / referenceWallWidthCm) * 100;
    referenceScaleInfo = {
      referenceWallWidthCm,
      coveragePct: Number(coveragePct.toFixed(1)),
      label: `Ocupa ${coveragePct.toFixed(1)}% del ancho real (${formatCm(referenceWallWidthCm)} cm)`,
    };
  }

  return {
    widthCm,
    heightCm,
    widthLabel,
    heightLabel,
    areaM2,
    sheetsLabel,
    tilesLabel,
    edgeMidpoints: {
      top: topMid,
      right: rightMid,
      bottom: bottomMid,
      left: leftMid,
    },
    edgeLengthsPx: {
      top: Number(topLenPx.toFixed(2)),
      right: Number(rightLenPx.toFixed(2)),
      bottom: Number(bottomLenPx.toFixed(2)),
      left: Number(leftLenPx.toFixed(2)),
    },
    referenceScaleInfo,
  };
}

/**
 * Retorna una escena SVG 100% offline para probar Realidad Aumentada incluso sin cámara física.
 * - `'wall'`: muro de estudio minimalista con zócalo, lámpara colgante, repisa y planta de escala.
 * - `'floor'`: patio/piso en perspectiva geométrica clara con líneas de fuga.
 *
 * @param {'wall' | 'floor'} [scene='wall']
 * @returns {string}
 */
export function getBuiltInArSceneSvg(scene = 'wall') {
  if (scene === 'floor') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="gm-ar-floor-sky" x1="0" y1="0" x2="0" y2="260" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#dfe6df" />
      <stop offset="100%" stop-color="#ece7dc" />
    </linearGradient>
    <linearGradient id="gm-ar-floor-slab" x1="0" y1="240" x2="0" y2="800" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#d7d0c2" />
      <stop offset="100%" stop-color="#c3b9a6" />
    </linearGradient>
  </defs>
  <!-- Fondo muro superior del patio -->
  <rect x="0" y="0" width="1200" height="250" fill="url(#gm-ar-floor-sky)" />
  <rect x="0" y="232" width="1200" height="18" fill="#a89f8d" />
  <!-- Macetero y banco de referencia al fondo -->
  <rect x="115" y="160" width="180" height="72" rx="4" fill="#9c5b38" opacity="0.88" />
  <rect x="108" y="152" width="194" height="12" rx="3" fill="#bd754e" />
  <ellipse cx="1010" cy="185" rx="54" ry="38" fill="#36594d" opacity="0.85" />
  <ellipse cx="980" cy="170" rx="34" ry="26" fill="#5c8276" opacity="0.85" />
  <rect x="975" y="198" width="70" height="36" rx="4" fill="#bd754e" />
  <!-- Piso en perspectiva -->
  <rect x="0" y="250" width="1200" height="550" fill="url(#gm-ar-floor-slab)" />
  <!-- Líneas de fuga hacia punto central (600, 110) -->
  <g stroke="#9b917f" stroke-width="1.5" opacity="0.55">
    <line x1="600" y1="250" x2="600" y2="800" />
    <line x1="490" y1="250" x2="220" y2="800" />
    <line x1="380" y1="250" x2="-140" y2="800" />
    <line x1="270" y1="250" x2="-480" y2="800" />
    <line x1="710" y1="250" x2="980" y2="800" />
    <line x1="820" y1="250" x2="1340" y2="800" />
    <line x1="930" y1="250" x2="1680" y2="800" />
    <line x1="0" y1="295" x2="1200" y2="295" />
    <line x1="0" y1="355" x2="1200" y2="355" />
    <line x1="0" y1="435" x2="1200" y2="435" />
    <line x1="0" y1="540" x2="1200" y2="540" />
    <line x1="0" y1="675" x2="1200" y2="675" />
  </g>
  <text x="28" y="38" font-family="sans-serif" font-size="16" font-weight="600" fill="#24332d" opacity="0.65">Escena AR · Piso / Patio en Perspectiva</text>
</svg>`;
  }

  // Escena 'wall': Muro de estudio minimalista con zócalo, lámpara y planta para referencia de escala
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="gm-ar-wall-bg" x1="0" y1="0" x2="0" y2="685" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#f3efe6" />
      <stop offset="65%" stop-color="#ebe5d8" />
      <stop offset="100%" stop-color="#e0d8c8" />
    </linearGradient>
    <radialGradient id="gm-ar-lamp-glow" cx="50%" cy="22%" r="55%">
      <stop offset="0%" stop-color="#fffdf8" stop-opacity="0.78" />
      <stop offset="100%" stop-color="#fffdf8" stop-opacity="0" />
    </radialGradient>
  </defs>
  <!-- Pared principal de estudio -->
  <rect x="0" y="0" width="1200" height="688" fill="url(#gm-ar-wall-bg)" />
  <rect x="0" y="0" width="1200" height="688" fill="url(#gm-ar-lamp-glow)" />
  <!-- Zócalo y suelo -->
  <rect x="0" y="662" width="1200" height="26" fill="#d5cdbc" />
  <line x1="0" y1="662" x2="1200" y2="662" stroke="#bfb6a3" stroke-width="2" />
  <rect x="0" y="688" width="1200" height="112" fill="#c7bcab" />
  <line x1="0" y1="688" x2="1200" y2="688" stroke="#a69c8a" stroke-width="2" />
  <!-- Lámpara colgante superior izquierda -->
  <line x1="168" y1="0" x2="168" y2="115" stroke="#24332d" stroke-width="3" />
  <path d="M 118 158 C 118 122 142 110 168 110 C 194 110 218 122 218 158 Z" fill="#263f36" />
  <ellipse cx="168" cy="158" rx="46" ry="7" fill="#f7e6c4" />
  <!-- Banco/repisa de referencia a la izquierda -->
  <rect x="65" y="575" width="170" height="16" rx="3" fill="#9c5b38" />
  <rect x="85" y="591" width="14" height="96" fill="#7c472b" />
  <rect x="200" y="591" width="14" height="96" fill="#7c472b" />
  <!-- Planta en maceta a la derecha para referencia real -->
  <path d="M 1015 605 L 1110 605 L 1094 688 L 1031 688 Z" fill="#bd754e" />
  <ellipse cx="1062" cy="605" rx="48" ry="8" fill="#9c5b38" />
  <path d="M 1062 602 C 1030 535 1002 510 982 465 C 1020 488 1044 528 1062 602 Z" fill="#36594d" />
  <path d="M 1062 602 C 1054 515 1065 462 1085 415 C 1096 465 1088 532 1062 602 Z" fill="#467262" />
  <path d="M 1064 602 C 1095 540 1126 516 1152 480 C 1132 528 1102 560 1064 602 Z" fill="#263f36" />
  <!-- Regla sutil de referencia en esquina superior derecha -->
  <g opacity="0.45" transform="translate(1030, 26)">
    <rect x="0" y="0" width="140" height="24" rx="4" fill="#fffdf8" stroke="#bfb6a3" />
    <text x="70" y="16" text-anchor="middle" font-family="monospace" font-size="11" fill="#24332d">MURO ESTUDIO</text>
  </g>
</svg>`;
}
