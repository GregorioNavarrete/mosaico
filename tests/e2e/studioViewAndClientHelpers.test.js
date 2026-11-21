import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ejs from 'ejs';
import { createApp } from '../../src/app.js';
import { computeGridMetrics, UNUSED_CELL } from '../../src/shared/mosaicCore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

// Resolver imports browser-style (/shared/* y /public/*) hacia el árbol local en Node 24
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

const { createStudioStore, quantizeCellsToMosaic, MAX_HISTORY_STEPS } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/state/studioStore.js')).href
);
const { renderDesignRegion, drawPrintGridOverlay } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/render/canvasRenderer.js')).href
);
const { createEditorController } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/controllers/editorController.js')).href
);

function createMockCanvas2dContext() {
  const counts = {
    fillRect: 0,
    strokeRect: 0,
    fillText: 0,
    rect: 0,
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
    rect() {
      counts.rect++;
    },
    clip() {},
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

test('studio.ejs renderiza offline sin CDNs externos ni alert/confirm y contiene todos los IDs esperados por main.js y editorController.js', async () => {
  const studioPath = path.join(ROOT_DIR, 'src/views/studio.ejs');
  const html = await ejs.renderFile(studioPath, {
    title: 'GuíaMosaico · Estudio MVC 1:1',
    phaseStatus: 'Fase 1 · Estudio 1:1',
  });

  // Cero CDNs externos
  assert.doesNotMatch(html, /https?:\/\//i, 'studio.ejs no debe contener URLs externas http(s)://');
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|unpkg\.com|fonts\.googleapis\.com/i);

  // Verificar CSS y JS offline enlazados
  assert.match(html, /\/public\/css\/tokens\.css/);
  assert.match(html, /\/public\/css\/layout\.css/);
  assert.match(html, /\/public\/css\/components\.css/);
  assert.match(html, /type="module" src="\/public\/js\/main\.js"/);

  // Extraer todos los IDs consultados en main.js y editorController.js y validar su presencia en studio.ejs
  const clientFiles = [
    path.join(ROOT_DIR, 'public/js/main.js'),
    path.join(ROOT_DIR, 'public/js/controllers/editorController.js'),
    path.join(ROOT_DIR, 'public/js/render/canvasRenderer.js'),
    path.join(ROOT_DIR, 'public/js/state/studioStore.js'),
  ];

  const expectedIds = new Set();
  for (const file of clientFiles) {
    const code = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /\b(alert|confirm|prompt)\s*\(/, `${path.basename(file)} no debe usar alert/confirm/prompt`);
    assert.doesNotMatch(code, /https?:\/\/(cdn\.tailwindcss\.com|unpkg\.com|fonts\.googleapis\.com)/i);

    const idMatches = code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of idMatches) {
      expectedIds.add(m[1]);
    }
  }

  assert.ok(expectedIds.size >= 60, `Se esperaban >= 60 IDs referenciados, encontrados: ${expectedIds.size}`);
  for (const id of expectedIds) {
    assert.ok(
      html.includes(`id="${id}"`),
      `Falta el elemento con id="${id}" en src/views/studio.ejs`
    );
  }

  // Verificar opciones de papel A4, A3, LETTER, LEGAL, CUSTOM y herramientas Fase 1
  for (const fmt of ['A4', 'A3', 'LETTER', 'LEGAL', 'CUSTOM']) {
    assert.match(html, new RegExp(`value="${fmt}"`), `Debe existir formato de papel ${fmt}`);
  }
  assert.match(html, /Recalcular desde imagen/);
  assert.match(html, /Recalcular \(descartar trazos\)/);
  assert.match(html, /Cancelar y conservar ediciones/);
  assert.match(html, /Reemplazar Global/);
  assert.match(html, /Incluir portada de montaje/);
});

test('Servidor Express sirve vista studio y todos los recursos offline (/public, /shared, /vendor/fonts) con HTTP 200', async () => {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const urls = [
      '/',
      '/public/css/tokens.css',
      '/public/css/layout.css',
      '/public/css/components.css',
      '/public/js/main.js',
      '/public/js/state/studioStore.js',
      '/public/js/render/canvasRenderer.js',
      '/public/js/controllers/editorController.js',
      '/shared/contracts.js',
      '/shared/printGrid.js',
      '/shared/mosaicCore.js',
      '/vendor/fonts/manrope/600.css',
      '/vendor/fonts/dm-sans/400.css',
      '/vendor/fonts/dm-mono/400.css',
    ];

    for (const u of urls) {
      const res = await fetch(`${base}${u}`);
      assert.equal(res.status, 200, `Se esperaba HTTP 200 para ${u}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('studioStore soporta multipapel (A4/A3/LETTER/LEGAL/CUSTOM), herramientas (Pincel/Bote/Reemplazo/Cuentagotas), 40 pasos Undo/Redo y round-trip RLE', () => {
  const store = createStudioStore();
  const state = store.getState();

  assert.equal(state.printMetrics.paperFormat, 'A4');
  assert.equal(state.printMetrics.totalPages, 28);

  // Cambiar a CUSTOM 30x40 cm
  store.updateConfig({
    paperFormat: 'CUSTOM',
    customPaperWidthCm: 30,
    customPaperHeightCm: 40,
    orientation: 'landscape',
    marginCm: 1.0,
    overlapCm: 0.5,
  });
  assert.equal(state.printMetrics.pageW, 40);
  assert.equal(state.printMetrics.pageH, 30);
  assert.equal(state.printMetrics.Nx, 4); // ceil((120-0.5)/(38-0.5)) = ceil(119.5/37.5) = 4
  assert.equal(state.printMetrics.Ny, 4); // ceil((90-0.5)/(28-0.5)) = ceil(89.5/27.5) = 4

  // Validar error controlado cuando overlap >= Ux
  store.updateConfig({
    paperFormat: 'CUSTOM',
    customPaperWidthCm: 10,
    customPaperHeightCm: 10,
    marginCm: 2.0,
    overlapCm: 6.0,
  });
  assert.ok(state.printGridError, 'Debe capturar error de solapamiento inválido sin lanzar excepción');

  // Restaurar A4 y crear mosaico 10x10 cm (tesela 2 cm => 5x5 = 25 teselas)
  store.updateConfig({
    paperFormat: 'A4',
    orientation: 'portrait',
    marginCm: 1.0,
    overlapCm: 0.5,
    widthCm: 10,
    heightCm: 10,
    tileSizeCm: 2.0,
    pattern: 'grid',
    colorCount: 3,
  });
  assert.equal(state.printGridError, null);

  const metrics = computeGridMetrics(10, 10, 2.0, 'grid');
  const cellColors = [];
  for (let r = 0; r < metrics.tileRows; r++) {
    for (let c = 0; c < metrics.tileCols; c++) {
      const isLeft = c < 2;
      cellColors.push({
        r: isLeft ? 220 : 40,
        g: isLeft ? 80 : 120,
        b: isLeft ? 60 : 200,
        row: r,
        col: c,
      });
    }
  }
  const mosaicData = quantizeCellsToMosaic(cellColors, 2, metrics);
  store.setMosaicData(mosaicData);

  assert.equal(state.totalTiles, 25);
  assert.equal(state.palette.length, 2);
  assert.equal(state.hasManualEdits, false);

  // Pincel en modo espejo: pintar (xCm=1.0, yCm=1.0) edita col=4 en grid[4]
  store.updateConfig({ mirrorMode: true });
  store.setActiveColor(1);
  store.beginBrushStroke();
  const brushRes = store.paintTileAtCm(1.0, 1.0);
  store.endBrushStroke();
  assert.equal(brushRes.changed, true);
  assert.equal(brushRes.hit.col, 4);
  assert.equal(state.hasManualEdits, true);
  assert.equal(state.undoStack.length, 1);

  // Cuentagotas en (xCm=1.0, yCm=1.0) captura color 1
  const picked = store.pickColorAtCm(1.0, 1.0);
  assert.equal(picked.pickedIdx, 1);

  // Flood fill en zona izquierda (col=0..1, color 1) hacia color 0 -> rellena las 10 teselas izquierdas
  store.updateConfig({ mirrorMode: false });
  store.setActiveColor(0);
  const fillRes = store.applyFloodFillAtCm(1.0, 1.0);
  assert.equal(fillRes.changedCount, 10);
  assert.equal(state.undoStack.length, 2);

  // Deshacer y Rehacer
  assert.equal(store.undo(), true);
  assert.equal(state.palette[1].count, 11); // 10 izquierdas + 1 pintada en col=4
  assert.equal(state.redoStack.length, 1);
  assert.equal(store.redo(), true);
  assert.equal(state.palette[1].count, 1); // solo la pintada en col=4
  assert.equal(state.redoStack.length, 0);

  // Verificar tope de 40 pasos en undoStack alternando color respecto al valor actual en (1.0, 1.0)
  for (let step = 0; step < 48; step++) {
    const currentVal = state.grid[0];
    const nextColor = currentVal === 0 ? 1 : 0;
    store.setActiveColor(nextColor);
    store.beginBrushStroke();
    const res = store.paintTileAtCm(1.0, 1.0);
    store.endBrushStroke();
    assert.equal(res.changed, true);
  }
  assert.equal(state.undoStack.length, MAX_HISTORY_STEPS);
  assert.equal(MAX_HISTORY_STEPS, 40);

  // Reemplazo Global de color actual en (1.0, 1.0) por el otro color
  const fromColor = state.grid[0];
  const targetColor = fromColor === 0 ? 1 : 0;
  store.setActiveColor(targetColor);
  const rep = store.applyReplaceGlobalAtCm(1.0, 1.0);
  assert.ok(rep.changedCount > 0);
  assert.equal(state.palette[fromColor].count, 0);
  assert.equal(state.palette[targetColor].count, 25);

  // Verificar payloads de proyecto y PDF + round-trip RLE
  const projectPayload = store.buildProjectPayload();
  assert.ok(Array.isArray(projectPayload.gridRle) && projectPayload.gridRle.length > 0);
  assert.equal(projectPayload.totalTiles, 25);

  const pdfPayload = store.buildPdfExportPayload({
    includeCover: true,
    includePalette: true,
    selectedSheets: ['A1'],
    rangeExpression: '',
  });
  assert.deepEqual(pdfPayload.exportOptions.selectedSheets, ['A1']);
  assert.ok(Array.isArray(pdfPayload.grid.rle));

  const store2 = createStudioStore();
  store2.applyLoadedProject(
    {
      id: 'proj-1',
      name: projectPayload.name,
      sourceImageId: null,
      sourceName: projectPayload.sourceName,
      aspectRatio: 1,
      keepRatio: true,
      config: projectPayload.config,
    },
    {
      palette: projectPayload.palette,
      gridRle: projectPayload.gridRle,
    }
  );
  assert.deepEqual(store2.getState().grid, state.grid);
  assert.equal(store2.getState().hasManualEdits, false);
});

test('canvasRenderer renderiza 10 000 teselas (100x100) holgadamente por encima de 30 fps (< 33.3 ms/frame)', () => {
  const store = createStudioStore({
    widthCm: 200,
    heightCm: 200,
    tileSizeCm: 2.0,
    pattern: 'grid',
    colorCount: 10,
    paperFormat: 'A4',
    showNumbers: false,
    showA4Grid: true,
  });

  const state = store.getState();
  const metrics = computeGridMetrics(200, 200, 2.0, 'grid');
  assert.equal(metrics.totalTiles, 10000);

  const palette = Array.from({ length: 10 }, (_, i) => ({
    r: (i * 23 + 30) % 255,
    g: (i * 47 + 60) % 255,
    b: (i * 71 + 90) % 255,
    hex: `#${((i * 23 + 30) % 255).toString(16).padStart(2, '0')}${((i * 47 + 60) % 255)
      .toString(16)
      .padStart(2, '0')}${((i * 71 + 90) % 255).toString(16).padStart(2, '0')}`.toUpperCase(),
    count: 1000,
  }));

  const grid = new Uint8Array(metrics.tileRows * metrics.maxRowCols);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = i % 10;
  }
  store.setMosaicData({
    palette,
    grid,
    tileCols: metrics.tileCols,
    tileRows: metrics.tileRows,
    maxRowCols: metrics.maxRowCols,
    totalTiles: metrics.totalTiles,
    gridMetrics: metrics,
  });

  const mockCtx = createMockCanvas2dContext();

  // Warmup
  const renderedWarm = renderDesignRegion(mockCtx, {
    destX: 0,
    destY: 0,
    destW: 1000,
    destH: 1000,
    srcXCm: 0,
    srcYCm: 0,
    srcWCm: 200,
    srcHCm: 200,
    pxPerCm: 5,
    state: store.getState(),
  });
  assert.equal(renderedWarm, 10000);

  const frames = 30;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    renderDesignRegion(mockCtx, {
      destX: 0,
      destY: 0,
      destW: 1000,
      destH: 1000,
      srcXCm: 0,
      srcYCm: 0,
      srcWCm: 200,
      srcHCm: 200,
      pxPerCm: 5,
      state: store.getState(),
    });
    drawPrintGridOverlay(mockCtx, store.getState(), 5, 0, 0, 1000, 1000);
  }
  const elapsedMs = performance.now() - t0;
  const avgFrameMs = elapsedMs / frames;
  const approxFps = 1000 / avgFrameMs;

  assert.ok(
    avgFrameMs < 33.33,
    `El renderizado de 10 000 teselas debe mantenerse >= 30 fps (< 33.33 ms/frame); actual: ${avgFrameMs.toFixed(
      2
    )} ms (${approxFps.toFixed(1)} fps)`
  );
  assert.ok(mockCtx.counts.fillRect >= 10000 * frames);
  assert.equal(UNUSED_CELL, 255);
});

test('editorController protege ediciones manuales (modal no bloqueante) y sincroniza selección de hojas en modal PDF', () => {
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
      get className() {
        return Array.from(classes).join(' ');
      },
      set className(val) {
        classes.clear();
        for (const token of String(val || '').split(/\s+/).filter(Boolean)) {
          classes.add(token);
        }
      },
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
      querySelectorAll(sel) {
        if (sel === '.sheet-chip') return children.filter((c) => c.classList.contains('sheet-chip'));
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

  const tabBtns = [makeStubEl('button', { tab: 'f1' }), makeStubEl('button', { tab: 'f2' })];
  const groutPresets = [makeStubEl('button', { grout: '#D6D3CB' })];
  const vmodeBtns = [makeStubEl('button', { vmode: 'color' })];
  const toolBtns = [makeStubEl('button', { tool: 'pan' }), makeStubEl('button', { tool: 'brush' })];

  const mockDoc = {
    activeElement: null,
    body: makeStubEl('body'),
    getElementById: getEl,
    createElement: (tag) => makeStubEl(tag),
    querySelectorAll: (sel) => {
      if (sel === '.tab-btn') return tabBtns;
      if (sel === '.grout-preset') return groutPresets;
      if (sel === '.vmode-btn') return vmodeBtns;
      if (sel === '.tool-btn[data-tool]') return toolBtns;
      return [];
    },
  };
  const mockWin = { addEventListener() {} };

  const store = createStudioStore();
  const metrics = computeGridMetrics(120, 90, 2.0, 'grid');
  const grid = new Uint8Array(metrics.tileRows * metrics.maxRowCols).fill(0);
  const palette = [
    { r: 54, g: 89, b: 77, hex: '#36594D', count: metrics.totalTiles - 1 },
    { r: 189, g: 117, b: 78, hex: '#BD754E', count: 1 },
  ];
  grid[0] = 1;
  store.setMosaicData({
    palette,
    grid,
    tileCols: metrics.tileCols,
    tileRows: metrics.tileRows,
    maxRowCols: metrics.maxRowCols,
    totalTiles: metrics.totalTiles,
    gridMetrics: metrics,
  });

  // Simular edición manual con pincel
  store.setActiveColor(1);
  store.beginBrushStroke();
  store.paintTileAtCm(3.0, 1.0);
  store.endBrushStroke();
  assert.equal(store.getState().hasManualEdits, true);

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

  // 1. Verificar Modal de Protección de Ediciones Manuales al cambiar patrón o tamaño tesela
  const protectModal = getEl('protect-edits-modal');
  assert.equal(protectModal.classList.contains('is-open'), false);

  getEl('btn-pattern-brick').click();
  assert.equal(protectModal.classList.contains('is-open'), true);

  // Cancelar y conservar ediciones -> patrón sigue en 'grid' y hasManualEdits sigue true
  getEl('btn-protect-cancel').click();
  assert.equal(protectModal.classList.contains('is-open'), false);
  assert.equal(store.getState().config.pattern, 'grid');
  assert.equal(store.getState().hasManualEdits, true);

  // Cambiar tileSizeCm y confirmar Recalcular -> aplica 3.0 cm
  const rangeTile = getEl('range-tile-size');
  rangeTile.value = '3.0';
  rangeTile.dispatch('change');
  assert.equal(protectModal.classList.contains('is-open'), true);
  getEl('btn-protect-confirm').click();
  assert.equal(protectModal.classList.contains('is-open'), false);
  assert.equal(store.getState().config.tileSizeCm, 3.0);

  // 2. Verificar Modal de Exportación PDF Selectiva y rango "A1-B2"
  controller.openPdfExportModal();
  const modalEl = getEl('pdf-export-modal');
  assert.equal(modalEl.classList.contains('is-open'), true);

  const gridPicker = getEl('pdf-sheets-grid');
  assert.equal(gridPicker.children.length, 28); // 120x90 en A4 = 28 hojas
  assert.equal(gridPicker.children[0].dataset.sheet, 'A1');
  assert.equal(gridPicker.children[27].dataset.sheet, 'D7');

  const rangeInput = getEl('pdf-range-input');
  rangeInput.value = 'A1-B2';
  rangeInput.dispatch('input');
  const selectedChips = gridPicker.children.filter((c) => c.classList.contains('is-selected')).map((c) => c.dataset.sheet);
  assert.deepEqual(selectedChips, ['A1', 'A2', 'B1', 'B2']);

  getEl('btn-pdf-clear-all').click();
  assert.equal(gridPicker.children.filter((c) => c.classList.contains('is-selected')).length, 0);
  assert.equal(getEl('btn-pdf-confirm-export').disabled, true);

  getEl('btn-pdf-select-all').click();
  assert.equal(gridPicker.children.filter((c) => c.classList.contains('is-selected')).length, 28);
  assert.equal(getEl('btn-pdf-confirm-export').disabled, false);
});

