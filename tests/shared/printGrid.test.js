import test from 'node:test';
import assert from 'node:assert/strict';
import { PT_PER_CM } from '../../src/shared/contracts.js';
import {
  cmToPt,
  ptToCm,
  getPaperDimensionsCm,
  getRowLabel,
  parseSheetLabel,
  computePrintGrid,
  listPrintSheets,
  parseSheetRangeExpression,
} from '../../src/shared/printGrid.js';

test('cmToPt y ptToCm mantienen precisión física exacta 72 / 2.54', () => {
  const cal10 = cmToPt(10.0);
  assert.ok(Math.abs(cal10 - 10 * PT_PER_CM) < 1e-9);
  assert.ok(Math.abs(cal10 - 283.46456692913387) < 1e-6);
  assert.ok(Math.abs(ptToCm(cal10) - 10.0) < 1e-9);
});

test('getPaperDimensionsCm soporta A4, A3, LETTER, LEGAL y CUSTOM en ambas orientaciones', () => {
  assert.deepEqual(getPaperDimensionsCm('A4', 'portrait'), {
    pageW: 21.0,
    pageH: 29.7,
    paperFormat: 'A4',
    orientation: 'portrait',
  });
  assert.deepEqual(getPaperDimensionsCm('A4', 'landscape'), {
    pageW: 29.7,
    pageH: 21.0,
    paperFormat: 'A4',
    orientation: 'landscape',
  });
  assert.deepEqual(getPaperDimensionsCm('A3', 'portrait'), {
    pageW: 29.7,
    pageH: 42.0,
    paperFormat: 'A3',
    orientation: 'portrait',
  });
  assert.deepEqual(getPaperDimensionsCm('LETTER', 'portrait'), {
    pageW: 21.59,
    pageH: 27.94,
    paperFormat: 'LETTER',
    orientation: 'portrait',
  });
  assert.deepEqual(getPaperDimensionsCm('LEGAL', 'landscape'), {
    pageW: 35.56,
    pageH: 21.59,
    paperFormat: 'LEGAL',
    orientation: 'landscape',
  });
  assert.deepEqual(getPaperDimensionsCm('CUSTOM', 'portrait', 30, 40), {
    pageW: 30,
    pageH: 40,
    paperFormat: 'CUSTOM',
    orientation: 'portrait',
  });
  assert.deepEqual(getPaperDimensionsCm('CUSTOM', 'landscape', 30, 40), {
    pageW: 40,
    pageH: 30,
    paperFormat: 'CUSTOM',
    orientation: 'landscape',
  });
});

test('getRowLabel y parseSheetLabel manejan filas simples y multi-letra (Z -> AA)', () => {
  assert.equal(getRowLabel(0), 'A');
  assert.equal(getRowLabel(25), 'Z');
  assert.equal(getRowLabel(26), 'AA');
  assert.equal(getRowLabel(27), 'AB');

  assert.deepEqual(parseSheetLabel('a1'), { row: 0, col: 0, label: 'A1' });
  assert.deepEqual(parseSheetLabel('B3'), { row: 1, col: 2, label: 'B3' });
  assert.deepEqual(parseSheetLabel('AA12'), { row: 26, col: 11, label: 'AA12' });
  assert.equal(parseSheetLabel('A0'), null);
  assert.equal(parseSheetLabel('12A'), null);
  assert.equal(parseSheetLabel(''), null);
});

test('computePrintGrid calcula multipapel A4, A3, LETTER y caso borde mural menor a 1 hoja', () => {
  // Caso demo por defecto: 120x90 cm en A4 vertical, margen 1.0, overlap 0.5 -> 7x4 = 28 hojas
  const demo = computePrintGrid({
    widthCm: 120,
    heightCm: 90,
    paperFormat: 'A4',
    orientation: 'portrait',
    marginCm: 1.0,
    overlapCm: 0.5,
  });
  assert.equal(demo.Nx, 7);
  assert.equal(demo.Ny, 4);
  assert.equal(demo.totalPages, 28);
  assert.ok(Math.abs(demo.calibrationBar10CmPt - 283.464567) < 1e-4);

  // Caso verify_mosaic_math: 60x80 cm
  const a4 = computePrintGrid({ widthCm: 60, heightCm: 80, paperFormat: 'A4', marginCm: 1.0, overlapCm: 1.0 });
  const a3 = computePrintGrid({ widthCm: 60, heightCm: 80, paperFormat: 'A3', marginCm: 1.0, overlapCm: 1.0 });
  const letter = computePrintGrid({ widthCm: 60, heightCm: 80, paperFormat: 'LETTER', marginCm: 1.0, overlapCm: 0.5 });
  assert.equal(a4.totalPages, 12);
  assert.equal(a3.totalPages, 9);
  assert.equal(letter.totalPages, 16);

  // Caso borde: mural 10x10 cm menor a una hoja A4 (Ux=19, Uy=27.7) con solapamiento grande
  const small = computePrintGrid({
    widthCm: 10,
    heightCm: 10,
    paperFormat: 'A4',
    marginCm: 1.0,
    overlapCm: 5.0,
  });
  assert.equal(small.Nx, 1);
  assert.equal(small.Ny, 1);
  assert.equal(small.totalPages, 1);

  const sheetsSmall = listPrintSheets({
    widthCm: 10,
    heightCm: 10,
    paperFormat: 'A4',
    marginCm: 1.0,
    overlapCm: 5.0,
  });
  assert.equal(sheetsSmall.length, 1);
  assert.equal(sheetsSmall[0].label, 'A1');
  assert.equal(sheetsSmall[0].sliceWCm, 10);
  assert.equal(sheetsSmall[0].sliceHCm, 10);
});

test('computePrintGrid valida overlap < Math.min(Ux, Uy) y márgenes válidos', () => {
  assert.throws(
    () =>
      computePrintGrid({
        widthCm: 40,
        heightCm: 40,
        paperFormat: 'CUSTOM',
        customPaperWidthCm: 10,
        customPaperHeightCm: 10,
        marginCm: 2.0, // Ux = 6, Uy = 6
        overlapCm: 6.0, // overlap == Ux -> debe fallar
      }),
    /Solapamiento inválido/
  );
});

test('parseSheetRangeExpression soporta rangos rectangulares, listas e ignora inválidos', () => {
  const res1 = parseSheetRangeExpression('A1-B2, C3', 4, 4);
  assert.deepEqual(res1, ['A1', 'A2', 'B1', 'B2', 'C3']);

  // Orden inverso, duplicados y tokens fuera de rango / inválidos
  const res2 = parseSheetRangeExpression('B2-A1, B2, Z9, invalid, C1', 3, 3);
  assert.deepEqual(res2, ['A1', 'A2', 'B1', 'B2', 'C1']);

  assert.deepEqual(parseSheetRangeExpression('', 4, 4), []);
});
