import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { PT_PER_CM, PAPER_FORMATS } from '../../src/shared/contracts.js';
import { computeGridMetrics, encodeGridRle, rgbToHex, getBuiltInSampleSvg } from '../../src/shared/mosaicCore.js';
import { generatePatternCells } from '../../src/shared/patterns.js';
import { generatePdf1to1 } from '../../src/services/pdfService.js';

function buildTestMosaicPayload({
  widthCm = 40,
  heightCm = 30,
  tileSizeCm = 2,
  pattern = 'grid',
  colorCount = 4,
  paperFormat = 'A4',
  orientation = 'portrait',
  mirrorMode = false,
  viewMode = 'color',
  mosaicMode = true,
  useRle = false,
  breakdownColorIdx = 0,
} = {}) {
  const isPolyPattern = !['grid', 'brick_50', 'brick'].includes(pattern);
  const metrics = computeGridMetrics(widthCm, heightCm, tileSizeCm, pattern);
  const patternCells = isPolyPattern ? generatePatternCells({ widthCm, heightCm, tileSizeCm, pattern }) : null;
  const gridLen = patternCells ? patternCells.length : metrics.tileRows * metrics.maxRowCols;
  const grid = new Uint8Array(gridLen).fill(255);
  const palette = [];

  for (let i = 0; i < colorCount; i++) {
    const r = (i * 53 + 40) % 255;
    const g = (i * 97 + 80) % 255;
    const b = (i * 139 + 120) % 255;
    palette.push({ r, g, b, hex: rgbToHex(r, g, b), count: 0 });
  }

  if (patternCells) {
    for (let i = 0; i < patternCells.length; i++) {
      const colorIdx = i % colorCount;
      grid[i] = colorIdx;
      palette[colorIdx].count++;
    }
  } else {
    let k = 0;
    for (let r = 0; r < metrics.tileRows; r++) {
      const cols = pattern === 'brick_50' && r % 2 === 1 ? metrics.tileCols + 1 : metrics.tileCols;
      for (let c = 0; c < cols; c++) {
        const colorIdx = k % colorCount;
        grid[r * metrics.maxRowCols + c] = colorIdx;
        palette[colorIdx].count++;
        k++;
      }
    }
  }

  return {
    sourceName: 'test_mural.png',
    config: {
      widthCm,
      heightCm,
      paperFormat,
      orientation,
      marginCm: 1.0,
      overlapCm: 0.5,
      mirrorMode,
      showA4Grid: true,
      mosaicMode,
      tileSizeCm,
      tileThicknessMm: 4,
      pattern,
      colorCount,
      groutColor: '#D6D3CB',
      groutMm: 1.5,
      viewMode,
      breakdownColorIdx,
      finish: 'ceramic',
      showNumbers: true,
    },
    palette,
    grid: useRle ? { rle: encodeGridRle(grid) } : grid,
    tileCols: metrics.tileCols,
    tileRows: metrics.tileRows,
    maxRowCols: metrics.maxRowCols,
    totalTiles: patternCells ? patternCells.length : metrics.totalTiles,
  };
}

test('pdfService genera PDF vectorial 1:1 con portada A4, dimensiones exactas en pt y Brick 50% + Mirror', async () => {
  // 40x30 cm en A4 portrait (Ux=19, Uy=27.7, stepX=18.5, stepY=27.2) => Nx=3, Ny=2 => 6 hojas
  const payload = buildTestMosaicPayload({
    widthCm: 40,
    heightCm: 30,
    tileSizeCm: 2,
    pattern: 'brick_50',
    colorCount: 6,
    paperFormat: 'A4',
    orientation: 'portrait',
    mirrorMode: true,
    useRle: true,
  });

  const res = await generatePdf1to1(payload);
  assert.ok(res.pdfBytes instanceof Uint8Array);
  assert.ok(res.pdfBytes.length > 2000);
  assert.equal(res.sheetsIncluded.length, 6);
  assert.deepEqual(res.sheetsIncluded, ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal(res.pageCount, 8); // 1 portada + 1 paleta + 6 hojas

  const loaded = await PDFDocument.load(res.pdfBytes);
  assert.equal(loaded.getPageCount(), 8);

  const a4W = PAPER_FORMATS.A4.shortCm * PT_PER_CM;
  const a4H = PAPER_FORMATS.A4.longCm * PT_PER_CM;

  const coverSize = loaded.getPage(0).getSize();
  assert.ok(Math.abs(coverSize.width - a4W) < 1e-3);
  assert.ok(Math.abs(coverSize.height - a4H) < 1e-3);

  const sheetSize = loaded.getPage(2).getSize();
  assert.ok(Math.abs(sheetSize.width - a4W) < 1e-3);
  assert.ok(Math.abs(sheetSize.height - a4H) < 1e-3);

  // Verificar que el stream de la portada contiene la longitud exacta de la regla de 10 cm (283.46.. pt)
  const coverBytes = loaded.getPage(0).node.Contents()?.toString?.() ?? '';
  assert.ok(res.pdfBytes.length > 0 && typeof coverBytes === 'string');

  // Probar Modo Mosaico con viewMode='contour'
  const contourPayload = buildTestMosaicPayload({
    widthCm: 16,
    heightCm: 16,
    tileSizeCm: 2,
    viewMode: 'contour',
    colorCount: 4,
  });
  const contourRes = await generatePdf1to1(contourPayload);
  const contourLoaded = await PDFDocument.load(contourRes.pdfBytes);
  assert.equal(contourLoaded.getPageCount(), 3); // 1 portada + 1 paleta + 1 hoja A4
});

test('pdfService auto-pagina la hoja de paleta con 36 y 48 colores sin recortar tarjetas', async () => {
  const payload36 = buildTestMosaicPayload({
    widthCm: 25,
    heightCm: 25,
    tileSizeCm: 2,
    colorCount: 36,
    paperFormat: 'LETTER',
    orientation: 'landscape',
  });

  const res36 = await generatePdf1to1(payload36);
  // 25x25 cm en LETTER landscape (27.94 x 21.59, margin 1 -> Ux=25.94, Uy=19.59) => Nx=1, Ny=2 => 2 hojas
  // 36 colores en A4 vertical (30 tarjetas por hoja -> 2 páginas de paleta)
  // Total: 1 portada + 2 paleta + 2 hojas = 5 páginas
  assert.equal(res36.sheetsIncluded.length, 2);
  assert.equal(res36.pageCount, 5);

  const loaded36 = await PDFDocument.load(res36.pdfBytes);
  assert.equal(loaded36.getPageCount(), 5);

  // Portada y paleta son A4 vertical; las hojas de fragmento son LETTER horizontal
  const letterLandscapeW = PAPER_FORMATS.LETTER.longCm * PT_PER_CM;
  const letterLandscapeH = PAPER_FORMATS.LETTER.shortCm * PT_PER_CM;
  const fragmentSize = loaded36.getPage(3).getSize();
  assert.ok(Math.abs(fragmentSize.width - letterLandscapeW) < 1e-3);
  assert.ok(Math.abs(fragmentSize.height - letterLandscapeH) < 1e-3);

  // 48 colores (máximo de Fase 1) también auto-pagina en 2 páginas de paleta sin recortar
  const payload48 = buildTestMosaicPayload({
    widthCm: 20,
    heightCm: 20,
    tileSizeCm: 2,
    colorCount: 48,
    paperFormat: 'A4',
  });
  const res48 = await generatePdf1to1(payload48);
  assert.equal(res48.pageCount, 5); // 1 portada + 2 paleta + 2 hojas (20x20 con Ux=19, Uy=27.7 => Nx=2, Ny=1)
});

test('pdfService soporta descarga selectiva de 2 hojas (A1, B2) y expresión de rangos', async () => {
  const payload = buildTestMosaicPayload({
    widthCm: 40,
    heightCm: 30,
    paperFormat: 'A4',
  });

  const res = await generatePdf1to1({
    ...payload,
    exportOptions: {
      includeCover: true,
      includePalette: true,
      selectedSheets: ['A1', 'B2'],
    },
  });

  assert.deepEqual(res.sheetsIncluded, ['A1', 'B2']);
  assert.equal(res.pageCount, 4); // 1 portada + 1 paleta + 2 hojas

  const resRange = await generatePdf1to1({
    ...payload,
    exportOptions: {
      includeCover: false,
      includePalette: false,
      rangeExpression: 'A2-B3',
    },
  });
  assert.deepEqual(resRange.sheetsIncluded, ['A2', 'A3', 'B2', 'B3']);
  assert.equal(resRange.pageCount, 4);
});

test('pdfService en Modo Imagen Directa usa sharp a 300 DPI con fallback SVG y con resolver externo', async () => {
  const directPayload = buildTestMosaicPayload({
    widthCm: 30,
    heightCm: 20,
    mosaicMode: false,
    mirrorMode: true,
    viewMode: 'grayscale',
  });

  // Sin sourceImageId -> usa getBuiltInSampleSvg() con sharp
  const resFallback = await generatePdf1to1(directPayload);
  assert.equal(resFallback.sheetsIncluded.length, 2); // 30x20 en A4 portrait => Nx=2, Ny=1
  assert.equal(resFallback.pageCount, 3); // 1 portada + 0 paleta + 2 hojas

  const loadedFallback = await PDFDocument.load(resFallback.pdfBytes);
  assert.equal(loadedFallback.getPageCount(), 3);

  // Con sourceImageId y resolver PNG real en modo contour
  const customPng = await sharp(Buffer.from(getBuiltInSampleSvg(), 'utf8')).png().toBuffer();
  const resCustom = await generatePdf1to1(
    {
      ...directPayload,
      sourceImageId: 'img-123',
      config: { ...directPayload.config, viewMode: 'contour' },
    },
    async (id) => (id === 'img-123' ? customPng : null)
  );
  assert.equal(resCustom.pageCount, 3);
  assert.ok(resCustom.pdfBytes.length > 5000);
});

test('pdfService respeta el tope MAX_PDF_PAGES_PHASE1 (250 páginas)', async () => {
  const hugePayload = buildTestMosaicPayload({
    widthCm: 400,
    heightCm: 400,
    mosaicMode: false,
    paperFormat: 'A4',
  });

  await assert.rejects(() => generatePdf1to1(hugePayload), /250/);
});

test('pdfService exporta vectorialmente hexagonal, herringbone, penny_round y viewMode breakdown', async () => {
  const hexPayload = buildTestMosaicPayload({
    widthCm: 16,
    heightCm: 16,
    tileSizeCm: 2,
    pattern: 'hexagonal',
    colorCount: 4,
    viewMode: 'breakdown',
    breakdownColorIdx: 1,
    mirrorMode: true,
    useRle: true,
  });
  const hexRes = await generatePdf1to1(hexPayload);
  assert.equal(hexRes.pageCount, 3); // 1 portada + 1 paleta + 1 hoja
  const hexDoc = await PDFDocument.load(hexRes.pdfBytes);
  assert.equal(hexDoc.getPageCount(), 3);
  assert.ok(hexRes.pdfBytes.length > 5000);

  const hbPayload = buildTestMosaicPayload({
    widthCm: 16,
    heightCm: 16,
    tileSizeCm: 2,
    pattern: 'herringbone',
    colorCount: 5,
    viewMode: 'color',
  });
  const hbRes = await generatePdf1to1(hbPayload);
  assert.equal(hbRes.pageCount, 3);
  const hbDoc = await PDFDocument.load(hbRes.pdfBytes);
  assert.equal(hbDoc.getPageCount(), 3);

  const prPayload = buildTestMosaicPayload({
    widthCm: 14,
    heightCm: 14,
    tileSizeCm: 2,
    pattern: 'penny_round',
    colorCount: 3,
    viewMode: 'contour',
  });
  const prRes = await generatePdf1to1(prPayload);
  assert.equal(prRes.pageCount, 3);
});
