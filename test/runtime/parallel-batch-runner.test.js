const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeConcurrency, runBatch } = require("../../runtime/server/parallel-batch-runner");
const { runHeadlessBatch } = require("../../src/main/desktop-runtime-routes");

// A controllable async job: resolves only when release() is called, so a test can
// hold jobs "in flight" and observe how many run at once.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("Z10 normalizeConcurrency clamps to >= 1 integers", () => {
  assert.equal(normalizeConcurrency(3), 3);
  assert.equal(normalizeConcurrency(0), 1);
  assert.equal(normalizeConcurrency(-5), 1);
  assert.equal(normalizeConcurrency(2.9), 2);
  assert.equal(normalizeConcurrency("bad", 4), 4);
});

test("Z10 runBatch never exceeds the concurrency ceiling", async () => {
  const gates = Array.from({ length: 6 }, () => deferred());
  let active = 0;
  let peak = 0;
  const batch = runBatch({
    items: gates,
    concurrency: 2,
    runItem: async (gate) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return "done";
    },
  });
  // Let the pool spin up, then release jobs one at a time.
  for (const gate of gates) {
    await Promise.resolve();
    gate.resolve();
  }
  const { results, stats } = await batch;
  assert.equal(results.length, 6);
  assert.ok(peak <= 2, `peak ${peak} exceeded ceiling 2`);
  assert.ok(stats.peakConcurrency <= 2);
  assert.equal(stats.okCount, 6);
});

test("Z10 runBatch actually parallelizes (peak reaches K)", async () => {
  const gates = Array.from({ length: 4 }, () => deferred());
  let active = 0;
  let peak = 0;
  const batch = runBatch({
    items: gates,
    concurrency: 3,
    runItem: async (gate) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(peak >= 3, `expected 3 in flight, saw ${peak}`);
  gates.forEach((gate) => gate.resolve());
  const { stats } = await batch;
  assert.equal(stats.peakConcurrency, 3);
});

test("Z10 runBatch preserves order and isolates per-item failures", async () => {
  const { results, stats } = await runBatch({
    items: [1, 2, 3],
    concurrency: 2,
    runItem: async (n) => {
      if (n === 2) {
        throw Object.assign(new Error("boom"), { code: "kaboom" });
      }
      return n * 10;
    },
  });
  assert.equal(results[0].value, 10);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, "kaboom");
  assert.equal(results[2].value, 30);
  assert.equal(stats.okCount, 2);
  assert.equal(stats.errorCount, 1);
});

test("Z10 runBatch runs a single-item batch without hanging", async () => {
  const { stats } = await runBatch({ items: ["only"], concurrency: 4, runItem: async () => "ok" });
  assert.equal(stats.total, 1);
  assert.equal(stats.peakConcurrency, 1);
});

// --- Route handler: overflow queues, runs stay independent (Z10-2/Z10-3) ---

test("Z10 runHeadlessBatch fans items to createTestSession with the shared context", async () => {
  const seen = [];
  let active = 0;
  let peak = 0;
  const browserContext = { launchOptions: { args: ["--disable-web-security"] }, contextOptions: { bypassCSP: true } };
  const fakeCreateTestSession = async (request, options) => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push({ request, browserContext: options.browserContext });
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return { response: { ok: true, sessionId: `s-${request.testFilePath}`, status: "passed" } };
  };
  const { statusCode, payload } = await runHeadlessBatch(
    {
      concurrency: 2,
      authProfile: "demo-local",
      items: [
        { testFilePath: "a.json" },
        { testFilePath: "b.json" },
        { testFilePath: "c.json", authProfile: "other" },
      ],
    },
    {
      runBatch,
      createTestSession: fakeCreateTestSession,
      store: {},
      browserContext,
      defaultConcurrency: 2,
    },
  );
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.sessions.length, 3);
  assert.equal(payload.data.stats.peakConcurrency <= 2, true, "overflow beyond K must queue");
  // shared default applied, per-item override wins
  assert.equal(seen.find((s) => s.request.testFilePath === "a.json").request.authProfile, "demo-local");
  assert.equal(seen.find((s) => s.request.testFilePath === "c.json").request.authProfile, "other");
  // every item got the aligned browser context
  assert.ok(seen.every((s) => s.browserContext === browserContext));
});

test("Z10 runHeadlessBatch rejects an empty batch", async () => {
  const { statusCode, payload } = await runHeadlessBatch({ items: [] }, { runBatch, createTestSession: async () => ({}) });
  assert.equal(statusCode, 400);
  assert.equal(payload.error.code, "empty-batch");
});
