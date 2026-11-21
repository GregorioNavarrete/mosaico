import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCHITECTURAL_PATTERNS,
  createDefaultConfig,
  validateMosaicConfig,
} from '../shared/contracts.js';
import {
  UNUSED_CELL,
  computeGridMetrics,
  decodeGridRle,
  encodeGridRle,
  hexToRgb,
  recountPalette,
  rgbToHex,
} from '../shared/mosaicCore.js';
import { generatePatternCells } from '../shared/patterns.js';
import { JsonStore } from './jsonStore.js';
import { assertValidImageUuid, HttpError } from '../services/imageSecurityService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const PROJECTS_INDEX_FILE = path.join(ROOT_DIR, 'data/projects.json');
const PROJECTS_SNAPSHOT_DIR = path.join(ROOT_DIR, 'storage/projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_VIEW_MODES = ['color', 'grayscale', 'contour', 'breakdown'];
const MAX_SYNC_PATTERN_CELLS = 150000;

const projectsStore = new JsonStore(PROJECTS_INDEX_FILE, []);

function assertValidProjectId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id.trim())) {
    throw new HttpError(400, 'ID de proyecto inválido. Debe ser un UUID válido.', 'INVALID_PROJECT_ID');
  }
  return id.trim().toLowerCase();
}

function getSnapshotPath(validProjectId) {
  const resolved = path.resolve(PROJECTS_SNAPSHOT_DIR, `${validProjectId}.json`);
  if (!resolved.startsWith(PROJECTS_SNAPSHOT_DIR + path.sep)) {
    throw new HttpError(400, 'Ruta de snapshot fuera de storage/projects/.', 'INVALID_PROJECT_PATH');
  }
  return resolved;
}

function getSnapshotStore(validProjectId) {
  return new JsonStore(getSnapshotPath(validProjectId), null);
}

function stripUndefinedKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return clean;
}

function normalizeHexOrThrow(rawHex, fieldLabel) {
  if (typeof rawHex !== 'string') {
    throw new HttpError(400, `${fieldLabel} debe ser un color hexadecimal válido.`, 'INVALID_CONFIG');
  }
  try {
    const { r, g, b } = hexToRgb(rawHex);
    return rgbToHex(r, g, b);
  } catch {
    throw new HttpError(400, `${fieldLabel} inválido: ${rawHex}.`, 'INVALID_CONFIG');
  }
}

/**
 * Valida y normaliza una configuración completa Fase 1 + Fase 2 usando `validateMosaicConfig`
 * y conservando todos los parámetros de patrón, preprocesado, colorimetría, dithering,
 * generación algorítmica y acabado.
 *
 * @param {Record<string, any>} [rawConfig]
 * @param {Record<string, any>} [fallbackConfig]
 * @returns {import('../shared/contracts.js').MosaicConfig}
 */
export function validateAndNormalizeMosaicConfig(rawConfig, fallbackConfig) {
  if (rawConfig !== undefined && (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig))) {
    throw new HttpError(400, 'El campo config debe ser un objeto JSON válido.', 'INVALID_CONFIG');
  }

  const base = fallbackConfig
    ? { ...createDefaultConfig(), ...stripUndefinedKeys(fallbackConfig) }
    : createDefaultConfig();
  const merged = { ...base, ...stripUndefinedKeys(rawConfig) };

  const validation = validateMosaicConfig(merged);
  if (!validation.valid) {
    throw new HttpError(
      400,
      `Configuración de proyecto inválida: ${validation.errors.join(' ')}`,
      'INVALID_CONFIG'
    );
  }

  const cfg = { ...validation.config };

  if (!VALID_VIEW_MODES.includes(cfg.viewMode)) {
    throw new HttpError(400, `viewMode inválido: ${cfg.viewMode}.`, 'INVALID_CONFIG');
  }

  cfg.mirrorMode = Boolean(cfg.mirrorMode);
  cfg.showA4Grid = Boolean(cfg.showA4Grid);
  cfg.mosaicMode = Boolean(cfg.mosaicMode);
  cfg.showNumbers = Boolean(cfg.showNumbers);
  cfg.removeBackground = Boolean(cfg.removeBackground);

  if (!Number.isInteger(cfg.breakdownColorIdx) || cfg.breakdownColorIdx < 0) {
    throw new HttpError(400, 'breakdownColorIdx debe ser un entero mayor o igual a 0.', 'INVALID_CONFIG');
  }

  if (!Number.isFinite(cfg.gradientAngleDeg)) {
    throw new HttpError(400, 'gradientAngleDeg debe ser un número finito.', 'INVALID_CONFIG');
  }

  if (!Number.isFinite(cfg.tileThicknessMm) || cfg.tileThicknessMm <= 0 || cfg.tileThicknessMm > 50) {
    throw new HttpError(400, 'tileThicknessMm debe estar entre 0 y 50 mm.', 'INVALID_CONFIG');
  }

  cfg.groutColor = normalizeHexOrThrow(cfg.groutColor, 'groutColor');

  if (!Array.isArray(cfg.mixtureStops)) {
    throw new HttpError(400, 'mixtureStops debe ser un arreglo.', 'INVALID_CONFIG');
  }
  if (cfg.generationMode === 'mixture' && cfg.mixtureStops.length === 0) {
    throw new HttpError(400, 'mixtureStops no puede estar vacío en modo mixture.', 'INVALID_CONFIG');
  }
  cfg.mixtureStops = cfg.mixtureStops.map((stop, idx) => {
    if (!stop || typeof stop !== 'object' || Array.isArray(stop)) {
      throw new HttpError(400, `mixtureStops[${idx}] inválido.`, 'INVALID_CONFIG');
    }
    const percent = Number(stop.percent);
    if (!Number.isFinite(percent) || percent < 0) {
      throw new HttpError(400, `mixtureStops[${idx}].percent debe ser >= 0.`, 'INVALID_CONFIG');
    }
    return {
      hex: normalizeHexOrThrow(stop.hex, `mixtureStops[${idx}].hex`),
      percent,
    };
  });

  if (!Array.isArray(cfg.gradientStops)) {
    throw new HttpError(400, 'gradientStops debe ser un arreglo.', 'INVALID_CONFIG');
  }
  if (cfg.generationMode === 'gradient' && cfg.gradientStops.length === 0) {
    throw new HttpError(400, 'gradientStops no puede estar vacío en modo gradient.', 'INVALID_CONFIG');
  }
  cfg.gradientStops = cfg.gradientStops.map((stop, idx) => {
    if (!stop || typeof stop !== 'object' || Array.isArray(stop)) {
      throw new HttpError(400, `gradientStops[${idx}] inválido.`, 'INVALID_CONFIG');
    }
    const position = Number(stop.position);
    if (!Number.isFinite(position) || position < 0 || position > 1) {
      throw new HttpError(400, `gradientStops[${idx}].position debe estar entre 0 y 1.`, 'INVALID_CONFIG');
    }
    return {
      hex: normalizeHexOrThrow(stop.hex, `gradientStops[${idx}].hex`),
      position,
    };
  });

  if (cfg.seed !== undefined) {
    const seedNum = Number(cfg.seed);
    if (!Number.isFinite(seedNum)) {
      throw new HttpError(400, 'seed debe ser numérico.', 'INVALID_CONFIG');
    }
    cfg.seed = Math.trunc(seedNum);
  }

  return cfg;
}

function isLegacyRectPattern(pattern) {
  return !pattern || pattern === 'grid' || pattern === 'brick_50' || pattern === 'brick';
}

function estimatePatternCellCount(widthCm, heightCm, tileSizeCm, pattern) {
  const area = widthCm * heightCm;
  if (pattern === 'hexagonal') {
    const r = tileSizeCm / Math.sqrt(3);
    const cellArea = ((3 * Math.sqrt(3)) / 2) * r * r;
    return Math.ceil(area / Math.max(1e-6, cellArea));
  }
  if (pattern === 'fish_scale') {
    return Math.ceil(area / Math.max(1e-6, 0.5 * tileSizeCm * tileSizeCm));
  }
  if (pattern === 'basketweave') {
    return Math.ceil(area / Math.max(1e-6, 2 * tileSizeCm * tileSizeCm));
  }
  if (pattern === 'penny_round') {
    const dx = tileSizeCm;
    const dy = (Math.sqrt(3) * 0.5) * tileSizeCm;
    return Math.ceil(area / Math.max(1e-6, dx * dy));
  }
  return Math.ceil(widthCm / tileSizeCm) * Math.ceil(heightCm / tileSizeCm);
}

function resolvePatternCellsIfSafe(config, explicitCells = null) {
  if (Array.isArray(explicitCells) && explicitCells.length > 0) {
    return explicitCells;
  }
  if (isLegacyRectPattern(config.pattern)) {
    return null;
  }
  if (!ARCHITECTURAL_PATTERNS.includes(config.pattern)) {
    return null;
  }
  const estimated = estimatePatternCellCount(
    config.widthCm,
    config.heightCm,
    config.tileSizeCm,
    config.pattern
  );
  if (estimated > MAX_SYNC_PATTERN_CELLS) {
    return null;
  }
  return generatePatternCells(config);
}

function countActiveGridCells(grid) {
  if (!grid || grid.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== UNUSED_CELL) count++;
  }
  return count;
}

function normalizePaletteEntries(rawPalette = []) {
  if (!Array.isArray(rawPalette)) {
    throw new HttpError(400, 'palette debe ser un arreglo.', 'INVALID_PALETTE');
  }
  return rawPalette.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new HttpError(400, `Entrada de paleta inválida en índice ${idx}.`, 'INVALID_PALETTE');
    }
    let r = Number(entry.r);
    let g = Number(entry.g);
    let b = Number(entry.b);
    if ((!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) && Array.isArray(entry.rgb)) {
      r = Number(entry.rgb[0]);
      g = Number(entry.rgb[1]);
      b = Number(entry.rgb[2]);
    }
    if ((!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) && entry.hex) {
      let parsed;
      try {
        parsed = hexToRgb(entry.hex);
      } catch (err) {
        throw new HttpError(400, `Color inválido en paleta índice ${idx}: ${err.message}`, 'INVALID_PALETTE');
      }
      r = parsed.r;
      g = parsed.g;
      b = parsed.b;
    }
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new HttpError(400, `Color inválido en paleta índice ${idx}.`, 'INVALID_PALETTE');
    }
    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));
    const hex = typeof entry.hex === 'string' && /^#[0-9a-f]{6}$/i.test(entry.hex.trim())
      ? entry.hex.trim().toUpperCase()
      : rgbToHex(r, g, b);
    const count = Number.isFinite(Number(entry.count)) ? Math.max(0, Math.round(Number(entry.count))) : 0;

    const normalized = { r, g, b, hex, count };
    if (Number.isInteger(entry.id) && entry.id >= 0) normalized.id = entry.id;
    if (
      entry.lab &&
      typeof entry.lab === 'object' &&
      Number.isFinite(entry.lab.L) &&
      Number.isFinite(entry.lab.a) &&
      Number.isFinite(entry.lab.b)
    ) {
      normalized.lab = { L: entry.lab.L, a: entry.lab.a, b: entry.lab.b };
    }
    if (Number.isInteger(entry.wholeCount) && entry.wholeCount >= 0) normalized.wholeCount = entry.wholeCount;
    if (Number.isInteger(entry.cutCount) && entry.cutCount >= 0) normalized.cutCount = entry.cutCount;
    if (typeof entry.catalogCode === 'string' && entry.catalogCode.trim()) {
      normalized.catalogCode = entry.catalogCode.trim().slice(0, 64);
    }
    if (typeof entry.name === 'string' && entry.name.trim()) {
      normalized.name = entry.name.trim().slice(0, 120);
    }
    if (Number.isFinite(entry.stockAvailable) && entry.stockAvailable >= 0) {
      normalized.stockAvailable = Number(entry.stockAvailable);
    }
    return normalized;
  });
}

function normalizeSnapshotInput(projectId, payload, config, existingSnapshot = null) {
  const metrics = computeGridMetrics(config.widthCm, config.heightCm, config.tileSizeCm, config.pattern);
  const snapSrc =
    payload.snapshot && typeof payload.snapshot === 'object' && !Array.isArray(payload.snapshot)
      ? payload.snapshot
      : payload;

  const explicitCells = Array.isArray(snapSrc.cells)
    ? snapSrc.cells
    : Array.isArray(payload.cells)
    ? payload.cells
    : null;

  const hasExplicitSnapshot =
    payload.snapshot !== undefined ||
    payload.gridRle !== undefined ||
    payload.grid !== undefined ||
    payload.palette !== undefined ||
    payload.cells !== undefined;

  const patternCells = resolvePatternCellsIfSafe(
    config,
    explicitCells || (!hasExplicitSnapshot ? existingSnapshot?.cells : null) || null
  );
  const expectedLen = patternCells
    ? patternCells.length
    : isLegacyRectPattern(config.pattern)
    ? metrics.tileRows * metrics.maxRowCols
    : undefined;

  if (!hasExplicitSnapshot && existingSnapshot) {
    const existingPalette = Array.isArray(existingSnapshot.palette) ? existingSnapshot.palette : [];
    const existingRle = Array.isArray(existingSnapshot.gridRle) ? existingSnapshot.gridRle : [];
    const existingPaletteSum = existingPalette.reduce((sum, c) => sum + (Number(c.count) || 0), 0);
    const hasSavedMosaic =
      existingRle.length > 0 || existingPalette.length > 0 || Boolean(existingSnapshot.cells?.length);

    if (hasSavedMosaic) {
      return {
        ...existingSnapshot,
        projectId,
        totalTiles:
          existingPaletteSum > 0
            ? existingPaletteSum
            : Number.isFinite(existingSnapshot.totalTiles)
            ? existingSnapshot.totalTiles
            : patternCells
            ? patternCells.length
            : metrics.totalTiles,
      };
    }

    return {
      ...existingSnapshot,
      projectId,
      tileCols: metrics.tileCols,
      tileRows: metrics.tileRows,
      maxRowCols: metrics.maxRowCols,
      totalTiles: patternCells
        ? patternCells.length
        : isLegacyRectPattern(config.pattern)
        ? metrics.totalTiles
        : estimatePatternCellCount(config.widthCm, config.heightCm, config.tileSizeCm, config.pattern),
    };
  }

  let rawRle = null;
  let decodedGrid = null;

  if (Array.isArray(snapSrc.gridRle)) {
    rawRle = snapSrc.gridRle;
  } else if (snapSrc.grid && typeof snapSrc.grid === 'object' && Array.isArray(snapSrc.grid.rle)) {
    rawRle = snapSrc.grid.rle;
  } else if (Array.isArray(snapSrc.grid) || snapSrc.grid instanceof Uint8Array) {
    const arr = snapSrc.grid instanceof Uint8Array ? snapSrc.grid : Uint8Array.from(snapSrc.grid);
    rawRle = encodeGridRle(arr);
  }

  if (rawRle !== null) {
    try {
      const expected = rawRle.length === 0 ? undefined : expectedLen;
      decodedGrid = decodeGridRle(rawRle, expected);
    } catch (err) {
      throw new HttpError(400, `Grilla RLE inválida: ${err.message}`, 'INVALID_GRID_RLE');
    }
  } else if (existingSnapshot && Array.isArray(existingSnapshot.gridRle)) {
    rawRle = existingSnapshot.gridRle;
    try {
      decodedGrid = rawRle.length > 0 ? decodeGridRle(rawRle) : null;
    } catch {
      decodedGrid = null;
    }
  } else {
    rawRle = [];
  }

  const rawPalette =
    snapSrc.palette !== undefined
      ? normalizePaletteEntries(snapSrc.palette)
      : existingSnapshot?.palette
      ? normalizePaletteEntries(existingSnapshot.palette)
      : [];

  let palette = rawPalette;
  let totalTiles;

  if (decodedGrid && decodedGrid.length > 0 && palette.length > 0) {
    const recounted = recountPalette(decodedGrid, palette);
    palette = recounted.palette;
    totalTiles = recounted.totalTiles;
  } else if (decodedGrid && decodedGrid.length > 0) {
    totalTiles = countActiveGridCells(decodedGrid);
  } else if (palette.length > 0) {
    const paletteSum = palette.reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
    if (paletteSum > 0) {
      totalTiles = paletteSum;
    } else if (Number.isFinite(Number(snapSrc.totalTiles))) {
      totalTiles = Math.max(0, Math.round(Number(snapSrc.totalTiles)));
    } else {
      totalTiles = patternCells
        ? patternCells.length
        : isLegacyRectPattern(config.pattern)
        ? metrics.totalTiles
        : estimatePatternCellCount(config.widthCm, config.heightCm, config.tileSizeCm, config.pattern);
    }
  } else if (explicitCells) {
    totalTiles = explicitCells.length;
  } else if (Number.isFinite(Number(snapSrc.totalTiles))) {
    totalTiles = Math.max(0, Math.round(Number(snapSrc.totalTiles)));
  } else if (patternCells) {
    totalTiles = patternCells.length;
  } else if (isLegacyRectPattern(config.pattern)) {
    totalTiles = metrics.totalTiles;
  } else {
    totalTiles = estimatePatternCellCount(
      config.widthCm,
      config.heightCm,
      config.tileSizeCm,
      config.pattern
    );
  }

  const tileCols = Number.isInteger(snapSrc.tileCols) ? snapSrc.tileCols : metrics.tileCols;
  const tileRows = Number.isInteger(snapSrc.tileRows) ? snapSrc.tileRows : metrics.tileRows;
  const maxRowCols = Number.isInteger(snapSrc.maxRowCols) ? snapSrc.maxRowCols : metrics.maxRowCols;

  const snapshot = {
    projectId,
    palette,
    gridRle: rawRle,
    tileCols,
    tileRows,
    maxRowCols,
    totalTiles,
  };

  if (explicitCells) {
    snapshot.cells = explicitCells;
  } else if (existingSnapshot?.cells && payload.cells === undefined) {
    snapshot.cells = existingSnapshot.cells;
  }

  return snapshot;
}

function buildStats(snapshot, config, existingStats = null) {
  const metrics = computeGridMetrics(config.widthCm, config.heightCm, config.tileSizeCm, config.pattern);
  const palette = Array.isArray(snapshot?.palette) ? snapshot.palette : [];
  const paletteTotal = palette.reduce((sum, c) => sum + Math.max(0, Number(c.count) || 0), 0);
  const activeColors = palette.filter((c) => Number(c.count) > 0).length;

  let resolvedTotalTiles;
  if (paletteTotal > 0) {
    resolvedTotalTiles = paletteTotal;
  } else if (Number.isFinite(snapshot?.totalTiles)) {
    resolvedTotalTiles = snapshot.totalTiles;
  } else if (Array.isArray(snapshot?.cells) && snapshot.cells.length > 0) {
    resolvedTotalTiles = snapshot.cells.length;
  } else if (Number.isFinite(existingStats?.totalTiles)) {
    resolvedTotalTiles = existingStats.totalTiles;
  } else {
    const patternCells = resolvePatternCellsIfSafe(config);
    resolvedTotalTiles = patternCells ? patternCells.length : metrics.totalTiles;
  }

  return {
    totalTiles: resolvedTotalTiles,
    tileCols: snapshot?.tileCols ?? existingStats?.tileCols ?? metrics.tileCols,
    tileRows: snapshot?.tileRows ?? existingStats?.tileRows ?? metrics.tileRows,
    maxRowCols: snapshot?.maxRowCols ?? existingStats?.maxRowCols ?? metrics.maxRowCols,
    colorCount: activeColors || config.colorCount,
  };
}

function normalizeSourceImageId(sourceImageId) {
  if (sourceImageId === undefined) return undefined;
  if (sourceImageId === null || sourceImageId === '') return null;
  return assertValidImageUuid(String(sourceImageId));
}

function sanitizeProjectMetadataOnly(record) {
  return {
    id: record.id,
    name: record.name,
    sourceImageId: record.sourceImageId ?? null,
    sourceName: record.sourceName,
    aspectRatio: record.aspectRatio,
    keepRatio: Boolean(record.keepRatio),
    config: record.config,
    stats: record.stats,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Lista todos los proyectos livianos ordenados por `updatedAt` descendente.
 * @returns {Promise<import('../shared/contracts.js').ProjectMetadata[]>}
 */
export async function listProjects() {
  const list = await projectsStore.read();
  if (!Array.isArray(list)) return [];
  return [...list]
    .map(sanitizeProjectMetadataOnly)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * Obtiene un proyecto por ID junto con su snapshot RLE almacenado en `storage/projects/<id>.json`.
 * @param {string} id
 * @returns {Promise<{ project: import('../shared/contracts.js').ProjectMetadata, snapshot: import('../shared/contracts.js').ProjectGridSnapshot } | null>}
 */
export async function getProjectById(id) {
  const validId = assertValidProjectId(id);
  const list = await projectsStore.read();
  const project = Array.isArray(list) ? list.find((item) => item.id === validId) : null;
  if (!project) return null;

  const snapStore = getSnapshotStore(validId);
  let snapshot = null;
  try {
    await fs.access(snapStore.filePath);
    snapshot = await snapStore.read();
  } catch {
    const metrics = computeGridMetrics(
      project.config.widthCm,
      project.config.heightCm,
      project.config.tileSizeCm,
      project.config.pattern
    );
    const patternCells = resolvePatternCellsIfSafe(project.config);
    snapshot = {
      projectId: validId,
      palette: [],
      gridRle: [],
      tileCols: metrics.tileCols,
      tileRows: metrics.tileRows,
      maxRowCols: metrics.maxRowCols,
      totalTiles: patternCells ? patternCells.length : metrics.totalTiles,
    };
  }

  return {
    project: sanitizeProjectMetadataOnly(project),
    snapshot,
  };
}

/**
 * Crea un nuevo proyecto guardando metadatos livianos en `data/projects.json`
 * y la grilla RLE en `storage/projects/<id>.json`.
 *
 * @param {Record<string, any>} payload
 * @returns {Promise<{ project: import('../shared/contracts.js').ProjectMetadata, snapshot: import('../shared/contracts.js').ProjectGridSnapshot }>}
 */
export async function createProject(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'El cuerpo del proyecto debe ser un objeto JSON válido.', 'INVALID_PAYLOAD');
  }

  const id = crypto.randomUUID().toLowerCase();
  const now = new Date().toISOString();
  const config = validateAndNormalizeMosaicConfig(payload.config);

  const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
  const name = (rawName || `Mural ${config.widthCm}x${config.heightCm} cm`).slice(0, 140);

  const sourceImageId = normalizeSourceImageId(payload.sourceImageId) ?? null;
  const sourceName =
    typeof payload.sourceName === 'string' && payload.sourceName.trim()
      ? payload.sourceName.trim().slice(0, 180)
      : 'ejemplo_paisaje_mosaico.png';

  const rawAspect = Number(payload.aspectRatio);
  const aspectRatio =
    Number.isFinite(rawAspect) && rawAspect > 0
      ? rawAspect
      : Number((config.widthCm / config.heightCm).toFixed(6));

  const keepRatio = payload.keepRatio !== undefined ? Boolean(payload.keepRatio) : true;
  const snapshot = normalizeSnapshotInput(id, payload, config);
  const stats = buildStats(snapshot, config, payload.stats);

  const project = sanitizeProjectMetadataOnly({
    id,
    name,
    sourceImageId,
    sourceName,
    aspectRatio,
    keepRatio,
    config,
    stats,
    createdAt: now,
    updatedAt: now,
  });

  await fs.mkdir(PROJECTS_SNAPSHOT_DIR, { recursive: true });
  await getSnapshotStore(id).write(snapshot);

  await projectsStore.update((list) => {
    const arr = Array.isArray(list) ? list : [];
    return [project, ...arr];
  });

  return { project, snapshot };
}

/**
 * Actualiza metadatos y/o snapshot RLE de un proyecto existente.
 *
 * @param {string} id
 * @param {Record<string, any>} payload
 * @returns {Promise<{ project: import('../shared/contracts.js').ProjectMetadata, snapshot: import('../shared/contracts.js').ProjectGridSnapshot } | null>}
 */
export async function updateProject(id, payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'El cuerpo de actualización debe ser un objeto JSON válido.', 'INVALID_PAYLOAD');
  }

  const validId = assertValidProjectId(id);
  const existing = await getProjectById(validId);
  if (!existing) return null;

  const nextConfig =
    payload.config !== undefined
      ? validateAndNormalizeMosaicConfig(payload.config, existing.project.config)
      : validateAndNormalizeMosaicConfig(existing.project.config);

  const nextName =
    typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim().slice(0, 140)
      : existing.project.name;

  const nextSourceImageId =
    payload.sourceImageId !== undefined
      ? normalizeSourceImageId(payload.sourceImageId)
      : existing.project.sourceImageId;

  const nextSourceName =
    typeof payload.sourceName === 'string' && payload.sourceName.trim()
      ? payload.sourceName.trim().slice(0, 180)
      : existing.project.sourceName;

  const rawAspect = Number(payload.aspectRatio);
  const nextAspectRatio =
    payload.aspectRatio !== undefined && Number.isFinite(rawAspect) && rawAspect > 0
      ? rawAspect
      : existing.project.aspectRatio;

  const nextKeepRatio =
    payload.keepRatio !== undefined ? Boolean(payload.keepRatio) : existing.project.keepRatio;

  const nextSnapshot = normalizeSnapshotInput(validId, payload, nextConfig, existing.snapshot);
  const nextStats = buildStats(nextSnapshot, nextConfig, payload.stats || existing.project.stats);
  const updatedAt = new Date().toISOString();

  const updatedProject = sanitizeProjectMetadataOnly({
    ...existing.project,
    name: nextName,
    sourceImageId: nextSourceImageId,
    sourceName: nextSourceName,
    aspectRatio: nextAspectRatio,
    keepRatio: nextKeepRatio,
    config: nextConfig,
    stats: nextStats,
    updatedAt,
  });

  await fs.mkdir(PROJECTS_SNAPSHOT_DIR, { recursive: true });
  await getSnapshotStore(validId).write(nextSnapshot);

  await projectsStore.update((list) => {
    const arr = Array.isArray(list) ? list : [];
    return arr.map((item) => (item.id === validId ? updatedProject : item));
  });

  return { project: updatedProject, snapshot: nextSnapshot };
}

/**
 * Duplica un proyecto existente (metadatos + snapshot RLE) con un nuevo UUID.
 *
 * @param {string} id
 * @param {string} [customName]
 * @returns {Promise<{ project: import('../shared/contracts.js').ProjectMetadata, snapshot: import('../shared/contracts.js').ProjectGridSnapshot } | null>}
 */
export async function duplicateProject(id, customName) {
  const existing = await getProjectById(id);
  if (!existing) return null;

  const newId = crypto.randomUUID().toLowerCase();
  const now = new Date().toISOString();
  const baseName = typeof customName === 'string' && customName.trim()
    ? customName.trim()
    : `${existing.project.name} (Copia)`;

  const duplicatedProject = sanitizeProjectMetadataOnly({
    ...existing.project,
    id: newId,
    name: baseName.slice(0, 140),
    createdAt: now,
    updatedAt: now,
  });

  const duplicatedSnapshot = {
    ...structuredClone(existing.snapshot),
    projectId: newId,
  };

  await fs.mkdir(PROJECTS_SNAPSHOT_DIR, { recursive: true });
  await getSnapshotStore(newId).write(duplicatedSnapshot);

  await projectsStore.update((list) => {
    const arr = Array.isArray(list) ? list : [];
    return [duplicatedProject, ...arr];
  });

  return { project: duplicatedProject, snapshot: duplicatedSnapshot };
}

/**
 * Elimina un proyecto de `data/projects.json` y borra su snapshot de `storage/projects/<id>.json`.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteProject(id) {
  const validId = assertValidProjectId(id);
  let removed = false;

  await projectsStore.update((list) => {
    const arr = Array.isArray(list) ? list : [];
    const next = arr.filter((item) => item.id !== validId);
    removed = next.length !== arr.length;
    return next;
  });

  if (!removed) return false;

  const snapPath = getSnapshotPath(validId);
  await fs.rm(snapPath, { force: true }).catch(() => {});
  return true;
}
