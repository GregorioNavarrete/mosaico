import multer from 'multer';
import { HttpError } from '../services/imageSecurityService.js';

function getMaxUploadBytes() {
  const mb = Number(process.env.MAX_UPLOAD_MB || 25);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : 25;
  return Math.floor(safeMb * 1024 * 1024);
}

const uploadInstance = multer({
  storage: multer.memoryStorage(),
  limits: () => ({
    fileSize: getMaxUploadBytes(),
    files: 1,
    parts: 10,
  }),
});

const singleImageMulter = uploadInstance.single('image');

/**
 * Middleware Express para recibir una única imagen en campo `'image'` en memoria
 * con límites OWASP (`MAX_UPLOAD_MB`, default 25 MB) y respuestas JSON limpias (400 / 413).
 */
export function uploadSingleImageMiddleware(req, res, next) {
  singleImageMulter(req, res, (err) => {
    if (err) {
      return uploadErrorHandler(err, req, res, next);
    }
    return next();
  });
}

/**
 * Manejador de errores de subida Multer / HttpError en formato JSON uniforme (`400` / `413`).
 */
export function uploadErrorHandler(err, req, res, next) {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Number(process.env.MAX_UPLOAD_MB || 25);
      return res.status(413).json({
        ok: false,
        error: `El archivo excede el tamaño máximo permitido (${maxMb} MB).`,
        code: err.code,
      });
    }

    return res.status(400).json({
      ok: false,
      error: `Error en la carga multipart (${err.code}): ${err.message}`,
      code: err.code,
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({
      ok: false,
      error: err.message,
      code: err.code,
    });
  }

  return next(err);
}
