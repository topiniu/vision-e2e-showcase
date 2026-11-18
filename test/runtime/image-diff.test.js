const test = require("node:test");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");
const { computeImageDiff } = require("../../runtime/perception/image-diff");

function createSolidPng({ width, height, color }) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (width * y + x) * 4;
      png.data[index] = color[0];
      png.data[index + 1] = color[1];
      png.data[index + 2] = color[2];
      png.data[index + 3] = color[3];
    }
  }
  return PNG.sync.write(png);
}

test("computeImageDiff reports no change for identical images", () => {
  const before = createSolidPng({
    width: 4,
    height: 4,
    color: [255, 255, 255, 255],
  });
  const after = createSolidPng({
    width: 4,
    height: 4,
    color: [255, 255, 255, 255],
  });
  const diff = computeImageDiff(before, after, { threshold: 0.01 });
  assert.equal(diff.changed, false);
  assert.equal(diff.ratio, 0);
});

test("computeImageDiff reports change when pixels differ", () => {
  const before = createSolidPng({
    width: 4,
    height: 4,
    color: [255, 255, 255, 255],
  });
  const after = createSolidPng({
    width: 4,
    height: 4,
    color: [0, 0, 0, 255],
  });
  const diff = computeImageDiff(before, after, { threshold: 0.01 });
  assert.equal(diff.changed, true);
  assert.ok(diff.ratio > 0);
});
