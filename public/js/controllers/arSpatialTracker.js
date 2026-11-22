function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function wrapAngleDeg(deg) {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

/**
 * Calcula las dimensiones físicas de la pared visible y la distancia estimada de la cámara
 * a partir de 2 puntos tocados en pantalla y una longitud conocida en centímetros.
 */
export function computeWallCalibrationFromTwoPoints({
  ptA,
  ptB,
  knownCm,
  sceneW,
  sceneH,
  fovDeg = 62,
}) {
  const dx = (ptB?.[0] || 0) - (ptA?.[0] || 0);
  const dy = (ptB?.[1] || 0) - (ptA?.[1] || 0);
  const distPx = Math.hypot(dx, dy);
  const refCm = Number(knownCm);
  if (!Number.isFinite(distPx) || distPx < 8 || !Number.isFinite(refCm) || refCm <= 0) {
    return null;
  }

  const pxPerCm = distPx / refCm;
  const wallWidthCm = sceneW / pxPerCm;
  const wallHeightCm = sceneH / pxPerCm;
  const halfFovRad = ((fovDeg * Math.PI) / 180) / 2;
  const distanceM = Math.max(0.25, (wallWidthCm / 100) / (2 * Math.tan(halfFovRad)));

  return {
    distPx,
    pxPerCm,
    wallWidthCm,
    wallHeightCm,
    distanceM,
  };
}

/**
 * Proyecta las 4 esquinas ancladas a la pared compensando rotación del dispositivo (giroscopio)
 * y acercamiento hacia el mural (zoom relativo al centro de la cámara como gafas VR).
 */
export function computeAnchoredCornersFromMotion({
  anchorCorners,
  anchorOrientation = { alpha: 0, beta: 90, gamma: 0 },
  currentOrientation = { alpha: 0, beta: 90, gamma: 0 },
  anchorDistanceM = 2.2,
  currentDistanceM = 2.2,
  sceneW = 800,
  sceneH = 540,
  fovDeg = 62,
  opticalShiftPx = [0, 0],
  opticalScale = 1,
}) {
  if (!Array.isArray(anchorCorners) || anchorCorners.length !== 4) return null;

  const pxPerDeg = sceneW / Math.max(30, fovDeg);
  const dYawDeg = wrapAngleDeg((currentOrientation.alpha || 0) - (anchorOrientation.alpha || 0));
  const dPitchDeg = clamp((currentOrientation.beta || 0) - (anchorOrientation.beta || 0), -85, 85);

  // Al girar el teléfono a la derecha (dYaw < 0 en brújula estándar), la escena debe desplazarse a la izquierda
  const rotShiftX = dYawDeg * pxPerDeg;
  const rotShiftY = dPitchDeg * pxPerDeg;

  const distRatio = clamp((anchorDistanceM || 2.2) / Math.max(0.25, currentDistanceM || 2.2), 0.35, 4.5);
  const totalScale = clamp(distRatio * (opticalScale || 1), 0.35, 5.0);

  const cx = sceneW / 2;
  const cy = sceneH / 2;
  const totalShiftX = rotShiftX + (opticalShiftPx?.[0] || 0);
  const totalShiftY = rotShiftY + (opticalShiftPx?.[1] || 0);

  return anchorCorners.map(([x, y]) => {
    const shiftedX = x + totalShiftX;
    const shiftedY = y + totalShiftY;
    return [
      cx + (shiftedX - cx) * totalScale,
      cy + (shiftedY - cy) * totalScale,
    ];
  });
}

/**
 * Rastreador ligero de flujo óptico y expansión radial (acercamiento/alejamiento)
 * sobre frames reducidos del video de la cámara (80×60 px).
 */
export function createOpticalMotionEstimator(doc = typeof document !== 'undefined' ? document : null) {
  const W = 80;
  const H = 60;
  let offCanvas = null;
  let offCtx = null;
  let prevGray = null;
  let currGray = new Uint8Array(W * H);

  let accShiftX = 0;
  let accShiftY = 0;
  let accScale = 1;

  function ensureCanvas() {
    if (offCtx || !doc) return Boolean(offCtx);
    offCanvas = doc.createElement('canvas');
    offCanvas.width = W;
    offCanvas.height = H;
    offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    return Boolean(offCtx);
  }

  function reset() {
    prevGray = null;
    accShiftX = 0;
    accShiftY = 0;
    accScale = 1;
  }

  function samplePatchSad(a, b, x0, y0, pw, ph, dx, dy) {
    let sad = 0;
    let count = 0;
    for (let y = y0; y < y0 + ph; y += 2) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      const rowA = y * W;
      const rowB = ny * W;
      for (let x = x0; x < x0 + pw; x += 2) {
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        sad += Math.abs(a[rowA + x] - b[rowB + nx]);
        count++;
      }
    }
    return count > 0 ? sad / count : 9999;
  }

  function bestPatchShift(a, b, x0, y0, pw, ph, maxR = 4) {
    let bestDx = 0;
    let bestDy = 0;
    let bestErr = Infinity;
    for (let dy = -maxR; dy <= maxR; dy++) {
      for (let dx = -maxR; dx <= maxR; dx++) {
        const err = samplePatchSad(a, b, x0, y0, pw, ph, dx, dy);
        if (err < bestErr) {
          bestErr = err;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
    return { dx: bestDx, dy: bestDy, err: bestErr };
  }

  function step(videoEl, sceneW = 800, sceneH = 540) {
    if (!videoEl || videoEl.readyState < 2 || !ensureCanvas()) {
      return { shiftX: accShiftX, shiftY: accShiftY, scale: accScale };
    }

    offCtx.drawImage(videoEl, 0, 0, W, H);
    const imgData = offCtx.getImageData(0, 0, W, H).data;
    for (let i = 0, p = 0; i < currGray.length; i++, p += 4) {
      currGray[i] = (imgData[p] * 77 + imgData[p + 1] * 150 + imgData[p + 2] * 29) >> 8;
    }

    if (!prevGray) {
      prevGray = new Uint8Array(currGray);
      return { shiftX: accShiftX, shiftY: accShiftY, scale: accScale };
    }

    // Bloque central para traslación general
    const center = bestPatchShift(prevGray, currGray, 26, 18, 28, 24, 4);
    if (center.err < 28) {
      const scaleX = sceneW / W;
      const scaleY = sceneH / H;
      accShiftX = accShiftX * 0.85 + (accShiftX + center.dx * scaleX) * 0.15;
      accShiftY = accShiftY * 0.85 + (accShiftY + center.dy * scaleY) * 0.15;

      // Divergencia radial (cuadrantes izq vs der) para detectar acercamiento físico
      const left = bestPatchShift(prevGray, currGray, 10, 20, 18, 20, 3);
      const right = bestPatchShift(prevGray, currGray, 52, 20, 18, 20, 3);
      const divergence = (right.dx - left.dx);
      if (Math.abs(divergence) >= 1 && left.err < 30 && right.err < 30) {
        const deltaScale = 1 + clamp(divergence * 0.012, -0.05, 0.05);
        accScale = clamp(accScale * deltaScale, 0.5, 3.5);
      }
    }

    prevGray.set(currGray);
    return { shiftX: accShiftX, shiftY: accShiftY, scale: accScale };
  }

  return {
    reset,
    step,
    getState: () => ({ shiftX: accShiftX, shiftY: accShiftY, scale: accScale }),
  };
}

/**
 * Verifica si el dispositivo/navegador soporta WebXR Realidad Aumentada inmersiva.
 */
export async function isWebXrArSupported(win = typeof window !== 'undefined' ? window : null) {
  try {
    const xr = win?.navigator?.xr;
    if (!xr || typeof xr.isSessionSupported !== 'function') return false;
    return await xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}
