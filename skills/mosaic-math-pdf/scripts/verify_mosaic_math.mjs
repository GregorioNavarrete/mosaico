import fs from 'node:fs';

export const PT_PER_INCH = 72;
export const CM_PER_INCH = 2.54;
export const PT_PER_CM = PT_PER_INCH / CM_PER_INCH; // 28.346456692913385

export const PAPER_FORMATS = {
  A4: { shortCm: 21.0, longCm: 29.7 },
  A3: { shortCm: 29.7, longCm: 42.0 },
  LETTER: { shortCm: 21.59, longCm: 27.94 },
  LEGAL: { shortCm: 21.59, longCm: 35.56 },
};

export function cmToPt(cm) {
  if (!Number.isFinite(cm) || cm < 0) {
    throw new Error(`Invalid cm value: ${cm}`);
  }
  return cm * PT_PER_CM;
}

export function computePrintGrid({
  widthCm,
  heightCm,
  paperFormat = 'A4',
  orientation = 'portrait',
  paperWidthCm,
  paperHeightCm,
  marginCm = 1.0,
  overlapCm = 0.5,
}) {
  const fmt = PAPER_FORMATS[paperFormat] || PAPER_FORMATS.A4;
  const pW = paperWidthCm ?? (orientation === 'portrait' ? fmt.shortCm : fmt.longCm);
  const pH = paperHeightCm ?? (orientation === 'portrait' ? fmt.longCm : fmt.shortCm);

  const usableWidthCm = pW - 2 * marginCm;
  const usableHeightCm = pH - 2 * marginCm;
  if (usableWidthCm <= 0 || usableHeightCm <= 0) {
    throw new Error(`Invalid margins (${marginCm} cm) for paper ${pW}x${pH} cm.`);
  }
  if (overlapCm < 0 || overlapCm >= Math.min(usableWidthCm, usableHeightCm)) {
    throw new Error(`Invalid overlap (${overlapCm} cm) for usable ${usableWidthCm}x${usableHeightCm} cm.`);
  }

  const stepXCm = usableWidthCm - overlapCm;
  const stepYCm = usableHeightCm - overlapCm;
  const nx = Math.max(1, Math.ceil((widthCm - overlapCm) / stepXCm));
  const ny = Math.max(1, Math.ceil((heightCm - overlapCm) / stepYCm));

  return {
    paperFormat,
    paperWidthCm: pW,
    paperHeightCm: pH,
    usableWidthCm: Number(usableWidthCm.toFixed(4)),
    usableHeightCm: Number(usableHeightCm.toFixed(4)),
    stepXCm: Number(stepXCm.toFixed(4)),
    stepYCm: Number(stepYCm.toFixed(4)),
    nx,
    ny,
    totalPages: nx * ny,
    calibrationBar10CmPt: cmToPt(10.0),
  };
}

export function polygonAreaAndPerimeter(polygonCm) {
  const n = polygonCm.length;
  if (n < 3) return { areaCm2: 0, perimeterCm: 0 };
  let sum = 0;
  let perim = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = polygonCm[i];
    const [x2, y2] = polygonCm[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
    perim += Math.hypot(x2 - x1, y2 - y1);
  }
  return { areaCm2: Math.abs(sum) * 0.5, perimeterCm: perim };
}

/**
 * Fórmula generalizada de pastina por perímetro real (válida para cualquier polígono).
 * Para rectángulos L x W sin junta perimetral exterior extra, coincide algebraicamente con
 * A * ((L + W)/(L*W)) * j * e * rho.
 */
export function computeGeneralizedGroutKg({
  totalCellPerimeterCm,
  muralBorderPerimeterCm,
  outerBorderFactor = 0.5,
  groutMm = 2.0,
  tileThicknessMm = 4.0,
  groutDensityGPerCm3 = 1.6,
  wasteFactor = 0,
}) {
  const internalJointsCm = Math.max(0, totalCellPerimeterCm - muralBorderPerimeterCm) * 0.5;
  const totalJointsM =
    internalJointsCm / 100 + (muralBorderPerimeterCm / 100) * Math.max(0, Math.min(1, outerBorderFactor));
  const kg = totalJointsM * groutMm * tileThicknessMm * 1e-3 * groutDensityGPerCm3 * (1 + wasteFactor);
  return {
    jointLengthM: Number(totalJointsM.toFixed(4)),
    groutKg: Number(kg.toFixed(4)),
  };
}

export function srgbToLab(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) * 100;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) * 100;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) * 100;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X / 95.047);
  const fy = f(Y / 100.0);
  const fz = f(Z / 108.883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function ciede2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (bp, ap) => (bp === 0 && ap === 0 ? 0 : ((Math.atan2(bp, ap) * deg) + 360) % 360);
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
    else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
    else dhp = h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let Hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) Hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) Hbarp = (h1p + h2p + 360) / 2;
    else Hbarp = (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((Hbarp - 30) * rad) +
    0.24 * Math.cos(2 * Hbarp * rad) +
    0.32 * Math.cos((3 * Hbarp + 6) * rad) -
    0.20 * Math.cos((4 * Hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((Hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const L50sq = Math.pow(Lbarp - 50, 2);
  const Sl = 1 + (0.015 * L50sq) / Math.sqrt(20 + L50sq);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh)
  );
}

function runSelfTest() {
  const checks = [];
  const cal10Pt = cmToPt(10.0);
  if (Math.abs(cal10Pt - 283.46456692913387) > 1e-6) {
    throw new Error(`Calibration 10cm failed: ${cal10Pt}`);
  }
  checks.push({ test: 'calibration_10cm_pt', ok: true, valuePt: Number(cal10Pt.toFixed(6)) });

  const a4 = computePrintGrid({ widthCm: 60, heightCm: 80, paperFormat: 'A4', marginCm: 1.0, overlapCm: 1.0 });
  const a3 = computePrintGrid({ widthCm: 60, heightCm: 80, paperFormat: 'A3', marginCm: 1.0, overlapCm: 1.0 });
  const letter = computePrintGrid({ widthCm: 60, heightCm: 80, paperFormat: 'LETTER', marginCm: 1.0, overlapCm: 0.5 });
  if (a4.totalPages !== 12 || a3.totalPages >= a4.totalPages || letter.totalPages < 12) {
    throw new Error(`Multipaper check failed: A4=${a4.totalPages}, A3=${a3.totalPages}, LETTER=${letter.totalPages}`);
  }
  checks.push({ test: 'multipaper_grid', ok: true, a4: a4.totalPages, a3: a3.totalPages, letter: letter.totalPages });

  // Shoelace check on 2x2 cm square
  const poly = polygonAreaAndPerimeter([[0, 0], [2, 0], [2, 2], [0, 2]]);
  if (poly.areaCm2 !== 4 || poly.perimeterCm !== 8) {
    throw new Error(`Shoelace check failed: ${JSON.stringify(poly)}`);
  }
  checks.push({ test: 'shoelace_area_perimeter', ok: true, ...poly });

  // Equivalencia entre fórmula generalizada por perímetro y norma rectangular en 100x100cm con teselas 2x2cm (50x50=2500 celdas)
  const rectPerimeterSum = 2500 * 8; // 20000 cm
  const borderPerimeter = 400; // 4 * 100 cm
  const genInternal = computeGeneralizedGroutKg({
    totalCellPerimeterCm: rectPerimeterSum,
    muralBorderPerimeterCm: borderPerimeter,
    outerBorderFactor: 0, // 49+49 líneas internas = 98 m
    groutMm: 2.0,
    tileThicknessMm: 4.0,
    groutDensityGPerCm3: 1.6,
  });
  const genPeriodic = computeGeneralizedGroutKg({
    totalCellPerimeterCm: rectPerimeterSum,
    muralBorderPerimeterCm: borderPerimeter,
    outerBorderFactor: 0.5, // 50+50 líneas (equivalente exacto a A*(2/L)*j*e*rho) = 100 m -> 1.28 kg
    groutMm: 2.0,
    tileThicknessMm: 4.0,
    groutDensityGPerCm3: 1.6,
  });
  if (Math.abs(genInternal.jointLengthM - 98) > 1e-6 || Math.abs(genPeriodic.groutKg - 1.28) > 0.001) {
    throw new Error(`Generalized grout equivalence failed: ${JSON.stringify({ genInternal, genPeriodic })}`);
  }
  checks.push({ test: 'generalized_grout_equivalence', ok: true, internalM: genInternal.jointLengthM, periodicKg: genPeriodic.groutKg });

  const de1 = ciede2000([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485]);
  if (Math.abs(de1 - 2.0425) > 0.001) {
    throw new Error(`CIEDE2000 Sharma pair 1 failed: ${de1}`);
  }
  checks.push({ test: 'ciede2000_sharma_pair1', ok: true, deltaE00: Number(de1.toFixed(4)) });

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
    const cfg = JSON.parse(fs.readFileSync(args[idx + 1], 'utf8'));
    const grid = computePrintGrid(cfg);
    console.log(JSON.stringify({ status: 'OK', grid }, null, 2));
    return;
  }
  console.error('Usage: verify_mosaic_math.mjs [--self-test | --input <file.json>]');
  process.exit(2);
}

main();
