"use strict";


const { PNG } = require("pngjs");

function readJpegSize(buffer) {
  // Walk the JPEG marker segments to the first SOFn.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 all carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function detectImageFormat(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") {
    return "gif";
  }
  return "unknown";
}

// "Ink" = a pixel that differs from the background by more than `tolerance`, and
// is not (nearly) transparent. Background is sampled from the four corners rather
// than assumed white, so a dark-theme export is not reported as 100% ink.
function analyzePngPixels(png, { tolerance = 12, edgeRows = 8, edgeCols = 8 } = {}) {
  const { width, height, data } = png;
  const at = (x, y) => {
    const index = (y * width + x) * 4;
    return [data[index], data[index + 1], data[index + 2], data[index + 3]];
  };
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const background = [0, 1, 2].map((channel) =>
    Math.round(corners.reduce((sum, pixel) => sum + pixel[channel], 0) / corners.length),
  );
  const isInk = (pixel) => {
    if (pixel[3] < 16) {
      return false; // transparent
    }
    return (
      Math.abs(pixel[0] - background[0]) > tolerance ||
      Math.abs(pixel[1] - background[1]) > tolerance ||
      Math.abs(pixel[2] - background[2]) > tolerance
    );
  };

  let inkCount = 0;
  let bottomInk = 0;
  let topInk = 0;
  let lastInkRow = -1;
  let lastInkColumn = -1;
  const bottomRows = Math.min(Math.max(1, edgeRows), height);
  const topRows = Math.min(Math.max(1, edgeRows), height);
  const rightCols = Math.min(Math.max(1, edgeCols), width);
  let rightInk = 0;
  let leftInk = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isInk(at(x, y))) {
        continue;
      }
      inkCount += 1;
      lastInkRow = y;
      if (x > lastInkColumn) {
        lastInkColumn = x;
      }
      if (y >= height - bottomRows) {
        bottomInk += 1;
      }
      if (y < topRows) {
        topInk += 1;
      }
      if (x >= width - rightCols) {
        rightInk += 1;
      }
      if (x < rightCols) {
        leftInk += 1;
      }
    }
  }
  const total = width * height;
  return {
    width,
    height,
    background,
    inkRatio: total ? inkCount / total : 0,
    bottomEdgeInkRatio: bottomRows * width ? bottomInk / (bottomRows * width) : 0,
    topEdgeInkRatio: topRows * width ? topInk / (topRows * width) : 0,
    rightEdgeInkRatio: rightCols * height ? rightInk / (rightCols * height) : 0,
    leftEdgeInkRatio: rightCols * height ? leftInk / (rightCols * height) : 0,
    edgeRows: bottomRows,
    edgeCols: rightCols,
    // Where content actually stops. `height - 1 - lastInkRow` is the bottom
    // margin in pixels: 0 means the content runs into the very last row, which
    // is the signature of a cut-off export.
    lastInkRow,
    lastInkColumn,
    bottomMarginPx: lastInkRow >= 0 ? height - 1 - lastInkRow : null,
    rightMarginPx: lastInkColumn >= 0 ? width - 1 - lastInkColumn : null,
  };
}

function inspectImage(buffer, options = {}) {
  const format = detectImageFormat(buffer);
  if (format === "png") {
    let png;
    try {
      png = PNG.sync.read(buffer);
    } catch (error) {
      return { format, ok: false, error: `png-decode-failed: ${error?.message || error}` };
    }
    return { format, ok: true, ...analyzePngPixels(png, options) };
  }
  if (format === "jpeg") {
    const size = readJpegSize(buffer);
    return {
      format,
      ok: true,
      width: size?.width ?? null,
      height: size?.height ?? null,
      pixelsUnavailable:
        "JPEG pixel analysis is not implemented; dimension assertions work, ink/truncation assertions do not. " +
        "Export the artifact as PNG for truncation checks (a lossy format is a poor truncation oracle anyway).",
    };
  }
  return {
    format,
    ok: false,
    error: `unsupported-image-format:${format}`,
    pixelsUnavailable: "only PNG supports pixel-level assertions; JPEG supports dimensions only",
  };
}

module.exports = {
  analyzePngPixels,
  detectImageFormat,
  inspectImage,
  readJpegSize,
};
