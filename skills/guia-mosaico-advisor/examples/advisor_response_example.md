# Ejemplo de Respuesta en Modo Asesor Proactivo (Arquitectura MVC)

**Solicitud:** "Implementa la Fase 1: subida segura OWASP, escala multipapel, editor mejorado y PDF 1:1 vectorial."

## 1. Diagnóstico rápido
Fase 1 combina un núcleo crítico secuencial (PDF 1:1 vectorial en `pdfService.js` + `printGrid.js`) y dos tracks paralelizables con rutas disjuntas (Backend OWASP/JSON vs Vistas EJS/CSS/Canvas).

## 2. Opciones de ejecución
- **Opción Recomendada:** `/boost` con `geom-pdf-agent` (`pro`) en `src/shared/printGrid.js` + `src/services/pdfService.js`, seguido de paralelo entre `backend-sec-agent` (`pro`, modelos/OWASP/controladores) y `canvas-ux-agent` (`inherit`/`flash`, vistas EJS/CSS/Canvas).
- **Alternativa conservadora:** Ejecutar todo secuencialmente con `/boost` en 3 rondas.

## 3. Fronteras y `[done]`
- `qa-verifier` (`flash`) ejecuta `npm run qa:all` y levanta `npm start` para la **Prueba de Uso Fase 1**, deteniéndose a pedir autorización para Fase 2.
