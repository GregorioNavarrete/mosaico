# GuíaMosaico

Plataforma MVC en **Node.js + Express + HTML5 (EJS) + CSS modular offline + JavaScript (ES Modules)** para transformar imágenes digitales en plantillas físicas a escala real (**1:1**), diseño profesional de mosaicos y *Trencadís*, cálculo de materiales (BOM) y transferencia visual en pared.

## Arranque rápido

```bash
npm install
npm start
```

El servidor Express inicia por defecto en `http://localhost:3000`.

## Validación y QA

```bash
npm test       # Pruebas unitarias y de API (node:test)
npm run qa:all # Compuerta completa: estructura MVC + matemática 1:1 + patrones + QA gate + tests
```

## Estructura MVC

* `src/shared/`: Motor matemático, colorimétrico y geométrico puro (compartido entre Node.js y navegador).
* `src/models/`: Persistencia local atómica en JSON (`data/*.json`).
* `src/controllers/`: Controladores de vistas y API REST.
* `src/services/` y `src/middlewares/`: Seguridad de archivos OWASP, PDF 1:1 vectorial, SVG/DXF y Worker Threads.
* `src/views/` y `public/`: Plantillas EJS, Design System CSS offline y controladores JS modulares.
* `skills/`: Skills operativos del proyecto con validadores deterministas.
