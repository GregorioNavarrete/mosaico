# Antigravity Playbook Operativo — Proyecto GuíaMosaico (MVC Node.js/Express)

> **Propósito:** Regla operativa permanente de **GuíaMosaico** para garantizar calidad técnica, cero conflictos entre agentes, ahorro de tokens y cumplimiento estricto de las **Compuertas de Fase** (Prueba de Uso + Autorización del usuario).

---

## 0. Directiva Permanente: Modo Asesor Proactivo

Antes de ejecutar cualquier tarea nueva de complejidad media o alta:
1. **Diagnóstico rápido:** Determinar si es paralelizable (módulos MVC disjuntos), secuencial crítica (`/boost`) o ambigua (`/grill-me`).
2. **Opciones de ejecución (2 a 3):** Opción Recomendada vs rápida / conservadora.
3. **Asignación de agentes, modelos y fronteras:** Indicar rol, modelo (`pro` / `inherit` / `flash`), rutas exclusivas y criterio `[done]`.
4. **Compuerta de Fase:** Al finalizar cada fase (Fases 1 a 6), ejecutar `npm run qa:all`, levantar `npm start`, realizar la **Prueba de Uso**, y **detenerse a pedir autorización** antes de iniciar la fase siguiente.

---

## 1. Catálogo de Agentes, Modelos (Ahorro de Tokens) y Fronteras MVC

En este entorno VM remoto, los subagentes usan **`Workspace: "inherit"`**, por lo que la **Regla de Cero Conflictos** se garantiza mediante **propiedad disjunta estricta de rutas**:

| Agente | Modelo | Rutas Exclusivas de Escritura | Rutas Prohibidas | Responsabilidad |
| :--- | :--- | :--- | :--- | :--- |
| `gm-planner` | `pro` / `inherit` | Solo lectura (diseña `src/shared/contracts.js` vía orquestador) | Todo código fuente | Congela contratos, divide tareas y aplica `/compact` dirigido entre fases. |
| `research` (built-in) | `flash` | Solo lectura | Todo código fuente | Lectura de codebase/docs sin inflar el contexto principal. |
| `gm-geom-pdf` | `pro` (algoritmos) / `inherit` | `src/shared/printGrid.js`, `colorLab.js`, `patterns.js`, `mixtures.js`, `voronoiEngine.js`, `vermiculatumEngine.js`, `preprocess.js`, `src/services/pdfService.js`, `vectorExportService.js`, `tests/shared/` | `src/models/`, `src/controllers/`, `src/views/`, `public/`, `src/shared/bomEngine.js`, `src/shared/homography.js` | PDF 1:1 vectorial, CIELAB $\Delta E_{00}$, 8 patrones, Trencadís Voronoi/Lloyd, *Opus Vermiculatum*, SVG/DXF. |
| `gm-bom-estimator` | `inherit` | `src/shared/bomEngine.js`, `src/models/catalogModel.js`, `stockModel.js`, `src/controllers/catalogController.js`, `stockController.js`, `tests/bom/` | `src/shared/colorLab.js`, `patterns.js`, `src/views/`, `public/`, `src/services/pdfService.js` | BOM por perímetro real, 4 catálogos, Modo Mi Stock (*regret* $\Delta E_{00}$), CSV/monedas. |
| `gm-canvas-ux` | `inherit` (Canvas/Worker) / `flash` (CSS/EJS) | `src/views/`, `public/css/`, `public/js/state/`, `public/js/render/`, `public/js/workers/`, `public/js/controllers/` (excepto AR), `src/models/galleryModel.js`, `src/controllers/viewController.js`, `galleryController.js`, `tests/e2e/` | `src/shared/*`, `src/services/*`, `src/middlewares/*`, `src/models/projectModel.js` | Vistas EJS, Design System offline, Canvas $\ge 30\text{ fps}$, Web Worker, editor, galería. |
| `gm-cv-ar` | `pro` (DLT/escáner) / `inherit` (UI AR) | `src/shared/homography.js`, `public/js/controllers/cameraArController.js`, `progressScanner.js`, `src/views/projector.ejs`, `public/css/ar-camera.css`, `tests/cv/` | `src/models/`, `src/services/`, `src/shared/bomEngine.js`, `patterns.js` | Cámara, homografía DLT normalizada, Modo Strobe, Doodle Grid, Proyector y Escáner de Avance. |
| `gm-backend-sec` | `pro` (OWASP/workers) / `inherit` | `src/server.js`, `src/app.js`, `src/models/jsonStore.js`, `projectModel.js`, `src/middlewares/`, `src/services/imageSecurityService.js`, `aiAdapter.js`, `jobQueueService.js`, `src/workers/`, `src/controllers/projectController.js`, `exportController.js`, `jobController.js`, `src/routes/`, `tests/api/` | `public/`, `src/views/`, `src/shared/colorLab.js`, `patterns.js`, `bomEngine.js` | Express MVC, persistencia JSON atómica, OWASP File Upload, Worker Threads gran formato $> 5\text{ m}$. |
| `gm-qa-verifier` | `flash` | **PROHIBIDO EDITAR CÓDIGO** (solo lectura + `run_command`) | Todo archivo del proyecto | Verifica contratos, `npm run qa:all`, pruebas de uso y emite `[done]`. |

---

## 2. Skills del Proyecto (`skills/` y `~/.gemini/skills/`)

1. **`guia-mosaico-advisor`**: Protocolo de Modo Asesor Proactivo, asignación de modelos y compuertas de fase.
2. **`mosaic-mvc-express`**: Estándares MVC Express/EJS/JSON/OWASP + `scripts/verify_mvc_structure.mjs`.
3. **`mosaic-math-pdf`**: Matemáticas 1:1, multipapel, perímetro real, CIELAB $\Delta E_{00}$ + `scripts/verify_mosaic_math.mjs`.
4. **`mosaic-patterns-lab`**: 8 patrones geométricos, clipping Sutherland-Hodgman, mezclas y cortes imposibles + `scripts/verify_patterns_geometry.mjs`.
5. **`mosaic-qa-gate`**: Compuerta obligatoria de criterios de aceptación (§8) + `scripts/check_bom_integrity.mjs`.

---

## 3. Reglas de Ejecución: Paralelo vs `/boost`

* **Paralelo (`/swarm` lógico con `invoke_subagent`):** Úsalo cuando los contratos en `src/shared/contracts.js` estén congelados y los agentes tengan rutas disjuntas (ej. `backend-sec-agent` + `canvas-ux-agent` en F1; `bom-estimator-agent` + `canvas-ux-agent` en F4; 3 tracks en F6).
* **`/boost` (secuencial profundo):** Úsalo en algoritmos acoplados críticos: PDF 1:1 vectorial (`pdfService.js`), CIELAB/Bilateral/Patterns (`F2`), Voronoi/Lloyd + *Opus Vermiculatum* (`F3`), Homografía DLT + Escáner (`F5`) y Hardening OWASP.
* **Criterio único de ejecución local:** Todo debe arrancar con **`npm start`** y validarse con **`npm run qa:all`**.
