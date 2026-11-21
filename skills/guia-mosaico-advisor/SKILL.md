---
name: guia-mosaico-advisor
description: Activa el Modo Asesor Proactivo, asignación eficiente de modelos (pro/inherit/flash), fronteras disjuntas MVC (Express + EJS + JS + JSON), criterios paralelo vs /boost y la compuerta obligatoria de Prueba de Uso y autorización entre fases para GuíaMosaico. Úsalo al planificar o iniciar cualquier tarea media/alta del proyecto. No lo uses para consultas triviales de una línea.
---
# GuíaMosaico Advisor (Modo Asesor Proactivo · MVC Node.js/Express)

Sigue este protocolo obligatorio antes de iniciar tareas de complejidad media o alta en **GuíaMosaico**.

## Cuándo activar
- Al iniciar cualquiera de las 6 Fases (F1–F6) o un módulo MVC nuevo (`src/shared/`, `src/models/`, `src/controllers/`, `src/services/`, `src/views/`, `public/`).
- Cuando debas decidir entre ejecución paralela controlada vs `/boost` secuencial.

## Cuándo NO activar
- Correcciones tipográficas triviales o consultas simples de una línea.

## Protocolo en 4 pasos
1. **Diagnóstico rápido:** Clasifica como *paralelizable* (fronteras MVC disjuntas + `src/shared/contracts.js` congelado), *secuencial crítica* (`/boost`: PDF 1:1 vectorial, CIELAB $\Delta E_{00}$, 8 patrones geométricos, Voronoi/Lloyd, *Opus Vermiculatum*, Homografía DLT, OWASP) o *ambigua* (`/grill-me`).
2. **Opciones de ejecución (2 a 3):** Opción Recomendada vs alternativa rápida o conservadora.
3. **Asignación de agentes, modelos y fronteras:**
   - **`pro`**: `gm-planner` (contratos), `gm-geom-pdf` (algoritmos duros), `gm-cv-ar` (homografía DLT / escáner), `gm-backend-sec` (OWASP / workers $> 5\text{ m}$).
   - **`inherit`**: `gm-bom-estimator`, `gm-canvas-ux` (Canvas 2D / Web Workers / lógica cliente) y controladores CRUD.
   - **`flash`**: `research`, `gm-qa-verifier`, vistas EJS, CSS offline y pruebas de contrato.
   - En paralelo, usa siempre **`Workspace: "inherit"` + rutas disjuntas** definidas en `ANTIGRAVITY_PLAYBOOK.md`.
4. **Compuerta de Fase obligatoria (F1 → F6):**
   - Ejecuta `npm run qa:all` (`mosaic-mvc-express`, `mosaic-math-pdf`, `mosaic-patterns-lab`, `mosaic-qa-gate`, `npm test`).
   - Levanta `npm start`, realiza la **Prueba de Uso** real de la fase y **pide autorización al usuario** antes de pasar a la siguiente fase.

Consulta un ejemplo en `examples/advisor_response_example.md`.
