import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../../src/app.js';
import { bootstrapRuntimeDirs } from '../../src/server.js';
import {
  ARCHITECTURAL_PATTERNS,
  COLOR_MODES,
  DITHER_MODES,
  GENERATION_MODES,
  PATTERN_LABELS,
  PREPROCESS_MODES,
  TILE_FINISHES,
  createDefaultConfig,
} from '../../src/shared/contracts.js';
import { encodeGridRle, rgbToHex } from '../../src/shared/mosaicCore.js';
import { generatePatternCells } from '../../src/shared/patterns.js';
import { ciede2000, srgbToLab } from '../../src/shared/colorLab.js';
import { getAiAdapterStatus, runArtisticPreprocess } from '../../src/services/aiAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

function buildNoisyBorderSubjectRgba(width = 12, height = 12) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inSubject = x >= 3 && x <= 8 && y >= 3 && y <= 8;
      const noise = (x + y) % 2 === 0 ? 10 : -10;
      if (inSubject) {
        rgba[idx] = 205 + noise;
        rgba[idx + 1] = 55 + noise;
        rgba[idx + 2] = 45 + noise;
      } else {
        rgba[idx] = 74;
        rgba[idx + 1] = 144;
        rgba[idx + 2] = 226;
      }
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

test('aiAdapter: getAiAdapterStatus y runArtisticPreprocess en modo local (bilateral, kuwahara, removeBackground) y hook externo sin fugas de secretos', async () => {
  const prevProvider = process.env.AI_PROVIDER;
  const prevKey = process.env.AI_API_KEY;

  try {
    delete process.env.AI_PROVIDER;
    delete process.env.AI_API_KEY;
    const defaultStatus = getAiAdapterStatus();
    assert.deepEqual(defaultStatus, {
      provider: 'local',
      externalConfigured: false,
      mode: 'local-free',
    });

    process.env.AI_PROVIDER = 'openai';
    process.env.AI_API_KEY = '';
    assert.deepEqual(getAiAdapterStatus(), {
      provider: 'openai',
      externalConfigured: false,
      mode: 'local-free',
    });

    const secretToken = 'sk-secret-do-not-leak-987654';
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_API_KEY = secretToken;
    const hybridStatus = getAiAdapterStatus();
    assert.deepEqual(hybridStatus, {
      provider: 'openai',
      externalConfigured: true,
      mode: 'external-hybrid',
    });
    assert.equal(JSON.stringify(hybridStatus).includes(secretToken), false);

    // Probar fallback limpio si externalHook falla con el secreto en el mensaje
    const w = 12;
    const h = 12;
    const rgba = buildNoisyBorderSubjectRgba(w, h);
    const fallbackRes = await runArtisticPreprocess(rgba, w, h, {
      preprocessMode: 'bilateral',
      externalHook: async () => {
        throw new Error(`Auth failed for key ${secretToken}`);
      },
    });
    assert.equal(fallbackRes.provider, 'local');
    assert.equal(fallbackRes.mode, 'external-hybrid');
    assert.equal(fallbackRes.externalUsed, false);
    assert.equal(JSON.stringify(fallbackRes).includes(secretToken), false);

    // Probar hook externo exitoso cuando está configurado
    const extRes = await runArtisticPreprocess(rgba, w, h, {
      preprocessMode: 'none',
      externalHook: async ({ width, height }) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(128),
        width,
        height,
      }),
    });
    assert.equal(extRes.provider, 'openai');
    assert.equal(extRes.mode, 'external-hybrid');
    assert.equal(extRes.externalUsed, true);
    assert.equal(extRes.data[0], 128);

    // Volver a modo 100% local para validar bilateral, kuwahara y removeBackground
    process.env.AI_PROVIDER = 'local';
    process.env.AI_API_KEY = '';

    const bilateralRes = await runArtisticPreprocess(rgba, w, h, {
      preprocessMode: 'bilateral',
      radius: 2,
      spatialSigma: 2,
      rangeSigma: 30,
    });
    assert.equal(bilateralRes.provider, 'local');
    assert.equal(bilateralRes.mode, 'local-free');
    assert.equal(bilateralRes.externalUsed, false);
    assert.equal(bilateralRes.width, w);
    assert.equal(bilateralRes.height, h);
    const centerIdx = (5 * w + 5) * 4;
    // El ruido +-10 dentro del sujeto rojo se atenúa hacia ~205
    assert.ok(Math.abs(bilateralRes.data[centerIdx] - 205) <= 6);

    const kuwaharaRes = await runArtisticPreprocess(rgba, w, h, {
      preprocessMode: 'kuwahara',
      radius: 2,
    });
    assert.equal(kuwaharaRes.provider, 'local');
    assert.equal(kuwaharaRes.mode, 'local-free');
    assert.equal(kuwaharaRes.data.length, w * h * 4);
    assert.ok(Math.abs(kuwaharaRes.data[centerIdx] - 205) <= 8);

    const bgRemovedRes = await runArtisticPreprocess(rgba, w, h, {
      preprocessMode: 'none',
      removeBackground: true,
      toleranceDeltaE: 12,
    });
    assert.equal(bgRemovedRes.provider, 'local');
    assert.equal(bgRemovedRes.mode, 'local-free');
    // Esquina (0,0) del borde azul se limpia a blanco [255, 255, 255]
    assert.equal(bgRemovedRes.data[0], 255);
    assert.equal(bgRemovedRes.data[1], 255);
    assert.equal(bgRemovedRes.data[2], 255);
    // Sujeto rojo central permanece intacto
    assert.ok(
      ciede2000(
        srgbToLab(bgRemovedRes.data[centerIdx], bgRemovedRes.data[centerIdx + 1], bgRemovedRes.data[centerIdx + 2]),
        srgbToLab(rgba[centerIdx], rgba[centerIdx + 1], rgba[centerIdx + 2])
      ) < 1
    );
  } finally {
    if (prevProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = prevProvider;
    if (prevKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = prevKey;
  }
});

test('GET /api/health y GET /api/meta/defaults exponen fase-2, 9 patrones arquitectónicos, modos y aiStatus', async () => {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.phase, 'fase-2');

    const defaultsRes = await fetch(`${baseUrl}/api/meta/defaults`);
    assert.equal(defaultsRes.status, 200);
    const defaults = await defaultsRes.json();

    assert.deepEqual(defaults.architecturalPatterns, ARCHITECTURAL_PATTERNS);
    assert.equal(defaults.architecturalPatterns.length, 9);
    for (const patternKey of ARCHITECTURAL_PATTERNS) {
      assert.ok(
        typeof defaults.patternLabels?.[patternKey] === 'string' && defaults.patternLabels[patternKey].length > 0,
        `Falta patternLabels para ${patternKey}`
      );
    }
    assert.deepEqual(defaults.patternLabels, PATTERN_LABELS);
    assert.deepEqual(defaults.preprocessModes, PREPROCESS_MODES);
    assert.deepEqual(defaults.colorModes, COLOR_MODES);
    assert.deepEqual(defaults.ditherModes, DITHER_MODES);
    assert.deepEqual(defaults.generationModes, GENERATION_MODES);
    assert.deepEqual(defaults.tileFinishes, TILE_FINISHES);
    assert.ok(defaults.aiStatus);
    assert.ok(['local-free', 'external-hybrid'].includes(defaults.aiStatus.mode));
    assert.equal(typeof defaults.aiStatus.externalConfigured, 'boolean');
    assert.equal(defaults.defaultConfig.colorSpace, 'cielab');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Proyectos Fase 2 (hexagonal + cielab + floyd-steinberg + glass + breakdown): guardar, abrir, stats.totalTiles y PDF vectorial multipágina', async (t) => {
  await bootstrapRuntimeDirs();
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createdProjectIds = [];

  t.after(async () => {
    for (const pid of createdProjectIds) {
      await fetch(`${baseUrl}/api/projects/${pid}`, { method: 'DELETE' }).catch(() => {});
      await fs.rm(path.join(ROOT_DIR, 'storage/projects', `${pid}.json`), { force: true }).catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
  });

  // 1. Construir mosaico hexagonal 40x30 cm con tesela 2 cm (6 hojas A4 + portada + paleta = 8 págs)
  const hexConfig = {
    ...createDefaultConfig(),
    widthCm: 40,
    heightCm: 30,
    tileSizeCm: 2,
    paperFormat: 'A4',
    orientation: 'portrait',
    mosaicMode: true,
    pattern: 'hexagonal',
    preprocessMode: 'bilateral',
    removeBackground: true,
    colorSpace: 'cielab',
    ditherMode: 'floyd-steinberg',
    ditherStrength: 0.72,
    breakdownColorIdx: 1,
    generationMode: 'mixture',
    mixtureStops: [
      { hex: '#36594D', percent: 45 },
      { hex: '#BD754E', percent: 35 },
      { hex: '#E5B37C', percent: 20 },
    ],
    gradientStops: [
      { hex: '#263F36', position: 0 },
      { hex: '#C45B3E', position: 1 },
    ],
    gradientAngleDeg: 60,
    finish: 'glass',
    viewMode: 'breakdown',
    colorCount: 4,
  };

  const hexCells = generatePatternCells(hexConfig);
  assert.ok(hexCells.length > 0);

  const palette = [
    { id: 1, r: 54, g: 89, b: 77, hex: rgbToHex(54, 89, 77), count: 0 },
    { id: 2, r: 189, g: 117, b: 78, hex: rgbToHex(189, 117, 78), count: 0 },
    { id: 3, r: 229, g: 179, b: 124, hex: rgbToHex(229, 179, 124), count: 0 },
    { id: 4, r: 247, g: 244, b: 237, hex: rgbToHex(247, 244, 237), count: 0 },
  ];
  const grid = new Uint8Array(hexCells.length);
  for (let i = 0; i < hexCells.length; i++) {
    const colorIdx = i % palette.length;
    grid[i] = colorIdx;
    palette[colorIdx].count++;
  }
  const gridRle = encodeGridRle(grid);

  // Guardar sin enviar totalTiles explícito para verificar cálculo automático en projectModel
  const createRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mural Hexagonal Fase 2',
      sourceName: 'hex_fase2.png',
      config: hexConfig,
      palette,
      gridRle,
    }),
  });
  assert.equal(createRes.status, 201);
  const createJson = await createRes.json();
  assert.equal(createJson.ok, true);

  const projectId = createJson.project.id;
  createdProjectIds.push(projectId);

  // Verificar preservación total de campos Fase 2 y stats.totalTiles exacto
  const savedCfg = createJson.project.config;
  assert.equal(savedCfg.pattern, 'hexagonal');
  assert.equal(savedCfg.preprocessMode, 'bilateral');
  assert.equal(savedCfg.removeBackground, true);
  assert.equal(savedCfg.colorSpace, 'cielab');
  assert.equal(savedCfg.ditherMode, 'floyd-steinberg');
  assert.equal(savedCfg.ditherStrength, 0.72);
  assert.equal(savedCfg.breakdownColorIdx, 1);
  assert.equal(savedCfg.generationMode, 'mixture');
  assert.equal(savedCfg.mixtureStops.length, 3);
  assert.equal(savedCfg.gradientStops.length, 2);
  assert.equal(savedCfg.gradientAngleDeg, 60);
  assert.equal(savedCfg.finish, 'glass');
  assert.equal(savedCfg.viewMode, 'breakdown');

  const paletteSum = createJson.snapshot.palette.reduce((acc, c) => acc + c.count, 0);
  assert.equal(createJson.project.stats.totalTiles, hexCells.length);
  assert.equal(createJson.project.stats.totalTiles, paletteSum);

  // 2. Abrir proyecto por ID y verificar persistencia completa
  const getRes = await fetch(`${baseUrl}/api/projects/${projectId}`);
  assert.equal(getRes.status, 200);
  const getJson = await getRes.json();
  assert.equal(getJson.project.config.pattern, 'hexagonal');
  assert.equal(getJson.project.config.colorSpace, 'cielab');
  assert.equal(getJson.project.config.ditherMode, 'floyd-steinberg');
  assert.equal(getJson.project.config.finish, 'glass');
  assert.equal(getJson.project.config.viewMode, 'breakdown');
  assert.equal(getJson.project.stats.totalTiles, hexCells.length);
  assert.deepEqual(getJson.snapshot.gridRle, gridRle);

  // 3. Actualizar parcialmente Fase 2 vía PUT sin perder los campos previos ni stats.totalTiles
  const putRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        preprocessMode: 'kuwahara',
        breakdownColorIdx: 2,
      },
    }),
  });
  assert.equal(putRes.status, 200);
  const putJson = await putRes.json();
  assert.equal(putJson.project.config.pattern, 'hexagonal');
  assert.equal(putJson.project.config.finish, 'glass');
  assert.equal(putJson.project.config.preprocessMode, 'kuwahara');
  assert.equal(putJson.project.config.breakdownColorIdx, 2);
  assert.equal(putJson.project.stats.totalTiles, hexCells.length);

  // 4. Verificar cálculo de totalTiles en patrón poligonal sin gridRle ni palette (cells.length automático)
  const hbConfig = {
    ...createDefaultConfig(),
    widthCm: 20,
    heightCm: 20,
    tileSizeCm: 2,
    pattern: 'herringbone',
    generationMode: 'gradient',
    finish: 'matte',
  };
  const hbCells = generatePatternCells(hbConfig);
  const hbRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mural Espiga Solo Config',
      config: hbConfig,
    }),
  });
  assert.equal(hbRes.status, 201);
  const hbJson = await hbRes.json();
  createdProjectIds.push(hbJson.project.id);
  assert.equal(hbJson.project.stats.totalTiles, hbCells.length);

  // 5. Exportar PDF vectorial Fase 2 con POST /api/export/pdf usando configuración guardada
  const pdfRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceName: 'hex_fase2.png',
      config: getJson.project.config,
      palette: getJson.snapshot.palette,
      grid: { rle: getJson.snapshot.gridRle },
    }),
  });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');

  const loadedPdf = await PDFDocument.load(pdfBuf);
  assert.equal(loadedPdf.getPageCount(), 8); // 1 portada + 1 paleta + 6 hojas A4 1:1

  // 6. Validar rechazo 400 ante configuración Fase 2 inválida en proyectos y exportación PDF
  const badProjectRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { ...hexConfig, colorSpace: 'hsv-invalid', finish: 'plastic' },
    }),
  });
  assert.equal(badProjectRes.status, 400);
  const badProjectJson = await badProjectRes.json();
  assert.equal(badProjectJson.ok, false);

  const badExportRes = await fetch(`${baseUrl}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: { ...hexConfig, ditherMode: 'unknown-dither', breakdownColorIdx: -1 },
    }),
  });
  assert.equal(badExportRes.status, 400);
  const badExportJson = await badExportRes.json();
  assert.equal(badExportJson.ok, false);
});
