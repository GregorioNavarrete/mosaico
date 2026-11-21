import fs from 'node:fs';

const PT_PER_CM = 72 / 2.54;
const EXPECTED_10CM_PT = 10.0 * PT_PER_CM;
const TOLERANCE_05MM_PT = 0.05 * PT_PER_CM;

export function validateQaPayload(payload) {
  const errors = [];

  if (typeof payload.calibrationBar10CmPt !== 'number') {
    errors.push('Missing numeric field calibrationBar10CmPt.');
  } else {
    const diffPt = Math.abs(payload.calibrationBar10CmPt - EXPECTED_10CM_PT);
    if (diffPt > TOLERANCE_05MM_PT) {
      errors.push(
        `Calibration bar error: got ${payload.calibrationBar10CmPt} pt, expected ${EXPECTED_10CM_PT.toFixed(4)} pt ± ${TOLERANCE_05MM_PT.toFixed(4)} pt (0.5 mm).`
      );
    }
  }

  const canvasCounts = payload.canvasCountsByPaletteId || {};
  const bomItems = Array.isArray(payload.bomItems) ? payload.bomItems : [];
  const bomMap = new Map();

  for (const item of bomItems) {
    if (bomMap.has(item.paletteId)) {
      errors.push(`Duplicate paletteId ${item.paletteId} in bomItems.`);
      continue;
    }
    bomMap.set(item.paletteId, item);

    if (typeof item.wasteFactor !== 'number' || item.wasteFactor < 0.05 || item.wasteFactor > 0.20) {
      errors.push(`Palette ${item.paletteId}: wasteFactor (${item.wasteFactor}) must be within [0.05, 0.20].`);
    }
    const expectedTotal = Math.ceil(item.netTiles * (1 + item.wasteFactor));
    if (item.totalTilesWithWaste !== expectedTotal) {
      errors.push(
        `Palette ${item.paletteId}: totalTilesWithWaste (${item.totalTilesWithWaste}) !== ceil(${item.netTiles} * (1 + ${item.wasteFactor})) (${expectedTotal}).`
      );
    }
    if (typeof item.tilesPerBox === 'number' && item.tilesPerBox > 0) {
      const expectedBoxes = Math.ceil(item.totalTilesWithWaste / item.tilesPerBox);
      if (item.boxesNeeded !== expectedBoxes) {
        errors.push(
          `Palette ${item.paletteId}: boxesNeeded (${item.boxesNeeded}) !== ceil(${item.totalTilesWithWaste} / ${item.tilesPerBox}) (${expectedBoxes}).`
        );
      }
    }
  }

  for (const [idStr, canvasCount] of Object.entries(canvasCounts)) {
    const id = Number(idStr);
    const bom = bomMap.get(id);
    if (!bom) {
      errors.push(`Palette ${id} exists on Canvas (${canvasCount} tiles) but is missing in bomItems.`);
    } else if (bom.netTiles !== canvasCount) {
      errors.push(`Palette ${id} mismatch: Canvas=${canvasCount} !== BOM.netTiles=${bom.netTiles}.`);
    }
  }
  for (const id of bomMap.keys()) {
    if (!(String(id) in canvasCounts)) {
      errors.push(`Palette ${id} exists in bomItems but is missing in canvasCountsByPaletteId.`);
    }
  }

  if (payload.benchmark) {
    const { tileCount, fps } = payload.benchmark;
    if (typeof tileCount === 'number' && tileCount <= 10000 && typeof fps === 'number' && fps < 30) {
      errors.push(`Performance regression: ${fps} fps at ${tileCount} tiles (required >= 30 fps up to 10,000 tiles).`);
    }
  }

  return { passed: errors.length === 0, errors };
}

function runSelfTest() {
  const valid = {
    calibrationBar10CmPt: 283.464567,
    canvasCountsByPaletteId: { '1': 120, '2': 80 },
    bomItems: [
      { paletteId: 1, netTiles: 120, wasteFactor: 0.1, totalTilesWithWaste: 132, tilesPerBox: 50, boxesNeeded: 3 },
      { paletteId: 2, netTiles: 80, wasteFactor: 0.15, totalTilesWithWaste: 92, tilesPerBox: 50, boxesNeeded: 2 },
    ],
    benchmark: { tileCount: 10000, fps: 45 },
  };
  const r1 = validateQaPayload(valid);
  if (!r1.passed) throw new Error(`Valid payload failed: ${r1.errors.join('; ')}`);

  const invalid = {
    calibrationBar10CmPt: 270.0,
    canvasCountsByPaletteId: { '1': 120 },
    bomItems: [{ paletteId: 1, netTiles: 118, wasteFactor: 0.1, totalTilesWithWaste: 130 }],
    benchmark: { tileCount: 10000, fps: 22 },
  };
  const r2 = validateQaPayload(invalid);
  if (r2.passed || r2.errors.length < 3) {
    throw new Error(`Invalid payload test failed: ${JSON.stringify(r2)}`);
  }

  console.log(JSON.stringify({ status: 'PASS', checks: ['valid_payload_ok', 'invalid_payload_caught'] }, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test') || args.length === 0) {
    runSelfTest();
    return;
  }
  const idx = args.indexOf('--input');
  if (idx !== -1 && args[idx + 1]) {
    const payload = JSON.parse(fs.readFileSync(args[idx + 1], 'utf8'));
    const res = validateQaPayload(payload);
    console.log(JSON.stringify(res, null, 2));
    if (!res.passed) process.exit(1);
    return;
  }
  console.error('Usage: check_bom_integrity.mjs [--self-test | --input <qa_payload.json>]');
  process.exit(2);
}

main();
