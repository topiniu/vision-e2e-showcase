const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { run } = require("../../runtime");
const { TestSessionStore } = require("../../runtime/server/session-store");
const { createTestSession } = require("../../runtime/server/test-session-runner");
const { precheckTestFile } = require("../../src/shared/test-file-precheck");
const { classifyFailureClass } = require("../../runtime/reporting/evidence-bundle");

// v1.11: REQ-Z30 viewport / REQ-Z31 routeFault / REQ-Z32 assertLayout, against
// a fixture that reproduces the v6.1.2 shapes: a filter panel that overlaps and
// truncates below 1300px, and a "已录入" lookup whose failure must not warn.

const LAYOUT_PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 14px sans-serif; }
  [data-testid=panel] { display: flex; flex-wrap: wrap; padding: 8px; }
  .cell { width: 280px; height: 40px; margin: 4px; box-sizing: border-box; border: 1px solid #ccc; }
  .label { display: inline-block; width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 1300px) {
    .cell + .cell { margin-left: -60px; }
    .label { width: 40px; }
  }
</style></head><body><main data-testid="panel">
  <div class="cell"><span class="label">任务标签</span></div>
  <div class="cell"><span class="label">任务是否逾期</span></div>
  <div class="cell"><span class="label">核价状态</span></div>
  <div class="cell"><span class="label">归属事业部</span></div>
</main></body></html>`;

const FAULT_PAGE = `<!doctype html><html><body><main>
  <button id="query" onclick="lookup()">查询</button>
  <button id="save" onclick="document.getElementById('saved').textContent='保存成功'">保存</button>
  <div id="result" data-testid="result" style="min-height:10px"></div><div id="saved"></div>
  <script>
    async function lookup() {
      try {
        const res = await fetch('/api/listCjSpuUsage?spu=X');
        const body = await res.json();
        if (body.used) {
          const el = document.createElement('div');
          el.setAttribute('data-testid', 'usage-alert');
          el.textContent = '该编号已被录入';
          document.getElementById('result').appendChild(el);
        }
      } catch (e) { /* failure: no warning */ }
      document.getElementById('result').setAttribute('data-done', '1');
    }
  </script>
</main></body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/listCjSpuUsage")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ used: true }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url.startsWith("/fault") ? FAULT_PAGE : LAYOUT_PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function tempOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zz-v111-"));
}

const layoutStep = {
  id: "layout",
  type: "assertLayout",
  target: { testId: "panel" },
  items: ".cell",
  minItems: 4,
  timeoutMs: 1500,
};

test("v1.11 REQ-Z30/Z32: the same layout assertion is red at 1280 and green at 1920, and the run records the measured viewport", async () => {
  const { server, base } = await startServer();
  try {
    const narrow = await run([layoutStep], { url: `${base}/layout`, outputDir: tempOutputDir(), headless: true, viewport: { width: 1280, height: 900 }, viewportSource: "case" });
    assert.equal(narrow.ok, false);
    assert.deepEqual(narrow.runContext.viewport.effective && { w: narrow.runContext.viewport.effective.width, h: narrow.runContext.viewport.effective.height }, { w: 1280, h: 900 });
    assert.equal(narrow.runContext.viewport.matches, true);
    assert.equal(narrow.runContext.viewport.source, "case");
    const expectation = narrow.data.results[0].data.expectation;
    assert.equal(expectation.type, "assertLayout");
    assert.ok(expectation.overlaps.length > 0, "overlapping cells detected");
    assert.ok(expectation.truncated.some((row) => row.text.includes("任务是否逾期")), "truncated label detected");
    const summary = JSON.parse(fs.readFileSync(narrow.evidence.summaryPath, "utf8"));
    assert.equal(summary.runContext.viewport.effective.width, 1280);
    assert.equal(classifyFailureClass({ result: narrow, summary }), "value-assertion", "a layout red is a calibratable value-assertion red");

    const wide = await run([layoutStep], { url: `${base}/layout`, outputDir: tempOutputDir(), headless: true, viewport: { width: 1920, height: 1080 } });
    assert.equal(wide.ok, true, JSON.stringify(wide.data.results[0].data.expectation));
    assert.equal(wide.data.results[0].data.expectation.itemCount, 4);
    assert.equal(wide.runContext.viewport.effective.width, 1920);
  } finally {
    server.close();
  }
});

test("v1.11 REQ-Z32: an assertLayout that finds nothing fails instead of passing vacuously", async () => {
  const { server, base } = await startServer();
  try {
    const result = await run([{ ...layoutStep, items: ".does-not-exist" }], { url: `${base}/layout`, outputDir: tempOutputDir(), headless: true });
    assert.equal(result.ok, false);
    assert.equal(result.data.results[0].data.expectation.error, "layout-items-missing");
    // no viewport requested → recorded as the channel default
    assert.equal(result.runContext.viewport.source, "default");
    assert.equal(result.runContext.viewport.effective.width, 1440);
  } finally {
    server.close();
  }
});

test("v1.11 REQ-Z30: an injected page is emulated for the run and given its own size back afterwards", async () => {
  const { chromium } = require("playwright");
  const { server, base } = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    // a window-sized (viewport:null) context, like the visible App-run browser
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(`${base}/layout`);
    const before = await page.evaluate(() => window.innerWidth);
    const result = await run([layoutStep], { url: `${base}/layout`, outputDir: tempOutputDir(), page, context, browser, viewport: { width: 1920, height: 1000 } });
    assert.equal(result.runContext.viewport.mechanism, "cdp-device-metrics");
    assert.equal(result.runContext.viewport.effective.width, 1920);
    assert.equal(result.ok, true);
    const after = await page.evaluate(() => window.innerWidth);
    assert.equal(after, before, "the shared page is back at its window size");
    assert.equal(page.viewportSize(), null, "Playwright's own bookkeeping was not touched");
  } finally {
    await browser.close();
    server.close();
  }
});

test("v1.11 REQ-Z31: routeFault aborts the lookup, counts the hit, and the failure path is observed", async () => {
  const { server, base } = await startServer();
  try {
    const result = await run(
      [
        { id: "fault", type: "routeFault", urlIncludes: "/api/listCjSpuUsage", mode: "abort" },
        { id: "query", type: "click", target: { text: "查询" } },
        { id: "done", type: "assertDom", target: { testId: "result" }, property: "attribute", attribute: "data-done", expected: "1" },
        { id: "no-alert", type: "assertCount", target: { testId: "usage-alert" }, count: 0 },
        { id: "save", type: "click", target: { text: "保存" }, expectation: { kind: "text-exists", texts: ["保存成功"] } },
      ],
      { url: `${base}/fault`, outputDir: tempOutputDir(), headless: true },
    );
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.telemetry.routeFaults.length, 1);
    assert.equal(result.telemetry.routeFaults[0].hits, 1);
    assert.ok(result.telemetry.routeFaults[0].removedAt, "the route was removed at run end");
    const summary = JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
    assert.equal(summary.routeFaults[0].hits, 1);
    assert.ok(fs.existsSync(path.join(result.evidence.runDir, "network", "route-faults.json")));
  } finally {
    server.close();
  }
});

test("v1.11 REQ-Z31: respond mode replaces the body; a fault that never fires fails the case", async () => {
  const { server, base } = await startServer();
  try {
    const answered = await run(
      [
        { id: "fault", type: "routeFault", urlMatches: "listCjSpuUsage\\?", status: 200, body: { used: false } },
        { id: "query", type: "click", target: { text: "查询" } },
        { id: "done", type: "assertDom", target: { testId: "result" }, property: "attribute", attribute: "data-done", expected: "1" },
        { id: "no-alert", type: "assertCount", target: { testId: "usage-alert" }, count: 0 },
      ],
      { url: `${base}/fault`, outputDir: tempOutputDir(), headless: true },
    );
    assert.equal(answered.ok, true, JSON.stringify(answered.error));
    assert.equal(answered.telemetry.routeFaults[0].hits, 1);

    const missed = await run(
      [
        { id: "fault", type: "routeFault", urlIncludes: "/api/listCjSpuUsagee", mode: "abort" },
        { id: "query", type: "click", target: { text: "查询" } },
        { id: "done", type: "assertDom", target: { testId: "result" }, property: "attribute", attribute: "data-done", expected: "1" },
      ],
      { url: `${base}/fault`, outputDir: tempOutputDir(), headless: true },
    );
    assert.equal(missed.ok, false);
    const check = missed.data.results.at(-1);
    assert.equal(check.error.code, "route-fault-not-hit");
    const summary = JSON.parse(fs.readFileSync(missed.evidence.summaryPath, "utf8"));
    assert.equal(summary.firstFailure.code, "route-fault-not-hit");
  } finally {
    server.close();
  }
});

test("v1.11 REQ-Z30: headless sessions hand each case its own viewport (case > file), root steps the file's", async () => {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "zz-v111-ws-"));
  const outputRoot = path.join(workspace, "output");
  const workflows = path.join(workspace, "test-workflows");
  await fsp.mkdir(workflows, { recursive: true });
  await fsp.mkdir(path.join(outputRoot, "auth-profiles", "p"), { recursive: true });
  await fsp.writeFile(path.join(outputRoot, "auth-profiles", "p", "storageState.json"), JSON.stringify({ cookies: [], origins: [] }));
  await fsp.writeFile(
    path.join(workflows, "f.json"),
    JSON.stringify({
      id: "f",
      name: "f",
      baseUrl: "http://127.0.0.1:9/",
      settings: { viewport: { width: 1440, height: 900 } },
      setup: { steps: [{ id: "s", type: "capture" }] },
      cases: [
        { id: "w1280", name: "1280", viewport: { width: 1280, height: 900 }, steps: [{ id: "a", type: "capture" }] },
        { id: "w1920", name: "1920", viewport: { width: 1920, height: 1080 }, steps: [{ id: "b", type: "capture" }] },
        { id: "wfile", name: "file", steps: [{ id: "c", type: "capture" }] },
      ],
    }),
  );
  const calls = [];
  const runImpl = async (steps, options) => {
    calls.push({ runId: options.runId, viewport: options.viewport || null, source: options.viewportSource || null });
    return { ok: true, type: "batch", data: { results: [] }, telemetry: { durationMs: 1, steps: 1, okCount: 1, errorCount: 0 }, evidence: { steps: [] } };
  };
  await createTestSession(
    { testFilePath: "f.json", authProfile: "p", qualityGate: "off" },
    { store: new TestSessionStore({ outputRoot }), outputRoot, testWorkflowsRoot: workflows, outputRunsRoot: path.join(outputRoot, "runs"), runImpl },
  );
  const byCase = Object.fromEntries(calls.map((call) => [call.runId.split("-").pop(), call]));
  assert.deepEqual(byCase.w1280.viewport, { width: 1280, height: 900 });
  assert.equal(byCase.w1280.source, "case");
  assert.deepEqual(byCase.w1920.viewport, { width: 1920, height: 1080 });
  assert.deepEqual(byCase.wfile.viewport, { width: 1440, height: 900 });
  assert.equal(byCase.wfile.source, "file");
  assert.equal(byCase.setup.source, "file");
});

test("v1.11: precheck rejects what the runtime would reject", () => {
  const result = precheckTestFile({
    testFile: {
      id: "x",
      name: "x",
      settings: { viewport: { widht: 1280, height: 900 } },
      cases: [
        {
          id: "c1",
          name: "c1",
          viewport: { width: 99999, height: 900 },
          steps: [
            { id: "f", type: "routeFault", mode: "abort" },
            { id: "l", type: "assertLayout", target: { testId: "p" } },
          ],
        },
      ],
    },
  });
  const codes = (result.errors || result.issues || []).map((item) => item.code);
  const all = JSON.stringify(result);
  for (const code of ["invalid-viewport", "invalid-route-fault", "invalid-layout-assertion"]) {
    assert.ok(all.includes(code), `${code} reported (${codes.join(",")})`);
  }
  assert.equal(result.ok, false);
});

test("v1.11: identical sibling boxes fail overlap; nested parent/child boxes remain valid", async () => {
  const { chromium } = require("playwright");
  const { evaluateLayoutAssertion } = require("../../runtime/perception/layout-assert");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="p" style="position:relative;width:100px;height:100px"><div class="cell" style="position:absolute;inset:0">A</div><div class="cell" style="position:absolute;inset:0">B</div></div>');
    const overlap = await evaluateLayoutAssertion({ items: ".cell", noTruncation: false }, { page });
    assert.equal(overlap.ok, false, "identical siblings are overlapping, not nested");
    await page.setContent('<div class="cell" style="width:100px;height:100px"><div class="cell" style="width:100px;height:100px">nested</div></div>');
    const nested = await evaluateLayoutAssertion({ items: ".cell", noTruncation: false }, { page });
    assert.equal(nested.ok, true);
    const missingText = await evaluateLayoutAssertion({ items: ".cell", noTruncation: ".misspelled" }, { page });
    assert.equal(missingText.ok, false);
    assert.equal(missingText.error, "layout-truncation-target-missing");
  } finally { await browser.close(); }
});

test("v1.11: case viewport beats injected context defaults and invalid direct requests cannot fall back silently", async () => {
  const { server, base } = await startServer();
  try {
    const result = await run([layoutStep], { url: `${base}/layout`, outputDir: tempOutputDir(),
      viewport: { width: 1920, height: 1080 }, contextOptions: { viewport: { width: 1280, height: 900 } } });
    assert.equal(result.ok, true);
    assert.equal(result.runContext.viewport.effective.width, 1920);
    await assert.rejects(run([], { viewport: { widht: 1920, height: 1080 } }), { code: "invalid-viewport" });
  } finally { server.close(); }
});

test("v1.11: viewport measurement cannot hang a run before health monitoring starts", async () => {
  const { measureViewport } = require("../../runtime/executor/viewport-emulation");
  const started = Date.now();
  assert.equal(await measureViewport({ evaluate: () => new Promise(() => {}) }), null);
  assert.ok(Date.now() - started < 3000);
});

test("v1.11: a matched request whose injection failed cannot produce GREEN; disposal cancels pending delay", async () => {
  const { RouteFaultRegistry } = require("../../runtime/executor/route-faults");
  const { parseRouteFaultSpec } = require("../../src/shared/route-fault");
  let handler;
  let fallback = false;
  const page = { route: async (_, callback) => { handler = callback; }, unroute: async () => {} };
  const request = { method: () => "GET", url: () => "http://local/api" };
  const broken = new RouteFaultRegistry({ page });
  await broken.install({ raw: { urlIncludes: "/api", mode: "respond", body: "x" } });
  await handler({ fulfill: async () => { throw new Error("cannot fulfill"); } }, request);
  await broken.dispose();
  assert.equal(broken.getUnmet().length, 1, "hit count alone is not success");
  assert.match(broken.getUnmet()[0].errors[0], /cannot fulfill/);
  const delayed = new RouteFaultRegistry({ page });
  await delayed.install({ raw: { urlIncludes: "/api", mode: "delay", delayMs: 120000 } });
  const pending = handler({ fallback: async () => { fallback = true; } }, request);
  await delayed.dispose();
  await pending;
  assert.equal(fallback, true);
  assert.equal(delayed.getUnmet().length, 1);
  assert.equal(parseRouteFaultSpec({ urlIncludes: "/api", minHits: 0 }).spec, null);
});
