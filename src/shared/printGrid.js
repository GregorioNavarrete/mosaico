import {
  PT_PER_CM,
  PAPER_FORMATS,
  createDefaultConfig,
  validateMosaicConfig,
} from './contracts.js';

/**
 * Convierte centímetros físicos a puntos PostScript/PDF (1 cm = 72/2.54 pt).
 * @param {number} cm
 * @returns {number}
 */
export function cmToPt(cm) {
  if (!Number.isFinite(cm) || cm < 0) {
    throw new Error(`Valor en cm inválido para conversión a pt: ${cm}`);
  }
  return cm * PT_PER_CM;
}

/**
 * Convierte puntos PostScript/PDF a centímetros físicos.
 * @param {number} pt
 * @returns {number}
 */
export function ptToCm(pt) {
  if (!Number.isFinite(pt) || pt < 0) {
    throw new Error(`Valor en pt inválido para conversión a cm: ${pt}`);
  }
  return pt / PT_PER_CM;
}

/**
 * Obtiene dimensiones físicas (en cm) del formato de papel solicitado según orientación.
 * Soporta A4, A3, LETTER, LEGAL y CUSTOM.
 *
 * @param {keyof typeof PAPER_FORMATS} [paperFormat='A4']
 * @param {'portrait' | 'landscape'} [orientation='portrait']
 * @param {number} [customW]
 * @param {number} [customH]
 * @returns {{ pageW: number, pageH: number, paperFormat: string, orientation: 'portrait' | 'landscape' }}
 */
export function getPaperDimensionsCm(paperFormat = 'A4', orientation = 'portrait', customW, customH) {
  const fmtKey = typeof paperFormat === 'string' && paperFormat in PAPER_FORMATS ? paperFormat : null;
  if (!fmtKey) {
    throw new Error(`Formato de papel no soportado: ${paperFormat}`);
  }
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw new Error(`Orientación de papel inválida: ${orientation}`);
  }

  let shortCm;
  let longCm;

  if (fmtKey === 'CUSTOM') {
    const w = Number.isFinite(customW) ? customW : PAPER_FORMATS.CUSTOM.shortCm;
    const h = Number.isFinite(customH) ? customH : PAPER_FORMATS.CUSTOM.longCm;
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
      throw new Error(`Dimensiones CUSTOM inválidas: ${customW} × ${customH} cm.`);
    }
    shortCm = Math.min(w, h);
    longCm = Math.max(w, h);
  } else {
    shortCm = PAPER_FORMATS[fmtKey].shortCm;
    longCm = PAPER_FORMATS[fmtKey].longCm;
  }

  const pageW = orientation === 'portrait' ? shortCm : longCm;
  const pageH = orientation === 'portrait' ? longCm : shortCm;

  return {
    pageW,
    pageH,
    paperFormat: fmtKey,
    orientation,
  };
}

/**
 * Convierte índice de fila (0-based) en etiqueta tipo hoja de cálculo (0 -> A, 25 -> Z, 26 -> AA).
 * @param {number} rowIndex
 * @returns {string}
 */
export function getRowLabel(rowIndex) {
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    throw new Error(`rowIndex inválido: ${rowIndex}`);
  }
  let label = '';
  let n = rowIndex;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * Convierte etiqueta de fila ("A", "Z", "AA") a índice entero 0-based.
 * @param {string} letters
 * @returns {number}
 */
function rowLabelToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    const code = letters.charCodeAt(i);
    if (code < 65 || code > 90) return -1;
    idx = idx * 26 + (code - 64);
  }
  return idx - 1;
}

/**
 * Parsea una etiqueta de hoja como "A1", "B3", "AA12" -> { row, col, label }.
 * Retorna null si es inválida.
 *
 * @param {string} label
 * @returns {{ row: number, col: number, label: string } | null}
 */
export function parseSheetLabel(label) {
  if (typeof label !== 'string') return null;
  const clean = label.trim().toUpperCase();
  const match = /^([A-Z]+)(\d+)$/.exec(clean);
  if (!match) return null;

  const row = rowLabelToIndex(match[1]);
  const colOneBased = Number.parseInt(match[2], 10);
  if (row < 0 || !Number.isInteger(colOneBased) || colOneBased < 1) {
    return null;
  }

  const col = colOneBased - 1;
  return {
    row,
    col,
    label: `${getRowLabel(row)}${colOneBased}`,
  };
}

/**
 * Calcula las métricas completas de la cuadrícula de impresión multipapel.
 * Aplica guarda Math.max(1, Math.ceil(...)) y valida overlap < Math.min(Ux, Uy).
 *
 * @param {Partial<import('./contracts.js').MosaicConfig>} [config={}]
 * @returns {import('./contracts.js').PrintGridMetrics & { orientation: 'portrait' | 'landscape' }}
 */
export function computePrintGrid(config = {}) {
  const merged = { ...createDefaultConfig(), ...config };
  const validation = validateMosaicConfig(merged);
  if (!validation.valid) {
    throw new Error(`Configuración de impresión inválida: ${validation.errors.join(' ')}`);
  }

  const cfg = validation.config;
  const { pageW, pageH, paperFormat, orientation } = getPaperDimensionsCm(
    cfg.paperFormat,
    cfg.orientation,
    cfg.customPaperWidthCm,
    cfg.customPaperHeightCm
  );

  const margin = cfg.marginCm;
  const Ux = pageW - 2 * margin;
  const Uy = pageH - 2 * margin;

  if (!Number.isFinite(Ux) || !Number.isFinite(Uy) || Ux <= 0 || Uy <= 0) {
    throw new Error(
      `Márgenes inválidos (${margin} cm) para formato ${paperFormat} (${pageW}×${pageH} cm): área útil no positiva.`
    );
  }

  const overlap = cfg.overlapCm;
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= Math.min(Ux, Uy)) {
    throw new Error(
      `Solapamiento inválido (${overlap} cm): debe ser >= 0 y estrictamente menor a min(Ux, Uy) = ${Math.min(Ux, Uy).toFixed(2)} cm.`
    );
  }

  const stepX = Ux - overlap;
  const stepY = Uy - overlap;

  const Nx = cfg.widthCm <= Ux ? 1 : Math.max(1, Math.ceil((cfg.widthCm - overlap) / stepX));
  const Ny = cfg.heightCm <= Uy ? 1 : Math.max(1, Math.ceil((cfg.heightCm - overlap) / stepY));

  return {
    paperFormat,
    orientation,
    pageW,
    pageH,
    margin,
    Ux,
    Uy,
    overlap,
    stepX,
    stepY,
    Nx,
    Ny,
    totalPages: Nx * Ny,
    calibrationBar10CmPt: cmToPt(10.0),
  };
}

/**
 * Genera el listado completo de hojas físicas en orden lectura (fila por fila, izquierda a derecha).
 *
 * @param {Partial<import('./contracts.js').MosaicConfig>} [config={}]
 * @returns {import('./contracts.js').PrintSheetSpec[]}
 */
export function listPrintSheets(config = {}) {
  const cfg = { ...createDefaultConfig(), ...config };
  const m = computePrintGrid(cfg);
  const sheets = [];

  for (let row = 0; row < m.Ny; row++) {
    const srcYCm = row * m.stepY;
    const sliceHCm = Math.max(0, Math.min(m.Uy, cfg.heightCm - srcYCm));
    const rowLabel = getRowLabel(row);

    for (let col = 0; col < m.Nx; col++) {
      const srcXCm = col * m.stepX;
      const sliceWCm = Math.max(0, Math.min(m.Ux, cfg.widthCm - srcXCm));

      sheets.push({
        row,
        col,
        label: `${rowLabel}${col + 1}`,
        srcXCm,
        srcYCm,
        sliceWCm,
        sliceHCm,
      });
    }
  }

  return sheets;
}

/**
 * Parsea una expresión de selección de hojas como "A1-B3, C2" o "A1; B2".
 * Soporta rangos rectangulares ("A1-B3" cubre filas A..B y columnas 1..3) y etiquetas individuales.
 * Ignora tokens inválidos o fuera de los límites [nx, ny], retornando un array de labels únicos
 * ordenados por fila (row) y luego por columna (col).
 *
 * @param {string} expr
 * @param {number} nx Número total de columnas (Nx)
 * @param {number} ny Número total de filas (Ny)
 * @returns {string[]}
 */
export function parseSheetRangeExpression(expr, nx, ny) {
  if (typeof expr !== 'string' || !expr.trim()) return [];
  if (!Number.isInteger(nx) || nx < 1 || !Number.isInteger(ny) || ny < 1) return [];

  const selected = new Map(); // key: row * nx + col -> label
  const tokens = expr.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);

  for (const token of tokens) {
    const rangeParts = token.split(/\s*[-–:]\s*/);
    if (rangeParts.length === 1) {
      const parsed = parseSheetLabel(rangeParts[0]);
      if (parsed && parsed.row >= 0 && parsed.row < ny && parsed.col >= 0 && parsed.col < nx) {
        selected.set(parsed.row * nx + parsed.col, parsed.label);
      }
      continue;
    }

    if (rangeParts.length === 2) {
      const a = parseSheetLabel(rangeParts[0]);
      const b = parseSheetLabel(rangeParts[1]);
      if (!a || !b) continue;

      const rStart = Math.max(0, Math.min(a.row, b.row));
      const rEnd = Math.min(ny - 1, Math.max(a.row, b.row));
      const cStart = Math.max(0, Math.min(a.col, b.col));
      const cEnd = Math.min(nx - 1, Math.max(a.col, b.col));

      if (rStart > rEnd || cStart > cEnd) continue;

      for (let r = rStart; r <= rEnd; r++) {
        const rLbl = getRowLabel(r);
        for (let c = cStart; c <= cEnd; c++) {
          selected.set(r * nx + c, `${rLbl}${c + 1}`);
        }
      }
    }
  }

  return Array.from(selected.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}
