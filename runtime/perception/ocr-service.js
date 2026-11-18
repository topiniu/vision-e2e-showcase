const { createWorker } = require("tesseract.js");
const { PaddleOcrClient } = require("../../src/main/ocr-paddle-client");
const { parseTsv, parseHocr, parseBlocks } = require("../../src/main/ocr-universal");

const DEFAULT_TESSERACT_LANGUAGES = "chi_sim+eng";

// The same tsv -> hocr -> blocks precedence `analyzeImage` used, applied to a
// recognition result that has already been produced. Splitting it out is what
// lets `runTesseract` recognise once instead of twice.
function parseRecognitionWords(data = {}) {
  let words = parseTsv(data.tsv);
  if (words.length) {
    return { words, source: "tsv" };
  }
  words = parseHocr(data.hocr);
  if (words.length) {
    return { words, source: "hocr" };
  }
  return { words: parseBlocks(data.blocks), source: "blocks" };
}

function bufferToDataUrl(buffer, mime = "image/png") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

class OcrService {
  constructor(options = {}) {
    this.paddleEnabled =
      options.paddleEnabled ??
      (
        process.env.PADDLE_OCR_ENABLED === "1" ||
        process.env.PADDLE_OCR_ENABLED === "true" ||
        Boolean(process.env.PADDLE_OCR_URL)
      );
    this.tesseractEnabled = options.tesseractEnabled ?? true;
    this.paddleClient = this.paddleEnabled ? new PaddleOcrClient() : null;
    this.worker = null;
  }

  async ensureWorker() {
    if (this.worker) {
      return this.worker;
    }
    this.worker = await createWorker(DEFAULT_TESSERACT_LANGUAGES);
    if (typeof this.worker?.setParameters === "function") {
      await this.worker.setParameters({
        tessedit_pageseg_mode: "3",
        preserve_interword_spaces: "1",
        user_defined_dpi: "240",
      });
    }
    return this.worker;
  }

  async runPaddle({ imageBuffer, width, height }) {
    if (!this.paddleClient) {
      return null;
    }
    const frame = {
      dataURL: bufferToDataUrl(imageBuffer),
      width,
      height,
      format: "png",
    };
    const result = await this.paddleClient.analyze({
      frame,
      rois: [],
      opts: { frameSize: { width, height } },
    });
    return {
      backend: "paddle",
      detections: Array.isArray(result?.detections) ? result.detections : [],
      raw: result,
    };
  }

  async runTesseract({ imageBuffer }) {
    if (!this.tesseractEnabled) {
      return null;
    }
    const worker = await this.ensureWorker();
    // v1.8 perf: ONE recognition pass, not two.
    //
    // This used to call `analyzeImage({ worker, ... })` — which itself runs
    // `worker.recognize(...)` — and then run `worker.recognize(...)` again on the
    // same buffer. Tesseract with `chi_sim+eng` on a 1280x720 screenshot is
    // seconds of CPU, so every OCR fallback and every `needRes` step paid for it
    // twice. The recognition output is now produced once and the parsers
    // (tsv -> hocr -> blocks) are applied to that single result, which is what
    // `analyzeImage` was doing internally anyway.
    const result = await worker.recognize(
      imageBuffer,
      {},
      { tsv: true, hocr: true, blocks: true },
    );
    const data = result?.data ?? {};
    const directWords = Array.isArray(data.words) ? data.words : [];
    const parsed = parseRecognitionWords(data);
    const parsedWords = parsed.words;
    const words = directWords.length ? directWords : parsedWords;
    return {
      backend: "tesseract",
      detections: words.map((word, index) => ({
        id: `ocr-${index + 1}`,
        text: word.text,
        score:
          Number.isFinite(word.confidence) ? word.confidence / 100 : 0.5,
        bbox: word.bbox
          ? {
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0,
            }
          : null,
        kind: "text",
      })),
      // v1.8 perf: `raw` used to spread the whole tesseract `data` object — the
      // full hOCR document, the tsv dump and the block tree. That object is
      // carried in the step trace *and* written to `NN-ocr.json`, so a single
      // OCR step could add megabytes to evidence. The detections above are the
      // consumable result; `raw` keeps only what a human triaging an OCR
      // mismatch actually reads.
      raw: {
        text: typeof data.text === "string" ? data.text : "",
        confidence: Number.isFinite(data.confidence) ? data.confidence : null,
        version: data.version ?? null,
        psm: data.psm ?? null,
        oem: data.oem ?? null,
        imageWidth: data.imageWidth ?? null,
        imageHeight: data.imageHeight ?? null,
        parsedSource: parsed?.source ?? null,
        parsedWordCount: parsedWords.length,
        directWordCount: directWords.length,
      },
    };
  }

  async runOcr({ imageBuffer, width = 1280, height = 720 }) {
    if (!imageBuffer) {
      return {
        backend: null,
        detections: [],
        raw: null,
        error: "ocr-image-required",
      };
    }

    try {
      const paddleResult = await this.runPaddle({ imageBuffer, width, height });
      if (paddleResult) {
        return paddleResult;
      }
    } catch (error) {
      if (!this.tesseractEnabled) {
        return {
          backend: "paddle",
          detections: [],
          raw: null,
          error: error.message || String(error),
        };
      }
    }

    try {
      const tesseractResult = await this.runTesseract({ imageBuffer });
      if (tesseractResult) {
        return tesseractResult;
      }
    } catch (error) {
      return {
        backend: "tesseract",
        detections: [],
        raw: null,
        error: error.message || String(error),
      };
    }

    return {
      backend: null,
      detections: [],
      raw: null,
      error: "ocr-disabled",
    };
  }

  async dispose() {
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch (_error) {
        // Ignore worker shutdown failures.
      }
    }
    this.worker = null;
  }
}

module.exports = {
  OcrService,
};
