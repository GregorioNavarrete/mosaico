import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import viewRoutes from './routes/viewRoutes.js';
import apiRoutes from './routes/apiRoutes.js';
import { HttpError } from './services/imageSecurityService.js';
import { uploadErrorHandler } from './middlewares/uploadSecurity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(
    helmet({
      contentSecurityPolicy: false, // Se ajustará por vista en Fase 1 al añadir Canvas/Workers/Media
    })
  );
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // Estáticos públicos y motor compartido offline
  app.use('/public', express.static(path.join(ROOT_DIR, 'public')));
  app.use('/shared', express.static(path.join(__dirname, 'shared')));
  app.use(
    '/vendor/fonts/dm-sans',
    express.static(path.join(ROOT_DIR, 'node_modules/@fontsource/dm-sans'))
  );
  app.use(
    '/vendor/fonts/dm-mono',
    express.static(path.join(ROOT_DIR, 'node_modules/@fontsource/dm-mono'))
  );
  app.use(
    '/vendor/fonts/manrope',
    express.static(path.join(ROOT_DIR, 'node_modules/@fontsource/manrope'))
  );

  // Rutas MVC
  app.use('/api', apiRoutes);
  app.get('/health', (req, res) => res.redirect(307, '/api/health'));
  app.use('/', viewRoutes);

  // Manejador global de errores JSON
  app.use(uploadErrorHandler);
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    if (err instanceof HttpError) {
      return res.status(err.statusCode).json({
        ok: false,
        error: err.message,
        code: err.code,
      });
    }

    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({
        ok: false,
        error: 'Cuerpo JSON malformado.',
        code: 'INVALID_JSON',
      });
    }

    if (err?.type === 'entity.too.large') {
      return res.status(413).json({
        ok: false,
        error: 'La carga JSON excede el límite máximo de 15 MB.',
        code: 'PAYLOAD_TOO_LARGE',
      });
    }

    const status = Number.isInteger(err?.statusCode)
      ? err.statusCode
      : Number.isInteger(err?.status)
      ? err.status
      : 500;

    return res.status(status).json({
      ok: false,
      error: status >= 500 ? 'Error interno del servidor.' : err?.message || 'Solicitud inválida.',
      code: err?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    });
  });

  return app;
}
