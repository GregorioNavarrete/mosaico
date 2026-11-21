import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import {
  PT_PER_CM,
  MAX_PDF_PAGES_PHASE1,
  MAX_PDF_PAGES_POSTER,
  PDF_SPLIT_MODES,
  POSTER_FILTER_MODES,
  PAPER_FORMATS,
  createDefaultConfig,
  validateMosaicConfig,
} from '../shared/contracts.js';
import { applyPosterReferenceRgba } from '../shared/preprocess.js';
import {
  cmToPt,
  getRowLabel,
  computePrintGrid,
  listPrintSheets,
  parseSheetRangeExpression,
} from '../shared/printGrid.js';
import {
  UNUSED_CELL,
  rgbToHex,
  hexToRgb,
  getLuminance,
  computeGridMetrics,
  getTileRectCm,
  decodeGridRle,
  recountPalette,
  getBuiltInSampleSvg,
} from '../shared/mosaicCore.js';
import {
  clipPolygonToRect,
  insetPolygon,
  mirrorPolygonCm,
  polygonAreaAndPerimeter,
  polygonCentroid,
  generatePatternCells,
} from '../shared/patterns.js';

const NUMBER_FORMATTER = new Intl.NumberFormat('es-AR');

/**
 * Convierte un color hex (#RRGGBB) o { r, g, b } a color `rgb()` de pdf-lib.
 * @param {string | { r: number, g: number, b: number }} color
 */
function toPdfRgb(color) {
  if (typeof color === 'string') {
    const { r, g, b } = hexToRgb(color);
    return rgb(r / 255, g / 255, b / 255);
  }
  return rgb(
    Math.max(0, Math.min(255, color.r)) / 255,
    Math.max(0, Math.min(255, color.g)) / 255,
    Math.max(0, Math.min(255, color.b)) / 255
  );
}

/**
 * Normaliza un texto para fuentes WinAnsi estándar (Helvetica/Courier en pdf-lib)
 * reemplazando caracteres fuera de WinAnsi como flechas o puntos medios problemáticos si hiciera falta.
 * @param {string} text
 * @returns {string}
 */
function safePdfText(text) {
  return String(text ?? '')
    .replaceAll('⇄', '<->')
    .replaceAll('×', 'x')
    .replaceAll('·', '|')
    .replace(/[^\x20-\xFF]/g, ' ');
}

function formatInt(n) {
  return NUMBER_FORMATTER.format(Math.round(n || 0));
}

/**
 * Normaliza la grilla de entrada (Uint8Array | number[] | { rle: number[] } | null).
 */
function resolveNormalizedGrid(rawGrid, expectedLen) {
  if (!rawGrid) return null;
  if (rawGrid instanceof Uint8Array) return rawGrid;
  if (Array.isArray(rawGrid)) return Uint8Array.from(rawGrid);
  if (typeof rawGrid === 'object' && Array.isArray(rawGrid.rle)) {
    return decodeGridRle(rawGrid.rle, expectedLen);
  }
  return null;
}

/**
 * Normaliza la paleta asegurando campos r, g, b, hex, count.
 */
function normalizePalette(rawPalette = []) {
  return rawPalette.map((entry) => {
    let r = entry.r;
    let g = entry.g;
    let b = entry.b;
    if ((!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) && Array.isArray(entry.rgb)) {
      [r, g, b] = entry.rgb;
    }
    if ((!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) && entry.hex) {
      const parsed = hexToRgb(entry.hex);
      r = parsed.r;
      g = parsed.g;
      b = parsed.b;
    }
    r = Number.isFinite(r) ? Math.round(r) : 0;
    g = Number.isFinite(g) ? Math.round(g) : 0;
    b = Number.isFinite(b) ? Math.round(b) : 0;
    const hex = entry.hex ? entry.hex.toUpperCase() : rgbToHex(r, g, b);
    return {
      ...entry,
      r,
      g,
      b,
      hex,
      count: Number.isFinite(entry.count) ? entry.count : 0,
    };
  });
}

/**
 * Filtra las hojas a incluir según `exportOptions.selectedSheets` y `exportOptions.rangeExpression`.
 */
function selectTargetSheets(allSheets, gridMetrics, exportOptions = {}) {
  const { selectedSheets, rangeExpression } = exportOptions;
  const hasSelectedArray = Array.isArray(selectedSheets) && selectedSheets.length > 0;
  const hasRangeExpr = typeof rangeExpression === 'string' && rangeExpression.trim().length > 0;

  if (!hasSelectedArray && !hasRangeExpr) {
    return allSheets;
  }

  const wantedLabels = new Set();
  if (hasSelectedArray) {
    for (const lbl of selectedSheets) {
      if (typeof lbl === 'string' && lbl.trim()) {
        wantedLabels.add(lbl.trim().toUpperCase());
      }
    }
  }
  if (hasRangeExpr) {
    const parsedLabels = parseSheetRangeExpression(rangeExpression, gridMetrics.Nx, gridMetrics.Ny);
    for (const lbl of parsedLabels) {
      wantedLabels.add(lbl.toUpperCase());
    }
  }

  const filtered = allSheets.filter((sheet) => wantedLabels.has(sheet.label.toUpperCase()));
  if (filtered.length === 0) {
    throw new Error('Ninguna hoja válida coincide con la selección o rango especificado.');
  }
  return filtered;
}

/**
 * Resuelve el buffer binario de la imagen base (o el SVG de muestra integrado).
 */
async function resolveSourceImageBuffer(sourceImageId, resolveImageBufferFn) {
  if (sourceImageId && typeof resolveImageBufferFn === 'function') {
    const resolved = await resolveImageBufferFn(sourceImageId);
    if (resolved && Buffer.isBuffer(resolved)) return resolved;
    if (resolved instanceof Uint8Array) return Buffer.from(resolved);
  }
  return Buffer.from(getBuiltInSampleSvg(), 'utf8');
}

const MAX_RASTER_PIXELS = 36_000_000;

function resolveEffectivePosterFilter(config) {
  const requested = POSTER_FILTER_MODES.includes(config.posterFilterMode) ? config.posterFilterMode : 'color';
  if (requested !== 'color') return requested;
  if (config.viewMode === 'contour') return 'line_art';
  if (config.viewMode === 'grayscale') return 'grayscale';
  return 'color';
}

/**
 * Prepara la imagen base rasterizada con `sharp` aplicando mirrorMode y filtros de póster
 * (color, grayscale, contrast_bw, line_art), redimensionada exactamente al tamaño en píxeles
 * correspondiente a 300 DPI (limitado a `MAX_RASTER_PIXELS` para pósters gigantes sin desbordar RAM).
 */
async function prepareRasterBaseImage(sourceBuffer, widthCm, heightCm, config, pxPerCm) {
  let targetW = Math.max(1, Math.round(widthCm * pxPerCm));
  let targetH = Math.max(1, Math.round(heightCm * pxPerCm));
  const totalPixels = targetW * targetH;

  if (totalPixels > MAX_RASTER_PIXELS) {
    const scale = Math.sqrt(MAX_RASTER_PIXELS / totalPixels);
    targetW = Math.max(1, Math.floor(targetW * scale));
    targetH = Math.max(1, Math.floor(targetH * scale));
  }

  // Usar densidad moderada para SVG cuando la salida se escala por encima de ~4000 px para evitar picos de RAM
  const isSvgInput =
    Buffer.isBuffer(sourceBuffer) &&
    sourceBuffer.subarray(0, 256).toString('utf8').toLowerCase().includes('<svg');
  const sharpInputOpts = isSvgInput
    ? { density: totalPixels > MAX_RASTER_PIXELS ? 150 : 300, limitInputPixels: false }
    : { limitInputPixels: false };

  let pipeline = sharp(sourceBuffer, sharpInputOpts).resize(targetW, targetH, {
    fit: 'fill',
    kernel: sharp.kernel.lanczos3,
  });

  if (config.mirrorMode) {
    pipeline = pipeline.flop();
  }

  const effectiveFilter = resolveEffectivePosterFilter(config);
  const posterContrast = Number.isFinite(Number(config.posterContrast)) ? Number(config.posterContrast) : 1.0;
  const posterBrightness = Number.isFinite(Number(config.posterBrightness)) ? Number(config.posterBrightness) : 0;
  const posterThreshold = Number.isFinite(Number(config.posterThreshold)) ? Number(config.posterThreshold) : 128;
  const posterInvert = Boolean(config.posterInvert);

  const needsPixelFilter =
    effectiveFilter !== 'color' ||
    posterContrast !== 1 ||
    posterBrightness !== 0 ||
    posterInvert;

  if (needsPixelFilter) {
    const { data, info } = await pipeline
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const filtered = applyPosterReferenceRgba(data, info.width, info.height, {
      filterMode: effectiveFilter,
      contrast: posterContrast,
      brightness: posterBrightness,
      threshold: posterThreshold,
      invert: posterInvert,
    });

    const rawRgb = await sharp(filtered, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      rawBuffer: rawRgb.data,
      channels: rawRgb.info.channels,
      widthPx: rawRgb.info.width,
      heightPx: rawRgb.info.height,
    };
  }

  // Asegurar fondo blanco si la imagen tiene canal alfa (ej. PNG transparente o SVG) y almacenar raw RGB para recorte veloz
  const rawRgb = await pipeline
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    rawBuffer: rawRgb.data,
    channels: rawRgb.info.channels,
    widthPx: rawRgb.info.width,
    heightPx: rawRgb.info.height,
  };
}

function isLegacyRectPattern(pattern) {
  return !pattern || pattern === 'grid' || pattern === 'brick_50' || pattern === 'brick';
}

function clipPolygonToWindow(poly, winX0, winY0, winW, winH) {
  const shifted = poly.map(([x, y]) => [x - winX0, y - winY0]);
  const clippedLocal = clipPolygonToRect(shifted, winW, winH);
  return clippedLocal.map(([x, y]) => [x + winX0, y + winY0]);
}

function buildSvgPathFromPolygon(poly, originXCm, originYCm, ptPerCm) {
  if (!Array.isArray(poly) || poly.length < 3) return '';
  let d = '';
  for (let i = 0; i < poly.length; i++) {
    const px = ((poly[i][0] - originXCm) * ptPerCm).toFixed(3);
    // drawSvgPath invierte Y respecto a su origen (scale(1, -1)), por eso dy positivo baja en coordenadas del mural
    const py = ((poly[i][1] - originYCm) * ptPerCm).toFixed(3);
    d += i === 0 ? `M ${px} ${py}` : ` L ${px} ${py}`;
  }
  return d + ' Z';
}

function computeTileDisplayStyle(colObj, colorIdx, config, cContourStroke) {
  const lum = getLuminance(colObj.r, colObj.g, colObj.b);
  const isBreakdown = config.viewMode === 'breakdown';
  const breakdownIdx = Number.isInteger(config.breakdownColorIdx) ? config.breakdownColorIdx : 0;
  const isHighlighted = !isBreakdown || colorIdx === breakdownIdx;

  if (config.viewMode === 'contour') {
    return {
      fillColor: rgb(1, 1, 1),
      borderColor: cContourStroke,
      borderWidth: undefined, // se calcula según escala
      opacity: 1,
      lum,
      isDimmed: false,
    };
  }

  if (config.viewMode === 'grayscale') {
    const gVal = Math.round(lum) / 255;
    return {
      fillColor: rgb(gVal, gVal, gVal),
      borderColor: undefined,
      borderWidth: 0,
      opacity: 1,
      lum,
      isDimmed: false,
    };
  }

  if (isBreakdown && !isHighlighted) {
    // Atenuar colores no seleccionados hacia gris claro neutro para destacar la capa activa
    const muted = (Math.round(lum) * 0.25 + 225 * 0.75) / 255;
    return {
      fillColor: rgb(muted, muted, muted),
      borderColor: rgb(0.82, 0.82, 0.8),
      borderWidth: 0.35,
      opacity: 0.35,
      lum: 210,
      isDimmed: true,
    };
  }

  return {
    fillColor: rgb(colObj.r / 255, colObj.g / 255, colObj.b / 255),
    borderColor: isBreakdown ? cContourStroke : undefined,
    borderWidth: isBreakdown ? 0.65 : 0,
    opacity: 1,
    lum,
    isDimmed: false,
  };
}

/**
 * Dibuja teselas vectoriales sobre una región de página PDF (usado tanto en portada miniatura como en hojas 1:1).
 * Soporta tanto la grilla clásica Fase 1 (`grid`, `brick_50`) como cualquier patrón `CellGeometry[]`
 * (`brick_33`, `diamond_45`, `hexagonal`, `herringbone`, `basketweave`, `fish_scale`, `penny_round`)
 * y el modo `viewMode === 'breakdown'`.
 */
function drawVectorMosaicRegion({
  page,
  destXPt,
  destYPt, // esquina inferior izquierda del rectángulo en coordenadas PDF
  destWPt,
  destHPt,
  srcXCm,
  srcYCm,
  srcWCm,
  srcHCm,
  ptPerCm,
  config,
  gridMetrics,
  grid,
  palette,
  fontMono,
  cells = null,
  isCoverMini = false,
}) {
  const cContourStroke = rgb(36 / 255, 51 / 255, 45 / 255);
  const cDarkText = rgb(28 / 255, 38 / 255, 34 / 255);
  const cLightText = rgb(1, 253 / 255, 248 / 255);

  // Fondo de junta / papel
  const groutBgColor =
    config.viewMode === 'contour'
      ? rgb(1, 1, 1)
      : config.viewMode === 'breakdown'
      ? rgb(246 / 255, 244 / 255, 239 / 255)
      : toPdfRgb(config.groutColor || '#D6D3CB');
  page.drawRectangle({
    x: destXPt,
    y: destYPt,
    width: destWPt,
    height: destHPt,
    color: groutBgColor,
  });

  const tileSize = gridMetrics.tileSizeCm;
  const groutCm = (config.groutMm || 0) / 10;
  const halfGroutCm = groutCm * 0.5;
  const halfGroutPt = halfGroutCm * ptPerCm;
  const tilePt = tileSize * ptPerCm;
  const drawNumbers = Boolean(config.showNumbers) && !isCoverMini && tilePt >= 10;
  const contourStrokeW = Math.max(0.35, Math.min(1.5, ptPerCm * 0.035));

  // Ruta vectorial poligonal (CellGeometry) para todos los patrones Fase 2 (y celdas personalizadas)
  if (Array.isArray(cells) && cells.length > 0) {
    const winX0 = srcXCm;
    const winY0 = srcYCm;
    const winX1 = srcXCm + srcWCm;
    const winY1 = srcYCm + srcHCm;
    const regionTopYPt = destYPt + destHPt;
    const isBreakdown = config.viewMode === 'breakdown';

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const colorIdx =
        grid && i < grid.length
          ? grid[i]
          : Number.isInteger(cell.paletteId)
          ? cell.paletteId
          : UNUSED_CELL;

      if (colorIdx === undefined || colorIdx === UNUSED_CELL || colorIdx >= palette.length) {
        continue;
      }

      const rawPoly = config.mirrorMode ? mirrorPolygonCm(cell.polygonCm, config.widthCm) : cell.polygonCm;
      if (!rawPoly || rawPoly.length < 3) continue;

      // Descartar rápido fuera de ventana
      let bMinX = Infinity;
      let bMinY = Infinity;
      let bMaxX = -Infinity;
      let bMaxY = -Infinity;
      for (let v = 0; v < rawPoly.length; v++) {
        const [vx, vy] = rawPoly[v];
        if (vx < bMinX) bMinX = vx;
        if (vx > bMaxX) bMaxX = vx;
        if (vy < bMinY) bMinY = vy;
        if (vy > bMaxY) bMaxY = vy;
      }
      if (bMaxX <= winX0 + 1e-6 || bMinX >= winX1 - 1e-6 || bMaxY <= winY0 + 1e-6 || bMinY >= winY1 - 1e-6) {
        continue;
      }

      const colObj = palette[colorIdx];
      const style = computeTileDisplayStyle(colObj, colorIdx, config, cContourStroke);
      const borderWidth = config.viewMode === 'contour' ? contourStrokeW : style.borderWidth;

      // Caso especial Penny Round: círculo vectorial cuando la tesela está completa dentro de la ventana
      const isCompleteCircle =
        cell.shapeHint === 'circle' &&
        Number.isFinite(cell.radiusCm) &&
        !cell.isCut &&
        bMinX >= winX0 - 1e-5 &&
        bMaxX <= winX1 + 1e-5 &&
        bMinY >= winY0 - 1e-5 &&
        bMaxY <= winY1 + 1e-5;

      let visCentroid = null;
      let visW = 0;
      let visH = 0;

      if (isCompleteCircle) {
        const rawCenter = Array.isArray(cell.centroidCm) ? cell.centroidCm : polygonCentroid(cell.polygonCm);
        const cxCm = config.mirrorMode ? config.widthCm - rawCenter[0] : rawCenter[0];
        const cyCm = rawCenter[1];
        const drawRCm = Math.max(0.05, cell.radiusCm - halfGroutCm);
        const cxPt = destXPt + (cxCm - winX0) * ptPerCm;
        const cyPt = regionTopYPt - (cyCm - winY0) * ptPerCm;
        const rPt = Math.max(0.5, drawRCm * ptPerCm);

        page.drawCircle({
          x: cxPt,
          y: cyPt,
          size: rPt,
          color: style.fillColor,
          opacity: style.opacity,
          borderColor: style.borderColor,
          borderWidth: borderWidth || undefined,
        });

        visCentroid = [cxCm, cyCm];
        visW = drawRCm * 2;
        visH = drawRCm * 2;
      } else {
        // Aplicar junta mediante insetPolygon y recortar contra la ventana visible de la hoja
        const insetPoly = halfGroutCm > 1e-5 ? insetPolygon(rawPoly, halfGroutCm) : rawPoly;
        const visPoly = clipPolygonToWindow(insetPoly, winX0, winY0, srcWCm, srcHCm);
        if (visPoly.length < 3 || polygonAreaAndPerimeter(visPoly).areaCm2 <= 1e-6) {
          continue;
        }

        const svgPath = buildSvgPathFromPolygon(visPoly, winX0, winY0, ptPerCm);
        if (!svgPath) continue;

        page.drawSvgPath(svgPath, {
          x: destXPt,
          y: regionTopYPt,
          color: style.fillColor,
          opacity: style.opacity,
          borderColor: style.borderColor,
          borderWidth: borderWidth || undefined,
        });

        visCentroid = polygonCentroid(visPoly);
        let vMinX = Infinity;
        let vMaxX = -Infinity;
        let vMinY = Infinity;
        let vMaxY = -Infinity;
        for (let k = 0; k < visPoly.length; k++) {
          const [px, py] = visPoly[k];
          if (px < vMinX) vMinX = px;
          if (px > vMaxX) vMaxX = px;
          if (py < vMinY) vMinY = py;
          if (py > vMaxY) vMaxY = py;
        }
        visW = vMaxX - vMinX;
        visH = vMaxY - vMinY;
      }

      const wPt = visW * ptPerCm;
      const hPt = visH * ptPerCm;
      if (drawNumbers && (!isBreakdown || !style.isDimmed) && visCentroid && wPt >= 10 && hPt >= 10) {
        const labelStr = String(colorIdx + 1);
        const fontSize = Math.max(5.5, Math.min(13, Math.min(wPt, hPt) * 0.36));
        const textWidth = fontMono.widthOfTextAtSize(labelStr, fontSize);
        const textHeight = fontMono.heightAtSize(fontSize, { descender: false });
        const txPt = destXPt + (visCentroid[0] - winX0) * ptPerCm - textWidth * 0.5;
        const tyPt = regionTopYPt - (visCentroid[1] - winY0) * ptPerCm - textHeight * 0.5;

        page.drawText(labelStr, {
          x: txPt,
          y: tyPt,
          size: fontSize,
          font: fontMono,
          color: config.viewMode === 'contour' ? cDarkText : style.lum > 142 ? cDarkText : cLightText,
        });
      }
    }

    return;
  }

  // Ruta rápida rectangular clásica de Fase 1 (grid y brick_50)
  const startRow = Math.max(0, Math.floor(srcYCm / tileSize));
  const endRow = Math.min(gridMetrics.tileRows - 1, Math.ceil((srcYCm + srcHCm) / tileSize) - 1);

  for (let r = startRow; r <= endRow; r++) {
    const rowCols = gridMetrics.isBrick50 && r % 2 === 1 ? gridMetrics.tileCols + 1 : gridMetrics.tileCols;

    for (let c = 0; c < rowCols; c++) {
      const idx = r * gridMetrics.maxRowCols + c;
      const colorIdx = grid[idx];
      if (colorIdx === undefined || colorIdx === UNUSED_CELL || colorIdx >= palette.length) {
        continue;
      }

      const rect = getTileRectCm(r, c, gridMetrics, { mirrorMode: config.mirrorMode });
      if (!rect) continue;

      // Intersección con la ventana [srcXCm, srcXCm + srcWCm] x [srcYCm, srcYCm + srcHCm]
      const visX0 = Math.max(srcXCm, rect.x0Cm);
      const visX1 = Math.min(srcXCm + srcWCm, rect.x1Cm);
      const visY0 = Math.max(srcYCm, rect.y0Cm);
      const visY1 = Math.min(srcYCm + srcHCm, rect.y1Cm);

      if (visX1 <= visX0 + 1e-6 || visY1 <= visY0 + 1e-6) continue;

      const eps = 1e-6;
      const leftInsetPt =
        Math.abs(visX0 - rect.x0Cm) <= eps ? Math.min(halfGroutPt, (visX1 - visX0) * ptPerCm * 0.25) : 0;
      const rightInsetPt =
        Math.abs(visX1 - rect.x1Cm) <= eps ? Math.min(halfGroutPt, (visX1 - visX0) * ptPerCm * 0.25) : 0;
      const topInsetPt =
        Math.abs(visY0 - rect.y0Cm) <= eps ? Math.min(halfGroutPt, (visY1 - visY0) * ptPerCm * 0.25) : 0;
      const bottomInsetPt =
        Math.abs(visY1 - rect.y1Cm) <= eps ? Math.min(halfGroutPt, (visY1 - visY0) * ptPerCm * 0.25) : 0;

      const xPt = destXPt + (visX0 - srcXCm) * ptPerCm + leftInsetPt;
      const wPt = Math.max(0.25, (visX1 - visX0) * ptPerCm - leftInsetPt - rightInsetPt);

      // En PDF, Y crece hacia arriba; srcYCm=0 corresponde al borde superior (destYPt + destHPt)
      const topOffsetFromRegionTopPt = (visY0 - srcYCm) * ptPerCm + topInsetPt;
      const hPt = Math.max(0.25, (visY1 - visY0) * ptPerCm - topInsetPt - bottomInsetPt);
      const yPt = destYPt + destHPt - topOffsetFromRegionTopPt - hPt;

      const colObj = palette[colorIdx];
      const style = computeTileDisplayStyle(colObj, colorIdx, config, cContourStroke);

      page.drawRectangle({
        x: xPt,
        y: yPt,
        width: wPt,
        height: hPt,
        color: style.fillColor,
        opacity: style.opacity,
        borderColor: style.borderColor,
        borderWidth: config.viewMode === 'contour' ? contourStrokeW : style.borderWidth || undefined,
      });

      // Número centrado si la celda visible en el fragmento mide >= 10 pt
      const isBreakdown = config.viewMode === 'breakdown';
      if (drawNumbers && (!isBreakdown || !style.isDimmed) && wPt >= 10 && hPt >= 10) {
        const labelStr = String(colorIdx + 1);
        const fontSize = Math.max(5.5, Math.min(14, Math.min(wPt, hPt) * 0.42));
        const textWidth = fontMono.widthOfTextAtSize(labelStr, fontSize);
        const textHeight = fontMono.heightAtSize(fontSize, { descender: false });

        page.drawText(labelStr, {
          x: xPt + (wPt - textWidth) * 0.5,
          y: yPt + (hPt - textHeight) * 0.5,
          size: fontSize,
          font: fontMono,
          color: config.viewMode === 'contour' ? cDarkText : style.lum > 142 ? cDarkText : cLightText,
        });
      }
    }
  }
}

/**
 * Calcula las páginas requeridas para la Paleta Numerada antes de construir el documento
 * para validar contra el tope MAX_PDF_PAGES_PHASE1.
 */
function countPalettePages(paletteLength) {
  if (paletteLength <= 0) return 0;
  const a4H = PAPER_FORMATS.A4.longCm * PT_PER_CM;
  const marginPt = 1.5 * PT_PER_CM;
  const headerH = 48;
  const rowH = 38;
  const gapY = 8;
  const availH = a4H - marginPt * 2 - headerH;
  const rowsPerPage = Math.max(1, Math.floor((availH + gapY) / (rowH + gapY)));
  const cardsPerPage = rowsPerPage * 2;
  return Math.ceil(paletteLength / cardsPerPage);
}

function resolveMaxPdfPages(exportOptions = {}) {
  const splitMode = exportOptions?.splitMode || 'single';
  if (exportOptions?.allowLargePoster === true || splitMode === 'per_sheet' || splitMode === 'batches') {
    return MAX_PDF_PAGES_POSTER;
  }
  return MAX_PDF_PAGES_PHASE1;
}

/**
 * Prepara todos los insumos geométricos, cromáticos y rasterizados (si aplica) una sola vez
 * para construir uno o múltiples PDFs sin repetir el rasterizado de alta resolución.
 */
async function prepareExportContext(request, resolveImageBufferFn) {
  if (!request || typeof request !== 'object') {
    throw new Error('La solicitud de exportación PDF es obligatoria.');
  }

  const mergedConfig = { ...createDefaultConfig(), ...(request.config || {}) };
  const validation = validateMosaicConfig(mergedConfig);
  if (!validation.valid) {
    throw new Error(`Configuración de mosaico inválida: ${validation.errors.join(' ')}`);
  }

  const config = validation.config;
  const printMetrics = computePrintGrid(config);
  const allSheets = listPrintSheets(config);
  const exportOptions = request.exportOptions || {};

  const includeCover = exportOptions.includeCover !== false;
  const targetSheets = selectTargetSheets(allSheets, printMetrics, exportOptions);

  const useCellGeometry =
    (Array.isArray(request.cells) && request.cells.length > 0) || !isLegacyRectPattern(config.pattern);
  const patternCells =
    Array.isArray(request.cells) && request.cells.length > 0
      ? request.cells
      : useCellGeometry
      ? generatePatternCells(config)
      : null;

  const tileGridMetrics = computeGridMetrics(config.widthCm, config.heightCm, config.tileSizeCm, config.pattern);
  const expectedGridLen = patternCells ? patternCells.length : tileGridMetrics.tileRows * tileGridMetrics.maxRowCols;
  let normalizedGrid = resolveNormalizedGrid(request.grid, expectedGridLen);
  if (!normalizedGrid && patternCells && patternCells.some((c) => Number.isInteger(c.paletteId))) {
    normalizedGrid = Uint8Array.from(
      patternCells.map((c) => (Number.isInteger(c.paletteId) ? c.paletteId : UNUSED_CELL))
    );
  }
  const basePalette = normalizePalette(request.palette || []);
  const { palette } = normalizedGrid
    ? recountPalette(normalizedGrid, basePalette)
    : { palette: basePalette };

  const activeMosaicMode = Boolean(config.mosaicMode && normalizedGrid && palette.length > 0);
  const includePalette = exportOptions.includePalette !== false && activeMosaicMode && palette.length > 0;

  const palettePageCount = includePalette ? countPalettePages(palette.length) : 0;
  const estimatedTotalPages = (includeCover ? 1 : 0) + palettePageCount + targetSheets.length;
  const maxAllowedPages = resolveMaxPdfPages(exportOptions);

  if (estimatedTotalPages > maxAllowedPages) {
    throw new Error(
      `El documento requiere ${estimatedTotalPages} páginas y supera el límite máximo permitido (${maxAllowedPages} páginas). Selecciona un rango de hojas o usa un formato de papel mayor.`
    );
  }

  const totalTiles =
    request.totalTiles ??
    (activeMosaicMode
      ? palette.reduce((acc, p) => acc + p.count, 0)
      : patternCells
      ? patternCells.length
      : tileGridMetrics.totalTiles);

  const sourceName = request.sourceName || 'ejemplo_paisaje_mosaico.png';

  let rasterBase = null;
  let coverMiniJpg = null;

  if (!activeMosaicMode) {
    const sourceBuffer = await resolveSourceImageBuffer(request.sourceImageId, resolveImageBufferFn);
    // 300 DPI = 300 / 2.54 px/cm = 118.110236 px/cm
    const pxPerCm300Dpi = 300 / 2.54;
    rasterBase = await prepareRasterBaseImage(sourceBuffer, config.widthCm, config.heightCm, config, pxPerCm300Dpi);

    if (includeCover) {
      const miniPxPerCm = Math.min(18, 900 / Math.max(config.widthCm, config.heightCm));
      const miniW = Math.max(1, Math.round(config.widthCm * miniPxPerCm));
      const miniH = Math.max(1, Math.round(config.heightCm * miniPxPerCm));
      coverMiniJpg = await sharp(rasterBase.rawBuffer, {
        raw: {
          width: rasterBase.widthPx,
          height: rasterBase.heightPx,
          channels: rasterBase.channels,
        },
      })
        .resize(miniW, miniH, { fit: 'fill' })
        .jpeg({ quality: 88 })
        .toBuffer();
    }
  }

  return {
    config,
    printMetrics,
    allSheets,
    targetSheets,
    exportOptions,
    includeCover,
    includePalette,
    patternCells,
    tileGridMetrics,
    normalizedGrid,
    palette,
    activeMosaicMode,
    totalTiles,
    sourceName,
    rasterBase,
    coverMiniJpg,
  };
}

/**
 * Construye un único documento PDF a partir del contexto preparado y un subconjunto de hojas.
 */
async function renderPdfFromContext(ctx, sheetsForDoc, options = {}) {
  const {
    config,
    printMetrics,
    allSheets,
    patternCells,
    tileGridMetrics,
    normalizedGrid,
    palette,
    activeMosaicMode,
    totalTiles,
    sourceName,
    rasterBase,
    coverMiniJpg,
  } = ctx;

  const docIncludeCover = options.includeCover !== undefined ? options.includeCover : ctx.includeCover;
  const docIncludePalette =
    (options.includePalette !== undefined ? options.includePalette : ctx.includePalette) &&
    activeMosaicMode &&
    palette.length > 0;
  const drawMiniScaleBar = Boolean(options.drawMiniScaleBar);

  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.CourierBold);

  const cInk = rgb(36 / 255, 51 / 255, 45 / 255);
  const cMuted = rgb(105 / 255, 116 / 255, 107 / 255);
  const cForest = rgb(54 / 255, 89 / 255, 77 / 255);
  const cTerra = rgb(189 / 255, 117 / 255, 78 / 255);
  const cLine = rgb(215 / 255, 208 / 255, 195 / 255);
  const cPaper = rgb(247 / 255, 244 / 255, 237 / 255);

  const coverMiniImage = docIncludeCover && coverMiniJpg ? await pdfDoc.embedJpg(coverMiniJpg) : null;

  // -------------------------------------------------------------------------
  // 1. PORTADA A4 VERTICAL
  // -------------------------------------------------------------------------
  if (docIncludeCover) {
    const a4PortraitW = PAPER_FORMATS.A4.shortCm * PT_PER_CM;
    const a4PortraitH = PAPER_FORMATS.A4.longCm * PT_PER_CM;
    const cover = pdfDoc.addPage([a4PortraitW, a4PortraitH]);
    const marginPt = 1.5 * PT_PER_CM;
    let curY = a4PortraitH - marginPt;

    cover.drawRectangle({
      x: marginPt,
      y: curY - 46,
      width: a4PortraitW - marginPt * 2,
      height: 46,
      color: cForest,
    });
    cover.drawText('GUIAMOSAICO | GUIA DE MONTAJE A ESCALA 1:1', {
      x: marginPt + 14,
      y: curY - 22,
      size: 13,
      font: fontBold,
      color: rgb(1, 1, 1),
    });
    cover.drawText(safePdfText(`Archivo base: ${sourceName.slice(0, 48)}`), {
      x: marginPt + 14,
      y: curY - 37,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.85, 0.9, 0.87),
    });
    curY -= 64;

    cover.drawRectangle({
      x: marginPt,
      y: curY - 96,
      width: a4PortraitW - marginPt * 2,
      height: 96,
      color: cPaper,
      borderColor: cLine,
      borderWidth: 1,
    });

    const activeColorsCount = palette.filter((p) => p.count > 0).length;
    const paperDesc = `${printMetrics.paperFormat} ${
      printMetrics.orientation === 'portrait' ? 'Vertical' : 'Horizontal'
    } (${printMetrics.pageW} x ${printMetrics.pageH} cm)`;
    const effectiveFilter = resolveEffectivePosterFilter(config);

    const leftInfo = [
      `Dimensiones finales: ${config.widthCm} x ${config.heightCm} cm`,
      `Papel: ${paperDesc}`,
      `Margen: ${printMetrics.margin.toFixed(1)} cm | Solapamiento: ${printMetrics.overlap.toFixed(1)} cm`,
      `Cuadricula: ${printMetrics.Nx} cols x ${printMetrics.Ny} filas (${sheetsForDoc.length}/${printMetrics.totalPages} hojas)`,
    ];
    const rightInfo = [
      `Transferencia: ${config.mirrorMode ? 'ESPEJO (Metodo Indirecto)' : 'Directo (Normal)'}`,
      `Modo Mosaico: ${activeMosaicMode ? 'ACTIVO (Vectorial)' : 'Imagen Directa / Poster'}`,
      activeMosaicMode
        ? `Tesela: ${config.tileSizeCm.toFixed(1)} cm | Patron: ${config.pattern}${
            config.viewMode === 'breakdown' ? ` | Capa #${(config.breakdownColorIdx ?? 0) + 1}` : ''
          }`
        : `Filtro Poster: ${effectiveFilter}${config.posterInvert ? ' (Invertido)' : ''}`,
      activeMosaicMode
        ? `Total teselas: ${formatInt(totalTiles)} | Colores: ${activeColorsCount}`
        : 'Escala real 100%',
    ];

    leftInfo.forEach((line, i) => {
      cover.drawText(safePdfText(line), {
        x: marginPt + 12,
        y: curY - 22 - i * 19,
        size: 9.2,
        font: i === 0 ? fontBold : fontRegular,
        color: cInk,
      });
    });
    rightInfo.forEach((line, i) => {
      cover.drawText(safePdfText(line), {
        x: a4PortraitW / 2 + 8,
        y: curY - 22 - i * 19,
        size: 9.2,
        font: i === 0 && config.mirrorMode ? fontBold : fontRegular,
        color: i === 0 && config.mirrorMode ? cTerra : cInk,
      });
    });
    curY -= 114;

    cover.drawText(`MAPA DE MONTAJE DE HOJAS (${printMetrics.paperFormat})`, {
      x: marginPt,
      y: curY,
      size: 10,
      font: fontBold,
      color: cTerra,
    });
    curY -= 10;

    const previewBoxW = a4PortraitW - marginPt * 2;
    const previewBoxH = 340;
    const prevScalePtPerCm = Math.min(previewBoxW / config.widthCm, previewBoxH / config.heightCm);
    const prevDrawW = config.widthCm * prevScalePtPerCm;
    const prevDrawH = config.heightCm * prevScalePtPerCm;
    const prevX = marginPt + (previewBoxW - prevDrawW) / 2;
    const prevY = curY - prevDrawH;

    if (activeMosaicMode) {
      drawVectorMosaicRegion({
        page: cover,
        destXPt: prevX,
        destYPt: prevY,
        destWPt: prevDrawW,
        destHPt: prevDrawH,
        srcXCm: 0,
        srcYCm: 0,
        srcWCm: config.widthCm,
        srcHCm: config.heightCm,
        ptPerCm: prevScalePtPerCm,
        config,
        gridMetrics: tileGridMetrics,
        grid: normalizedGrid,
        palette,
        fontMono,
        cells: patternCells,
        isCoverMini: true,
      });
    } else if (coverMiniImage) {
      cover.drawImage(coverMiniImage, {
        x: prevX,
        y: prevY,
        width: prevDrawW,
        height: prevDrawH,
      });
    }

    const selectedSet = new Set(sheetsForDoc.map((s) => s.label));
    for (const sheet of allSheets) {
      const rx = prevX + sheet.srcXCm * prevScalePtPerCm;
      const ry = prevY + (config.heightCm - (sheet.srcYCm + sheet.sliceHCm)) * prevScalePtPerCm;
      const rw = sheet.sliceWCm * prevScalePtPerCm;
      const rh = sheet.sliceHCm * prevScalePtPerCm;
      const isSelected = selectedSet.has(sheet.label);

      cover.drawRectangle({
        x: rx,
        y: ry,
        width: rw,
        height: rh,
        borderColor: isSelected ? cTerra : cMuted,
        borderWidth: isSelected ? 1.1 : 0.6,
      });

      if (rw > 18 && rh > 14) {
        cover.drawRectangle({
          x: rx + 2,
          y: ry + rh - 13,
          width: Math.min(24, rw - 4),
          height: 11,
          color: isSelected ? cForest : cMuted,
        });
        cover.drawText(sheet.label, {
          x: rx + 4,
          y: ry + rh - 10.5,
          size: 7.5,
          font: fontMono,
          color: rgb(1, 1, 1),
        });
      }
    }

    const calBoxY = marginPt;
    const calBoxH = 128;
    cover.drawRectangle({
      x: marginPt,
      y: calBoxY,
      width: a4PortraitW - marginPt * 2,
      height: calBoxH,
      color: rgb(252 / 255, 245 / 255, 236 / 255),
      borderColor: cTerra,
      borderWidth: 1.5,
    });

    cover.drawText('REGLA DE CALIBRACION EXACTA: 10.0 cm (VERIFICAR ANTES DE CORTAR)', {
      x: marginPt + 14,
      y: calBoxY + calBoxH - 22,
      size: 9.5,
      font: fontBold,
      color: cTerra,
    });
    cover.drawText(
      'IMPORTANTE: Imprimir al 100% / "Tamano real". Desactivar "Ajustar a pagina" en el dialogo de impresion.',
      {
        x: marginPt + 14,
        y: calBoxY + calBoxH - 37,
        size: 8.5,
        font: fontBold,
        color: cInk,
      }
    );

    const rulerLenPt = cmToPt(10.0);
    const rulerX = marginPt + (a4PortraitW - marginPt * 2 - rulerLenPt) / 2;
    const rulerY = calBoxY + 34;

    cover.drawLine({
      start: { x: rulerX, y: rulerY },
      end: { x: rulerX + rulerLenPt, y: rulerY },
      thickness: 1.5,
      color: cInk,
    });

    for (let half = 0; half <= 20; half++) {
      const xTick = rulerX + cmToPt(half * 0.5);
      const isMajor = half % 2 === 0;
      const tickH = isMajor ? 16 : 9;
      cover.drawLine({
        start: { x: xTick, y: rulerY },
        end: { x: xTick, y: rulerY + tickH },
        thickness: isMajor ? 1.2 : 0.7,
        color: cInk,
      });
      if (isMajor) {
        const cmNum = String(half / 2);
        cover.drawText(cmNum, {
          x: xTick - (cmNum.length > 1 ? 5 : 2.5),
          y: rulerY - 12,
          size: 8.5,
          font: fontMono,
          color: cInk,
        });
      }
    }
    cover.drawText('cm', {
      x: rulerX + rulerLenPt + 8,
      y: rulerY - 3,
      size: 8.5,
      font: fontMono,
      color: cMuted,
    });
  }

  // -------------------------------------------------------------------------
  // 2. HOJA(S) DE PALETA NUMERADA AUTO-PAGINADA
  // -------------------------------------------------------------------------
  if (docIncludePalette) {
    const a4PortraitW = PAPER_FORMATS.A4.shortCm * PT_PER_CM;
    const a4PortraitH = PAPER_FORMATS.A4.longCm * PT_PER_CM;
    const marginPt = 1.5 * PT_PER_CM;
    const headerH = 48;
    const colGap = 16;
    const colW = (a4PortraitW - marginPt * 2 - colGap) / 2;
    const rowH = 38;
    const rowGap = 8;
    const availH = a4PortraitH - marginPt * 2 - headerH;
    const rowsPerPage = Math.max(1, Math.floor((availH + rowGap) / (rowH + rowGap)));
    const cardsPerPage = rowsPerPage * 2;
    const totalPalPages = Math.ceil(palette.length / cardsPerPage);

    for (let pIdx = 0; pIdx < totalPalPages; pIdx++) {
      const palPage = pdfDoc.addPage([a4PortraitW, a4PortraitH]);
      let py = a4PortraitH - marginPt;

      const pageSuffix = totalPalPages > 1 ? ` (Pag. ${pIdx + 1}/${totalPalPages})` : '';
      palPage.drawText(`PALETA NUMERADA DE COLORES Y CONTEO DE TESELAS${pageSuffix}`, {
        x: marginPt,
        y: py - 14,
        size: 12.5,
        font: fontBold,
        color: cForest,
      });
      palPage.drawText(
        safePdfText(
          `Total: ${formatInt(totalTiles)} teselas (${config.tileSizeCm.toFixed(1)} cm) | Colores: ${
            palette.length
          } | Junta: ${config.groutMm.toFixed(1)} mm (${(config.groutColor || '#D6D3CB').toUpperCase()})`
        ),
        {
          x: marginPt,
          y: py - 30,
          size: 9,
          font: fontRegular,
          color: cMuted,
        }
      );
      py -= headerH;

      const startItem = pIdx * cardsPerPage;
      const endItem = Math.min(palette.length, startItem + cardsPerPage);

      for (let i = startItem; i < endItem; i++) {
        const col = palette[i];
        const localIdx = i - startItem;
        const colIdx = localIdx % 2;
        const rowIdx = Math.floor(localIdx / 2);

        const bx = marginPt + colIdx * (colW + colGap);
        const by = py - rowIdx * (rowH + rowGap) - rowH;

        palPage.drawRectangle({
          x: bx,
          y: by,
          width: colW,
          height: rowH,
          color: cPaper,
          borderColor: cLine,
          borderWidth: 0.8,
        });

        palPage.drawRectangle({
          x: bx + 6,
          y: by + 6,
          width: 26,
          height: 26,
          color: rgb(col.r / 255, col.g / 255, col.b / 255),
          borderColor: rgb(0.2, 0.2, 0.2),
          borderWidth: 0.5,
        });

        const lum = getLuminance(col.r, col.g, col.b);
        const numText = String(i + 1);
        palPage.drawText(numText, {
          x: bx + (numText.length > 1 ? 13 : 16),
          y: by + 15,
          size: 10,
          font: fontMono,
          color: lum > 142 ? cInk : rgb(1, 1, 1),
        });

        const pct = totalTiles > 0 ? ((col.count / totalTiles) * 100).toFixed(1) : '0.0';
        palPage.drawText(safePdfText(`Color #${i + 1} | ${col.hex}`), {
          x: bx + 42,
          y: by + 22,
          size: 9.5,
          font: fontBold,
          color: cInk,
        });
        palPage.drawText(safePdfText(`${formatInt(col.count)} teselas (${pct}%)`), {
          x: bx + 42,
          y: by + 9,
          size: 8.5,
          font: fontRegular,
          color: cMuted,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. HOJAS DE FRAGMENTO 1:1 (VECTORIAL EN MOSAICO / SHARP EN DIRECTA)
  // -------------------------------------------------------------------------
  const tilePageW_pt = cmToPt(printMetrics.pageW);
  const tilePageH_pt = cmToPt(printMetrics.pageH);
  const tileMargin_pt = cmToPt(printMetrics.margin);
  const sheetsIncluded = [];

  for (const sheet of sheetsForDoc) {
    sheetsIncluded.push(sheet.label);
    const page = pdfDoc.addPage([tilePageW_pt, tilePageH_pt]);

    const drawW_pt = cmToPt(sheet.sliceWCm);
    const drawH_pt = cmToPt(sheet.sliceHCm);
    const drawX_pt = tileMargin_pt;
    const drawY_pt = tilePageH_pt - tileMargin_pt - drawH_pt;

    if (activeMosaicMode) {
      drawVectorMosaicRegion({
        page,
        destXPt: drawX_pt,
        destYPt: drawY_pt,
        destWPt: drawW_pt,
        destHPt: drawH_pt,
        srcXCm: sheet.srcXCm,
        srcYCm: sheet.srcYCm,
        srcWCm: sheet.sliceWCm,
        srcHCm: sheet.sliceHCm,
        ptPerCm: PT_PER_CM,
        config,
        gridMetrics: tileGridMetrics,
        grid: normalizedGrid,
        palette,
        fontMono,
        cells: patternCells,
        isCoverMini: false,
      });
    } else if (rasterBase) {
      const pxPerCmX = rasterBase.widthPx / config.widthCm;
      const pxPerCmY = rasterBase.heightPx / config.heightCm;

      const left = Math.max(0, Math.min(rasterBase.widthPx - 1, Math.round(sheet.srcXCm * pxPerCmX)));
      const top = Math.max(0, Math.min(rasterBase.heightPx - 1, Math.round(sheet.srcYCm * pxPerCmY)));
      const width = Math.max(1, Math.min(rasterBase.widthPx - left, Math.round(sheet.sliceWCm * pxPerCmX)));
      const height = Math.max(1, Math.min(rasterBase.heightPx - top, Math.round(sheet.sliceHCm * pxPerCmY)));

      const sliceJpg = await sharp(rasterBase.rawBuffer, {
        raw: {
          width: rasterBase.widthPx,
          height: rasterBase.heightPx,
          channels: rasterBase.channels,
        },
      })
        .extract({ left, top, width, height })
        .jpeg({ quality: 92 })
        .toBuffer();

      const embeddedSlice = await pdfDoc.embedJpg(sliceJpg);
      page.drawImage(embeddedSlice, {
        x: drawX_pt,
        y: drawY_pt,
        width: drawW_pt,
        height: drawH_pt,
      });
    }

    page.drawRectangle({
      x: drawX_pt,
      y: drawY_pt,
      width: drawW_pt,
      height: drawH_pt,
      borderColor: rgb(0.4, 0.4, 0.4),
      borderWidth: 0.5,
    });

    if (printMetrics.overlap > 0) {
      const ovPt = cmToPt(printMetrics.overlap);
      const dashOpts = { thickness: 0.8, color: cTerra, dashArray: [4, 3] };

      if (sheet.col > 0 && drawW_pt > ovPt) {
        page.drawLine({
          start: { x: drawX_pt + ovPt, y: drawY_pt },
          end: { x: drawX_pt + ovPt, y: drawY_pt + drawH_pt },
          ...dashOpts,
        });
      }
      if (sheet.col < printMetrics.Nx - 1 && drawW_pt > ovPt) {
        page.drawLine({
          start: { x: drawX_pt + drawW_pt - ovPt, y: drawY_pt },
          end: { x: drawX_pt + drawW_pt - ovPt, y: drawY_pt + drawH_pt },
          ...dashOpts,
        });
      }
      if (sheet.row > 0 && drawH_pt > ovPt) {
        page.drawLine({
          start: { x: drawX_pt, y: drawY_pt + drawH_pt - ovPt },
          end: { x: drawX_pt + drawW_pt, y: drawY_pt + drawH_pt - ovPt },
          ...dashOpts,
        });
      }
      if (sheet.row < printMetrics.Ny - 1 && drawH_pt > ovPt) {
        page.drawLine({
          start: { x: drawX_pt, y: drawY_pt + ovPt },
          end: { x: drawX_pt + drawW_pt, y: drawY_pt + ovPt },
          ...dashOpts,
        });
      }
    }

    const mk = Math.min(10, tileMargin_pt * 0.65);
    const corners = [
      [drawX_pt, drawY_pt, -1, -1],
      [drawX_pt + drawW_pt, drawY_pt, 1, -1],
      [drawX_pt, drawY_pt + drawH_pt, -1, 1],
      [drawX_pt + drawW_pt, drawY_pt + drawH_pt, 1, 1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      page.drawLine({
        start: { x: cx + dx * 2, y: cy },
        end: { x: cx + dx * (mk + 2), y: cy },
        thickness: 0.7,
        color: cInk,
      });
      page.drawLine({
        start: { x: cx, y: cy + dy * 2 },
        end: { x: cx, y: cy + dy * (mk + 2) },
        thickness: 0.7,
        color: cInk,
      });
    }

    const headerText = safePdfText(
      `Hoja ${sheet.label} (${getRowLabel(sheet.row)}-${sheet.col + 1}) | Fila ${sheet.row + 1}, Col ${
        sheet.col + 1
      } | GuiaMosaico 1:1 (${config.widthCm}x${config.heightCm} cm)${config.mirrorMode ? ' | ESPEJO' : ''}`
    );
    page.drawText(headerText, {
      x: tileMargin_pt,
      y: tilePageH_pt - Math.max(12, tileMargin_pt * 0.55),
      size: 8,
      font: fontBold,
      color: cForest,
    });

    // En exportación individual por hoja, colocar una mini regla de calibración de 5.0 cm en el margen inferior si entra
    if (drawMiniScaleBar && tileMargin_pt >= 16) {
      const bar5CmPt = cmToPt(5.0);
      if (tilePageW_pt - tileMargin_pt * 2 >= bar5CmPt + 60) {
        const barX = tilePageW_pt - tileMargin_pt - bar5CmPt;
        const barY = Math.max(5, tileMargin_pt * 0.38);
        page.drawLine({
          start: { x: barX, y: barY },
          end: { x: barX + bar5CmPt, y: barY },
          thickness: 1.0,
          color: cInk,
        });
        for (let t = 0; t <= 5; t++) {
          const tx = barX + cmToPt(t);
          page.drawLine({
            start: { x: tx, y: barY },
            end: { x: tx, y: barY + (t === 0 || t === 5 ? 5 : 3) },
            thickness: 0.7,
            color: cInk,
          });
        }
        page.drawText('5.0 cm', {
          x: barX - 32,
          y: barY - 1,
          size: 7,
          font: fontMono,
          color: cMuted,
        });
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  return {
    pdfBytes,
    pageCount: pdfDoc.getPageCount(),
    sheetsIncluded,
  };
}

/**
 * Construye un archivo ZIP estándar (cero dependencias externas) usando zlib.crc32 y zlib.deflateRawSync.
 *
 * @param {Array<{ name: string, data: Uint8Array | Buffer }>} files
 * @returns {Uint8Array}
 */
export function buildZipArchive(files = []) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Se requiere al menos un archivo para construir el archivo ZIP.');
  }

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of files) {
    const cleanName = String(entry?.name || 'archivo.bin').replace(/^\/+/, '');
    const nameBuf = Buffer.from(cleanName, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || []);
    const compressedBuf = zlib.deflateRawSync(rawBuf, { level: 6 });

    const useDeflate = compressedBuf.length < rawBuf.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? compressedBuf : rawBuf;
    const crc = zlib.crc32(rawBuf) >>> 0;

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localParts.push(localHeader, nameBuf, payload);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localParts, centralDirBuf, eocd]));
}

/**
 * Genera el PDF 1:1 vectorial/híbrido en el servidor Node.js con `pdf-lib` y `sharp`.
 *
 * @param {import('../shared/contracts.js').PdfExportRequest} request
 * @param {(sourceImageId: string) => Promise<Buffer | Uint8Array | null>} [resolveImageBufferFn]
 * @returns {Promise<{ pdfBytes: Uint8Array, filename: string, pageCount: number, sheetsIncluded: string[] }>}
 */
export async function generatePdf1to1(request, resolveImageBufferFn) {
  const ctx = await prepareExportContext(request, resolveImageBufferFn);
  const rendered = await renderPdfFromContext(ctx, ctx.targetSheets);
  const filename = `GuiaMosaico_${ctx.config.widthCm}x${ctx.config.heightCm}cm_${ctx.printMetrics.paperFormat}.pdf`;

  return {
    pdfBytes: rendered.pdfBytes,
    filename,
    pageCount: rendered.pageCount,
    sheetsIncluded: rendered.sheetsIncluded,
  };
}

/**
 * Exporta la guía 1:1 en PDF único (`'single'`), en un ZIP con un PDF por hoja (`'per_sheet'`)
 * o en un ZIP con lotes de N hojas (`'batches'`).
 *
 * @param {import('../shared/contracts.js').PdfExportRequest} request
 * @param {(sourceImageId: string) => Promise<Buffer | Uint8Array | null>} [resolveImageBufferFn]
 */
export async function generateSplitPdfExport(request, resolveImageBufferFn) {
  const splitMode = request?.exportOptions?.splitMode || 'single';
  if (!PDF_SPLIT_MODES.includes(splitMode)) {
    throw new Error(`splitMode inválido: ${splitMode}. Valores permitidos: ${PDF_SPLIT_MODES.join(', ')}.`);
  }

  if (splitMode === 'single') {
    const res = await generatePdf1to1(request, resolveImageBufferFn);
    return {
      kind: 'pdf',
      bytes: res.pdfBytes,
      filename: res.filename,
      pageCount: res.pageCount,
      pdfCount: 1,
      sheetsIncluded: res.sheetsIncluded,
    };
  }

  const sheetsPerPdf = Math.max(1, Math.min(50, Math.floor(Number(request?.exportOptions?.sheetsPerPdf) || 10)));
  const ctx = await prepareExportContext(request, resolveImageBufferFn);
  const chunkSize = splitMode === 'per_sheet' ? 1 : sheetsPerPdf;

  const chunks = [];
  for (let i = 0; i < ctx.targetSheets.length; i += chunkSize) {
    chunks.push(ctx.targetSheets.slice(i, i + chunkSize));
  }

  const zipFiles = [];
  const entrySummaries = [];
  const allIncludedSheets = [];
  let totalPages = 0;

  const basePrefix = `GuiaMosaico_${ctx.config.widthCm}x${ctx.config.heightCm}cm_${ctx.printMetrics.paperFormat}`;
  const padWidth = Math.max(2, String(chunks.length).length);

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const isFirstChunk = idx === 0;
    const rendered = await renderPdfFromContext(ctx, chunk, {
      includeCover: isFirstChunk ? ctx.includeCover : false,
      includePalette: isFirstChunk ? ctx.includePalette : false,
      drawMiniScaleBar: splitMode === 'per_sheet',
    });

    const firstLabel = chunk[0].label;
    const lastLabel = chunk[chunk.length - 1].label;
    const entryName =
      splitMode === 'per_sheet'
        ? `${basePrefix}_Hoja_${firstLabel}.pdf`
        : `${basePrefix}_Lote_${String(idx + 1).padStart(padWidth, '0')}_${firstLabel}-${lastLabel}.pdf`;

    zipFiles.push({
      name: entryName,
      data: rendered.pdfBytes,
    });
    entrySummaries.push({
      name: entryName,
      pageCount: rendered.pageCount,
      sheets: rendered.sheetsIncluded,
      byteLength: rendered.pdfBytes.byteLength,
    });
    allIncludedSheets.push(...rendered.sheetsIncluded);
    totalPages += rendered.pageCount;
  }

  const zipBytes = buildZipArchive(zipFiles);
  const zipFilename = `${basePrefix}_${splitMode === 'per_sheet' ? 'hojas' : 'lotes'}.zip`;

  return {
    kind: 'zip',
    bytes: zipBytes,
    filename: zipFilename,
    pageCount: totalPages,
    pdfCount: chunks.length,
    files: entrySummaries,
    sheetsIncluded: allIncludedSheets,
  };
}
