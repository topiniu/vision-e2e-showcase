
const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { startHeavyPageServer } = require("../fixtures/heavy-page");
const { capturePageState } = require("../../runtime/perception/page-snapshot");
const { resolveActionTarget } = require("../../runtime/executor/locator-resolver");

// The scenario that used to be pathological: a row-action label matching every
// row, disambiguated by nearText, inside a scope. Pre-v1.8 this cost one
// round-trip per match *plus* a full-document scan per match — measured at
// 22.7s on 3.9k nodes and 132.3s on 9.9k nodes.
const MANY_MATCH_ACTION = {
  kind: "click",
  target: { text: "查看", nearText: "样品名称 7", scope: { testId: "perf-table" } },
};

async function withHeavyPage(nodes, fn) {
  const fixture = await startHeavyPageServer();
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(fixture.url(nodes), { waitUntil: "domcontentloaded" });
    const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
    return await fn(page, domNodes);
  } finally {
    await browser.close();
    await fixture.close();
  }
}

async function elapsed(fn) {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test("the page-state probe is bounded in what it returns, not just in time", async () => {
  await withHeavyPage(20000, async (page, domNodes) => {
    assert.ok(domNodes > 15000, `fixture should be large, got ${domNodes} nodes`);
    const state = await capturePageState(page);

    // The page genuinely has far more text than the cap, so this asserts the cap
    // is doing something rather than that the page happens to be small.
    assert.ok(state.textLength > 20000, `fixture page text should be large, got ${state.textLength}`);
    assert.equal(state.textTruncated, true);
    assert.ok(
      state.text.length <= 4000,
      `page text must stay within the probe budget, got ${state.text.length}`,
    );

    assert.ok(
      state.interactables.length <= 250,
      `interactables must stay within budget, got ${state.interactables.length}`,
    );
    // This page exposes >1000 semantic candidates, so the expensive
    // pointer-affordance scan must not have run.
    assert.equal(state.pointerScanned, false);

    const payloadBytes = Buffer.byteLength(JSON.stringify(state));
    assert.ok(
      payloadBytes < 120 * 1024,
      `page-state payload must stay small (was ${Math.round(payloadBytes / 1024)}KB); ` +
        "this is the value that gets multiplied by two per step in report.json",
    );
  });
});

test("a truncated page-state sample says so instead of looking complete", async () => {
  await withHeavyPage(20000, async (page) => {
    const state = await capturePageState(page);
    // The point of the flag: a consumer must be able to tell "the page had this
    // little text" from "we stopped reading". Silent truncation reads as the
    // former and is how evidence starts lying.
    assert.equal(state.textTruncated, true);
    assert.ok(state.textLength > state.text.length);
  });
});

test("resolving a many-match scoped target is bounded, not quadratic", async (t) => {
  const small = await withHeavyPage(4000, async (page, domNodes) => ({
    domNodes,
    ms: await elapsed(() => resolveActionTarget(page, MANY_MATCH_ACTION).catch(() => null)),
  }));
  const large = await withHeavyPage(10000, async (page, domNodes) => ({
    domNodes,
    ms: await elapsed(() => resolveActionTarget(page, MANY_MATCH_ACTION).catch(() => null)),
  }));

  t.diagnostic(
    `${small.domNodes} nodes: ${Math.round(small.ms)}ms | ${large.domNodes} nodes: ${Math.round(large.ms)}ms`,
  );

  // Absolute ceiling. Pre-v1.8 the 10k case took ~132 seconds; 8s leaves a 16x
  // margin over the current ~0.6s, which is wide enough for a loaded CI box and
  // still nowhere near the regression it guards.
  assert.ok(
    large.ms < 8000,
    `resolution on a ${large.domNodes}-node page took ${Math.round(large.ms)}ms; ` +
      "the pre-v1.8 per-candidate round-trip screen is back",
  );

  // Growth. The DOM grows ~2.5x between the two sizes: linear screening lands
  // near 2.5x, the old quadratic screening landed near 6x. 4x is the line.
  const domRatio = large.domNodes / small.domNodes;
  const timeRatio = large.ms / Math.max(small.ms, 1);
  assert.ok(
    timeRatio < domRatio * 1.6,
    `resolution time grew ${timeRatio.toFixed(2)}x for a ${domRatio.toFixed(2)}x DOM — ` +
      "screening looks superlinear again",
  );
});

test("candidate screening reports when it capped the candidate set", async () => {
  await withHeavyPage(20000, async (page) => {
    // >1000 buttons carry this label, well past the 300 screening cap.
    const resolution = await resolveActionTarget(page, {
      kind: "click",
      target: { text: "查看" },
    });
    assert.ok(resolution, "a matching target should still resolve");
    assert.ok(
      resolution.locatorSummary.count > 300,
      `expected more matches than the cap, got ${resolution.locatorSummary.count}`,
    );
    // The cap must be visible in evidence. A capped screen that reports nothing
    // is indistinguishable from an exhaustive one.
    assert.equal(resolution.locatorSummary.screenTruncated, true);
    assert.ok(resolution.locatorSummary.screened <= 300);
  });
});
