
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const {
  baselineSlot,
  buildVisualReview,
  comparePeerTokens,
  evaluatePeerAssertion,
  evaluateVisualAssertion,
  paintMasks,
  readVisualState,
  resolveMaskBoxes,
} = require("../../runtime/perception/visual-baseline");
const {
  createPerformanceCollector,
  evaluatePerfAssertion,
  resolveMetricName,
} = require("../../runtime/perception/performance-metrics");

function serveHtml(html) {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

async function withPage(html, fn, launchOptions = {}) {
  const { server, url } = await serveHtml(html);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, ...launchOptions });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return await fn(page, url);
  } finally {
    await browser.close();
    server.close();
  }
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const CARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: Arial; background: #fff; }
  .card { width: 300px; padding: 16px; border: 1px solid #d9d9d9; border-radius: 8px;
          font-size: 14px; line-height: 22px; color: #262626; background: #fff; }
  .peer-ok { width: 300px; padding: 16px; border: 1px solid #d9d9d9; border-radius: 8px;
             font-size: 14px; line-height: 22px; color: #262626; background: #fff; }
  .peer-off { width: 300px; padding: 0; border: 1px solid #ff4d4f; border-radius: 0;
              font-size: 12px; line-height: 16px; color: #ff0000; background: #fff; }
  .live { font-variant-numeric: tabular-nums; }
  .narrow { width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style></head><body>
  <div class="card" data-testid="demo-size-rule-adv-modal">
    <div data-testid="modal-title">尺寸规则</div>
    <div class="live" data-testid="modal-log-table">2026-08-25 10:00:00</div>
  </div>
  <div class="peer-ok" data-testid="peer-cost-order-modal">成本单弹窗</div>
  <div class="peer-off" data-testid="peer-legacy-modal">旧版弹窗</div>
  <div class="narrow" data-testid="truncated-label">这是一段会被截断的很长的文本内容</div>
</body></html>`;

// --- Z-E ---------------------------------------------------------------------

test("E-1: a missing baseline is recorded AND reported as no-baseline (never a pass)", async (t) => {
  const root = tempRoot(t, "zhuzhu-visual-");
  await withPage(CARD_HTML, async (page) => {
    const first = await evaluateVisualAssertion(
      {
        target: { testId: "demo-size-rule-adv-modal" },
        baseline: "size-rule-adv-modal",
        expectation: { maxDiffRatio: 0.02, onMissingBaseline: "record" },
      },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    assert.equal(first.ok, false, "the first run must not pretend to pass");
    assert.equal(first.noBaseline, true);
    assert.equal(first.error, "visual-no-baseline");
    assert.equal(first.baseline.recorded, true);
    assert.ok(fs.existsSync(first.baseline.imagePath));
    assert.match(first.detail, /先确认这张图本身是对的/);

    // Second run compares against what was just recorded and passes.
    const second = await evaluateVisualAssertion(
      {
        target: { testId: "demo-size-rule-adv-modal" },
        baseline: "size-rule-adv-modal",
        expectation: { maxDiffRatio: 0.02 },
      },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.diff.ratio, 0);
  });
});

test('onMissingBaseline:"fail" does not record anything', async (t) => {
  const root = tempRoot(t, "zhuzhu-visual-nofail-");
  await withPage(CARD_HTML, async (page) => {
    const result = await evaluateVisualAssertion(
      {
        target: { testId: "demo-size-rule-adv-modal" },
        baseline: "k",
        expectation: { onMissingBaseline: "fail" },
      },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.baseline.recorded, false);
    assert.equal(fs.readdirSync(root).length === 0 || !fs.existsSync(path.join(root, "test")), true);
  });
});

test("E-1: a real visual regression is caught and localized", async (t) => {
  const root = tempRoot(t, "zhuzhu-visual-regress-");
  await withPage(CARD_HTML, async (page) => {
    await evaluateVisualAssertion(
      { target: { testId: "demo-size-rule-adv-modal" }, baseline: "k" },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    // Somebody changes the padding — the classic appearance regression.
    await page.evaluate(() => {
      document.querySelector('[data-testid="demo-size-rule-adv-modal"]').style.padding = "40px";
    });
    const result = await evaluateVisualAssertion(
      { target: { testId: "demo-size-rule-adv-modal" }, baseline: "k", expectation: { maxDiffRatio: 0.02 } },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /diff-ratio/);
    // Where the difference is — the difference between actionable and "it looks different".
    assert.ok(result.diff.bounds);
    assert.match(result.detail, /差异集中在/);
  });
});

test("E-2: viewport/DPR are slotted, so a different DPR never produces a false diff", async (t) => {
  const root = tempRoot(t, "zhuzhu-visual-dpr-");
  // Two runs at different device pixel ratios must use different baseline slots.
  assert.equal(
    baselineSlot({ key: "k", viewport: { width: 800, height: 600 }, devicePixelRatio: 1 }),
    "k@800x600@1x",
  );
  assert.equal(
    baselineSlot({ key: "k", viewport: { width: 800, height: 600 }, devicePixelRatio: 2 }),
    "k@800x600@2x",
  );
  assert.notEqual(
    baselineSlot({ key: "k", viewport: { width: 800, height: 600 }, devicePixelRatio: 1 }),
    baselineSlot({ key: "k", viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 }),
  );

  await withPage(CARD_HTML, async (page) => {
    const first = await evaluateVisualAssertion(
      { target: { testId: "demo-size-rule-adv-modal" }, baseline: "k" },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    assert.match(first.baseline.slot, /@800x600@1x$/);
  });
  // A 2x run gets its own slot: no baseline yet, so `no-baseline` — NOT a bogus
  // diff against a 1x image resampled to 2x.
  await withPage(
    CARD_HTML,
    async (page) => {
      const result = await evaluateVisualAssertion(
        { target: { testId: "demo-size-rule-adv-modal" }, baseline: "k" },
        { page, visualBaselineRoot: root, visualProfile: "test" },
      );
      assert.equal(result.noBaseline, true);
      assert.match(result.baseline.slot, /@2x$/);
    },
    { deviceScaleFactor: 2 },
  );
});

test("E-2: a theme change is reported as a theme mismatch, not as a huge diff ratio", async (t) => {
  const root = tempRoot(t, "zhuzhu-visual-theme-");
  const themed = CARD_HTML.replace("<body>", '<body data-theme="light">');
  await withPage(themed, async (page) => {
    await evaluateVisualAssertion(
      { target: { testId: "demo-size-rule-adv-modal" }, baseline: "k" },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    await page.evaluate(() => document.body.setAttribute("data-theme", "dark"));
    const result = await evaluateVisualAssertion(
      { target: { testId: "demo-size-rule-adv-modal" }, baseline: "k" },
      { page, visualBaselineRoot: root, visualProfile: "test" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "visual-theme-mismatch");
    assert.match(result.detail, /跨主题时没有意义/);
  });
});

test("E-4: a change inside a masked region does not turn the case red", async (t) => {
  const root = tempRoot(t, "zhuzhu-visual-mask-");
  await withPage(CARD_HTML, async (page) => {
    const spec = {
      target: { testId: "demo-size-rule-adv-modal" },
      baseline: "masked",
      mask: [{ testId: "modal-log-table" }],
      expectation: { maxDiffRatio: 0.01 },
    };
    const first = await evaluateVisualAssertion(spec, { page, visualBaselineRoot: root, visualProfile: "test" });
    assert.equal(first.noBaseline, true);
    assert.equal(first.masks.length, 1);

    // Only the masked timestamp changes.
    await page.evaluate(() => {
      document.querySelector('[data-testid="modal-log-table"]').textContent = "2099-12-31 23:59:59";
    });
    const masked = await evaluateVisualAssertion(spec, { page, visualBaselineRoot: root, visualProfile: "test" });
    assert.equal(masked.ok, true, `masked diff was ${JSON.stringify(masked.diff)}`);

    // Sanity: without the mask the same change WOULD be caught, otherwise this
    // test would pass for the wrong reason.
    const unmaskedSpec = { ...spec, baseline: "unmasked", mask: [] };
    await evaluateVisualAssertion(unmaskedSpec, { page, visualBaselineRoot: root, visualProfile: "test" });
    await page.evaluate(() => {
      document.querySelector('[data-testid="modal-log-table"]').textContent = "AAAAAAAAAAAAAAAAAAA";
    });
    const unmasked = await evaluateVisualAssertion(unmaskedSpec, {
      page,
      visualBaselineRoot: root,
      visualProfile: "test",
    });
    assert.equal(unmasked.ok, false, "the mask must be the reason the earlier check passed");
  });
});

test("E-3: the peer table names the concrete token differences", async (t) => {
  await withPage(CARD_HTML, async (page) => {
    const result = await evaluatePeerAssertion(
      {
        target: { testId: "peer-legacy-modal" },
        peers: [{ testId: "peer-cost-order-modal" }, { testId: "demo-size-rule-adv-modal" }],
      },
      { page },
    );
    const tokens = result.differences.map((row) => row.token);
    // The three the roadmap calls out by name: 字号 / 内边距 / 主色.
    assert.ok(tokens.includes("fontSize"), JSON.stringify(tokens));
    assert.ok(tokens.includes("paddingLeft"));
    assert.ok(tokens.includes("color"));
    const fontRow = result.differences.find((row) => row.token === "fontSize");
    assert.match(fontRow.summary, /字号 12 vs 14/);
    // Material only by default: an aesthetic conclusion is not the engine's call.
    assert.equal(result.ok, true, "without mustMatch the peer table is material, not a verdict");
  });
});

test("E-3: mustMatch turns a named token difference into a failure", async (t) => {
  await withPage(CARD_HTML, async (page) => {
    const result = await evaluatePeerAssertion(
      {
        target: { testId: "peer-legacy-modal" },
        peers: [{ testId: "peer-cost-order-modal" }],
        mustMatch: ["fontSize", "borderRadius"],
      },
      { page },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /fontSize/);
    assert.match(result.detail, /与同族模块不一致/);
  });
});

test("a declared peer that does not exist is 'not measured', not 'consistent'", async (t) => {
  await withPage(CARD_HTML, async (page) => {
    const result = await evaluatePeerAssertion(
      { target: { testId: "peer-legacy-modal" }, peers: [{ testId: "nope-not-here" }] },
      { page },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /visual-peers-not-found/);
    assert.match(result.detail, /没测到/);
  });
});

test("the visual state read includes truncation and accessibility facts", async (t) => {
  await withPage(CARD_HTML, async (page) => {
    const state = await readVisualState(page, [{ testId: "truncated-label" }, { testId: "modal-title" }]);
    const truncated = state.elements.find((item) => item.selector.includes("truncated-label"));
    assert.equal(truncated.truncation.clipped, true, "an ellipsised label is a measurable defect class");
    const title = state.elements.find((item) => item.selector.includes("modal-title"));
    assert.equal(title.truncation.clipped, false);
    assert.ok(title.accessibility.contrastRatio > 4.5, `contrast was ${title.accessibility.contrastRatio}`);
    assert.equal(typeof title.accessibility.hitTargetOk, "boolean");
    assert.equal(state.viewport.width, 800);
  });
});

test("visual assertions fail closed without a page or a baseline root", async () => {
  const noPage = await evaluateVisualAssertion({ target: { testId: "x" } }, {});
  assert.equal(noPage.ok, false);
  assert.equal(noPage.error, "visual-capture-unavailable");

  const noRoot = await evaluateVisualAssertion(
    { target: { testId: "x" } },
    { page: { screenshot: () => {}, evaluate: async () => ({ elements: [] }), locator: () => ({}) } },
  );
  assert.equal(noRoot.ok, false);
  assert.equal(noRoot.error, "visual-baseline-root-unavailable");
});

test("mask painting and box resolution are relative to the captured element", async () => {
  const boxes = resolveMaskBoxes(
    [{ found: true, box: { x: 120, y: 240, width: 50, height: 20 }, selector: "a" }],
    { x: 100, y: 200 },
  );
  assert.deepEqual(boxes, [{ x: 20, y: 40, width: 50, height: 20, selector: "a" }]);

  const { PNG } = require("pngjs");
  const png = new PNG({ width: 10, height: 10 });
  png.data.fill(255);
  const painted = await paintMasks(PNG.sync.write(png), [{ x: 2, y: 2, width: 3, height: 3 }]);
  const decoded = PNG.sync.read(painted);
  const at = (x, y) => decoded.data.slice((y * 10 + x) * 4, (y * 10 + x) * 4 + 3).join(",");
  assert.equal(at(3, 3), "255,0,255");
  assert.equal(at(8, 8), "255,255,255");
  // A no-op mask list returns the buffer untouched.
  const untouched = await paintMasks(PNG.sync.write(png), []);
  assert.equal(untouched.length, PNG.sync.write(png).length);
});

test("comparePeerTokens ignores differences within tolerance", () => {
  const subject = { tokens: { fontSize: 14, paddingLeft: 16 } };
  const near = [{ selector: "p", tokens: { fontSize: 14.3, paddingLeft: 16.5 } }];
  assert.deepEqual(comparePeerTokens(subject, near), []);
  const far = [{ selector: "p", tokens: { fontSize: 12, paddingLeft: 16 } }];
  assert.deepEqual(
    comparePeerTokens(subject, far).map((row) => row.token),
    ["fontSize"],
  );
});

test("buildVisualReview returns null when nothing visual ran", () => {
  assert.equal(buildVisualReview([]), null);
  const review = buildVisualReview([{ kind: "baseline", selector: "x" }]);
  assert.equal(review.items.length, 1);
  assert.match(review.note, /不出审美结论/);
});

// --- Z-G ---------------------------------------------------------------------

const HEAVY_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <button id="load">load</button>
  <div id="table"></div>
  <script>
    document.querySelector("#load").addEventListener("click", () => {
      // A deliberately expensive synchronous render: 5000 rows, on the main
      // thread, which is exactly the "多品类多档位卡顿" shape.
      const rows = [];
      for (let i = 0; i < 5000; i += 1) { rows.push("<div class='row'><span>" + i + "</span></div>"); }
      document.querySelector("#table").innerHTML = rows.join("");
      const until = performance.now() + 220;
      while (performance.now() < until) { /* block the main thread */ }
    });
  </script>
</body></html>`;

test("G-1: 5000 rendered rows trip the domNodes assertion", async (t) => {
  await withPage(HEAVY_HTML, async (page) => {
    const collector = createPerformanceCollector({ page });
    await collector.install();
    const before = await evaluatePerfAssertion({ metric: "domNodes", atMost: 5000 }, { performance: collector, page });
    assert.equal(before.ok, true, `light page had ${before.actual} nodes`);

    await page.click("#load");
    await page.waitForTimeout(300);
    const after = await evaluatePerfAssertion({ metric: "domNodes", atMost: 5000 }, { performance: collector, page });
    assert.equal(after.ok, false);
    assert.ok(after.actual > 5000, `expected > 5000 nodes, got ${after.actual}`);
    assert.match(after.error, /domNodes:atMost/);
    // The whole sample travels with the failure — "domNodes exceeded" is much
    // more actionable next to the long-task figure.
    assert.ok(Number.isFinite(after.sample.longTaskTotalMs));
    assert.match(after.detail, /regression判据/);
  });
});

test("G-1: a blocked main thread trips the long-task assertion", async (t) => {
  await withPage(HEAVY_HTML, async (page) => {
    const collector = createPerformanceCollector({ page });
    await collector.install();
    // Drain whatever the page load produced so the measurement window is the click.
    await collector.sample({ label: "baseline" });
    await page.click("#load");
    await page.waitForTimeout(400);
    const result = await evaluatePerfAssertion(
      { metric: "longTaskTotalMs", atMost: 100 },
      { performance: collector, page },
    );
    assert.equal(result.ok, false, `long task total was ${result.actual}ms`);
    assert.ok(result.actual >= 100);
  });
});

test("G-2/G-3: the report carries a jitter band and names the slowest step", async (t) => {
  await withPage(HEAVY_HTML, async (page) => {
    const collector = createPerformanceCollector({ page });
    await collector.install();
    await collector.sample({ stepId: "idle-1", stepIndex: 0 });
    await page.click("#load");
    await page.waitForTimeout(350);
    await collector.sample({ stepId: "render-5000", stepIndex: 1 });
    await collector.sample({ stepId: "idle-2", stepIndex: 2 });

    const report = collector.getReport();
    assert.equal(report.samples, 3);
    // G-2: min/max per metric, so nobody treats one sample as a conclusion.
    assert.ok(report.spread.domNodes.max > report.spread.domNodes.min);
    assert.equal(report.spread.domNodes.samples, 3);
    // G-3: which step it got stuck on.
    assert.equal(report.slowestStep.stepId, "render-5000");
    assert.equal(report.timeline.length, 3);
  });
});

test("Z-G: a baseline comparison is the endorsed regression form", async (t) => {
  await withPage(HEAVY_HTML, async (page) => {
    const collector = createPerformanceCollector({ page });
    await collector.install();
    const variables = {};
    const context = {
      performance: collector,
      page,
      runtimeVariables: variables,
      setRuntimeVariable: (name, value) => {
        variables[name] = value;
      },
    };
    const captured = await evaluatePerfAssertion(
      { metric: "domNodes", atMost: 100000, saveAs: "baselineNodes" },
      context,
    );
    assert.equal(captured.ok, true);
    assert.ok(Number.isFinite(variables.baselineNodes));

    await page.click("#load");
    await page.waitForTimeout(300);
    const regressed = await evaluatePerfAssertion(
      { metric: "domNodes", baseline: "baselineNodes", toleranceRatio: 0.5 },
      context,
    );
    assert.equal(regressed.ok, false, `nodes went ${variables.baselineNodes} -> ${regressed.actual}`);
    assert.equal(regressed.failures[0].reason, "baseline");
    assert.match(String(regressed.failures[0].expected), /baseline/);
  });
});

test("assertPerf fails closed on a missing collector, metric or bound", async () => {
  const noCollector = await evaluatePerfAssertion({ metric: "domNodes", atMost: 10 }, {});
  assert.equal(noCollector.ok, false);
  assert.equal(noCollector.error, "performance-collector-unavailable");
  assert.match(noCollector.detail, /unverifiable green/);

  const noMetric = await evaluatePerfAssertion({}, {});
  assert.equal(noMetric.error, "assertPerf:no-metric");

  await withPage("<html><body>ok</body></html>", async (page) => {
    const collector = createPerformanceCollector({ page });
    const noBound = await evaluatePerfAssertion({ metric: "domNodes" }, { performance: collector, page });
    assert.equal(noBound.ok, false);
    assert.equal(noBound.error, "assertPerf:no-bound");

    const unknownMetric = await evaluatePerfAssertion(
      { metric: "totallyMadeUpMetric", atMost: 1 },
      { performance: collector, page },
    );
    assert.equal(unknownMetric.error, "performance-metric-unavailable");
    assert.match(unknownMetric.detail, /Available metrics/);
  });
});

test("a missing baseline variable is a failure, not a silent skip", async (t) => {
  await withPage("<html><body>ok</body></html>", async (page) => {
    const collector = createPerformanceCollector({ page });
    const result = await evaluatePerfAssertion(
      { metric: "domNodes", baseline: "neverCaptured" },
      { performance: collector, page, runtimeVariables: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.failures[0].reason, "baseline:missing");
  });
});

test("metric aliases resolve to the canonical names", () => {
  assert.equal(resolveMetricName("longTaskTotal"), "longTaskTotalMs");
  assert.equal(resolveMetricName("interactionLatencyMs"), "interactionMaxMs");
  assert.equal(resolveMetricName("nodes"), "domNodes");
  assert.equal(resolveMetricName("domNodes"), "domNodes");
});

test("the collector degrades to 'unavailable' rather than throwing on a fake page", async () => {
  const collector = createPerformanceCollector({ page: { evaluate: async () => { throw new Error("no renderer"); } } });
  assert.equal(await collector.install(), false);
  assert.equal(await collector.sample(), null);
  const report = collector.getReport();
  assert.equal(report.samples, 0);
  assert.match(report.unavailable, /no renderer/);
});
