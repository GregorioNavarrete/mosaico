import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../../src/app.js';
import { bootstrapRuntimeDirs } from '../../src/server.js';
import {
  MAX_PDF_PAGES_POSTER,
  PDF_SPLIT_MODES,
  POSTER_FILTER_MODES,
  createDefaultConfig,
} from '../../src/shared/contracts.js';
import { deleteUploadedImage } from '../../src/services/imageSecurityService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

function parseZipEntries(zipBytes) {
  const buf = Buffer.from(zipBytes);
  assert.equal(buf[0], 0x50); // 'P'
  assert.equal(buf[1], 0x4b); // 'K'
  assert.equal(buf[2], 0x03);
  assert.equal(buf[3], 0x04);

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

  assert.equal(buf.readUInt32LE(pos), 0x02014b50, 'Falta firma de Central Directory PK\\x01\\x02');
  const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdOffset > pos, 'Falta firma EOCD PK\\x05\\x06');
  assert.equal(buf.readUInt16LE(eocdOffset + 8), entries.length);
  assert.equal(buf.readUInt16LE(eocdOffset + 10), entries.length);

  return entries;
}

test('GET /api/health y GET /api/meta/defaults exponen features y contratos de Póster + Split PDF', async () => {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.phase, 'fase-2');
    assert.deepEqual(health.features, ['poster-contrast', 'split-pdf-zip', 'camera-ar-4pt']);

    const defaultsRes = await fetch(`${baseUrl}/api/meta/defaults`);
    assert.equal(defaultsRes.status, 200);
    const defaults = await defaultsRes.json();
    assert.deepEqual(defaults.posterFilterModes, POSTER_FILTER_MODES);
    assert.deepEqual(defaults.pdfSplitModes, PDF_SPLIT_MODES);
    assert.equal(defaults.maxPdfPagesPoster, MAX_PDF_PAGES_POSTER);
    assert.equal(defaults.defaultConfig.posterFilterMode, 'color');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST/GET /api/projects y POST /api/export/pdf soportan Modo Póster, splitMode single/batches/per_sheet y validación 400', async (t) => {
  await bootstrapRuntimeDirs();
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createdProjectIds = [];
  const createdUploadIds = [];

  t.after(async () => {
    for (const pid of createdProjectIds) {
      await fetch(`${baseUrl}/api/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
      await fs.rm(path.join(ROOT_DIR, 'storage/projects', `${pid}.json`), { force: true }).catch(() => {});
    }
    for (const uid of createdUploadIds) {
      await deleteUploadedImage(uid).catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
  });

  // Subir imagen de prueba para exportar en Modo Póster real
  const samplePng = await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: { r: 210, g: 120, b: 64 },
    },
  })
    .png()
    .toBuffer();

  const uploadForm = new FormData();
  uploadForm.append('image', new Blob([samplePng], { type: 'image/png' }), 'poster_ref.png');
  const uploadRes = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    body: uploadForm,
  });
  assert.equal(uploadRes.status, 201);
  const uploadJson = await uploadRes.json();
  const sourceImageId = uploadJson.image.id;
  createdUploadIds.push(sourceImageId);

  // 1. Guardar y recuperar proyecto con configuración de Modo Póster
  const posterConfig = {
    ...createDefaultConfig(),
    widthCm: 50,
    heightCm: 35,
    paperFormat: 'A4',
    orientation: 'portrait',
    marginCm: 1.0,
    overlapCm: 0.5,
    mosaicMode: false,
    posterFilterMode: 'line_art',
    posterContrast: 1.8,
    posterBrightness: -10,
    posterThreshold: 140,
    posterInvert: true,
  };

  const createRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Póster Boceto Line Art',
      sourceImageId,
      sourceName: 'poster_ref.png',
      config: posterConfig,
    }),
  });
  assert.equal(createRes.status, 201);
  const createJson = await createRes.json();
  assert.equal(createJson.ok, true);
  const projectId = createJson.project.id;
  createdProjectIds.push(projectId);

  const getRes = await fetch(`${baseUrl}/api/projects/${projectId}`);
  assert.equal(getRes.status, 200);
  const getJson = await getRes.json();
  assert.equal(getJson.project.config.mosaicMode, false);
  assert.equal(getJson.project.config.posterFilterMode, 'line_art');
  assert.equal(getJson.project.config.posterContrast, 1.8);
  assert.equal(getJson.project.config.posterBrightness, -10);
  assert.equal(getJson.project.config.posterThreshold, 140);
  assert.equal(getJson.project.config.posterInvert, true);

  // 2. POST /api/export/pdf en Modo Póster (splitMode: 'single') -> 50x35 cm en A4 = 3x2 = 6 hojas + 1 portada = 7 págs
  const singleRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceImageId,
      sourceName: 'poster_ref.png',
      config: getJson.project.config,
      exportOptions: {
        splitMode: 'single',
        includeCover: true,
        includePalette: false,
      },
    }),
  });
  assert.equal(singleRes.status, 200);
  assert.equal(singleRes.headers.get('content-type'), 'application/pdf');
  assert.equal(singleRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(singleRes.headers.get('x-pdf-pages'), '7');
  assert.equal(singleRes.headers.get('x-pdf-count'), '1');
  assert.match(singleRes.headers.get('content-disposition') || '', /^attachment; filename=".*\.pdf"$/);

  const singlePdfBuf = Buffer.from(await singleRes.arrayBuffer());
  assert.equal(singlePdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');
  const singlePdf = await PDFDocument.load(singlePdfBuf);
  assert.equal(singlePdf.getPageCount(), 7);

  // 3. POST /api/export/pdf con splitMode: 'batches' (sheetsPerPdf: 2 -> 6 hojas en 3 lotes de 2)
  const batchesRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceImageId,
      sourceName: 'poster_ref.png',
      config: getJson.project.config,
      exportOptions: {
        splitMode: 'batches',
        sheetsPerPdf: 2,
        includeCover: true,
      },
    }),
  });
  assert.equal(batchesRes.status, 200);
  assert.equal(batchesRes.headers.get('content-type'), 'application/zip');
  assert.equal(batchesRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(batchesRes.headers.get('x-pdf-count'), '3');
  assert.equal(batchesRes.headers.get('x-pdf-pages'), '7');
  assert.match(batchesRes.headers.get('content-disposition') || '', /^attachment; filename=".*\.zip"$/);

  const batchesZipBuf = Buffer.from(await batchesRes.arrayBuffer());
  const batchEntries = parseZipEntries(batchesZipBuf);
  assert.equal(batchEntries.length, 3);
  const expectedBatchPages = [3, 2, 2]; // Lote 1: portada + 2 hojas, Lotes 2 y 3: 2 hojas c/u
  for (let i = 0; i < batchEntries.length; i++) {
    assert.ok(batchEntries[i].name.endsWith('.pdf'));
    assert.equal(batchEntries[i].data.subarray(0, 5).toString('ascii'), '%PDF-');
    const doc = await PDFDocument.load(batchEntries[i].data);
    assert.equal(doc.getPageCount(), expectedBatchPages[i]);
  }

  // 4. POST /api/export/pdf con splitMode: 'per_sheet' -> 6 PDFs dentro del ZIP
  const perSheetRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceImageId,
      sourceName: 'poster_ref.png',
      config: getJson.project.config,
      exportOptions: {
        splitMode: 'per_sheet',
        includeCover: true,
      },
    }),
  });
  assert.equal(perSheetRes.status, 200);
  assert.equal(perSheetRes.headers.get('content-type'), 'application/zip');
  assert.equal(perSheetRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(perSheetRes.headers.get('x-pdf-count'), '6');
  assert.equal(perSheetRes.headers.get('x-pdf-pages'), '7');
  assert.match(perSheetRes.headers.get('content-disposition') || '', /^attachment; filename=".*\.zip"$/);

  const perSheetZipBuf = Buffer.from(await perSheetRes.arrayBuffer());
  const perSheetEntries = parseZipEntries(perSheetZipBuf);
  assert.equal(perSheetEntries.length, 6);
  for (let i = 0; i < perSheetEntries.length; i++) {
    assert.ok(perSheetEntries[i].name.endsWith('.pdf'));
    assert.equal(perSheetEntries[i].data.subarray(0, 5).toString('ascii'), '%PDF-');
    const doc = await PDFDocument.load(perSheetEntries[i].data);
    assert.equal(doc.getPageCount(), i === 0 ? 2 : 1);
  }

  // 5. Rechazo HTTP 400 ante splitMode inválido
  const badSplitRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceImageId,
      config: getJson.project.config,
      exportOptions: {
        splitMode: 'invalido',
      },
    }),
  });
  assert.equal(badSplitRes.status, 400);
  const badSplitJson = await badSplitRes.json();
  assert.equal(badSplitJson.ok, false);
  assert.equal(badSplitJson.code, 'INVALID_SPLIT_MODE');
});
