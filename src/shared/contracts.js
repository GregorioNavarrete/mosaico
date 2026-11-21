/**
 * Contratos compartidos de GuíaMosaico (Node.js + Browser ES Modules).
 * Fuente única de verdad para constantes físicas, formatos de papel, patrones,
 * preprocesado, colorimetría CIELAB/Dithering, proyectos, PDF 1:1, BOM y homografía.
 */

export const PT_PER_INCH = 72;
export const CM_PER_INCH = 2.54;
export const PT_PER_CM = PT_PER_INCH / CM_PER_INCH; // 28.346456692913385
export const MAX_PDF_PAGES_PHASE1 = 250;
export const MAX_PDF_PAGES_POSTER = 1000;

export const PAPER_FORMATS = Object.freeze({
  A4: { id: 'A4', label: 'A4 (21.0 × 29.7 cm)', shortCm: 21.0, longCm: 29.7 },
  A3: { id: 'A3', label: 'A3 (29.7 × 42.0 cm)', shortCm: 29.7, longCm: 42.0 },
  LETTER: { id: 'LETTER', label: 'Carta (21.59 × 27.94 cm)', shortCm: 21.59, longCm: 27.94 },
  LEGAL: { id: 'LEGAL', label: 'Oficio / Legal (21.59 × 35.56 cm)', shortCm: 21.59, longCm: 35.56 },
  CUSTOM: { id: 'CUSTOM', label: 'Personalizado', shortCm: 21.0, longCm: 29.7 },
});

export const PATTERN_TYPES = Object.freeze([
  'grid',
  'brick_50',
  'brick_33',
  'diamond_45',
  'hexagonal',
  'herringbone',
  'basketweave',
  'fish_scale',
  'penny_round',
  'trencadis_voronoi',
  'opus_vermiculatum',
]);

export const ARCHITECTURAL_PATTERNS = Object.freeze([
  'grid',
  'brick_50',
  'brick_33',
  'diamond_45',
  'hexagonal',
  'herringbone',
  'basketweave',
  'fish_scale',
  'penny_round',
]);

export const PATTERN_LABELS = Object.freeze({
  grid: 'Cuadrícula',
  brick_50: 'Ladrillo 50%',
  brick_33: 'Ladrillo 33%',
  diamond_45: 'Diamante 45°',
  hexagonal: 'Hexagonal',
  herringbone: 'Espiga',
  basketweave: 'Basketweave',
  fish_scale: 'Escama',
  penny_round: 'Penny Round',
  trencadis_voronoi: 'Trencadís',
  opus_vermiculatum: 'Vermiculatum',
});

export const PATTERN_DEFAULT_WASTE = Object.freeze({
  grid: 0.07,
  brick_50: 0.10,
  brick_33: 0.10,
  diamond_45: 0.14,
  hexagonal: 0.13,
  herringbone: 0.14,
  basketweave: 0.12,
  fish_scale: 0.15,
  penny_round: 0.12,
  trencadis_voronoi: 0.18,
  opus_vermiculatum: 0.16,
});

export const PREPROCESS_MODES = Object.freeze(['none', 'bilateral', 'kuwahara']);
export const COLOR_MODES = Object.freeze(['cielab', 'redmean']);
export const DITHER_MODES = Object.freeze(['none', 'floyd-steinberg', 'bayer']);
export const GENERATION_MODES = Object.freeze(['image', 'mixture', 'gradient']);
export const TILE_FINISHES = Object.freeze(['ceramic', 'glass', 'matte']);
export const POSTER_FILTER_MODES = Object.freeze(['color', 'grayscale', 'contrast_bw', 'line_art']);
export const PDF_SPLIT_MODES = Object.freeze(['single', 'per_sheet', 'batches']);

export const TROWEL_RATES_KG_M2 = Object.freeze({
  4: 2.5,
  6: 3.5,
  8: 4.5,
  10: 5.5,
});

export const SUPPORTED_CURRENCIES = Object.freeze(['ARS', 'USD', 'EUR']);

/**
 * @typedef {'portrait' | 'landscape'} PaperOrientation
 * @typedef {'color' | 'grayscale' | 'contour' | 'breakdown'} ViewMode
 * @typedef {'color' | 'grayscale' | 'contrast_bw' | 'line_art'} PosterFilterMode
 * @typedef {'single' | 'per_sheet' | 'batches'} PdfSplitMode
 * @typedef {'matte' | 'glass' | 'ceramic'} TileFinish
 * @typedef {'none' | 'bilateral' | 'kuwahara'} PreprocessMode
 * @typedef {'cielab' | 'redmean'} ColorSpaceMode
 * @typedef {'none' | 'floyd-steinberg' | 'bayer'} DitherMode
 * @typedef {'image' | 'mixture' | 'gradient'} GenerationMode
 *
 * @typedef {Object} MosaicConfig
 * @property {number} widthCm
 * @property {number} heightCm
 * @property {keyof typeof PAPER_FORMATS} paperFormat
 * @property {number} [customPaperWidthCm]
 * @property {number} [customPaperHeightCm]
 * @property {PaperOrientation} orientation
 * @property {number} marginCm
 * @property {number} overlapCm
 * @property {boolean} mirrorMode
 * @property {boolean} showA4Grid
 * @property {boolean} mosaicMode
 * @property {PosterFilterMode} [posterFilterMode]
 * @property {number} [posterContrast]
 * @property {number} [posterBrightness]
 * @property {number} [posterThreshold]
 * @property {boolean} [posterInvert]
 * @property {number} tileSizeCm
 * @property {number} tileThicknessMm
 * @property {string} pattern
 * @property {number} colorCount
 * @property {string} groutColor
 * @property {number} groutMm
 * @property {ViewMode} viewMode
 * @property {TileFinish} finish
 * @property {boolean} showNumbers
 * @property {PreprocessMode} preprocessMode
 * @property {boolean} removeBackground
 * @property {ColorSpaceMode} colorSpace
 * @property {DitherMode} ditherMode
 * @property {number} ditherStrength
 * @property {number} breakdownColorIdx
 * @property {GenerationMode} generationMode
 * @property {Array<{ hex: string, percent: number }>} [mixtureStops]
 * @property {Array<{ hex: string, position: number }>} [gradientStops]
 * @property {number} [gradientAngleDeg]
 * @property {number} [seed]
 *
 * @typedef {Object} CellGeometry
 * @property {number} id
 * @property {number} [row]
 * @property {number} [col]
 * @property {Array<[number, number]>} polygonCm
 * @property {number} areaCm2
 * @property {number} perimeterCm
 * @property {[number, number]} centroidCm
 * @property {number} nominalAreaCm2
 * @property {number} cutRatio
 * @property {boolean} isCut
 * @property {number} orientationDeg
 * @property {number} paletteId
 * @property {'polygon' | 'circle'} [shapeHint]
 * @property {number} [radiusCm]
 * @property {{ unbuildable?: boolean, minWidthMm?: number, minAngleDeg?: number }} [flags]
 *
 * @typedef {Object} PaletteEntry
 * @property {number} id
 * @property {string} hex
 * @property {number} r
 * @property {number} g
 * @property {number} b
 * @property {[number, number, number]} [rgb]
 * @property {{ L: number, a: number, b: number }} [lab]
 * @property {number} count
 * @property {number} [wholeCount]
 * @property {number} [cutCount]
 * @property {string} [catalogCode]
 * @property {string} [name]
 * @property {number} [stockAvailable]
 */

/**
 * Crea la configuración por defecto de GuíaMosaico (retrocompatible F1 + F2 + Póster/AR).
 * @returns {MosaicConfig}
 */
export function createDefaultConfig() {
  return {
    widthCm: 120,
    heightCm: 90,
    paperFormat: 'A4',
    customPaperWidthCm: 21.0,
    customPaperHeightCm: 29.7,
    orientation: 'portrait',
    marginCm: 1.0,
    overlapCm: 0.5,
    mirrorMode: false,
    showA4Grid: true,
    mosaicMode: true,
    posterFilterMode: 'color',
    posterContrast: 1.2,
    posterBrightness: 0,
    posterThreshold: 128,
    posterInvert: false,
    tileSizeCm: 2.0,
    tileThicknessMm: 4.0,
    pattern: 'grid',
    colorCount: 10,
    groutColor: '#D6D3CB',
    groutMm: 1.5,
    viewMode: 'color',
    finish: 'ceramic',
    showNumbers: true,
    preprocessMode: 'none',
    removeBackground: false,
    colorSpace: 'cielab',
    ditherMode: 'none',
    ditherStrength: 0.65,
    breakdownColorIdx: 0,
    generationMode: 'image',
    mixtureStops: [
      { hex: '#36594D', percent: 50 },
      { hex: '#E9BF8A', percent: 30 },
      { hex: '#BD754E', percent: 20 },
    ],
    gradientStops: [
      { hex: '#263F36', position: 0 },
      { hex: '#E9BF8A', position: 0.55 },
      { hex: '#C45B3E', position: 1 },
    ],
    gradientAngleDeg: 135,
    seed: 20261120,
  };
}

/**
 * Valida y normaliza una configuración de mural.
 * @param {Partial<MosaicConfig>} input
 * @returns {{ valid: boolean, errors: string[], config: MosaicConfig }}
 */
export function validateMosaicConfig(input = {}) {
  const cfg = { ...createDefaultConfig(), ...input };
  const errors = [];

  if (!Number.isFinite(cfg.widthCm) || cfg.widthCm < 5 || cfg.widthCm > 2500) {
    errors.push('widthCm debe estar entre 5 y 2500 cm.');
  }
  if (!Number.isFinite(cfg.heightCm) || cfg.heightCm < 5 || cfg.heightCm > 2500) {
    errors.push('heightCm debe estar entre 5 y 2500 cm.');
  }
  if (!(cfg.paperFormat in PAPER_FORMATS)) {
    errors.push(`paperFormat inválido: ${cfg.paperFormat}.`);
  }
  if (cfg.paperFormat === 'CUSTOM') {
    if (!Number.isFinite(cfg.customPaperWidthCm) || cfg.customPaperWidthCm < 5 || cfg.customPaperWidthCm > 200) {
      errors.push('customPaperWidthCm debe estar entre 5 y 200 cm.');
    }
    if (!Number.isFinite(cfg.customPaperHeightCm) || cfg.customPaperHeightCm < 5 || cfg.customPaperHeightCm > 200) {
      errors.push('customPaperHeightCm debe estar entre 5 y 200 cm.');
    }
  }
  if (cfg.orientation !== 'portrait' && cfg.orientation !== 'landscape') {
    errors.push(`orientation inválida: ${cfg.orientation}.`);
  }
  if (!Number.isFinite(cfg.marginCm) || cfg.marginCm < 0.2 || cfg.marginCm > 5.0) {
    errors.push('marginCm debe estar entre 0.2 y 5.0 cm.');
  }
  if (!Number.isFinite(cfg.overlapCm) || cfg.overlapCm < 0 || cfg.overlapCm > 8.0) {
    errors.push('overlapCm debe estar entre 0 y 8.0 cm.');
  }
  if (!Number.isFinite(cfg.tileSizeCm) || cfg.tileSizeCm < 0.5 || cfg.tileSizeCm > 30) {
    errors.push('tileSizeCm debe estar entre 0.5 y 30 cm.');
  }
  if (!Number.isFinite(cfg.groutMm) || cfg.groutMm < 0 || cfg.groutMm > 10) {
    errors.push('groutMm debe estar entre 0 y 10 mm.');
  }
  if (!PATTERN_TYPES.includes(cfg.pattern)) {
    errors.push(`pattern no soportado: ${cfg.pattern}.`);
  }
  if (!Number.isInteger(cfg.colorCount) || cfg.colorCount < 2 || cfg.colorCount > 48) {
    errors.push('colorCount debe ser un entero entre 2 y 48.');
  }
  if (!PREPROCESS_MODES.includes(cfg.preprocessMode)) {
    errors.push(`preprocessMode inválido: ${cfg.preprocessMode}.`);
  }
  if (!COLOR_MODES.includes(cfg.colorSpace)) {
    errors.push(`colorSpace inválido: ${cfg.colorSpace}.`);
  }
  if (!DITHER_MODES.includes(cfg.ditherMode)) {
    errors.push(`ditherMode inválido: ${cfg.ditherMode}.`);
  }
  if (!Number.isFinite(cfg.ditherStrength) || cfg.ditherStrength < 0 || cfg.ditherStrength > 1) {
    errors.push('ditherStrength debe estar entre 0 y 1.');
  }
  if (!GENERATION_MODES.includes(cfg.generationMode)) {
    errors.push(`generationMode inválido: ${cfg.generationMode}.`);
  }
  if (!TILE_FINISHES.includes(cfg.finish)) {
    errors.push(`finish inválido: ${cfg.finish}.`);
  }
  if (!POSTER_FILTER_MODES.includes(cfg.posterFilterMode)) {
    errors.push(`posterFilterMode inválido: ${cfg.posterFilterMode}.`);
  }
  if (!Number.isFinite(cfg.posterContrast) || cfg.posterContrast < 0.4 || cfg.posterContrast > 3.0) {
    errors.push('posterContrast debe estar entre 0.4 y 3.0.');
  }
  if (!Number.isFinite(cfg.posterBrightness) || cfg.posterBrightness < -80 || cfg.posterBrightness > 80) {
    errors.push('posterBrightness debe estar entre -80 y 80.');
  }
  if (!Number.isFinite(cfg.posterThreshold) || cfg.posterThreshold < 16 || cfg.posterThreshold > 240) {
    errors.push('posterThreshold debe estar entre 16 y 240.');
  }
  cfg.posterInvert = Boolean(cfg.posterInvert);

  return { valid: errors.length === 0, errors, config: cfg };
}
