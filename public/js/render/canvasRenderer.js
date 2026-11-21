import { POSTER_FILTER_MODES } from '/shared/contracts.js';
import { applyPosterReferenceRgba } from '/shared/preprocess.js';
import {
  UNUSED_CELL,
  getLuminance,
  computeGridMetrics,
  getTileRectCm,
  getBuiltInSampleSvg,
} from '/shared/mosaicCore.js';
import {
  generatePatternCells,
  insetPolygon,
  mirrorPolygonCm,
} from '/shared/patterns.js';
import { computeMosaicJob, isPolygonalPattern } from '/public/js/workers/mosaicWorker.js';

const TWO_PI = Math.PI * 2;
const polygonalCacheMap = new WeakMap();
const posterCacheMap = new WeakMap();

function resolveEffectivePosterFilter(config = {}) {
  const requested = POSTER_FILTER_MODES.includes(config.posterFilterMode)
    ? config.posterFilterMode
    : 'color';
  if (requested !== 'color') return requested;
  if (config.viewMode === 'contour') return 'line_art';
  if (config.viewMode === 'grayscale') return 'grayscale';
  return 'color';
}

/**
 * Escala y procesa la imagen fuente para Modo Póster / Referencia (Color, Grises,
 * Alto Contraste B/N o Solo Contorno Sobel) con caché WeakMap para 60 fps sin ctx.filter.
 *
 * @param {HTMLImageElement | HTMLCanvasElement | null} sourceImage
 * @param {Partial<import('/shared/contracts.js').MosaicConfig>} [config={}]
 */
export function getOrBuildPosterCanvas(sourceImage, config = {}) {
  if (!sourceImage) return null;
  if (typeof document === 'undefined') {
    return sourceImage;
  }

  const srcW = sourceImage.naturalWidth || sourceImage.width || 960;
  const srcH = sourceImage.naturalHeight || sourceImage.height || 720;
  if (srcW <= 0 || srcH <= 0) return sourceImage;

  const maxEdge = 1200;
  const maxCur = Math.max(srcW, srcH);
  const scale = maxCur > maxEdge ? maxEdge / maxCur : 1;
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const effectiveFilter = resolveEffectivePosterFilter(config);
  const contrast = Number.isFinite(Number(config.posterContrast)) ? Number(config.posterContrast) : 1.2;
  const brightness = Number.isFinite(Number(config.posterBrightness)) ? Number(config.posterBrightness) : 0;
  const threshold = Number.isFinite(Number(config.posterThreshold)) ? Number(config.posterThreshold) : 128;
  const invert = Boolean(config.posterInvert);

  const needsFilter =
    effectiveFilter !== 'color' ||
    Math.abs(contrast - 1) > 1e-4 ||
    Math.abs(brightness) > 1e-4 ||
    invert;

  let entry = posterCacheMap.get(sourceImage);
  if (!entry || entry.width !== outW || entry.height !== outH) {
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = outW;
    baseCanvas.height = outH;
    const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
    baseCtx.fillStyle = '#ffffff';
    baseCtx.fillRect(0, 0, outW, outH);
    baseCtx.drawImage(sourceImage, 0, 0, outW, outH);
    const baseImgData = baseCtx.getImageData(0, 0, outW, outH);

    entry = {
      width: outW,
      height: outH,
      baseCanvas,
      baseRgba: baseImgData.data,
      filteredCanvas: null,
      filteredSig: '',
    };
    posterCacheMap.set(sourceImage, entry);
  }

  if (!needsFilter) {
    return entry.baseCanvas;
  }

  const sig = [
    effectiveFilter,
    contrast.toFixed(3),
    brightness.toFixed(1),
    threshold.toFixed(1),
    invert ? 1 : 0,
  ].join('|');

  if (entry.filteredCanvas && entry.filteredSig === sig) {
    return entry.filteredCanvas;
  }

  const filteredBytes = applyPosterReferenceRgba(entry.baseRgba, outW, outH, {
    filterMode: effectiveFilter,
    contrast,
    brightness,
    threshold,
    invert,
  });

  if (!entry.filteredCanvas) {
    entry.filteredCanvas = document.createElement('canvas');
    entry.filteredCanvas.width = outW;
    entry.filteredCanvas.height = outH;
  }
  const fCtx = entry.filteredCanvas.getContext('2d');
  const outImgData =
    typeof ImageData !== 'undefined'
      ? new ImageData(filteredBytes, outW, outH)
      : fCtx.createImageData(outW, outH);
  if (outImgData.data !== filteredBytes) {
    outImgData.data.set(filteredBytes);
  }
  fCtx.putImageData(outImgData, 0, 0);
  entry.filteredSig = sig;
  return entry.filteredCanvas;
}

/**
 * Carga la ilustración SVG mediterránea integrada desde `getBuiltInSampleSvg()`
 * y la rasteriza en un canvas offscreen de 960×720 px listo para muestreo y renderizado.
 *
 * @returns {Promise<{ image: HTMLCanvasElement, width: number, height: number }>}
 */
export function loadSampleSvgImage() {
  return new Promise((resolve, reject) => {
    const svg = getBuiltInSampleSvg();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 960;
        c.height = 720;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 960, 720);
        URL.revokeObjectURL(url);
        resolve({ image: c, width: 960, height: 720 });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo cargar el SVG de muestra integrado.'));
    };

    img.src = url;
  });
}

/**
 * Extrae el buffer RGBA de muestreo desde una imagen HTMLImageElement/HTMLCanvasElement
 * adaptado a la densidad del mosaico y filtros activos.
 *
 * @param {HTMLImageElement | HTMLCanvasElement | null} sourceImage
 * @param {Partial<import('/shared/contracts.js').MosaicConfig>} config
 * @returns {{ rgbaBuffer: Uint8ClampedArray | null, sampleW: number, sampleH: number }}
 */
export function extractSourceRgba(sourceImage, config = {}) {
  if (!sourceImage) {
    return { rgbaBuffer: null, sampleW: 0, sampleH: 0 };
  }
  const widthCm = Number(config.widthCm) || 120;
  const heightCm = Number(config.heightCm) || 90;
  const tileSizeCm = Number(config.tileSizeCm) || 2;
  const cols = Math.max(1, Math.ceil(widthCm / tileSizeCm));
  const rows = Math.max(1, Math.ceil(heightCm / tileSizeCm));

  const hasExpensiveFilter =
    Boolean(config.removeBackground) ||
    (config.preprocessMode && config.preprocessMode !== 'none');
  const maxDim = hasExpensiveFilter ? 720 : 1200;
  const sampleScale = Math.min(4, Math.max(1, Math.floor(800 / Math.max(cols, rows))));
  const sW = Math.min(maxDim, Math.max(cols * sampleScale, 32));
  const sH = Math.min(maxDim, Math.max(rows * sampleScale, 32));

  const off = document.createElement('canvas');
  off.width = sW;
  off.height = sH;
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, sW, sH);
  octx.drawImage(sourceImage, 0, 0, sW, sH);

  const imgData = octx.getImageData(0, 0, sW, sH);
  return {
    rgbaBuffer: imgData.data,
    sampleW: sW,
    sampleH: sH,
  };
}

/**
 * Muestrea la imagen fuente celda por celda y ejecuta el pipeline unificado Fase 2
 * (fallback síncrono equivalente al Web Worker).
 *
 * @param {HTMLImageElement | HTMLCanvasElement | null} sourceImage
 * @param {import('/shared/contracts.js').MosaicConfig} config
 */
export function sampleSourceImageToGrid(sourceImage, config) {
  const { rgbaBuffer, sampleW, sampleH } = extractSourceRgba(sourceImage, config);
  const res = computeMosaicJob({ rgbaBuffer, sampleW, sampleH, config });
  return {
    palette: res.palette,
    grid: res.gridBuffer,
    tileCols: res.tileCols,
    tileRows: res.tileRows,
    maxRowCols: res.maxRowCols,
    totalTiles: res.totalTiles,
    gridMetrics: res.gridMetrics,
    cells: res.cells,
    isPolygonal: res.isPolygonal,
  };
}

/**
 * Precomputa y cachea en WeakMap la geometría empaquetada de celdas poligonales
 * (espejo horizontal, inset de junta y bounding boxes) en Float32Array para
 * renderizar 10 000+ teselas a >= 30 fps sin asignaciones por frame.
 */
function getOrBuildPolygonalRenderCache(
  cells,
  widthCm,
  mirrorMode,
  halfGroutCm,
  fastPreview = false
) {
  const effectiveHalfGroutCm = fastPreview ? 0 : halfGroutCm;
  const cacheKey = `${widthCm}|${mirrorMode ? 1 : 0}|${Math.round(effectiveHalfGroutCm * 10000)}|${fastPreview ? 1 : 0}`;
  let cached = polygonalCacheMap.get(cells);
  if (cached && cached.key === cacheKey) {
    return cached;
  }

  const n = cells.length;
  const bboxes = new Float32Array(n * 4);
  const centers = new Float32Array(n * 2);
  const radii = new Float32Array(n);
  const isCircle = new Uint8Array(n);
  const polyStarts = new Uint32Array(n + 1);
  const tempPolys = new Array(n);
  let totalFloats = 0;

  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const cx = mirrorMode ? widthCm - cell.centroidCm[0] : cell.centroidCm[0];
    const cy = cell.centroidCm[1];
    centers[i * 2] = cx;
    centers[i * 2 + 1] = cy;

    const fullCircle =
      cell.shapeHint === 'circle' && Number.isFinite(cell.radiusCm) && !cell.isCut;

    if (fullCircle) {
      const r = Math.max(0.04, cell.radiusCm - effectiveHalfGroutCm);
      isCircle[i] = 1;
      radii[i] = r;
      const b4 = i * 4;
      bboxes[b4] = cx - r;
      bboxes[b4 + 1] = cy - r;
      bboxes[b4 + 2] = cx + r;
      bboxes[b4 + 3] = cy + r;
      polyStarts[i] = totalFloats;
      tempPolys[i] = null;
    } else {
      const rawPoly = mirrorMode ? mirrorPolygonCm(cell.polygonCm, widthCm) : cell.polygonCm;
      const drawPoly = effectiveHalfGroutCm > 1e-5 ? insetPolygon(rawPoly, effectiveHalfGroutCm) : rawPoly;
      tempPolys[i] = drawPoly;
      polyStarts[i] = totalFloats;
      totalFloats += drawPoly.length * 2;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let v = 0; v < drawPoly.length; v++) {
        const vx = drawPoly[v][0];
        const vy = drawPoly[v][1];
        if (vx < minX) minX = vx;
        if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy;
        if (vy > maxY) maxY = vy;
      }
      const b4 = i * 4;
      bboxes[b4] = minX;
      bboxes[b4 + 1] = minY;
      bboxes[b4 + 2] = maxX;
      bboxes[b4 + 3] = maxY;
    }
  }
  polyStarts[n] = totalFloats;

  const polyCoords = new Float32Array(totalFloats);
  // Precalcular también índices del vértice superior-izquierdo (min x+y) para reflejos vítreos y biseles
  const topVertOffsets = new Uint16Array(n);

  for (let i = 0; i < n; i++) {
    const poly = tempPolys[i];
    if (!poly) continue;
    let offset = polyStarts[i];
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let v = 0; v < poly.length; v++) {
      const vx = poly[v][0];
      const vy = poly[v][1];
      polyCoords[offset++] = vx;
      polyCoords[offset++] = vy;
      const score = vx + vy;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = v;
      }
    }
    topVertOffsets[i] = bestIdx;
  }

  cached = {
    key: cacheKey,
    count: n,
    bboxes,
    centers,
    radii,
    isCircle,
    polyStarts,
    polyCoords,
    topVertOffsets,
  };
  polygonalCacheMap.set(cells, cached);
  return cached;
}

function appendCachedShapePath(ctx, cache, idx, originShiftX, originShiftY, pxPerCm) {
  if (cache.isCircle[idx]) {
    const cx = originShiftX + cache.centers[idx * 2] * pxPerCm;
    const cy = originShiftY + cache.centers[idx * 2 + 1] * pxPerCm;
    const r = cache.radii[idx] * pxPerCm;
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, TWO_PI);
    return;
  }

  const start = cache.polyStarts[idx];
  const end = cache.polyStarts[idx + 1];
  if (end - start < 6) return;

  ctx.moveTo(
    originShiftX + cache.polyCoords[start] * pxPerCm,
    originShiftY + cache.polyCoords[start + 1] * pxPerCm
  );
  for (let p = start + 2; p < end; p += 2) {
    ctx.lineTo(
      originShiftX + cache.polyCoords[p] * pxPerCm,
      originShiftY + cache.polyCoords[p + 1] * pxPerCm
    );
  }
  ctx.closePath();
}

function renderPolygonalRegion(targetCtx, {
  destX,
  destY,
  srcXCm,
  srcYCm,
  srcWCm,
  srcHCm,
  pxPerCm,
  state,
  cells,
  forPdf,
}) {
  const { config, grid, palette } = state;
  const widthCm = config.widthCm;
  const heightCm = config.heightCm;
  const tileSize = config.tileSizeCm || 2;
  const groutCm = (config.groutMm || 0) / 10;
  const halfGroutCm = groutCm * 0.5;
  const tilePx = tileSize * pxPerCm;

  const visY0 = Math.max(0, srcYCm);
  const visY1 = Math.min(heightCm, srcYCm + srcHCm);
  const visX0 = Math.max(0, srcXCm);
  const visX1 = Math.min(widthCm, srcXCm + srcWCm);

  if (visX1 <= visX0 || visY1 <= visY0) {
    return 0;
  }

  const fastPreview = Boolean(state.isInteractiveDragging) && cells.length > 2500;
  const cache = getOrBuildPolygonalRenderCache(
    cells,
    widthCm,
    Boolean(config.mirrorMode),
    halfGroutCm,
    fastPreview
  );

  const palLen = palette.length;
  const viewMode = config.viewMode || 'color';
  const isContour = viewMode === 'contour';
  const isGrayscale = viewMode === 'grayscale';
  const isBreakdown = viewMode === 'breakdown';
  const breakdownIdx = Number.isInteger(config.breakdownColorIdx) ? config.breakdownColorIdx : 0;
  const finish = config.finish || 'ceramic';
  const drawNumbers = Boolean(config.showNumbers) && tilePx >= (forPdf ? 14 : 18);

  const fillStyles = new Array(palLen);
  const isLightColor = new Uint8Array(palLen);
  const buckets = new Array(palLen);

  for (let k = 0; k < palLen; k++) {
    const colObj = palette[k];
    const lum = getLuminance(colObj.r, colObj.g, colObj.b);
    isLightColor[k] = lum > 142 ? 1 : 0;
    if (isGrayscale) {
      const gVal = Math.round(lum);
      fillStyles[k] = `rgb(${gVal},${gVal},${gVal})`;
    } else if (isBreakdown && k !== breakdownIdx) {
      const muted = Math.round(lum * 0.25 + 225 * 0.75);
      fillStyles[k] = `rgba(${muted},${muted},${muted},0.42)`;
    } else {
      fillStyles[k] = colObj.hex;
    }
    buckets[k] = [];
  }

  const contourIndices = isContour ? [] : null;
  const dimmedIndices = isBreakdown ? [] : null;
  const activeIndices = isBreakdown ? [] : null;
  const finishIndices = !isContour && finish !== 'matte' && tilePx >= 8 ? [] : null;

  const darkLabels = drawNumbers ? [] : null;
  const lightLabels = drawNumbers ? [] : null;

  const bboxes = cache.bboxes;
  const centers = cache.centers;
  const originShiftX = destX - srcXCm * pxPerCm;
  const originShiftY = destY - srcYCm * pxPerCm;
  const n = cache.count;
  let renderedTiles = 0;

  for (let i = 0; i < n; i++) {
    const b4 = i * 4;
    const bMinX = bboxes[b4];
    const bMinY = bboxes[b4 + 1];
    const bMaxX = bboxes[b4 + 2];
    const bMaxY = bboxes[b4 + 3];

    if (bMaxX <= visX0 || bMinX >= visX1 || bMaxY <= visY0 || bMinY >= visY1) {
      continue;
    }

    const colorIdx =
      grid && i < grid.length
        ? grid[i]
        : Number.isInteger(cells[i].paletteId)
        ? cells[i].paletteId
        : UNUSED_CELL;

    if (colorIdx === undefined || colorIdx === UNUSED_CELL || colorIdx < 0 || colorIdx >= palLen || !buckets[colorIdx]) continue;
    renderedTiles++;

    if (isContour) {
      contourIndices.push(i);
    } else {
      buckets[colorIdx].push(i);
      if (isBreakdown) {
        if (colorIdx === breakdownIdx) {
          activeIndices.push(i);
          if (finishIndices) finishIndices.push(i);
        } else {
          dimmedIndices.push(i);
        }
      } else if (finishIndices) {
        finishIndices.push(i);
      }
    }

    if (drawNumbers && (!isBreakdown || colorIdx === breakdownIdx)) {
      const visWPx = (bMaxX - bMinX) * pxPerCm;
      const visHPx = (bMaxY - bMinY) * pxPerCm;
      if (visWPx >= 14 && visHPx >= 14) {
        const cxPx = originShiftX + centers[i * 2] * pxPerCm;
        const cyPx = originShiftY + centers[i * 2 + 1] * pxPerCm + 0.5;
        const label = String(colorIdx + 1);
        if (isContour || isLightColor[colorIdx]) {
          darkLabels.push(label, cxPx, cyPx);
        } else {
          lightLabels.push(label, cxPx, cyPx);
        }
      }
    }
  }

  if (isContour) {
    targetCtx.strokeStyle = '#24332d';
    targetCtx.lineWidth = Math.max(1, pxPerCm * 0.04);
    targetCtx.beginPath();
    for (let j = 0; j < contourIndices.length; j++) {
      appendCachedShapePath(targetCtx, cache, contourIndices[j], originShiftX, originShiftY, pxPerCm);
    }
    targetCtx.stroke();
  } else {
    // Relleno por lotes de color (máximo palLen llamadas a fill())
    for (let k = 0; k < palLen; k++) {
      const b = buckets[k];
      if (b.length === 0) continue;
      targetCtx.fillStyle = fillStyles[k];
      targetCtx.beginPath();
      for (let j = 0; j < b.length; j++) {
        appendCachedShapePath(targetCtx, cache, b[j], originShiftX, originShiftY, pxPerCm);
      }
      targetCtx.fill();
    }

    // Vista previa ligera de junta al arrastrar slider en murales grandes (> 2500 celdas)
    if (fastPreview && groutCm > 1e-5) {
      targetCtx.strokeStyle = isBreakdown ? '#f6f4ef' : config.groutColor || '#D6D3CB';
      targetCtx.lineWidth = Math.max(0.5, groutCm * pxPerCm);
      targetCtx.lineJoin = 'round';
      targetCtx.beginPath();
      for (let k = 0; k < palLen; k++) {
        const b = buckets[k];
        for (let j = 0; j < b.length; j++) {
          appendCachedShapePath(targetCtx, cache, b[j], originShiftX, originShiftY, pxPerCm);
        }
      }
      targetCtx.stroke();
    }

    // En Breakdown: contorno suave a las atenuadas y contorno nítido al color aislado
    if (isBreakdown) {
      if (dimmedIndices.length > 0) {
        targetCtx.strokeStyle = 'rgba(150, 158, 152, 0.38)';
        targetCtx.lineWidth = Math.max(0.6, pxPerCm * 0.025);
        targetCtx.beginPath();
        for (let j = 0; j < dimmedIndices.length; j++) {
          appendCachedShapePath(targetCtx, cache, dimmedIndices[j], originShiftX, originShiftY, pxPerCm);
        }
        targetCtx.stroke();
      }
      if (activeIndices.length > 0) {
        targetCtx.strokeStyle = '#24332d';
        targetCtx.lineWidth = Math.max(1.2, pxPerCm * 0.05);
        targetCtx.beginPath();
        for (let j = 0; j < activeIndices.length; j++) {
          appendCachedShapePath(targetCtx, cache, activeIndices[j], originShiftX, originShiftY, pxPerCm);
        }
        targetCtx.stroke();
      }
    }

    // Acabados superficiales por lotes (2 llamadas vectoriales globales en vez de por celda)
    if (finishIndices && finishIndices.length > 0 && typeof targetCtx.moveTo === 'function') {
      const { isCircle, radii, polyStarts, polyCoords, topVertOffsets } = cache;

      if (finish === 'ceramic') {
        targetCtx.lineWidth = Math.max(0.8, Math.min(1.6, tilePx * 0.08));
        // Bisel iluminado superior-izquierdo
        targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        targetCtx.beginPath();
        for (let j = 0; j < finishIndices.length; j++) {
          const idx = finishIndices[j];
          if (isCircle[idx]) {
            const cx = originShiftX + centers[idx * 2] * pxPerCm;
            const cy = originShiftY + centers[idx * 2 + 1] * pxPerCm;
            const r = Math.max(1, radii[idx] * pxPerCm - 1);
            targetCtx.moveTo(cx + r * Math.cos(Math.PI * 0.85), cy + r * Math.sin(Math.PI * 0.85));
            targetCtx.arc(cx, cy, r, Math.PI * 0.85, Math.PI * 1.85);
          } else {
            const start = polyStarts[idx];
            const end = polyStarts[idx + 1];
            const vCount = (end - start) >> 1;
            if (vCount >= 3) {
              const tv = topVertOffsets[idx];
              const pPrev = start + (((tv - 1 + vCount) % vCount) << 1);
              const pTop = start + (tv << 1);
              const pNext = start + (((tv + 1) % vCount) << 1);
              targetCtx.moveTo(
                originShiftX + polyCoords[pPrev] * pxPerCm,
                originShiftY + polyCoords[pPrev + 1] * pxPerCm
              );
              targetCtx.lineTo(
                originShiftX + polyCoords[pTop] * pxPerCm,
                originShiftY + polyCoords[pTop + 1] * pxPerCm
              );
              targetCtx.lineTo(
                originShiftX + polyCoords[pNext] * pxPerCm,
                originShiftY + polyCoords[pNext + 1] * pxPerCm
              );
            }
          }
        }
        targetCtx.stroke();

        // Bisel sombreado inferior-derecho
        targetCtx.strokeStyle = 'rgba(18, 28, 24, 0.20)';
        targetCtx.beginPath();
        for (let j = 0; j < finishIndices.length; j++) {
          const idx = finishIndices[j];
          if (isCircle[idx]) {
            const cx = originShiftX + centers[idx * 2] * pxPerCm;
            const cy = originShiftY + centers[idx * 2 + 1] * pxPerCm;
            const r = Math.max(1, radii[idx] * pxPerCm - 1);
            targetCtx.moveTo(cx + r * Math.cos(-Math.PI * 0.15), cy + r * Math.sin(-Math.PI * 0.15));
            targetCtx.arc(cx, cy, r, -Math.PI * 0.15, Math.PI * 0.85);
          } else {
            const start = polyStarts[idx];
            const end = polyStarts[idx + 1];
            const vCount = (end - start) >> 1;
            if (vCount >= 3) {
              const opp = (topVertOffsets[idx] + Math.floor(vCount / 2)) % vCount;
              const pPrev = start + (((opp - 1 + vCount) % vCount) << 1);
              const pOpp = start + (opp << 1);
              const pNext = start + (((opp + 1) % vCount) << 1);
              targetCtx.moveTo(
                originShiftX + polyCoords[pPrev] * pxPerCm,
                originShiftY + polyCoords[pPrev + 1] * pxPerCm
              );
              targetCtx.lineTo(
                originShiftX + polyCoords[pOpp] * pxPerCm,
                originShiftY + polyCoords[pOpp + 1] * pxPerCm
              );
              targetCtx.lineTo(
                originShiftX + polyCoords[pNext] * pxPerCm,
                originShiftY + polyCoords[pNext + 1] * pxPerCm
              );
            }
          }
        }
        targetCtx.stroke();
      } else if (finish === 'glass') {
        // Brillo vítreo diagonal translúcido en una sola pasada global
        targetCtx.fillStyle = 'rgba(255, 255, 255, 0.24)';
        targetCtx.beginPath();
        for (let j = 0; j < finishIndices.length; j++) {
          const idx = finishIndices[j];
          const cx = originShiftX + centers[idx * 2] * pxPerCm;
          const cy = originShiftY + centers[idx * 2 + 1] * pxPerCm;
          if (isCircle[idx]) {
            const r = radii[idx] * pxPerCm;
            const gx = cx - r * 0.26;
            const gy = cy - r * 0.26;
            const gr = r * 0.42;
            targetCtx.moveTo(gx + gr, gy);
            targetCtx.arc(gx, gy, gr, 0, TWO_PI);
          } else {
            const start = polyStarts[idx];
            const end = polyStarts[idx + 1];
            const vCount = (end - start) >> 1;
            if (vCount >= 3) {
              const tv = topVertOffsets[idx];
              const pPrev = start + (((tv - 1 + vCount) % vCount) << 1);
              const pTop = start + (tv << 1);
              const pNext = start + (((tv + 1) % vCount) << 1);

              const tx = originShiftX + polyCoords[pTop] * pxPerCm;
              const ty = originShiftY + polyCoords[pTop + 1] * pxPerCm;
              const px1 = originShiftX + polyCoords[pNext] * pxPerCm;
              const py1 = originShiftY + polyCoords[pNext + 1] * pxPerCm;
              const px2 = originShiftX + polyCoords[pPrev] * pxPerCm;
              const py2 = originShiftY + polyCoords[pPrev + 1] * pxPerCm;

              targetCtx.moveTo(tx, ty);
              targetCtx.lineTo((tx + px1) * 0.5, (ty + py1) * 0.5);
              targetCtx.lineTo(cx, cy);
              targetCtx.lineTo((tx + px2) * 0.5, (ty + py2) * 0.5);
              targetCtx.closePath();
            }
          }
        }
        targetCtx.fill();

        targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
        targetCtx.lineWidth = Math.max(0.75, Math.min(1.4, tilePx * 0.06));
        targetCtx.beginPath();
        for (let j = 0; j < finishIndices.length; j++) {
          appendCachedShapePath(targetCtx, cache, finishIndices[j], originShiftX, originShiftY, pxPerCm);
        }
        targetCtx.stroke();
      }
    }
  }

  if (drawNumbers && (darkLabels.length > 0 || lightLabels.length > 0)) {
    const fontSize = Math.max(8, Math.min(tilePx * 0.38, forPdf ? 26 : 17));
    targetCtx.font = `600 ${fontSize}px "DM Mono", monospace`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';

    if (darkLabels.length > 0) {
      targetCtx.fillStyle = isContour ? '#24332d' : 'rgba(28, 38, 34, 0.85)';
      for (let i = 0; i < darkLabels.length; i += 3) {
        targetCtx.fillText(darkLabels[i], darkLabels[i + 1], darkLabels[i + 2]);
      }
    }
    if (lightLabels.length > 0) {
      targetCtx.fillStyle = 'rgba(255, 253, 248, 0.92)';
      for (let i = 0; i < lightLabels.length; i += 3) {
        targetCtx.fillText(lightLabels[i], lightLabels[i + 1], lightLabels[i + 2]);
      }
    }
  }

  return renderedTiles;
}

/**
 * Renderiza una región física del diseño (imagen directa o teselas de mosaico)
 * con culling X/Y y batching por color para garantizar >= 30 fps hasta 10 000+ teselas
 * tanto en patrones clásicos como en los 7 patrones poligonales de Fase 2.
 *
 * @param {CanvasRenderingContext2D} targetCtx
 * @param {Object} opts
 */
export function renderDesignRegion(targetCtx, opts) {
  const {
    destX,
    destY,
    destW,
    destH,
    srcXCm,
    srcYCm,
    srcWCm,
    srcHCm,
    pxPerCm,
    state,
    forPdf = false,
  } = opts;

  const { config, grid, palette, gridMetrics, sourceImage } = state;

  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.rect(destX, destY, destW, destH);
  targetCtx.clip();

  // Fondo de junta / papel
  targetCtx.fillStyle = config.mosaicMode
    ? config.viewMode === 'contour'
      ? '#ffffff'
      : config.viewMode === 'breakdown'
      ? '#f6f4ef'
      : config.groutColor || '#D6D3CB'
    : '#ffffff';
  targetCtx.fillRect(destX, destY, destW, destH);

  // Modo Imagen Directa / Póster (sin mosaico)
  if (!config.mosaicMode || !grid || !gridMetrics) {
    if (sourceImage) {
      const posterDrawable = getOrBuildPosterCanvas(sourceImage, config) || sourceImage;
      targetCtx.save();

      const imgW = posterDrawable.width || sourceImage.width || 960;
      const imgH = posterDrawable.height || sourceImage.height || 720;

      if (config.mirrorMode) {
        targetCtx.translate(destX + (config.widthCm - srcXCm) * pxPerCm, destY - srcYCm * pxPerCm);
        targetCtx.scale(-1, 1);
        targetCtx.drawImage(posterDrawable, 0, 0, config.widthCm * pxPerCm, config.heightCm * pxPerCm);
      } else {
        targetCtx.drawImage(
          posterDrawable,
          0,
          0,
          imgW,
          imgH,
          destX - srcXCm * pxPerCm,
          destY - srcYCm * pxPerCm,
          config.widthCm * pxPerCm,
          config.heightCm * pxPerCm
        );
      }
      targetCtx.restore();
    }
    targetCtx.restore();
    return 0;
  }

  // Ruta Poligonal Fase 2 si pattern es poligonal o state.cells está presente
  const isPoly = isPolygonalPattern(config.pattern) || (Array.isArray(state.cells) && state.cells.length > 0);
  if (isPoly) {
    const polyCells =
      Array.isArray(state.cells) && state.cells.length > 0
        ? state.cells
        : generatePatternCells(config);
    const rendered = renderPolygonalRegion(targetCtx, {
      destX,
      destY,
      srcXCm,
      srcYCm,
      srcWCm,
      srcHCm,
      pxPerCm,
      state,
      cells: polyCells,
      forPdf,
    });
    targetCtx.restore();
    return rendered;
  }

  // RUTA RÁPIDA CLÁSICA (grid / brick_50): culling estricto X/Y + batching por color
  const tileSize = gridMetrics.tileSizeCm;
  const isBrick = gridMetrics.isBrick50;
  const widthCm = config.widthCm;
  const heightCm = config.heightCm;
  const groutCm = (config.groutMm || 0) / 10;
  const halfGroutPx = groutCm * pxPerCm * 0.5;
  const tilePx = tileSize * pxPerCm;

  const visY0 = Math.max(0, srcYCm);
  const visY1 = Math.min(heightCm, srcYCm + srcHCm);
  const visX0 = Math.max(0, srcXCm);
  const visX1 = Math.min(widthCm, srcXCm + srcWCm);

  if (visX1 <= visX0 || visY1 <= visY0) {
    targetCtx.restore();
    return 0;
  }

  const startRow = Math.max(0, Math.floor(visY0 / tileSize));
  const endRow = Math.min(gridMetrics.tileRows - 1, Math.ceil(visY1 / tileSize) - 1);

  const logX0 = config.mirrorMode ? widthCm - visX1 : visX0;
  const logX1 = config.mirrorMode ? widthCm - visX0 : visX1;

  const drawNumbers = Boolean(config.showNumbers) && tilePx >= (forPdf ? 14 : 18);
  const palLen = palette.length;
  const viewMode = config.viewMode || 'color';
  const isContour = viewMode === 'contour';
  const isGrayscale = viewMode === 'grayscale';
  const isBreakdown = viewMode === 'breakdown';
  const breakdownIdx = Number.isInteger(config.breakdownColorIdx) ? config.breakdownColorIdx : 0;
  const finish = config.finish || 'ceramic';

  const fillStyles = new Array(palLen);
  const isLightColor = new Uint8Array(palLen);
  const buckets = new Array(palLen);

  for (let k = 0; k < palLen; k++) {
    const colObj = palette[k];
    const lum = getLuminance(colObj.r, colObj.g, colObj.b);
    isLightColor[k] = lum > 142 ? 1 : 0;
    if (isGrayscale) {
      const gVal = Math.round(lum);
      fillStyles[k] = `rgb(${gVal},${gVal},${gVal})`;
    } else if (isBreakdown && k !== breakdownIdx) {
      const muted = Math.round(lum * 0.25 + 225 * 0.75);
      fillStyles[k] = `rgba(${muted},${muted},${muted},0.42)`;
    } else {
      fillStyles[k] = colObj.hex;
    }
    buckets[k] = [];
  }

  const darkLabels = drawNumbers ? [] : null;
  const lightLabels = drawNumbers ? [] : null;
  const contourRects = isContour ? [] : null;
  let renderedTiles = 0;

  for (let r = startRow; r <= endRow; r++) {
    const isOddRow = isBrick && r % 2 === 1;
    const rowCols = isOddRow ? gridMetrics.tileCols + 1 : gridMetrics.tileCols;
    const offsetXCm = isOddRow ? -tileSize * 0.5 : 0;

    const clippedY0 = Math.max(0, r * tileSize);
    const clippedY1 = Math.min(heightCm, clippedY0 + tileSize);
    if (clippedY1 <= clippedY0 + 1e-9) continue;

    const yTopPx = destY + (clippedY0 - srcYCm) * pxPerCm + halfGroutPx;
    const hPx = Math.max(0.5, (clippedY1 - clippedY0) * pxPerCm - halfGroutPx * 2);

    const startCol = Math.max(0, Math.floor((logX0 - offsetXCm) / tileSize));
    const endCol = Math.min(rowCols - 1, Math.floor((logX1 - offsetXCm) / tileSize));
    const rowBase = r * gridMetrics.maxRowCols;

    for (let c = startCol; c <= endCol; c++) {
      const colorIdx = grid[rowBase + c];
      if (colorIdx === undefined || colorIdx === UNUSED_CELL || colorIdx < 0 || colorIdx >= palLen || !buckets[colorIdx]) continue;

      const rawX0 = offsetXCm + c * tileSize;
      const rawX1 = rawX0 + tileSize;
      const logCellX0 = rawX0 > 0 ? rawX0 : 0;
      const logCellX1 = rawX1 < widthCm ? rawX1 : widthCm;
      if (logCellX1 <= logCellX0 + 1e-9) continue;

      const clippedX0 = config.mirrorMode ? widthCm - logCellX1 : logCellX0;
      const clippedX1 = config.mirrorMode ? widthCm - logCellX0 : logCellX1;

      const xPx = destX + (clippedX0 - srcXCm) * pxPerCm + halfGroutPx;
      const wPx = Math.max(0.5, (clippedX1 - clippedX0) * pxPerCm - halfGroutPx * 2);

      renderedTiles++;

      if (isContour) {
        contourRects.push(xPx, yTopPx, wPx, hPx);
      } else {
        buckets[colorIdx].push(xPx, yTopPx, wPx, hPx);
      }

      if (drawNumbers && (!isBreakdown || colorIdx === breakdownIdx) && wPx >= 12 && hPx >= 12) {
        const label = String(colorIdx + 1);
        const cx = xPx + wPx * 0.5;
        const cy = yTopPx + hPx * 0.5 + 0.5;
        if (isContour || isLightColor[colorIdx]) {
          darkLabels.push(label, cx, cy);
        } else {
          lightLabels.push(label, cx, cy);
        }
      }
    }
  }

  if (isContour) {
    targetCtx.strokeStyle = '#24332d';
    targetCtx.lineWidth = Math.max(1, pxPerCm * 0.04);
    targetCtx.beginPath();
    for (let i = 0; i < contourRects.length; i += 4) {
      targetCtx.rect(contourRects[i], contourRects[i + 1], contourRects[i + 2], contourRects[i + 3]);
    }
    targetCtx.stroke();
  } else {
    for (let k = 0; k < palLen; k++) {
      const b = buckets[k];
      if (b.length === 0) continue;
      targetCtx.fillStyle = fillStyles[k];
      for (let i = 0; i < b.length; i += 4) {
        targetCtx.fillRect(b[i], b[i + 1], b[i + 2], b[i + 3]);
      }
    }

    if (isBreakdown) {
      const activeB = buckets[breakdownIdx];
      if (activeB && activeB.length > 0) {
        targetCtx.strokeStyle = '#24332d';
        targetCtx.lineWidth = Math.max(1.2, pxPerCm * 0.05);
        targetCtx.beginPath();
        for (let i = 0; i < activeB.length; i += 4) {
          targetCtx.rect(activeB[i], activeB[i + 1], activeB[i + 2], activeB[i + 3]);
        }
        targetCtx.stroke();
      }
    }

    // Acabado superficial (solo cuando la tesela mide >= 12 px para mantener >= 30 fps incluso a 10k)
    if (finish !== 'matte' && tilePx >= 12) {
      const bevel = Math.max(1, Math.min(2, tilePx * 0.08));
      const canTriangle = typeof targetCtx.moveTo === 'function' && typeof targetCtx.fill === 'function';

      if (finish === 'ceramic') {
        targetCtx.fillStyle = 'rgba(255, 255, 255, 0.24)';
        for (let k = 0; k < palLen; k++) {
          if (isBreakdown && k !== breakdownIdx) continue;
          const b = buckets[k];
          for (let i = 0; i < b.length; i += 4) {
            targetCtx.fillRect(b[i], b[i + 1], b[i + 2], bevel);
          }
        }
        targetCtx.fillStyle = 'rgba(18, 28, 24, 0.16)';
        for (let k = 0; k < palLen; k++) {
          if (isBreakdown && k !== breakdownIdx) continue;
          const b = buckets[k];
          for (let i = 0; i < b.length; i += 4) {
            targetCtx.fillRect(b[i], b[i + 1] + b[i + 3] - bevel, b[i + 2], bevel);
          }
        }
      } else if (finish === 'glass' && canTriangle) {
        targetCtx.fillStyle = 'rgba(255, 255, 255, 0.24)';
        targetCtx.beginPath();
        for (let k = 0; k < palLen; k++) {
          if (isBreakdown && k !== breakdownIdx) continue;
          const b = buckets[k];
          for (let i = 0; i < b.length; i += 4) {
            const x = b[i];
            const y = b[i + 1];
            const w = b[i + 2];
            const h = b[i + 3];
            targetCtx.moveTo(x, y);
            targetCtx.lineTo(x + w * 0.68, y);
            targetCtx.lineTo(x, y + h * 0.68);
            targetCtx.closePath();
          }
        }
        targetCtx.fill();
      }
    }
  }

  if (drawNumbers && (darkLabels.length > 0 || lightLabels.length > 0)) {
    const fontSize = Math.max(8, Math.min(tilePx * 0.42, forPdf ? 26 : 18));
    targetCtx.font = `600 ${fontSize}px "DM Mono", monospace`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';

    if (darkLabels.length > 0) {
      targetCtx.fillStyle = isContour ? '#24332d' : 'rgba(28, 38, 34, 0.85)';
      for (let i = 0; i < darkLabels.length; i += 3) {
        targetCtx.fillText(darkLabels[i], darkLabels[i + 1], darkLabels[i + 2]);
      }
    }
    if (lightLabels.length > 0) {
      targetCtx.fillStyle = 'rgba(255, 253, 248, 0.92)';
      for (let i = 0; i < lightLabels.length; i += 3) {
        targetCtx.fillText(lightLabels[i], lightLabels[i + 1], lightLabels[i + 2]);
      }
    }
  }

  targetCtx.restore();
  return renderedTiles;
}

/**
 * Dibuja la superposición de hojas físicas multipapel (A4/A3/Carta/Oficio/Personalizado)
 * con marcas de solapamiento y etiquetas A1, A2, B1...
 */
export function drawPrintGridOverlay(ctx, state, pxPerCm, originX, originY, viewW, viewH) {
  const { config, printMetrics, printSheets } = state;
  if (!config.showA4Grid || !printMetrics || !Array.isArray(printSheets) || printSheets.length === 0) {
    return;
  }

  ctx.save();
  const drawW = config.widthCm * pxPerCm;
  const drawH = config.heightCm * pxPerCm;

  ctx.beginPath();
  ctx.rect(originX, originY, drawW, drawH);
  ctx.clip();

  const lineW = Math.max(1.5, Math.min(2.5, pxPerCm * 0.08));
  const overlapPx = printMetrics.overlap * pxPerCm;

  for (let i = 0; i < printSheets.length; i++) {
    const sheet = printSheets[i];
    const rx = originX + sheet.srcXCm * pxPerCm;
    const ry = originY + sheet.srcYCm * pxPerCm;
    const rw = sheet.sliceWCm * pxPerCm;
    const rh = sheet.sliceHCm * pxPerCm;

    // Culling rápido de hojas fuera del viewport
    if (rx + rw < 0 || ry + rh < 0 || rx > viewW || ry > viewH) {
      continue;
    }

    ctx.strokeStyle = 'rgba(189, 117, 78, 0.92)';
    ctx.lineWidth = lineW;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    if (printMetrics.overlap > 0 && sheet.col > 0) {
      ctx.fillStyle = 'rgba(189, 117, 78, 0.12)';
      ctx.fillRect(rx, ry, overlapPx, rh);
    }
    if (printMetrics.overlap > 0 && sheet.row > 0) {
      ctx.fillStyle = 'rgba(189, 117, 78, 0.12)';
      ctx.fillRect(rx, ry, rw, overlapPx);
    }

    if (rw > 28 && rh > 22) {
      const badgeW = Math.max(26, Math.min(44, rw * 0.35));
      const badgeH = 18;
      ctx.fillStyle = 'rgba(38, 63, 54, 0.88)';
      ctx.fillRect(rx + 4, ry + 4, badgeW, badgeH);
      ctx.fillStyle = '#fffdf8';
      ctx.font = '600 11px "DM Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sheet.label, rx + 4 + badgeW / 2, ry + 4 + badgeH / 2 + 0.5);
    }
  }

  ctx.restore();
}

/**
 * Crea el controlador de renderizado Canvas de alto rendimiento (DPR-aware + caché offscreen para pan/pincel).
 */
export function createCanvasRenderer(canvas, viewport, store) {
  const ctx = canvas.getContext('2d');
  let rafId = null;
  let dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  let viewWidth = 800;
  let viewHeight = 600;

  let cacheCanvas = null;
  let cacheCtx = null;
  let cacheKey = '';
  let cachePxPerCm = 0;
  let pendingTilePatches = [];

  function getPxPerCm() {
    return store.getState().zoom * 5;
  }

  function screenToCm(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const state = store.getState();
    const pxPerCm = getPxPerCm();
    const xCm = (sx - state.panX) / pxPerCm;
    const yCm = (sy - state.panY) / pxPerCm;
    return { xCm, yCm, sx, sy };
  }

  function resize() {
    const rect = viewport.getBoundingClientRect();
    dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    viewWidth = Math.max(1, rect.width);
    viewHeight = Math.max(1, rect.height);
    canvas.width = Math.max(1, Math.floor(viewWidth * dpr));
    canvas.height = Math.max(1, Math.floor(viewHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderNow();
  }

  function fitToView() {
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    viewWidth = rect.width;
    viewHeight = rect.height;

    const state = store.getState();
    const pad = 44;
    const availW = Math.max(100, rect.width - pad * 2);
    const availH = Math.max(100, rect.height - pad * 2);
    const pxPerCm = Math.min(availW / state.config.widthCm, availH / state.config.heightCm);

    state.zoom = pxPerCm / 5;
    const drawW = state.config.widthCm * pxPerCm;
    const drawH = state.config.heightCm * pxPerCm;
    state.panX = (rect.width - drawW) / 2;
    state.panY = (rect.height - drawH) / 2;

    store.notify('camera');
    renderNow();
  }

  function applyZoom(newZoom, centerClientX = null, centerClientY = null) {
    const state = store.getState();
    const clamped = Math.max(0.15, Math.min(12, newZoom));
    const rect = viewport.getBoundingClientRect();
    const cx = centerClientX !== null ? centerClientX - rect.left : rect.width / 2;
    const cy = centerClientY !== null ? centerClientY - rect.top : rect.height / 2;

    const ratio = clamped / state.zoom;
    state.panX = cx - (cx - state.panX) * ratio;
    state.panY = cy - (cy - state.panY) * ratio;
    state.zoom = clamped;

    store.notify('camera');
    scheduleRender();
  }

  function buildCacheKey(state, pxPerCm) {
    const c = state.config;
    return [
      state.gridVersion,
      c.mosaicMode ? 1 : 0,
      c.widthCm,
      c.heightCm,
      c.tileSizeCm,
      c.pattern,
      c.groutColor,
      c.groutMm,
      state.isInteractiveDragging ? 1 : 0,
      c.viewMode,
      c.viewMode === 'breakdown' ? c.breakdownColorIdx : 0,
      c.finish,
      c.showNumbers ? 1 : 0,
      c.mirrorMode ? 1 : 0,
      Math.round(pxPerCm * 100),
      dpr,
    ].join('|');
  }

  function patchCachedTile(state, patch) {
    if (!cacheCtx || !state.gridMetrics) return;
    const colObj = state.palette[patch.newColorIdx];
    if (!colObj) return;

    const pxPerCm = cachePxPerCm;
    const cfg = state.config;
    const groutCm = (cfg.groutMm || 0) / 10;
    const halfGroutCm = groutCm * 0.5;
    const halfGroutPx = halfGroutCm * pxPerCm;
    const tilePx = state.gridMetrics.tileSizeCm * pxPerCm;
    const lum = getLuminance(colObj.r, colObj.g, colObj.b);
    const isBreakdown = cfg.viewMode === 'breakdown';
    const breakdownIdx = Number.isInteger(cfg.breakdownColorIdx) ? cfg.breakdownColorIdx : 0;
    const isDimmed = isBreakdown && patch.newColorIdx !== breakdownIdx;

    if (patch.isPolygonal && Array.isArray(state.cells) && Number.isInteger(patch.idx)) {
      const cell = state.cells[patch.idx];
      if (!cell) return;

      const cache = getOrBuildPolygonalRenderCache(
        state.cells,
        cfg.widthCm,
        Boolean(cfg.mirrorMode),
        halfGroutCm
      );

      // Limpiar la huella completa sin inset con color de junta para evitar halo del color anterior
      const rawPoly = cfg.mirrorMode ? mirrorPolygonCm(cell.polygonCm, cfg.widthCm) : cell.polygonCm;
      if (rawPoly.length >= 3) {
        cacheCtx.fillStyle =
          cfg.viewMode === 'contour'
            ? '#ffffff'
            : isBreakdown
            ? '#f6f4ef'
            : cfg.groutColor || '#D6D3CB';
        cacheCtx.beginPath();
        cacheCtx.moveTo(rawPoly[0][0] * pxPerCm, rawPoly[0][1] * pxPerCm);
        for (let v = 1; v < rawPoly.length; v++) {
          cacheCtx.lineTo(rawPoly[v][0] * pxPerCm, rawPoly[v][1] * pxPerCm);
        }
        cacheCtx.closePath();
        cacheCtx.fill();
      }

      cacheCtx.beginPath();
      appendCachedShapePath(cacheCtx, cache, patch.idx, 0, 0, pxPerCm);

      if (cfg.viewMode === 'contour') {
        cacheCtx.fillStyle = '#ffffff';
        cacheCtx.fill();
        cacheCtx.strokeStyle = '#24332d';
        cacheCtx.lineWidth = Math.max(1, pxPerCm * 0.04);
        cacheCtx.stroke();
      } else if (cfg.viewMode === 'grayscale') {
        const gVal = Math.round(lum);
        cacheCtx.fillStyle = `rgb(${gVal},${gVal},${gVal})`;
        cacheCtx.fill();
      } else if (isDimmed) {
        const muted = Math.round(lum * 0.25 + 225 * 0.75);
        cacheCtx.fillStyle = `rgba(${muted},${muted},${muted},0.42)`;
        cacheCtx.fill();
        cacheCtx.strokeStyle = 'rgba(150, 158, 152, 0.38)';
        cacheCtx.lineWidth = Math.max(0.6, pxPerCm * 0.025);
        cacheCtx.stroke();
      } else {
        cacheCtx.fillStyle = colObj.hex;
        cacheCtx.fill();
        if (isBreakdown) {
          cacheCtx.strokeStyle = '#24332d';
          cacheCtx.lineWidth = Math.max(1.2, pxPerCm * 0.05);
          cacheCtx.stroke();
        }
      }

      const b4 = patch.idx * 4;
      const visWPx = (cache.bboxes[b4 + 2] - cache.bboxes[b4]) * pxPerCm;
      const visHPx = (cache.bboxes[b4 + 3] - cache.bboxes[b4 + 1]) * pxPerCm;
      const drawNumbers = Boolean(cfg.showNumbers) && tilePx >= 18;
      if (drawNumbers && (!isBreakdown || !isDimmed) && visWPx >= 14 && visHPx >= 14) {
        const fontSize = Math.max(8, Math.min(tilePx * 0.38, 17));
        cacheCtx.font = `600 ${fontSize}px "DM Mono", monospace`;
        cacheCtx.textAlign = 'center';
        cacheCtx.textBaseline = 'middle';
        cacheCtx.fillStyle =
          cfg.viewMode === 'contour'
            ? '#24332d'
            : lum > 142
              ? 'rgba(28, 38, 34, 0.85)'
              : 'rgba(255, 253, 248, 0.92)';
        cacheCtx.fillText(
          String(patch.newColorIdx + 1),
          cache.centers[patch.idx * 2] * pxPerCm,
          cache.centers[patch.idx * 2 + 1] * pxPerCm + 0.5
        );
      }
      return;
    }

    const rect = getTileRectCm(patch.row, patch.col, state.gridMetrics, {
      mirrorMode: cfg.mirrorMode,
    });
    if (!rect) return;

    const xPx = rect.x0Cm * pxPerCm + halfGroutPx;
    const yPx = rect.y0Cm * pxPerCm + halfGroutPx;
    const wPx = Math.max(0.5, rect.wCm * pxPerCm - halfGroutPx * 2);
    const hPx = Math.max(0.5, rect.hCm * pxPerCm - halfGroutPx * 2);

    if (isBreakdown) {
      cacheCtx.fillStyle = '#f6f4ef';
      cacheCtx.fillRect(xPx, yPx, wPx, hPx);
    }

    if (cfg.viewMode === 'contour') {
      cacheCtx.fillStyle = '#ffffff';
      cacheCtx.fillRect(xPx, yPx, wPx, hPx);
      cacheCtx.strokeStyle = '#24332d';
      cacheCtx.lineWidth = Math.max(1, pxPerCm * 0.04);
      cacheCtx.strokeRect(xPx, yPx, wPx, hPx);
    } else if (cfg.viewMode === 'grayscale') {
      const gVal = Math.round(lum);
      cacheCtx.fillStyle = `rgb(${gVal},${gVal},${gVal})`;
      cacheCtx.fillRect(xPx, yPx, wPx, hPx);
    } else if (isDimmed) {
      const muted = Math.round(lum * 0.25 + 225 * 0.75);
      cacheCtx.fillStyle = `rgba(${muted},${muted},${muted},0.42)`;
      cacheCtx.fillRect(xPx, yPx, wPx, hPx);
    } else {
      cacheCtx.fillStyle = colObj.hex;
      cacheCtx.fillRect(xPx, yPx, wPx, hPx);
      if (isBreakdown) {
        cacheCtx.strokeStyle = '#24332d';
        cacheCtx.lineWidth = Math.max(1.2, pxPerCm * 0.05);
        cacheCtx.strokeRect(xPx, yPx, wPx, hPx);
      }
    }

    const drawNumbers = Boolean(cfg.showNumbers) && tilePx >= 18;
    if (drawNumbers && (!isBreakdown || !isDimmed) && wPx >= 12 && hPx >= 12) {
      const fontSize = Math.max(8, Math.min(tilePx * 0.42, 18));
      cacheCtx.font = `600 ${fontSize}px "DM Mono", monospace`;
      cacheCtx.textAlign = 'center';
      cacheCtx.textBaseline = 'middle';
      cacheCtx.fillStyle =
        cfg.viewMode === 'contour'
          ? '#24332d'
          : lum > 142
            ? 'rgba(28, 38, 34, 0.85)'
            : 'rgba(255, 253, 248, 0.92)';
      cacheCtx.fillText(String(patch.newColorIdx + 1), xPx + wPx * 0.5, yPx + hPx * 0.5 + 0.5);
    }
  }

  function queueTilePatch(patch) {
    pendingTilePatches.push(patch);
  }

  function invalidateCache() {
    cacheKey = '';
    pendingTilePatches = [];
  }

  function renderNow() {
    const state = store.getState();
    ctx.clearRect(0, 0, viewWidth, viewHeight);
    if (!state.sourceImage && !state.grid) return;

    const pxPerCm = getPxPerCm();
    const drawW = state.config.widthCm * pxPerCm;
    const drawH = state.config.heightCm * pxPerCm;
    const originX = state.panX;
    const originY = state.panY;

    // Sombra editorial ligera sin shadowBlur pesado en cada frame
    ctx.fillStyle = 'rgba(36, 51, 45, 0.10)';
    ctx.fillRect(originX + 4, originY + 8, drawW, drawH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(originX, originY, drawW, drawH);

    const canUseOffscreenCache =
      typeof document !== 'undefined' &&
      state.config.mosaicMode &&
      Boolean(state.grid) &&
      drawW * dpr <= 2400 &&
      drawH * dpr <= 2400 &&
      drawW >= 4 &&
      drawH >= 4;

    if (canUseOffscreenCache) {
      const nextKey = buildCacheKey(state, pxPerCm);
      if (cacheKey !== nextKey || !cacheCanvas) {
        if (!cacheCanvas) {
          cacheCanvas = document.createElement('canvas');
          cacheCtx = cacheCanvas.getContext('2d');
        }
        cacheCanvas.width = Math.max(1, Math.ceil(drawW * dpr));
        cacheCanvas.height = Math.max(1, Math.ceil(drawH * dpr));
        cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cachePxPerCm = pxPerCm;
        renderDesignRegion(cacheCtx, {
          destX: 0,
          destY: 0,
          destW: drawW,
          destH: drawH,
          srcXCm: 0,
          srcYCm: 0,
          srcWCm: state.config.widthCm,
          srcHCm: state.config.heightCm,
          pxPerCm,
          state,
          forPdf: false,
        });
        cacheKey = nextKey;
        pendingTilePatches = [];
      } else if (pendingTilePatches.length > 0) {
        for (let i = 0; i < pendingTilePatches.length; i++) {
          patchCachedTile(state, pendingTilePatches[i]);
        }
        pendingTilePatches = [];
      }

      ctx.drawImage(cacheCanvas, originX, originY, drawW, drawH);
    } else {
      // Vista muy ampliada (> 2400px) o Modo Imagen Directa: dibujar solo región visible en viewport
      pendingTilePatches = [];
      const visLeft = Math.max(originX, 0);
      const visTop = Math.max(originY, 0);
      const visRight = Math.min(originX + drawW, viewWidth);
      const visBottom = Math.min(originY + drawH, viewHeight);

      if (visRight > visLeft && visBottom > visTop) {
        const srcXCm = (visLeft - originX) / pxPerCm;
        const srcYCm = (visTop - originY) / pxPerCm;
        const srcWCm = (visRight - visLeft) / pxPerCm;
        const srcHCm = (visBottom - visTop) / pxPerCm;

        renderDesignRegion(ctx, {
          destX: visLeft,
          destY: visTop,
          destW: visRight - visLeft,
          destH: visBottom - visTop,
          srcXCm,
          srcYCm,
          srcWCm,
          srcHCm,
          pxPerCm,
          state,
          forPdf: false,
        });
      }
    }

    // Superposición de hojas de impresión multipapel
    drawPrintGridOverlay(ctx, state, pxPerCm, originX, originY, viewWidth, viewHeight);

    // Borde exterior nítido del mural
    ctx.strokeStyle = '#36594d';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(originX, originY, drawW, drawH);
  }

  function scheduleRender() {
    if (rafId !== null) return;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    rafId = raf(() => {
      rafId = null;
      renderNow();
    });
  }

  return {
    resize,
    fitToView,
    applyZoom,
    screenToCm,
    getPxPerCm,
    renderNow,
    scheduleRender,
    queueTilePatch,
    invalidateCache,
  };
}

/**
 * Renderiza una instantánea limpia del diseño completo (Mosaico o Póster) sobre un canvas destino,
 * utilizada por el módulo de Realidad Aumentada (`cameraArController`).
 *
 * @param {HTMLCanvasElement} targetCanvas
 * @param {ReturnType<import('/public/js/state/studioStore.js').createStudioStore>['getState'] extends () => infer S ? S : any} state
 * @param {{ forceContour?: boolean, showGrid?: boolean }} [options={}]
 */
export function renderArtworkSnapshotToCanvas(
  targetCanvas,
  state,
  { forceContour = false, showGrid = false } = {}
) {
  if (!targetCanvas || !state || !state.config) return false;
  const ctx = typeof targetCanvas.getContext === 'function' ? targetCanvas.getContext('2d') : null;
  if (!ctx) return false;

  const width = Math.max(1, Number(targetCanvas.width) || 720);
  const height = Math.max(1, Number(targetCanvas.height) || 540);
  ctx.clearRect?.(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const cfg = state.config;
  const widthCm = Math.max(1, Number(cfg.widthCm) || 120);
  const heightCm = Math.max(1, Number(cfg.heightCm) || 90);
  const pxPerCm = Math.min(width / widthCm, height / heightCm);
  const destW = widthCm * pxPerCm;
  const destH = heightCm * pxPerCm;
  const destX = (width - destW) * 0.5;
  const destY = (height - destH) * 0.5;

  const effectiveConfig = { ...cfg };
  if (forceContour) {
    effectiveConfig.viewMode = 'contour';
    if (!effectiveConfig.mosaicMode) {
      effectiveConfig.posterFilterMode = 'line_art';
      effectiveConfig.posterInvert = false;
    }
  }

  const snapshotState = {
    ...state,
    isInteractiveDragging: false,
    config: effectiveConfig,
  };

  renderDesignRegion(ctx, {
    destX,
    destY,
    destW,
    destH,
    srcXCm: 0,
    srcYCm: 0,
    srcWCm: widthCm,
    srcHCm: heightCm,
    pxPerCm,
    state: snapshotState,
    forPdf: false,
  });

  if (showGrid) {
    drawPrintGridOverlay(
      ctx,
      {
        ...snapshotState,
        config: { ...effectiveConfig, showA4Grid: true },
      },
      pxPerCm,
      destX,
      destY,
      width,
      height
    );
  }

  return true;
}

