import { generateSplitPdfExport } from '../services/pdfService.js';
import { HttpError, readUploadedImageBuffer } from '../services/imageSecurityService.js';
import { PDF_SPLIT_MODES, validateMosaicConfig } from '../shared/contracts.js';
import { validateAndNormalizeMosaicConfig } from '../models/projectModel.js';

function sanitizeDownloadFilename(name, expectedExt = '.pdf') {
  const defaultName = expectedExt === '.zip' ? 'GuiaMosaico_1a1.zip' : 'GuiaMosaico_1a1.pdf';
  const clean = String(name || defaultName)
    .replace(/[\r\n"\\/:*?<>|]+/g, '_')
    .trim();
  const base = clean || defaultName;
  return base.toLowerCase().endsWith(expectedExt) ? base : `${base}${expectedExt}`;
}

function normalizeExportOptions(rawExportOptions, validatedConfig) {
  if (
    rawExportOptions !== undefined &&
    (!rawExportOptions || typeof rawExportOptions !== 'object' || Array.isArray(rawExportOptions))
  ) {
    throw new HttpError(400, 'El campo "exportOptions" debe ser un objeto JSON válido.', 'INVALID_EXPORT_OPTIONS');
  }

  const opts = rawExportOptions ? { ...rawExportOptions } : {};
  const splitMode = opts.splitMode === undefined ? 'single' : String(opts.splitMode);
  if (!PDF_SPLIT_MODES.includes(splitMode)) {
    throw new HttpError(
      400,
      `splitMode inválido: ${splitMode}. Valores permitidos: ${PDF_SPLIT_MODES.join(', ')}.`,
      'INVALID_SPLIT_MODE'
    );
  }

  let sheetsPerPdf = 10;
  if (opts.sheetsPerPdf !== undefined && opts.sheetsPerPdf !== null && opts.sheetsPerPdf !== '') {
    const parsedSheets = Number(opts.sheetsPerPdf);
    if (!Number.isFinite(parsedSheets)) {
      throw new HttpError(400, 'sheetsPerPdf debe ser un número finito.', 'INVALID_EXPORT_OPTIONS');
    }
    sheetsPerPdf = Math.max(1, Math.min(50, Math.floor(parsedSheets)));
  }

  const allowLargePoster = Boolean(opts.allowLargePoster || !validatedConfig.mosaicMode);

  return {
    ...opts,
    splitMode,
    sheetsPerPdf,
    allowLargePoster,
  };
}

export async function exportPdfHandler(req, res, next) {
  try {
    const payload = req.body;
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !payload.config ||
      typeof payload.config !== 'object' ||
      Array.isArray(payload.config)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Solicitud de exportación PDF inválida: se requiere el objeto "config".',
        code: 'INVALID_PDF_REQUEST',
      });
    }

    const validatedConfig = validateAndNormalizeMosaicConfig(payload.config);
    const baseCheck = validateMosaicConfig(validatedConfig);
    if (!baseCheck.valid) {
      throw new HttpError(
        400,
        `Configuración de exportación PDF inválida: ${baseCheck.errors.join(' ')}`,
        'INVALID_CONFIG'
      );
    }

    const normalizedExportOptions = normalizeExportOptions(payload.exportOptions, validatedConfig);

    const normalizedPayload = {
      ...payload,
      config: validatedConfig,
      exportOptions: normalizedExportOptions,
    };
    if (!normalizedPayload.grid && Array.isArray(normalizedPayload.gridRle)) {
      normalizedPayload.grid = { rle: normalizedPayload.gridRle };
    }

    const result = await generateSplitPdfExport(normalizedPayload, async (sourceImageId) => {
      const buf = await readUploadedImageBuffer(sourceImageId);
      if (!buf) {
        throw new HttpError(
          400,
          `La imagen referenciada (sourceImageId=${sourceImageId}) no existe en storage/uploads/.`,
          'SOURCE_IMAGE_NOT_FOUND'
        );
      }
      return buf;
    });

    if (result.kind === 'zip') {
      const filename = sanitizeDownloadFilename(result.filename, '.zip');
      const zipBuffer = Buffer.from(result.bytes);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-PDF-Pages', String(result.pageCount));
      res.setHeader('X-PDF-Count', String(result.pdfCount));

      return res.status(200).send(zipBuffer);
    }

    const filename = sanitizeDownloadFilename(result.filename, '.pdf');
    const pdfBuffer = Buffer.from(result.bytes);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-PDF-Pages', String(result.pageCount));
    res.setHeader('X-PDF-Count', '1');

    return res.status(200).send(pdfBuffer);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({
        ok: false,
        error: err.message,
        code: err.code,
      });
    }

    // Errores de validación lanzados por pdfService / printGrid / contracts / mosaicCore
    const msg = err?.message || 'Error al generar el PDF.';
    return res.status(400).json({
      ok: false,
      error: msg,
      code: 'PDF_GENERATION_FAILED',
    });
  }
}
