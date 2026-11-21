---
name: mosaic-mvc-express
description: Estandariza y valida la arquitectura MVC de GuíaMosaico en Node.js + Express + EJS + CSS offline + JS ES Modules + persistencia atómica en JSON (npm start) y seguridad OWASP File Upload. Úsalo siempre que diseñes o edites rutas, controladores, modelos JSON, middlewares de subida o vistas EJS en Fase 1 y Fase 2+. No lo uses para cálculos colorimétricos o poligonales.
---
# Mosaic MVC Express & OWASP Guard

Mantiene intacta la separación **Modelo / Vista / Controlador**, la ejecución offline con `npm start` y la seguridad OWASP de subida de archivos.

## Cuándo activar
- Al crear o modificar archivos en `src/app.js`, `src/server.js`, `src/models/`, `src/controllers/`, `src/routes/`, `src/middlewares/`, `src/services/imageSecurityService.js`, `src/views/` o `public/css/`.

## Cuándo NO activar
- Edición pura de fórmulas matemáticas o colorimétricas dentro de `src/shared/`.

## Reglas obligatorias
1. **Capa Modelo (`src/models/`):** Usa siempre `JsonStore` (`tmp -> rename` + cola serializada). Nunca hagas `fs.writeFile` directo sobre `data/*.json`.
2. **Capa Vista (`src/views/` + `public/`):** Prohibido usar CDNs externos (Tailwind CDN, Google Fonts CDN, unpkg) para el funcionamiento principal. Usa los CSS locales en `public/css/` y fuentes servidas desde `/vendor/fonts/*`.
3. **Seguridad OWASP (`src/middlewares/uploadSecurity.js` + `imageSecurityService.js`):**
   - Valida por *magic bytes* binarios (JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF...WEBP`), nunca solo por extensión.
   - Aplica límites de dimensiones y píxeles en `sharp` (`limitInputPixels`) contra *decompression bombs*.
   - Re-codifica las imágenes subidas y guárdalas con `crypto.randomUUID()` dentro de `storage/uploads/` (nunca expuesto como ruta estática pública).
4. **Verificación determinista:**
   ```bash
   node skills/mosaic-mvc-express/scripts/verify_mvc_structure.mjs
   ```

Consulta el checklist OWASP detallado en `examples/owasp_upload_checklist.md`.
