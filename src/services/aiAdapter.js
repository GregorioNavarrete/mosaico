import { preprocessRgba } from '../shared/preprocess.js';

function readEnvConfig() {
  const rawProvider = typeof process.env.AI_PROVIDER === 'string' ? process.env.AI_PROVIDER.trim() : '';
  const provider = rawProvider ? rawProvider.toLowerCase() : 'local';
  const apiKey = typeof process.env.AI_API_KEY === 'string' ? process.env.AI_API_KEY.trim() : '';
  const endpoint = typeof process.env.AI_ENDPOINT === 'string' ? process.env.AI_ENDPOINT.trim() : '';
  return { provider, apiKey, endpoint };
}

/**
 * Devuelve el estado del adaptador de preprocesado artístico sin exponer secretos.
 *
 * @returns {{ provider: string, externalConfigured: boolean, mode: 'local-free' | 'external-hybrid' }}
 */
export function getAiAdapterStatus() {
  const { provider, apiKey } = readEnvConfig();
  const externalConfigured = provider !== 'local' && apiKey.length > 0;
  const mode = externalConfigured ? 'external-hybrid' : 'local-free';

  return {
    provider,
    externalConfigured,
    mode,
  };
}

function sanitizeExternalError(err) {
  const msg = String(err?.message || 'Error en proveedor externo').slice(0, 180);
  const { apiKey } = readEnvConfig();
  if (apiKey && msg.includes(apiKey)) {
    return 'Error en proveedor externo (detalle redactado por seguridad).';
  }
  return msg;
}

async function invokeExternalHook({ rgba, width, height, options, provider, apiKey, endpoint }) {
  if (typeof options.externalHook === 'function') {
    return options.externalHook({
      rgba,
      width,
      height,
      options: { ...options, externalHook: undefined },
      provider,
      apiKey,
    });
  }

  if (!endpoint) {
    return null;
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 15000;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-AI-Provider': provider,
    },
    body: JSON.stringify({
      provider,
      width,
      height,
      preprocessMode: options.preprocessMode || 'none',
      removeBackground: Boolean(options.removeBackground),
      toleranceDeltaE: options.toleranceDeltaE ?? 18,
      rgbaBase64: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).toString('base64'),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} desde proveedor externo`);
  }

  const json = await response.json();
  if (!json || typeof json.rgbaBase64 !== 'string') {
    throw new Error('Respuesta inválida del proveedor externo.');
  }

  const decoded = Buffer.from(json.rgbaBase64, 'base64');
  const outW = Number.isInteger(json.width) ? json.width : width;
  const outH = Number.isInteger(json.height) ? json.height : height;
  if (decoded.length < outW * outH * 4) {
    throw new Error('Buffer RGBA externo insuficiente.');
  }

  return {
    data: new Uint8ClampedArray(decoded.subarray(0, outW * outH * 4)),
    width: outW,
    height: outH,
  };
}

/**
 * Ejecuta el preprocesado artístico sobre un buffer RGBA.
 * Por defecto corre 100% local mediante `preprocessRgba` (`bilateral`, `kuwahara`, `removeBackground`)
 * y mantiene un hook opcional para proveedor externo configurado vía `.env` (`AI_PROVIDER`, `AI_API_KEY`, `AI_ENDPOINT`).
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{
 *   preprocessMode?: 'none' | 'bilateral' | 'kuwahara',
 *   removeBackground?: boolean,
 *   toleranceDeltaE?: number,
 *   bgColor?: string | { r: number, g: number, b: number } | [number, number, number] | null,
 *   radius?: number,
 *   spatialSigma?: number,
 *   rangeSigma?: number,
 *   clearAlpha?: boolean,
 *   allowFallback?: boolean,
 *   externalHook?: Function,
 *   timeoutMs?: number
 * }} [options={}]
 * @returns {Promise<{
 *   data: Uint8ClampedArray,
 *   width: number,
 *   height: number,
 *   provider: string,
 *   mode: 'local-free' | 'external-hybrid',
 *   externalUsed: boolean,
 *   fallbackReason?: string
 * }>}
 */
export async function runArtisticPreprocess(rgba, width, height, options = {}) {
  const status = getAiAdapterStatus();
  const { apiKey, endpoint } = readEnvConfig();
  const allowFallback = options?.allowFallback !== false;

  if (status.mode === 'external-hybrid' && (typeof options?.externalHook === 'function' || endpoint)) {
    try {
      const ext = await invokeExternalHook({
        rgba,
        width,
        height,
        options,
        provider: status.provider,
        apiKey,
        endpoint,
      });

      if (ext && ext.data && Number.isInteger(ext.width) && Number.isInteger(ext.height)) {
        return {
          data: ext.data instanceof Uint8ClampedArray ? ext.data : new Uint8ClampedArray(ext.data),
          width: ext.width,
          height: ext.height,
          provider: status.provider,
          mode: status.mode,
          externalUsed: true,
        };
      }
    } catch (err) {
      if (!allowFallback) {
        throw new Error(sanitizeExternalError(err));
      }
      const localFallback = preprocessRgba(rgba, width, height, options);
      return {
        data: localFallback.data,
        width: localFallback.width,
        height: localFallback.height,
        provider: 'local',
        mode: status.mode,
        externalUsed: false,
        fallbackReason: sanitizeExternalError(err),
      };
    }
  }

  const localResult = preprocessRgba(rgba, width, height, options);
  return {
    data: localResult.data,
    width: localResult.width,
    height: localResult.height,
    provider: 'local',
    mode: status.mode,
    externalUsed: false,
  };
}
