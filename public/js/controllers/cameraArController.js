import {
  validateQuadNonCollinear,
  solveHomographyDlt,
  applyHomographyPoint,
  invertHomography3x3,
  computeCssMatrix3d,
  computeDefaultArCorners,
  computeRealWorldQuadMetrics,
  getBuiltInArSceneSvg,
} from '/shared/homography.js';

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function getStageDimensions(el) {
  if (!el) return { w: 800, h: 540 };
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  const w = Math.max(240, rect?.width || el.clientWidth || 800);
  const h = Math.max(180, rect?.height || el.clientHeight || 540);
  return { w, h };
}

function svgToDataUrl(svgString) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
}

/**
 * Dibuja un cuadrilátero de una imagen/canvas origen sobre un contexto Canvas 2D
 * utilizando subdivisión proyectiva en triángulos afines a partir de la homografía inversa.
 * Garantiza exportaciones PNG nítidas 100% compatibles offline sin WebGL.
 */
function renderProjectiveQuadOnCanvas(ctx, srcCanvas, dstPts, alpha = 1, subdivisions = 14) {
  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;
  if (srcW <= 0 || srcH <= 0) return;

  const srcQuad = [
    [0, 0],
    [srcW, 0],
    [srcW, srcH],
    [0, srcH],
  ];
  const { H } = solveHomographyDlt(srcQuad, dstPts);

  const proj = (u, v) => applyHomographyPoint(H, u * srcW, v * srcH);

  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);

  const drawTexturedTriangle = (s0, s1, s2, d0, d1, d2) => {
    const denom = s0[0] * (s1[1] - s2[1]) + s1[0] * (s2[1] - s0[1]) + s2[0] * (s0[1] - s1[1]);
    if (Math.abs(denom) < 1e-7) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d0[0], d0[1]);
    ctx.lineTo(d1[0], d1[1]);
    ctx.lineTo(d2[0], d2[1]);
    ctx.closePath();
    ctx.clip();

    // Transformación afín exacta entre triángulo fuente (s0,s1,s2) y destino (d0,d1,d2)
    const a = (d0[0] * (s1[1] - s2[1]) + d1[0] * (s2[1] - s0[1]) + d2[0] * (s0[1] - s1[1])) / denom;
    const b = (d0[1] * (s1[1] - s2[1]) + d1[1] * (s2[1] - s0[1]) + d2[1] * (s0[1] - s1[1])) / denom;
    const c = (d0[0] * (s2[0] - s1[0]) + d1[0] * (s0[0] - s2[0]) + d2[0] * (s1[0] - s0[0])) / denom;
    const d = (d0[1] * (s2[0] - s1[0]) + d1[1] * (s0[0] - s2[0]) + d2[1] * (s1[0] - s0[0])) / denom;
    const e =
      (d0[0] * (s1[0] * s2[1] - s2[0] * s1[1]) +
        d1[0] * (s2[0] * s0[1] - s0[0] * s2[1]) +
        d2[0] * (s0[0] * s1[1] - s1[0] * s0[1])) /
      denom;
    const f =
      (d0[1] * (s1[0] * s2[1] - s2[0] * s1[1]) +
        d1[1] * (s2[0] * s0[1] - s0[0] * s2[1]) +
        d2[1] * (s0[0] * s1[1] - s1[0] * s0[1])) /
      denom;

    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.restore();
  };

  for (let iy = 0; iy < subdivisions; iy++) {
    const v0 = iy / subdivisions;
    const v1 = (iy + 1) / subdivisions;
    for (let ix = 0; ix < subdivisions; ix++) {
      const u0 = ix / subdivisions;
      const u1 = (ix + 1) / subdivisions;

      const s00 = [u0 * srcW, v0 * srcH];
      const s10 = [u1 * srcW, v0 * srcH];
      const s11 = [u1 * srcW, v1 * srcH];
      const s01 = [u0 * srcW, v1 * srcH];

      const d00 = proj(u0, v0);
      const d10 = proj(u1, v0);
      const d11 = proj(u1, v1);
      const d01 = proj(u0, v1);

      drawTexturedTriangle(s00, s10, s11, d00, d10, d11);
      drawTexturedTriangle(s00, s11, s01, d00, d11, d01);
    }
  }

  ctx.restore();
}

/**
 * Controlador modular de Realidad Aumentada (cámara en vivo / foto de pared o piso / escenas SVG offline).
 */
export function createCameraArController({
  store,
  drawArtworkToCanvas,
  showToast = () => {},
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
}) {
  let overlayEl = doc?.getElementById('ar-stage-overlay') || null;
  let dom = {};

  const arState = {
    isOpen: false,
    sourceMode: 'scene', // 'camera' | 'photo' | 'scene'
    sceneType: 'wall', // 'wall' | 'floor'
    facingMode: 'environment', // 'environment' | 'user'
    selectedDeviceId: null,
    corners: null, // [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] en px dentro de #ar-scene-box
    lockAspect: true,
    opacity: 0.78,
    strobeEnabled: false,
    strobeHz: 2.5,
    strobeVisible: true,
    contourOnly: false,
    showSheetGrid: false,
    referenceWallWidthCm: null,
    artW: 720,
    artH: 540,
    photoObjectUrl: null,
    lastH: null,
    lastInvH: null,
    lastMaxErrorPx: 0,
  };

  let mediaStream = null;
  let strobeTimerId = null;
  let transformRafId = null;
  let pendingTransformSync = false;
  let activeDrag = null; // { type: 'corner', index, startCorners } | { type: 'move', startX, startY, startCorners }
  let boundResizeListener = false;

  function ensureOverlayMarkup() {
    if (!doc) return null;
    overlayEl = doc.getElementById('ar-stage-overlay');
    if (overlayEl && overlayEl.dataset.arReady === '1') {
      bindDomRefs();
      return overlayEl;
    }

    const host = doc.body || doc.querySelector('.studio-main');
    if (!host) return null;

    if (!overlayEl) {
      overlayEl = doc.createElement('section');
      overlayEl.id = 'ar-stage-overlay';
      overlayEl.className = 'hidden';
      overlayEl.setAttribute('aria-label', 'Estudio de Realidad Aumentada y Perspectiva en Pared');
      host.appendChild(overlayEl);
    }

    overlayEl.dataset.arReady = '1';
    overlayEl.innerHTML = `
      <header class="ar-topbar">
        <div class="ar-topbar-title">
          <span class="ar-badge">AR · Homografía 4 pts</span>
          <h2 class="ar-heading">Probar en Pared / Piso</h2>
          <span id="ar-status-text" class="ar-status-text">Listo para iniciar</span>
        </div>
        <div class="ar-topbar-actions">
          <button id="btn-ar-start-camera" type="button" class="ar-btn ar-btn-forest" title="Iniciar o reiniciar cámara en vivo">📷 Cámara en vivo</button>
          <select id="select-ar-camera-device" class="ar-btn ar-select-device hidden" title="Seleccionar cámara conectada"></select>
          <button id="btn-ar-flip-camera" type="button" class="ar-btn" title="Alternar cámara trasera o frontal">⇄ Cambiar cámara</button>
          <button id="btn-ar-snap-photo" type="button" class="ar-btn" title="Tomar foto con la cámara (ideal para celulares y tablets)">📸 Tomar foto</button>
          <input id="ar-photo-capture" type="file" accept="image/*" capture="environment" class="hidden" />
          <button id="btn-ar-upload-photo" type="button" class="ar-btn" title="Subir foto guardada en tu equipo">Subir foto</button>
          <input id="ar-photo-input" type="file" accept="image/jpeg,image/png,image/webp" class="hidden" />
          <button id="btn-ar-scene-wall" type="button" class="ar-btn">Escena Pared</button>
          <button id="btn-ar-scene-floor" type="button" class="ar-btn">Escena Piso</button>
          <button id="btn-ar-close" type="button" class="ar-btn ar-btn-terra" title="Cerrar simulador y volver al editor">✕ Volver al Editor</button>
        </div>
      </header>

      <div class="ar-workspace">
        <div class="ar-viewport">
          <div id="ar-scene-box">
            <video id="ar-video" autoplay playsinline muted class="hidden"></video>
            <img id="ar-photo-img" alt="Fondo de pared o piso para simulación AR" />
            <div id="ar-live-indicator" class="ar-live-badge hidden">Cámara en Vivo</div>

            <div id="ar-camera-notice" class="ar-camera-notice hidden" role="status">
              <span id="ar-camera-notice-text"></span>
              <button id="btn-ar-notice-dismiss" type="button" class="ar-btn">Entendido</button>
            </div>

            <div id="ar-warped-layer">
              <canvas id="ar-artwork-canvas" width="720" height="540"></canvas>
            </div>

            <svg id="ar-quad-svg" class="ar-quad-outline" aria-hidden="true">
              <line id="ar-diag-1" class="ar-quad-diags" x1="0" y1="0" x2="0" y2="0" />
              <line id="ar-diag-2" class="ar-quad-diags" x1="0" y1="0" x2="0" y2="0" />
              <polygon id="ar-quad-poly" class="ar-quad-poly" points="0,0 100,0 100,100 0,100" />
            </svg>

            <div id="ar-dim-top" class="ar-dim-callout">↔ 120 cm</div>
            <div id="ar-dim-left" class="ar-dim-callout is-terra">↕ 90 cm</div>

            <button type="button" class="ar-corner-pin" data-corner="0" aria-label="Esquina superior izquierda">1</button>
            <button type="button" class="ar-corner-pin" data-corner="1" aria-label="Esquina superior derecha">2</button>
            <button type="button" class="ar-corner-pin" data-corner="2" aria-label="Esquina inferior derecha">3</button>
            <button type="button" class="ar-corner-pin" data-corner="3" aria-label="Esquina inferior izquierda">4</button>

            <div id="ar-metrics-hud" class="ar-metrics-hud">120 × 90 cm · 1.08 m²</div>
          </div>
        </div>

        <div class="ar-controls-bar">
          <div class="ar-control-group">
            <div class="ar-field ar-dim-inputs" title="Ajustar dimensiones reales del mural (cm) directamente en la vista">
              <label>Medidas (cm):</label>
              <input id="input-ar-mural-w" type="number" min="5" max="2500" step="0.5" value="120" title="Ancho en cm" />
              <span>×</span>
              <input id="input-ar-mural-h" type="number" min="5" max="2500" step="0.5" value="90" title="Alto en cm" />
            </div>

            <button id="btn-ar-preset-wall" type="button" class="ar-btn" title="Proyectar sobre pared vertical">🧱 Pared</button>
            <button id="btn-ar-preset-floor" type="button" class="ar-btn" title="Proyectar sobre piso en perspectiva">📐 Piso</button>
            <button id="btn-ar-fit-aspect" type="button" class="ar-btn">Ajustar W:H</button>
            <label class="ar-toggle-label" title="Mantener proporción real ancho/alto al arrastrar esquinas">
              <input id="chk-ar-lock-aspect" type="checkbox" checked />
              <span>Bloquear W:H</span>
            </label>
          </div>

          <div class="ar-control-group">
            <div class="ar-field">
              <label for="range-ar-opacity">Opacidad</label>
              <input id="range-ar-opacity" type="range" min="10" max="100" step="2" value="78" />
              <span id="val-ar-opacity" class="ar-mono-val">78%</span>
            </div>

            <label class="ar-toggle-label" title="Parpadeo intermitente para comparar obra con pared real">
              <input id="chk-ar-strobe" type="checkbox" />
              <span>Modo Strobe</span>
            </label>

            <div class="ar-field">
              <label for="range-ar-strobe-hz">Hz</label>
              <input id="range-ar-strobe-hz" type="range" min="0.5" max="8" step="0.5" value="2.5" />
              <span id="val-ar-strobe-hz" class="ar-mono-val">2.5 Hz</span>
            </div>

            <label class="ar-toggle-label" title="Mostrar solo líneas de contorno transparentes para calcar en pared">
              <input id="chk-ar-contour" type="checkbox" />
              <span>Solo contorno para calcar</span>
            </label>

            <div class="ar-field" title="Ancho físico de referencia del muro o piso visible para estimar escala exacta">
              <label for="input-ar-ref-wall-cm">Ancho real pared/piso</label>
              <input id="input-ar-ref-wall-cm" type="number" min="20" max="3000" step="5" placeholder="ej. 300" />
              <span>cm</span>
            </div>
          </div>

          <div class="ar-control-group">
            <button id="btn-ar-capture-png" type="button" class="ar-btn ar-btn-forest" title="Descargar imagen PNG con la cámara, obra proyectada y medidas">📸 Guardar Foto con Medidas (.png)</button>
          </div>
        </div>
      </div>
    `;

    bindDomRefs();
    bindOverlayEvents();
    return overlayEl;
  }

  function bindDomRefs() {
    if (!overlayEl) return;
    dom = {
      statusText: overlayEl.querySelector('#ar-status-text'),
      btnStartCamera: overlayEl.querySelector('#btn-ar-start-camera'),
      selectCameraDevice: overlayEl.querySelector('#select-ar-camera-device'),
      btnFlipCamera: overlayEl.querySelector('#btn-ar-flip-camera'),
      btnSnapPhoto: overlayEl.querySelector('#btn-ar-snap-photo'),
      photoCaptureInput: overlayEl.querySelector('#ar-photo-capture'),
      btnUploadPhoto: overlayEl.querySelector('#btn-ar-upload-photo'),
      photoInput: overlayEl.querySelector('#ar-photo-input'),
      btnSceneWall: overlayEl.querySelector('#btn-ar-scene-wall'),
      btnSceneFloor: overlayEl.querySelector('#btn-ar-scene-floor'),
      btnClose: overlayEl.querySelector('#btn-ar-close'),
      sceneBox: overlayEl.querySelector('#ar-scene-box'),
      video: overlayEl.querySelector('#ar-video'),
      photoImg: overlayEl.querySelector('#ar-photo-img'),
      liveIndicator: overlayEl.querySelector('#ar-live-indicator'),
      cameraNotice: overlayEl.querySelector('#ar-camera-notice'),
      cameraNoticeText: overlayEl.querySelector('#ar-camera-notice-text'),
      btnNoticeDismiss: overlayEl.querySelector('#btn-ar-notice-dismiss'),
      warpedLayer: overlayEl.querySelector('#ar-warped-layer'),
      artworkCanvas: overlayEl.querySelector('#ar-artwork-canvas'),
      quadPoly: overlayEl.querySelector('#ar-quad-poly'),
      diag1: overlayEl.querySelector('#ar-diag-1'),
      diag2: overlayEl.querySelector('#ar-diag-2'),
      dimTop: overlayEl.querySelector('#ar-dim-top'),
      dimLeft: overlayEl.querySelector('#ar-dim-left'),
      metricsHud: overlayEl.querySelector('#ar-metrics-hud'),
      pins: Array.from(overlayEl.querySelectorAll('.ar-corner-pin')),
      inputMuralW: overlayEl.querySelector('#input-ar-mural-w'),
      inputMuralH: overlayEl.querySelector('#input-ar-mural-h'),
      btnPresetWall: overlayEl.querySelector('#btn-ar-preset-wall'),
      btnPresetFloor: overlayEl.querySelector('#btn-ar-preset-floor'),
      btnFitAspect: overlayEl.querySelector('#btn-ar-fit-aspect'),
      chkLockAspect: overlayEl.querySelector('#chk-ar-lock-aspect'),
      rangeOpacity: overlayEl.querySelector('#range-ar-opacity'),
      valOpacity: overlayEl.querySelector('#val-ar-opacity'),
      chkStrobe: overlayEl.querySelector('#chk-ar-strobe'),
      rangeStrobeHz: overlayEl.querySelector('#range-ar-strobe-hz'),
      valStrobeHz: overlayEl.querySelector('#val-ar-strobe-hz'),
      chkContour: overlayEl.querySelector('#chk-ar-contour'),
      inputRefWallCm: overlayEl.querySelector('#input-ar-ref-wall-cm'),
      btnCapturePng: overlayEl.querySelector('#btn-ar-capture-png'),
    };
  }

  function showCameraNotice(msg) {
    if (!dom.cameraNotice || !dom.cameraNoticeText) return;
    dom.cameraNoticeText.textContent = msg;
    dom.cameraNotice.classList.remove('hidden');
  }

  function hideCameraNotice() {
    dom.cameraNotice?.classList.add('hidden');
  }

  function stopCameraStream() {
    if (mediaStream) {
      const tracks = typeof mediaStream.getTracks === 'function' ? mediaStream.getTracks() : [];
      for (const track of tracks) {
        try {
          track.stop();
        } catch {
          // noop
        }
      }
      mediaStream = null;
    }
    if (dom.video) {
      try {
        dom.video.pause();
      } catch {
        // noop
      }
      dom.video.srcObject = null;
      dom.video.classList.add('hidden');
    }
    if (dom.liveIndicator) dom.liveIndicator.classList.add('hidden');
    if (dom.btnStartCamera) dom.btnStartCamera.classList.remove('is-active');
  }

  function stopStrobeTimer() {
    if (strobeTimerId !== null) {
      clearInterval(strobeTimerId);
      strobeTimerId = null;
    }
    arState.strobeVisible = true;
    applyOpacityVisual();
  }

  function syncStrobeTimer() {
    if (strobeTimerId !== null) {
      clearInterval(strobeTimerId);
      strobeTimerId = null;
    }
    if (!arState.isOpen || !arState.strobeEnabled) {
      arState.strobeVisible = true;
      applyOpacityVisual();
      return;
    }

    const hz = clamp(Number(arState.strobeHz) || 2.5, 0.5, 10);
    const intervalMs = Math.max(50, Math.round(500 / hz));
    strobeTimerId = setInterval(() => {
      arState.strobeVisible = !arState.strobeVisible;
      applyOpacityVisual();
    }, intervalMs);
  }

  function applyOpacityVisual() {
    if (!dom.warpedLayer) return;
    const effectiveOpacity = arState.strobeEnabled && !arState.strobeVisible ? 0.04 : arState.opacity;
    dom.warpedLayer.style.opacity = String(effectiveOpacity);
  }

  function revokePhotoUrl() {
    if (arState.photoObjectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(arState.photoObjectUrl);
      } catch {
        // noop
      }
      arState.photoObjectUrl = null;
    }
  }

  function loadBuiltInScene(scene = 'wall') {
    stopCameraStream();
    revokePhotoUrl();
    arState.sourceMode = 'scene';
    arState.sceneType = scene === 'floor' ? 'floor' : 'wall';

    if (dom.photoImg) {
      dom.photoImg.src = svgToDataUrl(getBuiltInArSceneSvg(arState.sceneType));
      dom.photoImg.classList.remove('hidden');
    }
    if (dom.btnSceneWall) dom.btnSceneWall.classList.toggle('is-active', arState.sceneType === 'wall');
    if (dom.btnSceneFloor) dom.btnSceneFloor.classList.toggle('is-active', arState.sceneType === 'floor');
    if (dom.statusText) {
      dom.statusText.textContent =
        arState.sceneType === 'floor' ? 'Escena Piso Perspectiva (Offline)' : 'Escena Pared Estudio (Offline)';
    }

    // Si es escena piso, aplicar preset perspectiva automáticamente y desbloquear aspecto libre
    applyPreset(arState.sceneType === 'floor' ? 'floor' : 'wall');
  }

  function syncArtworkCanvas() {
    if (!dom.artworkCanvas || typeof drawArtworkToCanvas !== 'function') return;
    const state = store.getState();
    const cfg = state.config || {};
    const ratio = clamp((Number(cfg.widthCm) || 120) / Math.max(1, Number(cfg.heightCm) || 90), 0.12, 8.5);
    const maxSide = 960;
    const artW = ratio >= 1 ? maxSide : Math.max(160, Math.round(maxSide * ratio));
    const artH = ratio >= 1 ? Math.max(160, Math.round(maxSide / ratio)) : maxSide;

    arState.artW = artW;
    arState.artH = artH;
    dom.artworkCanvas.width = artW;
    dom.artworkCanvas.height = artH;

    if (dom.warpedLayer) {
      dom.warpedLayer.style.width = `${artW}px`;
      dom.warpedLayer.style.height = `${artH}px`;
    }

    drawArtworkToCanvas(dom.artworkCanvas, {
      forceContour: arState.contourOnly,
      showGrid: arState.showSheetGrid,
    });
  }

  function applyPreset(preset = 'wall') {
    const state = store.getState();
    const cfg = state.config || {};
    const { w, h } = getStageDimensions(dom.sceneBox);
    arState.corners = computeDefaultArCorners(w, h, cfg.widthCm || 120, cfg.heightCm || 90, preset);
    if (preset === 'floor') {
      arState.lockAspect = false;
      if (dom.chkLockAspect) dom.chkLockAspect.checked = false;
    }
    renderTransformNow();
  }

  function fitCornersToAspect() {
    if (!Array.isArray(arState.corners) || arState.corners.length !== 4) {
      applyPreset('wall');
      return;
    }
    const state = store.getState();
    const cfg = state.config || {};
    const ratio = Math.max(0.1, (Number(cfg.widthCm) || 120) / Math.max(1, Number(cfg.heightCm) || 90));

    let cx = 0;
    let cy = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of arState.corners) {
      cx += x;
      cy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    cx /= 4;
    cy /= 4;

    const curW = Math.max(40, maxX - minX);
    const curH = Math.max(40, maxY - minY);
    const { w: stageW, h: stageH } = getStageDimensions(dom.sceneBox);

    let targetW = curW;
    let targetH = targetW / ratio;
    if (targetH > stageH * 0.86) {
      targetH = stageH * 0.86;
      targetW = targetH * ratio;
    }
    if (targetW > stageW * 0.88) {
      targetW = stageW * 0.88;
      targetH = targetW / ratio;
    }

    const x0 = clamp(cx - targetW * 0.5, 8, Math.max(8, stageW - targetW - 8));
    const y0 = clamp(cy - targetH * 0.5, 8, Math.max(8, stageH - targetH - 8));
    arState.corners = [
      [x0, y0],
      [x0 + targetW, y0],
      [x0 + targetW, y0 + targetH],
      [x0, y0 + targetH],
    ];
    arState.lockAspect = true;
    if (dom.chkLockAspect) dom.chkLockAspect.checked = true;
    scheduleTransformRender();
  }

  function applyReferenceScaleZoom(refWallCm) {
    if (!Number.isFinite(refWallCm) || refWallCm <= 0) return;
    const state = store.getState();
    const cfg = state.config || {};
    const muralW = Number(cfg.widthCm) || 120;
    const muralH = Number(cfg.heightCm) || 90;
    const { w: stageW, h: stageH } = getStageDimensions(dom.sceneBox);

    // Si el usuario indica cuánto mide el ancho visible real de la pared/piso,
    // ajustamos el tamaño aparente en proporción real al ancho del escenario
    const frac = clamp(muralW / refWallCm, 0.08, 0.94);
    let targetW = stageW * frac;
    let targetH = targetW * (muralH / muralW);
    if (targetH > stageH * 0.88) {
      targetH = stageH * 0.88;
      targetW = targetH * (muralW / muralH);
    }

    let cx = stageW * 0.5;
    let cy = stageH * 0.5;
    if (Array.isArray(arState.corners) && arState.corners.length === 4) {
      cx = arState.corners.reduce((s, p) => s + p[0], 0) / 4;
      cy = arState.corners.reduce((s, p) => s + p[1], 0) / 4;
    }

    const x0 = clamp(cx - targetW * 0.5, 8, Math.max(8, stageW - targetW - 8));
    const y0 = clamp(cy - targetH * 0.5, 8, Math.max(8, stageH - targetH - 8));
    arState.corners = [
      [x0, y0],
      [x0 + targetW, y0],
      [x0 + targetW, y0 + targetH],
      [x0, y0 + targetH],
    ];
    scheduleTransformRender();
  }

  function renderTransformNow() {
    if (!arState.isOpen || !dom.warpedLayer || !Array.isArray(arState.corners)) return;

    const corners = arState.corners;
    const quadValidation = validateQuadNonCollinear(corners, 25);

    if (dom.quadPoly) {
      dom.quadPoly.setAttribute(
        'points',
        corners.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
      );
      dom.quadPoly.classList.toggle('is-invalid', !quadValidation.valid);
    }
    if (dom.diag1) {
      dom.diag1.setAttribute('x1', corners[0][0].toFixed(1));
      dom.diag1.setAttribute('y1', corners[0][1].toFixed(1));
      dom.diag1.setAttribute('x2', corners[2][0].toFixed(1));
      dom.diag1.setAttribute('y2', corners[2][1].toFixed(1));
    }
    if (dom.diag2) {
      dom.diag2.setAttribute('x1', corners[1][0].toFixed(1));
      dom.diag2.setAttribute('y1', corners[1][1].toFixed(1));
      dom.diag2.setAttribute('x2', corners[3][0].toFixed(1));
      dom.diag2.setAttribute('y2', corners[3][1].toFixed(1));
    }

    dom.pins.forEach((pin, idx) => {
      const pt = corners[idx];
      if (!pt) return;
      pin.style.left = `${pt[0].toFixed(2)}px`;
      pin.style.top = `${pt[1].toFixed(2)}px`;
    });

    if (quadValidation.valid) {
      try {
        const { matrix3d, H, maxErrorPx } = computeCssMatrix3d(arState.artW, arState.artH, corners);
        arState.lastH = H;
        arState.lastInvH = invertHomography3x3(H);
        arState.lastMaxErrorPx = maxErrorPx;
        dom.warpedLayer.style.transform = matrix3d;
        dom.warpedLayer.style.visibility = 'visible';
      } catch {
        dom.warpedLayer.style.visibility = 'hidden';
      }
    }

    const state = store.getState();
    const metrics = computeRealWorldQuadMetrics(
      corners,
      state.config,
      state.printMetrics,
      state.config?.mosaicMode ? state.totalTiles : 0,
      arState.referenceWallWidthCm
    );

    if (dom.dimTop) {
      dom.dimTop.textContent = `↔ ${metrics.widthLabel}`;
      dom.dimTop.style.left = `${metrics.edgeMidpoints.top[0].toFixed(1)}px`;
      dom.dimTop.style.top = `${Math.max(18, metrics.edgeMidpoints.top[1] - 18).toFixed(1)}px`;
    }
    if (dom.dimLeft) {
      dom.dimLeft.textContent = `↕ ${metrics.heightLabel}`;
      dom.dimLeft.style.left = `${Math.max(46, metrics.edgeMidpoints.left[0] - 8).toFixed(1)}px`;
      dom.dimLeft.style.top = `${metrics.edgeMidpoints.left[1].toFixed(1)}px`;
    }
    if (dom.metricsHud) {
      const parts = [
        `${metrics.widthLabel} × ${metrics.heightLabel}`,
        `${metrics.areaM2} m²`,
        metrics.sheetsLabel,
        metrics.tilesLabel,
      ];
      if (metrics.referenceScaleInfo) {
        parts.push(metrics.referenceScaleInfo.label);
      }
      dom.metricsHud.textContent = parts.join(' · ');
    }
  }

  function scheduleTransformRender() {
    if (pendingTransformSync) return;
    pendingTransformSync = true;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    transformRafId = raf(() => {
      pendingTransformSync = false;
      renderTransformNow();
    });
  }

  async function updateCameraDeviceList() {
    if (!dom.selectCameraDevice) return;
    const mediaDevices =
      win?.navigator?.mediaDevices ||
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') return;
    try {
      const devices = await mediaDevices.enumerateDevices();
      const videoDevices = (devices || []).filter((d) => d.kind === 'videoinput');
      if (videoDevices.length > 1) {
        dom.selectCameraDevice.innerHTML = videoDevices
          .map(
            (d, idx) =>
              `<option value="${d.deviceId}">${d.label || `Cámara ${idx + 1}`}</option>`
          )
          .join('');
        if (arState.selectedDeviceId) {
          dom.selectCameraDevice.value = arState.selectedDeviceId;
        }
        dom.selectCameraDevice.classList.remove('hidden');
      } else {
        dom.selectCameraDevice.classList.add('hidden');
      }
    } catch {
      // noop
    }
  }

  async function startCamera(opts = {}) {
    hideCameraNotice();

    const isSecureCtx = win ? win.isSecureContext !== false : true;
    const mediaDevices = win?.navigator?.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);

    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      const msg = !isSecureCtx
        ? 'El navegador bloqueó la cámara porque estás en HTTP LAN no seguro. Usa HTTPS/localhost o sube una foto local de tu pared/piso.'
        : 'Cámara no disponible en este navegador/dispositivo. Usa "Subir foto pared/piso" o las escenas integradas.';
      showCameraNotice(msg);
      showToast('Cámara no disponible · usando escena de simulación', 'warn');
      return false;
    }

    stopCameraStream();
    try {
      const targetDeviceId = opts?.deviceId || arState.selectedDeviceId;
      const videoConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };
      if (targetDeviceId) {
        videoConstraints.deviceId = { exact: targetDeviceId };
      } else {
        videoConstraints.facingMode = { ideal: arState.facingMode };
      }

      const stream = await mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });

      if (!arState.isOpen) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }

      mediaStream = stream;
      arState.sourceMode = 'camera';
      revokePhotoUrl();
      if (dom.photoImg) dom.photoImg.classList.add('hidden');
      if (dom.liveIndicator) dom.liveIndicator.classList.remove('hidden');
      if (dom.video) {
        dom.video.srcObject = stream;
        dom.video.classList.remove('hidden');
        if (typeof dom.video.play === 'function') {
          await dom.video.play().catch(() => {});
        }
      }
      if (dom.btnSceneWall) dom.btnSceneWall.classList.remove('is-active');
      if (dom.btnSceneFloor) dom.btnSceneFloor.classList.remove('is-active');
      if (dom.btnStartCamera) dom.btnStartCamera.classList.add('is-active');
      if (dom.statusText) {
        dom.statusText.textContent =
          arState.facingMode === 'environment'
            ? '🟢 Cámara en vivo activa (Pared/Piso)'
            : '🟢 Cámara frontal activa';
      }
      await updateCameraDeviceList();
      showToast('Cámara AR en vivo conectada', 'success');
      return true;
    } catch (err) {
      if (dom.liveIndicator) dom.liveIndicator.classList.add('hidden');
      if (dom.btnStartCamera) dom.btnStartCamera.classList.remove('is-active');
      const reason =
        err?.name === 'NotAllowedError'
          ? 'Permiso de cámara denegado. Puedes cargar una foto de tu pared/piso o usar la escena integrada.'
          : !isSecureCtx
          ? 'La cámara requiere contexto seguro (HTTPS o localhost). Sube una foto de tu pared para calibrar en HTTP LAN.'
          : 'No se detectó cámara activa. Usa "Subir foto pared/piso" o las escenas offline.';
      showCameraNotice(reason);
      showToast('No se pudo abrir la cámara; modo simulación activo', 'warn');
      return false;
    }
  }

  function handleLocalPhotoUpload(file) {
    if (!file) return;
    const valid = ['image/jpeg', 'image/png', 'image/webp'];
    if (file.type && !valid.includes(file.type)) {
      showToast('Formato de foto no soportado. Usa JPG, PNG o WebP.', 'error');
      return;
    }

    stopCameraStream();
    hideCameraNotice();
    revokePhotoUrl();

    const url = URL.createObjectURL(file);
    arState.photoObjectUrl = url;
    arState.sourceMode = 'photo';

    if (dom.photoImg) {
      dom.photoImg.onload = () => {
        if (dom.statusText) dom.statusText.textContent = `Foto local: ${file.name}`;
      };
      dom.photoImg.src = url;
      dom.photoImg.classList.remove('hidden');
    }
    if (dom.btnSceneWall) dom.btnSceneWall.classList.remove('is-active');
    if (dom.btnSceneFloor) dom.btnSceneFloor.classList.remove('is-active');
    showToast(`Foto cargada en AR: ${file.name}`, 'success');
  }

  function updateCornerWithAspectLock(corners, cornerIdx, rawX, rawY, w, h) {
    const oppIdx = (cornerIdx + 2) % 4;
    const opp = corners[oppIdx];
    const cfg = store.getState().config || {};
    const ratio = Math.max(0.1, (Number(cfg.widthCm) || 120) / Math.max(1, Number(cfg.heightCm) || 90));

    const minSize = 36;
    const signX = cornerIdx === 1 || cornerIdx === 2 ? 1 : -1;
    const signY = cornerIdx === 2 || cornerIdx === 3 ? 1 : -1;

    let dx = (rawX - opp[0]) * signX;
    let dy = (rawY - opp[1]) * signY;
    dx = Math.max(minSize, dx);
    dy = Math.max(minSize / ratio, dy);

    // Ajustar conservando relación W:H
    let newW = dx;
    let newH = newW / ratio;
    if (dy * ratio > newW) {
      newH = dy;
      newW = newH * ratio;
    }

    const maxAvailX = signX > 0 ? w - 6 - opp[0] : opp[0] - 6;
    const maxAvailY = signY > 0 ? h - 6 - opp[1] : opp[1] - 6;
    if (newW > maxAvailX) {
      newW = Math.max(minSize, maxAvailX);
      newH = newW / ratio;
    }
    if (newH > maxAvailY) {
      newH = Math.max(minSize, maxAvailY);
      newW = newH * ratio;
    }

    const xLeft = signX > 0 ? opp[0] : opp[0] - newW;
    const yTop = signY > 0 ? opp[1] : opp[1] - newH;
    return [
      [xLeft, yTop],
      [xLeft + newW, yTop],
      [xLeft + newW, yTop + newH],
      [xLeft, yTop + newH],
    ];
  }

  function captureProposalPng() {
    if (!doc || !dom.sceneBox || !dom.artworkCanvas || !Array.isArray(arState.corners)) return;
    const { w: stageW, h: stageH } = getStageDimensions(dom.sceneBox);
    const outW = Math.round(stageW);
    const outH = Math.round(stageH);

    const outCanvas = doc.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const ctx = outCanvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#ece7dc';
    ctx.fillRect(0, 0, outW, outH);

    const drawBackgroundCover = (media, mediaW, mediaH) => {
      if (!media || mediaW <= 0 || mediaH <= 0) return;
      const scale = Math.max(outW / mediaW, outH / mediaH);
      const dw = mediaW * scale;
      const dh = mediaH * scale;
      const dx = (outW - dw) * 0.5;
      const dy = (outH - dh) * 0.5;
      ctx.drawImage(media, dx, dy, dw, dh);
    };

    if (arState.sourceMode === 'camera' && dom.video && dom.video.readyState >= 2) {
      drawBackgroundCover(dom.video, dom.video.videoWidth || outW, dom.video.videoHeight || outH);
    } else if (dom.photoImg && dom.photoImg.complete) {
      drawBackgroundCover(
        dom.photoImg,
        dom.photoImg.naturalWidth || outW,
        dom.photoImg.naturalHeight || outH
      );
    }

    try {
      renderProjectiveQuadOnCanvas(ctx, dom.artworkCanvas, arState.corners, arState.opacity, 16);
    } catch {
      // fallback si quad inválido
    }

    const pts = arState.corners;
    ctx.strokeStyle = '#36594d';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    const state = store.getState();
    const metrics = computeRealWorldQuadMetrics(
      pts,
      state.config,
      state.printMetrics,
      state.config?.mosaicMode ? state.totalTiles : 0,
      arState.referenceWallWidthCm
    );

    const drawPill = (text, x, y, bg) => {
      ctx.font = '600 12px "DM Mono", monospace';
      const tw = ctx.measureText(text).width;
      const pw = tw + 16;
      const ph = 22;
      ctx.fillStyle = bg;
      ctx.fillRect(x - pw * 0.5, y - ph * 0.5, pw, ph);
      ctx.fillStyle = '#fffdf8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
    };

    drawPill(
      `↔ ${metrics.widthLabel}`,
      metrics.edgeMidpoints.top[0],
      Math.max(16, metrics.edgeMidpoints.top[1] - 18),
      'rgba(36, 51, 45, 0.92)'
    );
    drawPill(
      `↕ ${metrics.heightLabel}`,
      Math.max(48, metrics.edgeMidpoints.left[0] - 8),
      metrics.edgeMidpoints.left[1],
      'rgba(156, 91, 56, 0.94)'
    );

    const footerText = `${metrics.widthLabel} × ${metrics.heightLabel} · ${metrics.areaM2} m² · ${metrics.sheetsLabel} · ${metrics.tilesLabel}`;
    ctx.fillStyle = 'rgba(255, 253, 248, 0.92)';
    ctx.fillRect(12, outH - 36, Math.min(outW - 24, ctx.measureText(footerText).width + 26), 24);
    ctx.fillStyle = '#24332d';
    ctx.font = '600 11px "DM Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(footerText, 22, outH - 24);

    try {
      const pngUrl = outCanvas.toDataURL('image/png');
      const a = doc.createElement('a');
      a.href = pngUrl;
      a.download = `GuiaMosaico_AR_${state.config.widthCm}x${state.config.heightCm}cm.png`;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      showToast('Propuesta AR exportada como PNG', 'success');
    } catch {
      showToast('No se pudo generar la captura PNG en este navegador.', 'error');
    }
  }

  function bindOverlayEvents() {
    if (!overlayEl) return;

    dom.btnClose?.addEventListener('click', close);
    dom.btnNoticeDismiss?.addEventListener('click', hideCameraNotice);
    dom.btnStartCamera?.addEventListener('click', () => startCamera());

    dom.btnFlipCamera?.addEventListener('click', () => {
      arState.facingMode = arState.facingMode === 'environment' ? 'user' : 'environment';
      if (arState.sourceMode === 'camera') {
        startCamera();
      } else {
        showToast(
          arState.facingMode === 'environment'
            ? 'Cámara seleccionada: Trasera (environment)'
            : 'Cámara seleccionada: Frontal (user)',
          'info'
        );
      }
    });

    dom.selectCameraDevice?.addEventListener('change', () => {
      arState.selectedDeviceId = dom.selectCameraDevice.value;
      startCamera({ deviceId: arState.selectedDeviceId });
    });

    dom.btnSnapPhoto?.addEventListener('click', () => triggerMobilePhotoCapture());
    dom.photoCaptureInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleLocalPhotoUpload(file);
      e.target.value = '';
    });

    dom.btnUploadPhoto?.addEventListener('click', () => dom.photoInput?.click());
    dom.photoInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleLocalPhotoUpload(file);
      e.target.value = '';
    });

    dom.btnSceneWall?.addEventListener('click', () => loadBuiltInScene('wall'));
    dom.btnSceneFloor?.addEventListener('click', () => loadBuiltInScene('floor'));
    dom.btnPresetWall?.addEventListener('click', () => {
      arState.lockAspect = true;
      if (dom.chkLockAspect) dom.chkLockAspect.checked = true;
      applyPreset('wall');
    });
    dom.btnPresetFloor?.addEventListener('click', () => applyPreset('floor'));
    dom.btnFitAspect?.addEventListener('click', fitCornersToAspect);

    dom.chkLockAspect?.addEventListener('change', () => {
      arState.lockAspect = Boolean(dom.chkLockAspect.checked);
      if (arState.lockAspect) {
        fitCornersToAspect();
      }
    });

    dom.rangeOpacity?.addEventListener('input', () => {
      const pct = Number(dom.rangeOpacity.value) || 78;
      arState.opacity = clamp(pct / 100, 0.1, 1);
      if (dom.valOpacity) dom.valOpacity.textContent = `${pct}%`;
      applyOpacityVisual();
    });

    dom.chkStrobe?.addEventListener('change', () => {
      arState.strobeEnabled = Boolean(dom.chkStrobe.checked);
      syncStrobeTimer();
    });

    dom.rangeStrobeHz?.addEventListener('input', () => {
      const hz = Number.parseFloat(dom.rangeStrobeHz.value) || 2.5;
      arState.strobeHz = clamp(hz, 0.5, 10);
      if (dom.valStrobeHz) dom.valStrobeHz.textContent = `${arState.strobeHz.toFixed(1)} Hz`;
      if (arState.strobeEnabled) syncStrobeTimer();
    });

    dom.chkContour?.addEventListener('change', () => {
      arState.contourOnly = Boolean(dom.chkContour.checked);
      syncArtworkCanvas();
    });

    dom.inputRefWallCm?.addEventListener('change', () => {
      const raw = Number.parseFloat(dom.inputRefWallCm.value);
      arState.referenceWallWidthCm = Number.isFinite(raw) && raw >= 20 ? raw : null;
      if (arState.referenceWallWidthCm) {
        applyReferenceScaleZoom(arState.referenceWallWidthCm);
      } else {
        scheduleTransformRender();
      }
    });

    const onMuralDimensionChange = () => {
      const rawW = Number.parseFloat(dom.inputMuralW?.value);
      const rawH = Number.parseFloat(dom.inputMuralH?.value);
      if (!Number.isFinite(rawW) || rawW < 5 || !Number.isFinite(rawH) || rawH < 5) return;

      const oldCfg = store.getState().config || {};
      const oldRatio = (Number(oldCfg.widthCm) || 120) / Math.max(1, Number(oldCfg.heightCm) || 90);
      let newW = Math.round(rawW * 10) / 10;
      let newH = Math.round(rawH * 10) / 10;

      if (arState.lockAspect) {
        if (doc?.activeElement === dom.inputMuralW) {
          newH = Math.round((newW / oldRatio) * 10) / 10;
          if (dom.inputMuralH) dom.inputMuralH.value = String(newH);
        } else if (doc?.activeElement === dom.inputMuralH) {
          newW = Math.round((newH * oldRatio) * 10) / 10;
          if (dom.inputMuralW) dom.inputMuralW.value = String(newW);
        }
      }

      store.updateConfig({ widthCm: newW, heightCm: newH });
      syncArtworkCanvas();
      fitCornersToAspect();
      renderTransformNow();
      showToast(`Medidas actualizadas: ${newW} × ${newH} cm`, 'info');
    };

    dom.inputMuralW?.addEventListener('change', onMuralDimensionChange);
    dom.inputMuralH?.addEventListener('change', onMuralDimensionChange);

    dom.btnCapturePng?.addEventListener('click', captureProposalPng);

    // Drag de esquinas
    dom.pins.forEach((pin) => {
      pin.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pin.setPointerCapture) pin.setPointerCapture(e.pointerId);
        const cornerIdx = Number.parseInt(pin.dataset.corner || '0', 10);
        pin.classList.add('is-dragging');
        activeDrag = {
          type: 'corner',
          index: cornerIdx,
          pin,
          startCorners: (arState.corners || []).map((p) => [...p]),
        };
      });
    });

    // Drag del cuerpo entero para reposicionar obra
    dom.warpedLayer?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (dom.warpedLayer.setPointerCapture) dom.warpedLayer.setPointerCapture(e.pointerId);
      activeDrag = {
        type: 'move',
        startX: e.clientX,
        startY: e.clientY,
        startCorners: (arState.corners || []).map((p) => [...p]),
      };
    });

    const onPointerMove = (e) => {
      if (!activeDrag || !dom.sceneBox) return;
      const rect = dom.sceneBox.getBoundingClientRect();
      const stageW = Math.max(120, rect.width || dom.sceneBox.clientWidth || 800);
      const stageH = Math.max(120, rect.height || dom.sceneBox.clientHeight || 540);

      if (activeDrag.type === 'corner') {
        const px = clamp(e.clientX - rect.left, 4, stageW - 4);
        const py = clamp(e.clientY - rect.top, 4, stageH - 4);
        let candidate;
        if (arState.lockAspect) {
          candidate = updateCornerWithAspectLock(
            activeDrag.startCorners,
            activeDrag.index,
            px,
            py,
            stageW,
            stageH
          );
        } else {
          candidate = activeDrag.startCorners.map((p) => [...p]);
          candidate[activeDrag.index] = [px, py];
        }

        const check = validateQuadNonCollinear(candidate, 25);
        if (check.valid) {
          arState.corners = candidate;
          scheduleTransformRender();
        }
      } else if (activeDrag.type === 'move') {
        const dx = e.clientX - activeDrag.startX;
        const dy = e.clientY - activeDrag.startY;
        const xs = activeDrag.startCorners.map((p) => p[0]);
        const ys = activeDrag.startCorners.map((p) => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const clampedDx = clamp(dx, 4 - minX, stageW - 4 - maxX);
        const clampedDy = clamp(dy, 4 - minY, stageH - 4 - maxY);
        arState.corners = activeDrag.startCorners.map((p) => [p[0] + clampedDx, p[1] + clampedDy]);
        scheduleTransformRender();
      }
    };

    const onPointerUp = () => {
      if (!activeDrag) return;
      if (activeDrag.pin) activeDrag.pin.classList.remove('is-dragging');
      activeDrag = null;
    };

    dom.sceneBox?.addEventListener('pointermove', onPointerMove);
    dom.sceneBox?.addEventListener('pointerup', onPointerUp);
    dom.sceneBox?.addEventListener('pointercancel', onPointerUp);

    if (!boundResizeListener && win) {
      boundResizeListener = true;
      win.addEventListener('resize', () => {
        if (arState.isOpen) {
          scheduleTransformRender();
        }
      });
    }
  }

  function triggerMobilePhotoCapture() {
    if (dom.photoCaptureInput) {
      dom.photoCaptureInput.click();
    } else if (dom.photoInput) {
      dom.photoInput.click();
    }
  }

  function open({ autoStartCamera = false } = {}) {
    const el = ensureOverlayMarkup();
    if (!el) return;
    arState.isOpen = true;
    el.classList.remove('hidden');
    syncArtworkCanvas();
    applyOpacityVisual();

    const state = store.getState();
    const cfg = state.config || {};
    if (dom.inputMuralW) dom.inputMuralW.value = String(cfg.widthCm || 120);
    if (dom.inputMuralH) dom.inputMuralH.value = String(cfg.heightCm || 90);

    // Renderizar preset y matriz de forma síncrona inmediata para garantizar valores iniciales
    if (!arState.corners) {
      applyPreset(arState.sceneType || 'wall');
    } else {
      renderTransformNow();
    }

    if (autoStartCamera) {
      Promise.resolve()
        .then(() => startCamera())
        .then((started) => {
          if (!started && arState.sourceMode === 'scene' && !dom.photoImg?.getAttribute('src')) {
            loadBuiltInScene(arState.sceneType || 'wall');
          }
        })
        .catch(() => {
          if (arState.sourceMode === 'scene' && !dom.photoImg?.getAttribute('src')) {
            loadBuiltInScene(arState.sceneType || 'wall');
          }
        });
    } else if (arState.sourceMode === 'scene' && !dom.photoImg?.getAttribute('src')) {
      loadBuiltInScene(arState.sceneType || 'wall');
    }
  }

  function close() {
    arState.isOpen = false;
    stopCameraStream();
    stopStrobeTimer();
    if (transformRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(transformRafId);
      transformRafId = null;
      pendingTransformSync = false;
    }
    if (overlayEl) {
      overlayEl.classList.add('hidden');
    }
  }

  function destroy() {
    close();
    revokePhotoUrl();
  }

  function refreshArtwork() {
    if (!arState.isOpen) return;
    syncArtworkCanvas();
    scheduleTransformRender();
  }

  return {
    open,
    close,
    destroy,
    refreshArtwork,
    startCamera,
    stopCameraStream,
    loadBuiltInScene,
    applyPreset,
    fitCornersToAspect,
    captureProposalPng,
    triggerMobilePhotoCapture,
    getState: () => arState,
  };
}
