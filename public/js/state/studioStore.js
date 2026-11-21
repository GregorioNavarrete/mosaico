import {
  PAPER_FORMATS,
  createDefaultConfig,
  validateMosaicConfig,
} from '/shared/contracts.js';
import {
  computePrintGrid,
  listPrintSheets,
  getPaperDimensionsCm,
  parseSheetRangeExpression,
} from '/shared/printGrid.js';
import {
  UNUSED_CELL,
  rgbToHex,
  colorDistSq,
  computeGridMetrics,
  cmToTileCoords,
  floodFillGrid,
  replaceGlobalColor,
  recountPalette,
  encodeGridRle,
  decodeGridRle,
  runKMeansRedmean,
} from '/shared/mosaicCore.js';
import {
  generatePatternCells,
  buildSpatialCellIndex,
  findCellAtCm,
  floodFillCells,
} from '/shared/patterns.js';

export const MAX_HISTORY_STEPS = 40;
export const PROTECTED_REBUILD_KEYS = Object.freeze([
  'tileSizeCm',
  'pattern',
  'colorCount',
  'widthCm',
  'heightCm',
  'preprocessMode',
  'removeBackground',
  'colorSpace',
  'ditherMode',
  'ditherStrength',
  'generationMode',
]);

function normalizePatternName(pattern) {
  if (pattern === 'brick') return 'brick_50';
  return pattern || 'grid';
}

function isPolygonalPattern(pattern) {
  const p = normalizePatternName(pattern);
  return p !== 'grid' && p !== 'brick_50';
}

function buildCellsKey(config) {
  return `${config.widthCm}|${config.heightCm}|${config.tileSizeCm}|${normalizePatternName(config.pattern)}`;
}

/**
 * Cuantiza las muestras promedio por celda mediante K-Means++ Redmean y construye
 * la paleta ordenada por frecuencia y la grilla Uint8Array indexada.
 *
 * @param {Array<{ r: number, g: number, b: number, row: number, col: number }>} cellColors
 * @param {number} colorCount
 * @param {ReturnType<typeof computeGridMetrics>} gridMetrics
 */
export function quantizeCellsToMosaic(cellColors, colorCount, gridMetrics) {
  if (!gridMetrics) {
    throw new Error('gridMetrics es obligatorio para quantizeCellsToMosaic.');
  }
  const totalCells = Array.isArray(cellColors) ? cellColors.length : 0;
  const grid = new Uint8Array(gridMetrics.tileRows * gridMetrics.maxRowCols);
  grid.fill(UNUSED_CELL);

  if (totalCells === 0) {
    return {
      palette: [],
      grid,
      tileCols: gridMetrics.tileCols,
      tileRows: gridMetrics.tileRows,
      maxRowCols: gridMetrics.maxRowCols,
      totalTiles: 0,
      gridMetrics,
    };
  }

  const targetK = Math.max(2, Math.min(48, Math.floor(colorCount) || 10));
  const effectiveK = Math.min(targetK, totalCells);

  let centroids;
  let assignments;

  // Para murales extremos (> 12 000 teselas) submuestreamos de manera determinista para encontrar centroides rápido
  if (totalCells > 12000) {
    const stride = Math.ceil(totalCells / 12000);
    const subSamples = [];
    for (let i = 0; i < totalCells; i += stride) {
      subSamples.push(cellColors[i]);
    }
    const km = runKMeansRedmean(subSamples, effectiveK);
    centroids = km.centroids;
    assignments = new Uint8Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      const c = cellColors[i];
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < centroids.length; k++) {
        const cent = centroids[k];
        const d = colorDistSq(c.r, c.g, c.b, cent[0], cent[1], cent[2]);
        if (d < bestDist) {
          bestDist = d;
          bestK = k;
        }
      }
      assignments[i] = bestK;
    }
  } else {
    const km = runKMeansRedmean(cellColors, effectiveK);
    centroids = km.centroids;
    assignments = km.assignments;
  }

  const counts = new Uint32Array(centroids.length);
  for (let i = 0; i < assignments.length; i++) {
    counts[assignments[i]]++;
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
  ordered.forEach((item, newIdx) => {
    remap[item.oldIdx] = newIdx;
  });

  const palette = ordered.map((item) => ({
    r: item.r,
    g: item.g,
    b: item.b,
    hex: rgbToHex(item.r, item.g, item.b),
    count: item.count,
  }));

  for (let i = 0; i < totalCells; i++) {
    const cell = cellColors[i];
    grid[cell.row * gridMetrics.maxRowCols + cell.col] = remap[assignments[i]];
  }

  return {
    palette,
    grid,
    tileCols: gridMetrics.tileCols,
    tileRows: gridMetrics.tileRows,
    maxRowCols: gridMetrics.maxRowCols,
    totalTiles: totalCells,
    gridMetrics,
  };
}

/**
 * Crea el store central de estado del Estudio GuíaMosaico (Fase 1 + Fase 2).
 */
export function createStudioStore(initialConfig = {}) {
  const defaultCfg = { ...createDefaultConfig(), ...initialConfig };

  const state = {
    // Proyecto
    projectId: null,
    projectName: 'Mural Mediterráneo',
    projectsList: [],

    // Imagen fuente
    sourceImage: null,
    sourceImageId: null,
    sourceName: 'ejemplo_paisaje_mosaico.png',
    aspectRatio: 4 / 3,
    keepRatio: true,

    // Configuración física y de mosaico
    config: defaultCfg,

    // Datos calculados del mosaico
    tileCols: 0,
    tileRows: 0,
    maxRowCols: 0,
    totalTiles: 0,
    palette: [],
    grid: null,
    gridMetrics: null,

    // Caché geométrica Fase 2 para patrones poligonales
    cells: null,
    spatialIndex: null,
    cellsKey: '',
    isPolygonal: false,
    unbuildableCount: 0,

    // Datos de grilla de impresión multipapel
    printMetrics: null,
    printSheets: [],
    printGridError: null,

    // Herramientas e historial
    tool: 'pan', // 'pan' | 'brush' | 'fill' | 'replace' | 'eyedropper'
    activeColorIdx: 0,
    undoStack: [],
    redoStack: [],
    hasPaintedInStroke: false,
    hasManualEdits: false,
    gridVersion: 0,
    lastEditedTile: null,

    // Cámara viewport & estado interactivo
    zoom: 1,
    panX: 0,
    panY: 0,
    isInteractiveDragging: false,
  };

  const listeners = new Set();

  function notify(reason = 'update') {
    for (const fn of listeners) {
      fn(state, reason);
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function refreshPrintMetrics() {
    try {
      const validation = validateMosaicConfig(state.config);
      if (!validation.valid) {
        state.printGridError = validation.errors.join(' ');
        return false;
      }
      const metrics = computePrintGrid(state.config);
      const sheets = listPrintSheets(state.config);
      state.printMetrics = metrics;
      state.printSheets = sheets;
      state.printGridError = null;
      return true;
    } catch (err) {
      state.printGridError = err.message;
      return false;
    }
  }

  function ensurePolygonalCache() {
    const { widthCm, heightCm, tileSizeCm, pattern } = state.config;
    const isPoly = isPolygonalPattern(pattern);
    state.isPolygonal = isPoly;

    if (!isPoly) {
      state.cells = null;
      state.spatialIndex = null;
      state.cellsKey = '';
      state.unbuildableCount = 0;
      return null;
    }

    if (!Number.isFinite(widthCm) || widthCm <= 0 || !Number.isFinite(heightCm) || heightCm <= 0 || !Number.isFinite(tileSizeCm) || tileSizeCm <= 0) {
      state.cells = null;
      state.spatialIndex = null;
      state.cellsKey = '';
      state.unbuildableCount = 0;
      return null;
    }

    const nextKey = buildCellsKey(state.config);
    if (state.cellsKey !== nextKey || !Array.isArray(state.cells)) {
      const cells = generatePatternCells({
        widthCm,
        heightCm,
        tileSizeCm,
        pattern: normalizePatternName(pattern),
      });
      state.cells = cells;
      state.cellsKey = nextKey;
      state.spatialIndex = buildSpatialCellIndex(cells, widthCm, heightCm);
      let unbuildable = 0;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].flags?.unbuildable) unbuildable++;
      }
      state.unbuildableCount = unbuildable;
    } else if (!state.spatialIndex) {
      state.spatialIndex = buildSpatialCellIndex(state.cells, widthCm, heightCm);
    }

    return state.cells;
  }

  function refreshGridMetrics({ skipPolygons = false } = {}) {
    const { widthCm, heightCm, tileSizeCm, pattern } = state.config;
    state.gridMetrics = computeGridMetrics(widthCm, heightCm, tileSizeCm, pattern);
    state.tileCols = state.gridMetrics.tileCols;
    state.tileRows = state.gridMetrics.tileRows;
    state.maxRowCols = state.gridMetrics.maxRowCols;
    state.isPolygonal = isPolygonalPattern(pattern);

    if (skipPolygons || !state.config.mosaicMode) {
      if (!state.isPolygonal) {
        state.cells = null;
        state.spatialIndex = null;
        state.cellsKey = '';
        state.unbuildableCount = 0;
      }
      if (!state.grid) {
        state.totalTiles = state.gridMetrics.totalTiles;
      }
      return state.gridMetrics;
    }

    const polyCells = ensurePolygonalCache();
    if (!state.grid) {
      state.totalTiles = polyCells ? polyCells.length : state.gridMetrics.totalTiles;
    }
    return state.gridMetrics;
  }

  function pushUndoSnapshot() {
    if (!state.grid) return;
    state.undoStack.push(new Uint8Array(state.grid));
    if (state.undoStack.length > MAX_HISTORY_STEPS) {
      state.undoStack.shift();
    }
    state.redoStack = [];
  }

  function setSourceImage({ image = null, imageId = null, name = 'ejemplo_paisaje_mosaico.png', aspectRatio }) {
    state.sourceImage = image;
    state.sourceImageId = imageId;
    state.sourceName = name;
    if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
      state.aspectRatio = aspectRatio;
    } else if (image && image.width && image.height) {
      state.aspectRatio = image.width / image.height;
    }
    notify('source');
  }

  function updateConfig(patch, { silent = false, deferPolygons = false } = {}) {
    state.config = { ...state.config, ...patch };
    if (
      patch &&
      patch.breakdownColorIdx !== undefined &&
      Number.isInteger(patch.breakdownColorIdx) &&
      patch.breakdownColorIdx >= 0 &&
      patch.breakdownColorIdx < state.palette.length
    ) {
      state.activeColorIdx = patch.breakdownColorIdx;
    }
    refreshPrintMetrics();
    refreshGridMetrics({ skipPolygons: deferPolygons });
    if (!silent) {
      notify('config');
    }
  }

  function setMosaicData({
    palette,
    grid,
    gridBuffer,
    tileCols,
    tileRows,
    maxRowCols,
    totalTiles,
    gridMetrics,
    cells,
  }) {
    const rawGrid = grid || gridBuffer;
    state.palette = Array.isArray(palette) ? palette.map((p) => ({ ...p })) : [];
    state.grid = rawGrid ? new Uint8Array(rawGrid) : null;

    if (Array.isArray(cells) && isPolygonalPattern(state.config.pattern)) {
      state.cells = cells;
      state.cellsKey = buildCellsKey(state.config);
      state.spatialIndex = buildSpatialCellIndex(cells, state.config.widthCm, state.config.heightCm);
      state.isPolygonal = true;
      let unbuildable = 0;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].flags?.unbuildable) unbuildable++;
      }
      state.unbuildableCount = unbuildable;
    }

    state.gridMetrics = gridMetrics || refreshGridMetrics();
    if (!Array.isArray(cells)) {
      ensurePolygonalCache();
    }

    state.tileCols = tileCols ?? state.gridMetrics.tileCols;
    state.tileRows = tileRows ?? state.gridMetrics.tileRows;
    state.maxRowCols = maxRowCols ?? state.gridMetrics.maxRowCols;
    state.totalTiles =
      totalTiles ?? (state.isPolygonal && state.cells ? state.cells.length : state.gridMetrics.totalTiles);

    if (state.activeColorIdx >= state.palette.length) {
      state.activeColorIdx = 0;
      state.config = { ...state.config, breakdownColorIdx: 0 };
    }
    state.undoStack = [];
    state.redoStack = [];
    state.hasManualEdits = false;
    state.lastEditedTile = null;
    state.gridVersion++;
    notify('mosaic');
  }

  function setTool(toolName) {
    state.tool = toolName;
    notify('tool');
  }

  function setActiveColor(idx) {
    if (idx >= 0 && idx < state.palette.length) {
      state.activeColorIdx = idx;
      state.config = { ...state.config, breakdownColorIdx: idx };
      notify('activeColor');
    }
  }

  function hitTestAtCm(xCm, yCm) {
    if (!state.config.mosaicMode || !state.grid || !state.gridMetrics) return null;

    if (isPolygonalPattern(state.config.pattern)) {
      ensurePolygonalCache();
      if (!state.spatialIndex || !state.cells) return null;
      const found = findCellAtCm(
        state.spatialIndex,
        xCm,
        yCm,
        Boolean(state.config.mirrorMode),
        state.config.widthCm
      );
      if (!found) return null;
      const idx = found.index;
      if (idx < 0 || idx >= state.grid.length || state.grid[idx] === UNUSED_CELL) return null;
      return {
        isPolygonal: true,
        idx,
        cell: found.cell,
        cellId: found.cell.id,
        row: found.cell.row ?? 0,
        col: found.cell.col ?? idx,
        colorIdx: state.grid[idx],
      };
    }

    const hit = cmToTileCoords(xCm, yCm, state.gridMetrics, state.config, state.grid);
    if (!hit) return null;
    return {
      isPolygonal: false,
      idx: hit.idx,
      row: hit.row,
      col: hit.col,
      colorIdx: state.grid[hit.idx],
    };
  }

  function beginBrushStroke() {
    state.hasPaintedInStroke = false;
  }

  function endBrushStroke() {
    state.hasPaintedInStroke = false;
  }

  function paintTileAtCm(xCm, yCm) {
    if (!state.config.mosaicMode || !state.grid || !state.gridMetrics) {
      return { changed: false, reason: 'inactive' };
    }
    const hit = hitTestAtCm(xCm, yCm);
    if (!hit) return { changed: false, reason: 'out_of_bounds' };

    const oldColorIdx = state.grid[hit.idx];
    const newColorIdx = state.activeColorIdx;
    if (oldColorIdx === newColorIdx) {
      return { changed: false, hit, reason: 'same_color' };
    }

    if (!state.hasPaintedInStroke) {
      pushUndoSnapshot();
      state.hasPaintedInStroke = true;
    }

    state.grid[hit.idx] = newColorIdx;
    if (state.palette[oldColorIdx]) {
      state.palette[oldColorIdx].count = Math.max(0, state.palette[oldColorIdx].count - 1);
    }
    if (state.palette[newColorIdx]) {
      state.palette[newColorIdx].count++;
    }

    state.hasManualEdits = true;
    state.lastEditedTile = {
      row: hit.row,
      col: hit.col,
      idx: hit.idx,
      isPolygonal: hit.isPolygonal,
      cellId: hit.cellId,
      oldColorIdx,
      newColorIdx,
    };

    notify('paint');
    return { changed: true, hit, oldColorIdx, newColorIdx };
  }

  function applyFloodFillAtCm(xCm, yCm) {
    if (!state.config.mosaicMode || !state.grid || !state.gridMetrics) {
      return { changedCount: 0, reason: 'inactive' };
    }
    const hit = hitTestAtCm(xCm, yCm);
    if (!hit) return { changedCount: 0, reason: 'out_of_bounds' };

    let nextGrid;
    let changedCount;

    if (hit.isPolygonal) {
      const res = floodFillCells(
        state.cells,
        state.grid,
        hit.cellId,
        state.activeColorIdx,
        state.spatialIndex
      );
      nextGrid = res.grid;
      changedCount = res.changedCount;
    } else {
      const res = floodFillGrid(
        state.grid,
        hit.row,
        hit.col,
        state.activeColorIdx,
        state.gridMetrics,
        state.config.pattern
      );
      nextGrid = res.grid;
      changedCount = res.changedCount;
    }

    if (changedCount === 0) {
      return { changedCount: 0, hit, reason: 'no_change' };
    }

    pushUndoSnapshot();
    state.grid = nextGrid;
    const recounted = recountPalette(state.grid, state.palette);
    state.palette = recounted.palette;
    state.totalTiles = recounted.totalTiles;
    state.hasManualEdits = true;
    state.lastEditedTile = null;
    state.gridVersion++;

    notify('fill');
    return { changedCount, hit, targetColorIdx: state.activeColorIdx };
  }

  function applyReplaceGlobalAtCm(xCm, yCm) {
    if (!state.config.mosaicMode || !state.grid || !state.gridMetrics) {
      return { changedCount: 0, reason: 'inactive' };
    }
    const hit = hitTestAtCm(xCm, yCm);
    if (!hit) return { changedCount: 0, reason: 'out_of_bounds' };

    const fromColorIdx = state.grid[hit.idx];
    const toColorIdx = state.activeColorIdx;
    const { grid: nextGrid, changedCount } = replaceGlobalColor(state.grid, fromColorIdx, toColorIdx);

    if (changedCount === 0) {
      return { changedCount: 0, hit, fromColorIdx, toColorIdx, reason: 'same_color' };
    }

    pushUndoSnapshot();
    state.grid = nextGrid;
    const recounted = recountPalette(state.grid, state.palette);
    state.palette = recounted.palette;
    state.totalTiles = recounted.totalTiles;
    state.hasManualEdits = true;
    state.lastEditedTile = null;
    state.gridVersion++;

    notify('replace');
    return { changedCount, hit, fromColorIdx, toColorIdx };
  }

  function pickColorAtCm(xCm, yCm) {
    if (!state.config.mosaicMode || !state.grid || !state.gridMetrics) {
      return null;
    }
    const hit = hitTestAtCm(xCm, yCm);
    if (!hit) return null;

    const pickedIdx = state.grid[hit.idx];
    if (pickedIdx === UNUSED_CELL || pickedIdx >= state.palette.length) return null;

    state.activeColorIdx = pickedIdx;
    state.config = { ...state.config, breakdownColorIdx: pickedIdx };
    notify('eyedropper');
    return { pickedIdx, color: state.palette[pickedIdx], hit };
  }

  function undo() {
    if (state.undoStack.length === 0 || !state.grid) return false;
    state.redoStack.push(new Uint8Array(state.grid));
    if (state.redoStack.length > MAX_HISTORY_STEPS) {
      state.redoStack.shift();
    }
    state.grid = state.undoStack.pop();
    const recounted = recountPalette(state.grid, state.palette);
    state.palette = recounted.palette;
    state.totalTiles = recounted.totalTiles;
    state.lastEditedTile = null;
    state.gridVersion++;
    notify('undo');
    return true;
  }

  function redo() {
    if (state.redoStack.length === 0 || !state.grid) return false;
    state.undoStack.push(new Uint8Array(state.grid));
    if (state.undoStack.length > MAX_HISTORY_STEPS) {
      state.undoStack.shift();
    }
    state.grid = state.redoStack.pop();
    const recounted = recountPalette(state.grid, state.palette);
    state.palette = recounted.palette;
    state.totalTiles = recounted.totalTiles;
    state.lastEditedTile = null;
    state.gridVersion++;
    notify('redo');
    return true;
  }

  function buildProjectPayload() {
    return {
      name: (state.projectName || '').trim() || 'Proyecto sin título',
      sourceImageId: state.sourceImageId || null,
      sourceName: state.sourceName || 'ejemplo_paisaje_mosaico.png',
      aspectRatio: state.aspectRatio,
      keepRatio: Boolean(state.keepRatio),
      config: { ...state.config },
      palette: state.palette.map((p) => ({
        r: p.r,
        g: p.g,
        b: p.b,
        hex: p.hex,
        count: p.count,
      })),
      gridRle: state.grid ? encodeGridRle(state.grid) : [],
      tileCols: state.tileCols,
      tileRows: state.tileRows,
      maxRowCols: state.maxRowCols,
      totalTiles: state.totalTiles,
    };
  }

  function buildPdfExportPayload(exportOptions = {}) {
    const defaults = createDefaultConfig();
    const cfg = {
      ...state.config,
      posterFilterMode: state.config.posterFilterMode ?? defaults.posterFilterMode,
      posterContrast: Number.isFinite(Number(state.config.posterContrast))
        ? Number(state.config.posterContrast)
        : defaults.posterContrast,
      posterBrightness: Number.isFinite(Number(state.config.posterBrightness))
        ? Number(state.config.posterBrightness)
        : defaults.posterBrightness,
      posterThreshold: Number.isFinite(Number(state.config.posterThreshold))
        ? Number(state.config.posterThreshold)
        : defaults.posterThreshold,
      posterInvert: Boolean(state.config.posterInvert),
    };
    const splitMode = exportOptions?.splitMode || 'single';
    const allowLargePoster = Boolean(
      exportOptions?.allowLargePoster || !cfg.mosaicMode || splitMode !== 'single'
    );

    return {
      sourceImageId: state.sourceImageId || undefined,
      sourceName: state.sourceName || 'ejemplo_paisaje_mosaico.png',
      config: cfg,
      palette: state.palette.map((p) => ({
        r: p.r,
        g: p.g,
        b: p.b,
        hex: p.hex,
        count: p.count,
      })),
      grid: state.grid ? { rle: encodeGridRle(state.grid) } : undefined,
      tileCols: state.tileCols,
      tileRows: state.tileRows,
      maxRowCols: state.maxRowCols,
      totalTiles: state.totalTiles,
      exportOptions: {
        ...exportOptions,
        allowLargePoster,
      },
    };
  }

  function applyLoadedProject(project, snapshot = null) {
    const mergedCfg = { ...createDefaultConfig(), ...(project.config || {}) };
    state.projectId = project.id || null;
    state.projectName = project.name || 'Proyecto cargado';
    state.sourceImageId = project.sourceImageId ?? null;
    state.sourceName = project.sourceName || 'ejemplo_paisaje_mosaico.png';
    state.aspectRatio = Number.isFinite(project.aspectRatio) && project.aspectRatio > 0 ? project.aspectRatio : 4 / 3;
    state.keepRatio = project.keepRatio !== false;
    state.config = mergedCfg;

    refreshPrintMetrics();
    const metrics = refreshGridMetrics();
    const expectedLen =
      state.isPolygonal && state.cells
        ? state.cells.length
        : metrics.tileRows * metrics.maxRowCols;

    let decodedGrid = null;
    if (snapshot && Array.isArray(snapshot.gridRle) && snapshot.gridRle.length > 0) {
      decodedGrid = decodeGridRle(snapshot.gridRle, expectedLen);
    }

    const rawPalette = Array.isArray(snapshot?.palette) ? snapshot.palette : [];
    const { palette, totalTiles } = decodedGrid
      ? recountPalette(decodedGrid, rawPalette)
      : {
          palette: rawPalette,
          totalTiles: state.isPolygonal && state.cells ? state.cells.length : metrics.totalTiles,
        };

    state.grid = decodedGrid;
    state.palette = palette.map((p) => ({ ...p }));
    state.totalTiles = totalTiles;
    state.activeColorIdx = Math.min(
      Math.max(0, Number.isInteger(mergedCfg.breakdownColorIdx) ? mergedCfg.breakdownColorIdx : 0),
      Math.max(0, state.palette.length - 1)
    );
    state.undoStack = [];
    state.redoStack = [];
    state.hasManualEdits = false;
    state.lastEditedTile = null;
    state.gridVersion++;
    notify('projectLoaded');
  }

  function resetToNewProject() {
    state.projectId = null;
    state.projectName = 'Mural Mediterráneo';
    state.sourceImageId = null;
    state.sourceName = 'ejemplo_paisaje_mosaico.png';
    state.aspectRatio = 4 / 3;
    state.keepRatio = true;
    state.config = createDefaultConfig();
    state.cells = null;
    state.spatialIndex = null;
    state.cellsKey = '';
    state.isPolygonal = false;
    state.unbuildableCount = 0;
    state.activeColorIdx = 0;
    state.undoStack = [];
    state.redoStack = [];
    state.hasManualEdits = false;
    state.lastEditedTile = null;
    state.gridVersion++;
    refreshPrintMetrics();
    refreshGridMetrics();
    notify('newProject');
  }

  function getPaperOrientationDims() {
    const { paperFormat, customPaperWidthCm, customPaperHeightCm } = state.config;
    const p = getPaperDimensionsCm(paperFormat, 'portrait', customPaperWidthCm, customPaperHeightCm);
    const l = getPaperDimensionsCm(paperFormat, 'landscape', customPaperWidthCm, customPaperHeightCm);
    return {
      portrait: `${Number(p.pageW.toFixed(1))}×${Number(p.pageH.toFixed(1))}`,
      landscape: `${Number(l.pageW.toFixed(1))}×${Number(l.pageH.toFixed(1))}`,
      formatLabel: PAPER_FORMATS[paperFormat]?.id || paperFormat,
    };
  }

  // Inicializar métricas base al crear el store
  refreshPrintMetrics();
  refreshGridMetrics();

  return {
    getState: () => state,
    subscribe,
    notify,
    refreshPrintMetrics,
    refreshGridMetrics,
    ensurePolygonalCache,
    hitTestAtCm,
    setSourceImage,
    updateConfig,
    setMosaicData,
    setTool,
    setActiveColor,
    beginBrushStroke,
    endBrushStroke,
    paintTileAtCm,
    paintAtCm: paintTileAtCm,
    applyFloodFillAtCm,
    floodFillAtCm: applyFloodFillAtCm,
    applyReplaceGlobalAtCm,
    replaceGlobalAtCm: applyReplaceGlobalAtCm,
    pickColorAtCm,
    undo,
    redo,
    buildProjectPayload,
    buildPdfExportPayload,
    applyLoadedProject,
    resetToNewProject,
    getPaperOrientationDims,
    parseSheetRangeExpression,
  };
}
