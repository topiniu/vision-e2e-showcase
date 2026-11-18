const { Buffer } = require('buffer');
const { URL } = require('node:url');
const http = require('node:http');
const https = require('node:https');
const DEFAULT_ENDPOINT = 'http://127.0.0.1:32145';
const DEFAULT_TIMEOUT_MS = 1500;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toPositiveNumber = (value) =>
  Number.isFinite(value) && value > 0 ? value : null;

const createNodeFetch = () => (input, init = {}) => new Promise((resolve, reject) => {
  const targetUrl = typeof input === 'string' ? new URL(input) : new URL(String(input));
  const isHttps = targetUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  const requestOptions = {
    method: init.method || 'GET',
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: `${targetUrl.pathname}${targetUrl.search}`,
    headers: init.headers,
  };

  let settled = false;
  const settleResolve = (value) => {
    if (!settled) {
      settled = true;
      resolve(value);
    }
  };
  const settleReject = (error) => {
    if (!settled) {
      settled = true;
      reject(error);
    }
  };

  const req = transport.request(requestOptions, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const text = buffer.toString('utf-8');
      const response = {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
        json: async () => {
          if (!text) {
            return null;
          }
          try {
            return JSON.parse(text);
          } catch (error) {
            const parseError = new Error('Failed to parse JSON response');
            parseError.cause = error;
            throw parseError;
          }
        },
        text: async () => text,
      };
      settleResolve(response);
    });
    res.on('error', (error) => {
      settleReject(error);
    });
  });

  req.on('error', (error) => {
    settleReject(error);
  });

  if (init.body) {
    req.write(init.body);
  }
  req.end();

  if (init.signal) {
    const abortHandler = () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      req.destroy(abortError);
      settleReject(abortError);
    };
    if (init.signal.aborted) {
      abortHandler();
    } else {
      init.signal.addEventListener('abort', abortHandler, { once: true });
      req.on('close', () => {
        init.signal.removeEventListener('abort', abortHandler);
      });
    }
  }
});

let cachedFetch = null;

function ensureFetch() {
  if (cachedFetch) {
    return cachedFetch;
  }
  if (typeof globalThis.fetch === 'function') {
    cachedFetch = globalThis.fetch.bind(globalThis);
    return cachedFetch;
  }
  cachedFetch = createNodeFetch();
  return cachedFetch;
}

function ensureDataUrl(frame) {
  if (typeof frame?.dataURL === 'string' && frame.dataURL.startsWith('data:')) {
    return frame.dataURL;
  }
  if (Buffer.isBuffer(frame?.pixels)) {
    const mime = frame?.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${frame.pixels.toString('base64')}`;
  }
  throw new Error('paddle-frame-missing-data');
}

class PaddleOcrClient {
  constructor({
    endpoint = process.env.PADDLE_OCR_URL || DEFAULT_ENDPOINT,
    timeoutMs = Number(process.env.PADDLE_OCR_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    lang = process.env.PPOCR_LANG || 'ch',
    disableAngleCls =
      process.env.PPOCR_DISABLE_CLS === '1' ||
      process.env.PPOCR_DISABLE_CLS === 'true',
    enableMp =
      process.env.PPOCR_ENABLE_MP === '1' ||
      process.env.PPOCR_ENABLE_MP === 'true',
    minScore = Number(process.env.PPOCR_MIN_SCORE),
  } = {}) {
    this.fetch = ensureFetch();
    this.endpoint = String(endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.lang = lang;
    this.disableAngleCls = Boolean(disableAngleCls);
    this.enableMp = Boolean(enableMp);
    this.minScore = Number.isFinite(minScore) ? minScore : null;
    this.backend = 'paddle';
    this.lastServiceMeta = null;
  }

  get url() {
    return `${this.endpoint}/ocr`;
  }

  normalizeRois(rois, frameWidth, frameHeight) {
    const safeWidth =
      Number.isFinite(frameWidth) && frameWidth > 0 ? frameWidth : 1;
    const safeHeight =
      Number.isFinite(frameHeight) && frameHeight > 0 ? frameHeight : 1;

    if (!Array.isArray(rois) || !rois.length) {
      return [
        {
          x: 0,
          y: 0,
          width: safeWidth,
          height: safeHeight,
          index: 0,
        },
      ];
    }

    return rois.map((roi, index) => {
      const left = clamp(Math.round(roi?.x ?? 0), 0, safeWidth - 1);
      const top = clamp(Math.round(roi?.y ?? 0), 0, safeHeight - 1);
      const width = clamp(
        Math.round(roi?.width ?? safeWidth),
        1,
        safeWidth - left,
      );
      const height = clamp(
        Math.round(roi?.height ?? safeHeight),
        1,
        safeHeight - top,
      );
      return {
        x: left,
        y: top,
        width,
        height,
        index,
      };
    });
  }

  buildFrameSize(frame, opts, fallbackWidth, fallbackHeight) {
    const widthCandidate = Number.isFinite(frame?.width) ? frame.width : Number(opts?.frameSize?.width);
    const heightCandidate = Number.isFinite(frame?.height) ? frame.height : Number(opts?.frameSize?.height);
    const width = Number.isFinite(widthCandidate) ? widthCandidate : fallbackWidth;
    const height = Number.isFinite(heightCandidate) ? heightCandidate : fallbackHeight;
    const dipWidth =
      toPositiveNumber(frame?.dipWidth) ??
      toPositiveNumber(opts?.frameSize?.dipWidth) ??
      width;
    const dipHeight =
      toPositiveNumber(frame?.dipHeight) ??
      toPositiveNumber(opts?.frameSize?.dipHeight) ??
      height;
    const dprX =
      toPositiveNumber(frame?.dpr?.x) ??
      toPositiveNumber(opts?.frameSize?.dpr?.x);
    const dprY =
      toPositiveNumber(frame?.dpr?.y) ??
      toPositiveNumber(opts?.frameSize?.dpr?.y);

    return {
      width,
      height,
      dipWidth,
      dipHeight,
      dpr: {
        x: toPositiveNumber(dprX),
        y: toPositiveNumber(dprY),
      },
    };
  }

  buildOptions() {
    const opts = {
      lang: this.lang,
      disableAngleCls: this.disableAngleCls,
    };
    if (this.enableMp) {
      opts.enableMp = true;
    }
    if (Number.isFinite(this.minScore)) {
      opts.minScore = this.minScore;
    }
    return opts;
  }

  async analyze({ frame, rois, opts }) {
    if (!frame) {
      throw new Error('paddle-frame-required');
    }

    const dataUrl = ensureDataUrl(frame);
    const frameWidth = Number.isFinite(frame?.width)
      ? frame.width
      : Number(opts?.frameSize?.width);
    const frameHeight = Number.isFinite(frame?.height)
      ? frame.height
      : Number(opts?.frameSize?.height);

    if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) {
      throw new Error('paddle-frame-dimensions-missing');
    }

    const normalizedRois = this.normalizeRois(rois, frameWidth, frameHeight);
    const timeoutMs = Math.max(
      250,
      Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : this.timeoutMs,
    );

    const requestPayload = {
      frameId: frame.frameId ?? opts?.frameId ?? null,
      ts: Number.isFinite(frame?.captureCompletedAt)
        ? frame.captureCompletedAt
        : Number.isFinite(frame?.epoch)
        ? frame.epoch
        : Date.now(),
      image: {
        dataUrl,
      },
      rois: normalizedRois.map((roi) => ({
        x: roi.x,
        y: roi.y,
        width: roi.width,
        height: roi.height,
      })),
      frameSize: this.buildFrameSize(frame, opts, frameWidth, frameHeight),
      timeoutMs,
      options: this.buildOptions(),
      source: opts?.source ?? null,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 50);

    let response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        return { detections: [], timedOut: true, backend: this.backend };
      }
      throw Object.assign(new Error('paddle-request-failed'), {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errorDetail = null;
      try {
        errorDetail = await response.json();
      } catch (_error) {
        errorDetail = null;
      }
      const reason =
        errorDetail?.detail?.message ??
        errorDetail?.error ??
        `HTTP ${response.status}`;
      throw Object.assign(new Error('paddle-response-error'), {
        status: response.status,
        detail: reason,
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw Object.assign(new Error('paddle-json-parse-failed'), { cause: error });
    }

    this.lastServiceMeta = payload?.service ?? null;

    if (payload?.timedOut || payload?.status === 'timeout') {
      return {
        detections: [],
        timedOut: true,
        backend: this.backend,
        service: payload?.service ?? null,
      };
    }

    const detections = Array.isArray(payload?.detections)
      ? payload.detections
      : [];

    for (const det of detections) {
      if (det && det.extras) {
        det.extras.backend = this.backend;
      } else if (det) {
        det.extras = { backend: this.backend };
      }
    }

    return {
      detections,
      backend: this.backend,
      service: payload?.service ?? null,
      elapsedMs: payload?.elapsedMs ?? null,
      status: payload?.status ?? null,
    };
  }

  async dispose() {}
}

module.exports = { PaddleOcrClient };
