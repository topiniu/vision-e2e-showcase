const { createWorker } = require('tesseract.js');

const clean = (value) =>
  typeof value === 'string' ? value.replace(/^\uFEFF/, '').trim() : value;

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function parseTsv(tsv) {
  if (!tsv || !tsv.trim()) return [];

  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  // 判断首行是否为表头：出现非数字/包含level/left这类字段则认为是表头
  const firstCols = lines[0].split('\t');
  const maybeHeader = /[A-Za-z]/.test(lines[0]) || firstCols.includes('level');

  let rows;
  if (maybeHeader) {
    // —— 带表头 —— //
    const clean = s => s.replace(/^\uFEFF/, '').trim();
    const header = firstCols.map(clean);
    const colIndex = Object.fromEntries(header.map((h, i) => [h, i]));
    const need = ['level', 'left', 'top', 'width', 'height', 'text', 'conf', 'word_num'];
    // 宽松兜底匹配（防止大小写或空白差异）
    for (const k of need) {
      if (!(k in colIndex)) {
        const i = header.findIndex(h => clean(h).toLowerCase() === k);
        if (i !== -1) colIndex[k] = i;
      }
    }
    const get = (cols, k) => {
      const i = colIndex[k];
      return i != null ? cols[i] : undefined;
    };

    rows = lines.slice(1) // 去掉表头
      .map(l => l.split('\t'))
      .filter(cols => {
        const level = get(cols, 'level');
        const wordNum = Number(get(cols, 'word_num'));
        const text = (get(cols, 'text') || '').trim();
        // 常规：level=5 是词；兜底：word_num>0 且有 text 也算词
        return (level === '5') || (wordNum > 0 && text);
      })
      .map(cols => {
        const left   = Number(get(cols, 'left')   || 0);
        const top    = Number(get(cols, 'top')    || 0);
        const width  = Number(get(cols, 'width')  || 0);
        const height = Number(get(cols, 'height') || 0);
        const conf   = Number(get(cols, 'conf')   || -1);
        const text   = (get(cols, 'text') || '').trim();
        return {
          text,
          confidence: conf,
          bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
        };
      });
  } else {
    // —— 无表头：按固定列位解析 —— //
    // 约定列：level page block par line word left top width height conf [text?]
    rows = lines
      .map(l => l.split('\t'))
      .filter(cols => cols[0] === '5') // 词级
      .map(cols => {
        const left   = Number(cols[6]  || 0);
        const top    = Number(cols[7]  || 0);
        const width  = Number(cols[8]  || 0);
        const height = Number(cols[9]  || 0);
        const conf   = Number(cols[10] || -1);
        const text   = (cols[11] || '').trim();
        return {
          text,
          confidence: conf,
          bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
        };
      });
  }

  // 过滤空文本（有时会有空格或噪声）
  return rows.filter(w => w.text);
}

function parseHocr(hocr) {
  if (!hocr || !hocr.trim()) return [];
  const words = [];
  const re = /<span[^>]*class="[^"]*\bocrx_word\b[^"]*"[^>]*title="([^"]+)"[^>]*>(.*?)<\/span>/gis;

  let m;
  while ((m = re.exec(hocr)) !== null) {
    const title = m[1];
    const rawText = m[2]
      .replace(/<[^>]+>/g, '')      // 去掉内部标签
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();

    // 从 title 提取 bbox 和 wconf
    // 形如：bbox 714 776 1007 827; x_wconf 96
    const bboxMatch = /bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i.exec(title);
    const confMatch = /x_wconf\s+(-?\d+(?:\.\d+)?)/i.exec(title);

    if (bboxMatch) {
      const x0 = Number(bboxMatch[1]);
      const y0 = Number(bboxMatch[2]);
      const x1 = Number(bboxMatch[3]);
      const y1 = Number(bboxMatch[4]);
      const conf = confMatch ? Number(confMatch[1]) : -1;

      if (rawText) {
        words.push({
          text: rawText,
          confidence: conf,
          bbox: { x0, y0, x1, y1 },
        });
      }
    }
  }
  return words;
}

function parseBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter(b => b?.bbox && b?.text)
    .map(b => ({
      text: String(b.text || '').trim(),
      confidence: Number(b.confidence ?? -1),
      bbox: { x0: b.bbox.x0, y0: b.bbox.y0, x1: b.bbox.x1, y1: b.bbox.y1 },
    }))
    .filter(b => b.text);
}

function scaleBBox(bbox, naturalW, naturalH, displayW, displayH) {
  const sx = displayW / naturalW;
  const sy = displayH / naturalH;
  return {
    x: bbox.x0 * sx,
    y: bbox.y0 * sy,
    w: (bbox.x1 - bbox.x0) * sx,
    h: (bbox.y1 - bbox.y0) * sy,
  };
}


async function analyzeImage({
  worker,
  image,
  rectangle,
  lang = 'eng',
  psm = 6,
  includeBlocks = true,
} = {}) {
  let ownedWorker = false;
  let activeWorker = worker;
  if (!activeWorker) {
    activeWorker = await createWorker(lang);
    ownedWorker = true;
  }

  if (psm !== undefined && psm !== null) {
    await activeWorker.setParameters({
      tessedit_pageseg_mode: String(psm),
    });
  }

  const recognitionOptions = {};
  if (rectangle) {
    recognitionOptions.rectangle = {
      left: toNumber(rectangle.left ?? rectangle.x ?? 0),
      top: toNumber(rectangle.top ?? rectangle.y ?? 0),
      width: toNumber(
        rectangle.width ??
          rectangle.w ??
          (rectangle.right != null
            ? rectangle.right - toNumber(rectangle.left ?? rectangle.x ?? 0)
            : 0),
      ),
      height: toNumber(
        rectangle.height ??
          rectangle.h ??
          (rectangle.bottom != null
            ? rectangle.bottom - toNumber(rectangle.top ?? rectangle.y ?? 0)
            : 0),
      ),
    };
  }

  const result = await activeWorker.recognize(image, recognitionOptions, { tsv: true });
  const data = result?.data ?? {};

  let words = parseTsv(data.tsv);

  let source = 'tsv';

  if (!words.length) {
    words = parseHocr(data.hocr);
    source = 'hocr';
  }

  if (!words.length && includeBlocks) {
    words = parseBlocks(data.blocks);
    source = 'blocks';
  }

  const meta = {
    confidence: toNumber(data.confidence, -1),
    version: data.version,
    psm: data.psm,
    oem: data.oem,
    rotateRadians: toNumber(data.rotateRadians, 0),
    width: toNumber(data.imageWidth, NaN),
    height: toNumber(data.imageHeight, NaN),
  };

  if (ownedWorker) {
    await activeWorker.terminate();
  }

  return { words, source, meta };
}

module.exports = {
  analyzeImage,
  parseTsv,
  parseHocr,
  parseBlocks,
  scaleBBox,
};
