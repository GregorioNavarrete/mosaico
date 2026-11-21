import { createStudioStore } from '/public/js/state/studioStore.js';
import { createCanvasRenderer } from '/public/js/render/canvasRenderer.js';
import { createEditorController } from '/public/js/controllers/editorController.js';

function bootStudio() {
  const canvas = document.getElementById('studio-canvas');
  const viewport = document.getElementById('canvas-viewport');
  if (!canvas || !viewport) return;

  const store = createStudioStore();
  const renderer = createCanvasRenderer(canvas, viewport, store);
  const controller = createEditorController(store, renderer, document);

  controller.init();
}

window.addEventListener('DOMContentLoaded', bootStudio);
