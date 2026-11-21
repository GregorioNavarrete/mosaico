import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../../src/app.js';
import { MAX_PDF_PAGES_POSTER, POSTER_FILTER_MODES } from '../../src/shared/contracts.js';
import { generatePatternCells } from '../../src/shared/patterns.js';

const execFileAsync = promisify(execFile);
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

const { createStudioStore } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/state/studioStore.js')).href
);
const { renderDesignRegion, renderArtworkSnapshotToCanvas } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/render/canvasRenderer.js')).href
);
const { createEditorController } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/controllers/editorController.js')).href
);

function createStubDom() {
  const elements = new Map();
  const bySelector = {
    '.tab-btn': [],
    '.grout-preset': [],
    '.vmode-btn': [],
    '.tool-btn[data-tool]': [],
    '.poster-mode-btn': [],
    '.ar-corner-pin': [],
  };

  function makeEl(tag = 'div', id = '', dataset = {}) {
    const listeners = new Map();
    const classes = new Set();
    const children = [];
    const attrs = {};
    const el = {
      id,
      tagName: tag.toUpperCase(),
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: {},
      dataset: { ...dataset },
      attributes: attrs,
      children,
      width: 720,
      height: 540,
      clientWidth: 800,
      clientHeight: 540,
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
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      getAttribute(k) {
        return attrs[k] ?? null;
      },
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
          fn({ target: el, preventDefault() {}, stopPropagation() {}, ...event });
        }
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 540 }),
      querySelector(sel) {
        if (sel.startsWith('#')) return elements.get(sel.slice(1)) || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '.sheet-chip') return children.filter((c) => c.classList.contains('sheet-chip'));
        return bySelector[sel] || [];
      },
    };
    return el;
  }

  const getEl = (id) => {
    if (!elements.has(id)) {
      const el = makeEl('div', id);
      if (id === 'ar-stage-overlay') {
        Object.defineProperty(el, 'innerHTML', {
          set(html) {
            this._html = html;
            for (const m of html.matchAll(/id="([^"]+)"/g)) {
              if (!elements.has(m[1])) {
                elements.set(m[1], makeEl('div', m[1]));
              }
            }
            bySelector['.ar-corner-pin'] = [0, 1, 2, 3].map((i) => makeEl('button', '', { corner: String(i) }));
          },
          get() {
            return this._html || '';
          },
        });
      }
      elements.set(id, el);
    }
    return elements.get(id);
  };

  // Precrear pestañas, herramientas y botones de póster
  const tabF1 = getEl('tab-btn-f1');
  tabF1.dataset.tab = 'f1';
  const tabF2 = getEl('tab-btn-f2');
  tabF2.dataset.tab = 'f2';
  const tabF3 = getEl('tab-btn-f3');
  tabF3.dataset.tab = 'f3';
  bySelector['.tab-btn'] = [tabF1, tabF2, tabF3];

  const posterSpecs = [
    ['btn-poster-color', 'color'],
    ['btn-poster-grayscale', 'grayscale'],
    ['btn-poster-contrast', 'contrast_bw'],
    ['btn-poster-lineart', 'line_art'],
  ];
  bySelector['.poster-mode-btn'] = posterSpecs.map(([id, mode]) => {
    const b = getEl(id);
    b.dataset.posterMode = mode;
    return b;
  });

  const panBtn = getEl('tool-pan');
  panBtn.dataset.tool = 'pan';
  bySelector['.tool-btn[data-tool]'] = [panBtn];

  const groutBtn = makeEl('button', '', { grout: '#D6D3CB' });
  bySelector['.grout-preset'] = [groutBtn];

  const vmodeColor = makeEl('button', '', { vmode: 'color' });
  bySelector['.vmode-btn'] = [vmodeColor];

  const studioMain = makeEl('main', 'studio-main');
  const mockDoc = {
    activeElement: null,
    body: makeEl('body'),
    getElementById: getEl,
    querySelector: (sel) => (sel === '.studio-main' ? studioMain : null),
    querySelectorAll: (sel) => bySelector[sel] || [],
    createElement: (tag) => {
      if (tag === 'section') {
        return getEl('ar-stage-overlay');
      }
      return makeEl(tag);
    },
  };

  const mockWin = { addEventListener() {} };
  return { elements, getEl, mockDoc, mockWin };
}

test('Servidor Express sirve favicon.svg, ar-camera.css y studio.ejs actualizado sin 404 ni bloqueos', async () => {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const favRes = await fetch(`${base}/public/favicon.svg`);
    assert.equal(favRes.status, 200);
    const favSvg = await favRes.text();
    assert.match(favSvg, /<svg[^>]*>/);
    assert.match(favSvg, /#36594d/i);
    assert.match(favSvg, /#bd754e/i);

    const arCssRes = await fetch(`${base}/public/css/ar-camera.css`);
    assert.equal(arCssRes.status, 200);

    const layoutRes = await fetch(`${base}/public/css/layout.css`);
    assert.equal(layoutRes.status, 200);
    assert.match(await layoutRes.text(), /repeat\(3,\s*1fr\)/);

    const rootRes = await fetch(`${base}/`);
    assert.equal(rootRes.status, 200);
    const html = await rootRes.text();
    assert.match(html, /Fase 2 · Póster &amp; Cámara AR|Fase 2 · Póster & Cámara AR/);
    assert.match(html, /href="\/public\/favicon\.svg"/);
    assert.match(html, /href="\/public\/css\/ar-camera\.css"/);
    assert.match(html, /id="btn-open-ar"/);
    assert.match(html, /id="tab-btn-f3"/);
    assert.match(html, /id="panel-f3"/);
    assert.match(html, /id="mosaic-only-controls"/);
    assert.match(html, /id="poster-only-controls"/);
    assert.match(html, /id="select-pdf-split-mode"/);
    assert.match(html, /id="pdf-batches-field"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('studioStore soporta deferPolygons sin generar celdas síncronas y propaga campos póster/allowLargePoster en PDF', () => {
  const store = createStudioStore({
    widthCm: 100,
    heightCm: 80,
    tileSizeCm: 2,
    pattern: 'grid',
    mosaicMode: true,
  });
  const state = store.getState();

  // Diferir generación de polígonos al cambiar a patrón poligonal durante arrastre
  store.updateConfig(
    { pattern: 'hexagonal', tileSizeCm: 1.5 },
    { silent: true, deferPolygons: true }
  );
  assert.equal(state.cells, null, 'Con deferPolygons=true no debe construir celdas poligonales síncronamente');

  // Al desactivar deferPolygons o activar mosaicMode, las celdas se construyen limpiamente
  store.updateConfig({ mosaicMode: true });
  assert.ok(Array.isArray(state.cells) && state.cells.length > 0);

  // En modo póster, buildPdfExportPayload incluye campos de póster y allowLargePoster=true
  store.updateConfig({
    mosaicMode: false,
    posterFilterMode: 'line_art',
    posterContrast: 1.55,
    posterBrightness: -12,
    posterThreshold: 144,
    posterInvert: true,
  });
  const posterPdfPayload = store.buildPdfExportPayload({ splitMode: 'single' });
  assert.equal(posterPdfPayload.config.posterFilterMode, 'line_art');
  assert.equal(posterPdfPayload.config.posterContrast, 1.55);
  assert.equal(posterPdfPayload.config.posterBrightness, -12);
  assert.equal(posterPdfPayload.config.posterThreshold, 144);
  assert.equal(posterPdfPayload.config.posterInvert, true);
  assert.equal(posterPdfPayload.exportOptions.allowLargePoster, true);

  // En modo mosaico con splitMode='batches', allowLargePoster=true también
  store.updateConfig({ mosaicMode: true });
  const splitPayload = store.buildPdfExportPayload({ splitMode: 'batches', sheetsPerPdf: 10 });
  assert.equal(splitPayload.exportOptions.allowLargePoster, true);
  const singleMosaicPayload = store.buildPdfExportPayload({ splitMode: 'single' });
  assert.equal(singleMosaicPayload.exportOptions.allowLargePoster, false);
});

test('editorController: desactivar Modo Mosaico NO bloquea controles, habilita #poster-only-controls, AR y modal PDF hasta 1000 págs', () => {
  const { getEl, mockDoc, mockWin } = createStubDom();
  const store = createStudioStore({
    widthCm: 120,
    heightCm: 90,
    paperFormat: 'A4',
    mosaicMode: true,
  });

  let renderCalls = 0;
  let invalidateCalls = 0;
  const fakeRenderer = {
    resize() {},
    fitToView() {},
    applyZoom() {},
    screenToCm: () => ({ xCm: 0, yCm: 0 }),
    renderNow() {},
    scheduleRender() {
      renderCalls++;
    },
    queueTilePatch() {},
    invalidateCache() {
      invalidateCalls++;
    },
  };

  const controller = createEditorController(store, fakeRenderer, mockDoc, mockWin);
  controller.bindEvents();
  controller.syncAllUI();

  // Estado inicial (Modo Mosaico activo)
  assert.equal(getEl('f2-controls-wrapper').classList.contains('is-dimmed'), false);
  assert.equal(getEl('mosaic-only-controls').classList.contains('hidden'), false);
  assert.equal(getEl('poster-only-controls').classList.contains('hidden'), true);

  // Desactivar Modo Mosaico con botón #btn-workmode-poster
  getEl('btn-workmode-poster').click();
  assert.equal(store.getState().config.mosaicMode, false);
  assert.equal(getEl('chk-mosaic-mode').checked, false);
  assert.equal(getEl('f2-controls-wrapper').classList.contains('is-dimmed'), false, 'Nunca debe agregar is-dimmed al wrapper');
  assert.equal(getEl('mosaic-only-controls').classList.contains('hidden'), true);
  assert.equal(getEl('poster-only-controls').classList.contains('hidden'), false);

  // Probar los 4 modos póster y sliders en vivo
  for (const [btnId, mode] of [
    ['btn-poster-grayscale', 'grayscale'],
    ['btn-poster-contrast', 'contrast_bw'],
    ['btn-poster-lineart', 'line_art'],
    ['btn-poster-color', 'color'],
  ]) {
    getEl(btnId).click();
    assert.equal(store.getState().config.posterFilterMode, mode);
    assert.ok(POSTER_FILTER_MODES.includes(mode));
  }

  const contrastRange = getEl('range-poster-contrast');
  contrastRange.value = '180';
  contrastRange.dispatch('input');
  assert.equal(store.getState().config.posterContrast, 1.8);
  assert.equal(getEl('val-poster-contrast').textContent, '180%');

  const brightRange = getEl('range-poster-brightness');
  brightRange.value = '-20';
  brightRange.dispatch('input');
  assert.equal(store.getState().config.posterBrightness, -20);

  const threshRange = getEl('range-poster-threshold');
  threshRange.value = '160';
  threshRange.dispatch('input');
  assert.equal(store.getState().config.posterThreshold, 160);

  const chkInvert = getEl('chk-poster-invert');
  chkInvert.checked = true;
  chkInvert.dispatch('change');
  assert.equal(store.getState().config.posterInvert, true);

  // Sincronización de cuadrícula de hojas desde el modo póster
  const chkGridPoster = getEl('chk-show-a4-grid-poster');
  chkGridPoster.checked = false;
  chkGridPoster.dispatch('change');
  assert.equal(store.getState().config.showA4Grid, false);
  assert.equal(getEl('chk-show-a4-grid').checked, false);
  assert.equal(getEl('chk-show-a4-grid-f2').checked, false);
  assert.ok(renderCalls > 0 && invalidateCalls > 0);

  // Cámara AR: abrir desde #btn-open-ar, verificar matrix3d y dimensiones reales, cerrar limpio
  getEl('btn-open-ar').click();
  const arOverlay = getEl('ar-stage-overlay');
  assert.equal(arOverlay.classList.contains('hidden'), false);
  assert.match(getEl('ar-warped-layer').style.transform, /^matrix3d\(/);
  assert.match(getEl('ar-dim-top').textContent, /120 cm/);
  assert.match(getEl('ar-dim-left').textContent, /90 cm/);
  getEl('btn-ar-close').click();
  assert.equal(arOverlay.classList.contains('hidden'), true);

  // Modal PDF: splitMode='batches' habilita #pdf-batches-field y permite hasta MAX_PDF_PAGES_POSTER (1000)
  store.updateConfig({ widthCm: 400, heightCm: 300, mosaicMode: false }, { deferPolygons: true });
  controller.openPdfExportModal();
  const splitSel = getEl('select-pdf-split-mode');
  splitSel.value = 'batches';
  splitSel.dispatch('change');
  assert.equal(getEl('pdf-batches-field').classList.contains('hidden'), false);
  assert.equal(MAX_PDF_PAGES_POSTER, 1000);
  // 400x300 cm en A4 = 264 hojas < 1000 -> botón exportar habilitado!
  assert.equal(getEl('btn-pdf-confirm-export').disabled, false);
});

test('canvasRenderer: vista previa rápida de junta en >2500 celdas poligonales mantiene >= 30 fps y renderArtworkSnapshotToCanvas funciona', () => {
  const widthCm = 120;
  const heightCm = 120;
  const cells = generatePatternCells({
    widthCm,
    heightCm,
    tileSizeCm: 2,
    pattern: 'hexagonal',
  });
  assert.ok(cells.length > 2500, `Esperado >2500 celdas, obtenidas: ${cells.length}`);

  const grid = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) grid[i] = i % 4;
  const palette = [
    { r: 54, g: 89, b: 77, hex: '#36594D', count: 1000 },
    { r: 233, g: 191, b: 138, hex: '#E9BF8A', count: 1000 },
    { r: 189, g: 117, b: 78, hex: '#BD754E', count: 1000 },
    { r: 36, g: 51, b: 45, hex: '#24332D', count: 1000 },
  ];

  const counts = { fill: 0, stroke: 0, fillRect: 0 };
  const mockCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    clip() {},
    clearRect() {},
    fill() { counts.fill++; },
    stroke() { counts.stroke++; },
    fillRect() { counts.fillRect++; },
    strokeRect() {},
    fillText() {},
    setLineDash() {},
    translate() {},
    scale() {},
    drawImage() {},
  };

  const store = createStudioStore({
    widthCm,
    heightCm,
    tileSizeCm: 2,
    pattern: 'hexagonal',
    mosaicMode: true,
    groutColor: '#D6D3CB',
    groutMm: 1.5,
    viewMode: 'color',
    finish: 'matte',
    showNumbers: false,
    mirrorMode: false,
  });
  store.setMosaicData({ palette, grid, totalTiles: cells.length, cells });
  const state = store.getState();
  state.isInteractiveDragging = true;

  // Warmup
  renderDesignRegion(mockCtx, {
    destX: 0,
    destY: 0,
    destW: 600,
    destH: 600,
    srcXCm: 0,
    srcYCm: 0,
    srcWCm: widthCm,
    srcHCm: heightCm,
    pxPerCm: 5,
    state,
  });

  // Simular arrastre continuo del slider groutMm cambiando groutMm en cada frame
  const frames = 20;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    state.config.groutMm = 0.5 + (f % 8) * 0.5;
    renderDesignRegion(mockCtx, {
      destX: 0,
      destY: 0,
      destW: 600,
      destH: 600,
      srcXCm: 0,
      srcYCm: 0,
      srcWCm: widthCm,
      srcHCm: heightCm,
      pxPerCm: 5,
      state,
    });
  }
  const avgMs = (performance.now() - t0) / frames;
  assert.ok(avgMs < 33.33, `Drag de junta poligonal debe ser >= 30 fps (< 33.33 ms/frame); actual: ${avgMs.toFixed(2)} ms`);
  assert.ok(counts.stroke >= frames, 'Modo fastPreview debe trazar borde de junta durante drag');

  // Snapshot AR con contorno forzado
  const snapCanvas = {
    width: 480,
    height: 480,
    getContext: () => mockCtx,
  };
  const ok = renderArtworkSnapshotToCanvas(snapCanvas, state, { forceContour: true, showGrid: false });
  assert.equal(ok, true);
});

test('Chromium headless verifica la app real (/), Modo Póster sin pointer-events bloqueados, Cámara AR y Split PDF sin errores JS ni 404', async (t) => {
  let hasChromium = true;
  try {
    await execFileAsync('which', ['chromium']);
  } catch {
    hasChromium = false;
  }
  if (!hasChromium) {
    t.skip('Binario chromium no disponible en este entorno');
    return;
  }

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;

  const chrome = spawn('chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--window-size=1320,900',
    '--remote-debugging-port=0',
    baseUrl,
  ]);

  let ws = null;
  try {
    const devToolsWsUrl = await new Promise((resolve, reject) => {
      let stderrBuf = '';
      const timer = setTimeout(() => reject(new Error(`Timeout esperando DevTools: ${stderrBuf}`)), 10000);
      chrome.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      chrome.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium salió prematuramente (${code}): ${stderrBuf}`));
      });
    });

    const listRes = await fetch(
      devToolsWsUrl.replace('ws://', 'http://').replace(/\/devtools.*/, '/json/list')
    );
    const targets = await listRes.json();
    const pageTarget = targets.find((tgt) => tgt.type === 'page') || targets[0];
    assert.ok(pageTarget?.webSocketDebuggerUrl, 'Debe existir target CDP de página');

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let msgId = 1;
    const pending = new Map();
    const consoleErrors = [];
    const pageExceptions = [];
    const failedResponses = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        pageExceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'exceptionThrown');
      } else if (msg.method === 'Network.responseReceived' && msg.params?.response?.status >= 400) {
        failedResponses.push(`${msg.params.response.status} ${msg.params.response.url}`);
      }
    });

    const cdpCall = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await cdpCall('Runtime.enable');
    await cdpCall('Network.enable');

    const evalPage = async (expression) => {
      const res = await cdpCall('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(`Page eval error: ${res.exceptionDetails.text}`);
      }
      return res.result?.value;
    };

    // Esperar hasta que la paleta del mosaico inicial esté renderizada
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evalPage(`document.querySelectorAll('#palette-container .palette-card').length > 0`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready, true, 'El mosaico inicial y su paleta deben cargarse en Chromium');

    const e2e = await evalPage(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // 1. Pestaña 2 -> Modo Póster / Contraste sin pointer-events: none
      document.getElementById('tab-btn-f2').click();
      document.getElementById('btn-workmode-poster').click();
      await sleep(80);

      const wrapper = document.getElementById('f2-controls-wrapper');
      const mosaicCtrls = document.getElementById('mosaic-only-controls');
      const posterCtrls = document.getElementById('poster-only-controls');
      const btnContrast = document.getElementById('btn-poster-contrast');

      const wrapperPointer = window.getComputedStyle(wrapper).pointerEvents;
      const btnContrastPointer = window.getComputedStyle(btnContrast).pointerEvents;
      const mosaicHidden = window.getComputedStyle(mosaicCtrls).display === 'none';
      const posterVisible = window.getComputedStyle(posterCtrls).display !== 'none';

      const canvas = document.getElementById('studio-canvas');
      const ctx = canvas.getContext('2d');
      const sampleAtCenter = () => {
        const cx = Math.floor(canvas.width / 2);
        const cy = Math.floor(canvas.height / 2);
        const px = ctx.getImageData(cx - 25, cy - 25, 50, 50).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
        return sum;
      };

      const sumColor = sampleAtCenter();
      document.getElementById('btn-poster-grayscale').click();
      await sleep(80);
      const sumGray = sampleAtCenter();

      document.getElementById('btn-poster-contrast').click();
      await sleep(80);
      const sumContrast = sampleAtCenter();

      document.getElementById('btn-poster-lineart').click();
      await sleep(80);
      const sumLineArt = sampleAtCenter();

      // 2. Abrir Cámara AR con #btn-open-ar (debe iniciar cámara en vivo automáticamente)
      document.getElementById('btn-open-ar').click();
      await sleep(350);

      const arOverlay = document.getElementById('ar-stage-overlay');
      const arOpen = Boolean(arOverlay) && !arOverlay.classList.contains('hidden');
      const arTransform = document.getElementById('ar-warped-layer')?.style.transform || '';
      const arDimTop = document.getElementById('ar-dim-top')?.textContent || '';
      const arDimLeft = document.getElementById('ar-dim-left')?.textContent || '';
      const arVideo = document.getElementById('ar-video');
      const arVideoActive = Boolean(arVideo) && !arVideo.classList.contains('hidden');
      const arLiveBadgeVisible = !document.getElementById('ar-live-indicator')?.classList.contains('hidden');

      // Modificar medidas en vivo dentro de la cámara AR a 150 cm
      const inputMuralW = document.getElementById('input-ar-mural-w');
      inputMuralW.value = '150';
      inputMuralW.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(100);
      const arDimTopUpdated = document.getElementById('ar-dim-top')?.textContent || '';

      document.getElementById('btn-ar-close').click();
      const arClosed = arOverlay.classList.contains('hidden');

      // 3. Abrir Modal PDF y cambiar splitMode a 'batches'
      document.getElementById('btn-export-pdf').click();
      const splitSelect = document.getElementById('select-pdf-split-mode');
      splitSelect.value = 'batches';
      splitSelect.dispatchEvent(new Event('change', { bubbles: true }));
      const batchesFieldVisible = !document.getElementById('pdf-batches-field').classList.contains('hidden');
      document.getElementById('btn-pdf-cancel-export').click();

      // 4. Pestaña 3 Cámara AR + Escena Piso + Solo Contorno
      document.getElementById('tab-btn-f3').click();
      await sleep(100);
      const panelF3Visible = !document.getElementById('panel-f3').classList.contains('hidden');
      const arOpenedFromTab3 = !document.getElementById('ar-stage-overlay').classList.contains('hidden');
      document.getElementById('btn-ar-launch-floor').click();
      await sleep(80);
      const arFloorTransform = document.getElementById('ar-warped-layer')?.style.transform || '';
      const chkArContour = document.getElementById('chk-ar-contour');
      chkArContour.checked = true;
      chkArContour.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(60);
      document.getElementById('btn-ar-close').click();

      // 5. Volver a Pestaña 2 y restaurar Modo Mosaico Teselas
      document.getElementById('tab-btn-f2').click();
      document.getElementById('btn-workmode-mosaic').click();
      await sleep(80);
      const mosaicRestoredVisible = window.getComputedStyle(mosaicCtrls).display !== 'none';
      const posterHiddenAfterRestore = window.getComputedStyle(posterCtrls).display === 'none';

      return {
        wrapperPointer,
        btnContrastPointer,
        mosaicHidden,
        posterVisible,
        posterChangedPixels: sumColor !== sumLineArt && sumGray !== sumLineArt,
        sumColor,
        sumGray,
        sumContrast,
        sumLineArt,
        arOpen,
        arVideoActive,
        arLiveBadgeVisible,
        arDimTopUpdated,
        arClosed,
        arTransform,
        arFloorTransform,
        arDimTop,
        arDimLeft,
        batchesFieldVisible,
        panelF3Visible,
        arOpenedFromTab3,
        mosaicRestoredVisible,
        posterHiddenAfterRestore,
      };
    })()`);

    assert.deepEqual(consoleErrors, [], `Errores de consola: ${consoleErrors.join('; ')}`);
    assert.deepEqual(pageExceptions, [], `Excepciones JS: ${pageExceptions.join('; ')}`);
    assert.deepEqual(failedResponses, [], `Respuestas HTTP >= 400: ${failedResponses.join('; ')}`);

    assert.notEqual(e2e.wrapperPointer, 'none');
    assert.notEqual(e2e.btnContrastPointer, 'none');
    assert.equal(e2e.mosaicHidden, true);
    assert.equal(e2e.posterVisible, true);
    assert.equal(e2e.posterChangedPixels, true, `Canvas no cambió entre modos póster: ${JSON.stringify(e2e)}`);
    assert.equal(e2e.arOpen, true);
    assert.equal(e2e.arVideoActive, true, 'El stream de video de la cámara debe estar activo');
    assert.equal(e2e.arLiveBadgeVisible, true, 'El badge CÁMARA EN VIVO debe ser visible');
    assert.match(e2e.arDimTopUpdated, /150(\.0)? cm/);
    assert.equal(e2e.arClosed, true);
    assert.match(e2e.arTransform, /^matrix3d\(/);
    assert.match(e2e.arFloorTransform, /^matrix3d\(/);
    assert.notEqual(e2e.arFloorTransform, e2e.arTransform);
    assert.match(e2e.arDimTop, /120 cm/);
    assert.match(e2e.arDimLeft, /90 cm/);
    assert.equal(e2e.batchesFieldVisible, true);
    assert.equal(e2e.panelF3Visible, true);
    assert.equal(e2e.arOpenedFromTab3, true);
    assert.equal(e2e.mosaicRestoredVisible, true);
    assert.equal(e2e.posterHiddenAfterRestore, true);
  } finally {
    try {
      ws?.close();
    } catch {}
    chrome.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
  }
});

