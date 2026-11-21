import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ejs from 'ejs';
import { createApp } from '../../src/app.js';
import { ARCHITECTURAL_PATTERNS } from '../../src/shared/contracts.js';
import { generatePatternCells } from '../../src/shared/patterns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/shared/')) {
      const target = path.join(ROOT_DIR, 'src', specifier);
      return nextResolve(pathToFileURL(target).href, context);
    }
    if (specifier.startsWith('/public/')) {
      const target = path.join(ROOT_DIR, specifier);
      return nextResolve(pathToFileURL(target).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { computeMosaicJob } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/workers/mosaicWorker.js')).href
);
const { createStudioStore, PROTECTED_REBUILD_KEYS } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/state/studioStore.js')).href
);
const { renderDesignRegion } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/render/canvasRenderer.js')).href
);
const { createEditorController } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/controllers/editorController.js')).href
);

function makeSyntheticRgba(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const isBorder = x < 4 || x >= w - 4 || y < 4 || y >= h - 4;
      if (isBorder) {
        // Fondo azul cielo uniforme en bordes para probar removeBackgroundLocal
        rgba[idx] = 232;
        rgba[idx + 1] = 238;
        rgba[idx + 2] = 242;
      } else {
        // Paisaje cálido / bosque con gradiente y ruido sutil
        const noise = ((x + y) % 3) * 8 - 8;
        rgba[idx] = Math.max(0, Math.min(255, Math.round(45 + (x / w) * 180 + noise)));
        rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(70 + (y / h) * 130 - noise)));
        rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(180 - (x / w) * 110)));
      }
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

function createFullMockCanvas2dContext() {
  const counts = {
    fillRect: 0,
    strokeRect: 0,
    fillText: 0,
    rect: 0,
    moveTo: 0,
    lineTo: 0,
    arc: 0,
    fill: 0,
    stroke: 0,
  };
  return {
    counts,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    filter: 'none',
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {
      counts.moveTo++;
    },
    lineTo() {
      counts.lineTo++;
    },
    arc() {
      counts.arc++;
    },
    rect() {
      counts.rect++;
    },
    clip() {},
    fill() {
      counts.fill++;
    },
    fillRect() {
      counts.fillRect++;
    },
    strokeRect() {
      counts.strokeRect++;
    },
    stroke() {
      counts.stroke++;
    },
    fillText() {
      counts.fillText++;
    },
    setLineDash() {},
    translate() {},
    scale() {},
    drawImage() {},
  };
}

test('studio.ejs Fase 2 incluye los 9 patrones, controles CIELAB/Dithering/Preprocesado/Mezcla/Degradado/Acabados/Breakdown y endpoint Worker HTTP 200', async () => {
  const studioPath = path.join(ROOT_DIR, 'src/views/studio.ejs');
  const html = await ejs.renderFile(studioPath, {
    title: 'GuíaMosaico · Fase 2',
    phaseStatus: 'Fase 2 · Editor & Patrones',
  });

  assert.match(html, /Fase 2 · Editor &amp; Patrones|Fase 2 · Editor & Patrones/);
  for (const pat of ARCHITECTURAL_PATTERNS) {
    assert.match(html, new RegExp(`data-pattern="${pat}"`), `Falta botón de patrón ${pat}`);
  }
  for (const gm of ['image', 'mixture', 'gradient']) {
    assert.match(html, new RegExp(`data-genmode="${gm}"`), `Falta modo de generación ${gm}`);
  }
  assert.match(html, /data-vmode="breakdown"/);
  assert.match(html, /id="select-preprocess-mode"/);
  assert.match(html, /id="chk-remove-bg"/);
  assert.match(html, /id="select-color-space"/);
  assert.match(html, /id="select-dither-mode"/);
  assert.match(html, /id="range-dither-strength"/);
  assert.match(html, /id="select-tile-finish"/);
  assert.match(html, /id="worker-status-pill"/);

  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/public/js/workers/mosaicWorker.js`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /computeMosaicJob/);

    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootRes.status, 200);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /Fase 2/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('computeMosaicJob ejecuta pipeline unificado en hexagonal+cielab+bayer, herringbone+floyd-steinberg, penny_round+mixture (50/30/20%), diamond_45+gradient y preprocesado', () => {
  const w = 60;
  const h = 48;
  const rgba = makeSyntheticRgba(w, h);

  // 1. hexagonal + cielab + bayer
  const hexJob = computeMosaicJob({
    rgbaBuffer: rgba,
    sampleW: w,
    sampleH: h,
    config: {
      widthCm: 20,
      heightCm: 16,
      tileSizeCm: 2,
      pattern: 'hexagonal',
      generationMode: 'image',
      colorSpace: 'cielab',
      ditherMode: 'bayer',
      ditherStrength: 0.7,
      colorCount: 6,
      seed: 20261120,
    },
  });
  assert.equal(hexJob.isPolygonal, true);
  assert.ok(hexJob.gridBuffer instanceof Uint8Array);
  assert.equal(hexJob.gridBuffer.length, hexJob.totalTiles);
  assert.equal(
    hexJob.palette.reduce((s, p) => s + p.count, 0),
    hexJob.totalTiles
  );

  // 2. herringbone + floyd-steinberg
  const hbJob = computeMosaicJob({
    rgbaBuffer: rgba,
    sampleW: w,
    sampleH: h,
    config: {
      widthCm: 20,
      heightCm: 16,
      tileSizeCm: 2,
      pattern: 'herringbone',
      generationMode: 'image',
      colorSpace: 'cielab',
      ditherMode: 'floyd-steinberg',
      ditherStrength: 0.8,
      colorCount: 5,
      seed: 42,
    },
  });
  assert.equal(hbJob.isPolygonal, true);
  assert.equal(hbJob.gridBuffer.length, hbJob.totalTiles);
  assert.equal(
    hbJob.palette.reduce((s, p) => s + p.count, 0),
    hbJob.totalTiles
  );

  // 3. penny_round + mixture (50/30/20% exacto sobre 100+ celdas)
  const pennyMixJob = computeMosaicJob({
    rgbaBuffer: null,
    sampleW: 0,
    sampleH: 0,
    config: {
      widthCm: 20,
      heightCm: 20,
      tileSizeCm: 2,
      pattern: 'penny_round',
      generationMode: 'mixture',
      mixtureStops: [
        { hex: '#36594D', percent: 50 },
        { hex: '#E9BF8A', percent: 30 },
        { hex: '#BD754E', percent: 20 },
      ],
      seed: 1234,
    },
  });
  assert.equal(pennyMixJob.isPolygonal, true);
  assert.equal(pennyMixJob.palette.length, 3);
  const n = pennyMixJob.totalTiles;
  assert.ok(n >= 90);
  // Método Hamilton mantiene proporción exacta ± 1 pieza por redondeo entero
  assert.ok(Math.abs(pennyMixJob.palette[0].count / n - 0.5) <= 1 / n + 1e-9);
  assert.ok(Math.abs(pennyMixJob.palette[1].count / n - 0.3) <= 1 / n + 1e-9);
  assert.ok(Math.abs(pennyMixJob.palette[2].count / n - 0.2) <= 1 / n + 1e-9);
  assert.equal(
    pennyMixJob.palette[0].count + pennyMixJob.palette[1].count + pennyMixJob.palette[2].count,
    n
  );

  // 4. diamond_45 + gradient (sin requerir imagen)
  const diamGradJob = computeMosaicJob({
    config: {
      widthCm: 20,
      heightCm: 20,
      tileSizeCm: 2,
      pattern: 'diamond_45',
      generationMode: 'gradient',
      gradientStops: [
        { hex: '#263F36', position: 0 },
        { hex: '#E9BF8A', position: 0.5 },
        { hex: '#C45B3E', position: 1 },
      ],
      gradientAngleDeg: 45,
      ditherStrength: 0.65,
      seed: 99,
    },
  });
  assert.equal(diamGradJob.isPolygonal, true);
  assert.equal(diamGradJob.gridBuffer.length, diamGradJob.totalTiles);
  assert.equal(
    diamGradJob.palette.reduce((s, p) => s + p.count, 0),
    diamGradJob.totalTiles
  );

  // 5. diamond_45 + image + bilateral / kuwahara / removeBackground
  for (const preprocessMode of ['bilateral', 'kuwahara']) {
    const prepJob = computeMosaicJob({
      rgbaBuffer: rgba,
      sampleW: w,
      sampleH: h,
      config: {
        widthCm: 16,
        heightCm: 16,
        tileSizeCm: 2,
        pattern: 'diamond_45',
        generationMode: 'image',
        preprocessMode,
        removeBackground: true,
        colorSpace: 'cielab',
        ditherMode: 'bayer',
        colorCount: 5,
      },
    });
    assert.equal(prepJob.isPolygonal, true);
    assert.equal(prepJob.gridBuffer.length, prepJob.totalTiles);
    assert.equal(
      prepJob.palette.reduce((s, p) => s + p.count, 0),
      prepJob.totalTiles
    );
  }
});

test('studioStore soporta floodFillAtCm poligonal en hexagonal, Undo/Redo y preserva ediciones al cambiar a breakdown o finish glass', () => {
  for (const key of [
    'preprocessMode',
    'removeBackground',
    'colorSpace',
    'ditherMode',
    'ditherStrength',
    'generationMode',
  ]) {
    assert.ok(PROTECTED_REBUILD_KEYS.includes(key), `Falta ${key} en PROTECTED_REBUILD_KEYS`);
  }
  assert.equal(PROTECTED_REBUILD_KEYS.includes('breakdownColorIdx'), false);
  assert.equal(PROTECTED_REBUILD_KEYS.includes('viewMode'), false);
  assert.equal(PROTECTED_REBUILD_KEYS.includes('finish'), false);

  const store = createStudioStore({
    widthCm: 12,
    heightCm: 10,
    tileSizeCm: 2,
    pattern: 'hexagonal',
    generationMode: 'mixture',
  });
  const state = store.getState();
  assert.ok(Array.isArray(state.cells) && state.cells.length > 0);
  assert.ok(state.spatialIndex);

  // Inicializar grilla uniforme color 0, y pintar una isla de 2 celdas conectadas en color 1
  const n = state.cells.length;
  const grid = new Uint8Array(n).fill(0);
  const palette = [
    { r: 54, g: 89, b: 77, hex: '#36594D', count: n },
    { r: 233, g: 191, b: 138, hex: '#E9BF8A', count: 0 },
    { r: 189, g: 117, b: 78, hex: '#BD754E', count: 0 },
  ];
  store.setMosaicData({
    palette,
    grid,
    totalTiles: n,
    cells: state.cells,
  });

  // Pintar en (6.0, 5.0) con color 1 usando pincel
  store.setActiveColor(1);
  store.beginBrushStroke();
  const brushRes = store.paintAtCm(6.0, 5.0);
  store.endBrushStroke();
  assert.equal(brushRes.changed, true);
  assert.equal(state.hasManualEdits, true);
  assert.equal(state.palette[1].count, 1);

  // Flood fill sobre el fondo conexo color 0 en (1.0, 1.0) hacia color 2
  store.setActiveColor(2);
  const fillRes = store.floodFillAtCm(1.0, 1.0);
  assert.ok(fillRes.changedCount > 10);
  assert.equal(state.palette[2].count, fillRes.changedCount);
  assert.equal(state.undoStack.length, 2);

  // Undo y Redo preservan conteos exactos
  assert.equal(store.undo(), true);
  assert.equal(state.palette[2].count, 0);
  assert.equal(state.palette[1].count, 1);
  assert.equal(store.redo(), true);
  assert.equal(state.palette[2].count, fillRes.changedCount);

  // Cambiar a viewMode: 'breakdown' y finish: 'glass' NO borra ediciones manuales ni resetea grid
  const snapshotBefore = new Uint8Array(state.grid);
  store.updateConfig({ viewMode: 'breakdown', breakdownColorIdx: 2, finish: 'glass' });
  assert.equal(state.hasManualEdits, true);
  assert.deepEqual(state.grid, snapshotBefore);
});

test('editorController cancela trabajos obsoletos en Web Worker y preserva ediciones ante breakdown/finish', async () => {
  function makeStubEl(tag = 'div', attrs = {}) {
    const listeners = new Map();
    const classes = new Set();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: {},
      dataset: { ...attrs },
      children,
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        toggle: (name, force) => {
          if (force === undefined) {
            if (classes.has(name)) classes.delete(name);
            else classes.add(name);
          } else if (force) classes.add(name);
          else classes.delete(name);
        },
        contains: (name) => classes.has(name),
      },
      setAttribute() {},
      appendChild(child) {
        children.push(child);
        return child;
      },
      remove() {},
      click() {
        el.dispatch('click');
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, event = {}) {
        for (const fn of listeners.get(type) || []) {
          fn({ target: el, preventDefault() {}, ...event });
        }
      },
      querySelectorAll() {
        return [];
      },
    };
    return el;
  }

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeStubEl('div'));
    return elements.get(id);
  };

  const mockDoc = {
    activeElement: null,
    body: makeStubEl('body'),
    getElementById: getEl,
    createElement: (tag) => makeStubEl(tag),
    querySelectorAll: () => [],
  };

  // Mock Worker que resuelve de forma asíncrona para verificar cancelación de trabajos obsoletos
  let workerTerminatedCount = 0;
  const postedJobs = [];
  class MockWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(msg) {
      postedJobs.push({ msg, worker: this });
    }
    terminate() {
      workerTerminatedCount++;
    }
  }

  const mockWin = {
    Worker: MockWorker,
    addEventListener() {},
  };

  const store = createStudioStore({
    widthCm: 12,
    heightCm: 12,
    tileSizeCm: 2,
    pattern: 'hexagonal',
    generationMode: 'mixture',
  });

  const fakeRenderer = {
    resize() {},
    fitToView() {},
    applyZoom() {},
    screenToCm: () => ({ xCm: 0, yCm: 0 }),
    renderNow() {},
    scheduleRender() {},
    queueTilePatch() {},
    invalidateCache() {},
  };

  const controller = createEditorController(store, fakeRenderer, mockDoc, mockWin);
  controller.bindEvents();
  controller.syncAllUI();

  // Lanzar trabajo 1 y luego trabajo 2 antes de que responda trabajo 1
  const p1 = controller.rebuildMosaicFromSource();
  assert.equal(getEl('worker-status-pill').classList.contains('hidden'), false);
  const p2 = controller.rebuildMosaicFromSource();
  assert.equal(workerTerminatedCount, 1);
  assert.equal(postedJobs.length, 2);

  // Entregar respuesta obsoleta de trabajo 1 -> debe ser ignorada
  const obsoleteRes = computeMosaicJob(postedJobs[0].msg);
  postedJobs[0].worker.onmessage({ data: { ok: true, jobId: postedJobs[0].msg.jobId, result: obsoleteRes } });
  assert.equal(store.getState().grid, null);

  // Entregar respuesta vigente de trabajo 2
  const validRes = computeMosaicJob(postedJobs[1].msg);
  postedJobs[1].worker.onmessage({ data: { ok: true, jobId: postedJobs[1].msg.jobId, result: validRes } });
  await Promise.all([p1, p2]);
  assert.ok(store.getState().grid instanceof Uint8Array);
  assert.equal(getEl('worker-status-pill').classList.contains('hidden'), true);

  // Hacer trazo manual (eligiendo un color distinto al de la celda en (6,6)) y verificar que cambiar a breakdown y finish='glass' NO abre protectModal
  const targetHit = store.hitTestAtCm(6, 6);
  assert.ok(targetHit);
  const distinctColor = (targetHit.colorIdx + 1) % store.getState().palette.length;
  store.setActiveColor(distinctColor);
  store.beginBrushStroke();
  const paintRes = store.paintAtCm(6, 6);
  store.endBrushStroke();
  assert.equal(paintRes.changed, true);
  assert.equal(store.getState().hasManualEdits, true);

  getEl('btn-vmode-breakdown').click();
  assert.equal(getEl('protect-edits-modal').classList.contains('is-open'), false);
  assert.equal(store.getState().config.viewMode, 'breakdown');
  assert.equal(store.getState().hasManualEdits, true);

  const finishSel = getEl('select-tile-finish');
  finishSel.value = 'glass';
  finishSel.dispatch('change');
  assert.equal(getEl('protect-edits-modal').classList.contains('is-open'), false);
  assert.equal(store.getState().config.finish, 'glass');
  assert.equal(store.getState().hasManualEdits, true);

  // Cambiar preprocessMode SÍ debe abrir el modal protector de ediciones
  const prepSel = getEl('select-preprocess-mode');
  prepSel.value = 'bilateral';
  prepSel.dispatch('change');
  assert.equal(getEl('protect-edits-modal').classList.contains('is-open'), true);
  getEl('btn-protect-cancel').click();
  assert.equal(store.getState().config.preprocessMode, 'none');
  assert.equal(store.getState().hasManualEdits, true);
});

test('canvasRenderer renderiza >= 10 000 celdas hexagonales en mock Canvas 2D por encima de 30 fps (< 33.3 ms/frame)', () => {
  const widthCm = 186;
  const heightCm = 186;
  const tileSizeCm = 2.0;

  const cells = generatePatternCells({
    widthCm,
    heightCm,
    tileSizeCm,
    pattern: 'hexagonal',
  });
  assert.ok(cells.length >= 10000, `Esperado >= 10 000 celdas hexagonales, obtenidas: ${cells.length}`);

  const palette = Array.from({ length: 10 }, (_, i) => ({
    r: (i * 29 + 35) % 255,
    g: (i * 53 + 65) % 255,
    b: (i * 79 + 95) % 255,
    hex: `#${((i * 29 + 35) % 255).toString(16).padStart(2, '0')}${((i * 53 + 65) % 255)
      .toString(16)
      .padStart(2, '0')}${((i * 79 + 95) % 255).toString(16).padStart(2, '0')}`.toUpperCase(),
    count: Math.floor(cells.length / 10),
  }));

  const grid = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    grid[i] = i % 10;
  }

  const store = createStudioStore({
    widthCm,
    heightCm,
    tileSizeCm,
    pattern: 'hexagonal',
    finish: 'ceramic',
    showNumbers: false,
  });
  store.setMosaicData({
    palette,
    grid,
    totalTiles: cells.length,
    cells,
  });

  const mockCtx = createFullMockCanvas2dContext();
  const state = store.getState();

  // Warmup (construye caché empaquetada Float32Array)
  const warmCount = renderDesignRegion(mockCtx, {
    destX: 0,
    destY: 0,
    destW: 930,
    destH: 930,
    srcXCm: 0,
    srcYCm: 0,
    srcWCm: widthCm,
    srcHCm: heightCm,
    pxPerCm: 5,
    state,
  });
  assert.equal(warmCount, cells.length);

  const frames = 25;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    renderDesignRegion(mockCtx, {
      destX: 0,
      destY: 0,
      destW: 930,
      destH: 930,
      srcXCm: 0,
      srcYCm: 0,
      srcWCm: widthCm,
      srcHCm: heightCm,
      pxPerCm: 5,
      state,
    });
  }
  const elapsedMs = performance.now() - t0;
  const avgFrameMs = elapsedMs / frames;
  const fps = 1000 / avgFrameMs;

  assert.ok(
    avgFrameMs < 33.33,
    `Renderizado de ${cells.length} celdas hexagonales debe mantenerse >= 30 fps (< 33.33 ms/frame); actual: ${avgFrameMs.toFixed(
      2
    )} ms (${fps.toFixed(1)} fps)`
  );
  assert.ok(mockCtx.counts.fill >= 10 * frames);

  // Verificar también renderizado penny_round (arc real), glass y breakdown
  const prCells = generatePatternCells({
    widthCm: 16,
    heightCm: 16,
    tileSizeCm: 2,
    pattern: 'penny_round',
  });
  const prGrid = new Uint8Array(prCells.length).fill(0);
  prGrid[0] = 1;
  const prCtx = createFullMockCanvas2dContext();
  const prRendered = renderDesignRegion(prCtx, {
    destX: 0,
    destY: 0,
    destW: 320,
    destH: 320,
    srcXCm: 0,
    srcYCm: 0,
    srcWCm: 16,
    srcHCm: 16,
    pxPerCm: 20,
    state: {
      config: {
        widthCm: 16,
        heightCm: 16,
        tileSizeCm: 2,
        pattern: 'penny_round',
        mosaicMode: true,
        groutColor: '#D6D3CB',
        groutMm: 1.5,
        viewMode: 'breakdown',
        breakdownColorIdx: 1,
        finish: 'glass',
        showNumbers: true,
        mirrorMode: true,
      },
      palette: palette.slice(0, 2),
      grid: prGrid,
      gridMetrics: store.getState().gridMetrics,
      cells: prCells,
    },
  });
  assert.equal(prRendered, prCells.length);
  assert.ok(prCtx.counts.arc > 0, 'penny_round completo debe usar arc() real en Canvas 2D');
  assert.ok(prCtx.counts.fillText >= 1, 'breakdown debe numerar el color activo aislado');
});
