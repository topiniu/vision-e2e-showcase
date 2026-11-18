const test = require("node:test");
const assert = require("node:assert/strict");
const { isHardTimeoutError } = require("../../runtime/executor/hard-timeout");
const {
  observeNavigationAfterAction,
  readPageReadiness,
  safeCapturePageState,
  safeDetectUiFrameworks,
  settlePageBeforeAction,
} = require("../../runtime/executor/navigation-recovery");
const { capturePageState } = require("../../runtime/perception/page-snapshot");

// REQ-Z12 root cause: `page.evaluate` has no timeout in Playwright, so a wedged
// renderer parks it forever. These tests pin the bound on each probe that runs on
// EVERY step, and pin which of them degrade gracefully vs. surface as a failure.

const PROBE_MS = "60";

function withProbeBudget(run) {
  const previous = process.env.ZHUZHU_PROBE_HARD_TIMEOUT_MS;
  process.env.ZHUZHU_PROBE_HARD_TIMEOUT_MS = PROBE_MS;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) {
        delete process.env.ZHUZHU_PROBE_HARD_TIMEOUT_MS;
      } else {
        process.env.ZHUZHU_PROBE_HARD_TIMEOUT_MS = previous;
      }
    });
}

// A renderer whose main thread is wedged: evaluate never settles, never rejects.
function wedgedPage(overrides = {}) {
  return {
    url: () => "http://localhost:8000/demoCostOrder",
    evaluate: () => new Promise(() => {}),
    screenshot: () => new Promise(() => {}),
    async waitForTimeout() {},
    async waitForLoadState() {},
    ...overrides,
  };
}

test("readPageReadiness is bounded instead of parking forever", async () => {
  await withProbeBudget(async () => {
    const started = Date.now();
    await assert.rejects(() => readPageReadiness(wedgedPage(), { kind: "click" }), isHardTimeoutError);
    assert.ok(Date.now() - started < 3000);
  });
});

test("capturePageState is bounded instead of parking forever", async () => {
  await withProbeBudget(async () => {
    await assert.rejects(() => capturePageState(wedgedPage()), (error) => {
      assert.equal(isHardTimeoutError(error), true);
      assert.match(error.label, /capturePageState/);
      return true;
    });
  });
});

test("a wedged framework probe degrades to the fallback, it does not fail the step", async () => {
  await withProbeBudget(async () => {
    const frameworks = await safeDetectUiFrameworks(wedgedPage(), {}, { forceRefresh: true });
    assert.equal(frameworks.antd.detected, false);
    assert.equal(frameworks.antd.confidence, 0);
  });
});

test("settlePageBeforeAction degrades on a wedged renderer instead of parking", async () => {
  await withProbeBudget(async () => {
    const started = Date.now();
    // Adaptive settle catches probe errors and falls back to a load-state wait.
    await settlePageBeforeAction(wedgedPage(), {
      kind: "click",
      settleStrategy: "adaptive",
      settleMaxMs: 150,
      settleInitialMs: 20,
      timeoutMs: 5000,
    });
    assert.ok(Date.now() - started < 5000, "returned instead of hanging");
  });
});

test("navigation observation records the probe failure and returns instead of parking", async () => {
  await withProbeBudget(async () => {
    const started = Date.now();
    const navigation = await observeNavigationAfterAction(
      wedgedPage(),
      { kind: "openUrl", navigationBehavior: "required", timeoutMs: 20000, waitUntil: "domcontentloaded" },
      { url: "http://localhost:8000/before", title: "before" },
    );
    // This is the exact loop that used to park on its first probe and therefore
    // never re-checked its own `timeoutMs`.
    assert.ok(navigation.error, "the probe timeout is reported, not swallowed silently");
    assert.equal(navigation.observed, false);
    assert.ok(Date.now() - started < 5000, "bounded, and far below the declared 20s");
  });
});

test("a bounded evidence probe surfaces as a hard-timeout error the step layer understands", async () => {
  await withProbeBudget(async () => {
    // safeCapturePageState has a navigation-recovery wrapper but no catch-all, so
    // the error propagates — and executeWithRetries classifies it as a hard
    // timeout (bounded failure), never as an infinite wait.
    await assert.rejects(() => safeCapturePageState(wedgedPage(), {}, {}), isHardTimeoutError);
  });
});

test("healthy probes are untouched by the bound (no regression)", async () => {
  const healthy = {
    url: () => "http://x/y",
    async evaluate() {
      return {
        url: "http://x/y",
        title: "t",
        text: "hello",
        interactables: [],
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
      };
    },
    async waitForTimeout() {},
    async waitForLoadState() {},
  };
  const state = await capturePageState(healthy);
  assert.equal(state.title, "t");
  assert.equal(state.text, "hello");
  const readiness = await readPageReadiness(healthy, { kind: "click" });
  assert.equal(readiness.url, "http://x/y");
});
