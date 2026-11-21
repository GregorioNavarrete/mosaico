import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../../src/app.js';
import { bootstrapRuntimeDirs } from '../../src/server.js';
import { createDefaultConfig } from '../../src/shared/contracts.js';
import { computeGridMetrics, encodeGridRle, rgbToHex } from '../../src/shared/mosaicCore.js';
import { deleteUploadedImage, getUploadedImageMeta } from '../../src/services/imageSecurityService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

function buildSampleMosaic(widthCm = 40, heightCm = 30, tileSizeCm = 2, pattern = 'grid') {
  const config = {
    ...createDefaultConfig(),
    widthCm,
    heightCm,
    tileSizeCm,
    pattern,
    mosaicMode: true,
    colorCount: 4,
    paperFormat: 'A4',
    orientation: 'portrait',
  };

  const metrics = computeGridMetrics(widthCm, heightCm, tileSizeCm, pattern);
  const grid = new Uint8Array(metrics.tileRows * metrics.maxRowCols).fill(255);
  const palette = [
    { r: 54, g: 89, b: 77, hex: rgbToHex(54, 89, 77), count: 0 },
    { r: 189, g: 117, b: 78, hex: rgbToHex(189, 117, 78), count: 0 },
    { r: 229, g: 179, b: 124, hex: rgbToHex(229, 179, 124), count: 0 },
    { r: 247, g: 244, b: 237, hex: rgbToHex(247, 244, 237), count: 0 },
  ];

  let idx = 0;
  for (let r = 0; r < metrics.tileRows; r++) {
    const cols = pattern === 'brick_50' && r % 2 === 1 ? metrics.tileCols + 1 : metrics.tileCols;
    for (let c = 0; c < cols; c++) {
      const colorIdx = idx % palette.length;
      grid[r * metrics.maxRowCols + c] = colorIdx;
      palette[colorIdx].count++;
      idx++;
    }
  }

  return {
    config,
    palette,
    gridRle: encodeGridRle(grid),
    metrics,
  };
}

test('API Uploads OWASP + Proyectos JSON/RLE + Exportación PDF 1:1', async (t) => {
  await bootstrapRuntimeDirs();
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createdUploadIds = [];
  const createdProjectIds = [];

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

  // 1. Verificar /api/meta/defaults
  const defaultsRes = await fetch(`${baseUrl}/api/meta/defaults`);
  assert.equal(defaultsRes.status, 200);
  const defaultsBody = await defaultsRes.json();
  assert.ok(defaultsBody.defaultConfig);
  assert.ok(defaultsBody.paperFormats?.A4);

  // 2. Rechazo 400 de archivo .txt disfrazado de .png (spoofing de extensión/MIME)
  const spoofForm = new FormData();
  const fakePngBlob = new Blob([Buffer.from('Esto es texto plano intentando hacerse pasar por PNG', 'utf8')], {
    type: 'image/png',
  });
  spoofForm.append('image', fakePngBlob, 'malicioso.png');

  const spoofRes = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    body: spoofForm,
  });
  assert.equal(spoofRes.status, 400);
  const spoofJson = await spoofRes.json();
  assert.equal(spoofJson.ok, false);
  assert.match(spoofJson.error, /magic bytes|binaria|JPEG|PNG|WebP/i);

  // 3. Subida y lectura válida de PNG generado con sharp (incluyendo validación EXIF removida y headers)
  const validPngBuffer = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 189, g: 117, b: 78 },
    },
  })
    .png()
    .toBuffer();

  const validForm = new FormData();
  validForm.append('image', new Blob([validPngBuffer], { type: 'image/png' }), 'mural_prueba.png');

  const uploadRes = await fetch(`${baseUrl}/api/uploads`, {
    method: 'POST',
    body: validForm,
  });
  assert.equal(uploadRes.status, 201);
  const uploadJson = await uploadRes.json();
  assert.equal(uploadJson.ok, true);
  assert.ok(uploadJson.image?.id);
  assert.equal(uploadJson.image.width, 64);
  assert.equal(uploadJson.image.height, 48);
  assert.equal(uploadJson.image.mimeType, 'image/png');
  assert.equal(uploadJson.image.url, `/api/uploads/${uploadJson.image.id}`);
  createdUploadIds.push(uploadJson.image.id);

  // Verificar getUploadedImageMeta
  const meta = await getUploadedImageMeta(uploadJson.image.id);
  assert.equal(meta?.width, 64);
  assert.equal(meta?.height, 48);

  // Leer imagen subida y verificar headers de seguridad
  const imgGetRes = await fetch(`${baseUrl}${uploadJson.image.url}`);
  assert.equal(imgGetRes.status, 200);
  assert.equal(imgGetRes.headers.get('content-type'), 'image/png');
  assert.equal(imgGetRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(imgGetRes.headers.get('cache-control'), 'private, max-age=3600');
  const downloadedImgBuf = Buffer.from(await imgGetRes.arrayBuffer());
  assert.deepEqual(downloadedImgBuf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // Validar 400 ante UUID inválido / intento de path traversal y 404 ante UUID inexistente
  const badIdRes = await fetch(`${baseUrl}/api/uploads/not-a-uuid`);
  assert.equal(badIdRes.status, 400);

  const traversalRes = await fetch(`${baseUrl}/api/uploads/..%2F..%2Fpackage.json`);
  assert.equal(traversalRes.status, 400);

  const missingImgRes = await fetch(`${baseUrl}/api/uploads/00000000-0000-4000-8000-000000000000`);
  assert.equal(missingImgRes.status, 404);

  // Validar 413 cuando se excede MAX_UPLOAD_MB y subida WebP válida con EXIF eliminado
  const prevMaxMb = process.env.MAX_UPLOAD_MB;
  process.env.MAX_UPLOAD_MB = '0.0001';
  try {
    const bigForm = new FormData();
    bigForm.append('image', new Blob([validPngBuffer], { type: 'image/png' }), 'grande.png');
    const tooLargeRes = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: bigForm,
    });
    assert.equal(tooLargeRes.status, 413);
    const tooLargeJson = await tooLargeRes.json();
    assert.equal(tooLargeJson.ok, false);
  } finally {
    if (prevMaxMb === undefined) delete process.env.MAX_UPLOAD_MB;
    else process.env.MAX_UPLOAD_MB = prevMaxMb;
  }

  const webpBuffer = await sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 54, g: 89, b: 77 } },
  })
    .webp()
    .toBuffer();
  const webpForm = new FormData();
  webpForm.append('image', new Blob([webpBuffer], { type: 'image/webp' }), 'muestra.webp');
  const webpRes = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: webpForm });
  assert.equal(webpRes.status, 201);
  const webpJson = await webpRes.json();
  assert.equal(webpJson.image.mimeType, 'image/png');
  createdUploadIds.push(webpJson.image.id);

  // Verificar que storage/uploads nunca se expone como estático directo
  const staticLeakRes = await fetch(`${baseUrl}/storage/uploads/${uploadJson.image.id}.png`);
  assert.equal(staticLeakRes.status, 404);

  // 4. CRUD completo de proyecto + duplicado + aislamiento de gridRle fuera de data/projects.json
  const mosaic = buildSampleMosaic(40, 30, 2, 'brick_50');
  const createProjRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mural Patio Mediterráneo',
      sourceImageId: uploadJson.image.id,
      sourceName: 'mural_prueba.png',
      aspectRatio: 4 / 3,
      keepRatio: true,
      config: mosaic.config,
      palette: mosaic.palette,
      gridRle: mosaic.gridRle,
      tileCols: mosaic.metrics.tileCols,
      tileRows: mosaic.metrics.tileRows,
      maxRowCols: mosaic.metrics.maxRowCols,
      totalTiles: mosaic.metrics.totalTiles,
    }),
  });
  assert.equal(createProjRes.status, 201);
  const createdProjJson = await createProjRes.json();
  assert.equal(createdProjJson.ok, true);
  assert.equal(createdProjJson.project.name, 'Mural Patio Mediterráneo');
  assert.equal(createdProjJson.project.sourceImageId, uploadJson.image.id);
  assert.equal(createdProjJson.snapshot.projectId, createdProjJson.project.id);
  assert.deepEqual(createdProjJson.snapshot.gridRle, mosaic.gridRle);
  const projectId = createdProjJson.project.id;
  createdProjectIds.push(projectId);

  // Comprobar en disco que data/projects.json NO contiene gridRle y storage/projects/<id>.json SÍ
  const projectsIndexRaw = await fs.readFile(path.join(ROOT_DIR, 'data/projects.json'), 'utf8');
  const projectsIndex = JSON.parse(projectsIndexRaw);
  const storedIndexEntry = projectsIndex.find((p) => p.id === projectId);
  assert.ok(storedIndexEntry);
  assert.equal(storedIndexEntry.gridRle, undefined);
  assert.equal(storedIndexEntry.palette, undefined);

  const snapshotDiskRaw = await fs.readFile(path.join(ROOT_DIR, 'storage/projects', `${projectId}.json`), 'utf8');
  const snapshotDisk = JSON.parse(snapshotDiskRaw);
  assert.equal(snapshotDisk.projectId, projectId);
  assert.deepEqual(snapshotDisk.gridRle, mosaic.gridRle);

  // GET /api/projects
  const listRes = await fetch(`${baseUrl}/api/projects`);
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.equal(listJson.ok, true);
  assert.ok(listJson.projects.some((p) => p.id === projectId));

  // GET /api/projects/:id
  const getOneRes = await fetch(`${baseUrl}/api/projects/${projectId}`);
  assert.equal(getOneRes.status, 200);
  const getOneJson = await getOneRes.json();
  assert.equal(getOneJson.project.id, projectId);
  assert.deepEqual(getOneJson.snapshot.gridRle, mosaic.gridRle);

  // PUT /api/projects/:id
  const updateRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mural Patio Editado',
      config: { ...mosaic.config, mirrorMode: true },
    }),
  });
  assert.equal(updateRes.status, 200);
  const updateJson = await updateRes.json();
  assert.equal(updateJson.project.name, 'Mural Patio Editado');
  assert.equal(updateJson.project.config.mirrorMode, true);
  assert.deepEqual(updateJson.snapshot.gridRle, mosaic.gridRle);

  // POST /api/projects/:id/duplicate
  const dupRes = await fetch(`${baseUrl}/api/projects/${projectId}/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(dupRes.status, 201);
  const dupJson = await dupRes.json();
  assert.equal(dupJson.ok, true);
  assert.notEqual(dupJson.project.id, projectId);
  assert.match(dupJson.project.name, /Copia/);
  assert.deepEqual(dupJson.snapshot.gridRle, mosaic.gridRle);
  createdProjectIds.push(dupJson.project.id);

  // 5. POST /api/export/pdf en Modo Mosaico vectorial (6 hojas + portada + paleta = 8 págs)
  const pdfMosaicRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceName: 'mural_prueba.png',
      config: mosaic.config,
      palette: mosaic.palette,
      grid: { rle: mosaic.gridRle },
      tileCols: mosaic.metrics.tileCols,
      tileRows: mosaic.metrics.tileRows,
      maxRowCols: mosaic.metrics.maxRowCols,
      totalTiles: mosaic.metrics.totalTiles,
    }),
  });
  assert.equal(pdfMosaicRes.status, 200);
  assert.equal(pdfMosaicRes.headers.get('content-type'), 'application/pdf');
  assert.match(pdfMosaicRes.headers.get('content-disposition') || '', /^attachment; filename="/);
  const pdfMosaicBuf = Buffer.from(await pdfMosaicRes.arrayBuffer());
  assert.equal(pdfMosaicBuf.subarray(0, 5).toString('ascii'), '%PDF-');
  const loadedMosaicPdf = await PDFDocument.load(pdfMosaicBuf);
  assert.equal(loadedMosaicPdf.getPageCount(), 8);

  // 6. POST /api/export/pdf en Modo Imagen Directa con sourceImageId y descarga selectiva rangeExpression: "A1"
  const pdfDirectRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceImageId: uploadJson.image.id,
      sourceName: 'mural_prueba.png',
      config: {
        ...mosaic.config,
        mosaicMode: false,
      },
      exportOptions: {
        includeCover: true,
        includePalette: false,
        rangeExpression: 'A1',
      },
    }),
  });
  assert.equal(pdfDirectRes.status, 200);
  assert.equal(pdfDirectRes.headers.get('content-type'), 'application/pdf');
  const pdfDirectBuf = Buffer.from(await pdfDirectRes.arrayBuffer());
  assert.equal(pdfDirectBuf.subarray(0, 5).toString('ascii'), '%PDF-');
  const loadedDirectPdf = await PDFDocument.load(pdfDirectBuf);
  assert.equal(loadedDirectPdf.getPageCount(), 2); // 1 portada + 1 hoja A1

  // 7. Error 400 limpio en /api/export/pdf ante configuración inválida
  const badPdfRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { ...mosaic.config, widthCm: 2 },
    }),
  });
  assert.equal(badPdfRes.status, 400);
  const badPdfJson = await badPdfRes.json();
  assert.equal(badPdfJson.ok, false);

  // 8. DELETE /api/projects/:id y eliminación de snapshot en disco
  const delDupRes = await fetch(`${baseUrl}/api/projects/${dupJson.project.id}`, { method: 'DELETE' });
  assert.equal(delDupRes.status, 200);
  const delDupJson = await delDupRes.json();
  assert.equal(delDupJson.ok, true);
  assert.equal(delDupJson.deletedId, dupJson.project.id);

  await assert.rejects(() =>
    fs.access(path.join(ROOT_DIR, 'storage/projects', `${dupJson.project.id}.json`))
  );

  const delMainRes = await fetch(`${baseUrl}/api/projects/${projectId}`, { method: 'DELETE' });
  assert.equal(delMainRes.status, 200);
  const getAfterDelRes = await fetch(`${baseUrl}/api/projects/${projectId}`);
  assert.equal(getAfterDelRes.status, 404);
});
