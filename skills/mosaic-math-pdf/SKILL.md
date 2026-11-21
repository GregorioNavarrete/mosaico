---
name: mosaic-math-pdf
description: Calcula y valida determinísticamente las matemáticas mejoradas de GuíaMosaico (1 cm = 28.3464567 pt, cuadrícula multipapel A4/A3/Carta/Legal, área/perímetro poligonal Shoelace, pastina por perímetro real y ΔE00 CIEDE2000). Úsalo siempre en src/shared/, pdfService.js o bomEngine.js. No lo uses para estilos CSS.
---
# Mosaic Math & PDF Validator (Teoría Mejorada)

Delega las comprobaciones matemáticas exactas a `scripts/verify_mosaic_math.mjs` para validar las 6 mejoras teóricas del plan maestro sin gastar tokens en cálculo manual.

## Cuándo activar
- Al desarrollar o auditar `src/shared/printGrid.js`, `src/shared/colorLab.js`, `src/shared/bomEngine.js` o `src/services/pdfService.js`.

## Cuándo NO activar
- Cambios puramente visuales en `public/css/` o texto en vistas EJS.

## Pasos de ejecución
1. Ejecuta la batería determinista completa (incluye multipapel, equivalencia algebraica de pastina por perímetro real vs norma rectangular, Shoelace y Sharma 2005 $\Delta E_{00}$):
   ```bash
   node skills/mosaic-math-pdf/scripts/verify_mosaic_math.mjs --self-test
   ```
2. Para validar una configuración concreta en JSON:
   ```bash
   node skills/mosaic-math-pdf/scripts/verify_mosaic_math.mjs --input skills/mosaic-math-pdf/examples/sample_input.json
   ```
3. Exige tolerancia $< 0.001\text{ pt}$ en escala, $< 0.001$ en $\Delta E_{00}$ y concordancia exacta de pastina/juntas antes de pasar a `qa-verifier`.
