import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNUSED_CELL,
  rgbToHex,
  hexToRgb,
  getLuminance,
  colorDistSq,
  computeGridMetrics,
  getTileRectCm,
  cmToTileCoords,
  getBrickAwareNeighbors,
  floodFillGrid,
  replaceGlobalColor,
  recountPalette,
  encodeGridRle,
  decodeGridRle,
  runKMeansRedmean,
  getBuiltInSampleSvg,
} from '../../src/shared/mosaicCore.js';

test('Utilidades cromáticas rgbToHex, hexToRgb, getLuminance y colorDistSq funcionan con exactitud', () => {
  assert.equal(rgbToHex(54, 89, 77), '#36594D');
  assert.deepEqual(hexToRgb('#36594D'), { r: 54, g: 89, b: 77 });
  assert.deepEqual(hexToRgb('#fff'), { r: 255, g: 255, b: 255 });
  assert.ok(getLuminance(255, 255, 255) > 254);
  assert.equal(colorDistSq(100, 100, 100, 100, 100, 100), 0);
  assert.ok(colorDistSq(255, 0, 0, 0, 0, 255) > colorDistSq(255, 0, 0, 240, 10, 10));
});

test('cmToTileCoords mapea correctamente en modo directo y mirrorMode', () => {
  // Mural 10x4 cm con teselas 2 cm -> 5 columnas x 2 filas
  const metricsGrid = computeGridMetrics(10, 4, 2, 'grid');
  assert.equal(metricsGrid.tileCols, 5);
  assert.equal(metricsGrid.tileRows, 2);
  assert.equal(metricsGrid.totalTiles, 10);

  const grid = new Uint8Array(metricsGrid.tileRows * metricsGrid.maxRowCols).fill(0);

  // Directo: x=1.0 -> col 0; x=9.0 -> col 4
  assert.deepEqual(cmToTileCoords(1.0, 1.0, metricsGrid, { mirrorMode: false }, grid), { row: 0, col: 0, idx: 0 });
  assert.deepEqual(cmToTileCoords(9.0, 1.0, metricsGrid, { mirrorMode: false }, grid), { row: 0, col: 4, idx: 4 });

  // Espejo: x=1.0 físico corresponde a x_lógico = 10 - 1 = 9.0 -> col 4
  assert.deepEqual(cmToTileCoords(1.0, 1.0, metricsGrid, { mirrorMode: true }, grid), { row: 0, col: 4, idx: 4 });
  assert.deepEqual(cmToTileCoords(9.0, 3.0, metricsGrid, { mirrorMode: true }, grid), { row: 1, col: 0, idx: 5 });

  // Verificar getTileRectCm reflejado en mirrorMode sobre brick_50
  const metricsBrick = computeGridMetrics(10, 4, 2, 'brick_50');
  // Fila impar 1, col 0 cubre lógico [0, 1], en espejo cubre [9, 10]
  const rectMirrored = getTileRectCm(1, 0, metricsBrick, { mirrorMode: true });
  assert.ok(rectMirrored);
  assert.equal(rectMirrored.xCm, 9);
  assert.equal(rectMirrored.wCm, 1);
  assert.equal(rectMirrored.isCut, true);

  // En brick_50 con mirrorMode, hacer clic en x=9.5, y=3.0 debe mapear a (row=1, col=0)
  const hitBrickMirror = cmToTileCoords(9.5, 3.0, metricsBrick, { mirrorMode: true });
  assert.deepEqual(hitBrickMirror, { row: 1, col: 0, idx: metricsBrick.maxRowCols });
});

test('getBrickAwareNeighbors y floodFillGrid respetan adyacencia física exacta en brick_50', () => {
  // 10x6 cm con tesela 2 cm en brick_50 -> 3 filas, maxRowCols = 6
  // Fila 0 (par): cols 0..4 => [0..2], [2..4], [4..6], [6..8], [8..10]
  // Fila 1 (impar): cols 0..5 => [0..1], [1..3], [3..5], [5..7], [7..9], [9..10]
  // Fila 2 (par): cols 0..4
  const metrics = computeGridMetrics(10, 6, 2, 'brick_50');
  assert.equal(metrics.tileRows, 3);
  assert.equal(metrics.maxRowCols, 6);
  assert.equal(metrics.totalTiles, 16); // 5 + 6 + 5

  const grid = new Uint8Array(metrics.tileRows * metrics.maxRowCols).fill(UNUSED_CELL);
  for (let r = 0; r < metrics.tileRows; r++) {
    const cols = r % 2 === 1 ? metrics.tileCols + 1 : metrics.tileCols;
    for (let c = 0; c < cols; c++) {
      grid[r * metrics.maxRowCols + c] = 0;
    }
  }

  // Verificar vecinos de (row=1, col=2) que ocupa X=[3..5]:
  // En fila 0 debe tocar col 1 ([2..4]) y col 2 ([4..6]), NO col 3 ([6..8]).
  // En fila 1 toca col 1 y col 3. En fila 2 toca col 1 y col 2.
  const nbs = getBrickAwareNeighbors(1, 2, metrics, grid).map((n) => `${n.row},${n.col}`).sort();
  assert.deepEqual(nbs, ['0,1', '0,2', '1,1', '1,3', '2,1', '2,2']);

  // Configurar isla conectada diagonalmente en grilla rectangular pero conectada físicamente en brick_50:
  // (0,1) [2..4] toca físicamente a (1,2) [3..5] que toca a (2,2) [4..6]
  // Ponemos color 1 en (0,1), (1,2), (2,2) y dejamos el resto en color 0.
  grid[0 * metrics.maxRowCols + 1] = 1;
  grid[1 * metrics.maxRowCols + 2] = 1;
  grid[2 * metrics.maxRowCols + 2] = 1;

  // Agregamos una celda separada de color 1 en (0,4) que NO debe rellenarse
  grid[0 * metrics.maxRowCols + 4] = 1;

  const res = floodFillGrid(grid, 0, 1, 2, metrics, 'brick_50');
  assert.equal(res.changedCount, 3);
  assert.equal(res.grid[0 * metrics.maxRowCols + 1], 2);
  assert.equal(res.grid[1 * metrics.maxRowCols + 2], 2);
  assert.equal(res.grid[2 * metrics.maxRowCols + 2], 2);
  assert.equal(res.grid[0 * metrics.maxRowCols + 4], 1); // aislada intacta
  assert.equal(grid[0 * metrics.maxRowCols + 1], 1); // original sin mutar
});

test('floodFillGrid soporta murales grandes (200x200) sin desbordar pila gracias a BFS iterativo', () => {
  const metrics = computeGridMetrics(200, 200, 1, 'grid');
  const grid = new Uint8Array(metrics.tileRows * metrics.maxRowCols).fill(0);
  const res = floodFillGrid(grid, 0, 0, 3, metrics, 'grid');
  assert.equal(res.changedCount, 40000);
  assert.equal(res.grid[39999], 3);
});

test('replaceGlobalColor y recountPalette actualizan conteos exactamente sin mutar entrada', () => {
  const palette = [
    { r: 255, g: 0, b: 0, hex: '#FF0000', count: 3 },
    { r: 0, g: 255, b: 0, hex: '#00FF00', count: 2 },
    { r: 0, g: 0, b: 255, hex: '#0000FF', count: 1 },
  ];
  const grid = new Uint8Array([0, 0, 1, UNUSED_CELL, 0, 1, 2]);
  const { grid: replaced, changedCount } = replaceGlobalColor(grid, 0, 2);

  assert.equal(changedCount, 3);
  assert.equal(grid[0], 0); // inmutable

  const { palette: nextPalette, totalTiles } = recountPalette(replaced, palette);
  assert.equal(totalTiles, 6);
  assert.equal(nextPalette[0].count, 0);
  assert.equal(nextPalette[1].count, 2);
  assert.equal(nextPalette[2].count, 4);
});

test('encodeGridRle y decodeGridRle realizan round-trip sin pérdida incluyendo UNUSED_CELL=255', () => {
  const raw = new Uint8Array(1500);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = i % 17 === 0 ? UNUSED_CELL : (Math.floor(i / 13) % 12);
  }
  const rle = encodeGridRle(raw);
  assert.ok(rle.length < raw.length);
  const decoded = decodeGridRle(rle, raw.length);
  assert.deepEqual(decoded, raw);

  assert.throws(() => decodeGridRle(rle, raw.length + 1), /expectedLen/);
});

test('runKMeansRedmean y getBuiltInSampleSvg producen resultados deterministas y SVG válido 960x720', () => {
  const samples = [
    { r: 250, g: 10, b: 10 },
    { r: 245, g: 15, b: 12 },
    { r: 10, g: 20, b: 240 },
    { r: 12, g: 22, b: 235 },
  ];
  const { centroids, assignments } = runKMeansRedmean(samples, 2);
  assert.equal(centroids.length, 2);
  assert.equal(assignments.length, 4);
  assert.equal(assignments[0], assignments[1]);
  assert.equal(assignments[2], assignments[3]);
  assert.notEqual(assignments[0], assignments[2]);

  const svg = getBuiltInSampleSvg();
  assert.match(svg, /width="960"/);
  assert.match(svg, /height="720"/);
  assert.match(svg, /#c45b3e/);
});
