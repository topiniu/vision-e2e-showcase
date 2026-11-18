const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");

function normalizeClip(region) {
  if (!region || typeof region !== "object") {
    return null;
  }
  const x = Math.max(0, Math.floor(region.x ?? 0));
  const y = Math.max(0, Math.floor(region.y ?? 0));
  const width = Math.max(1, Math.floor(region.width ?? 1));
  const height = Math.max(1, Math.floor(region.height ?? 1));
  return { x, y, width, height };
}

function cropPng(png, clip) {
  if (!clip) {
    return png;
  }
  const width = Math.min(clip.width, png.width - clip.x);
  const height = Math.min(clip.height, png.height - clip.y);
  const output = new PNG({ width, height });
  PNG.bitblt(png, output, clip.x, clip.y, width, height, 0, 0);
  return output;
}

function computeBounds(diffPng) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < diffPng.height; y += 1) {
    for (let x = 0; x < diffPng.width; x += 1) {
      const index = (y * diffPng.width + x) * 4;
      const alpha = diffPng.data[index + 3];
      if (alpha === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function computeImageDiff(beforeBuffer, afterBuffer, options = {}) {
  if (!beforeBuffer || !afterBuffer) {
    return {
      changed: false,
      ratio: 0,
      diffPixels: 0,
      threshold: options.threshold ?? 0.02,
      bounds: null,
    };
  }

  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  const clip = normalizeClip(options.region);
  const beforePng = cropPng(before, clip);
  const afterPng = cropPng(after, clip);

  if (
    beforePng.width !== afterPng.width ||
    beforePng.height !== afterPng.height
  ) {
    return {
      changed: true,
      ratio: 1,
      diffPixels: beforePng.width * beforePng.height,
      threshold: options.threshold ?? 0.02,
      bounds: {
        x: 0,
        y: 0,
        width: Math.max(beforePng.width, afterPng.width),
        height: Math.max(beforePng.height, afterPng.height),
      },
    };
  }

  const diff = new PNG({ width: beforePng.width, height: beforePng.height });
  const diffPixels = pixelmatch(
    beforePng.data,
    afterPng.data,
    diff.data,
    beforePng.width,
    beforePng.height,
    {
      threshold: options.pixelThreshold ?? 0.1,
      includeAA: false,
    },
  );

  const totalPixels = beforePng.width * beforePng.height;
  const ratio = totalPixels > 0 ? diffPixels / totalPixels : 0;
  const threshold = options.threshold ?? 0.02;

  return {
    changed: ratio >= threshold,
    ratio,
    diffPixels,
    threshold,
    bounds: computeBounds(diff),
    width: beforePng.width,
    height: beforePng.height,
  };
}

module.exports = {
  computeImageDiff,
};
