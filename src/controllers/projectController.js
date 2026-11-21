import {
  HttpError,
  processAndStoreImage,
  readUploadedImageBuffer,
} from '../services/imageSecurityService.js';
import {
  createProject,
  deleteProject,
  duplicateProject,
  getProjectById,
  listProjects,
  updateProject,
  validateAndNormalizeMosaicConfig,
} from '../models/projectModel.js';

export async function uploadImageHandler(req, res, next) {
  try {
    if (!req.file || !req.file.buffer) {
      throw new HttpError(400, 'No se recibió ningún archivo en el campo "image".', 'MISSING_FILE');
    }

    const stored = await processAndStoreImage(req.file.buffer, req.file.originalname);

    return res.status(201).json({
      ok: true,
      image: {
        id: stored.id,
        originalName: stored.originalName,
        width: stored.width,
        height: stored.height,
        mimeType: 'image/png',
        url: `/api/uploads/${stored.id}`,
      },
    });
  } catch (err) {
    return next(err);
  }
}

export async function getUploadedImageHandler(req, res, next) {
  try {
    const { imageId } = req.params;
    const buffer = await readUploadedImageBuffer(imageId);

    if (!buffer) {
      return res.status(404).json({
        ok: false,
        error: 'Imagen no encontrada.',
        code: 'IMAGE_NOT_FOUND',
      });
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    return res.status(200).send(buffer);
  } catch (err) {
    return next(err);
  }
}

export async function listProjectsHandler(req, res, next) {
  try {
    const projects = await listProjects();
    return res.status(200).json({ ok: true, projects });
  } catch (err) {
    return next(err);
  }
}

export async function createProjectHandler(req, res, next) {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'El cuerpo del proyecto debe ser un objeto JSON válido.', 'INVALID_PAYLOAD');
    }
    const normalizedConfig = validateAndNormalizeMosaicConfig(body.config);
    const { project, snapshot } = await createProject({
      ...body,
      config: normalizedConfig,
    });
    return res.status(201).json({ ok: true, project, snapshot });
  } catch (err) {
    return next(err);
  }
}

export async function getProjectHandler(req, res, next) {
  try {
    const found = await getProjectById(req.params.id);
    if (!found) {
      return res.status(404).json({
        ok: false,
        error: 'Proyecto no encontrado.',
        code: 'PROJECT_NOT_FOUND',
      });
    }
    return res.status(200).json({ ok: true, project: found.project, snapshot: found.snapshot });
  } catch (err) {
    return next(err);
  }
}

export async function updateProjectHandler(req, res, next) {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'El cuerpo de actualización debe ser un objeto JSON válido.', 'INVALID_PAYLOAD');
    }
    if (body.config !== undefined && (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))) {
      throw new HttpError(400, 'El campo config debe ser un objeto JSON válido.', 'INVALID_CONFIG');
    }
    const updated = await updateProject(req.params.id, body);
    if (!updated) {
      return res.status(404).json({
        ok: false,
        error: 'Proyecto no encontrado.',
        code: 'PROJECT_NOT_FOUND',
      });
    }
    return res.status(200).json({ ok: true, project: updated.project, snapshot: updated.snapshot });
  } catch (err) {
    return next(err);
  }
}

export async function duplicateProjectHandler(req, res, next) {
  try {
    const customName = req.body && typeof req.body.name === 'string' ? req.body.name : undefined;
    const duplicated = await duplicateProject(req.params.id, customName);
    if (!duplicated) {
      return res.status(404).json({
        ok: false,
        error: 'Proyecto no encontrado.',
        code: 'PROJECT_NOT_FOUND',
      });
    }
    return res.status(201).json({ ok: true, project: duplicated.project, snapshot: duplicated.snapshot });
  } catch (err) {
    return next(err);
  }
}

export async function deleteProjectHandler(req, res, next) {
  try {
    const deleted = await deleteProject(req.params.id);
    if (!deleted) {
      return res.status(404).json({
        ok: false,
        error: 'Proyecto no encontrado.',
        code: 'PROJECT_NOT_FOUND',
      });
    }
    return res.status(200).json({ ok: true, deletedId: req.params.id.trim().toLowerCase() });
  } catch (err) {
    return next(err);
  }
}
