import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { JsonStore } from '../models/jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const UPLOADS_DIR = path.join(ROOT_DIR, 'storage/uploads');
const UPLOADS_META_FILE = path.join(UPLOADS_DIR, '_meta.json');
const MAX_WIDTH_PX = 12000;
const MAX_HEIGHT_PX = 12000;
const UUID_V4_OR_GENERAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uploadMetaStore = new JsonStore(UPLOADS_META_FILE, {});

export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   * @param {string} [code]
   */
  constructor(statusCode, message, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

/**
 * Valida la firma binaria real (magic bytes) contra JPEG, PNG y WebP.
 * Rechaza cualquier spoofing como un archivo .txt renombrado a .png.
 *
 * @param {Buffer} buffer
 * @returns {'jpeg' | 'png' | 'webp' | null}
 */
export function detectImageMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // WebP: "RIFF" (0..3) + "WEBP" (8..11)
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

/**
 * Valida estrictamente un UUID para prevenir Path Traversal o inyección de rutas.
 *
 * @param {string} imageId
 * @returns {string}
 */
export function assertValidImageUuid(imageId) {
  if (typeof imageId !== 'string' || !UUID_V4_OR_GENERAL_RE.test(imageId.trim())) {
    throw new HttpError(400, 'Identificador de imagen inválido. Debe ser un UUID válido.', 'INVALID_IMAGE_ID');
  }
  return imageId.trim().toLowerCase();
}

function sanitizeOriginalName(originalName) {
  const base = path.basename(String(originalName || 'imagen.png')).replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_').trim();
  return (base || 'imagen.png').slice(0, 180);
}

function getImageFilePath(validId) {
  const resolved = path.resolve(UPLOADS_DIR, `${validId}.png`);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) {
    throw new HttpError(400, 'Ruta de imagen fuera del directorio permitido.', 'INVALID_IMAGE_PATH');
  }
  return resolved;
}

/**
 * Valida magic bytes, límites de píxeles/dimensiones anti-decompression-bomb,
 * re-codifica a PNG limpio sin EXIF/XMP y persiste con UUID en storage/uploads/.
 *
 * @param {Buffer} buffer
 * @param {string} [originalName='imagen.png']
 * @returns {Promise<{ id: string, originalName: string, width: number, height: number, mimeType: 'image/png', sizeBytes: number, createdAt: string }>}
 */
export async function processAndStoreImage(buffer, originalName = 'imagen.png') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'El archivo de imagen está vacío o es inválido.', 'EMPTY_FILE');
  }

  const detectedFormat = detectImageMagicBytes(buffer);
  if (!detectedFormat) {
    throw new HttpError(
      400,
      'Firma binaria inválida (magic bytes). Solo se permiten imágenes reales JPEG, PNG o WebP.',
      'INVALID_MAGIC_BYTES'
    );
  }

  const limitInputPixels = Number(process.env.MAX_IMAGE_PIXELS || 40000000);
  const safePixelLimit = Number.isFinite(limitInputPixels) && limitInputPixels > 0 ? limitInputPixels : 40000000;

  let metadata;
  try {
    const inspector = sharp(buffer, { limitInputPixels: safePixelLimit, failOn: 'error' });
    metadata = await inspector.metadata();
  } catch (err) {
    throw new HttpError(
      400,
      `La imagen no pudo decodificarse de forma segura o excede el límite de píxeles (${safePixelLimit}): ${err.message}`,
      'INVALID_IMAGE_DECODE'
    );
  }

  if (!metadata || !Number.isFinite(metadata.width) || !Number.isFinite(metadata.height)) {
    throw new HttpError(400, 'No se pudieron determinar las dimensiones de la imagen.', 'INVALID_IMAGE_DIMENSIONS');
  }

  // Considerar orientación EXIF 5..8 que intercambia ancho/alto al rotar
  const swapsAxes = Number(metadata.orientation) >= 5 && Number(metadata.orientation) <= 8;
  const effectiveW = swapsAxes ? metadata.height : metadata.width;
  const effectiveH = swapsAxes ? metadata.width : metadata.height;

  if (
    metadata.width <= 0 ||
    metadata.height <= 0 ||
    metadata.width > MAX_WIDTH_PX ||
    metadata.height > MAX_HEIGHT_PX ||
    effectiveW > MAX_WIDTH_PX ||
    effectiveH > MAX_HEIGHT_PX
  ) {
    throw new HttpError(
      400,
      `Dimensiones máximas excedidas (${effectiveW}x${effectiveH} px). El límite permitido es ${MAX_WIDTH_PX}x${MAX_HEIGHT_PX} px.`,
      'IMAGE_DIMENSIONS_EXCEEDED'
    );
  }

  if (metadata.width * metadata.height > safePixelLimit) {
    throw new HttpError(
      400,
      `La resolución total (${metadata.width * metadata.height} px) excede el límite seguro (${safePixelLimit} px).`,
      'IMAGE_PIXELS_EXCEEDED'
    );
  }

  const id = crypto.randomUUID().toLowerCase();
  const safeName = sanitizeOriginalName(originalName);
  const destPath = getImageFilePath(id);
  const tmpPath = `${destPath}.${process.pid}.${Date.now()}.tmp`;

  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  let sanitizedBuffer;
  let outInfo;
  try {
    const result = await sharp(buffer, { limitInputPixels: safePixelLimit, failOn: 'error' })
      .rotate()
      .png({ compressionLevel: 6 })
      .toBuffer({ resolveWithObject: true });

    sanitizedBuffer = result.data;
    outInfo = result.info;

    if (outInfo.width > MAX_WIDTH_PX || outInfo.height > MAX_HEIGHT_PX) {
      throw new HttpError(
        400,
        `Dimensiones procesadas fuera de límite (${outInfo.width}x${outInfo.height} px).`,
        'IMAGE_DIMENSIONS_EXCEEDED'
      );
    }

    await fs.writeFile(tmpPath, sanitizedBuffer);
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      400,
      `Error al sanitizar y re-codificar la imagen: ${err.message}`,
      'IMAGE_SANITIZE_FAILED'
    );
  }

  const record = {
    id,
    originalName: safeName,
    width: outInfo.width,
    height: outInfo.height,
    mimeType: 'image/png',
    sizeBytes: sanitizedBuffer.length,
    createdAt: new Date().toISOString(),
  };

  await uploadMetaStore.update((metaMap) => {
    const next = metaMap && typeof metaMap === 'object' && !Array.isArray(metaMap) ? { ...metaMap } : {};
    next[id] = record;
    return next;
  });

  return record;
}

/**
 * Lee el buffer PNG sanitizado de `storage/uploads/<uuid>.png`.
 * Valida estrictamente el UUID contra path traversal.
 * Retorna null si no existe en disco (o lanza 400 si el UUID es inválido).
 *
 * @param {string} imageId
 * @returns {Promise<Buffer | null>}
 */
export async function readUploadedImageBuffer(imageId) {
  const validId = assertValidImageUuid(imageId);
  const filePath = getImageFilePath(validId);
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Obtiene metadatos de una imagen subida en `storage/uploads/`.
 * Si existe el archivo PNG en disco aunque no esté en `_meta.json`, reconstruye dimensiones con sharp.
 *
 * @param {string} imageId
 * @returns {Promise<{ id: string, originalName: string, width: number, height: number, mimeType: 'image/png', sizeBytes: number, createdAt: string } | null>}
 */
export async function getUploadedImageMeta(imageId) {
  const validId = assertValidImageUuid(imageId);
  const filePath = getImageFilePath(validId);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const metaMap = await uploadMetaStore.read().catch(() => ({}));
  if (metaMap && typeof metaMap === 'object' && metaMap[validId]) {
    return metaMap[validId];
  }

  const fileBuffer = await fs.readFile(filePath);
  const info = await sharp(fileBuffer).metadata();
  return {
    id: validId,
    originalName: `${validId}.png`,
    width: info.width || 0,
    height: info.height || 0,
    mimeType: 'image/png',
    sizeBytes: stat.size,
    createdAt: stat.birthtime.toISOString(),
  };
}

/**
 * Elimina de forma atómica una imagen subida y su metadato asociado.
 *
 * @param {string} imageId
 * @returns {Promise<boolean>}
 */
export async function deleteUploadedImage(imageId) {
  const validId = assertValidImageUuid(imageId);
  const filePath = getImageFilePath(validId);
  await fs.rm(filePath, { force: true }).catch(() => {});

  let existed = false;
  await uploadMetaStore.update((metaMap) => {
    if (!metaMap || typeof metaMap !== 'object' || Array.isArray(metaMap)) return {};
    if (validId in metaMap) {
      existed = true;
      const next = { ...metaMap };
      delete next[validId];
      return next;
    }
    return metaMap;
  });
  return existed;
}

