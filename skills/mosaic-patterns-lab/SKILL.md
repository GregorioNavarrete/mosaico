---
name: mosaic-patterns-lab
description: Diseña y valida el modelo geométrico unificado CellGeometry, los 8 patrones arquitectónicos de Fase 2 (Cuadrícula, Ladrillo 50/33%, Diamante 45°, Hexagonal, Espiga Herringbone, Basketweave, Escama y Penny Round), clipping Sutherland-Hodgman, colorimetría CIELAB/Dithering, mezclas por porcentaje y detector de cortes imposibles. Úsalo en src/shared/patterns.js, colorLab.js, mixtures.js y preprocess.js. No lo uses para rutas Express o estilos CSS.
---
# Mosaic Patterns & CIELAB Validator (Fase 2)

Asegura consistencia geométrica y física entre los patrones de mosaico, el Canvas y el futuro BOM.

## Cuándo activar
- Al implementar o modificar `src/shared/patterns.js`, `src/shared/colorLab.js`, `src/shared/mixtures.js`, `src/shared/preprocess.js` o `public/js/render/`.

## Reglas obligatorias
1. **Abstracción `CellGeometry` única:** Toda tesela (cuadrada, ladrillo, hexagonal, espiga, escama o polígono) devuelve `{ id, polygonCm, areaCm2, perimeterCm, centroidCm, nominalAreaCm2, cutRatio, isCut, orientationDeg, paletteId, flags }`.
2. **Clipping obligatorio:** Todas las celdas de cualquier patrón deben recortarse al rectángulo $[0, W]\times[0, H]$ con Sutherland-Hodgman antes de calcular `areaCm2`, `perimeterCm` y `isCut`.
3. **Detección de cortes:** Marca `isCut = cutRatio < 0.95` para que el BOM cuente por separado piezas enteras vs cortadas y el detector de cortes imposibles alerte cuando `minWidthMm < 8` o `minAngleDeg < 25`.
4. **Verificación determinista:**
   ```bash
   node skills/mosaic-patterns-lab/scripts/verify_patterns_geometry.mjs --self-test
   ```

Consulta el contrato de ejemplo en `examples/sample_cell_geometry.json`.
