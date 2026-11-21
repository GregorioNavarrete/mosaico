import {
  MAX_PDF_PAGES_PHASE1,
  MAX_PDF_PAGES_POSTER,
  PAPER_FORMATS,
  PATTERN_LABELS,
  PDF_SPLIT_MODES,
  POSTER_FILTER_MODES,
} from '/shared/contracts.js';
import { getRowLabel, parseSheetRangeExpression } from '/shared/printGrid.js';
import { getLuminance } from '/shared/mosaicCore.js';
import {
  loadSampleSvgImage,
  extractSourceRgba,
  renderArtworkSnapshotToCanvas,
} from '/public/js/render/canvasRenderer.js';
import { computeMosaicJob } from '/public/js/workers/mosaicWorker.js';
import { createCameraArController } from '/public/js/controllers/cameraArController.js';

const NUMBER_FORMATTER = new Intl.NumberFormat('es-AR');

function formatNumber(n) {
  return NUMBER_FORMATTER.format(Math.round(n || 0));
}

function normalizePatternId(pattern) {
  if (pattern === 'brick') return 'brick_50';
  return pattern || 'grid';
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

const PATTERN_BTN_SPECS = [
  ['btn-pattern-grid', 'grid'],
  ['btn-pattern-brick', 'brick_50'],
  ['btn-pattern-brick-33', 'brick_33'],
  ['btn-pattern-diamond-45', 'diamond_45'],
  ['btn-pattern-hexagonal', 'hexagonal'],
  ['btn-pattern-herringbone', 'herringbone'],
  ['btn-pattern-basketweave', 'basketweave'],
  ['btn-pattern-fish-scale', 'fish_scale'],
  ['btn-pattern-penny-round', 'penny_round'],
];

const GENMODE_BTN_SPECS = [
  ['btn-genmode-image', 'image'],
  ['btn-genmode-mixture', 'mixture'],
  ['btn-genmode-gradient', 'gradient'],
];

export function createEditorController(
  store,
  renderer,
  doc = document,
  win = typeof window !== 'undefined' ? window : null
) {
  const dom = {
    // Proyecto
    projectSelect: doc.getElementById('project-select'),
    projectNameInput: doc.getElementById('project-name-input'),
    btnProjectNew: doc.getElementById('btn-project-new'),
    btnProjectSave: doc.getElementById('btn-project-save'),
    btnProjectDuplicate: doc.getElementById('btn-project-duplicate'),
    btnProjectDelete: doc.getElementById('btn-project-delete'),

    // HUD
    hudDims: doc.getElementById('hud-dims'),
    hudPagesLabel: doc.getElementById('hud-pages-label'),
    hudPages: doc.getElementById('hud-pages'),
    hudTiles: doc.getElementById('hud-tiles'),
    hudMirror: doc.getElementById('hud-mirror-badge'),
    btnOpenAr: doc.getElementById('btn-open-ar'),
    btnExportPdf: doc.getElementById('btn-export-pdf'),

    // Tabs
    tabBtns: doc.querySelectorAll('.tab-btn'),
    tabBtnF3: doc.getElementById('tab-btn-f3'),
    panelF1: doc.getElementById('panel-f1'),
    panelF2: doc.getElementById('panel-f2'),
    panelF3: doc.getElementById('panel-f3'),
    btnArLaunchLive: doc.getElementById('btn-ar-launch-live'),
    btnArLaunchPhoto: doc.getElementById('btn-ar-launch-photo'),
    btnArLaunchWall: doc.getElementById('btn-ar-launch-wall'),
    btnArLaunchFloor: doc.getElementById('btn-ar-launch-floor'),
    arTabPreviewDims: doc.getElementById('ar-tab-preview-dims'),
    btnCanvasQuickAr: doc.getElementById('btn-canvas-quick-ar'),

    // Fase 1
    dropzone: doc.getElementById('dropzone'),
    fileInput: doc.getElementById('file-input'),
    fileNameDisplay: doc.getElementById('file-name-display'),
    btnLoadSample: doc.getElementById('btn-load-sample'),
    inputWidth: doc.getElementById('input-width-cm'),
    inputHeight: doc.getElementById('input-height-cm'),
    chkKeepRatio: doc.getElementById('chk-keep-ratio'),
    selectPaperFormat: doc.getElementById('select-paper-format'),
    customPaperFields: doc.getElementById('custom-paper-fields'),
    inputCustomPaperW: doc.getElementById('input-custom-paper-w'),
    inputCustomPaperH: doc.getElementById('input-custom-paper-h'),
    btnOrientPortrait: doc.getElementById('btn-orient-portrait'),
    btnOrientLandscape: doc.getElementById('btn-orient-landscape'),
    orientPortraitDims: doc.getElementById('orient-portrait-dims'),
    orientLandscapeDims: doc.getElementById('orient-landscape-dims'),
    inputMargin: doc.getElementById('input-margin-cm'),
    inputOverlap: doc.getElementById('input-overlap-cm'),
    calcGridTitle: doc.getElementById('calc-grid-title'),
    calcPagesTotal: doc.getElementById('calc-pages-total'),
    calcUsable: doc.getElementById('calc-usable'),
    calcGridNxNy: doc.getElementById('calc-grid-nxny'),
    calcGridError: doc.getElementById('calc-grid-error'),
    chkMirror: doc.getElementById('chk-mirror'),
    chkShowA4F1: doc.getElementById('chk-show-a4-grid'),

    // Fase 2: Selector de Modo (Mosaico vs Póster), Geometría y 9 Patrones
    chkMosaicMode: doc.getElementById('chk-mosaic-mode'),
    btnWorkmodeMosaic: doc.getElementById('btn-workmode-mosaic'),
    btnWorkmodePoster: doc.getElementById('btn-workmode-poster'),
    f2Wrapper: doc.getElementById('f2-controls-wrapper'),
    mosaicOnlyControls: doc.getElementById('mosaic-only-controls'),
    posterOnlyControls: doc.getElementById('poster-only-controls'),

    // Controles Modo Póster / Referencia (2.1)
    posterModeBtns: doc.querySelectorAll('.poster-mode-btn'),
    btnPosterColor: doc.getElementById('btn-poster-color'),
    btnPosterGrayscale: doc.getElementById('btn-poster-grayscale'),
    btnPosterContrast: doc.getElementById('btn-poster-contrast'),
    btnPosterLineart: doc.getElementById('btn-poster-lineart'),
    rangePosterContrast: doc.getElementById('range-poster-contrast'),
    valPosterContrast: doc.getElementById('val-poster-contrast'),
    rangePosterBrightness: doc.getElementById('range-poster-brightness'),
    valPosterBrightness: doc.getElementById('val-poster-brightness'),
    rangePosterThreshold: doc.getElementById('range-poster-threshold'),
    valPosterThreshold: doc.getElementById('val-poster-threshold'),
    chkPosterInvert: doc.getElementById('chk-poster-invert'),
    chkShowA4Poster: doc.getElementById('chk-show-a4-grid-poster'),

    rangeTileSize: doc.getElementById('range-tile-size'),
    valTileSize: doc.getElementById('val-tile-size'),
    btnPatternGrid: doc.getElementById('btn-pattern-grid'),
    btnPatternBrick: doc.getElementById('btn-pattern-brick'),
    patternEntries: PATTERN_BTN_SPECS.map(([id, pattern]) => ({
      id,
      pattern,
      el: doc.getElementById(id),
    })),

    // Fase 2: Modo de generación (Imagen / Mezcla / Degradado)
    genmodeEntries: GENMODE_BTN_SPECS.map(([id, mode]) => ({
      id,
      mode,
      el: doc.getElementById(id),
    })),
    genmodeMixturePanel: doc.getElementById('genmode-mixture-panel'),
    mixColor1: doc.getElementById('mix-color-1'),
    mixPct1: doc.getElementById('mix-pct-1'),
    mixColor2: doc.getElementById('mix-color-2'),
    mixPct2: doc.getElementById('mix-pct-2'),
    mixColor3: doc.getElementById('mix-color-3'),
    mixPct3: doc.getElementById('mix-pct-3'),
    mixPctTotal: doc.getElementById('mix-pct-total'),
    btnApplyMixture: doc.getElementById('btn-apply-mixture'),

    genmodeGradientPanel: doc.getElementById('genmode-gradient-panel'),
    chkGradStop3: doc.getElementById('chk-grad-stop-3'),
    gradStop3Row: doc.getElementById('grad-stop-3-row'),
    gradColor1: doc.getElementById('grad-color-1'),
    gradPos1: doc.getElementById('grad-pos-1'),
    gradColor2: doc.getElementById('grad-color-2'),
    gradPos2: doc.getElementById('grad-pos-2'),
    gradColor3: doc.getElementById('grad-color-3'),
    gradPos3: doc.getElementById('grad-pos-3'),
    rangeGradAngle: doc.getElementById('range-grad-angle'),
    valGradAngle: doc.getElementById('val-grad-angle'),
    btnApplyGradient: doc.getElementById('btn-apply-gradient'),

    // Fase 2: Preprocesado, Colorimetría y Dithering
    imagePreprocessSection: doc.getElementById('image-preprocess-section'),
    selectPreprocessMode: doc.getElementById('select-preprocess-mode'),
    chkRemoveBg: doc.getElementById('chk-remove-bg'),
    imageColorSection: doc.getElementById('image-color-section'),
    rangeColors: doc.getElementById('range-colors'),
    valColorsCount: doc.getElementById('val-colors-count'),
    selectColorSpace: doc.getElementById('select-color-space'),
    selectDitherMode: doc.getElementById('select-dither-mode'),
    rangeDitherStrength: doc.getElementById('range-dither-strength'),
    valDitherStrength: doc.getElementById('val-dither-strength'),

    // Junta / Pastina
    groutPresets: doc.querySelectorAll('.grout-preset'),
    inputGroutColor: doc.getElementById('input-grout-color'),
    rangeGroutMm: doc.getElementById('range-grout-mm'),
    valGroutMm: doc.getElementById('val-grout-mm'),

    // Acabados, Visualización y Breakdown
    selectTileFinish: doc.getElementById('select-tile-finish'),
    vmodeBtns: doc.querySelectorAll('.vmode-btn'),
    btnVmodeBreakdown: doc.getElementById('btn-vmode-breakdown'),
    breakdownHint: doc.getElementById('breakdown-hint'),
    chkShowNumbers: doc.getElementById('chk-show-numbers'),
    chkShowA4F2: doc.getElementById('chk-show-a4-grid-f2'),
    btnRecalculateMosaic: doc.getElementById('btn-recalculate-mosaic'),

    // Toolbar & Canvas
    toolBtns: doc.querySelectorAll('.tool-btn[data-tool]'),
    btnUndo: doc.getElementById('btn-undo'),
    undoCount: doc.getElementById('undo-count'),
    btnRedo: doc.getElementById('btn-redo'),
    redoCount: doc.getElementById('redo-count'),
    activeColorPill: doc.getElementById('active-color-pill'),
    activeColorSwatch: doc.getElementById('active-color-swatch'),
    activeColorLabel: doc.getElementById('active-color-label'),
    btnZoomOut: doc.getElementById('btn-zoom-out'),
    btnZoomIn: doc.getElementById('btn-zoom-in'),
    btnZoomFit: doc.getElementById('btn-zoom-fit'),
    zoomLevel: doc.getElementById('zoom-level'),
    viewport: doc.getElementById('canvas-viewport'),
    canvas: doc.getElementById('studio-canvas'),
    workerStatusPill: doc.getElementById('worker-status-pill'),
    cursorInfo: doc.getElementById('cursor-info'),
    mirrorOverlayTag: doc.getElementById('mirror-overlay-tag'),

    // Paleta
    paletteContainer: doc.getElementById('palette-container'),
    paletteSummary: doc.getElementById('palette-summary'),
    paletteSubtitle: doc.getElementById('palette-subtitle'),

    // Modal PDF
    pdfModal: doc.getElementById('pdf-export-modal'),
    pdfSheetsGrid: doc.getElementById('pdf-sheets-grid'),
    pdfRangeInput: doc.getElementById('pdf-range-input'),
    selectPdfSplitMode: doc.getElementById('select-pdf-split-mode'),
    pdfBatchesField: doc.getElementById('pdf-batches-field'),
    inputPdfSheetsPerFile: doc.getElementById('input-pdf-sheets-per-file'),
    btnPdfSelectAll: doc.getElementById('btn-pdf-select-all'),
    btnPdfClearAll: doc.getElementById('btn-pdf-clear-all'),
    chkPdfIncludeCover: doc.getElementById('chk-pdf-include-cover'),
    chkPdfIncludePalette: doc.getElementById('chk-pdf-include-palette'),
    pdfExportSummary: doc.getElementById('pdf-export-summary'),
    pdfExportStatus: doc.getElementById('pdf-export-status'),
    pdfStatusText: doc.getElementById('pdf-status-text'),
    pdfPercentLabel: doc.getElementById('pdf-percent-label'),
    pdfProgressBar: doc.getElementById('pdf-progress-bar'),
    btnPdfCancelExport: doc.getElementById('btn-pdf-cancel-export'),
    btnPdfConfirmExport: doc.getElementById('btn-pdf-confirm-export'),

    // Modal Protección Ediciones
    protectModal: doc.getElementById('protect-edits-modal'),
    protectMessage: doc.getElementById('protect-edits-message'),
    btnProtectConfirm: doc.getElementById('btn-protect-confirm'),
    btnProtectCancel: doc.getElementById('btn-protect-cancel'),

    // Modal Eliminar Proyecto
    deleteModal: doc.getElementById('delete-project-modal'),
    deleteMessage: doc.getElementById('delete-project-message'),
    btnDeleteConfirm: doc.getElementById('btn-delete-confirm'),
    btnDeleteCancel: doc.getElementById('btn-delete-cancel'),

    toastContainer: doc.getElementById('toast-container'),
  };

  let isDraggingPan = false;
  let isPainting = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  let pendingProtectedAction = null;
  let selectedSheetsSet = new Set();
  let isExportingPdf = false;
  let paletteCountNodes = [];

  // Estado del Web Worker y cancelación de trabajos obsoletos
  let mosaicWorker = null;
  let workerUnavailable = false;
  let workerBusy = false;
  let latestJobId = 0;
  let activeJobContext = null;
  let lastMosaicGeoKey = '';

  const arController = createCameraArController({
    store,
    drawArtworkToCanvas: (cv, opts) => renderArtworkSnapshotToCanvas(cv, store.getState(), opts),
    showToast,
    doc,
    win,
  });

  function buildGeometryKey(cfg) {
    return `${cfg.widthCm}|${cfg.heightCm}|${cfg.tileSizeCm}|${normalizePatternId(cfg.pattern)}`;
  }

  function setWorkerBusyUI(busy) {
    workerBusy = busy;
    if (dom.workerStatusPill) {
      dom.workerStatusPill.classList.toggle('hidden', !busy);
    }
  }

  function applyComputedJobResult(result, fitAfter = false) {
    store.setMosaicData({
      palette: result.palette,
      grid: result.gridBuffer,
      tileCols: result.tileCols,
      tileRows: result.tileRows,
      maxRowCols: result.maxRowCols,
      totalTiles: result.totalTiles,
      gridMetrics: result.gridMetrics,
      cells: result.cells,
    });
    lastMosaicGeoKey = buildGeometryKey(store.getState().config);
    renderer.invalidateCache();
    if (fitAfter) {
      renderer.fitToView();
    } else {
      renderer.scheduleRender();
    }
    syncAllUI();
    arController.refreshArtwork();
  }

  function runSyncFallbackJob(payload, fitAfter) {
    const result = computeMosaicJob(payload);
    applyComputedJobResult(result, fitAfter);
    return result;
  }

  function spawnWorker() {
    if (workerUnavailable) return null;
    const WorkerCtor = win?.Worker || (typeof Worker === 'function' ? Worker : null);
    if (!WorkerCtor) {
      workerUnavailable = true;
      return null;
    }

    try {
      const w = new WorkerCtor('/public/js/workers/mosaicWorker.js', { type: 'module' });
      w.onmessage = (event) => {
        const msg = event?.data || {};
        if (msg.jobId !== latestJobId) {
          // Trabajo obsoleto descartado
          return;
        }
        const ctx = activeJobContext;
        activeJobContext = null;
        setWorkerBusyUI(false);

        if (msg.ok && msg.result) {
          applyComputedJobResult(msg.result, Boolean(ctx?.fitAfter));
          ctx?.resolve?.(msg.result);
        } else {
          if (ctx?.payload) {
            try {
              const res = runSyncFallbackJob(ctx.payload, Boolean(ctx.fitAfter));
              ctx.resolve?.(res);
              return;
            } catch (err) {
              showToast(err.message || 'Error al recalcular mosaico.', 'error');
              ctx?.reject?.(err);
              return;
            }
          }
          showToast(msg.error || 'Error en el cálculo del mosaico.', 'error');
          ctx?.reject?.(new Error(msg.error || 'Worker error'));
        }
      };

      w.onerror = () => {
        // Fallback limpio a hilo principal si el navegador/entorno no soporta Worker módulo
        if (mosaicWorker === w) {
          mosaicWorker = null;
        }
        workerUnavailable = true;
        const ctx = activeJobContext;
        activeJobContext = null;
        setWorkerBusyUI(false);
        if (ctx && ctx.jobId === latestJobId) {
          try {
            const res = runSyncFallbackJob(ctx.payload, Boolean(ctx.fitAfter));
            ctx.resolve?.(res);
          } catch (err) {
            ctx.reject?.(err);
          }
        }
      };

      mosaicWorker = w;
      return w;
    } catch {
      workerUnavailable = true;
      mosaicWorker = null;
      return null;
    }
  }

  // =====================================================================
  // TOASTS NO BLOQUEANTES
  // =====================================================================
  function showToast(message, type = 'info') {
    if (!dom.toastContainer) return;
    const el = doc.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    dom.toastContainer.appendChild(el);
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
    raf(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }

  // =====================================================================
  // RECONSTRUCCIÓN DEL MOSAICO (WEB WORKER + FALLBACK SÍNCRONO)
  // =====================================================================
  function rebuildMosaicFromSource({ fitAfter = false } = {}) {
    const state = store.getState();
    const cfg = state.config;
    if (cfg.generationMode === 'image' && !state.sourceImage) {
      return Promise.resolve(null);
    }

    const jobId = ++latestJobId;
    const { rgbaBuffer, sampleW, sampleH } =
      cfg.generationMode === 'image'
        ? extractSourceRgba(state.sourceImage, cfg)
        : { rgbaBuffer: null, sampleW: 0, sampleH: 0 };

    const configCopy = {
      ...cfg,
      mixtureStops: Array.isArray(cfg.mixtureStops) ? cfg.mixtureStops.map((s) => ({ ...s })) : undefined,
      gradientStops: Array.isArray(cfg.gradientStops) ? cfg.gradientStops.map((s) => ({ ...s })) : undefined,
    };

    const payload = { rgbaBuffer, sampleW, sampleH, config: configCopy };

    // Si hay un trabajo anterior activo en el Worker, cancelarlo inmediatamente
    if (workerBusy && mosaicWorker) {
      if (typeof mosaicWorker.terminate === 'function') {
        mosaicWorker.terminate();
        mosaicWorker = null;
      }
      if (activeJobContext?.resolve) {
        activeJobContext.resolve(null);
      }
      activeJobContext = null;
      setWorkerBusyUI(false);
    }

    const worker = mosaicWorker || spawnWorker();
    if (!worker) {
      const result = runSyncFallbackJob(payload, fitAfter);
      return Promise.resolve(result);
    }

    return new Promise((resolve, reject) => {
      setWorkerBusyUI(true);
      // Copia de respaldo en caso de fallo onerror tras transferir el buffer
      const fallbackRgba = rgbaBuffer ? new Uint8ClampedArray(rgbaBuffer) : null;
      activeJobContext = {
        jobId,
        fitAfter,
        resolve,
        reject,
        payload: { rgbaBuffer: fallbackRgba, sampleW, sampleH, config: configCopy },
      };

      const transferables =
        rgbaBuffer && rgbaBuffer.buffer instanceof ArrayBuffer ? [rgbaBuffer.buffer] : [];
      try {
        worker.postMessage({ jobId, rgbaBuffer, sampleW, sampleH, config: configCopy }, transferables);
      } catch {
        // Fallback inmediato si postMessage falló
        activeJobContext = null;
        setWorkerBusyUI(false);
        const result = runSyncFallbackJob(
          { rgbaBuffer: fallbackRgba, sampleW, sampleH, config: configCopy },
          fitAfter
        );
        resolve(result);
      }
    });
  }

  function requestProtectedRebuild({ description, nextPatch, fitAfter = false, revertUI }) {
    const state = store.getState();
    if (!state.hasManualEdits) {
      if (nextPatch) store.updateConfig(nextPatch, { silent: true });
      const resOrPromise = rebuildMosaicFromSource({ fitAfter });
      if (fitAfter && !workerBusy) renderer.fitToView();
      syncAllUI();
      return resOrPromise;
    }

    pendingProtectedAction = { nextPatch, fitAfter, revertUI };
    dom.protectMessage.textContent =
      description ||
      'Tienes trazos manuales en este mosaico. ¿Deseas recalcular desde la imagen y descartar tus ediciones, o cancelar y conservarlas?';
    dom.protectModal.classList.add('is-open');
    return Promise.resolve(null);
  }

  function closeProtectModal(applyChanges) {
    dom.protectModal.classList.remove('is-open');
    const action = pendingProtectedAction;
    pendingProtectedAction = null;
    if (!action) return;

    if (applyChanges) {
      if (action.nextPatch) store.updateConfig(action.nextPatch, { silent: true });
      rebuildMosaicFromSource({ fitAfter: Boolean(action.fitAfter) });
      syncAllUI();
      showToast('Mosaico recalculado', 'info');
    } else if (typeof action.revertUI === 'function') {
      action.revertUI();
      syncAllUI();
      showToast('Ediciones manuales conservadas', 'success');
    }
  }

  // =====================================================================
  // SINCRONIZACIÓN COMPLETA DE INTERFAZ
  // =====================================================================
  function syncHudAndMathCard() {
    const state = store.getState();
    const cfg = state.config;
    const m = state.printMetrics;

    dom.hudDims.textContent = `${cfg.widthCm} × ${cfg.heightCm} cm`;
    dom.hudPagesLabel.textContent = `Hojas ${cfg.paperFormat}`;
    dom.hudTiles.textContent = cfg.mosaicMode ? formatNumber(state.totalTiles) : 'Original';

    if (cfg.mirrorMode) {
      dom.hudMirror.className = 'hud-mirror-badge is-mirror';
      dom.hudMirror.innerHTML = '<span>⇄ Modo Espejo</span>';
      dom.mirrorOverlayTag.classList.remove('hidden');
    } else {
      dom.hudMirror.className = 'hud-mirror-badge';
      dom.hudMirror.innerHTML = '<span>Modo Directo</span>';
      dom.mirrorOverlayTag.classList.add('hidden');
    }

    dom.calcGridTitle.textContent = `Cálculo de cuadrícula ${cfg.paperFormat}`;

    if (state.printGridError || !m) {
      dom.hudPages.textContent = 'Inválido';
      dom.calcPagesTotal.textContent = '—';
      dom.calcUsable.textContent = '—';
      dom.calcGridNxNy.textContent = '—';
      dom.calcGridError.textContent = state.printGridError || 'Configuración de papel inválida.';
      dom.calcGridError.classList.remove('hidden');
      dom.btnExportPdf.disabled = true;
    } else {
      dom.hudPages.textContent = `${m.Nx} × ${m.Ny} (${m.totalPages})`;
      dom.calcPagesTotal.textContent = `${m.totalPages} ${m.totalPages === 1 ? 'hoja' : 'hojas'}`;
      dom.calcUsable.textContent = `${m.Ux.toFixed(1)} × ${m.Uy.toFixed(1)} cm`;
      dom.calcGridNxNy.textContent = `${m.Nx} cols × ${m.Ny} filas`;
      dom.calcGridError.classList.add('hidden');
      dom.btnExportPdf.disabled = false;
    }

    const orientDims = store.getPaperOrientationDims();
    dom.orientPortraitDims.textContent = orientDims.portrait;
    dom.orientLandscapeDims.textContent = orientDims.landscape;
  }

  function syncPatternUI(activePattern) {
    const norm = normalizePatternId(activePattern);
    dom.patternEntries.forEach(({ pattern, el }) => {
      if (el) el.classList.toggle('is-active', pattern === norm);
    });
  }

  function syncGenerationPanelsFromConfig(cfg) {
    const genMode = cfg.generationMode || 'image';
    dom.genmodeEntries.forEach(({ mode, el }) => {
      if (el) el.classList.toggle('is-active', mode === genMode);
    });

    if (dom.genmodeMixturePanel) {
      dom.genmodeMixturePanel.classList.toggle('hidden', genMode !== 'mixture');
    }
    if (dom.genmodeGradientPanel) {
      dom.genmodeGradientPanel.classList.toggle('hidden', genMode !== 'gradient');
    }
    if (dom.imagePreprocessSection) {
      dom.imagePreprocessSection.classList.toggle('is-dimmed', genMode !== 'image');
    }

    const mix = Array.isArray(cfg.mixtureStops) ? cfg.mixtureStops : [];
    if (mix[0] && dom.mixColor1 && dom.mixPct1) {
      dom.mixColor1.value = (mix[0].hex || '#36594D').toLowerCase();
      dom.mixPct1.value = mix[0].percent ?? 50;
    }
    if (mix[1] && dom.mixColor2 && dom.mixPct2) {
      dom.mixColor2.value = (mix[1].hex || '#E9BF8A').toLowerCase();
      dom.mixPct2.value = mix[1].percent ?? 30;
    }
    if (mix[2] && dom.mixColor3 && dom.mixPct3) {
      dom.mixColor3.value = (mix[2].hex || '#BD754E').toLowerCase();
      dom.mixPct3.value = mix[2].percent ?? 20;
    }
    updateMixtureTotalBadge();

    const grad = Array.isArray(cfg.gradientStops) ? cfg.gradientStops : [];
    if (grad[0] && dom.gradColor1 && dom.gradPos1) {
      dom.gradColor1.value = (grad[0].hex || '#263F36').toLowerCase();
      dom.gradPos1.value = Math.round((grad[0].position ?? 0) * 100);
    }
    if (grad[1] && dom.gradColor2 && dom.gradPos2) {
      dom.gradColor2.value = (grad[1].hex || '#E9BF8A').toLowerCase();
      dom.gradPos2.value = Math.round((grad[1].position ?? 0.55) * 100);
    }
    const hasThird = grad.length >= 3;
    if (dom.chkGradStop3) dom.chkGradStop3.checked = hasThird;
    if (dom.gradStop3Row) dom.gradStop3Row.classList.toggle('hidden', !hasThird);
    if (grad[2] && dom.gradColor3 && dom.gradPos3) {
      dom.gradColor3.value = (grad[2].hex || '#C45B3E').toLowerCase();
      dom.gradPos3.value = Math.round((grad[2].position ?? 1) * 100);
    }
    const angle = Number.isFinite(cfg.gradientAngleDeg) ? cfg.gradientAngleDeg : 135;
    if (dom.rangeGradAngle) dom.rangeGradAngle.value = angle;
    if (dom.valGradAngle) dom.valGradAngle.textContent = `${angle}°`;
  }

  function updateMixtureTotalBadge() {
    if (!dom.mixPctTotal) return;
    const p1 = Math.max(0, Number(dom.mixPct1?.value) || 0);
    const p2 = Math.max(0, Number(dom.mixPct2?.value) || 0);
    const p3 = Math.max(0, Number(dom.mixPct3?.value) || 0);
    const total = Math.round(p1 + p2 + p3);
    dom.mixPctTotal.textContent = total === 100 ? '100%' : `${total}% (norm.)`;
  }

  function syncBreakdownHint(state) {
    if (!dom.breakdownHint) return;
    const isBreakdown = state.config.viewMode === 'breakdown';
    dom.breakdownHint.classList.toggle('hidden', !isBreakdown);
    if (isBreakdown) {
      const idx = Number.isInteger(state.config.breakdownColorIdx) ? state.config.breakdownColorIdx : 0;
      const col = state.palette[idx];
      dom.breakdownHint.textContent = col
        ? `Aislando Color #${idx + 1} (${col.hex} · ${formatNumber(col.count)} pz). Selecciona otro color en la paleta inferior.`
        : 'Aislando color activo en la paleta.';
    }
  }

  function syncControlsFromState() {
    const state = store.getState();
    const cfg = state.config;

    dom.projectNameInput.value = state.projectName;
    dom.fileNameDisplay.textContent = state.sourceName;

    dom.inputWidth.value = cfg.widthCm;
    dom.inputHeight.value = cfg.heightCm;
    dom.chkKeepRatio.checked = state.keepRatio;

    dom.selectPaperFormat.value = cfg.paperFormat;
    dom.customPaperFields.classList.toggle('hidden', cfg.paperFormat !== 'CUSTOM');
    dom.inputCustomPaperW.value = cfg.customPaperWidthCm ?? PAPER_FORMATS.CUSTOM.shortCm;
    dom.inputCustomPaperH.value = cfg.customPaperHeightCm ?? PAPER_FORMATS.CUSTOM.longCm;

    dom.btnOrientPortrait.classList.toggle('is-active', cfg.orientation === 'portrait');
    dom.btnOrientLandscape.classList.toggle('is-active', cfg.orientation === 'landscape');

    dom.inputMargin.value = cfg.marginCm;
    dom.inputOverlap.value = cfg.overlapCm;
    dom.chkMirror.checked = cfg.mirrorMode;
    dom.chkShowA4F1.checked = cfg.showA4Grid;
    dom.chkShowA4F2.checked = cfg.showA4Grid;
    if (dom.chkShowA4Poster) dom.chkShowA4Poster.checked = cfg.showA4Grid;

    const isMosaic = Boolean(cfg.mosaicMode);
    dom.chkMosaicMode.checked = isMosaic;
    dom.f2Wrapper?.classList.remove('is-dimmed');
    dom.btnWorkmodeMosaic?.classList.toggle('is-active', isMosaic);
    dom.btnWorkmodePoster?.classList.toggle('is-active', !isMosaic);
    dom.mosaicOnlyControls?.classList.toggle('hidden', !isMosaic);
    dom.posterOnlyControls?.classList.toggle('hidden', isMosaic);

    // Sincronizar controles Modo Póster / Referencia (2.1)
    const posterMode = POSTER_FILTER_MODES.includes(cfg.posterFilterMode) ? cfg.posterFilterMode : 'color';
    dom.posterModeBtns?.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.posterMode === posterMode);
    });
    const contrastPct = Math.round(clamp(Number(cfg.posterContrast ?? 1.2), 0.4, 3.0) * 100);
    if (dom.rangePosterContrast) dom.rangePosterContrast.value = contrastPct;
    if (dom.valPosterContrast) dom.valPosterContrast.textContent = `${contrastPct}%`;
    const brightness = Math.round(clamp(Number(cfg.posterBrightness ?? 0), -80, 80));
    if (dom.rangePosterBrightness) dom.rangePosterBrightness.value = brightness;
    if (dom.valPosterBrightness) dom.valPosterBrightness.textContent = `${brightness}`;
    const threshold = Math.round(clamp(Number(cfg.posterThreshold ?? 128), 16, 240));
    if (dom.rangePosterThreshold) dom.rangePosterThreshold.value = threshold;
    if (dom.valPosterThreshold) dom.valPosterThreshold.textContent = `${threshold}`;
    if (dom.chkPosterInvert) dom.chkPosterInvert.checked = Boolean(cfg.posterInvert);

    dom.rangeTileSize.value = cfg.tileSizeCm;
    dom.valTileSize.textContent = `${Number(cfg.tileSizeCm).toFixed(1)} cm`;

    syncPatternUI(cfg.pattern);
    syncGenerationPanelsFromConfig(cfg);

    if (dom.selectPreprocessMode) dom.selectPreprocessMode.value = cfg.preprocessMode || 'none';
    if (dom.chkRemoveBg) dom.chkRemoveBg.checked = Boolean(cfg.removeBackground);

    dom.rangeColors.value = cfg.colorCount;
    dom.valColorsCount.textContent = `${cfg.colorCount} colores`;

    if (dom.selectColorSpace) dom.selectColorSpace.value = cfg.colorSpace || 'cielab';
    if (dom.selectDitherMode) dom.selectDitherMode.value = cfg.ditherMode || 'none';
    const ditherPct = Math.round(clamp(Number(cfg.ditherStrength ?? 0.65), 0, 1) * 100);
    if (dom.rangeDitherStrength) dom.rangeDitherStrength.value = ditherPct;
    if (dom.valDitherStrength) dom.valDitherStrength.textContent = `${ditherPct}%`;

    dom.inputGroutColor.value = cfg.groutColor;
    dom.groutPresets.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.grout.toLowerCase() === cfg.groutColor.toLowerCase());
    });

    dom.rangeGroutMm.value = cfg.groutMm;
    dom.valGroutMm.textContent = `${Number(cfg.groutMm).toFixed(1)} mm`;

    if (dom.selectTileFinish) dom.selectTileFinish.value = cfg.finish || 'ceramic';

    dom.vmodeBtns.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.vmode === cfg.viewMode);
    });
    if (dom.btnVmodeBreakdown) {
      dom.btnVmodeBreakdown.classList.toggle('is-active', cfg.viewMode === 'breakdown');
    }
    syncBreakdownHint(state);

    dom.chkShowNumbers.checked = cfg.showNumbers;

    syncToolUI();
    syncHistoryUI();
    syncZoomLabel();
    syncActiveColorPill();
  }

  function syncToolUI() {
    const { tool } = store.getState();
    dom.toolBtns.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tool === tool);
    });
    updateCanvasCursor();
  }

  function updateCanvasCursor() {
    const { tool } = store.getState();
    if (tool === 'pan') dom.canvas.style.cursor = isDraggingPan ? 'grabbing' : 'grab';
    else if (tool === 'brush') dom.canvas.style.cursor = 'crosshair';
    else if (tool === 'fill' || tool === 'replace') dom.canvas.style.cursor = 'cell';
    else if (tool === 'eyedropper') dom.canvas.style.cursor = 'copy';
  }

  function syncHistoryUI() {
    const { undoStack, redoStack } = store.getState();
    dom.btnUndo.disabled = undoStack.length === 0;
    dom.undoCount.textContent = `(${undoStack.length})`;
    dom.btnRedo.disabled = redoStack.length === 0;
    dom.redoCount.textContent = `(${redoStack.length})`;
  }

  function syncZoomLabel() {
    dom.zoomLevel.textContent = `${Math.round(store.getState().zoom * 100)}%`;
  }

  function syncActiveColorPill() {
    const state = store.getState();
    const col = state.palette[state.activeColorIdx];
    if (!col || !state.config.mosaicMode) {
      dom.activeColorPill.style.opacity = '0.4';
      return;
    }
    dom.activeColorPill.style.opacity = '1';
    dom.activeColorSwatch.style.backgroundColor = col.hex;
    dom.activeColorLabel.textContent = `#${state.activeColorIdx + 1} · ${col.hex}`;
  }

  function updatePaletteCountsInPlace() {
    const state = store.getState();
    const activeColors = state.palette.filter((c) => c.count > 0).length;
    dom.paletteSummary.textContent = `${activeColors} colores · ${formatNumber(state.totalTiles)} teselas`;
    dom.hudTiles.textContent = state.config.mosaicMode ? formatNumber(state.totalTiles) : 'Original';

    for (let idx = 0; idx < state.palette.length; idx++) {
      const node = paletteCountNodes[idx];
      if (node) {
        node.textContent = `${formatNumber(state.palette[idx].count)} pz`;
      }
    }
  }

  function renderPalette() {
    const state = store.getState();
    dom.paletteContainer.innerHTML = '';
    paletteCountNodes = [];

    if (!state.config.mosaicMode) {
      dom.paletteSummary.textContent = 'Modo Póster / Referencia 1:1';
      dom.paletteSubtitle.textContent = 'Ajusta Original, Grises, Alto Contraste B/N o Solo Contorno en la pestaña 2';
      return;
    }

    const activeColors = state.palette.filter((c) => c.count > 0).length;
    dom.paletteSummary.textContent = `${activeColors} colores · ${formatNumber(state.totalTiles)} teselas`;
    dom.paletteSubtitle.textContent =
      state.config.viewMode === 'breakdown'
        ? 'Modo Breakdown activo: haz clic en un color para aislar su capa'
        : 'Haz clic en un color para seleccionarlo con Pincel, Bote o Reemplazar';

    state.palette.forEach((col, idx) => {
      const isSelected = idx === state.activeColorIdx;
      const lum = getLuminance(col.r, col.g, col.b);
      const textContrast = lum > 142 ? '#24332d' : '#fffdf8';

      const card = doc.createElement('button');
      card.type = 'button';
      card.className = `palette-card${isSelected ? ' is-selected' : ''}`;
      card.dataset.colorIdx = String(idx);

      const swatch = doc.createElement('span');
      swatch.className = 'palette-swatch';
      swatch.style.backgroundColor = col.hex;
      swatch.style.color = textContrast;
      swatch.textContent = String(idx + 1);

      const meta = doc.createElement('div');
      const hexDiv = doc.createElement('div');
      hexDiv.className = 'palette-hex';
      hexDiv.textContent = col.hex;

      const countDiv = doc.createElement('div');
      countDiv.className = 'palette-count';
      countDiv.textContent = `${formatNumber(col.count)} pz`;
      paletteCountNodes[idx] = countDiv;

      meta.appendChild(hexDiv);
      meta.appendChild(countDiv);
      card.appendChild(swatch);
      card.appendChild(meta);

      card.addEventListener('click', () => {
        store.setActiveColor(idx);
        const curState = store.getState();
        if (curState.config.viewMode === 'breakdown') {
          renderer.invalidateCache();
          renderer.scheduleRender();
          syncBreakdownHint(curState);
        } else if (curState.tool === 'pan') {
          store.setTool('brush');
        }
        renderPalette();
      });

      dom.paletteContainer.appendChild(card);
    });
  }

  function syncAllUI() {
    syncHudAndMathCard();
    syncControlsFromState();
    renderPalette();
  }

  // =====================================================================
  // API CLIENT: UPLOAD, PROYECTOS Y EXPORTACIÓN PDF
  // =====================================================================
  async function fetchProjectsList() {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.projects)) return;
      const state = store.getState();
      state.projectsList = data.projects;
      renderProjectSelect();
    } catch {
      // Silencioso en caso de arranque offline sin backend de proyectos listo
    }
  }

  function renderProjectSelect() {
    const state = store.getState();
    const currentId = state.projectId || '';
    dom.projectSelect.innerHTML = '';

    const unsavedOpt = doc.createElement('option');
    unsavedOpt.value = '';
    unsavedOpt.textContent = 'Proyecto sin guardar';
    dom.projectSelect.appendChild(unsavedOpt);

    state.projectsList.forEach((proj) => {
      const opt = doc.createElement('option');
      opt.value = proj.id;
      opt.textContent = `${proj.name} (${proj.config?.widthCm ?? '?'}×${proj.config?.heightCm ?? '?'} cm)`;
      dom.projectSelect.appendChild(opt);
    });

    dom.projectSelect.value = currentId;
  }

  async function loadProjectById(projectId) {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'No se pudo cargar el proyecto.');
      }

      store.applyLoadedProject(data.project, data.snapshot);

      // Cargar imagen fuente correspondiente sin sobreescribir el mosaico restaurado
      if (data.project.sourceImageId) {
        const imgUrl = data.project.sourceImageUrl || `/api/uploads/${encodeURIComponent(data.project.sourceImageId)}`;
        const img = new Image();
        img.onload = () => {
          store.getState().sourceImage = img;
          renderer.invalidateCache();
          renderer.renderNow();
          arController.refreshArtwork();
        };
        img.onerror = () => {
          showToast('Proyecto cargado (imagen original no disponible; grilla intacta)', 'warn');
        };
        img.src = imgUrl;
      } else {
        const sample = await loadSampleSvgImage();
        store.getState().sourceImage = sample.image;
      }

      lastMosaicGeoKey = buildGeometryKey(store.getState().config);
      renderProjectSelect();
      syncAllUI();
      renderer.invalidateCache();
      renderer.fitToView();
      arController.refreshArtwork();
      showToast(`Proyecto cargado: ${data.project.name}`, 'success');
    } catch (err) {
      showToast(err.message || 'Error al abrir el proyecto.', 'error');
    }
  }

  async function saveCurrentProject() {
    const state = store.getState();
    state.projectName = dom.projectNameInput.value.trim() || 'Proyecto sin título';
    const payload = store.buildProjectPayload();
    const isUpdate = Boolean(state.projectId);
    const endpoint = isUpdate ? `/api/projects/${encodeURIComponent(state.projectId)}` : '/api/projects';
    const method = isUpdate ? 'PUT' : 'POST';

    dom.btnProjectSave.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'No se pudo guardar el proyecto.');
      }

      state.projectId = data.project.id;
      state.projectName = data.project.name;
      await fetchProjectsList();
      syncControlsFromState();
      showToast(`Proyecto guardado: ${data.project.name}`, 'success');
    } catch (err) {
      showToast(err.message || 'Error al guardar proyecto.', 'error');
    } finally {
      dom.btnProjectSave.disabled = false;
    }
  }

  async function duplicateCurrentProject() {
    const state = store.getState();
    if (!state.projectId) {
      showToast('Guarda el proyecto primero para poder duplicarlo.', 'warn');
      return;
    }
    dom.btnProjectDuplicate.disabled = true;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/duplicate`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'No se pudo duplicar el proyecto.');
      }

      store.applyLoadedProject(data.project, data.snapshot);
      await fetchProjectsList();
      syncAllUI();
      renderer.invalidateCache();
      renderer.renderNow();
      showToast(`Proyecto duplicado: ${data.project.name}`, 'success');
    } catch (err) {
      showToast(err.message || 'Error al duplicar proyecto.', 'error');
    } finally {
      dom.btnProjectDuplicate.disabled = false;
    }
  }

  function requestDeleteCurrentProject() {
    const state = store.getState();
    if (!state.projectId) {
      showToast('No hay un proyecto guardado activo para eliminar.', 'warn');
      return;
    }
    dom.deleteMessage.textContent = `¿Deseas eliminar "${state.projectName}" de forma permanente?`;
    dom.deleteModal.classList.add('is-open');
  }

  async function confirmDeleteProject() {
    const state = store.getState();
    const targetId = state.projectId;
    dom.deleteModal.classList.remove('is-open');
    if (!targetId) return;

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(targetId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'No se pudo eliminar el proyecto.');
      }

      await fetchProjectsList();
      await createNewProject();
      showToast('Proyecto eliminado', 'info');
    } catch (err) {
      showToast(err.message || 'Error al eliminar proyecto.', 'error');
    }
  }

  async function createNewProject() {
    store.resetToNewProject();
    renderProjectSelect();
    await loadSampleIllustration({ resetDims: true, silentToast: true });
    showToast('Nuevo proyecto inicializado', 'info');
  }

  async function loadSampleIllustration({ resetDims = false, silentToast = false } = {}) {
    try {
      const sample = await loadSampleSvgImage();
      const state = store.getState();
      if (resetDims) {
        state.config.widthCm = 120;
        state.config.heightCm = 90;
      } else if (state.keepRatio) {
        state.config.heightCm = Math.max(5, Math.round((state.config.widthCm / (4 / 3)) * 10) / 10);
      }
      store.setSourceImage({
        image: sample.image,
        imageId: null,
        name: 'ejemplo_paisaje_mosaico.png',
        aspectRatio: 4 / 3,
      });
      store.refreshPrintMetrics();
      store.refreshGridMetrics();
      if (state.config.mosaicMode) {
        await rebuildMosaicFromSource({ fitAfter: true });
      } else {
        renderer.invalidateCache();
        renderer.fitToView();
        arController.refreshArtwork();
      }
      syncAllUI();
      if (!silentToast) showToast('Ilustración de ejemplo cargada', 'success');
    } catch (err) {
      showToast(err.message || 'No se pudo cargar el ejemplo.', 'error');
    }
  }

  async function handleFileUpload(file) {
    if (!file) return;
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      showToast('Formato no soportado. Usa JPG, PNG o WebP.', 'error');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      showToast('La imagen supera el límite de 25 MB.', 'warn');
      return;
    }

    const formData = new FormData();
    formData.append('image', file);
    showToast('Subiendo y validando imagen en servidor...', 'info');

    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.image) {
        throw new Error(data.error || 'El servidor rechazó la imagen.');
      }

      const img = new Image();
      img.onload = async () => {
        const ratio =
          data.image.width && data.image.height
            ? data.image.width / data.image.height
            : img.width / img.height;

        const state = store.getState();
        store.setSourceImage({
          image: img,
          imageId: data.image.id,
          name: data.image.originalName || file.name,
          aspectRatio: ratio,
        });

        if (state.keepRatio) {
          const nextH = Math.max(5, Math.round((state.config.widthCm / ratio) * 10) / 10);
          store.updateConfig({ heightCm: nextH }, { silent: true, deferPolygons: !state.config.mosaicMode });
        }

        if (state.config.mosaicMode) {
          await rebuildMosaicFromSource({ fitAfter: true });
        } else {
          renderer.invalidateCache();
          renderer.fitToView();
          arController.refreshArtwork();
        }
        syncAllUI();
        showToast(`Imagen cargada (${img.width} × ${img.height} px)`, 'success');
      };
      img.onerror = () => showToast('No se pudo decodificar la imagen subida.', 'error');
      img.src = data.image.url;
    } catch (err) {
      showToast(err.message || 'Error al subir la imagen.', 'error');
    }
  }

  // =====================================================================
  // MODAL DE EXPORTACIÓN PDF SELECTIVA
  // =====================================================================
  function openPdfExportModal() {
    const state = store.getState();
    if (state.printGridError || !state.printMetrics || state.printSheets.length === 0) {
      showToast(state.printGridError || 'Configuración de papel inválida para exportar.', 'warn');
      return;
    }

    selectedSheetsSet = new Set(state.printSheets.map((s) => s.label));
    dom.pdfRangeInput.value = '';
    if (dom.selectPdfSplitMode && !PDF_SPLIT_MODES.includes(dom.selectPdfSplitMode.value)) {
      dom.selectPdfSplitMode.value = 'single';
    }
    if (dom.inputPdfSheetsPerFile && !dom.inputPdfSheetsPerFile.value) {
      dom.inputPdfSheetsPerFile.value = '10';
    }
    dom.chkPdfIncludeCover.checked = true;
    dom.chkPdfIncludePalette.checked = state.config.mosaicMode && state.palette.length > 0;
    dom.chkPdfIncludePalette.disabled = !state.config.mosaicMode || state.palette.length === 0;

    dom.pdfExportStatus.classList.add('hidden');
    dom.btnPdfConfirmExport.disabled = false;

    renderPdfSheetPicker();
    updatePdfExportSummary();
    dom.pdfModal.classList.add('is-open');
  }

  function renderPdfSheetPicker() {
    const state = store.getState();
    const m = state.printMetrics;
    dom.pdfSheetsGrid.innerHTML = '';
    dom.pdfSheetsGrid.style.gridTemplateColumns = `repeat(${Math.max(1, m.Nx)}, minmax(44px, 1fr))`;

    state.printSheets.forEach((sheet) => {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = `sheet-chip${selectedSheetsSet.has(sheet.label) ? ' is-selected' : ''}`;
      chip.dataset.sheet = sheet.label;
      chip.textContent = sheet.label;
      chip.title = `Hoja ${sheet.label} (Fila ${sheet.row + 1}, Col ${sheet.col + 1})`;

      chip.addEventListener('click', () => {
        if (selectedSheetsSet.has(sheet.label)) {
          selectedSheetsSet.delete(sheet.label);
          chip.classList.remove('is-selected');
        } else {
          selectedSheetsSet.add(sheet.label);
          chip.classList.add('is-selected');
        }
        dom.pdfRangeInput.value = '';
        updatePdfExportSummary();
      });

      dom.pdfSheetsGrid.appendChild(chip);
    });
  }

  function syncSheetChipsHighlight() {
    const chips = dom.pdfSheetsGrid.querySelectorAll('.sheet-chip');
    chips.forEach((chip) => {
      chip.classList.toggle('is-selected', selectedSheetsSet.has(chip.dataset.sheet));
    });
  }

  function getCurrentPdfSplitOptions() {
    const rawSplit = dom.selectPdfSplitMode?.value;
    const splitMode = PDF_SPLIT_MODES.includes(rawSplit) ? rawSplit : 'single';
    const rawSheets = Number.parseInt(dom.inputPdfSheetsPerFile?.value, 10);
    const sheetsPerPdf = clamp(Number.isFinite(rawSheets) ? rawSheets : 10, 1, 50);
    return { splitMode, sheetsPerPdf };
  }

  function updatePdfExportSummary() {
    const state = store.getState();
    const totalAvailable = state.printSheets.length;
    const selectedCount = selectedSheetsSet.size;
    const includeCover = dom.chkPdfIncludeCover.checked ? 1 : 0;
    const includePal =
      dom.chkPdfIncludePalette.checked && state.config.mosaicMode && state.palette.length > 0
        ? Math.ceil(state.palette.length / 30)
        : 0;
    const totalPages = includeCover + includePal + selectedCount;

    const { splitMode, sheetsPerPdf } = getCurrentPdfSplitOptions();
    dom.pdfBatchesField?.classList.toggle('hidden', splitMode !== 'batches');

    const maxAllowedPages =
      !state.config.mosaicMode || splitMode !== 'single'
        ? MAX_PDF_PAGES_POSTER
        : MAX_PDF_PAGES_PHASE1;

    if (splitMode === 'per_sheet') {
      dom.pdfExportSummary.textContent = `${selectedCount} de ${totalAvailable} hojas · ${selectedCount} PDFs en .zip (${totalPages} págs)`;
    } else if (splitMode === 'batches') {
      const pdfCount = Math.max(1, Math.ceil(selectedCount / sheetsPerPdf));
      dom.pdfExportSummary.textContent = `${selectedCount} de ${totalAvailable} hojas · ${pdfCount} PDFs en .zip (${sheetsPerPdf} hojas/PDF)`;
    } else {
      dom.pdfExportSummary.textContent = `${selectedCount} de ${totalAvailable} hojas · ${totalPages} páginas PDF`;
    }

    if (dom.btnPdfConfirmExport) {
      dom.btnPdfConfirmExport.textContent =
        splitMode === 'single' ? 'Descargar PDF (1:1)' : 'Descargar ZIP (PDFs 1:1)';
    }

    if (selectedCount === 0) {
      dom.btnPdfConfirmExport.disabled = true;
    } else if (totalPages > maxAllowedPages) {
      dom.pdfExportSummary.textContent += ` (supera el máximo de ${maxAllowedPages})`;
      dom.btnPdfConfirmExport.disabled = true;
    } else {
      dom.btnPdfConfirmExport.disabled = isExportingPdf;
    }
  }

  async function executePdfExport() {
    if (isExportingPdf) return;
    if (selectedSheetsSet.size === 0) {
      showToast('Selecciona al menos una hoja para exportar.', 'warn');
      return;
    }

    const state = store.getState();
    const { splitMode, sheetsPerPdf } = getCurrentPdfSplitOptions();
    const allowLargePoster = Boolean(!state.config.mosaicMode || splitMode !== 'single');

    isExportingPdf = true;
    dom.btnPdfConfirmExport.disabled = true;
    dom.btnPdfCancelExport.disabled = true;
    dom.pdfExportStatus.classList.remove('hidden');
    dom.pdfStatusText.textContent =
      splitMode === 'single'
        ? 'Generando PDF vectorial 1:1 en el servidor...'
        : 'Generando paquete ZIP de PDFs 1:1 en el servidor...';
    dom.pdfProgressBar.style.width = '45%';
    dom.pdfPercentLabel.textContent = '45%';

    const exportOptions = {
      includeCover: dom.chkPdfIncludeCover.checked,
      includePalette: dom.chkPdfIncludePalette.checked,
      selectedSheets: Array.from(selectedSheetsSet),
      rangeExpression: dom.pdfRangeInput.value.trim(),
      splitMode,
      sheetsPerPdf,
      allowLargePoster,
    };

    try {
      const res = await fetch('/api/export/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(store.buildPdfExportPayload(exportOptions)),
      });

      if (!res.ok) {
        let errMsg = 'Error al generar el PDF 1:1.';
        try {
          const errJson = await res.json();
          if (errJson?.error) errMsg = errJson.error;
        } catch {
          // respuesta no JSON
        }
        throw new Error(errMsg);
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const isZip = contentType.includes('application/zip') || contentType.includes('zip');
      const disp = res.headers.get('content-disposition') || '';
      const fnMatch = /filename\*?=(?:UTF-8'')?"?([^";\n]+)"?/i.exec(disp);
      const defaultExt = isZip ? '.zip' : '.pdf';
      const filename =
        fnMatch?.[1] || `GuiaMosaico_${state.config.widthCm}x${state.config.heightCm}cm${defaultExt}`;
      const pdfCount = Number.parseInt(res.headers.get('x-pdf-count') || '1', 10) || 1;
      const pdfPages =
        Number.parseInt(res.headers.get('x-pdf-pages') || String(selectedSheetsSet.size), 10) ||
        selectedSheetsSet.size;

      dom.pdfProgressBar.style.width = '85%';
      dom.pdfPercentLabel.textContent = '85%';
      dom.pdfStatusText.textContent = isZip ? 'Descargando paquete ZIP...' : 'Descargando archivo PDF...';

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = url;
      link.download = filename;
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      dom.pdfProgressBar.style.width = '100%';
      dom.pdfPercentLabel.textContent = '100%';
      dom.pdfStatusText.textContent = isZip
        ? `¡ZIP descargado (${pdfCount} PDFs · ${pdfPages} págs)!`
        : `¡PDF descargado (${pdfPages} págs)!`;

      if (isZip) {
        showToast(`ZIP descargado: ${filename} (${pdfCount} PDFs · ${pdfPages} págs)`, 'success');
      } else {
        showToast(`PDF descargado: ${filename} (${pdfPages} págs)`, 'success');
      }

      setTimeout(() => {
        dom.pdfModal.classList.remove('is-open');
      }, 350);
    } catch (err) {
      showToast(err.message || 'No se pudo exportar el PDF.', 'error');
      dom.pdfExportStatus.classList.add('hidden');
    } finally {
      isExportingPdf = false;
      dom.btnPdfCancelExport.disabled = false;
      updatePdfExportSummary();
    }
  }

  // =====================================================================
  // INTERACCIÓN SOBRE EL CANVAS (HERRAMIENTAS + ZOOM + CURSOR)
  // =====================================================================
  function handleBrushAt(clientX, clientY) {
    const { xCm, yCm } = renderer.screenToCm(clientX, clientY);
    const res = store.paintTileAtCm(xCm, yCm);
    if (res.changed) {
      renderer.queueTilePatch({
        row: res.hit.row,
        col: res.hit.col,
        idx: res.hit.idx,
        isPolygonal: Boolean(res.hit.isPolygonal),
        newColorIdx: res.newColorIdx,
      });
      renderer.scheduleRender();
    }
  }

  function updateCursorInfo(clientX, clientY) {
    const state = store.getState();
    const { xCm, yCm } = renderer.screenToCm(clientX, clientY);
    const cfg = state.config;

    if (xCm >= 0 && yCm >= 0 && xCm <= cfg.widthCm && yCm <= cfg.heightCm) {
      const m = state.printMetrics;
      let sheetLabel = 'A1';
      if (m) {
        const col = Math.min(m.Nx - 1, Math.max(0, Math.floor(xCm / m.stepX)));
        const row = Math.min(m.Ny - 1, Math.max(0, Math.floor(yCm / m.stepY)));
        sheetLabel = `${getRowLabel(row)}${col + 1}`;
      }
      let info = `Hoja ${sheetLabel} · ${xCm.toFixed(1)}, ${yCm.toFixed(1)} cm`;
      if (cfg.mosaicMode && state.grid && state.gridMetrics) {
        const hit = store.hitTestAtCm(xCm, yCm);
        if (hit) {
          const tileLabel = hit.isPolygonal ? `#${hit.cellId}` : `(${hit.row + 1},${hit.col + 1})`;
          info += ` · Tesela ${tileLabel} · Color #${hit.colorIdx + 1}`;
        }
      }
      dom.cursorInfo.textContent = info;
      dom.cursorInfo.classList.remove('hidden');
    } else {
      dom.cursorInfo.classList.add('hidden');
    }
  }

  let eventsBound = false;
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    const updateArTabPreview = () => {
      if (!dom.arTabPreviewDims) return;
      const cfg = store.getState().config || {};
      const w = Number(cfg.widthCm) || 120;
      const h = Number(cfg.heightCm) || 90;
      const m2 = ((w * h) / 10000).toFixed(2);
      dom.arTabPreviewDims.textContent = `${w.toFixed(1)} × ${h.toFixed(1)} cm · ${m2} m²`;
    };

    updateArTabPreview();

    store.subscribe((state, reason) => {
      if (reason === 'paint') {
        updatePaletteCountsInPlace();
        syncHistoryUI();
        arController.refreshArtwork();
        return;
      }
      if (reason === 'camera') {
        syncZoomLabel();
        return;
      }
      if (reason === 'tool') {
        syncToolUI();
        return;
      }
      if (reason === 'activeColor') {
        syncActiveColorPill();
        syncBreakdownHint(state);
        if (state.config.viewMode === 'breakdown') {
          arController.refreshArtwork();
        }
        return;
      }
      if (reason === 'undo' || reason === 'redo' || reason === 'fill' || reason === 'replace') {
        syncHistoryUI();
        syncActiveColorPill();
        syncBreakdownHint(state);
        renderPalette();
        renderer.invalidateCache();
        renderer.scheduleRender();
        arController.refreshArtwork();
        return;
      }
      if (reason === 'config') {
        syncHudAndMathCard();
        syncBreakdownHint(state);
        renderer.scheduleRender();
        arController.refreshArtwork();
        updateArTabPreview();
      }
    });

    // Pestañas del sidebar
    dom.tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        dom.tabBtns.forEach((b) => {
          const active = b.dataset.tab === target;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        dom.panelF1?.classList.toggle('hidden', target !== 'f1');
        dom.panelF2?.classList.toggle('hidden', target !== 'f2');
        dom.panelF3?.classList.toggle('hidden', target !== 'f3');
        if (target === 'f3') {
          updateArTabPreview();
          arController.open({ autoStartCamera: true });
        }
      });
    });

    // Botones de Cámara AR (Topbar, Lienzo y Pestaña 3)
    dom.btnOpenAr?.addEventListener('click', () => {
      arController.open({ autoStartCamera: true });
    });
    dom.btnCanvasQuickAr?.addEventListener('click', () => {
      arController.open({ autoStartCamera: true });
    });
    dom.btnArLaunchLive?.addEventListener('click', () => {
      arController.open({ autoStartCamera: true });
    });
    dom.btnArLaunchPhoto?.addEventListener('click', () => {
      arController.open({ autoStartCamera: false });
      arController.triggerMobilePhotoCapture();
    });
    dom.btnArLaunchWall?.addEventListener('click', () => {
      arController.open({ autoStartCamera: false });
      arController.loadBuiltInScene('wall');
    });
    dom.btnArLaunchFloor?.addEventListener('click', () => {
      arController.open({ autoStartCamera: false });
      arController.loadBuiltInScene('floor');
    });

    // Barra de proyectos
    dom.projectSelect.addEventListener('change', () => {
      const id = dom.projectSelect.value;
      if (id) {
        loadProjectById(id);
      } else if (store.getState().projectId) {
        createNewProject();
      }
    });
    dom.projectNameInput.addEventListener('input', () => {
      store.getState().projectName = dom.projectNameInput.value;
    });
    dom.btnProjectNew.addEventListener('click', createNewProject);
    dom.btnProjectSave.addEventListener('click', saveCurrentProject);
    dom.btnProjectDuplicate.addEventListener('click', duplicateCurrentProject);
    dom.btnProjectDelete.addEventListener('click', requestDeleteCurrentProject);
    dom.btnDeleteConfirm.addEventListener('click', confirmDeleteProject);
    dom.btnDeleteCancel.addEventListener('click', () => dom.deleteModal.classList.remove('is-open'));

    // Carga de imagen & ejemplo
    dom.btnLoadSample.addEventListener('click', () => loadSampleIllustration({ resetDims: false }));
    dom.dropzone.addEventListener('click', () => dom.fileInput.click());
    dom.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dom.fileInput.click();
      }
    });
    dom.fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleFileUpload(file);
      dom.fileInput.value = '';
    });
    dom.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.dropzone.classList.add('is-dragover');
    });
    dom.dropzone.addEventListener('dragleave', () => {
      dom.dropzone.classList.remove('is-dragover');
    });
    dom.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove('is-dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFileUpload(file);
    });

    // Dimensiones (protegidas si hasManualEdits === true)
    let dimTimer = null;
    function handleDimensionEdit(axis, isCommitted) {
      const state = store.getState();
      const rawVal = Number.parseFloat(axis === 'width' ? dom.inputWidth.value : dom.inputHeight.value);
      if (!Number.isFinite(rawVal) || rawVal < 5) return;

      const clamped = Math.min(2500, rawVal);
      let nextW = state.config.widthCm;
      let nextH = state.config.heightCm;

      if (axis === 'width') {
        nextW = clamped;
        if (state.keepRatio) {
          nextH = Math.max(5, Math.round((nextW / state.aspectRatio) * 10) / 10);
          dom.inputHeight.value = nextH;
        }
      } else {
        nextH = clamped;
        if (state.keepRatio) {
          nextW = Math.max(5, Math.round((nextH * state.aspectRatio) * 10) / 10);
          dom.inputWidth.value = nextW;
        }
      }

      if (nextW === state.config.widthCm && nextH === state.config.heightCm) {
        return;
      }

      if (!state.config.mosaicMode) {
        store.updateConfig({ widthCm: nextW, heightCm: nextH }, { silent: true, deferPolygons: true });
        syncHudAndMathCard();
        renderer.invalidateCache();
        clearTimeout(dimTimer);
        if (isCommitted) {
          renderer.fitToView();
          arController.refreshArtwork();
        } else {
          dimTimer = setTimeout(() => {
            renderer.fitToView();
            arController.refreshArtwork();
          }, 140);
        }
        return;
      }

      if (state.hasManualEdits) {
        if (!isCommitted) return;
        const prevW = state.config.widthCm;
        const prevH = state.config.heightCm;
        requestProtectedRebuild({
          description: `Cambiar las medidas finales a ${nextW} × ${nextH} cm recalculará el mosaico y descartará los trazos manuales.`,
          nextPatch: { widthCm: nextW, heightCm: nextH },
          fitAfter: true,
          revertUI: () => {
            dom.inputWidth.value = prevW;
            dom.inputHeight.value = prevH;
          },
        });
        return;
      }

      store.updateConfig({ widthCm: nextW, heightCm: nextH }, { silent: true, deferPolygons: true });
      syncHudAndMathCard();
      clearTimeout(dimTimer);
      dimTimer = setTimeout(() => {
        rebuildMosaicFromSource({ fitAfter: true });
      }, 140);
    }

    dom.inputWidth.addEventListener('input', () => handleDimensionEdit('width', false));
    dom.inputWidth.addEventListener('change', () => handleDimensionEdit('width', true));
    dom.inputHeight.addEventListener('input', () => handleDimensionEdit('height', false));
    dom.inputHeight.addEventListener('change', () => handleDimensionEdit('height', true));

    dom.chkKeepRatio.addEventListener('change', () => {
      const state = store.getState();
      state.keepRatio = dom.chkKeepRatio.checked;
      if (state.keepRatio) {
        const nextH = Math.max(5, Math.round((state.config.widthCm / state.aspectRatio) * 10) / 10);
        if (nextH !== state.config.heightCm) {
          const prevH = state.config.heightCm;
          if (!state.config.mosaicMode) {
            store.updateConfig({ heightCm: nextH }, { deferPolygons: true });
            dom.inputHeight.value = nextH;
            renderer.invalidateCache();
            renderer.fitToView();
            arController.refreshArtwork();
            return;
          }
          requestProtectedRebuild({
            description: `Ajustar el alto a ${nextH} cm para restaurar la proporción original descartará los trazos manuales.`,
            nextPatch: { heightCm: nextH },
            fitAfter: true,
            revertUI: () => {
              state.keepRatio = false;
              dom.chkKeepRatio.checked = false;
              dom.inputHeight.value = prevH;
            },
          });
        }
      }
    });

    // Formato de papel multipapel y personalizado
    dom.selectPaperFormat.addEventListener('change', () => {
      const paperFormat = dom.selectPaperFormat.value;
      dom.customPaperFields.classList.toggle('hidden', paperFormat !== 'CUSTOM');
      store.updateConfig({ paperFormat }, { deferPolygons: true });
      syncHudAndMathCard();
    });

    const handleCustomPaperInput = () => {
      const w = Number.parseFloat(dom.inputCustomPaperW.value);
      const h = Number.parseFloat(dom.inputCustomPaperH.value);
      if (Number.isFinite(w) && Number.isFinite(h)) {
        store.updateConfig(
          {
            customPaperWidthCm: w,
            customPaperHeightCm: h,
          },
          { deferPolygons: true }
        );
      }
    };
    dom.inputCustomPaperW.addEventListener('input', handleCustomPaperInput);
    dom.inputCustomPaperH.addEventListener('input', handleCustomPaperInput);

    function setOrientation(orientation) {
      store.updateConfig({ orientation }, { deferPolygons: true });
      dom.btnOrientPortrait.classList.toggle('is-active', orientation === 'portrait');
      dom.btnOrientLandscape.classList.toggle('is-active', orientation === 'landscape');
    }
    dom.btnOrientPortrait.addEventListener('click', () => setOrientation('portrait'));
    dom.btnOrientLandscape.addEventListener('click', () => setOrientation('landscape'));

    dom.inputMargin.addEventListener('input', () => {
      const v = Number.parseFloat(dom.inputMargin.value);
      if (Number.isFinite(v)) {
        store.updateConfig({ marginCm: v }, { deferPolygons: true });
      }
    });
    dom.inputOverlap.addEventListener('input', () => {
      const v = Number.parseFloat(dom.inputOverlap.value);
      if (Number.isFinite(v)) {
        store.updateConfig({ overlapCm: v }, { deferPolygons: true });
      }
    });

    // Transferencia y guías
    dom.chkMirror.addEventListener('change', () => {
      store.updateConfig({ mirrorMode: dom.chkMirror.checked }, { deferPolygons: true });
      syncHudAndMathCard();
      renderer.invalidateCache();
      renderer.scheduleRender();
    });

    function toggleSheetsGrid(val) {
      dom.chkShowA4F1.checked = val;
      dom.chkShowA4F2.checked = val;
      if (dom.chkShowA4Poster) dom.chkShowA4Poster.checked = val;
      store.updateConfig({ showA4Grid: val }, { deferPolygons: true });
    }
    dom.chkShowA4F1.addEventListener('change', () => toggleSheetsGrid(dom.chkShowA4F1.checked));
    dom.chkShowA4F2.addEventListener('change', () => toggleSheetsGrid(dom.chkShowA4F2.checked));
    dom.chkShowA4Poster?.addEventListener('change', () => toggleSheetsGrid(dom.chkShowA4Poster.checked));

    // Fase 2 / 2.1: Selector de Modo (Mosaico Teselas vs Póster / Contraste) SIN is-dimmed
    function setWorkMode(isMosaic) {
      const active = Boolean(isMosaic);
      const state = store.getState();
      const prev = Boolean(state.config.mosaicMode);
      store.updateConfig({ mosaicMode: active });
      dom.f2Wrapper?.classList.remove('is-dimmed');

      if (active && !prev) {
        const curGeoKey = buildGeometryKey(store.getState().config);
        const curState = store.getState();
        const expectedLen = curState.isPolygonal && curState.cells
          ? curState.cells.length
          : curState.gridMetrics
          ? curState.gridMetrics.tileRows * curState.gridMetrics.maxRowCols
          : 0;
        if (
          !curState.grid ||
          curState.palette.length === 0 ||
          (lastMosaicGeoKey && curGeoKey !== lastMosaicGeoKey) ||
          (expectedLen > 0 && curState.grid.length !== expectedLen)
        ) {
          rebuildMosaicFromSource();
        }
      }

      renderer.invalidateCache();
      syncAllUI();
      renderer.scheduleRender();
      arController.refreshArtwork();
    }

    dom.chkMosaicMode.addEventListener('change', () => setWorkMode(dom.chkMosaicMode.checked));
    dom.btnWorkmodeMosaic?.addEventListener('click', () => setWorkMode(true));
    dom.btnWorkmodePoster?.addEventListener('click', () => setWorkMode(false));

    // Controles Modo Póster / Referencia (2.1)
    dom.posterModeBtns?.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = POSTER_FILTER_MODES.includes(btn.dataset.posterMode)
          ? btn.dataset.posterMode
          : 'color';
        dom.posterModeBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.posterMode === mode));
        const patch = { posterFilterMode: mode };
        if (mode === 'color' && !store.getState().config.mosaicMode) {
          patch.viewMode = 'color';
        }
        store.updateConfig(patch, { deferPolygons: true });
        renderer.invalidateCache();
        renderer.scheduleRender();
        arController.refreshArtwork();
      });
    });

    dom.rangePosterContrast?.addEventListener('input', () => {
      const pct = Number.parseInt(dom.rangePosterContrast.value, 10) || 120;
      const val = clamp(pct / 100, 0.4, 3.0);
      if (dom.valPosterContrast) dom.valPosterContrast.textContent = `${pct}%`;
      store.updateConfig({ posterContrast: val }, { silent: true, deferPolygons: true });
      renderer.invalidateCache();
      renderer.scheduleRender();
      arController.refreshArtwork();
    });

    dom.rangePosterBrightness?.addEventListener('input', () => {
      const raw = Number.parseInt(dom.rangePosterBrightness.value, 10);
      const val = clamp(Number.isFinite(raw) ? raw : 0, -80, 80);
      if (dom.valPosterBrightness) dom.valPosterBrightness.textContent = `${val}`;
      store.updateConfig({ posterBrightness: val }, { silent: true, deferPolygons: true });
      renderer.invalidateCache();
      renderer.scheduleRender();
      arController.refreshArtwork();
    });

    dom.rangePosterThreshold?.addEventListener('input', () => {
      const raw = Number.parseInt(dom.rangePosterThreshold.value, 10);
      const val = clamp(Number.isFinite(raw) ? raw : 128, 16, 240);
      if (dom.valPosterThreshold) dom.valPosterThreshold.textContent = `${val}`;
      store.updateConfig({ posterThreshold: val }, { silent: true, deferPolygons: true });
      renderer.invalidateCache();
      renderer.scheduleRender();
      arController.refreshArtwork();
    });

    dom.chkPosterInvert?.addEventListener('change', () => {
      store.updateConfig({ posterInvert: dom.chkPosterInvert.checked }, { deferPolygons: true });
      renderer.invalidateCache();
      renderer.scheduleRender();
      arController.refreshArtwork();
    });

    // Tamaño tesela (protegido si hasManualEdits === true, debounce 140ms con deferPolygons)
    let tileTimer = null;
    dom.rangeTileSize.addEventListener('input', () => {
      const val = Number.parseFloat(dom.rangeTileSize.value);
      dom.valTileSize.textContent = `${val.toFixed(1)} cm`;
      if (!store.getState().hasManualEdits) {
        store.updateConfig({ tileSizeCm: val }, { silent: true, deferPolygons: true });
        clearTimeout(tileTimer);
        tileTimer = setTimeout(() => {
          rebuildMosaicFromSource();
        }, 140);
      }
    });
    dom.rangeTileSize.addEventListener('change', () => {
      const val = Number.parseFloat(dom.rangeTileSize.value);
      const prev = store.getState().config.tileSizeCm;
      if (store.getState().hasManualEdits && val !== prev) {
        requestProtectedRebuild({
          description: `Cambiar el tamaño de tesela a ${val.toFixed(1)} cm recalculará la grilla y descartará los trazos manuales actuales.`,
          nextPatch: { tileSizeCm: val },
          revertUI: () => {
            dom.rangeTileSize.value = prev;
            dom.valTileSize.textContent = `${Number(prev).toFixed(1)} cm`;
          },
        });
      } else if (!store.getState().hasManualEdits && val !== prev) {
        clearTimeout(tileTimer);
        store.updateConfig({ tileSizeCm: val }, { silent: true, deferPolygons: true });
        rebuildMosaicFromSource();
      }
    });

    // Selector de los 9 patrones arquitectónicos (protegido si hasManualEdits === true)
    function selectPattern(pattern) {
      const prev = normalizePatternId(store.getState().config.pattern);
      const next = normalizePatternId(pattern);
      if (next === prev) return;
      const label = PATTERN_LABELS[next] || next;
      requestProtectedRebuild({
        description: `Cambiar el patrón a "${label}" recalculará las celdas y descartará los trazos manuales actuales.`,
        nextPatch: { pattern: next },
        revertUI: () => syncPatternUI(prev),
      });
    }
    dom.patternEntries.forEach(({ pattern, el }) => {
      if (!el) return;
      el.addEventListener('click', () => selectPattern(el.dataset?.pattern || pattern));
    });

    // Modo de Generación (Imagen / Mezcla % / Degradado)
    function selectGenerationMode(mode) {
      const prev = store.getState().config.generationMode || 'image';
      if (mode === prev) return;
      const modeNames = { image: 'Imagen', mixture: 'Mezcla %', gradient: 'Degradado' };
      requestProtectedRebuild({
        description: `Cambiar el modo de generación a "${modeNames[mode] || mode}" recalculará el mosaico y descartará los trazos manuales actuales.`,
        nextPatch: { generationMode: mode },
        revertUI: () => syncGenerationPanelsFromConfig(store.getState().config),
      });
    }
    dom.genmodeEntries.forEach(({ mode, el }) => {
      if (!el) return;
      el.addEventListener('click', () => selectGenerationMode(el.dataset?.genmode || mode));
    });

    [dom.mixPct1, dom.mixPct2, dom.mixPct3].forEach((input) => {
      input?.addEventListener('input', updateMixtureTotalBadge);
    });

    dom.btnApplyMixture?.addEventListener('click', () => {
      const stops = [
        { hex: (dom.mixColor1?.value || '#36594D').toUpperCase(), percent: Math.max(0, Number(dom.mixPct1?.value) || 0) },
        { hex: (dom.mixColor2?.value || '#E9BF8A').toUpperCase(), percent: Math.max(0, Number(dom.mixPct2?.value) || 0) },
        { hex: (dom.mixColor3?.value || '#BD754E').toUpperCase(), percent: Math.max(0, Number(dom.mixPct3?.value) || 0) },
      ];
      requestProtectedRebuild({
        description: 'Aplicar esta mezcla porcentual recalculará las teselas y descartará los trazos manuales actuales.',
        nextPatch: { generationMode: 'mixture', mixtureStops: stops },
        revertUI: () => syncGenerationPanelsFromConfig(store.getState().config),
      });
    });

    dom.chkGradStop3?.addEventListener('change', () => {
      dom.gradStop3Row?.classList.toggle('hidden', !dom.chkGradStop3.checked);
    });
    dom.rangeGradAngle?.addEventListener('input', () => {
      if (dom.valGradAngle) dom.valGradAngle.textContent = `${dom.rangeGradAngle.value}°`;
    });

    dom.btnApplyGradient?.addEventListener('click', () => {
      const stops = [
        {
          hex: (dom.gradColor1?.value || '#263F36').toUpperCase(),
          position: clamp((Number(dom.gradPos1?.value) || 0) / 100, 0, 1),
        },
        {
          hex: (dom.gradColor2?.value || '#E9BF8A').toUpperCase(),
          position: clamp((Number(dom.gradPos2?.value) || 55) / 100, 0, 1),
        },
      ];
      if (dom.chkGradStop3?.checked) {
        stops.push({
          hex: (dom.gradColor3?.value || '#C45B3E').toUpperCase(),
          position: clamp((Number(dom.gradPos3?.value) || 100) / 100, 0, 1),
        });
      }
      stops.sort((a, b) => a.position - b.position);
      const angleDeg = Number(dom.rangeGradAngle?.value ?? 135);

      requestProtectedRebuild({
        description: 'Aplicar este degradado direccional recalculará las teselas y descartará los trazos manuales actuales.',
        nextPatch: { generationMode: 'gradient', gradientStops: stops, gradientAngleDeg: angleDeg },
        revertUI: () => syncGenerationPanelsFromConfig(store.getState().config),
      });
    });

    // Preprocesado artístico (protegido)
    dom.selectPreprocessMode?.addEventListener('change', () => {
      const val = dom.selectPreprocessMode.value;
      const prev = store.getState().config.preprocessMode || 'none';
      if (val === prev) return;
      requestProtectedRebuild({
        description: 'Aplicar un filtro de preprocesado recalculará el mosaico desde la imagen y descartará los trazos manuales.',
        nextPatch: { preprocessMode: val },
        revertUI: () => {
          dom.selectPreprocessMode.value = prev;
        },
      });
    });

    dom.chkRemoveBg?.addEventListener('change', () => {
      const val = dom.chkRemoveBg.checked;
      const prev = Boolean(store.getState().config.removeBackground);
      if (val === prev) return;
      requestProtectedRebuild({
        description: 'Activar o desactivar la limpieza de fondo ΔE00 recalculará el mosaico y descartará los trazos manuales.',
        nextPatch: { removeBackground: val },
        revertUI: () => {
          dom.chkRemoveBg.checked = prev;
        },
      });
    });

    // Colores K-Means (protegido si hasManualEdits === true)
    let colorTimer = null;
    dom.rangeColors.addEventListener('input', () => {
      const val = Number.parseInt(dom.rangeColors.value, 10);
      dom.valColorsCount.textContent = `${val} colores`;
      if (!store.getState().hasManualEdits) {
        store.updateConfig({ colorCount: val }, { silent: true, deferPolygons: true });
        clearTimeout(colorTimer);
        colorTimer = setTimeout(() => {
          rebuildMosaicFromSource();
        }, 140);
      }
    });
    dom.rangeColors.addEventListener('change', () => {
      const val = Number.parseInt(dom.rangeColors.value, 10);
      const prev = store.getState().config.colorCount;
      if (store.getState().hasManualEdits && val !== prev) {
        requestProtectedRebuild({
          description: `Cambiar la paleta K-Means a ${val} colores recalculará el mosaico y descartará los trazos manuales actuales.`,
          nextPatch: { colorCount: val },
          revertUI: () => {
            dom.rangeColors.value = prev;
            dom.valColorsCount.textContent = `${prev} colores`;
          },
        });
      } else if (!store.getState().hasManualEdits && val !== prev) {
        clearTimeout(colorTimer);
        store.updateConfig({ colorCount: val }, { silent: true, deferPolygons: true });
        rebuildMosaicFromSource();
      }
    });

    // Espacio cromático y Dithering (protegido)
    dom.selectColorSpace?.addEventListener('change', () => {
      const val = dom.selectColorSpace.value;
      const prev = store.getState().config.colorSpace || 'cielab';
      if (val === prev) return;
      requestProtectedRebuild({
        description: 'Cambiar el espacio cromático recalculará la cuantización del mosaico y descartará los trazos manuales.',
        nextPatch: { colorSpace: val },
        revertUI: () => {
          dom.selectColorSpace.value = prev;
        },
      });
    });

    dom.selectDitherMode?.addEventListener('change', () => {
      const val = dom.selectDitherMode.value;
      const prev = store.getState().config.ditherMode || 'none';
      if (val === prev) return;
      requestProtectedRebuild({
        description: 'Cambiar el método de dithering recalculará el mosaico y descartará los trazos manuales.',
        nextPatch: { ditherMode: val },
        revertUI: () => {
          dom.selectDitherMode.value = prev;
        },
      });
    });

    let ditherTimer = null;
    dom.rangeDitherStrength?.addEventListener('input', () => {
      const pct = Number.parseInt(dom.rangeDitherStrength.value, 10);
      const val = clamp(pct / 100, 0, 1);
      if (dom.valDitherStrength) dom.valDitherStrength.textContent = `${pct}%`;
      if (!store.getState().hasManualEdits) {
        store.updateConfig({ ditherStrength: val }, { silent: true, deferPolygons: true });
        clearTimeout(ditherTimer);
        ditherTimer = setTimeout(() => {
          rebuildMosaicFromSource();
        }, 140);
      }
    });
    dom.rangeDitherStrength?.addEventListener('change', () => {
      const pct = Number.parseInt(dom.rangeDitherStrength.value, 10);
      const val = clamp(pct / 100, 0, 1);
      const prev = store.getState().config.ditherStrength ?? 0.65;
      if (store.getState().hasManualEdits && Math.abs(val - prev) > 1e-4) {
        const prevPct = Math.round(prev * 100);
        requestProtectedRebuild({
          description: `Cambiar la fuerza de dithering a ${pct}% recalculará el mosaico y descartará los trazos manuales.`,
          nextPatch: { ditherStrength: val },
          revertUI: () => {
            dom.rangeDitherStrength.value = prevPct;
            if (dom.valDitherStrength) dom.valDitherStrength.textContent = `${prevPct}%`;
          },
        });
      } else if (!store.getState().hasManualEdits && Math.abs(val - prev) > 1e-4) {
        clearTimeout(ditherTimer);
        store.updateConfig({ ditherStrength: val }, { silent: true, deferPolygons: true });
        rebuildMosaicFromSource();
      }
    });

    // Junta / Pastina (NO borra ediciones; vista previa rápida durante drag en >2500 celdas)
    function setGroutColor(hex) {
      dom.inputGroutColor.value = hex;
      dom.groutPresets.forEach((b) => {
        b.classList.toggle('is-active', b.dataset.grout.toLowerCase() === hex.toLowerCase());
      });
      store.updateConfig({ groutColor: hex }, { deferPolygons: true });
      renderer.invalidateCache();
      renderer.scheduleRender();
    }
    dom.groutPresets.forEach((btn) => btn.addEventListener('click', () => setGroutColor(btn.dataset.grout)));
    dom.inputGroutColor.addEventListener('input', () => setGroutColor(dom.inputGroutColor.value));

    dom.rangeGroutMm.addEventListener('input', () => {
      const v = Number.parseFloat(dom.rangeGroutMm.value);
      dom.valGroutMm.textContent = `${v.toFixed(1)} mm`;
      store.getState().isInteractiveDragging = true;
      store.updateConfig({ groutMm: v }, { silent: true, deferPolygons: true });
      renderer.invalidateCache();
      renderer.scheduleRender();
    });
    dom.rangeGroutMm.addEventListener('change', () => {
      const v = Number.parseFloat(dom.rangeGroutMm.value);
      dom.valGroutMm.textContent = `${v.toFixed(1)} mm`;
      store.getState().isInteractiveDragging = false;
      store.updateConfig({ groutMm: v }, { deferPolygons: true });
      renderer.invalidateCache();
      renderer.scheduleRender();
    });

    // Acabado superficial (NO borra ediciones)
    dom.selectTileFinish?.addEventListener('change', () => {
      store.updateConfig({ finish: dom.selectTileFinish.value });
      renderer.invalidateCache();
      renderer.scheduleRender();
    });

    // Modos de visualización & Breakdown (NO borra ediciones)
    function applyViewMode(vmode) {
      dom.vmodeBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.vmode === vmode));
      if (dom.btnVmodeBreakdown) {
        dom.btnVmodeBreakdown.classList.toggle('is-active', vmode === 'breakdown');
      }
      const patch = { viewMode: vmode };
      if (vmode === 'breakdown') {
        patch.breakdownColorIdx = store.getState().activeColorIdx;
      }
      store.updateConfig(patch);
      syncBreakdownHint(store.getState());
      renderPalette();
      renderer.invalidateCache();
      renderer.scheduleRender();
    }

    let breakdownBoundInList = false;
    dom.vmodeBtns.forEach((btn) => {
      if (btn === dom.btnVmodeBreakdown) breakdownBoundInList = true;
      btn.addEventListener('click', () => applyViewMode(btn.dataset.vmode));
    });
    if (dom.btnVmodeBreakdown && !breakdownBoundInList) {
      dom.btnVmodeBreakdown.addEventListener('click', () => applyViewMode('breakdown'));
    }

    dom.chkShowNumbers.addEventListener('change', () => {
      store.updateConfig({ showNumbers: dom.chkShowNumbers.checked });
      renderer.invalidateCache();
      renderer.scheduleRender();
    });

    // Botón explícito Recalcular desde imagen
    dom.btnRecalculateMosaic.addEventListener('click', () => {
      requestProtectedRebuild({
        description: '¿Deseas recalcular todo el mosaico desde la fuente actual y descartar tus ediciones manuales?',
        nextPatch: null,
        revertUI: () => {},
      });
    });

    // Modales de protección
    dom.btnProtectConfirm.addEventListener('click', () => closeProtectModal(true));
    dom.btnProtectCancel.addEventListener('click', () => closeProtectModal(false));

    // Toolbar herramientas
    dom.toolBtns.forEach((btn) => {
      btn.addEventListener('click', () => store.setTool(btn.dataset.tool));
    });
    dom.btnUndo.addEventListener('click', () => {
      if (store.undo()) showToast('Cambio deshecho', 'info');
    });
    dom.btnRedo.addEventListener('click', () => {
      if (store.redo()) showToast('Cambio rehecho', 'info');
    });
    dom.btnZoomIn.addEventListener('click', () => renderer.applyZoom(store.getState().zoom * 1.25));
    dom.btnZoomOut.addEventListener('click', () => renderer.applyZoom(store.getState().zoom / 1.25));
    dom.btnZoomFit.addEventListener('click', () => renderer.fitToView());

    // Eventos de puntero en Canvas
    dom.canvas.addEventListener('pointerdown', (e) => {
      if (dom.canvas.setPointerCapture) dom.canvas.setPointerCapture(e.pointerId);
      const state = store.getState();

      if (state.tool === 'pan' || e.button === 1) {
        isDraggingPan = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        panStartX = state.panX;
        panStartY = state.panY;
        dom.canvas.style.cursor = 'grabbing';
        return;
      }

      if (!state.config.mosaicMode || !state.grid) {
        showToast('Activa el Modo Mosaico para usar las herramientas de edición.', 'warn');
        return;
      }

      if (state.tool === 'brush') {
        isPainting = true;
        store.beginBrushStroke();
        handleBrushAt(e.clientX, e.clientY);
      } else if (state.tool === 'fill') {
        const { xCm, yCm } = renderer.screenToCm(e.clientX, e.clientY);
        const res = store.applyFloodFillAtCm(xCm, yCm);
        if (res.changedCount > 0) {
          showToast(`Bote: ${formatNumber(res.changedCount)} teselas rellenadas`, 'success');
        }
      } else if (state.tool === 'replace') {
        const { xCm, yCm } = renderer.screenToCm(e.clientX, e.clientY);
        const res = store.applyReplaceGlobalAtCm(xCm, yCm);
        if (res.changedCount > 0) {
          showToast(
            `Reemplazo global: Color #${res.fromColorIdx + 1} → #${res.toColorIdx + 1} (${formatNumber(res.changedCount)} teselas)`,
            'success'
          );
        }
      } else if (state.tool === 'eyedropper') {
        const { xCm, yCm } = renderer.screenToCm(e.clientX, e.clientY);
        const picked = store.pickColorAtCm(xCm, yCm);
        if (picked) {
          renderPalette();
          if (store.getState().config.viewMode === 'breakdown') {
            renderer.invalidateCache();
            renderer.scheduleRender();
          }
          store.setTool('brush');
          showToast(`Color #${picked.pickedIdx + 1} (${picked.color.hex}) capturado · Pincel listo`, 'info');
        }
      }
    });

    dom.canvas.addEventListener('pointermove', (e) => {
      updateCursorInfo(e.clientX, e.clientY);
      const state = store.getState();

      if (isDraggingPan) {
        state.panX = panStartX + (e.clientX - dragStartX);
        state.panY = panStartY + (e.clientY - dragStartY);
        renderer.scheduleRender();
      } else if (isPainting) {
        handleBrushAt(e.clientX, e.clientY);
      }
    });

    const endPointer = () => {
      isDraggingPan = false;
      if (isPainting) {
        isPainting = false;
        store.endBrushStroke();
      }
      updateCanvasCursor();
    };
    dom.canvas.addEventListener('pointerup', endPointer);
    dom.canvas.addEventListener('pointercancel', endPointer);
    dom.canvas.addEventListener('pointerleave', () => {
      dom.cursorInfo.classList.add('hidden');
    });

    dom.viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        renderer.applyZoom(store.getState().zoom * factor, e.clientX, e.clientY);
      },
      { passive: false }
    );

    // Exportación PDF Modal
    dom.btnExportPdf.addEventListener('click', openPdfExportModal);
    dom.btnPdfCancelExport.addEventListener('click', () => {
      if (!isExportingPdf) dom.pdfModal.classList.remove('is-open');
    });
    dom.btnPdfSelectAll.addEventListener('click', () => {
      selectedSheetsSet = new Set(store.getState().printSheets.map((s) => s.label));
      dom.pdfRangeInput.value = '';
      syncSheetChipsHighlight();
      updatePdfExportSummary();
    });
    dom.btnPdfClearAll.addEventListener('click', () => {
      selectedSheetsSet.clear();
      dom.pdfRangeInput.value = '';
      syncSheetChipsHighlight();
      updatePdfExportSummary();
    });
    dom.pdfRangeInput.addEventListener('input', () => {
      const m = store.getState().printMetrics;
      if (!m) return;
      const expr = dom.pdfRangeInput.value.trim();
      if (!expr) {
        selectedSheetsSet.clear();
      } else {
        const parsed = parseSheetRangeExpression(expr, m.Nx, m.Ny);
        selectedSheetsSet = new Set(parsed);
      }
      syncSheetChipsHighlight();
      updatePdfExportSummary();
    });
    dom.chkPdfIncludeCover.addEventListener('change', updatePdfExportSummary);
    dom.chkPdfIncludePalette.addEventListener('change', updatePdfExportSummary);
    dom.selectPdfSplitMode?.addEventListener('change', updatePdfExportSummary);
    dom.inputPdfSheetsPerFile?.addEventListener('input', updatePdfExportSummary);
    dom.inputPdfSheetsPerFile?.addEventListener('change', updatePdfExportSummary);
    dom.btnPdfConfirmExport.addEventListener('click', executePdfExport);

    // Atajos de teclado Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Escape
    win?.addEventListener('keydown', (e) => {
      const active = doc.activeElement;
      const isTextInput =
        active &&
        ((active.tagName === 'INPUT' && !['checkbox', 'range', 'button', 'color'].includes(active.type)) ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT');

      if (e.key === 'Escape') {
        if (dom.protectModal.classList.contains('is-open')) closeProtectModal(false);
        if (dom.deleteModal.classList.contains('is-open')) dom.deleteModal.classList.remove('is-open');
        if (!isExportingPdf && dom.pdfModal.classList.contains('is-open')) dom.pdfModal.classList.remove('is-open');
        if (arController.getState().isOpen) arController.close();
        return;
      }

      if (isTextInput) return;

      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (store.undo()) showToast('Cambio deshecho', 'info');
      } else if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (store.redo()) showToast('Cambio rehecho', 'info');
      }
    });

    win?.addEventListener('resize', () => renderer.resize());
  }

  async function init() {
    bindEvents();
    renderer.resize();
    await fetchProjectsList();
    await loadSampleIllustration({ resetDims: true, silentToast: true });
    store.setTool('pan');
  }

  return {
    init,
    bindEvents,
    loadSampleIllustration,
    rebuildMosaicFromSource,
    syncAllUI,
    openPdfExportModal,
    arController,
  };
}
