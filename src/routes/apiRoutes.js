import { Router } from 'express';
import {
  ARCHITECTURAL_PATTERNS,
  COLOR_MODES,
  DITHER_MODES,
  GENERATION_MODES,
  MAX_PDF_PAGES_POSTER,
  PAPER_FORMATS,
  PATTERN_LABELS,
  PATTERN_TYPES,
  PDF_SPLIT_MODES,
  POSTER_FILTER_MODES,
  PREPROCESS_MODES,
  TILE_FINISHES,
  createDefaultConfig,
} from '../shared/contracts.js';
import { getAiAdapterStatus } from '../services/aiAdapter.js';
import { uploadSingleImageMiddleware } from '../middlewares/uploadSecurity.js';
import {
  uploadImageHandler,
  getUploadedImageHandler,
  listProjectsHandler,
  createProjectHandler,
  getProjectHandler,
  updateProjectHandler,
  duplicateProjectHandler,
  deleteProjectHandler,
} from '../controllers/projectController.js';
import { exportPdfHandler } from '../controllers/exportController.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'guia-mosaico',
    architecture: 'MVC-Express-JSON',
    phase: 'fase-2',
    features: ['poster-contrast', 'split-pdf-zip', 'camera-ar-4pt'],
    timestamp: new Date().toISOString(),
  });
});

router.get('/meta/defaults', (req, res) => {
  res.json({
    defaultConfig: createDefaultConfig(),
    paperFormats: PAPER_FORMATS,
    patterns: PATTERN_TYPES,
    architecturalPatterns: ARCHITECTURAL_PATTERNS,
    patternLabels: PATTERN_LABELS,
    preprocessModes: PREPROCESS_MODES,
    colorModes: COLOR_MODES,
    ditherModes: DITHER_MODES,
    generationModes: GENERATION_MODES,
    tileFinishes: TILE_FINISHES,
    posterFilterModes: POSTER_FILTER_MODES,
    pdfSplitModes: PDF_SPLIT_MODES,
    maxPdfPagesPoster: MAX_PDF_PAGES_POSTER,
    aiStatus: getAiAdapterStatus(),
  });
});

// Subida y servicio privado sanitizado de imágenes (OWASP)
router.post('/uploads', uploadSingleImageMiddleware, uploadImageHandler);
router.get('/uploads/:imageId', getUploadedImageHandler);

// Persistencia de proyectos + snapshots RLE
router.get('/projects', listProjectsHandler);
router.post('/projects', createProjectHandler);
router.get('/projects/:id', getProjectHandler);
router.put('/projects/:id', updateProjectHandler);
router.post('/projects/:id/duplicate', duplicateProjectHandler);
router.delete('/projects/:id', deleteProjectHandler);

// Exportación PDF 1:1 vectorial/híbrida
router.post('/export/pdf', exportPdfHandler);

export default router;

