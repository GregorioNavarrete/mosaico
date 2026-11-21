import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { applyPosterReferenceRgba } from '../../src/shared/preprocess.js';
import {
  buildZipArchive,
  generatePdf1to1,
  generateSplitPdfExport,
} from '../../src/services/pdfService.js';

function parseZipEntries(zipBytes) {
  const buf = Buffer.from(zipBytes);
  const entries = [];
  let pos = 0;

  while (pos + 4 <= buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x04034b50) break;

    const method = buf.readUInt16LE(pos + 8);
    const crc = buf.readUInt32LE(pos + 14);
    const compSize = buf.readUInt32LE(pos + 18);
    const uncompSize = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);

    const nameStart = pos + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    const data = method === 8 ? zlib.inflateRawSync(compData) : compData;
    assert.equal(data.length, uncompSize, `Tamaño descomprimido incorrecto para ${name}`);
    assert.equal(zlib.crc32(data) >>> 0, crc, `CRC32 inválido para ${name}`);

    entries.push({ name, method, data });
    pos = dataStart + compSize;
  }

  // Verificar existencia de Central Directory (PK\x01\x02) y EOCD (PK\x05\x06)
  assert.equal(buf.readUInt32LE(pos), 0x02014b50, 'Falta firma de Central Directory PK\\x01\\x02');
  const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdOffset > pos, 'Falta firma EOCD PK\\x05\\x06');
  assert.equal(buf.readUInt16LE(eocdOffset + 8), entries.length);
  assert.equal(buf.readUInt16LE(eocdOffset + 10), entries.length);

  return entries;
}

test('applyPosterReferenceRgba soporta color, grayscale, contrast_bw, line_art e invert preservando alfa', () => {
  const w = 6;
  const h = 6;
  const rgba = new Uint8ClampedArray(w * h * 4);

  // Mitad izquierda oscura (30, 60, 90), mitad derecha brillante (240, 210, 180)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (x < 3) {
        rgba[idx] = 30;
        rgba[idx + 1] = 60;
        rgba[idx + 2] = 90;
      } else {
        rgba[idx] = 240;
        rgba[idx + 1] = 210;
        rgba[idx + 2] = 180;
      }
      rgba[idx + 3] = (x + y) % 2 === 0 ? 255 : 173;
    }
  }

  // 1. Modo color sin cambios -> copia rápida exacta
  const colorIdentity = applyPosterReferenceRgba(rgba, w, h, {
    filterMode: 'color',
    contrast: 1,
    brightness: 0,
    invert: false,
  });
  assert.notEqual(colorIdentity, rgba);
  assert.deepEqual(colorIdentity, rgba);

  // 2. Modo color con contraste, brillo e inversión
  const colorAdj = applyPosterReferenceRgba(rgba, w, h, {
    filterMode: 'color',
    contrast: 1.5,
    brightness: 10,
    invert: true,
  });
  assert.equal(colorAdj[3], 255);
  assert.equal(colorAdj[7], 173);
  assert.notEqual(colorAdj[0], rgba[0]);

  // 3. Modo grayscale BT.601 (0.299*30 + 0.587*60 + 0.114*90 = 54.45)
  const gray = applyPosterReferenceRgba(rgba, w, h, {
    filterMode: 'grayscale',
    contrast: 1,
    brightness: 0,
    invert: false,
  });
  assert.equal(gray[0], 54);
  assert.equal(gray[1], 54);
  assert.equal(gray[2], 54);
  assert.equal(gray[3], 255);
  assert.equal(gray[7], 173);

  // 4. Modo contrast_bw normal e invertido
  const bw = applyPosterReferenceRgba(rgba, w, h, {
    filterMode: 'contrast_bw',
    contrast: 1,
    brightness: 0,
    threshold: 128,
    invert: false,
  });
  const bwInv = applyPosterReferenceRgba(rgba, w, h, {
    filterMode: 'contrast_bw',
    contrast: 1,
    brightness: 0,
    threshold: 128,
    invert: true,
  });
  assert.equal(bw[0], 0); // oscuro -> negro
  assert.equal(bw[(0 * w + 5) * 4], 255); // claro -> blanco
  assert.equal(bwInv[0], 255);
  assert.equal(bwInv[(0 * w + 5) * 4], 0);
  assert.equal(bw[7], 173); // alfa intacto

  // 5. Modo line_art (Sobel 3x3): borde central x=2,3 debe marcar trazo negro (0) sobre papel blanco (255)
  const lineArt = applyPosterReferenceRgba(rgba, w, h, {
    filterMode: 'line_art',
    contrast: 1.2,
    brightness: 0,
    threshold: 140,
    invert: false,
  });
  assert.equal(lineArt[(2 * w + 0) * 4], 255); // zona plana izquierda -> papel blanco
  assert.equal(lineArt[(2 * w + 2) * 4], 0);   // borde -> trazo oscuro
  assert.equal(lineArt[(2 * w + 3) * 4], 0);   // borde -> trazo oscuro
  assert.equal(lineArt[(2 * w + 5) * 4], 255); // zona plana derecha -> papel blanco
  assert.equal(lineArt[(2 * w + 1) * 4 + 3], rgba[(2 * w + 1) * 4 + 3]); // alfa preservado

  const lineArtInv = applyPosterReferenceRgba(rgba, w, h, {
    filterMode: 'line_art',
    contrast: 1.2,
    brightness: 0,
    threshold: 140,
    invert: true,
  });
  assert.equal(lineArtInv[(2 * w + 0) * 4], 0);
  assert.equal(lineArtInv[(2 * w + 2) * 4], 255);
});

test('generatePdf1to1 soporta póster gigante 400x300 cm con allowLargePoster sin desbordar RAM', async () => {
  const startMs = Date.now();
  const res = await generatePdf1to1({
    sourceName: 'poster_gigante_400x300.svg',
    config: {
      widthCm: 400,
      heightCm: 300,
      paperFormat: 'A4',
      orientation: 'portrait',
      marginCm: 1.0,
      overlapCm: 0.5,
      mosaicMode: false,
      posterFilterMode: 'line_art',
      posterContrast: 1.3,
      posterBrightness: 5,
      posterThreshold: 140,
      posterInvert: false,
    },
    exportOptions: {
      allowLargePoster: true,
      includeCover: true,
    },
  });
  const elapsedMs = Date.now() - startMs;

  // 400x300 cm en A4 portrait (Ux=19, stepX=18.5; Uy=27.7, stepY=27.2) => Nx=22, Ny=12 => 264 hojas + 1 portada = 265 páginas
  assert.equal(res.sheetsIncluded.length, 264);
  assert.equal(res.pageCount, 265);
  assert.ok(res.pdfBytes.subarray(0, 5).every((b, idx) => b === '%PDF-'.charCodeAt(idx)));
  assert.ok(elapsedMs < 20000, `Póster 400x300 cm tardó demasiado: ${elapsedMs} ms`);
});

test('buildZipArchive y generateSplitPdfExport generan ZIP válido en modos batches y per_sheet', async () => {
  // 60x40 cm en A4 portrait => Nx=4, Ny=2 => 8 hojas (A1..A4, B1..B4)
  const baseRequest = {
    sourceName: 'mural_poster.png',
    config: {
      widthCm: 60,
      heightCm: 40,
      paperFormat: 'A4',
      orientation: 'portrait',
      marginCm: 1.0,
      overlapCm: 0.5,
      mosaicMode: false,
      posterFilterMode: 'contrast_bw',
      posterContrast: 1.4,
      posterThreshold: 132,
      posterInvert: false,
    },
  };

  // 1. Modo batches (3 hojas por PDF -> 3 lotes: 3 + 3 + 2 hojas)
  const batchRes = await generateSplitPdfExport({
    ...baseRequest,
    exportOptions: {
      splitMode: 'batches',
      sheetsPerPdf: 3,
      includeCover: true,
    },
  });

  assert.equal(batchRes.kind, 'zip');
  assert.equal(batchRes.pdfCount, 3);
  assert.equal(batchRes.sheetsIncluded.length, 8);
  assert.equal(batchRes.pageCount, 9); // 1 portada en lote 1 + 8 hojas totales
  assert.equal(batchRes.bytes[0], 0x50); // 'P'
  assert.equal(batchRes.bytes[1], 0x4b); // 'K'
  assert.equal(batchRes.bytes[2], 0x03);
  assert.equal(batchRes.bytes[3], 0x04);

  const batchEntries = parseZipEntries(batchRes.bytes);
  assert.equal(batchEntries.length, 3);

  const expectedBatchPages = [4, 3, 2]; // Lote 1 incluye portada (1+3), Lote 2 (3), Lote 3 (2)
  for (let i = 0; i < batchEntries.length; i++) {
    assert.equal(batchEntries[i].data.subarray(0, 5).toString('ascii'), '%PDF-');
    const doc = await PDFDocument.load(batchEntries[i].data);
    assert.equal(doc.getPageCount(), expectedBatchPages[i]);
  }

  // 2. Modo per_sheet (8 PDFs individuales)
  const perSheetRes = await generateSplitPdfExport({
    ...baseRequest,
    exportOptions: {
      splitMode: 'per_sheet',
      includeCover: true,
    },
  });

  assert.equal(perSheetRes.kind, 'zip');
  assert.equal(perSheetRes.pdfCount, 8);
  assert.equal(perSheetRes.sheetsIncluded.length, 8);
  assert.equal(perSheetRes.pageCount, 9); // 1 portada en hoja 1 + 8 hojas

  const perSheetEntries = parseZipEntries(perSheetRes.bytes);
  assert.equal(perSheetEntries.length, 8);
  for (let i = 0; i < perSheetEntries.length; i++) {
    assert.equal(perSheetEntries[i].data.subarray(0, 5).toString('ascii'), '%PDF-');
    const doc = await PDFDocument.load(perSheetEntries[i].data);
    assert.equal(doc.getPageCount(), i === 0 ? 2 : 1);
  }

  // 3. Modo single retorna PDF directo
  const singleRes = await generateSplitPdfExport({
    ...baseRequest,
    exportOptions: {
      splitMode: 'single',
      includeCover: true,
    },
  });
  assert.equal(singleRes.kind, 'pdf');
  assert.equal(singleRes.pdfCount, 1);
  assert.equal(singleRes.pageCount, 9);

  // 4. buildZipArchive con entradas mixtas vacías y comprimibles
  const customZip = buildZipArchive([
    { name: 'nota.txt', data: Buffer.from('GuiaMosaico '.repeat(50), 'utf8') },
    { name: 'bin.dat', data: Uint8Array.from([1, 2, 3, 4]) },
  ]);
  const customEntries = parseZipEntries(customZip);
  assert.equal(customEntries.length, 2);
  assert.equal(customEntries[0].name, 'nota.txt');
  assert.deepEqual(Array.from(customEntries[1].data), [1, 2, 3, 4]);
});
