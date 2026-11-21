import { createDefaultConfig } from '/shared/contracts.js';
import {
  UNUSED_CELL,
  rgbToHex,
  colorDistSq,
  computeGridMetrics,
  getTileRectCm,
  recountPalette,
  runKMeansRedmean,
} from '/shared/mosaicCore.js';
import {
  srgbToLab,
  runKMeansLab,
  quantizeWithDithering,
} from '/shared/colorLab.js';
import { preprocessRgba } from '/shared/preprocess.js';
import {
  generatePatternCells,
  pointInPolygon,
} from '/shared/patterns.js';
import {
  generateMixtureAssignments,
  generateGradientAssignments,
} from '/shared/mixtures.js';

function normalizePattern(pattern) {
  if (pattern === 'brick') return 'brick_50';
  return pattern || 'grid';
}

export function isPolygonalPattern(pattern) {
  const p = normalizePattern(pattern);
  return p !== 'grid' && p !== 'brick_50';
}

function normalizeRgbaView(rgbaBuffer, sampleW, sampleH) {
  if (!rgbaBuffer) return null;
  if (!Number.isInteger(sampleW) || sampleW <= 0 || !Number.isInteger(sampleH) || sampleH <= 0) {
    throw new Error(`Dimensiones de muestreo inválidas: ${sampleW}×${sampleH}`);
  }
  let view;
  if (rgbaBuffer instanceof ArrayBuffer) {
    view = new Uint8ClampedArray(rgbaBuffer);
  } else if (ArrayBuffer.isView(rgbaBuffer)) {
    view = new Uint8ClampedArray(rgbaBuffer.buffer, rgbaBuffer.byteOffset, rgbaBuffer.byteLength);
  } else if (Array.isArray(rgbaBuffer)) {
    view = Uint8ClampedArray.from(rgbaBuffer);
  } else {
    throw new Error('rgbaBuffer debe ser Uint8ClampedArray, Uint8Array o ArrayBuffer.');
  }

  const expected = sampleW * sampleH * 4;
  if (view.length < expected) {
    throw new Error(`rgbaBuffer insuficiente: esperado ${expected} bytes, recibido ${view.length}.`);
  }
  return view;
}

function getPolygonBbox(poly) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const x = poly[i][0];
    const y = poly[i][1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function sampleClassicCellsFromRgba(rgba, sampleW, sampleH, gridMetrics) {
  const pxPerCmX = sampleW / gridMetrics.widthCm;
  const pxPerCmY = sampleH / gridMetrics.heightCm;
  const samples = [];

  for (let r = 0; r < gridMetrics.tileRows; r++) {
    const rowCols = gridMetrics.isBrick50 && r % 2 === 1 ? gridMetrics.tileCols + 1 : gridMetrics.tileCols;
    for (let c = 0; c < rowCols; c++) {
      const rect = getTileRectCm(r, c, gridMetrics, { mirrorMode: false });
      if (!rect) continue;

      const py0 = Math.max(0, Math.floor(rect.y0Cm * pxPerCmY));
      const py1 = Math.min(sampleH - 1, Math.max(py0, Math.floor(rect.y1Cm * pxPerCmY - 1e-6)));
      const px0 = Math.max(0, Math.floor(rect.logicalX0Cm * pxPerCmX));
      const px1 = Math.min(sampleW - 1, Math.max(px0, Math.floor(rect.logicalX1Cm * pxPerCmX - 1e-6)));

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let cnt = 0;

      for (let py = py0; py <= py1; py++) {
        const rowOffset = py * sampleW * 4;
        for (let px = px0; px <= px1; px++) {
          const idx = rowOffset + px * 4;
          sumR += rgba[idx];
          sumG += rgba[idx + 1];
          sumB += rgba[idx + 2];
          cnt++;
        }
      }

      if (cnt === 0) cnt = 1;
      samples.push({
        r: sumR / cnt,
        g: sumG / cnt,
        b: sumB / cnt,
        row: r,
        col: c,
        centroidCm: [(rect.logicalX0Cm + rect.logicalX1Cm) * 0.5, (rect.y0Cm + rect.y1Cm) * 0.5],
        areaCm2: rect.wCm * rect.hCm,
        nominalAreaCm2: gridMetrics.tileSizeCm * gridMetrics.tileSizeCm,
      });
    }
  }

  return samples;
}

function buildClassicSamplesNoImage(gridMetrics) {
  const samples = [];
  for (let r = 0; r < gridMetrics.tileRows; r++) {
    const rowCols = gridMetrics.isBrick50 && r % 2 === 1 ? gridMetrics.tileCols + 1 : gridMetrics.tileCols;
    for (let c = 0; c < rowCols; c++) {
      const rect = getTileRectCm(r, c, gridMetrics, { mirrorMode: false });
      if (!rect) continue;
      samples.push({
        row: r,
        col: c,
        centroidCm: [(rect.logicalX0Cm + rect.logicalX1Cm) * 0.5, (rect.y0Cm + rect.y1Cm) * 0.5],
        areaCm2: rect.wCm * rect.hCm,
        nominalAreaCm2: gridMetrics.tileSizeCm * gridMetrics.tileSizeCm,
      });
    }
  }
  return samples;
}

function samplePolygonalCellsFromRgba(rgba, sampleW, sampleH, cells, widthCm, heightCm) {
  const pxPerCmX = sampleW / widthCm;
  const pxPerCmY = sampleH / heightCm;
  const invPxPerCmX = 1 / pxPerCmX;
  const invPxPerCmY = 1 / pxPerCmY;
  const samples = new Array(cells.length);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const poly = cell.polygonCm;
    const [minX, minY, maxX, maxY] = getPolygonBbox(poly);

    const px0 = Math.max(0, Math.floor(minX * pxPerCmX));
    const px1 = Math.min(sampleW - 1, Math.max(px0, Math.floor(maxX * pxPerCmX - 1e-6)));
    const py0 = Math.max(0, Math.floor(minY * pxPerCmY));
    const py1 = Math.min(sampleH - 1, Math.max(py0, Math.floor(maxY * pxPerCmY - 1e-6)));

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let cnt = 0;

    const isCircle = cell.shapeHint === 'circle' && Number.isFinite(cell.radiusCm);
    const circleCx = cell.centroidCm[0];
    const circleCy = cell.centroidCm[1];
    const circleRSq = isCircle ? cell.radiusCm * cell.radiusCm : 0;

    for (let py = py0; py <= py1; py++) {
      const yCm = (py + 0.5) * invPxPerCmY;
      const rowOffset = py * sampleW * 4;
      for (let px = px0; px <= px1; px++) {
        const xCm = (px + 0.5) * invPxPerCmX;
        let inside;
        if (isCircle) {
          const dx = xCm - circleCx;
          const dy = yCm - circleCy;
          inside = dx * dx + dy * dy <= circleRSq + 1e-9;
          if (inside && cell.isCut) {
            inside = xCm >= 0 && xCm <= widthCm && yCm >= 0 && yCm <= heightCm;
          }
        } else {
          inside = pointInPolygon(xCm, yCm, poly);
        }

        if (inside) {
          const p4 = rowOffset + px * 4;
          sumR += rgba[p4];
          sumG += rgba[p4 + 1];
          sumB += rgba[p4 + 2];
          cnt++;
        }
      }
    }

    // Respaldo si la celda es tan estrecha que ningún centro de píxel cayó dentro
    if (cnt === 0) {
      const cpx = Math.max(0, Math.min(sampleW - 1, Math.floor(circleCx * pxPerCmX)));
      const cpy = Math.max(0, Math.min(sampleH - 1, Math.floor(circleCy * pxPerCmY)));
      const p4 = (cpy * sampleW + cpx) * 4;
      sumR = rgba[p4];
      sumG = rgba[p4 + 1];
      sumB = rgba[p4 + 2];
      cnt = 1;
    }

    samples[i] = {
      ...cell,
      r: sumR / cnt,
      g: sumG / cnt,
      b: sumB / cnt,
    };
  }

  return samples;
}

function quantizeRedmeanSamples(samples, colorCount) {
  const n = samples.length;
  if (n === 0) {
    return { palette: [], assignments: new Uint8Array(0) };
  }

  const targetK = Math.max(1, Math.min(48, Math.floor(colorCount) || 10));
  const effectiveK = Math.min(targetK, n);

  let centroids;
  let rawAssignments;

  if (n > 12000) {
    const stride = Math.ceil(n / 12000);
    const subSamples = [];
    for (let i = 0; i < n; i += stride) {
      subSamples.push(samples[i]);
    }
    const km = runKMeansRedmean(subSamples, effectiveK);
    centroids = km.centroids;
    rawAssignments = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < centroids.length; k++) {
        const c = centroids[k];
        const d = colorDistSq(s.r, s.g, s.b, c[0], c[1], c[2]);
        if (d < bestDist) {
          bestDist = d;
          bestK = k;
        }
      }
      rawAssignments[i] = bestK;
    }
  } else {
    const km = runKMeansRedmean(samples, effectiveK);
    centroids = km.centroids;
    rawAssignments = km.assignments;
  }

  const counts = new Uint32Array(centroids.length);
  for (let i = 0; i < rawAssignments.length; i++) {
    counts[rawAssignments[i]]++;
  }

  const ordered = centroids
    .map((c, oldIdx) => ({
      oldIdx,
      r: Math.round(c[0]),
      g: Math.round(c[1]),
      b: Math.round(c[2]),
      count: counts[oldIdx],
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.oldIdx - b.oldIdx));

  const remap = new Uint8Array(centroids.length);
  const palette = ordered.map((item, newIdx) => {
    remap[item.oldIdx] = newIdx;
    return {
      id: newIdx + 1,
      r: item.r,
      g: item.g,
      b: item.b,
      hex: rgbToHex(item.r, item.g, item.b),
      lab: srgbToLab(item.r, item.g, item.b),
      count: item.count,
    };
  });

  const assignments = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    assignments[i] = remap[rawAssignments[i]];
  }

  return { palette, assignments };
}

/**
 * Pipeline unificado de cálculo de mosaico Fase 2 (Web Worker + callable directo en Node/tests).
 *
 * @param {{
 *   rgbaBuffer?: Uint8ClampedArray | Uint8Array | ArrayBuffer | null,
 *   sampleW?: number,
 *   sampleH?: number,
 *   config: Partial<import('/shared/contracts.js').MosaicConfig> & { paletteSteps?: number }
 * }} payload
 * @returns {{
 *   palette: Array<import('/shared/contracts.js').PaletteEntry>,
 *   gridBuffer: Uint8Array,
 *   tileCols: number,
 *   tileRows: number,
 *   maxRowCols: number,
 *   totalTiles: number,
 *   isPolygonal: boolean,
 *   gridMetrics: ReturnType<typeof computeGridMetrics>,
 *   cells: Array<import('/shared/contracts.js').CellGeometry> | null
 * }}
 */
export function computeMosaicJob(payload = {}) {
  const { rgbaBuffer = null, sampleW = 0, sampleH = 0, config = {} } = payload;
  const cfg = { ...createDefaultConfig(), ...config };
  cfg.pattern = normalizePattern(cfg.pattern);

  const isPolygonal = isPolygonalPattern(cfg.pattern);
  const gridMetrics = computeGridMetrics(cfg.widthCm, cfg.heightCm, cfg.tileSizeCm, cfg.pattern);

  // 1) Preprocesado artístico RGBA cuando corresponde en modo imagen
  let processedRgba = null;
  if (cfg.generationMode === 'image') {
    const rawView = normalizeRgbaView(rgbaBuffer, sampleW, sampleH);
    if (!rawView) {
      throw new Error('Se requiere rgbaBuffer válido cuando generationMode === "image".');
    }
    if (cfg.preprocessMode !== 'none' || cfg.removeBackground) {
      const prep = preprocessRgba(rawView, sampleW, sampleH, {
        preprocessMode: cfg.preprocessMode || 'none',
        removeBackground: Boolean(cfg.removeBackground),
      });
      processedRgba = prep.data;
    } else {
      processedRgba = rawView;
    }
  }

  // 2 & 3) Generación de celdas / muestreo según patrón clásico o poligonal
  let cells = null;
  let samples;

  if (isPolygonal) {
    cells = generatePatternCells({
      widthCm: cfg.widthCm,
      heightCm: cfg.heightCm,
      tileSizeCm: cfg.tileSizeCm,
      pattern: cfg.pattern,
    });
    samples =
      cfg.generationMode === 'image'
        ? samplePolygonalCellsFromRgba(processedRgba, sampleW, sampleH, cells, cfg.widthCm, cfg.heightCm)
        : cells;
  } else {
    samples =
      cfg.generationMode === 'image'
        ? sampleClassicCellsFromRgba(processedRgba, sampleW, sampleH, gridMetrics)
        : buildClassicSamplesNoImage(gridMetrics);
  }

  // 4, 5, 6) Asignación cromática según generationMode
  let rawPalette = [];
  let sampleAssignments;

  if (cfg.generationMode === 'mixture') {
    const mixRes = generateMixtureAssignments(samples, cfg.mixtureStops, {
      seed: cfg.seed,
    });
    rawPalette = mixRes.palette;
    sampleAssignments = mixRes.grid;
  } else if (cfg.generationMode === 'gradient') {
    const gradOpts = {
      angleDeg: cfg.gradientAngleDeg,
      widthCm: cfg.widthCm,
      heightCm: cfg.heightCm,
      ditherStrength: cfg.ditherStrength,
      seed: cfg.seed,
    };
    if (cfg.ditherMode && cfg.ditherMode !== 'none') {
      gradOpts.ditherMode = cfg.ditherMode;
    }
    if (Number.isInteger(cfg.paletteSteps) && cfg.paletteSteps > 0) {
      gradOpts.paletteSteps = cfg.paletteSteps;
    }
    const gradRes = generateGradientAssignments(samples, cfg.gradientStops, gradOpts);
    rawPalette = gradRes.palette;
    sampleAssignments = gradRes.grid;
  } else {
    // generationMode === 'image'
    const effectiveK = Math.max(1, Math.min(48, Math.floor(cfg.colorCount) || 10, samples.length));
    if (cfg.colorSpace === 'redmean') {
      const redmeanRes = quantizeRedmeanSamples(samples, effectiveK);
      if (cfg.ditherMode && cfg.ditherMode !== 'none' && cfg.ditherStrength > 0) {
        const dithered = quantizeWithDithering(samples, redmeanRes.palette, {
          ditherMode: cfg.ditherMode,
          ditherStrength: cfg.ditherStrength,
          seed: cfg.seed,
        });
        rawPalette = dithered.palette;
        sampleAssignments = dithered.assignments;
      } else {
        rawPalette = redmeanRes.palette;
        sampleAssignments = redmeanRes.assignments;
      }
    } else {
      // 'cielab' (por defecto Fase 2)
      const labKm = runKMeansLab(samples, effectiveK, { seed: cfg.seed });
      const dithered = quantizeWithDithering(samples, labKm.palette, {
        ditherMode: cfg.ditherMode || 'none',
        ditherStrength: cfg.ditherStrength,
        seed: cfg.seed,
      });
      rawPalette = dithered.palette;
      sampleAssignments = dithered.assignments;
    }
  }

  // 7) Construir gridBuffer indexado según formato clásico vs poligonal y verificar conteos exactos
  let gridBuffer;
  if (isPolygonal) {
    gridBuffer = new Uint8Array(sampleAssignments);
  } else {
    gridBuffer = new Uint8Array(gridMetrics.tileRows * gridMetrics.maxRowCols);
    gridBuffer.fill(UNUSED_CELL);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      gridBuffer[s.row * gridMetrics.maxRowCols + s.col] = sampleAssignments[i];
    }
  }

  const { palette, totalTiles } = recountPalette(gridBuffer, rawPalette);

  return {
    palette,
    gridBuffer,
    tileCols: gridMetrics.tileCols,
    tileRows: gridMetrics.tileRows,
    maxRowCols: gridMetrics.maxRowCols,
    totalTiles,
    isPolygonal,
    gridMetrics,
    cells,
  };
}

// Registro automático como Web Worker (type: 'module') sin afectar imports en Node o main thread
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (event) => {
    const { jobId, rgbaBuffer, sampleW, sampleH, config } = event.data || {};
    try {
      const result = computeMosaicJob({ rgbaBuffer, sampleW, sampleH, config });
      const transferables =
        result.gridBuffer && result.gridBuffer.buffer instanceof ArrayBuffer
          ? [result.gridBuffer.buffer]
          : [];
      self.postMessage(
        {
          ok: true,
          jobId,
          result,
        },
        transferables
      );
    } catch (err) {
      self.postMessage({
        ok: false,
        jobId,
        error: err?.message || 'Error calculando el mosaico en Web Worker.',
      });
    }
  };
}
