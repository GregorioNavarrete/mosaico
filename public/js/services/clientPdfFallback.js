import { PT_PER_CM, getPaperDimensionsCm, computePrintGrid, getRowLabel } from '/shared/printGrid.js';

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function concatUint8Arrays(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function dataUrlToJpegBytes(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return new Uint8Array(0);
  const b64 = dataUrl.slice(commaIdx + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generador PDF 1.4 puro en navegador (sin dependencias externas ni servidor)
 * usado como respaldo automático si el hosting limita el endpoint /api/export/pdf.
 */
export async function generateClientPdfFallback({
  config,
  sourceCanvas,
  selectedSheets = null,
  includeCover = true,
  doc = typeof document !== 'undefined' ? document : null,
}) {
  if (!doc || !sourceCanvas) {
    throw new Error('No hay lienzo disponible para generar el PDF en el navegador.');
  }

  const gridMetrics = computePrintGrid(config);
  const paper = getPaperDimensionsCm(
    config.paperType,
    config.paperOrientation,
    config.customPaperWidthCm,
    config.customPaperHeightCm
  );

  const pageWidthPt = paper.widthCm * PT_PER_CM;
  const pageHeightPt = paper.heightCm * PT_PER_CM;
  const marginPt = (Number(config.marginCm) || 0.8) * PT_PER_CM;
  const usableWidthPt = gridMetrics.usableWidthCm * PT_PER_CM;
  const usableHeightPt = gridMetrics.usableHeightCm * PT_PER_CM;

  const selectedSet =
    Array.isArray(selectedSheets) && selectedSheets.length > 0 ? new Set(selectedSheets) : null;

  const sheets = [];
  for (let r = 0; r < gridMetrics.rows; r++) {
    for (let c = 0; c < gridMetrics.cols; c++) {
      const label = `${getRowLabel(r)}${c + 1}`;
      if (!selectedSet || selectedSet.has(label)) {
        sheets.push({ r, c, label });
      }
    }
  }

  // Construir objetos PDF 1.4
  const objects = [];
  const addObj = (bodyBytesOrStr) => {
    const id = objects.length + 1;
    const bytes = typeof bodyBytesOrStr === 'string' ? utf8Bytes(bodyBytesOrStr) : bodyBytesOrStr;
    objects.push({ id, bytes });
    return id;
  };

  const catalogId = addObj(''); // placeholder 1
  const pagesId = addObj(''); // placeholder 2
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBoldId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const pageIds = [];

  // Portada opcional
  if (includeCover) {
    const coverW = 595.28;
    const coverH = 841.89;
    const lines = [
      'BT',
      '/F2 20 Tf',
      '50 780 Td',
      '(GuiaMosaico - Plantilla 1:1) Tj',
      '/F1 11 Tf',
      '0 -28 Td',
      `(Dimensiones mural: ${config.widthCm} x ${config.heightCm} cm) Tj`,
      '0 -18 Td',
      `(Papel: ${config.paperType} ${config.paperOrientation} | Hojas: ${sheets.length}) Tj`,
      '0 -18 Td',
      `(Modo: ${config.mosaicMode ? 'Mosaico Teselas' : 'Poster / Referencia'} | ${config.mirrorMode ? 'Espejo' : 'Directo'}) Tj`,
      '0 -28 Td',
      '(Verifica la regla de calibracion de 5.0 cm al imprimir sin escalado 100%.) Tj',
      'ET',
      // Regla de 5.0 cm
      '0.2 0.2 0.2 RG 1 w',
      `50 620 ${(5 * PT_PER_CM).toFixed(2)} 12 re S`,
      'BT /F1 9 Tf 50 604 Td (Regla de calibracion exacta: 5.0 cm) Tj ET',
    ].join('\n');

    const streamId = addObj(`<< /Length ${utf8Bytes(lines).length} >>\nstream\n${lines}\nendstream`);
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${coverW} ${coverH}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${streamId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  // Recortar cada hoja del canvas fuente y embeber como JPEG a escala exacta 1:1
  const pxPerCmX = sourceCanvas.width / Math.max(0.1, config.widthCm);
  const pxPerCmY = sourceCanvas.height / Math.max(0.1, config.heightCm);
  const tileCanvas = doc.createElement('canvas');
  const tileCtx = tileCanvas.getContext('2d');

  for (const sheet of sheets) {
    const startXCm = sheet.c * gridMetrics.stepXCm;
    const startYCm = sheet.r * gridMetrics.stepYCm;
    const drawWcm = Math.min(gridMetrics.usableWidthCm, Math.max(0.1, config.widthCm - startXCm));
    const drawHcm = Math.min(gridMetrics.usableHeightCm, Math.max(0.1, config.heightCm - startYCm));

    const sx = Math.max(0, Math.floor(startXCm * pxPerCmX));
    const sy = Math.max(0, Math.floor(startYCm * pxPerCmY));
    const sw = Math.max(1, Math.min(sourceCanvas.width - sx, Math.ceil(drawWcm * pxPerCmX)));
    const sh = Math.max(1, Math.min(sourceCanvas.height - sy, Math.ceil(drawHcm * pxPerCmY)));

    const maxTilePx = 1400;
    const scale = Math.min(1, maxTilePx / Math.max(sw, sh));
    tileCanvas.width = Math.max(1, Math.round(sw * scale));
    tileCanvas.height = Math.max(1, Math.round(sh * scale));

    tileCtx.fillStyle = '#FFFFFF';
    tileCtx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);
    tileCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, tileCanvas.width, tileCanvas.height);

    const jpegDataUrl = tileCanvas.toDataURL('image/jpeg', 0.88);
    const jpegBytes = dataUrlToJpegBytes(jpegDataUrl);

    const imgHeader = utf8Bytes(
      `<< /Type /XObject /Subtype /Image /Width ${tileCanvas.width} /Height ${tileCanvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
    );
    const imgFooter = utf8Bytes('\nendstream');
    const imgObjId = addObj(concatUint8Arrays([imgHeader, jpegBytes, imgFooter]));

    const drawWPt = drawWcm * PT_PER_CM;
    const drawHPt = drawHcm * PT_PER_CM;
    const imgX = marginPt;
    const imgY = pageHeightPt - marginPt - drawHPt;

    const commands = [
      'q',
      `${drawWPt.toFixed(2)} 0 0 ${drawHPt.toFixed(2)} ${imgX.toFixed(2)} ${imgY.toFixed(2)} cm`,
      '/Im0 Do',
      'Q',
      // Marco de corte
      '0.55 0.55 0.55 RG 0.5 w',
      `${marginPt.toFixed(2)} ${(pageHeightPt - marginPt - usableHeightPt).toFixed(2)} ${usableWidthPt.toFixed(2)} ${usableHeightPt.toFixed(2)} re S`,
      // Etiqueta de hoja
      'BT',
      '/F2 10 Tf',
      `${marginPt.toFixed(2)} ${(pageHeightPt - marginPt + 4).toFixed(2)} Td`,
      `(Hoja ${sheet.label} | ${config.widthCm}x${config.heightCm} cm | 1:1) Tj`,
      'ET',
    ].join('\n');

    const contentId = addObj(
      `<< /Length ${utf8Bytes(commands).length} >>\nstream\n${commands}\nendstream`
    );

    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R >> /XObject << /Im0 ${imgObjId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1].bytes = utf8Bytes(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects[pagesId - 1].bytes = utf8Bytes(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  );

  // Ensamblar archivo PDF binario con tabla xref exacta
  const chunks = [utf8Bytes('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')];
  let offset = chunks[0].length;
  const offsets = [0];

  for (const obj of objects) {
    offsets.push(offset);
    const prefix = utf8Bytes(`${obj.id} 0 obj\n`);
    const suffix = utf8Bytes('\nendobj\n');
    chunks.push(prefix, obj.bytes, suffix);
    offset += prefix.length + obj.bytes.length + suffix.length;
  }

  const xrefStart = offset;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i <= objects.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(utf8Bytes(xrefLines.join('') + trailer));

  return {
    bytes: concatUint8Arrays(chunks),
    pageCount: pageIds.length,
    filename: `GuiaMosaico_${config.widthCm}x${config.heightCm}cm_1a1.pdf`,
  };
}
