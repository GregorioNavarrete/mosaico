---
name: mosaic-qa-gate
description: Audita determinísticamente los Criterios de Aceptación de GuíaMosaico (precisión 10.0 cm ± 0.5 mm, integridad exacta BOM == Canvas, márgenes de desperdicio, rendimiento ≥ 30 fps a 10 000 teselas) y la compuerta de cierre de cada fase antes de pedir autorización. Úsalo como compuerta obligatoria en qa-verifier. No lo uses para redacción de documentos.
---
# Mosaic QA Gate (Compuerta Obligatoria de Fase)

Ejecuta las validaciones deterministas antes de que `qa-verifier` confirme `[done]` y antes de solicitar autorización al usuario para pasar de fase.

## Cuándo activar
- Al cerrar cualquiera de las Fases 1–6 o tras modificar `src/shared/`, `src/services/`, `src/models/` o `public/js/`.

## Pasos de ejecución
1. Ejecuta la suite completa del proyecto:
   ```bash
   npm run qa:all
   ```
2. Para validar un payload QA concreto exportado por la app o por un test:
   ```bash
   node skills/mosaic-qa-gate/scripts/check_bom_integrity.mjs --input <ruta/qa_payload.json>
   ```
3. Verifica que `npm start` levante limpiamente y responda HTTP 200 en `GET /api/health` y `GET /` antes de presentar la **Prueba de Uso** al usuario.
