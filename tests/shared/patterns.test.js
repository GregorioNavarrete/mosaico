import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHITECTURAL_PATTERNS } from '../../src/shared/contracts.js';
import {
  clipPolygonToRect,
  polygonAreaAndPerimeter,
  polygonCentroid,
  pointInPolygon,
  insetPolygon,
  mirrorPolygonCm,
  evaluateCutViability,
  generatePatternCells,
  buildSpatialCellIndex,
  findCellAtCm,
  getPolygonCellNeighbors,
  floodFillCells,
} from '../../src/shared/patterns.js';

test('clipPolygonToRect, polygonAreaAndPerimeter, polygonCentroid, pointInPolygon, insetPolygon y mirrorPolygonCm', () => {
  const poly = [
    [-1, -1],
    [3, -1],
    [3, 3],
    [-1, 3],
  ];
  const clipped = clipPolygonToRect(poly, 10, 10);
  const { areaCm2, perimeterCm } = polygonAreaAndPerimeter(clipped);
  assert.ok(Math.abs(areaCm2 - 9) < 1e-6);
  assert.ok(Math.abs(perimeterCm - 12) < 1e-6);

  const [cx, cy] = polygonCentroid(clipped);
  assert.ok(Math.abs(cx - 1.5) < 1e-6);
  assert.ok(Math.abs(cy - 1.5) < 1e-6);

  assert.equal(pointInPolygon(1.5, 1.5, clipped), true);
  assert.equal(pointInPolygon(3.5, 1.5, clipped), false);

  const inset = insetPolygon(
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ],
    0.1
  );
  const insetMetrics = polygonAreaAndPerimeter(inset);
  assert.ok(Math.abs(insetMetrics.areaCm2 - 1.8 * 1.8) < 1e-5);

  const mirrored = mirrorPolygonCm(
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ],
    10
  );
  const mCentroid = polygonCentroid(mirrored);
  assert.ok(Math.abs(mCentroid[0] - 9) < 1e-6);
  assert.ok(Math.abs(mCentroid[1] - 1) < 1e-6);
});

test('generatePatternCells cubre exactamente [0, W] x [0, H] sin huecos ni solapes en los 8 patrones poligonales', () => {
  const W = 12;
  const H = 10;
  const tileSizeCm = 2;
  const expectedArea = W * H;

  const tilingPatterns = ARCHITECTURAL_PATTERNS.filter((p) => p !== 'penny_round');
  assert.equal(tilingPatterns.length, 8);

  for (const pattern of tilingPatterns) {
    const cells = generatePatternCells({ widthCm: W, heightCm: H, tileSizeCm, pattern });
    assert.ok(cells.length > 0, `${pattern} debe generar celdas`);

    let areaSum = 0;
    for (const cell of cells) {
      assert.ok(cell.polygonCm.length >= 3);
      assert.ok(cell.areaCm2 > 0);
      assert.ok(cell.perimeterCm > 0);
      assert.equal(cell.isCut, cell.cutRatio < 0.95);
      assert.ok(cell.flags && typeof cell.flags.unbuildable === 'boolean');

      // Ningún vértice fuera de [0, W] x [0, H] tras Sutherland-Hodgman
      for (const [vx, vy] of cell.polygonCm) {
        assert.ok(vx >= -1e-6 && vx <= W + 1e-6, `${pattern}: x=${vx} fuera de [0,${W}]`);
        assert.ok(vy >= -1e-6 && vy <= H + 1e-6, `${pattern}: y=${vy} fuera de [0,${H}]`);
      }

      areaSum += cell.areaCm2;
    }

    assert.ok(
      Math.abs(areaSum - expectedArea) < 1e-3,
      `${pattern}: suma de áreas ${areaSum.toFixed(6)} !== ${expectedArea}`
    );
  }
});

test('penny_round genera shapeHint=circle, radiusCm y polígonos de 16 lados recortados en bordes', () => {
  const cells = generatePatternCells({
    widthCm: 10,
    heightCm: 8,
    tileSizeCm: 2,
    pattern: 'penny_round',
  });
  assert.ok(cells.length >= 15);
  const wholeCircles = cells.filter((c) => !c.isCut);
  assert.ok(wholeCircles.length > 0);
  for (const c of cells) {
    assert.equal(c.shapeHint, 'circle');
    assert.equal(c.radiusCm, 1);
  }
  assert.equal(wholeCircles[0].polygonCm.length, 16);
});

test('brick_33 aplica desplazamientos 0, -1/3, -2/3 y evaluateCutViability detecta cortes imposibles', () => {
  const cells = generatePatternCells({
    widthCm: 9,
    heightCm: 9,
    tileSizeCm: 3,
    pattern: 'brick_33',
  });
  const row0 = cells.filter((c) => c.row === 0);
  const row1 = cells.filter((c) => c.row === 1);
  const row2 = cells.filter((c) => c.row === 2);

  assert.equal(row0.length, 3);
  assert.equal(row1.length, 4); // [0..2], [2..5], [5..8], [8..9]
  assert.equal(row2.length, 4); // [0..1], [1..4], [4..7], [7..9]
  assert.ok(Math.abs(row1[0].areaCm2 - 6) < 1e-6);
  assert.ok(Math.abs(row2[0].areaCm2 - 3) < 1e-6);

  const sliver = evaluateCutViability([
    [0, 0],
    [0.3, 0],
    [0.3, 2],
    [0, 2],
  ]);
  assert.equal(sliver.unbuildable, true);
});

test('buildSpatialCellIndex, findCellAtCm, getPolygonCellNeighbors y floodFillCells funcionan sobre hexagonal y herringbone', () => {
  for (const pattern of ['hexagonal', 'herringbone']) {
    const W = 12;
    const H = 10;
    const cells = generatePatternCells({ widthCm: W, heightCm: H, tileSizeCm: 2, pattern });
    const index = buildSpatialCellIndex(cells, W, H);

    // Hit testing directo y en modo espejo
    const hitDirect = findCellAtCm(index, 6.0, 5.0, false, W);
    assert.ok(hitDirect, `${pattern}: debe encontrar celda en (6,5)`);
    assert.ok(pointInPolygon(6.0, 5.0, hitDirect.cell.polygonCm));

    const hitMirror = findCellAtCm(index, 2.0, 5.0, true, W);
    assert.ok(hitMirror);
    assert.ok(pointInPolygon(W - 2.0, 5.0, hitMirror.cell.polygonCm));

    // Adyacencia física y Flood Fill en cadena
    const adj = getPolygonCellNeighbors(cells, index);
    const startIdx = hitDirect.index;
    const startNeighbors = adj.get(startIdx);
    assert.ok(Array.isArray(startNeighbors) && startNeighbors.length >= 2);

    const grid = new Uint8Array(cells.length).fill(0);
    // Pintamos una isla conectada: celda inicial + un vecino directo + un vecino del vecino
    const nb1 = startNeighbors[0];
    const nb2 = (adj.get(nb1) || []).find((x) => x !== startIdx && !startNeighbors.includes(x)) ?? nb1;

    grid[startIdx] = 1;
    grid[nb1] = 1;
    grid[nb2] = 1;

    const { grid: filled, changedCount } = floodFillCells(cells, grid, cells[startIdx].id, 2, index);
    assert.equal(changedCount, nb2 === nb1 ? 2 : 3);
    assert.equal(filled[startIdx], 2);
    assert.equal(filled[nb1], 2);
    assert.equal(filled[nb2], 2);
    assert.equal(grid[startIdx], 1); // no muta entrada
  }
});
