# Checklist OWASP para Subida de Imágenes (`imageSecurityService.js`)

1. **Magic Bytes (firma binaria):**
   - JPEG: bytes `[0xFF, 0xD8, 0xFF]`
   - PNG: bytes `[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]`
   - WebP: `"RIFF"` en offset 0..3 y `"WEBP"` en offset 8..11
2. **Anti Decompression Bomb:**
   - Límite de peso Multer (`MAX_UPLOAD_MB = 25`).
   - Configurar `sharp(buffer, { limitInputPixels: 40_000_000 })` y validar `metadata.width <= 12000 && metadata.height <= 12000`.
3. **Re-codificación Sanitaria:**
   - Procesar con `sharp(...).rotate().png({ compressionLevel: 6 }).toFile(...)` para eliminar perfiles EXIF/XMP potencialmente maliciosos.
4. **Aislamiento de Rutas:**
   - Guardar como `storage/uploads/<uuid>.png` y servir solo mediante endpoint controlador validado (`GET /api/projects/:id/image`) con `Content-Security-Policy` restrictivo.
