import { srgbToLab, ciede2000 } from './colorLab.js';
import { hexToRgb } from './mosaicCore.js';

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function validateRgbaBuffer(rgba, width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Dimensiones inválidas para buffer RGBA: ${width}×${height}`);
  }
  const expected = width * height * 4;
  if (!rgba || rgba.length < expected) {
    throw new Error(`Buffer RGBA insuficiente: esperado al menos ${expected} bytes.`);
  }
  return expected;
}

function copyRgba(rgba, len) {
  if (rgba instanceof Uint8ClampedArray) {
    return new Uint8ClampedArray(rgba.subarray(0, len));
  }
  const out = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    out[i] = rgba[i];
  }
  return out;
}

/**
 * Filtro Bilateral preservador de bordes sobre un buffer RGBA puro (sin DOM).
 * Suaviza ruido fotográfico dentro de áreas homogéneas respetando contornos de alto contraste.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ radius?: number, spatialSigma?: number, rangeSigma?: number }} [options={}]
 * @returns {Uint8ClampedArray}
 */
export function applyBilateralFilter(
  rgba,
  width,
  height,
  { radius = 2, spatialSigma = 2.0, rangeSigma = 28.0 } = {}
) {
  const len = validateRgbaBuffer(rgba, width, height);
  const rad = Math.max(0, Math.min(6, Math.floor(radius)));
  if (rad === 0) return copyRgba(rgba, len);

  const sSigma = Math.max(0.1, Number(spatialSigma) || 2.0);
  const rSigma = Math.max(0.5, Number(rangeSigma) || 28.0);
  const inv2SpatialSq = 1 / (2 * sSigma * sSigma);
  const inv2RangeSq = 1 / (2 * rSigma * rSigma);

  // Precalcular pesos espaciales y tabla exponencial de rango para máxima velocidad
  const kernelSize = 2 * rad + 1;
  const spatialKernel = new Float64Array(kernelSize * kernelSize);
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      spatialKernel[(dy + rad) * kernelSize + (dx + rad)] = Math.exp(-(dx * dx + dy * dy) * inv2SpatialSq);
    }
  }

  // Máximo dSq = 3 * 255^2 = 195075; usamos LUT cuantizada por paso de 1
  const maxDistSq = 3 * 255 * 255;
  const rangeLut = new Float64Array(maxDistSq + 1);
  for (let d = 0; d <= maxDistSq; d++) {
    rangeLut[d] = Math.exp(-d * inv2RangeSq);
  }

  const out = new Uint8ClampedArray(len);

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - rad);
    const y1 = Math.min(height - 1, y + rad);

    for (let x = 0; x < width; x++) {
      const cIdx = (y * width + x) * 4;
      const cr = rgba[cIdx];
      const cg = rgba[cIdx + 1];
      const cb = rgba[cIdx + 2];
      const ca = rgba[cIdx + 3];

      if (ca === 0) {
        out[cIdx] = cr;
        out[cIdx + 1] = cg;
        out[cIdx + 2] = cb;
        out[cIdx + 3] = 0;
        continue;
      }

      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(width - 1, x + rad);

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumW = 0;

      for (let ny = y0; ny <= y1; ny++) {
        const kRow = (ny - y + rad) * kernelSize;
        const rowOffset = ny * width * 4;
        for (let nx = x0; nx <= x1; nx++) {
          const nIdx = rowOffset + nx * 4;
          const na = rgba[nIdx + 3];
          if (na === 0) continue;

          const nr = rgba[nIdx];
          const ng = rgba[nIdx + 1];
          const nb = rgba[nIdx + 2];

          const dr = nr - cr;
          const dg = ng - cg;
          const db = nb - cb;
          const distSq = dr * dr + dg * dg + db * db;

          const w = spatialKernel[kRow + (nx - x + rad)] * rangeLut[distSq];
          sumR += nr * w;
          sumG += ng * w;
          sumB += nb * w;
          sumW += w;
        }
      }

      if (sumW > 1e-9) {
        out[cIdx] = clampByte(sumR / sumW);
        out[cIdx + 1] = clampByte(sumG / sumW);
        out[cIdx + 2] = clampByte(sumB / sumW);
      } else {
        out[cIdx] = cr;
        out[cIdx + 1] = cg;
        out[cIdx + 2] = cb;
      }
      out[cIdx + 3] = ca;
    }
  }

  return out;
}

/**
 * Filtro Kuwahara (4 cuadrantes por varianza mínima) sobre buffer RGBA puro (sin DOM).
 * Crea regiones pictóricas simplificadas con bordes nítidos ideales para mosaicos artísticos.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} [radius=2]
 * @returns {Uint8ClampedArray}
 */
export function applyKuwaharaFilter(rgba, width, height, radius = 2) {
  const len = validateRgbaBuffer(rgba, width, height);
  const rad = Math.max(0, Math.min(6, Math.floor(radius)));
  if (rad === 0) return copyRgba(rgba, len);

  const out = new Uint8ClampedArray(len);

  const quadrants = [
    [-rad, 0, -rad, 0], // sup-izq
    [0, rad, -rad, 0],  // sup-der
    [-rad, 0, 0, rad],  // inf-izq
    [0, rad, 0, rad],   // inf-der
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cIdx = (y * width + x) * 4;
      const ca = rgba[cIdx + 3];
      if (ca === 0) {
        out[cIdx] = rgba[cIdx];
        out[cIdx + 1] = rgba[cIdx + 1];
        out[cIdx + 2] = rgba[cIdx + 2];
        out[cIdx + 3] = 0;
        continue;
      }

      let bestVar = Infinity;
      let bestR = rgba[cIdx];
      let bestG = rgba[cIdx + 1];
      let bestB = rgba[cIdx + 2];

      for (let q = 0; q < 4; q++) {
        const [dx0, dx1, dy0, dy1] = quadrants[q];
        const xStart = Math.max(0, x + dx0);
        const xEnd = Math.min(width - 1, x + dx1);
        const yStart = Math.max(0, y + dy0);
        const yEnd = Math.min(height - 1, y + dy1);

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumL = 0;
        let sumL2 = 0;
        let cnt = 0;

        for (let ny = yStart; ny <= yEnd; ny++) {
          const rowOffset = ny * width * 4;
          for (let nx = xStart; nx <= xEnd; nx++) {
            const idx = rowOffset + nx * 4;
            const r = rgba[idx];
            const g = rgba[idx + 1];
            const b = rgba[idx + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            sumR += r;
            sumG += g;
            sumB += b;
            sumL += lum;
            sumL2 += lum * lum;
            cnt++;
          }
        }

        if (cnt > 0) {
          const meanL = sumL / cnt;
          const variance = Math.max(0, sumL2 / cnt - meanL * meanL);
          if (variance < bestVar) {
            bestVar = variance;
            bestR = sumR / cnt;
            bestG = sumG / cnt;
            bestB = sumB / cnt;
          }
        }
      }

      out[cIdx] = clampByte(bestR);
      out[cIdx + 1] = clampByte(bestG);
      out[cIdx + 2] = clampByte(bestB);
      out[cIdx + 3] = ca;
    }
  }

  return out;
}

function estimateBorderDominantRgb(rgba, width, height) {
  const bins = new Map();
  let bestKey = -1;
  let bestInfo = null;

  const pushBorderPixel = (x, y) => {
    const idx = (y * width + x) * 4;
    if (rgba[idx + 3] < 16) return;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    // Cuantización gruesa 16 niveles por canal para detectar moda de fondo de bordes
    const qr = r >> 4;
    const qg = g >> 4;
    const qb = b >> 4;
    const key = (qr << 8) | (qg << 4) | qb;
    let info = bins.get(key);
    if (!info) {
      info = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
      bins.set(key, info);
    }
    info.count++;
    info.sumR += r;
    info.sumG += g;
    info.sumB += b;
    if (!bestInfo || info.count > bestInfo.count) {
      bestInfo = info;
      bestKey = key;
    }
  };

  for (let x = 0; x < width; x++) {
    pushBorderPixel(x, 0);
    if (height > 1) pushBorderPixel(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    pushBorderPixel(0, y);
    if (width > 1) pushBorderPixel(width - 1, y);
  }

  if (!bestInfo || bestKey < 0) {
    return { r: 255, g: 255, b: 255 };
  }

  return {
    r: Math.round(bestInfo.sumR / bestInfo.count),
    g: Math.round(bestInfo.sumG / bestInfo.count),
    b: Math.round(bestInfo.sumB / bestInfo.count),
  };
}

function resolveBgRgb(bgColor, rgba, width, height) {
  if (!bgColor) return estimateBorderDominantRgb(rgba, width, height);
  if (typeof bgColor === 'string') return hexToRgb(bgColor);
  if (Array.isArray(bgColor)) {
    return { r: bgColor[0] ?? 255, g: bgColor[1] ?? 255, b: bgColor[2] ?? 255 };
  }
  if (Number.isFinite(bgColor.r) && Number.isFinite(bgColor.g) && Number.isFinite(bgColor.b)) {
    return { r: bgColor.r, g: bgColor.g, b: bgColor.b };
  }
  return estimateBorderDominantRgb(rgba, width, height);
}

/**
 * Limpieza local de fondo sin red neuronal externa:
 * Estima el color dominante de los bordes (o usa `bgColor`), lanza BFS desde todo el perímetro
 * usando distancia perceptual CIELAB `ciede2000 <= toleranceDeltaE` y limpia únicamente
 * regiones conectadas con el borde (preservando el sujeto central aunque tenga tonos parecidos).
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ toleranceDeltaE?: number, bgColor?: string | { r: number, g: number, b: number } | [number, number, number] | null, fillRgb?: [number, number, number] | null, clearAlpha?: boolean }} [options={}]
 * @returns {Uint8ClampedArray}
 */
export function removeBackgroundLocal(
  rgba,
  width,
  height,
  { toleranceDeltaE = 18, bgColor = null, fillRgb = [255, 255, 255], clearAlpha = false } = {}
) {
  const len = validateRgbaBuffer(rgba, width, height);
  const out = copyRgba(rgba, len);
  const totalPixels = width * height;
  const tol = Math.max(0.5, Number(toleranceDeltaE) || 18);

  const refRgb = resolveBgRgb(bgColor, rgba, width, height);
  const refLab = srgbToLab(refRgb.r, refRgb.g, refRgb.b);

  const visited = new Uint8Array(totalPixels);
  const isBg = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let head = 0;
  let tail = 0;

  // Caché rápida de color RGB empaquetado -> es fondo (boolean) para evitar recalcular ciede2000 repetidamente
  const colorMatchCache = new Map();
  const isBackgroundPixel = (pixelIdx) => {
    const p4 = pixelIdx * 4;
    const a = rgba[p4 + 3];
    if (a < 16) return true;
    const r = rgba[p4];
    const g = rgba[p4 + 1];
    const b = rgba[p4 + 2];
    const key = (r << 16) | (g << 8) | b;
    const cached = colorMatchCache.get(key);
    if (cached !== undefined) return cached;

    const lab = srgbToLab(r, g, b);
    const de = ciede2000(lab, refLab);
    const match = de <= tol;
    colorMatchCache.set(key, match);
    return match;
  };

  const enqueueBorder = (x, y) => {
    const idx = y * width + x;
    if (visited[idx]) return;
    visited[idx] = 1;
    if (isBackgroundPixel(idx)) {
      isBg[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    enqueueBorder(x, 0);
    if (height > 1) enqueueBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueueBorder(0, y);
    if (width > 1) enqueueBorder(width - 1, y);
  }

  while (head < tail) {
    const cur = queue[head++];
    const x = cur % width;
    const y = (cur - x) / width;

    if (x > 0) {
      const n = cur - 1;
      if (!visited[n]) {
        visited[n] = 1;
        if (isBackgroundPixel(n)) {
          isBg[n] = 1;
          queue[tail++] = n;
        }
      }
    }
    if (x + 1 < width) {
      const n = cur + 1;
      if (!visited[n]) {
        visited[n] = 1;
        if (isBackgroundPixel(n)) {
          isBg[n] = 1;
          queue[tail++] = n;
        }
      }
    }
    if (y > 0) {
      const n = cur - width;
      if (!visited[n]) {
        visited[n] = 1;
        if (isBackgroundPixel(n)) {
          isBg[n] = 1;
          queue[tail++] = n;
        }
      }
    }
    if (y + 1 < height) {
      const n = cur + width;
      if (!visited[n]) {
        visited[n] = 1;
        if (isBackgroundPixel(n)) {
          isBg[n] = 1;
          queue[tail++] = n;
        }
      }
    }
  }

  const fillR = fillRgb ? clampByte(fillRgb[0]) : 255;
  const fillG = fillRgb ? clampByte(fillRgb[1]) : 255;
  const fillB = fillRgb ? clampByte(fillRgb[2]) : 255;

  for (let i = 0; i < totalPixels; i++) {
    if (isBg[i]) {
      const p4 = i * 4;
      out[p4] = fillR;
      out[p4 + 1] = fillG;
      out[p4 + 2] = fillB;
      if (clearAlpha) {
        out[p4 + 3] = 0;
      } else {
        out[p4 + 3] = 255;
      }
    }
  }

  return out;
}

/**
 * Pipeline unificado de preprocesado artístico sobre buffers RGBA (sin DOM).
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{
 *   preprocessMode?: 'none' | 'bilateral' | 'kuwahara',
 *   removeBackground?: boolean,
 *   toleranceDeltaE?: number,
 *   bgColor?: string | { r: number, g: number, b: number } | [number, number, number] | null,
 *   radius?: number,
 *   spatialSigma?: number,
 *   rangeSigma?: number,
 *   clearAlpha?: boolean
 * }} [options={}]
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function preprocessRgba(
  rgba,
  width,
  height,
  {
    preprocessMode = 'none',
    removeBackground = false,
    toleranceDeltaE = 18,
    bgColor = null,
    radius = 2,
    spatialSigma = 2.0,
    rangeSigma = 28.0,
    clearAlpha = false,
  } = {}
) {
  const len = validateRgbaBuffer(rgba, width, height);
  let data = copyRgba(rgba, len);

  if (removeBackground) {
    data = removeBackgroundLocal(data, width, height, {
      toleranceDeltaE,
      bgColor,
      clearAlpha,
    });
  }

  if (preprocessMode === 'bilateral') {
    data = applyBilateralFilter(data, width, height, { radius, spatialSigma, rangeSigma });
  } else if (preprocessMode === 'kuwahara') {
    data = applyKuwaharaFilter(data, width, height, radius);
  } else if (preprocessMode && preprocessMode !== 'none') {
    throw new Error(`preprocessMode no soportado: ${preprocessMode}`);
  }

  return {
    data,
    width,
    height,
  };
}

/**
 * Procesa un buffer RGBA para referencias de póster/mural directo (puro en typed arrays, sin DOM).
 * Soporta los modos `'color'`, `'grayscale'`, `'contrast_bw'` y `'line_art'` (Sobel 3x3),
 * con ajuste de contraste, brillo, umbral e inversión preservando el canal alfa intacto.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{
 *   filterMode?: 'color' | 'grayscale' | 'contrast_bw' | 'line_art',
 *   contrast?: number,
 *   brightness?: number,
 *   threshold?: number,
 *   invert?: boolean
 * }} [options={}]
 * @returns {Uint8ClampedArray}
 */
export function applyPosterReferenceRgba(rgba, width, height, options = {}) {
  const len = validateRgbaBuffer(rgba, width, height);

  const filterMode = options?.filterMode ?? 'color';
  const contrast = Number.isFinite(Number(options?.contrast)) ? Number(options.contrast) : 1.2;
  const brightness = Number.isFinite(Number(options?.brightness)) ? Number(options.brightness) : 0;
  const threshold = Number.isFinite(Number(options?.threshold)) ? Number(options.threshold) : 128;
  const invert = Boolean(options?.invert);

  if (
    filterMode !== 'color' &&
    filterMode !== 'grayscale' &&
    filterMode !== 'contrast_bw' &&
    filterMode !== 'line_art'
  ) {
    throw new Error(`filterMode no soportado en applyPosterReferenceRgba: ${filterMode}`);
  }

  if (filterMode === 'color' && contrast === 1 && brightness === 0 && !invert) {
    return copyRgba(rgba, len);
  }

  const out = new Uint8ClampedArray(len);
  const pixelCount = width * height;

  if (filterMode === 'color') {
    // LUT de 256 entradas para transformación lineal afín muy rápida sobre 36MP+
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let c = Math.round((v + brightness - 128) * contrast + 128);
      if (c < 0) c = 0;
      else if (c > 255) c = 255;
      lut[v] = invert ? 255 - c : c;
    }

    for (let i = 0; i < len; i += 4) {
      out[i] = lut[rgba[i]];
      out[i + 1] = lut[rgba[i + 1]];
      out[i + 2] = lut[rgba[i + 2]];
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }

  if (filterMode === 'grayscale' || filterMode === 'contrast_bw') {
    const isBw = filterMode === 'contrast_bw';
    for (let i = 0; i < len; i += 4) {
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      let adj = Math.round((lum + brightness - 128) * contrast + 128);
      if (adj < 0) adj = 0;
      else if (adj > 255) adj = 255;

      let v = isBw ? (adj >= threshold ? 255 : 0) : adj;
      if (invert) v = 255 - v;

      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }

  // filterMode === 'line_art': luminancia ajustada + operador Sobel 3x3
  const lumBuf = new Float32Array(pixelCount);
  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    let adj = (lum + brightness - 128) * contrast + 128;
    if (adj < 0) adj = 0;
    else if (adj > 255) adj = 255;
    lumBuf[p] = adj;
  }

  const cutoff = Math.max(12, (255 - threshold) * 1.15);
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;

  for (let y = 0; y < height; y++) {
    const ym1 = y > 0 ? y - 1 : 0;
    const yp1 = y < hMinus1 ? y + 1 : hMinus1;
    const rowTop = ym1 * width;
    const rowMid = y * width;
    const rowBot = yp1 * width;

    for (let x = 0; x < width; x++) {
      const xm1 = x > 0 ? x - 1 : 0;
      const xp1 = x < wMinus1 ? x + 1 : wMinus1;

      const p00 = lumBuf[rowTop + xm1];
      const p01 = lumBuf[rowTop + x];
      const p02 = lumBuf[rowTop + xp1];
      const p10 = lumBuf[rowMid + xm1];
      const p12 = lumBuf[rowMid + xp1];
      const p20 = lumBuf[rowBot + xm1];
      const p21 = lumBuf[rowBot + x];
      const p22 = lumBuf[rowBot + xp1];

      const gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
      const gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
      const mag = Math.hypot(gx, gy) * contrast;

      let v = mag >= cutoff ? 0 : 255;
      if (invert) v = 255 - v;

      const outIdx = (rowMid + x) * 4;
      out[outIdx] = v;
      out[outIdx + 1] = v;
      out[outIdx + 2] = v;
      out[outIdx + 3] = rgba[outIdx + 3];
    }
  }

  return out;
}

