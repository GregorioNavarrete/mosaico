import fs from 'node:fs';

export function polygonAreaAndPerimeter(poly) {
  const n = poly.length;
  if (n < 3) return { areaCm2: 0, perimeterCm: 0 };
  let area = 0;
  let perim = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
    perim += Math.hypot(x2 - x1, y2 - y1);
  }
  return { areaCm2: Math.abs(area) * 0.5, perimeterCm: perim };
}

/**
 * Recorte exacto Sutherland-Hodgman contra [0, W] x [0, H].
 */
export function clipPolygonToRect(poly, widthCm, heightCm) {
  const clipEdge = (pts, isInside, intersect) => {
    if (pts.length === 0) return [];
    const out = [];
    let prev = pts[pts.length - 1];
    let prevIn = isInside(prev);
    for (const curr of pts) {
      const currIn = isInside(curr);
      if (currIn) {
        if (!prevIn) out.push(intersect(prev, curr));
        out.push(curr);
      } else if (prevIn) {
        out.push(intersect(prev, curr));
      }
      prev = curr;
      prevIn = currIn;
    }
    return out;
  };

  let res = poly;
  res = clipEdge(res, (p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]);
  res = clipEdge(res, (p) => p[0] <= widthCm, (a, b) => [widthCm, a[1] + ((b[1] - a[1]) * (widthCm - a[0])) / (b[0] - a[0])]);
  res = clipEdge(res, (p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]);
  res = clipEdge(res, (p) => p[1] <= heightCm, (a, b) => [a[0] + ((b[0] - a[0]) * (heightCm - a[1])) / (b[1] - a[1]), heightCm]);
  return res;
}

export function evaluateCutViability(poly, minCutMm = 8, minAngleDeg = 25) {
  const { areaCm2, perimeterCm } = polygonAreaAndPerimeter(poly);
  if (areaCm2 <= 1e-6 || perimeterCm <= 1e-6) {
    return { unbuildable: true, minWidthMm: 0, minAngleDeg: 0 };
  }
  const minWidthMm = ((2 * areaCm2) / perimeterCm) * 10;
  let minAng = 180;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n];
    const p1 = poly[i];
    const p2 = poly[(i + 1) % n];
    const v1x = p0[0] - p1[0];
    const v1y = p0[1] - p1[1];
    const v2x = p2[0] - p1[0];
    const v2y = p2[1] - p1[1];
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (mag > 1e-9) {
      const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / mag));
      const deg = (Math.acos(cos) * 180) / Math.PI;
      if (deg < minAng) minAng = deg;
    }
  }
  return {
    unbuildable: minWidthMm < minCutMm || minAng < minAngleDeg,
    minWidthMm: Number(minWidthMm.toFixed(2)),
    minAngleDeg: Number(minAng.toFixed(2)),
  };
}

function generateBrick50Test(widthCm, heightCm, tileSizeCm) {
  const cols = Math.ceil(widthCm / tileSizeCm);
  const rows = Math.ceil(heightCm / tileSizeCm);
  const nominalArea = tileSizeCm * tileSizeCm;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 === 1 ? -tileSizeCm * 0.5 : 0;
    const rowCols = r % 2 === 1 ? cols + 1 : cols;
    for (let c = 0; c < rowCols; c++) {
      const x0 = offset + c * tileSizeCm;
      const y0 = r * tileSizeCm;
      const raw = [[x0, y0], [x0 + tileSizeCm, y0], [x0 + tileSizeCm, y0 + tileSizeCm], [x0, y0 + tileSizeCm]];
      const clipped = clipPolygonToRect(raw, widthCm, heightCm);
      const { areaCm2, perimeterCm } = polygonAreaAndPerimeter(clipped);
      if (areaCm2 <= 1e-6) continue;
      const cutRatio = areaCm2 / nominalArea;
      cells.push({
        polygonCm: clipped,
        areaCm2,
        perimeterCm,
        cutRatio,
        isCut: cutRatio < 0.95,
      });
    }
  }
  return cells;
}

function runSelfTest() {
  const checks = [];
  // 1. Brick 50% on 10x4 cm with 2 cm tile -> row0: 5 whole, row1: 4 whole + 2 half = 6 => total 11 cells, exact area 40 cm2
  const cells = generateBrick50Test(10, 4, 2);
  const totalArea = cells.reduce((s, c) => s + c.areaCm2, 0);
  const cutCount = cells.filter((c) => c.isCut).length;
  if (cells.length !== 11 || cutCount !== 2 || Math.abs(totalArea - 40) > 1e-6) {
    throw new Error(`Brick 50% tiling failed: count=${cells.length}, cuts=${cutCount}, area=${totalArea}`);
  }
  checks.push({ test: 'brick50_clipping_and_cut_detection', ok: true, totalCells: cells.length, cutCount, totalArea });

  // 2. Impossible cut detection (narrow sliver 0.3 x 2.0 cm -> minWidthMm ~ 2.61 mm < 8 mm)
  const sliver = evaluateCutViability([[0, 0], [0.3, 0], [0.3, 2.0], [0, 2.0]]);
  if (!sliver.unbuildable) {
    throw new Error(`Impossible-cut detector failed to flag sliver: ${JSON.stringify(sliver)}`);
  }
  checks.push({ test: 'impossible_cut_detector', ok: true, ...sliver });

  // 3. Valid 2x2 cm tile viability (minWidthMm = 10 mm, minAngle = 90 deg)
  const whole = evaluateCutViability([[0, 0], [2, 0], [2, 2], [0, 2]]);
  if (whole.unbuildable) {
    throw new Error(`Valid 2x2 tile falsely flagged: ${JSON.stringify(whole)}`);
  }
  checks.push({ test: 'valid_tile_viability', ok: true, ...whole });

  console.log(JSON.stringify({ status: 'PASS', checks }, null, 2));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test') || args.length === 0) {
    runSelfTest();
    return;
  }
  const idx = args.indexOf('--input');
  if (idx !== -1 && args[idx + 1]) {
    const cells = JSON.parse(fs.readFileSync(args[idx + 1], 'utf8'));
    const flagged = cells.filter((c) => evaluateCutViability(c.polygonCm).unbuildable).length;
    console.log(JSON.stringify({ status: 'OK', cellCount: cells.length, unbuildableCount: flagged }, null, 2));
    return;
  }
  console.error('Usage: verify_patterns_geometry.mjs [--self-test | --input <cells.json>]');
  process.exit(2);
}

main();
