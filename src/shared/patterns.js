import { UNUSED_CELL } from './mosaicCore.js';

const EPS = 1e-9;

function normalizePatternName(pattern) {
  if (pattern === 'brick') return 'brick_50';
  return pattern || 'grid';
}

function dedupePolygonVertices(poly) {
  if (!Array.isArray(poly) || poly.length === 0) return [];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const pt = poly[i];
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > EPS) {
      out.push([pt[0], pt[1]]);
    }
  }
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= EPS) {
      out.pop();
    }
  }
  return out;
}

/**
 * Recorte exacto Sutherland-Hodgman de un polígono convexo o simple contra [0, widthCm] × [0, heightCm].
 *
 * @param {Array<[number, number]>} polygonCm
 * @param {number} widthCm
 * @param {number} heightCm
 * @returns {Array<[number, number]>}
 */
export function clipPolygonToRect(polygonCm, widthCm, heightCm) {
  if (!Array.isArray(polygonCm) || polygonCm.length < 3) return [];
  if (!Number.isFinite(widthCm) || widthCm <= 0 || !Number.isFinite(heightCm) || heightCm <= 0) {
    return [];
  }

  const clipEdge = (pts, isInside, intersect) => {
    const n = pts.length;
    if (n === 0) return [];
    const out = [];
    let prev = pts[n - 1];
    let prevIn = isInside(prev);

    for (let i = 0; i < n; i++) {
      const curr = pts[i];
      const currIn = isInside(curr);
      if (currIn) {
        if (!prevIn) out.push(intersect(prev, curr));
        out.push([curr[0], curr[1]]);
      } else if (prevIn) {
        out.push(intersect(prev, curr));
      }
      prev = curr;
      prevIn = currIn;
    }
    return out;
  };

  let res = polygonCm;
  res = clipEdge(
    res,
    (p) => p[0] >= 0,
    (a, b) => {
      const dx = b[0] - a[0];
      const t = Math.abs(dx) < EPS ? 0 : (0 - a[0]) / dx;
      return [0, a[1] + (b[1] - a[1]) * t];
    }
  );
  res = clipEdge(
    res,
    (p) => p[0] <= widthCm,
    (a, b) => {
      const dx = b[0] - a[0];
      const t = Math.abs(dx) < EPS ? 0 : (widthCm - a[0]) / dx;
      return [widthCm, a[1] + (b[1] - a[1]) * t];
    }
  );
  res = clipEdge(
    res,
    (p) => p[1] >= 0,
    (a, b) => {
      const dy = b[1] - a[1];
      const t = Math.abs(dy) < EPS ? 0 : (0 - a[1]) / dy;
      return [a[0] + (b[0] - a[0]) * t, 0];
    }
  );
  res = clipEdge(
    res,
    (p) => p[1] <= heightCm,
    (a, b) => {
      const dy = b[1] - a[1];
      const t = Math.abs(dy) < EPS ? 0 : (heightCm - a[1]) / dy;
      return [a[0] + (b[0] - a[0]) * t, heightCm];
    }
  );

  return dedupePolygonVertices(res);
}

/**
 * Calcula área (fórmula de Shoelace) y perímetro de un polígono 2D en cm.
 *
 * @param {Array<[number, number]>} poly
 * @returns {{ areaCm2: number, perimeterCm: number }}
 */
export function polygonAreaAndPerimeter(poly) {
  const n = Array.isArray(poly) ? poly.length : 0;
  if (n < 3) return { areaCm2: 0, perimeterCm: 0 };
  let sum = 0;
  let perim = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
    perim += Math.hypot(x2 - x1, y2 - y1);
  }
  return { areaCm2: Math.abs(sum) * 0.5, perimeterCm: perim };
}

/**
 * Calcula el centroide geométrico exacto de un polígono 2D.
 * Si el área es degenerada (< EPS), devuelve el promedio de vértices.
 *
 * @param {Array<[number, number]>} poly
 * @returns {[number, number]}
 */
export function polygonCentroid(poly) {
  const n = Array.isArray(poly) ? poly.length : 0;
  if (n === 0) return [0, 0];
  if (n < 3) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += poly[i][0];
      sy += poly[i][1];
    }
    return [sx / n, sy / n];
  }

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }

  if (Math.abs(twiceArea) <= EPS) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += poly[i][0];
      sy += poly[i][1];
    }
    return [sx / n, sy / n];
  }

  return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
}

/**
 * Prueba Ray-Casting + detección en borde para verificar si `(xCm, yCm)` cae dentro de `poly`.
 *
 * @param {number} xCm
 * @param {number} yCm
 * @param {Array<[number, number]>} poly
 * @returns {boolean}
 */
export function pointInPolygon(xCm, yCm, poly) {
  const n = Array.isArray(poly) ? poly.length : 0;
  if (n < 3) return false;

  // Chequeo rápido de proximidad a arista para incluir bordes exactos
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > EPS) {
      const t = Math.max(0, Math.min(1, ((xCm - x1) * dx + (yCm - y1) * dy) / lenSq));
      const projX = x1 + t * dx;
      const projY = y1 + t * dy;
      if (Math.hypot(xCm - projX, yCm - projY) <= 1e-7) return true;
    }
  }

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];

    const intersect =
      yi > yCm !== yj > yCm && xCm < ((xj - xi) * (yCm - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function signedArea(poly) {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum * 0.5;
}

/**
 * Desplaza hacia el interior (inset) las aristas de un polígono en `insetCm`
 * para simular el grosor de junta/pastina sin deformar la orientación ni colapsar.
 *
 * @param {Array<[number, number]>} poly
 * @param {number} insetCm
 * @returns {Array<[number, number]>}
 */
export function insetPolygon(poly, insetCm) {
  const clean = dedupePolygonVertices(poly);
  const n = clean.length;
  if (n < 3) return clean;
  if (!Number.isFinite(insetCm) || insetCm <= 0) {
    return clean.map((p) => [p[0], p[1]]);
  }

  const sArea = signedArea(clean);
  if (Math.abs(sArea) <= EPS) return clean.map((p) => [p[0], p[1]]);

  const { areaCm2, perimeterCm } = polygonAreaAndPerimeter(clean);
  // Limitar inset máximo para que polígonos estrechos nunca colapsen ni se inviertan
  const inradiusApprox = (2 * areaCm2) / Math.max(EPS, perimeterCm);
  const safeInset = Math.min(insetCm, inradiusApprox * 0.48);
  if (safeInset <= 1e-6) return clean.map((p) => [p[0], p[1]]);

  // Orientación CCW -> normal interior es (-dy/L, dx/L)
  // Orientación CW -> normal interior es (dy/L, -dx/L)
  const ccwSign = sArea > 0 ? 1 : -1;

  // Construir rectas desplazadas P_i + safeInset * normal_i en dirección (dx, dy)
  const offsetLines = [];
  for (let i = 0; i < n; i++) {
    const p0 = clean[i];
    const p1 = clean[(i + 1) % n];
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    if (len <= EPS) continue;

    const nx = (-dy / len) * ccwSign;
    const ny = (dx / len) * ccwSign;
    offsetLines.push({
      px: p0[0] + nx * safeInset,
      py: p0[1] + ny * safeInset,
      dx: dx / len,
      dy: dy / len,
    });
  }

  const m = offsetLines.length;
  if (m < 3) return clean.map((p) => [p[0], p[1]]);

  const result = [];
  for (let i = 0; i < m; i++) {
    const l1 = offsetLines[(i - 1 + m) % m];
    const l2 = offsetLines[i];
    const denom = l1.dx * l2.dy - l1.dy * l2.dx;

    if (Math.abs(denom) < 1e-6) {
      result.push([l2.px, l2.py]);
      continue;
    }

    const rx = l2.px - l1.px;
    const ry = l2.py - l1.py;
    const t = (rx * l2.dy - ry * l2.dx) / denom;
    let ix = l1.px + t * l1.dx;
    let iy = l1.py + t * l1.dy;

    // Clamping de picos agudos extremos (miter limit = 3x safeInset)
    const orig = clean[i % n];
    const distFromVertex = Math.hypot(ix - orig[0], iy - orig[1]);
    if (distFromVertex > safeInset * 3.5) {
      const [cx, cy] = polygonCentroid(clean);
      const shrink = Math.max(0.25, Math.min(0.95, 1 - safeInset / Math.max(EPS, inradiusApprox)));
      ix = cx + (orig[0] - cx) * shrink;
      iy = cy + (orig[1] - cy) * shrink;
    }

    result.push([ix, iy]);
  }

  // Verificar que el polígono resultante no se auto-cruzó ni perdió área positiva válida
  const resArea = signedArea(result);
  if (resArea * sArea <= 0 || Math.abs(resArea) <= EPS) {
    const [cx, cy] = polygonCentroid(clean);
    const shrink = Math.max(0.25, Math.min(0.95, 1 - safeInset / Math.max(EPS, inradiusApprox)));
    return clean.map(([x, y]) => [cx + (x - cx) * shrink, cy + (y - cy) * shrink]);
  }

  return result;
}

/**
 * Refleja horizontalmente un polígono en [0, widthCm].
 *
 * @param {Array<[number, number]>} poly
 * @param {number} widthCm
 * @returns {Array<[number, number]>}
 */
export function mirrorPolygonCm(poly, widthCm) {
  if (!Array.isArray(poly)) return [];
  // Al reflejar X -> W - X invertimos el orden de vértices para preservar la orientación (CCW/CW)
  const mirrored = poly.map(([x, y]) => [widthCm - x, y]);
  mirrored.reverse();
  return mirrored;
}

/**
 * Evalúa la viabilidad física de corte de una celda poligonal (regla de mosaic-patterns-lab):
 * - minWidthMm = ((2 * areaCm2) / perimeterCm) * 10 < 8 mm -> unbuildable
 * - minAngleDeg < 25 deg -> unbuildable
 *
 * @param {Array<[number, number]>} poly
 * @param {number} [minCutMm=8]
 * @param {number} [minAngleDeg=25]
 * @returns {{ unbuildable: boolean, minWidthMm: number, minAngleDeg: number }}
 */
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
    if (mag > EPS) {
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

function makeCellGeometry({
  id,
  row,
  col,
  polygonCm,
  nominalAreaCm2,
  orientationDeg = 0,
  paletteId = 0,
  shapeHint = 'polygon',
  radiusCm = undefined,
  forceIsCut = false,
}) {
  const { areaCm2, perimeterCm } = polygonAreaAndPerimeter(polygonCm);
  const centroidCm = polygonCentroid(polygonCm);
  const cutRatio = nominalAreaCm2 > EPS ? Math.min(1, areaCm2 / nominalAreaCm2) : 1;
  const isCut = forceIsCut || cutRatio < 0.95;
  const flags = evaluateCutViability(polygonCm);

  const cell = {
    id,
    row,
    col,
    polygonCm,
    areaCm2,
    perimeterCm,
    centroidCm,
    nominalAreaCm2,
    cutRatio,
    isCut,
    orientationDeg,
    paletteId,
    shapeHint,
    flags,
  };
  if (radiusCm !== undefined) {
    cell.radiusCm = radiusCm;
  }
  return cell;
}

function rectPoly(x0, y0, x1, y1) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function rotatePoint(x, y, cx, cy, cosA, sinA) {
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA];
}

function regularPolygon(cx, cy, radius, sides, angleOffsetRad = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = angleOffsetRad + (2 * Math.PI * i) / sides;
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return pts;
}

function generateRectangularOrBrick(widthCm, heightCm, tileSizeCm, shiftFn) {
  const cells = [];
  const nominalArea = tileSizeCm * tileSizeCm;
  const rows = Math.max(1, Math.ceil(heightCm / tileSizeCm));
  let nextId = 1;

  for (let r = 0; r < rows; r++) {
    const y0 = r * tileSizeCm;
    const y1 = y0 + tileSizeCm;
    const offset = shiftFn(r, tileSizeCm); // en [-tileSizeCm, 0]
    const cStart = Math.floor((0 - offset) / tileSizeCm) - 1;
    const cEnd = Math.ceil((widthCm - offset) / tileSizeCm) + 1;
    let colIdx = 0;

    for (let c = cStart; c <= cEnd; c++) {
      const x0 = offset + c * tileSizeCm;
      const x1 = x0 + tileSizeCm;
      const clipped = clipPolygonToRect(rectPoly(x0, y0, x1, y1), widthCm, heightCm);
      const { areaCm2 } = polygonAreaAndPerimeter(clipped);
      if (areaCm2 <= 1e-6) continue;

      cells.push(
        makeCellGeometry({
          id: nextId++,
          row: r,
          col: colIdx++,
          polygonCm: clipped,
          nominalAreaCm2: nominalArea,
          orientationDeg: 0,
        })
      );
    }
  }
  return cells;
}

function generateDiamond45(widthCm, heightCm, tileSizeCm) {
  const cells = [];
  const nominalArea = tileSizeCm * tileSizeCm;
  const cx = widthCm * 0.5;
  const cy = heightCm * 0.5;
  const diag = Math.hypot(widthCm, heightCm) * 0.5 + tileSizeCm * 2;
  const minIdx = -Math.ceil(diag / tileSizeCm) - 1;
  const maxIdx = Math.ceil(diag / tileSizeCm) + 1;
  const cos45 = Math.SQRT1_2;
  const sin45 = Math.SQRT1_2;
  let nextId = 1;

  for (let gy = minIdx; gy <= maxIdx; gy++) {
    for (let gx = minIdx; gx <= maxIdx; gx++) {
      const lx0 = gx * tileSizeCm;
      const ly0 = gy * tileSizeCm;
      const lx1 = lx0 + tileSizeCm;
      const ly1 = ly0 + tileSizeCm;

      const raw = [
        rotatePoint(lx0, ly0, 0, 0, cos45, sin45),
        rotatePoint(lx1, ly0, 0, 0, cos45, sin45),
        rotatePoint(lx1, ly1, 0, 0, cos45, sin45),
        rotatePoint(lx0, ly1, 0, 0, cos45, sin45),
      ].map(([rx, ry]) => [rx + cx, ry + cy]);

      const clipped = clipPolygonToRect(raw, widthCm, heightCm);
      const { areaCm2 } = polygonAreaAndPerimeter(clipped);
      if (areaCm2 <= 1e-6) continue;

      cells.push(
        makeCellGeometry({
          id: nextId++,
          row: gy - minIdx,
          col: gx - minIdx,
          polygonCm: clipped,
          nominalAreaCm2: nominalArea,
          orientationDeg: 45,
        })
      );
    }
  }
  return cells;
}

function generateHexagonal(widthCm, heightCm, tileSizeCm) {
  // Hexágonos regulares "pointy-top":
  // Radio circumscrito R derivado para que ancho entre caras (flat-to-flat) = tileSizeCm => R = t / sqrt(3)
  // Verificación teselado exacto: dx = sqrt(3)*R = t, dy = 1.5*R = (sqrt(3)/2)*t, fila impar desplazada dx/2 = t/2.
  const R = tileSizeCm / Math.sqrt(3);
  const dx = Math.sqrt(3) * R; // == tileSizeCm
  const dy = 1.5 * R;
  const nominalArea = ((3 * Math.sqrt(3)) / 2) * R * R;

  const rMin = -1;
  const rMax = Math.ceil((heightCm + R) / dy) + 1;
  const cMin = -2;
  const cMax = Math.ceil((widthCm + dx) / dx) + 2;

  const cells = [];
  let nextId = 1;

  for (let r = rMin; r <= rMax; r++) {
    const cy = r * dy;
    const xShift = (((r % 2) + 2) % 2 === 1 ? dx * 0.5 : 0);
    let colCounter = 0;

    for (let c = cMin; c <= cMax; c++) {
      const cx = c * dx + xShift;
      // Bounding box rápido
      if (cx + dx * 0.6 < 0 || cx - dx * 0.6 > widthCm || cy + R * 1.1 < 0 || cy - R * 1.1 > heightCm) {
        continue;
      }

      // Vértices pointy-top: ángulos 30°, 90°, 150°, 210°, 270°, 330°
      const raw = regularPolygon(cx, cy, R, 6, Math.PI / 6);
      const clipped = clipPolygonToRect(raw, widthCm, heightCm);
      const { areaCm2 } = polygonAreaAndPerimeter(clipped);
      if (areaCm2 <= 1e-6) continue;

      cells.push(
        makeCellGeometry({
          id: nextId++,
          row: r - rMin,
          col: colCounter++,
          polygonCm: clipped,
          nominalAreaCm2: nominalArea,
          orientationDeg: 0,
        })
      );
    }
  }
  return cells;
}

function generateHerringbone(widthCm, heightCm, tileSizeCm) {
  // Espiga clásica 2:1 (ancho a = tileSizeCm, largo = 2*a) rotada 45° para teselar sin huecos ni solapes.
  // En la base de cuadrícula unitaria (s = tileSizeCm):
  // - Cada bloque L formado por 2 piezas 2x1 cubre un paso periódico (u, v) de periodo (2s, 2s) con desplazamiento escalonado.
  // Específicamente, en coordenadas locales (u, v) de unidad s = tileSizeCm:
  // Para enteros (i, j) tales que (i + j) % 2 === 0 no, mejor:
  // Sea una celda base unitaria s:
  // Tesela Horizontal (H) en (u0, v0): [u0, u0 + 2s] x [v0, v0 + s]
  // Tesela Vertical (V) en (u0, v0 + s): no; construcción estándar exacta de teselación espiga 2:1:
  // Para cada (k, m) enteros:
  //   H(k, m): [ (k - m)*s, (k - m + 2)*s ] x [ (k + m)*s, (k + m + 1)*s ]
  //   V(k, m): [ (k - m + 1)*s, (k - m + 2)*s ] x [ (k + m + 1)*s, (k + m + 3)*s ] -> veamos cobertura!
  // Comprobemos con celda elemental 1x1:
  // Poniendo s=1, para cada (k,m):
  // H(k,m) cubre los cuadrados (k-m, k+m) y (k-m+1, k+m).
  // V(k,m) cubre los cuadrados (k-m, k+m+1) y (k-m, k+m+2)? Probemos:
  // Sea P = k - m, Q = k + m. Notar que P y Q tienen la misma paridad (P+Q = 2k, P-Q = -2m).
  // Si H cubre (P, Q) y (P+1, Q): cubre (par, par) y (impar, par), además de (impar, impar) y (par, impar)!
  // Espera: cuando P,Q son pares, H cubre (P, Q) [par, par] y (P+1, Q) [impar, par].
  // Cuando P,Q son impares, H cubre (P, Q) [impar, impar] y (P+1, Q) [par, impar].
  // ¡H ya cubre TODOS los cuadrados (x, y) de Z^2 una vez si no fuera por V! Necesitamos particionar Z^2 en H (x+y?) y V!
  // Partición exacta de Z^2 en pares (x,y) por espiga 2:1:
  // Para cada par (k, m) con s=1, sean origen de pareja: x0 = k + m, y0 = k - m? No:
  // Paso en escalera de 1:
  // En fila y = 0: H en [0,2)x[0,1), V en [2,3)x[0,2), H en [3,5)x[1,2)? Veamos el periodo en diagonal (1,1):
  // En espiga 2:1, cada "peldaño" n tiene:
  //   Pieza H_n: [n, n+2) x [n, n+1)
  //   Pieza V_n: [n, n+1) x [n+1, n+3)
  // La unión de la banda diagonal principal B_0 = U_n (H_n U V_n):
  //   H_0: (0,0),(1,0); V_0: (0,1),(0,2) -> wait: H_1 es (1,1),(2,1); V_1 is (1,2),(1,3).
  //   Comprobemos si (H_n U V_n) trasladado por (4*m, 0) o (2*m, -2*m) tesela Z^2!
  //   Veamos en B_0 para n in Z:
  //     Para y fijo: y=0 -> H_0 tiene (0,0),(1,0); V_{-1} tiene (-1,0),(-1,1); V_{-2} tiene (-2,-1),(-2,0)!
  //     Así para y=0, B_0 cubre x = -2, -1, 0, 1! Son 4 celdas consecutivas de ancho!
  //     Comprobemos y=1: H_1 tiene (1,1),(2,1); V_0 tiene (0,1),(0,2); V_{-1} tiene (-1,0),(-1,1)!
  //     Así para y=1, B_0 cubre x = -1, 0, 1, 2! ¡Exactamente 4 celdas desplazadas +1 en x!
  //     Comprobemos cualquier y:
  //       H_y cubre x = y, y+1.
  //       V_{y-1} cubre x = y-1 (pues y-1 + 1 = y, y-1 + 2 = y+1 -> cubre y y y+1).
  //       V_{y-2} cubre x = y-2 (cubre y-1 y y).
  //     Entonces para todo y, B_0 cubre EXACTAMENTE {y-2, y-1, y, y+1} sin solapes ni huecos!
  //   ¡Brillante! Trasladando B_0 por 4*m en X (para todo m in Z), cubrimos TODOS los enteros Z^2 sin ningún hueco ni solape!
  // Rotando luego todo por 45° respecto al centro del mural, tenemos la espiga herringbone arquitectónica clásica (±45°)!

  const s = tileSizeCm * 0.70710678; // ancho de pieza de modo que largo = 2s ≈ 1.414*t y área 2*s^2 = t^2
  // O si tileSizeCm es el ancho corto de la tira (o lado nominal sqrt(area)):
  // Usando s = tileSizeCm / Math.SQRT2 => área nominal de cada rectángulo 2s × s = 2 * (t^2 / 2) = t^2 (consistente con tileSizeCm^2!)
  const nominalArea = 2 * s * s; // == tileSizeCm^2 exacto
  const cx = widthCm * 0.5;
  const cy = heightCm * 0.5;
  const reach = Math.hypot(widthCm, heightCm) * 0.5 + s * 6;
  const bound = Math.ceil(reach / s) + 3;
  const cos45 = Math.SQRT1_2;
  const sin45 = Math.SQRT1_2;

  const mMin = Math.floor((-bound - bound) / 4) - 1;
  const mMax = Math.ceil((bound + bound) / 4) + 1;

  const cells = [];
  let nextId = 1;

  for (let m = mMin; m <= mMax; m++) {
    const xShift = 4 * m * s;
    for (let n = -bound; n <= bound; n++) {
      // Pieza Horizontal en coords locales: [n*s + xShift, (n+2)*s + xShift] x [n*s, (n+1)*s]
      const hRaw = rectPoly(n * s + xShift, n * s, (n + 2) * s + xShift, (n + 1) * s).map(([u, v]) => {
        const [rx, ry] = rotatePoint(u, v, 0, 0, cos45, sin45);
        return [rx + cx, ry + cy];
      });
      const hClip = clipPolygonToRect(hRaw, widthCm, heightCm);
      if (polygonAreaAndPerimeter(hClip).areaCm2 > 1e-6) {
        cells.push(
          makeCellGeometry({
            id: nextId++,
            row: n + bound,
            col: (m - mMin) * 2,
            polygonCm: hClip,
            nominalAreaCm2: nominalArea,
            orientationDeg: 45,
          })
        );
      }

      // Pieza Vertical en coords locales: [n*s + xShift, (n+1)*s + xShift] x [(n+1)*s, (n+3)*s]
      const vRaw = rectPoly(n * s + xShift, (n + 1) * s, (n + 1) * s + xShift, (n + 3) * s).map(([u, v]) => {
        const [rx, ry] = rotatePoint(u, v, 0, 0, cos45, sin45);
        return [rx + cx, ry + cy];
      });
      const vClip = clipPolygonToRect(vRaw, widthCm, heightCm);
      if (polygonAreaAndPerimeter(vClip).areaCm2 > 1e-6) {
        cells.push(
          makeCellGeometry({
            id: nextId++,
            row: n + bound,
            col: (m - mMin) * 2 + 1,
            polygonCm: vClip,
            nominalAreaCm2: nominalArea,
            orientationDeg: -45,
          })
        );
      }
    }
  }

  return cells;
}

function generateBasketweave(widthCm, heightCm, tileSizeCm) {
  // Bloques cuadrados de tamaño B = tileSizeCm subdivididos en 2 pares alternados 2×1:
  // Si (br + bc) % 2 === 0 -> 2 piezas horizontales de (B × B/2)
  // Si (br + bc) % 2 === 1 -> 2 piezas verticales de (B/2 × B)
  // (También escalado de manera que la tesela individual tenga lado corto = tileSizeCm * 0.5 y largo = tileSizeCm,
  // o si B = 2 * tileSizeCm entonces cada pieza mide tileSizeCm × 2*tileSizeCm. Usamos B = tileSizeCm * 2 para que el espesor mínimo >= tileSizeCm).
  // Espera: si tileSizeCm = 2 cm y mural = 10x10 cm, con B = 2*tileSizeCm = 4 cm cada barrita es 2x4 cm (área 8 cm2),
  // o con B = tileSizeCm = 2 cm cada barrita es 1x2 cm (área 2 cm2). Usamos B = 2 * tileSizeCm para evitar piezas < 1 cm cuando tileSizeCm = 1 cm (respetando minWidthMm >= 8mm!).
  const B = tileSizeCm * 2;
  const halfB = tileSizeCm;
  const nominalArea = B * halfB;
  const blockCols = Math.ceil(widthCm / B);
  const blockRows = Math.ceil(heightCm / B);

  const cells = [];
  let nextId = 1;

  for (let br = 0; br < blockRows; br++) {
    const y0 = br * B;
    for (let bc = 0; bc < blockCols; bc++) {
      const x0 = bc * B;
      const isHorizontal = (br + bc) % 2 === 0;

      if (isHorizontal) {
        for (let k = 0; k < 2; k++) {
          const py0 = y0 + k * halfB;
          const raw = rectPoly(x0, py0, x0 + B, py0 + halfB);
          const clipped = clipPolygonToRect(raw, widthCm, heightCm);
          if (polygonAreaAndPerimeter(clipped).areaCm2 <= 1e-6) continue;
          cells.push(
            makeCellGeometry({
              id: nextId++,
              row: br * 2 + k,
              col: bc,
              polygonCm: clipped,
              nominalAreaCm2: nominalArea,
              orientationDeg: 0,
            })
          );
        }
      } else {
        for (let k = 0; k < 2; k++) {
          const px0 = x0 + k * halfB;
          const raw = rectPoly(px0, y0, px0 + halfB, y0 + B);
          const clipped = clipPolygonToRect(raw, widthCm, heightCm);
          if (polygonAreaAndPerimeter(clipped).areaCm2 <= 1e-6) continue;
          cells.push(
            makeCellGeometry({
              id: nextId++,
              row: br,
              col: bc * 2 + k,
              polygonCm: clipped,
              nominalAreaCm2: nominalArea,
              orientationDeg: 90,
            })
          );
        }
      }
    }
  }

  return cells;
}

function generateFishScale(widthCm, heightCm, tileSizeCm) {
  // Escama de pez (Moroccan Fish Scale / Scallop) teselada sin huecos ni solapes:
  // Sea ancho de escama W = tileSizeCm, radio R = W / 2 = tileSizeCm / 2.
  // Para que la fila inferior y la fila superior encajen exactamente sin huecos ni solapes,
  // la pieza es un "escudo escama":
  // - Arco superior convexo (8 segmentos -> 9 puntos de arco desde ángulo -180° a 0° en coord Y hacia abajo: y = cy - R*sin(theta))
  // - Vértices inferiores cóncavos formados por los dos arcos inferiores de la fila inferior desplazada (W/2, dy)!
  // En efecto, una escama de abanico con centro (cx, cy), ancho W = 2*R y desplazamiento vertical dy = R:
  //   Frontera superior de la celda (r, c): arco superior semicircular centrado en (cx, cy) de radio R:
  //     (cx - R*cos(a), cy - R*sin(a)) para a in [0..PI] (Y hacia abajo, así que -R*sin(a) sube por encima de cy).
  //   Frontera inferior: dos cuartos de círculo (invertidos) correspondientes a los arcos superiores de las dos escamas debajo en (cx - R, cy + R) y (cx + R, cy + R)!
  //   Comprobación matemática:
  //     El arco izquierdo debajo (cx - R, cy + R) va de x = cx - R (áng = PI/2, y = cy) hasta x = cx (áng = 0, y = cy + R).
  //     El arco derecho debajo (cx + R, cy + R) va de x = cx (áng = PI, y = cy + R) hasta x = cx + R (áng = PI/2, y = cy).
  //   Área exacta = semicírculo superior (0.5*pi*R^2) + rectángulo [2R x R] menos dos cuartos de círculo (0.5*pi*R^2) = 2 * R^2 = (W^2)/2!
  //   ¡Encaja geométricamente al 100.000% sin solapes ni huecos y la suma de áreas es EXACTAMENTE widthCm * heightCm!

  const W = tileSizeCm;
  const R = W * 0.5;
  const dy = R;
  const nominalArea = 2 * R * R; // exacto: área de cada escama teselada = W * (W/2)

  const rMin = -1;
  const rMax = Math.ceil((heightCm + R) / dy) + 1;
  const cMin = -1;
  const cMax = Math.ceil((widthCm + W) / W) + 1;

  const arcSteps = 8; // 8 segmentos en el arco superior (9 vértices) + arcos inferiores = ~15 vértices poligonales suaves
  const halfArcSteps = 4;

  const cells = [];
  let nextId = 1;

  for (let r = rMin; r <= rMax; r++) {
    const cy = r * dy;
    const xShift = (((r % 2) + 2) % 2 === 1 ? R : 0);
    let colIdx = 0;

    for (let c = cMin; c <= cMax; c++) {
      const cx = c * W + xShift;
      if (cx + R < 0 || cx - R > widthCm || cy + R < 0 || cy - R > heightCm) {
        continue;
      }

      const raw = [];
      // 1. Arco superior de izquierda (cx - R, cy) a derecha (cx + R, cy) pasando por (cx, cy - R)
      for (let i = 0; i <= arcSteps; i++) {
        const theta = Math.PI - (Math.PI * i) / arcSteps; // PI -> 0
        raw.push([cx + R * Math.cos(theta), cy - R * Math.sin(theta)]);
      }
      // 2. Arco inferior derecho desde (cx + R, cy) hasta la punta inferior (cx, cy + R)
      // Centro en (cx + R, cy + R), ángulo de 3*PI/2? No: (cx+R, cy) está a PI/2 arriba del centro (cx+R, cy+R);
      // (cx, cy+R) está a PI a la izquierda del centro (cx+R, cy+R).
      for (let i = 1; i <= halfArcSteps; i++) {
        const theta = Math.PI * 0.5 + (Math.PI * 0.5 * i) / halfArcSteps; // PI/2 -> PI
        raw.push([cx + R + R * Math.cos(theta), cy + R - R * Math.sin(theta)]);
      }
      // 3. Arco inferior izquierdo desde (cx, cy + R) hasta (cx - R, cy)
      // Centro en (cx - R, cy + R), (cx, cy+R) está a ángulo 0; (cx-R, cy) está a ángulo PI/2.
      for (let i = 1; i < halfArcSteps; i++) {
        const theta = (Math.PI * 0.5 * i) / halfArcSteps; // 0 -> PI/2
        raw.push([cx - R + R * Math.cos(theta), cy + R - R * Math.sin(theta)]);
      }

      const clipped = clipPolygonToRect(raw, widthCm, heightCm);
      const { areaCm2 } = polygonAreaAndPerimeter(clipped);
      if (areaCm2 <= 1e-6) continue;

      cells.push(
        makeCellGeometry({
          id: nextId++,
          row: r - rMin,
          col: colIdx++,
          polygonCm: clipped,
          nominalAreaCm2: nominalArea,
          orientationDeg: 0,
        })
      );
    }
  }

  return cells;
}

function generatePennyRound(widthCm, heightCm, tileSizeCm) {
  // Empaquetamiento hexagonal compacto de círculos:
  // Diámetro D = tileSizeCm, radio R = D / 2 (con ligero margen interno para visualizar cada círculo).
  // Paso horizontal dx = D, paso vertical dy = (sqrt(3)/2) * D, filas impares desplazadas dx / 2.
  const D = tileSizeCm;
  const R = D * 0.5;
  const dx = D;
  const dy = (Math.sqrt(3) * 0.5) * D;
  const nominalArea = Math.PI * R * R;

  const rMin = 0;
  const rMax = Math.ceil((heightCm + R) / dy);
  const cMin = -1;
  const cMax = Math.ceil((widthCm + R) / dx) + 1;

  const cells = [];
  let nextId = 1;

  for (let r = rMin; r <= rMax; r++) {
    const cy = R + r * dy;
    if (cy - R >= heightCm) break;
    const xShift = r % 2 === 1 ? dx * 0.5 : 0;
    let colIdx = 0;

    for (let c = cMin; c <= cMax; c++) {
      const cx = R + c * dx + xShift;
      if (cx + R <= 0 || cx - R >= widthCm) continue;

      const raw = regularPolygon(cx, cy, R, 16, 0);
      const clipped = clipPolygonToRect(raw, widthCm, heightCm);
      const { areaCm2 } = polygonAreaAndPerimeter(clipped);
      if (areaCm2 <= 1e-6) continue;

      const touchesEdge =
        cx - R < -1e-6 || cx + R > widthCm + 1e-6 || cy - R < -1e-6 || cy + R > heightCm + 1e-6;

      cells.push(
        makeCellGeometry({
          id: nextId++,
          row: r,
          col: colIdx++,
          polygonCm: clipped,
          nominalAreaCm2: nominalArea,
          orientationDeg: 0,
          shapeHint: 'circle',
          radiusCm: R,
          forceIsCut: touchesEdge,
        })
      );
    }
  }

  return cells;
}

/**
 * Genera el arreglo completo de celdas `CellGeometry[]` recortadas a `[0, widthCm] × [0, heightCm]`
 * para todos los patrones arquitectónicos de Fase 2.
 *
 * @param {{ widthCm: number, heightCm: number, tileSizeCm: number, pattern?: string }} config
 * @returns {Array<import('./contracts.js').CellGeometry>}
 */
export function generatePatternCells(config = {}) {
  const widthCm = Number(config.widthCm);
  const heightCm = Number(config.heightCm);
  const tileSizeCm = Number(config.tileSizeCm);
  const pattern = normalizePatternName(config.pattern);

  if (!Number.isFinite(widthCm) || widthCm <= 0) {
    throw new Error(`widthCm inválido para generatePatternCells: ${config.widthCm}`);
  }
  if (!Number.isFinite(heightCm) || heightCm <= 0) {
    throw new Error(`heightCm inválido para generatePatternCells: ${config.heightCm}`);
  }
  if (!Number.isFinite(tileSizeCm) || tileSizeCm <= 0) {
    throw new Error(`tileSizeCm inválido para generatePatternCells: ${config.tileSizeCm}`);
  }

  switch (pattern) {
    case 'grid':
      return generateRectangularOrBrick(widthCm, heightCm, tileSizeCm, () => 0);
    case 'brick_50':
      return generateRectangularOrBrick(widthCm, heightCm, tileSizeCm, (r, t) =>
        r % 2 === 1 ? -t * 0.5 : 0
      );
    case 'brick_33':
      return generateRectangularOrBrick(widthCm, heightCm, tileSizeCm, (r, t) => {
        const mod = ((r % 3) + 3) % 3;
        return -(mod / 3) * t;
      });
    case 'diamond_45':
      return generateDiamond45(widthCm, heightCm, tileSizeCm);
    case 'hexagonal':
      return generateHexagonal(widthCm, heightCm, tileSizeCm);
    case 'herringbone':
      return generateHerringbone(widthCm, heightCm, tileSizeCm);
    case 'basketweave':
      return generateBasketweave(widthCm, heightCm, tileSizeCm);
    case 'fish_scale':
      return generateFishScale(widthCm, heightCm, tileSizeCm);
    case 'penny_round':
      return generatePennyRound(widthCm, heightCm, tileSizeCm);
    default:
      throw new Error(`Patrón arquitectónico no soportado en generatePatternCells: ${pattern}`);
  }
}

function getPolygonBbox(poly) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x, y] = poly[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Construye un índice espacial en grilla uniforme para hit-testing O(1) y adyacencia rápida.
 *
 * @param {Array<import('./contracts.js').CellGeometry>} cells
 * @param {number} widthCm
 * @param {number} heightCm
 * @param {number} [cellSizeCm]
 * @returns {{
 *   cells: Array<import('./contracts.js').CellGeometry>,
 *   idToIndex: Map<number, number>,
 *   bboxes: Array<[number, number, number, number]>,
 *   widthCm: number,
 *   heightCm: number,
 *   cellSizeCm: number,
 *   cols: number,
 *   rows: number,
 *   buckets: Array<number[]>
 * }}
 */
export function buildSpatialCellIndex(cells, widthCm, heightCm, cellSizeCm) {
  const list = Array.isArray(cells) ? cells : [];
  let binSize = Number(cellSizeCm);
  if (!Number.isFinite(binSize) || binSize <= 0) {
    const sampleCount = Math.min(list.length, 64);
    let areaSum = 0;
    for (let i = 0; i < sampleCount; i++) {
      areaSum += list[i].nominalAreaCm2 || list[i].areaCm2 || 4;
    }
    const avgSide = sampleCount > 0 ? Math.sqrt(areaSum / sampleCount) : 2;
    binSize = Math.max(0.5, avgSide * 1.5);
  }

  const cols = Math.max(1, Math.ceil(widthCm / binSize));
  const rows = Math.max(1, Math.ceil(heightCm / binSize));
  const buckets = new Array(cols * rows);
  const bboxes = new Array(list.length);
  const idToIndex = new Map();

  for (let i = 0; i < list.length; i++) {
    const cell = list[i];
    idToIndex.set(cell.id ?? i, i);
    const bbox = getPolygonBbox(cell.polygonCm);
    bboxes[i] = bbox;

    const c0 = Math.max(0, Math.min(cols - 1, Math.floor(bbox[0] / binSize)));
    const c1 = Math.max(0, Math.min(cols - 1, Math.floor(bbox[2] / binSize)));
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(bbox[1] / binSize)));
    const r1 = Math.max(0, Math.min(rows - 1, Math.floor(bbox[3] / binSize)));

    for (let br = r0; br <= r1; br++) {
      for (let bc = c0; bc <= c1; bc++) {
        const bi = br * cols + bc;
        if (!buckets[bi]) buckets[bi] = [];
        buckets[bi].push(i);
      }
    }
  }

  return {
    cells: list,
    idToIndex,
    bboxes,
    widthCm,
    heightCm,
    cellSizeCm: binSize,
    cols,
    rows,
    buckets,
  };
}

/**
 * Busca la celda que contiene las coordenadas `(xCm, yCm)`, respetando `mirrorMode`.
 *
 * @param {ReturnType<typeof buildSpatialCellIndex>} index
 * @param {number} xCm
 * @param {number} yCm
 * @param {boolean} [mirrorMode=false]
 * @param {number} [widthCm]
 * @returns {{ cell: import('./contracts.js').CellGeometry, index: number } | null}
 */
export function findCellAtCm(index, xCm, yCm, mirrorMode = false, widthCm) {
  if (!index || !Array.isArray(index.cells) || index.cells.length === 0) return null;
  if (!Number.isFinite(xCm) || !Number.isFinite(yCm)) return null;

  const w = Number.isFinite(widthCm) ? widthCm : index.widthCm;
  const h = index.heightCm;
  if (xCm < 0 || xCm > w || yCm < 0 || yCm > h) return null;

  const lx = mirrorMode ? w - xCm : xCm;
  const ly = yCm;

  const bc = Math.max(0, Math.min(index.cols - 1, Math.floor(lx / index.cellSizeCm)));
  const br = Math.max(0, Math.min(index.rows - 1, Math.floor(ly / index.cellSizeCm)));
  const candidates = index.buckets[br * index.cols + bc];

  if (candidates) {
    for (let k = 0; k < candidates.length; k++) {
      const ci = candidates[k];
      const bbox = index.bboxes[ci];
      if (lx < bbox[0] - 1e-6 || lx > bbox[2] + 1e-6 || ly < bbox[1] - 1e-6 || ly > bbox[3] + 1e-6) {
        continue;
      }
      const cell = index.cells[ci];
      if (cell.shapeHint === 'circle' && Number.isFinite(cell.radiusCm)) {
        const [cx, cy] = cell.centroidCm;
        if (Math.hypot(lx - cx, ly - cy) <= cell.radiusCm + 1e-6 && pointInPolygon(lx, ly, cell.polygonCm)) {
          return { cell, index: ci };
        }
      } else if (pointInPolygon(lx, ly, cell.polygonCm)) {
        return { cell, index: ci };
      }
    }
  }

  return null;
}

function segmentsShareOverlap(a1, a2, b1, b2) {
  const dxA = a2[0] - a1[0];
  const dyA = a2[1] - a1[1];
  const lenA = Math.hypot(dxA, dyA);
  if (lenA <= 1e-6) return false;

  const ux = dxA / lenA;
  const uy = dyA / lenA;

  // Distancia perpendicular de b1 y b2 a la recta de A
  const d1 = Math.abs((b1[0] - a1[0]) * uy - (b1[1] - a1[1]) * ux);
  const d2 = Math.abs((b2[0] - a1[0]) * uy - (b2[1] - a1[1]) * ux);
  if (d1 > 1e-4 || d2 > 1e-4) return false;

  // Proyección 1D sobre el eje de A
  const t1 = (b1[0] - a1[0]) * ux + (b1[1] - a1[1]) * uy;
  const t2 = (b2[0] - a1[0]) * ux + (b2[1] - a1[1]) * uy;
  const minB = Math.min(t1, t2);
  const maxB = Math.max(t1, t2);

  const overlap = Math.min(lenA, maxB) - Math.max(0, minB);
  return overlap > 1e-4;
}

function cellsAreAdjacent(cellA, cellB) {
  // Para círculos (penny_round), son adyacentes si sus centroides distan ~ D (suma de radios + tolerancia)
  if (cellA.shapeHint === 'circle' && cellB.shapeHint === 'circle') {
    const rSum = (cellA.radiusCm || 0) + (cellB.radiusCm || 0);
    const dist = Math.hypot(
      cellA.centroidCm[0] - cellB.centroidCm[0],
      cellA.centroidCm[1] - cellB.centroidCm[1]
    );
    if (dist <= rSum * 1.12) return true;
  }

  const pA = cellA.polygonCm;
  const pB = cellB.polygonCm;
  for (let i = 0; i < pA.length; i++) {
    const a1 = pA[i];
    const a2 = pA[(i + 1) % pA.length];
    for (let j = 0; j < pB.length; j++) {
      const b1 = pB[j];
      const b2 = pB[(j + 1) % pB.length];
      if (segmentsShareOverlap(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * Construye el grafo de adyacencia física entre celdas poligonales compartiendo arista (> 1e-4 cm)
 * (o contacto tangente en `penny_round`).
 *
 * @param {Array<import('./contracts.js').CellGeometry>} cells
 * @param {ReturnType<typeof buildSpatialCellIndex>} [index]
 * @returns {Map<number, number[]>} Mapa de índice en `cells` -> lista de índices vecinos (y también accesible por id)
 */
export function getPolygonCellNeighbors(cells, index) {
  const list = Array.isArray(cells) ? cells : [];
  const idx = index || buildSpatialCellIndex(list, ...inferBounds(list));
  const adj = new Map();

  for (let i = 0; i < list.length; i++) {
    adj.set(i, []);
  }

  const margin = 0.05;
  for (let i = 0; i < list.length; i++) {
    const bbox = idx.bboxes[i];
    const c0 = Math.max(0, Math.min(idx.cols - 1, Math.floor((bbox[0] - margin) / idx.cellSizeCm)));
    const c1 = Math.max(0, Math.min(idx.cols - 1, Math.floor((bbox[2] + margin) / idx.cellSizeCm)));
    const r0 = Math.max(0, Math.min(idx.rows - 1, Math.floor((bbox[1] - margin) / idx.cellSizeCm)));
    const r1 = Math.max(0, Math.min(idx.rows - 1, Math.floor((bbox[3] + margin) / idx.cellSizeCm)));

    const seenCandidates = new Set();
    for (let br = r0; br <= r1; br++) {
      for (let bc = c0; bc <= c1; bc++) {
        const bucket = idx.buckets[br * idx.cols + bc];
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j <= i || seenCandidates.has(j)) continue;
          seenCandidates.add(j);

          const b2 = idx.bboxes[j];
          const touchMargin = list[i].shapeHint === 'circle' ? Math.max(0.25, (list[i].radiusCm || 0) * 0.35) : 0.02;
          if (
            b2[2] < bbox[0] - touchMargin ||
            b2[0] > bbox[2] + touchMargin ||
            b2[3] < bbox[1] - touchMargin ||
            b2[1] > bbox[3] + touchMargin
          ) {
            continue;
          }

          if (cellsAreAdjacent(list[i], list[j])) {
            adj.get(i).push(j);
            adj.get(j).push(i);
          }
        }
      }
    }
  }

  return adj;
}

function inferBounds(cells) {
  let maxX = 10;
  let maxY = 10;
  for (let i = 0; i < cells.length; i++) {
    const poly = cells[i].polygonCm;
    for (let j = 0; j < poly.length; j++) {
      if (poly[j][0] > maxX) maxX = poly[j][0];
      if (poly[j][1] > maxY) maxY = poly[j][1];
    }
  }
  return [maxX, maxY];
}

/**
 * Flood Fill (BFS iterativo) sobre celdas geométricas arbitrarias (`CellGeometry[]`).
 * No muta el arreglo `grid` de entrada.
 *
 * @param {Array<import('./contracts.js').CellGeometry>} cells
 * @param {Uint8Array | number[]} grid
 * @param {number} startCellId `cell.id` (o índice si coincide) de la celda inicial
 * @param {number} targetColorIdx
 * @param {ReturnType<typeof buildSpatialCellIndex>} [spatialIndex]
 * @returns {{ grid: Uint8Array, changedCount: number }}
 */
export function floodFillCells(cells, grid, startCellId, targetColorIdx, spatialIndex) {
  const list = Array.isArray(cells) ? cells : [];
  const outGrid = new Uint8Array(grid);
  if (list.length === 0 || outGrid.length < list.length) {
    return { grid: outGrid, changedCount: 0 };
  }

  const idx = spatialIndex || buildSpatialCellIndex(list, ...inferBounds(list));
  let startIdx = idx.idToIndex.get(startCellId);
  if (startIdx === undefined && Number.isInteger(startCellId) && startCellId >= 0 && startCellId < list.length) {
    startIdx = startCellId;
  }
  if (startIdx === undefined) {
    return { grid: outGrid, changedCount: 0 };
  }

  const sourceColorIdx = outGrid[startIdx];
  if (sourceColorIdx === UNUSED_CELL || sourceColorIdx === targetColorIdx) {
    return { grid: outGrid, changedCount: 0 };
  }

  const adj = getPolygonCellNeighbors(list, idx);
  const visited = new Uint8Array(list.length);
  const queue = [startIdx];
  visited[startIdx] = 1;
  let head = 0;
  let changedCount = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    if (outGrid[cur] !== sourceColorIdx) continue;
    outGrid[cur] = targetColorIdx;
    changedCount++;

    const neighbors = adj.get(cur) || [];
    for (let i = 0; i < neighbors.length; i++) {
      const nb = neighbors[i];
      if (!visited[nb] && outGrid[nb] === sourceColorIdx) {
        visited[nb] = 1;
        queue.push(nb);
      }
    }
  }

  return { grid: outGrid, changedCount };
}
