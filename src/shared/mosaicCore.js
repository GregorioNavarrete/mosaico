/**
 * Núcleo compartido de mosaicos (Node.js + Browser ES Modules).
 * Implementa utilidades cromáticas Redmean, métricas geométricas de teselas (grid y brick_50),
 * mapeo físico-lógico con soporte de Modo Espejo, adyacencia física exacta en brick_50,
 * Flood Fill iterativo (BFS), reemplazo global, compresión RLE sin pérdida,
 * cuantización K-Means++ Redmean y la ilustración SVG mediterránea offline.
 */

export const UNUSED_CELL = 255;

/**
 * Convierte componentes RGB [0..255] a hexadecimal #RRGGBB en mayúsculas.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/**
 * Convierte un color hexadecimal #RGB o #RRGGBB a { r, g, b }.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') {
    throw new Error(`Hex inválido: ${hex}`);
  }
  const clean = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return {
      r: Number.parseInt(clean[0] + clean[0], 16),
      g: Number.parseInt(clean[1] + clean[1], 16),
      b: Number.parseInt(clean[2] + clean[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return {
      r: Number.parseInt(clean.slice(0, 2), 16),
      g: Number.parseInt(clean.slice(2, 4), 16),
      b: Number.parseInt(clean.slice(4, 6), 16),
    };
  }
  throw new Error(`Hex inválido: ${hex}`);
}

/**
 * Luminancia perceptual Rec. 601 en rango [0..255].
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number}
 */
export function getLuminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Distancia perceptual aproximada entre dos colores RGB (métrica Redmean al cuadrado).
 * @param {number} r1
 * @param {number} g1
 * @param {number} b1
 * @param {number} r2
 * @param {number} g2
 * @param {number} b2
 * @returns {number}
 */
export function colorDistSq(r1, g1, b1, r2, g2, b2) {
  const rmean = (r1 + r2) * 0.5;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (((512 + rmean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rmean) * db * db) >> 8);
}

/**
 * Normaliza el identificador de patrón para soportar alias 'brick' y 'brick_50'.
 * @param {string} pattern
 * @returns {boolean}
 */
function isBrick50Pattern(pattern) {
  return pattern === 'brick_50' || pattern === 'brick';
}

/**
 * Calcula dimensiones y conteos de la grilla de teselas para un mural físico.
 *
 * @param {number} widthCm
 * @param {number} heightCm
 * @param {number} tileSizeCm
 * @param {string} [pattern='grid']
 * @returns {{
 *   widthCm: number,
 *   heightCm: number,
 *   tileSizeCm: number,
 *   pattern: string,
 *   isBrick50: boolean,
 *   tileCols: number,
 *   tileRows: number,
 *   maxRowCols: number,
 *   totalTiles: number
 * }}
 */
export function computeGridMetrics(widthCm, heightCm, tileSizeCm, pattern = 'grid') {
  if (!Number.isFinite(widthCm) || widthCm <= 0) {
    throw new Error(`widthCm inválido: ${widthCm}`);
  }
  if (!Number.isFinite(heightCm) || heightCm <= 0) {
    throw new Error(`heightCm inválido: ${heightCm}`);
  }
  if (!Number.isFinite(tileSizeCm) || tileSizeCm <= 0) {
    throw new Error(`tileSizeCm inválido: ${tileSizeCm}`);
  }

  const tileCols = Math.max(1, Math.ceil(widthCm / tileSizeCm));
  const tileRows = Math.max(1, Math.ceil(heightCm / tileSizeCm));
  const isBrick50 = isBrick50Pattern(pattern);
  const maxRowCols = isBrick50 ? tileCols + 1 : tileCols;

  let totalTiles = 0;
  if (!isBrick50) {
    totalTiles = tileCols * tileRows;
  } else {
    for (let r = 0; r < tileRows; r++) {
      const isOddRow = r % 2 === 1;
      const offsetXCm = isOddRow ? -tileSizeCm * 0.5 : 0;
      const rowCols = isOddRow ? tileCols + 1 : tileCols;
      for (let c = 0; c < rowCols; c++) {
        const x0 = Math.max(0, offsetXCm + c * tileSizeCm);
        const x1 = Math.min(widthCm, offsetXCm + (c + 1) * tileSizeCm);
        if (x1 > x0 + 1e-9) totalTiles++;
      }
    }
  }

  return {
    widthCm,
    heightCm,
    tileSizeCm,
    pattern,
    isBrick50,
    tileCols,
    tileRows,
    maxRowCols,
    totalTiles,
  };
}

/**
 * Devuelve la cantidad de columnas potenciales en una fila dada.
 * @param {number} row
 * @param {ReturnType<typeof computeGridMetrics>} metrics
 * @returns {number}
 */
function getRowColsCount(row, metrics) {
  return metrics.isBrick50 && row % 2 === 1 ? metrics.tileCols + 1 : metrics.tileCols;
}

/**
 * Obtiene el rectángulo en cm de la tesela (row, col) recortado a [0, widthCm] x [0, heightCm].
 * Aplica reflexión horizontal si `config.mirrorMode === true`.
 * Retorna null si la celda queda fuera del mural o tiene área nula.
 *
 * @param {number} row
 * @param {number} col
 * @param {ReturnType<typeof computeGridMetrics>} metrics
 * @param {{ mirrorMode?: boolean }} [config={}]
 * @returns {{
 *   row: number,
 *   col: number,
 *   xCm: number,
 *   yCm: number,
 *   wCm: number,
 *   hCm: number,
 *   x0Cm: number,
 *   y0Cm: number,
 *   x1Cm: number,
 *   y1Cm: number,
 *   logicalX0Cm: number,
 *   logicalX1Cm: number,
 *   isCut: boolean
 * } | null}
 */
export function getTileRectCm(row, col, metrics, config = {}) {
  if (!metrics || row < 0 || row >= metrics.tileRows) return null;
  const rowCols = getRowColsCount(row, metrics);
  if (col < 0 || col >= rowCols) return null;

  const t = metrics.tileSizeCm;
  const isOddRow = metrics.isBrick50 && row % 2 === 1;
  const offsetXCm = isOddRow ? -t * 0.5 : 0;

  const rawX0 = offsetXCm + col * t;
  const rawX1 = rawX0 + t;
  const rawY0 = row * t;
  const rawY1 = rawY0 + t;

  const logicalX0Cm = Math.max(0, rawX0);
  const logicalX1Cm = Math.min(metrics.widthCm, rawX1);
  const y0Cm = Math.max(0, rawY0);
  const y1Cm = Math.min(metrics.heightCm, rawY1);

  if (logicalX1Cm <= logicalX0Cm + 1e-9 || y1Cm <= y0Cm + 1e-9) {
    return null;
  }

  let x0Cm = logicalX0Cm;
  let x1Cm = logicalX1Cm;
  if (config?.mirrorMode) {
    x0Cm = metrics.widthCm - logicalX1Cm;
    x1Cm = metrics.widthCm - logicalX0Cm;
  }

  const wCm = x1Cm - x0Cm;
  const hCm = y1Cm - y0Cm;
  const isCut = wCm < t - 1e-6 || hCm < t - 1e-6;

  return {
    row,
    col,
    xCm: x0Cm,
    yCm: y0Cm,
    wCm,
    hCm,
    x0Cm,
    y0Cm,
    x1Cm,
    y1Cm,
    logicalX0Cm,
    logicalX1Cm,
    isCut,
  };
}

/**
 * Convierte coordenadas físicas (xCm, yCm) del lienzo/hoja a la tesela lógica { row, col, idx }.
 * En `mirrorMode`, invierte xCm respecto a `metrics.widthCm` para apuntar a la celda subyacente exacta.
 *
 * @param {number} xCm
 * @param {number} yCm
 * @param {ReturnType<typeof computeGridMetrics>} metrics
 * @param {{ mirrorMode?: boolean }} [config={}]
 * @param {Uint8Array | number[] | null} [grid=null]
 * @returns {{ row: number, col: number, idx: number } | null}
 */
export function cmToTileCoords(xCm, yCm, metrics, config = {}, grid = null) {
  if (!metrics) return null;
  if (!Number.isFinite(xCm) || !Number.isFinite(yCm)) return null;
  if (xCm < 0 || yCm < 0 || xCm >= metrics.widthCm || yCm >= metrics.heightCm) {
    return null;
  }

  const t = metrics.tileSizeCm;
  const row = Math.min(metrics.tileRows - 1, Math.floor(yCm / t));
  if (row < 0 || row >= metrics.tileRows) return null;

  const logicalXCm = config?.mirrorMode ? metrics.widthCm - xCm : xCm;
  const clampedLogicalX = Math.max(0, Math.min(metrics.widthCm - 1e-9, logicalXCm));

  const isOddRow = metrics.isBrick50 && row % 2 === 1;
  const offsetXCm = isOddRow ? -t * 0.5 : 0;
  const rowCols = getRowColsCount(row, metrics);

  let col = Math.floor((clampedLogicalX - offsetXCm) / t);
  if (col < 0) col = 0;
  if (col >= rowCols) col = rowCols - 1;

  const rect = getTileRectCm(row, col, metrics, { mirrorMode: false });
  if (!rect) return null;

  const idx = row * metrics.maxRowCols + col;
  if (grid && (idx < 0 || idx >= grid.length || grid[idx] === UNUSED_CELL)) {
    return null;
  }

  return { row, col, idx };
}

/**
 * Calcula los vecinos físicamente adyacentes (arista compartida) para la tesela (row, col).
 * En patrón `brick_50`:
 * - Misma fila: (row, col - 1) y (row, col + 1).
 * - Filas superior/inferior con distinto desplazamiento 0.5*t:
 *   - Si row es par (offset 0), la celda [c*t, (c+1)*t] comparte arista horizontal con
 *     las celdas de filas impares (offset -0.5*t) en columnas `col` ([ (c-0.5)t, (c+0.5)t ]) y `col + 1` ([ (c+0.5)t, (c+1.5)t ]).
 *   - Si row es impar (offset -0.5*t), la celda [(c-0.5)t, (c+0.5)t] comparte arista horizontal con
 *     las celdas de filas pares (offset 0) en columnas `col - 1` ([ (c-1)t, c*t ]) y `col` ([ c*t, (c+1)t ]).
 *   Se filtra contra el recorte físico [0, widthCm] x [0, heightCm] y contra celdas UNUSED_CELL si `grid` está presente.
 *
 * @param {number} row
 * @param {number} col
 * @param {ReturnType<typeof computeGridMetrics>} metrics
 * @param {Uint8Array | number[] | null} [grid=null]
 * @returns {Array<{ row: number, col: number, idx: number }>}
 */
export function getBrickAwareNeighbors(row, col, metrics, grid = null) {
  if (!metrics) return [];
  const originRect = getTileRectCm(row, col, metrics, { mirrorMode: false });
  if (!originRect) return [];

  const candidates = [];

  // Vecinos horizontales en la misma fila
  candidates.push([row, col - 1], [row, col + 1]);

  if (!metrics.isBrick50) {
    candidates.push([row - 1, col], [row + 1, col]);
  } else {
    const isOddRow = row % 2 === 1;
    const neighborCols = isOddRow ? [col - 1, col] : [col, col + 1];
    for (const nr of [row - 1, row + 1]) {
      for (const nc of neighborCols) {
        candidates.push([nr, nc]);
      }
    }
  }

  const neighbors = [];
  const seen = new Set();

  for (const [nr, nc] of candidates) {
    if (nr < 0 || nr >= metrics.tileRows) continue;
    const rowCols = getRowColsCount(nr, metrics);
    if (nc < 0 || nc >= rowCols) continue;

    const nIdx = nr * metrics.maxRowCols + nc;
    if (seen.has(nIdx)) continue;

    const nRect = getTileRectCm(nr, nc, metrics, { mirrorMode: false });
    if (!nRect) continue;

    // Verificar solapamiento real de arista (en X para filas vecinas, o en Y para misma fila)
    if (nr !== row) {
      const overlapX = Math.min(originRect.logicalX1Cm, nRect.logicalX1Cm) - Math.max(originRect.logicalX0Cm, nRect.logicalX0Cm);
      if (overlapX <= 1e-6) continue;
    }

    if (grid && (nIdx < 0 || nIdx >= grid.length || grid[nIdx] === UNUSED_CELL)) {
      continue;
    }

    seen.add(nIdx);
    neighbors.push({ row: nr, col: nc, idx: nIdx });
  }

  return neighbors;
}

/**
 * Flood Fill (relleno por cubeta) iterativo con BFS para evitar desbordamiento de pila.
 * Soporta tanto `grid` como `brick_50` usando adyacencia física exacta.
 * No muta la grilla original; retorna `{ grid: Uint8Array, changedCount: number }`.
 *
 * @param {Uint8Array | number[]} grid
 * @param {number} startRow
 * @param {number} startCol
 * @param {number} targetColorIdx
 * @param {ReturnType<typeof computeGridMetrics>} metrics
 * @param {string} [pattern]
 * @returns {{ grid: Uint8Array, changedCount: number }}
 */
export function floodFillGrid(grid, startRow, startCol, targetColorIdx, metrics, pattern) {
  if (!grid || !metrics) {
    throw new Error('grid y metrics son obligatorios para floodFillGrid.');
  }

  const effectiveMetrics =
    pattern && pattern !== metrics.pattern
      ? { ...metrics, pattern, isBrick50: isBrick50Pattern(pattern) }
      : metrics;

  const outGrid = new Uint8Array(grid);
  const startRect = getTileRectCm(startRow, startCol, effectiveMetrics, { mirrorMode: false });
  if (!startRect) return { grid: outGrid, changedCount: 0 };

  const startIdx = startRow * effectiveMetrics.maxRowCols + startCol;
  if (startIdx < 0 || startIdx >= outGrid.length) {
    return { grid: outGrid, changedCount: 0 };
  }

  const sourceColorIdx = outGrid[startIdx];
  if (sourceColorIdx === UNUSED_CELL || sourceColorIdx === targetColorIdx) {
    return { grid: outGrid, changedCount: 0 };
  }

  const visited = new Uint8Array(outGrid.length);
  const queueRows = [startRow];
  const queueCols = [startCol];
  visited[startIdx] = 1;

  let head = 0;
  let changedCount = 0;

  while (head < queueRows.length) {
    const r = queueRows[head];
    const c = queueCols[head];
    head++;

    const idx = r * effectiveMetrics.maxRowCols + c;
    if (outGrid[idx] !== sourceColorIdx) continue;

    outGrid[idx] = targetColorIdx;
    changedCount++;

    const neighbors = getBrickAwareNeighbors(r, c, effectiveMetrics, outGrid);
    for (let i = 0; i < neighbors.length; i++) {
      const nb = neighbors[i];
      if (!visited[nb.idx] && outGrid[nb.idx] === sourceColorIdx) {
        visited[nb.idx] = 1;
        queueRows.push(nb.row);
        queueCols.push(nb.col);
      }
    }
  }

  return { grid: outGrid, changedCount };
}

/**
 * Reemplaza todas las ocurrencias de `fromColorIdx` por `toColorIdx` en la grilla.
 * Ignora celdas `UNUSED_CELL` (255). No muta el arreglo de entrada.
 *
 * @param {Uint8Array | number[]} grid
 * @param {number} fromColorIdx
 * @param {number} toColorIdx
 * @returns {{ grid: Uint8Array, changedCount: number }}
 */
export function replaceGlobalColor(grid, fromColorIdx, toColorIdx) {
  const outGrid = new Uint8Array(grid);
  if (fromColorIdx === toColorIdx || fromColorIdx === UNUSED_CELL) {
    return { grid: outGrid, changedCount: 0 };
  }

  let changedCount = 0;
  for (let i = 0; i < outGrid.length; i++) {
    if (outGrid[i] === fromColorIdx) {
      outGrid[i] = toColorIdx;
      changedCount++;
    }
  }
  return { grid: outGrid, changedCount };
}

/**
 * Recuenta las teselas de cada entrada de paleta a partir de `grid`.
 * Retorna una nueva paleta (sin mutar la original) y el total de teselas activas.
 *
 * @param {Uint8Array | number[]} grid
 * @param {Array<{ r: number, g: number, b: number, hex: string, count?: number }>} palette
 * @returns {{ palette: Array<{ r: number, g: number, b: number, hex: string, count: number }>, totalTiles: number }}
 */
export function recountPalette(grid, palette = []) {
  const counts = new Uint32Array(palette.length);
  let totalTiles = 0;

  if (grid) {
    for (let i = 0; i < grid.length; i++) {
      const c = grid[i];
      if (c !== UNUSED_CELL && c < palette.length) {
        counts[c]++;
        totalTiles++;
      }
    }
  }

  const nextPalette = palette.map((entry, idx) => ({
    ...entry,
    count: counts[idx],
  }));

  return { palette: nextPalette, totalTiles };
}

/**
 * Comprime un `Uint8Array` (o array de bytes) usando Run-Length Encoding [valor, longitud, ...].
 * Soporta cualquier valor 0..255 (incluyendo 255 = UNUSED_CELL) y longitudes arbitrarias.
 *
 * @param {Uint8Array | number[]} grid
 * @returns {number[]}
 */
export function encodeGridRle(grid) {
  if (!grid || grid.length === 0) return [];
  const rle = [];
  let current = grid[0] & 0xff;
  let runLen = 1;

  for (let i = 1; i < grid.length; i++) {
    const val = grid[i] & 0xff;
    if (val === current) {
      runLen++;
    } else {
      rle.push(current, runLen);
      current = val;
      runLen = 1;
    }
  }
  rle.push(current, runLen);
  return rle;
}

/**
 * Decodifica una secuencia RLE `[valor, longitud, ...]` a `Uint8Array`.
 * Valida longitud esperada si `expectedLen` es provisto.
 *
 * @param {number[]} rle
 * @param {number} [expectedLen]
 * @returns {Uint8Array}
 */
export function decodeGridRle(rle, expectedLen) {
  if (!Array.isArray(rle) || rle.length % 2 !== 0) {
    throw new Error('RLE inválido: debe ser un arreglo de pares [valor, longitud].');
  }

  let totalLen = 0;
  for (let i = 1; i < rle.length; i += 2) {
    const len = rle[i];
    if (!Number.isInteger(len) || len < 0) {
      throw new Error(`Longitud RLE inválida en índice ${i}: ${len}`);
    }
    totalLen += len;
  }

  if (Number.isInteger(expectedLen) && totalLen !== expectedLen) {
    throw new Error(`Longitud decodificada RLE (${totalLen}) no coincide con expectedLen (${expectedLen}).`);
  }

  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < rle.length; i += 2) {
    const val = rle[i];
    const len = rle[i + 1];
    if (!Number.isInteger(val) || val < 0 || val > 255) {
      throw new Error(`Valor RLE inválido en índice ${i}: ${val}`);
    }
    out.fill(val, offset, offset + len);
    offset += len;
  }

  return out;
}

/**
 * Cuantización cromática K-Means++ determinista usando distancia perceptual Redmean.
 * Replica exactamente la inicialización dispersa determinista de la demo.
 *
 * @param {Array<{ r: number, g: number, b: number }>} samples
 * @param {number} K
 * @param {number} [maxIter=14]
 * @returns {{ centroids: Array<[number, number, number]>, assignments: Uint8Array }}
 */
export function runKMeansRedmean(samples, K, maxIter = 14) {
  const n = Array.isArray(samples) ? samples.length : 0;
  if (n === 0) {
    return { centroids: [[200, 200, 200]], assignments: new Uint8Array(0) };
  }

  const effectiveK = Math.max(1, Math.min(Math.floor(K) || 1, n, 254));
  const centroids = [];
  const first = samples[Math.floor(n / 2)];
  centroids.push([first.r, first.g, first.b]);

  const minDists = new Float64Array(n).fill(Infinity);
  for (let k = 1; k < effectiveK; k++) {
    let farthestIdx = 0;
    let maxDist = -1;
    const lastC = centroids[k - 1];
    for (let i = 0; i < n; i++) {
      const d = colorDistSq(samples[i].r, samples[i].g, samples[i].b, lastC[0], lastC[1], lastC[2]);
      if (d < minDists[i]) minDists[i] = d;
      if (minDists[i] > maxDist) {
        maxDist = minDists[i];
        farthestIdx = i;
      }
    }
    centroids.push([samples[farthestIdx].r, samples[farthestIdx].g, samples[farthestIdx].b]);
  }

  const assignments = new Uint8Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    const sumR = new Float64Array(effectiveK);
    const sumG = new Float64Array(effectiveK);
    const sumB = new Float64Array(effectiveK);
    const cnt = new Uint32Array(effectiveK);

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < effectiveK; k++) {
        const c = centroids[k];
        const d = colorDistSq(s.r, s.g, s.b, c[0], c[1], c[2]);
        if (d < bestDist) {
          bestDist = d;
          bestK = k;
        }
      }
      if (assignments[i] !== bestK) {
        assignments[i] = bestK;
        changed = true;
      }
      sumR[bestK] += s.r;
      sumG[bestK] += s.g;
      sumB[bestK] += s.b;
      cnt[bestK]++;
    }

    for (let k = 0; k < effectiveK; k++) {
      if (cnt[k] > 0) {
        centroids[k][0] = sumR[k] / cnt[k];
        centroids[k][1] = sumG[k] / cnt[k];
        centroids[k][2] = sumB[k] / cnt[k];
      }
    }

    if (!changed) break;
  }

  return { centroids, assignments };
}

/**
 * Retorna el SVG vectorial 960×720 que reproduce fielmente el paisaje mediterráneo
 * integrado de la demo para renderizado offline tanto en Canvas como en sharp.
 *
 * @returns {string}
 */
export function getBuiltInSampleSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720">
  <defs>
    <linearGradient id="gm-sky" x1="0" y1="0" x2="0" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#e5b37c" />
      <stop offset="55%" stop-color="#f2d3a2" />
      <stop offset="100%" stop-color="#f7e6c4" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="960" height="720" fill="url(#gm-sky)" />
  <circle cx="690" cy="210" r="125" fill="#c45b3e" />
  <circle cx="690" cy="210" r="82" fill="#e08452" />
  <path d="M 0 460 Q 220 220 460 390 Q 720 260 960 380 L 960 720 L 0 720 Z" fill="#5c8276" />
  <path d="M 0 520 Q 260 350 530 470 Q 760 560 960 430 L 960 720 L 0 720 Z" fill="#36594d" />
  <path d="M 310 720 Q 420 580 540 550 Q 640 525 690 495 Q 600 565 530 620 Q 455 675 450 720 Z" fill="#e8c484" />
  <path d="M 0 620 Q 240 550 420 720 L 0 720 Z" fill="#a8643f" />
  <rect x="162" y="340" width="28" height="220" fill="#253e35" />
  <circle cx="176" cy="300" r="95" fill="#4f7a65" />
  <circle cx="145" cy="275" r="55" fill="#7fa382" />
  <path d="M 750 610 A 65 65 0 0 1 880 610 L 880 720 L 750 720 Z" fill="#fff6e6" />
  <path d="M 779 625 A 36 36 0 0 1 851 625 L 851 720 L 779 720 Z" fill="#2c473e" />
</svg>`;
}
