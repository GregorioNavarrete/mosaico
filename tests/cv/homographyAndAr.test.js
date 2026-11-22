import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  validateQuadNonCollinear,
  solveHomographyDlt,
  applyHomographyPoint,
  invertHomography3x3,
  computeCssMatrix3d,
  computeDefaultArCorners,
  computeRealWorldQuadMetrics,
  getBuiltInArSceneSvg,
} from '../../src/shared/homography.js';

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

const { createCameraArController } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'public/js/controllers/cameraArController.js')).href
);

test('solveHomographyDlt resuelve exactamente muro rectangular y trapecio oblicuo de piso con error < 0.5 px e inversión exacta', () => {
  const srcQuad = [
    [0, 0],
    [960, 0],
    [960, 720],
    [0, 720],
  ];

  // 1. Muro rectangular desplazado
  const wallDst = [
    [160, 90],
    [640, 90],
    [640, 450],
    [160, 450],
  ];
  const wallRes = solveHomographyDlt(srcQuad, wallDst);
  assert.equal(wallRes.H.length, 9);
  assert.ok(Math.abs(wallRes.H[8] - 1) < 1e-9);
  assert.ok(wallRes.maxErrorPx < 0.5, `Error máximo muro esperado < 0.5 px, obtenido: ${wallRes.maxErrorPx}`);

  // 2. Trapecio oblicuo fuerte en piso (perspectiva acentuada)
  const floorDst = [
    [290, 185],
    [545, 205],
    [740, 495],
    [115, 470],
  ];
  const floorRes = solveHomographyDlt(srcQuad, floorDst);
  assert.ok(floorRes.maxErrorPx < 0.5, `Error máximo piso esperado < 0.5 px, obtenido: ${floorRes.maxErrorPx}`);

  // Verificar proyección directa e inversión exacta H^-1 * H(p) == p
  const invH = invertHomography3x3(floorRes.H);
  assert.ok(Math.abs(invH[8] - 1) < 1e-9);

  const testPoints = [
    [0, 0],
    [480, 360],
    [960, 720],
    [215.5, 512.25],
  ];

  for (const [sx, sy] of testPoints) {
    const [dx, dy] = applyHomographyPoint(floorRes.H, sx, sy);
    const [rx, ry] = applyHomographyPoint(invH, dx, dy);
    const err = Math.hypot(rx - sx, ry - sy);
    assert.ok(err < 1e-5, `Round-trip inv(H)*H(${sx},${sy}) excedió tolerancia: ${err}`);
  }
});

test('validateQuadNonCollinear y solveHomographyDlt rechazan puntos colineales, cruzados, cóncavos o de área degenerada', () => {
  // 4 puntos sobre una línea recta
  const collinear = [
    [10, 10],
    [100, 100],
    [200, 200],
    [300, 300],
  ];
  const c1 = validateQuadNonCollinear(collinear);
  assert.equal(c1.valid, false);
  assert.match(c1.reason, /colineales/i);

  // 3 puntos colineales en el borde superior
  const threeCollinear = [
    [50, 50],
    [150, 50],
    [250, 50],
    [250, 250],
  ];
  const c2 = validateQuadNonCollinear(threeCollinear);
  assert.equal(c2.valid, false);

  // Área menor al umbral minArea = 25
  const tiny = [
    [10, 10],
    [14, 10],
    [14, 14],
    [10, 14],
  ];
  const c3 = validateQuadNonCollinear(tiny, 25);
  assert.equal(c3.valid, false);

  // Moño auto-intersectado
  const bowtie = [
    [100, 100],
    [300, 300],
    [300, 100],
    [100, 300],
  ];
  const c4 = validateQuadNonCollinear(bowtie);
  assert.equal(c4.valid, false);

  const srcQuad = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  assert.throws(() => solveHomographyDlt(srcQuad, collinear), /colineales|inválido/i);
  assert.throws(() => solveHomographyDlt(srcQuad, tiny), /pequeña|inválido/i);
});

test('computeCssMatrix3d genera string CSS column-major válido y reproduce exactamente traslación/escala/perspectiva', () => {
  const dst = [
    [120, 80],
    [600, 100],
    [640, 440],
    [90, 420],
  ];
  const res = computeCssMatrix3d(960, 720, dst);
  assert.ok(res.maxErrorPx < 0.5);
  assert.match(
    res.matrix3d,
    /^matrix3d\(([-0-9.]+,\s*){15}[-0-9.]+\)$/,
    `Formato CSS matrix3d inesperado: ${res.matrix3d}`
  );

  // Verificar orden column-major: entradas 12 y 13 son h02 (tx) y h12 (ty)
  const nums = res.matrix3d
    .replace(/^matrix3d\(|\)$/g, '')
    .split(',')
    .map((v) => Number.parseFloat(v.trim()));
  assert.equal(nums.length, 16);
  assert.ok(Math.abs(nums[12] - 120) < 1e-4, `tx esperado 120, recibido ${nums[12]}`);
  assert.ok(Math.abs(nums[13] - 80) < 1e-4, `ty esperado 80, recibido ${nums[13]}`);
  assert.equal(nums[10], 1);
  assert.equal(nums[15], 1);
});

test('computeDefaultArCorners, computeRealWorldQuadMetrics y getBuiltInArSceneSvg entregan geometría y escenas offline válidas', () => {
  const wallCorners = computeDefaultArCorners(1000, 600, 200, 100, 'wall');
  assert.equal(wallCorners.length, 4);
  const wallW = wallCorners[1][0] - wallCorners[0][0];
  const wallH = wallCorners[3][1] - wallCorners[0][1];
  assert.ok(Math.abs(wallW / wallH - 2.0) < 1e-6, 'Debe preservar relación exacta 200:100 = 2.0');
  assert.ok(validateQuadNonCollinear(wallCorners).valid);

  const floorCorners = computeDefaultArCorners(1000, 600, 120, 90, 'floor');
  assert.equal(floorCorners.length, 4);
  const topWidth = floorCorners[1][0] - floorCorners[0][0];
  const botWidth = floorCorners[2][0] - floorCorners[3][0];
  assert.ok(botWidth > topWidth, 'Preset floor debe formar trapecio con base inferior más ancha');
  assert.ok(floorCorners[0][1] < floorCorners[2][1], 'Borde superior debe estar más arriba que el inferior');
  assert.ok(validateQuadNonCollinear(floorCorners).valid);

  const metrics = computeRealWorldQuadMetrics(
    wallCorners,
    { widthCm: 200, heightCm: 100 },
    { totalPages: 24 },
    5000,
    400
  );
  assert.equal(metrics.widthLabel, '200 cm');
  assert.equal(metrics.heightLabel, '100 cm');
  assert.equal(metrics.areaM2, '2.00');
  assert.equal(metrics.sheetsLabel, '24 hojas');
  assert.match(metrics.tilesLabel, /5\.000|5,000|5000/);
  assert.equal(metrics.referenceScaleInfo.coveragePct, 50);

  const wallSvg = getBuiltInArSceneSvg('wall');
  const floorSvg = getBuiltInArSceneSvg('floor');
  assert.match(wallSvg, /^<svg\b/);
  assert.match(floorSvg, /^<svg\b/);
  const stripXmlns = (s) => s.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
  assert.doesNotMatch(stripXmlns(wallSvg + floorSvg), /https?:\/\//i);
});

test('ar-camera.css cumple políticas offline y usa solo tokens de diseño locales', () => {
  const css = fs.readFileSync(path.join(ROOT_DIR, 'public/css/ar-camera.css'), 'utf8');
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.match(css, /--color-paper/);
  assert.match(css, /--color-surface/);
  assert.match(css, /--color-ink/);
  assert.match(css, /--color-forest/);
  assert.match(css, /--color-terra/);
  assert.match(css, /--font-sans/);
  assert.match(css, /--font-mono/);
});

test('cameraArController abre/cierra escenario, calcula matrix3d, gestiona fallback sin cámara, modo Strobe y detiene tracks MediaStream al cerrar', async () => {
  // Mock DOM mínimo compatible con createCameraArController
  function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) set.delete(c);
          else set.add(c);
        } else if (force) set.add(c);
        else set.delete(c);
      },
      contains: (c) => set.has(c),
    };
  }

  function makeMockEl(tag = 'div', id = '') {
    const listeners = {};
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: '',
      classList: makeClassList(),
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      textContent: '',
      value: '',
      checked: false,
      width: 720,
      height: 540,
      clientWidth: 800,
      clientHeight: 540,
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'id') this.id = String(v);
      },
      getAttribute(k) {
        return this.attributes[k] ?? null;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      remove() {},
      addEventListener(ev, fn) {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(fn);
      },
      dispatchEvent(evObj) {
        (listeners[evObj.type] || []).forEach((fn) => fn(evObj));
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 540 }),
      play: async () => {},
      pause: () => {},
    };
    return el;
  }

  const host = makeMockEl('main', 'studio-main');
  const overlayIds = new Map();
  let createdOverlay = null;

  const mockDoc = {
    body: makeMockEl('body'),
    querySelector(sel) {
      if (sel === '.studio-main') return host;
      return null;
    },
    getElementById(id) {
      return overlayIds.get(id) || null;
    },
    createElement(tag) {
      const el = makeMockEl(tag);
      if (tag === 'section') {
        createdOverlay = el;
        // Stub querySelector / querySelectorAll sobre el HTML inyectado
        Object.defineProperty(el, 'innerHTML', {
          set(html) {
            this._html = html;
            const idMatches = html.matchAll(/id="([^"]+)"/g);
            for (const m of idMatches) {
              const sub = makeMockEl('div', m[1]);
              if (m[1] === 'ar-scene-box') {
                sub.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 540 });
              }
              overlayIds.set(m[1], sub);
            }
          },
          get() {
            return this._html || '';
          },
        });
        el.querySelector = (sel) => {
          if (sel.startsWith('#')) return overlayIds.get(sel.slice(1)) || null;
          return null;
        };
        el.querySelectorAll = (sel) => {
          if (sel === '.ar-corner-pin') {
            return [0, 1, 2, 3].map((idx) => {
              const p = makeMockEl('button');
              p.dataset.corner = String(idx);
              return p;
            });
          }
          return [];
        };
      }
      return el;
    },
  };

  let stoppedTracks = 0;
  const mockWin = {
    isSecureContext: true,
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          return {
            getTracks: () => [
              {
                stop() {
                  stoppedTracks++;
                },
              },
            ],
          };
        },
      },
    },
    addEventListener() {},
  };

  let drawCalls = 0;
  const fakeStore = {
    getState: () => ({
      config: { widthCm: 120, heightCm: 90, mosaicMode: true },
      printMetrics: { totalPages: 28 },
      totalTiles: 2700,
    }),
  };

  const controller = createCameraArController({
    store: fakeStore,
    drawArtworkToCanvas: (canvas, opts) => {
      drawCalls++;
      assert.ok(canvas.width > 0 && canvas.height > 0);
      assert.equal(typeof opts.forceContour, 'boolean');
    },
    showToast: () => {},
    doc: mockDoc,
    win: mockWin,
  });

  controller.open();
  assert.ok(createdOverlay);
  overlayIds.set('ar-stage-overlay', createdOverlay);
  assert.equal(controller.getState().isOpen, true);
  assert.ok(drawCalls >= 1);

  // Verificar cálculo inmediato de matrix3d tras abrir
  controller.applyPreset('floor');
  await new Promise((r) => setTimeout(r, 35));
  const warpedLayer = overlayIds.get('ar-warped-layer');
  assert.match(warpedLayer.style.transform, /^matrix3d\(/);

  // Iniciar cámara mock y verificar que cierre detiene el MediaStream track
  const started = await controller.startCamera();
  assert.equal(started, true);
  controller.close();
  assert.equal(stoppedTracks, 1);
  assert.equal(controller.getState().isOpen, false);
});

test('cameraArController gestiona fallback HTTP LAN sin getUserMedia, Strobe, contorno para calcar, escala real y carga HTTP en Express', async () => {
  const { createApp } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/app.js')).href);

  // 1. Verificar que Express sirve todos los artefactos CV/AR con HTTP 200
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    for (const urlPath of [
      '/shared/homography.js',
      '/public/css/ar-camera.css',
      '/public/js/controllers/cameraArController.js',
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
      assert.equal(res.status, 200, `Se esperaba HTTP 200 para ${urlPath}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 2. Probar fallback sin cámara en contexto HTTP no seguro + Strobe + contorno + escala pared
  const overlayIds = new Map();
  let createdOverlay = null;
  const toasts = [];
  const contourCalls = [];

  function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) set.delete(c);
          else set.add(c);
        } else if (force) set.add(c);
        else set.delete(c);
      },
      contains: (c) => set.has(c),
    };
  }

  function makeMockEl(tag = 'div', id = '') {
    const listeners = {};
    return {
      tagName: tag.toUpperCase(),
      id,
      classList: makeClassList(),
      dataset: {},
      style: {},
      attributes: {},
      textContent: '',
      value: '',
      checked: false,
      width: 720,
      height: 540,
      clientWidth: 800,
      clientHeight: 540,
      setAttribute(k, v) {
        this.attributes[k] = String(v);
      },
      getAttribute(k) {
        return this.attributes[k] ?? null;
      },
      appendChild(c) {
        return c;
      },
      remove() {},
      addEventListener(ev, fn) {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(fn);
      },
      dispatchEvent(evObj) {
        (listeners[evObj.type] || []).forEach((fn) => fn(evObj));
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 540 }),
    };
  }

  const host = makeMockEl('main', 'studio-main');
  const mockDoc = {
    body: makeMockEl('body'),
    querySelector: (sel) => (sel === '.studio-main' ? host : null),
    getElementById: (id) => overlayIds.get(id) || null,
    createElement(tag) {
      const el = makeMockEl(tag);
      if (tag === 'section') {
        createdOverlay = el;
        Object.defineProperty(el, 'innerHTML', {
          set(html) {
            this._html = html;
            const idMatches = html.matchAll(/id="([^"]+)"/g);
            for (const m of idMatches) {
              const sub = makeMockEl('div', m[1]);
              if (m[1] === 'ar-scene-box') {
                sub.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 540 });
              }
              overlayIds.set(m[1], sub);
            }
          },
          get() {
            return this._html || '';
          },
        });
        el.querySelector = (sel) => (sel.startsWith('#') ? overlayIds.get(sel.slice(1)) || null : null);
        el.querySelectorAll = (sel) =>
          sel === '.ar-corner-pin'
            ? [0, 1, 2, 3].map((i) => {
                const p = makeMockEl('button');
                p.dataset.corner = String(i);
                return p;
              })
            : [];
      }
      return el;
    },
  };

  const insecureLanWin = {
    isSecureContext: false,
    navigator: {},
    addEventListener() {},
  };

  const controller = createCameraArController({
    store: {
      getState: () => ({
        config: { widthCm: 150, heightCm: 100, mosaicMode: true },
        printMetrics: { totalPages: 30 },
        totalTiles: 3750,
      }),
    },
    drawArtworkToCanvas: (_canvas, opts) => {
      contourCalls.push(Boolean(opts?.forceContour));
    },
    showToast: (msg, type) => toasts.push({ msg, type }),
    doc: mockDoc,
    win: insecureLanWin,
  });

  controller.open();
  overlayIds.set('ar-stage-overlay', createdOverlay);

  const camOk = await controller.startCamera();
  assert.equal(camOk, false);
  const noticeEl = overlayIds.get('ar-camera-notice');
  const noticeText = overlayIds.get('ar-camera-notice-text');
  assert.equal(noticeEl.classList.contains('hidden'), false);
  assert.match(noticeText.textContent, /HTTP LAN|HTTPS|foto/i);

  // Activar contorno para calcar en AR
  const chkContour = overlayIds.get('chk-ar-contour');
  chkContour.checked = true;
  chkContour.dispatchEvent({ type: 'change' });
  assert.equal(contourCalls[contourCalls.length - 1], true);

  // Ingresar ancho real de pared (300 cm -> 50% de cobertura) y verificar metricsHud
  const refInput = overlayIds.get('input-ar-ref-wall-cm');
  refInput.value = '300';
  refInput.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 35));
  assert.match(overlayIds.get('ar-metrics-hud').textContent, /50\.0%/);

  // Activar modo Strobe a 5 Hz y verificar parpadeo de opacidad
  const chkStrobe = overlayIds.get('chk-ar-strobe');
  const rangeHz = overlayIds.get('range-ar-strobe-hz');
  rangeHz.value = '5';
  rangeHz.dispatchEvent({ type: 'input' });
  chkStrobe.checked = true;
  chkStrobe.dispatchEvent({ type: 'change' });

  await new Promise((r) => setTimeout(r, 140));
  const warpedLayer = overlayIds.get('ar-warped-layer');
  assert.ok(
    warpedLayer.style.opacity === '0.04' || warpedLayer.style.opacity === '0.78',
    `Opacidad Strobe inesperada: ${warpedLayer.style.opacity}`
  );

  // Al cerrar se detiene el timer Strobe y se restaura opacidad limpia
  controller.close();
  assert.equal(controller.getState().isOpen, false);
  assert.ok(toasts.some((t) => t.type === 'warn'));
});

test('Navegador real Chromium ejecuta homography.js, ar-camera.css y cameraArController sin errores de módulo ni reproyección', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const http = await import('node:http');
  const execFileAsync = promisify(execFile);

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

  const { createApp } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/app.js')).href);
  const app = createApp();
  const baseServer = app.listen(0);
  const basePort = baseServer.address().port;

  const proxy = http.createServer((req, res) => {
    if (req.url === '/__ar-browser-test.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="/public/css/tokens.css" />
  <link rel="stylesheet" href="/public/css/layout.css" />
  <link rel="stylesheet" href="/public/css/components.css" />
  <link rel="stylesheet" href="/public/css/ar-camera.css" />
</head>
<body>
  <main class="studio-main" style="width: 1000px; height: 680px;"></main>
  <pre id="ar-browser-result">PENDING</pre>
  <script type="module">
    import { createCameraArController } from "/public/js/controllers/cameraArController.js";
    import { createStudioStore } from "/public/js/state/studioStore.js";

    const out = document.getElementById("ar-browser-result");
    try {
      const store = createStudioStore();
      const ar = createCameraArController({
        store,
        drawArtworkToCanvas(canvas) {
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#36594d";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        },
        showToast() {},
      });
      ar.open();
      ar.applyPreset("floor");
      const layer = document.getElementById("ar-warped-layer");
      const overlay = document.getElementById("ar-stage-overlay");
      const hud = document.getElementById("ar-metrics-hud");
      const payload = {
        ok: true,
        open: !overlay.classList.contains("hidden"),
        transform: layer.style.transform,
        hudText: hud.textContent,
        errorPx: ar.getState().lastMaxErrorPx,
      };
      ar.close();
      payload.closed = overlay.classList.contains("hidden");
      out.textContent = JSON.stringify(payload);
    } catch (err) {
      out.textContent = JSON.stringify({ ok: false, error: err.message });
    }
  </script>
</body>
</html>`);
      return;
    }

    const proxyReq = http.request(
      { hostname: '127.0.0.1', port: basePort, path: req.url, method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    req.pipe(proxyReq);
  });

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;

  try {
    const { stdout } = await execFileAsync(
      'chromium',
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1280,820',
        '--virtual-time-budget=1200',
        '--dump-dom',
        `http://127.0.0.1:${proxyPort}/__ar-browser-test.html`,
      ],
      { timeout: 15000 }
    );

    const match = stdout.match(/<pre id="ar-browser-result">([^<]+)<\/pre>/);
    assert.ok(match, 'Debe existir resultado DOM de Chromium');
    const parsed = JSON.parse(match[1]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.open, true);
    assert.equal(parsed.closed, true);
    assert.match(parsed.transform, /^matrix3d\(/);
    assert.ok(parsed.errorPx < 0.5, `Error reproyección navegador: ${parsed.errorPx}`);
    assert.match(parsed.hudText, /120 cm × 90 cm/);
  } finally {
    proxy.close();
    baseServer.close();
  }
});

test('arSpatialTracker calcula dimensiones de pared por 2 toques y proyecta anclaje VR al girar y acercarse', async () => {
  const {
    computeWallCalibrationFromTwoPoints,
    computeAnchoredCornersFromMotion,
  } = await import('../../public/js/controllers/arSpatialTracker.js');

  // Calibración por 2 puntos de una puerta de 80 cm ocupando 200 px en escena 800x600
  const cal = computeWallCalibrationFromTwoPoints({
    ptA: [100, 100],
    ptB: [300, 100],
    knownCm: 80,
    sceneW: 800,
    sceneH: 600,
    fovDeg: 62,
  });
  assert.ok(cal);
  assert.equal(cal.distPx, 200);
  assert.equal(cal.pxPerCm, 2.5);
  assert.equal(cal.wallWidthCm, 320); // 800 / 2.5 = 320 cm (3.20 m)
  assert.equal(cal.wallHeightCm, 240); // 600 / 2.5 = 240 cm (2.40 m)
  assert.ok(cal.distanceM > 2.0 && cal.distanceM < 3.5);

  // Anclaje en pared: si gira cámara 10° y se acerca a la mitad de distancia, el cuadro se desplaza y escala x2 alrededor del centro
  const anchorCorners = [
    [250, 150],
    [550, 150],
    [550, 450],
    [250, 450],
  ];
  const moved = computeAnchoredCornersFromMotion({
    anchorCorners,
    anchorOrientation: { alpha: 100, beta: 90, gamma: 0 },
    currentOrientation: { alpha: 90, beta: 90, gamma: 0 },
    anchorDistanceM: 3.0,
    currentDistanceM: 1.5,
    sceneW: 800,
    sceneH: 600,
    fovDeg: 62,
  });
  assert.equal(moved.length, 4);
  // El ancho del cuadro se duplicó al acercarse a mitad de distancia (de 300px a 600px)
  const newWidth = moved[1][0] - moved[0][0];
  assert.ok(Math.abs(newWidth - 600) < 1e-6, `Ancho esperado 600, obtenido ${newWidth}`);
  // Al girar alpha -10°, el cuadro se desplazó a la izquierda respecto al centro
  const newCenterX = (moved[0][0] + moved[1][0]) / 2;
  assert.ok(newCenterX < 400, `Centro X esperado < 400 al girar, obtenido ${newCenterX}`);
});



