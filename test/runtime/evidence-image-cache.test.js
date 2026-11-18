const test = require("node:test");
const assert = require("node:assert/strict");

test("evidence image cache only retains screenshots used by the active view", async () => {
  const { retainEvidenceImageCache } = await import("../../src/panel/lib/evidence-image-cache.mjs");
  const before = { status: "loaded", dataUrl: "data:image/png;base64,before" };
  const after = { status: "loaded", dataUrl: "data:image/png;base64,after" };
  const stale = { status: "loaded", dataUrl: "data:image/png;base64,stale" };
  const cache = {
    "/runs/current-before.png": before,
    "/runs/current-after.png": after,
    "/runs/previous.png": stale,
  };

  const retained = retainEvidenceImageCache(cache, [
    "/runs/current-before.png",
    "/runs/current-after.png",
    "/runs/current-before.png",
  ]);

  assert.deepEqual(Object.keys(retained), [
    "/runs/current-before.png",
    "/runs/current-after.png",
  ]);
  assert.equal(retained["/runs/current-before.png"], before);
  assert.equal(retained["/runs/current-after.png"], after);
  assert.equal(retained["/runs/previous.png"], undefined);
  assert.deepEqual(retainEvidenceImageCache(cache, []), {});
});

test("evidence image cache preserves its reference when the active entries are unchanged", async () => {
  const { retainEvidenceImageCache } = await import("../../src/panel/lib/evidence-image-cache.mjs");
  const cache = {
    "/runs/before.png": { status: "loading" },
    "/runs/after.png": { status: "loaded", dataUrl: "data:image/png;base64,after" },
  };

  assert.equal(
    retainEvidenceImageCache(cache, ["/runs/after.png", "/runs/before.png"]),
    cache,
  );
});
