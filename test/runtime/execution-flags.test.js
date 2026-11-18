const test = require("node:test");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");
const { runExpectation, shouldUseAdapterDomState } = require("../../runtime/assertions");
const { executeAction } = require("../../runtime/index");

function createPngBuffer(r, g, b) {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function createPage(buffers, options = {}) {
  let screenshotIndex = 0;
  let evaluateIndex = 0;
  let metaIndex = 0;
  const waits = [];
  const destroyedEvaluateCalls = new Set(
    Array.isArray(options.throwContextDestroyedOnEvaluate)
      ? options.throwContextDestroyedOnEvaluate
      : options.throwContextDestroyedOnEvaluate
        ? [options.throwContextDestroyedOnEvaluate]
        : [],
  );
  const metas = options.metas || [
    {
      url: options.url ?? "https://example.com",
      title: options.title ?? "Example",
      text: options.text ?? "Dashboard",
    },
  ];
  return {
    waits,
    async screenshot() {
      const next = buffers[Math.min(screenshotIndex, buffers.length - 1)];
      screenshotIndex += 1;
      return next;
    },
    async evaluate(callback, arg) {
      evaluateIndex += 1;
      if (destroyedEvaluateCalls.has(evaluateIndex)) {
        throw new Error("Execution context was destroyed, most likely because of a navigation");
      }
      const source = typeof callback === "function" ? String(callback) : "";
      const nextMeta = metas[Math.min(metaIndex, metas.length - 1)];
      if (!options.advanceMetaOnWait && metaIndex < metas.length - 1) {
        metaIndex += 1;
      }
      if (source.includes("interactables")) {
        return {
          url: nextMeta.url,
          title: nextMeta.title,
          text: nextMeta.text,
          interactables: [],
          viewport: {
            width: 2,
            height: 2,
            scrollX: 0,
            scrollY: 0,
          },
        };
      }
      if (source.includes("collectGlobalText")) {
        return options.globalText ?? nextMeta.text;
      }
      if (source.includes("document.body?.innerText")) {
        return nextMeta.text;
      }
      if (source.includes("collectScopedText")) {
        return {
          text: options.scopedText ?? nextMeta.text,
          matched: options.scopeMatched ?? true,
          scope: arg,
        };
      }
      if (source.includes("location.href") && source.includes("document.title")) {
        return {
          url: nextMeta.url,
          title: nextMeta.title,
        };
      }
      return {
        url: nextMeta.url,
        title: nextMeta.title,
        text: nextMeta.text,
        interactables: [],
        viewport: {
          width: 2,
          height: 2,
          scrollX: 0,
          scrollY: 0,
        },
      };
    },
    async waitForLoadState() {},
    async waitForTimeout(timeoutMs) {
      waits.push(timeoutMs);
      if (options.advanceMetaOnWait && metaIndex < metas.length - 1) {
        metaIndex += 1;
      }
    },
    url() {
      return metas[Math.max(0, Math.min(metaIndex, metas.length - 1))]?.url ?? metas[0].url;
    },
  };
}

function createArtifactStore() {
  const saved = {
    screenshots: [],
    json: [],
  };
  return {
    saved,
    async saveScreenshot(index, suffix) {
      saved.screenshots.push({ index, suffix });
      return `/tmp/${index}-${suffix}.png`;
    },
    async saveJson(index, suffix, data) {
      saved.json.push({ index, suffix, data });
      return `/tmp/${index}-${suffix}.json`;
    },
  };
}

test("waitForChange expectation polls until a change appears within timeout", async () => {
  let attempts = 0;
  const waits = [];
  const result = await runExpectation(
    {},
    {
      kind: "waitForChange",
      timeoutMs: 100,
      intervalMs: 5,
    },
    {
      async resolveChange() {
        attempts += 1;
        return { changed: attempts >= 3, ratio: attempts >= 3 ? 0.5 : 0 };
      },
      async waitForTimeout(timeoutMs) {
        waits.push(timeoutMs);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.type, "waitForChange");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5, 5]);
});

test("text expectations keep global behavior when scope is omitted", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    text: "筛选面板 请选择或搜索运营",
    scopedText: "创建任务任务 已选择运营",
  });

  const result = await runExpectation(page, {
    kind: "text-absent",
    text: "请选择或搜索运营",
    timeoutMs: 20,
    intervalMs: 5,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.present, ["请选择或搜索运营"]);
  assert.equal(result.scope, null);
});

test("text-absent polls until text disappears within timeout", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    advanceMetaOnWait: true,
    metas: [
      {
        url: "https://example.com",
        title: "Example",
        text: "创建任务任务 提交中",
      },
      {
        url: "https://example.com",
        title: "Example",
        text: "主看板 创建成功",
      },
    ],
  });

  const result = await runExpectation(page, {
    kind: "text-absent",
    text: "创建任务任务",
    timeoutMs: 50,
    intervalMs: 5,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.present, []);
  assert.deepEqual(page.waits, [5]);
});

test("text-absent only evaluates text inside expectation scope", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    text: "筛选面板 请选择或搜索运营",
    scopedText: "创建任务任务 促佳贸易",
  });

  const result = await runExpectation(page, {
    kind: "text-absent",
    text: "请选择或搜索运营",
    scope: {
      role: "dialog",
      nearText: "创建任务任务",
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.present, []);
  assert.deepEqual(result.scope, {
    role: "dialog",
    nearText: "创建任务任务",
    locator: "",
    testId: "",
  });
});

test("text-exists only evaluates text inside expectation scope", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    text: "筛选面板 促佳贸易",
    scopedText: "创建任务任务 促佳贸易",
  });

  const result = await runExpectation(page, {
    kind: "text-exists",
    text: "促佳贸易",
    timeoutMs: 20,
    intervalMs: 5,
    scope: {
      locator: ".ant-modal-content",
      testId: "create-task-modal",
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.matched, ["促佳贸易"]);
  assert.deepEqual(result.scope, {
    nearText: "",
    role: "",
    locator: ".ant-modal-content",
    testId: "create-task-modal",
  });
});

test("text-exists includes visible form control values in global page text", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    globalText: "登录表单\n账号\ndemo-user",
  });

  const result = await runExpectation(page, {
    kind: "text-exists",
    text: "demo-user",
    timeoutMs: 20,
    intervalMs: 5,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.matched, ["demo-user"]);
});

test("text-absent global assertion ignores placeholder attributes", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    globalText: "已选择促佳贸易",
  });

  const result = await runExpectation(page, {
    kind: "text-absent",
    text: "请输入负责人姓名搜索",
    timeoutMs: 20,
    intervalMs: 5,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.present, []);
});

test("composite text assertion fails when expected text from text field is absent", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    text: "共 131 条",
  });

  const result = await runExpectation(page, {
    kind: "composite",
    assertions: [
      {
        kind: "waitForChange",
        timeoutMs: 20,
      },
      {
        kind: "text-exists",
        text: ["共 132 条"],
        timeoutMs: 20,
        intervalMs: 5,
      },
    ],
  }, {
    change: { changed: true },
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.deepEqual(result.results[1].missing, ["共 132 条"]);
});

test("text-exists assertion requires at least one expected text", async () => {
  const page = createPage([createPngBuffer(0, 0, 0)], {
    text: "Dashboard",
  });

  const result = await runExpectation(page, {
    kind: "text-exists",
    timeoutMs: 20,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "expected-text-required");
});

test("executeAction reports missing expectation text instead of generic action failure", async () => {
  const page = createPage([createPngBuffer(0, 0, 0), createPngBuffer(255, 255, 255)], {
    text: "共 131 条",
  });

  const result = await executeAction({
    page,
    action: {
      id: "step-click-expectation",
      index: 0,
      raw: { type: "waitForIdle" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: false,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForNav: false,
      waitForIdle: false,
      retries: 0,
      retryDelayMs: 0,
      expectation: {
        kind: "composite",
        assertions: [
          {
            kind: "text-exists",
            text: ["共 132 条"],
            timeoutMs: 20,
            intervalMs: 5,
          },
        ],
      },
    },
    ocrService: { async runOcr() { return null; } },
    artifactStore: createArtifactStore(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "expectation-not-met");
  assert.equal(result.error.message, "Expected text not found: 共 132 条");
});

test("DOM assertion state selection keeps native text when AntD wrapper text is polluted", () => {
  const nativeState = {
    count: 1,
    actual: "--",
    text: "--",
  };
  const adapterState = {
    count: 1,
    actual: "-- -- demo-phase-lifecycle-finish-14",
    text: "-- -- demo-phase-lifecycle-finish-14",
    stateSource: "wrapper",
  };

  assert.equal(
    shouldUseAdapterDomState(
      "text",
      nativeState,
      { ok: true, actual: "--" },
      adapterState,
      { ok: false, actual: "-- -- demo-phase-lifecycle-finish-14" },
    ),
    false,
  );
  assert.equal(
    shouldUseAdapterDomState(
      "checked",
      { count: 1, actual: false, checked: false },
      { ok: false, actual: false },
      { count: 1, actual: true, checked: true, stateSource: "class" },
      { ok: false, actual: true },
    ),
    true,
  );
});

test("executeAction does not persist artifacts when needRes is false", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, base, changed]);
  const artifactStore = createArtifactStore();
  const ocrService = {
    async runOcr() {
      throw new Error("OCR should not run when artifacts are disabled.");
    },
  };

  const result = await executeAction({
    page,
    action: {
      id: "step-1",
      index: 0,
      raw: { type: "waitForIdle" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: false,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: true,
      waitForChangeTimeoutMs: 50,
      waitForNav: false,
      waitForIdle: false,
      retries: 0,
      retryDelayMs: 0,
      expectation: null,
    },
    ocrService,
    artifactStore,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.expectation.type, "waitForChange");
  assert.equal(artifactStore.saved.screenshots.length, 0);
  assert.equal(artifactStore.saved.json.length, 0);
  assert.equal(result.evidence.beforeScreenshotPath, null);
  assert.equal(result.evidence.afterScreenshotPath, null);
  assert.equal(result.evidence.ocrPath, null);
  assert.equal(result.evidence.tracePath, null);
});

test("executeAction polls waitForChange when it is configured as expectation", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, base, base, changed]);
  const artifactStore = createArtifactStore();

  const result = await executeAction({
    page,
    action: {
      id: "step-upload",
      index: 0,
      raw: { type: "uploadFile" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: false,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForChangeTimeoutMs: 50,
      waitForNav: false,
      waitForIdle: false,
      retries: 0,
      retryDelayMs: 0,
      expectation: {
        kind: "waitForChange",
        timeoutMs: 50,
        intervalMs: 5,
      },
    },
    ocrService: { async runOcr() { return null; } },
    artifactStore,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.expectation.type, "waitForChange");
  assert.equal(page.waits.length, 1);
});

test("executeAction polls waitForChange when it is nested in a composite expectation", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, base, base, changed], {
    scopedText: "删除",
  });
  const artifactStore = createArtifactStore();

  const result = await executeAction({
    page,
    action: {
      id: "step-upload-composite",
      index: 0,
      raw: { type: "uploadFile" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: false,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForChangeTimeoutMs: 50,
      waitForNav: false,
      waitForIdle: false,
      retries: 0,
      retryDelayMs: 0,
      expectation: {
        kind: "composite",
        assertions: [
          {
            kind: "waitForChange",
            timeoutMs: 50,
            intervalMs: 5,
            threshold: 0.002,
          },
          {
            kind: "text-exists",
            text: "删除",
            scope: {
              testId: "demo-create-task-style-upload-证明图",
            },
            timeoutMs: 50,
          },
        ],
      },
    },
    ocrService: { async runOcr() { return null; } },
    artifactStore,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.expectation.type, "composite");
  assert.equal(result.data.expectation.results[0].type, "waitForChange");
  assert.equal(result.data.expectation.results[0].ok, true);
  assert.equal(page.waits.length, 1);
});

function createNeedResAction(overrides = {}) {
  return {
    id: "step-2",
    index: 1,
    raw: { type: "waitForIdle" },
    kind: "waitForIdle",
    query: "",
    hints: [],
    needRes: true,
    strictMatch: false,
    timeoutMs: 500,
    waitForChange: false,
    waitForChangeTimeoutMs: 500,
    waitForNav: false,
    waitForIdle: false,
    retries: 0,
    retryDelayMs: 0,
    expectation: null,
    ...overrides,
  };
}

function createCountingOcr() {
  const ocr = {
    calls: 0,
    async runOcr() {
      ocr.calls += 1;
      return { detections: [], backend: "stub" };
    },
  };
  return ocr;
}

test("v1.10 Z29-1: a passing needRes step keeps its screenshots and trace but skips the after-step OCR by default", async () => {
  const page = createPage([createPngBuffer(0, 0, 0), createPngBuffer(255, 255, 255)]);
  const artifactStore = createArtifactStore();
  const ocrService = createCountingOcr();
  const result = await executeAction({ page, action: createNeedResAction(), ocrService, artifactStore });

  assert.equal(result.ok, true);
  assert.equal(ocrService.calls, 0, "OCR must not run for a passing step under the default onFailure mode");
  assert.deepEqual(artifactStore.saved.screenshots.map((item) => item.suffix), ["before", "after"]);
  assert.deepEqual(artifactStore.saved.json.map((item) => item.suffix), ["trace"]);
  assert.equal(result.evidence.ocrPath, null);
});

test("v1.10 Z29-1: a failing needRes step still gets its after-step OCR under onFailure", async () => {
  const page = createPage([createPngBuffer(0, 0, 0), createPngBuffer(255, 255, 255)], { url: "https://example.com/home" });
  const artifactStore = createArtifactStore();
  const ocrService = createCountingOcr();
  const result = await executeAction({
    page,
    action: createNeedResAction({
      raw: { type: "assertUrl", urlIncludes: "/never-here" },
      kind: "assertUrl",
      query: "/never-here",
    }),
    ocrService,
    artifactStore,
  });

  assert.equal(result.ok, false);
  assert.equal(ocrService.calls, 1);
  assert.match(result.evidence.ocrPath, /ocr\.json$/);
});

test("v1.10 Z29-1: stepOcr off never OCRs, even a failure; a step-level stepOcr overrides the run's mode", async () => {
  const failing = createNeedResAction({
    raw: { type: "assertUrl", urlIncludes: "/never-here" },
    kind: "assertUrl",
    query: "/never-here",
  });
  const offOcr = createCountingOcr();
  await executeAction({
    page: createPage([createPngBuffer(0, 0, 0)], { url: "https://example.com/home" }),
    action: failing,
    ocrService: offOcr,
    artifactStore: createArtifactStore(),
    stepOcr: "off",
  });
  assert.equal(offOcr.calls, 0);

  const overrideOcr = createCountingOcr();
  await executeAction({
    page: createPage([createPngBuffer(0, 0, 0), createPngBuffer(255, 255, 255)]),
    action: createNeedResAction({ raw: { type: "waitForIdle", stepOcr: "always" } }),
    ocrService: overrideOcr,
    artifactStore: createArtifactStore(),
    stepOcr: "off",
  });
  assert.equal(overrideOcr.calls, 1, "the step's own stepOcr:always wins over the run-level off");
});

test("v1.10 Z29-2: without waitForChange the after picture is kept but no pixel diff is computed", async () => {
  const page = createPage([createPngBuffer(0, 0, 0), createPngBuffer(255, 255, 255)]);
  const result = await executeAction({
    page,
    action: createNeedResAction(),
    ocrService: createCountingOcr(),
    artifactStore: createArtifactStore(),
  });
  assert.equal(result.ok, true);
  assert.match(result.evidence.afterScreenshotPath, /after\.png$/);
  assert.equal(result.data.change ?? null, null, "change is only computed for waitForChange");
});

test("v1.10 Z29-3: a callApi step is not screenshotted (the page does not move)", async () => {
  const { createEvidencePolicy } = require("../../runtime/executor/action-runner");
  const policy = createEvidencePolicy({ kind: "callApi", needRes: true }, null, "onFailure");
  assert.equal(policy.captureBeforeScreenshot, false);
  assert.equal(policy.captureAfterScreenshot, false);
  assert.equal(policy.captureTrace, true, "the trace (request/response) is still the evidence");
  const clickPolicy = createEvidencePolicy({ kind: "click", needRes: true }, null, "onFailure");
  assert.equal(clickPolicy.captureBeforeScreenshot, true);
  const diffPolicy = createEvidencePolicy({ kind: "callApi", needRes: true }, { kind: "waitForChange" }, "onFailure");
  assert.equal(diffPolicy.captureAfterScreenshot, true, "an explicit waitForChange still gets its pictures");
});

test("v1.10 Z29-1: resolveStepOcrMode accepts aliases and falls back to onFailure", () => {
  const { resolveStepOcrMode } = require("../../runtime/executor/action-runner");
  assert.equal(resolveStepOcrMode("always"), "always");
  assert.equal(resolveStepOcrMode("on-failure"), "onFailure");
  assert.equal(resolveStepOcrMode("OFF"), "off");
  assert.equal(resolveStepOcrMode(null, "always"), "always");
  assert.equal(resolveStepOcrMode("bogus"), "onFailure");
  assert.equal(resolveStepOcrMode(), "onFailure");
});

test("executeAction persists screenshots, OCR, and trace when needRes is true and stepOcr is always", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, changed]);
  const artifactStore = createArtifactStore();
  const ocrService = {
    async runOcr() {
      return { detections: [], backend: "stub" };
    },
  };

  const result = await executeAction({
    page,
    stepOcr: "always",
    action: {
      id: "step-2",
      index: 1,
      raw: { type: "waitForIdle" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: true,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForChangeTimeoutMs: 500,
      waitForNav: false,
      waitForIdle: false,
      retries: 0,
      retryDelayMs: 0,
      expectation: null,
    },
    ocrService,
    artifactStore,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    artifactStore.saved.screenshots.map((item) => item.suffix),
    ["before", "after"],
  );
  assert.deepEqual(
    artifactStore.saved.json.map((item) => item.suffix),
    ["ocr", "trace"],
  );
  assert.match(result.evidence.beforeScreenshotPath, /before\.png$/);
  assert.match(result.evidence.afterScreenshotPath, /after\.png$/);
  assert.match(result.evidence.ocrPath, /ocr\.json$/);
  assert.match(result.evidence.tracePath, /trace\.json$/);
});

test("executeAction requires navigation target when navigationBehavior is required", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, changed], {
    metas: [
      { url: "https://example.com/login", title: "Login", text: "Login" },
      { url: "https://example.com/dashboard", title: "Dashboard", text: "Dashboard" },
      { url: "https://example.com/dashboard", title: "Dashboard", text: "Dashboard" },
    ],
  });
  const artifactStore = createArtifactStore();

  const result = await executeAction({
    page,
    action: {
      id: "step-3",
      index: 2,
      raw: { type: "waitForIdle" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: false,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForNav: false,
      waitForIdle: false,
      navigationBehavior: "required",
      navigationTarget: {
        urlIncludes: "/dashboard",
      },
      navigationTimeoutMs: 1200,
      waitUntil: "domcontentloaded",
      stabilizationDelayMs: 30,
      retries: 0,
      retryDelayMs: 0,
      expectation: null,
    },
    ocrService: { async runOcr() { return null; } },
    artifactStore,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.action.navigation.matchedTarget, true);
  assert.equal(result.data.action.navigation.finalUrl, "https://example.com/dashboard");
  assert.ok(page.waits.includes(30));
});

test("executeAction recovers after navigation destroys the old execution context", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, changed], {
    metas: [
      { url: "https://example.com/login", title: "Login", text: "Login" },
      { url: "https://example.com/dashboard", title: "Dashboard", text: "Dashboard" },
      { url: "https://example.com/dashboard", title: "Dashboard", text: "Dashboard" },
      { url: "https://example.com/dashboard", title: "Dashboard", text: "Dashboard" },
    ],
    throwContextDestroyedOnEvaluate: 3,
  });
  const artifactStore = createArtifactStore();

  const result = await executeAction({
    page,
    action: {
      id: "step-4",
      index: 3,
      raw: { type: "waitForIdle" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: false,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForNav: false,
      waitForIdle: false,
      navigationBehavior: "required",
      navigationTarget: {
        urlIncludes: "/dashboard",
      },
      navigationTimeoutMs: 1200,
      waitUntil: "domcontentloaded",
      stabilizationDelayMs: 0,
      retries: 0,
      retryDelayMs: 0,
      expectation: {
        kind: "text-exists",
        texts: ["Dashboard"],
        timeoutMs: 300,
      },
    },
    ocrService: { async runOcr() { return null; } },
    artifactStore,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.action.navigation.finalUrl, "https://example.com/dashboard");
  assert.equal(result.data.expectation.ok, true);
});

test("waitForChange recovers when navigation destroys context without navigationBehavior", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, changed, changed], {
    metas: [
      { url: "https://example.com/form", title: "Form", text: "Form" },
      { url: "https://example.com/result", title: "Result", text: "Result" },
      { url: "https://example.com/result", title: "Result", text: "Result" },
    ],
    throwContextDestroyedOnEvaluate: 2,
  });

  const result = await executeAction({
    page,
    action: {
      id: "step-change-navigation",
      index: 5,
      raw: { type: "waitForIdle" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: true,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForChangeTimeoutMs: 500,
      waitForNav: false,
      waitForIdle: false,
      navigationBehavior: "ignore",
      navigationTarget: null,
      waitUntil: "domcontentloaded",
      stabilizationDelayMs: 0,
      retries: 0,
      retryDelayMs: 0,
      expectation: {
        kind: "waitForChange",
        timeoutMs: 500,
        intervalMs: 50,
      },
    },
    ocrService: { async runOcr() { return { detections: [], backend: "stub" }; } },
    artifactStore: createArtifactStore(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.expectation.type, "waitForChange");
});

test("waitForChange keeps retrying while login navigation replaces execution contexts", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, changed, changed, changed], {
    metas: [
      { url: "https://example.com/login", title: "Login", text: "Login" },
      { url: "https://example.com/workbench", title: "Workbench", text: "Workbench" },
      { url: "https://example.com/workbench", title: "Workbench", text: "Workbench" },
    ],
    throwContextDestroyedOnEvaluate: [2, 3],
  });

  const result = await executeAction({
    page,
    action: {
      id: "step-click-login",
      index: 6,
      raw: { type: "click" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: true,
      strictMatch: false,
      timeoutMs: 100,
      waitForChange: false,
      waitForChangeTimeoutMs: 500,
      waitForNav: false,
      waitForIdle: false,
      navigationBehavior: "ignore",
      navigationTarget: null,
      waitUntil: "domcontentloaded",
      stabilizationDelayMs: 0,
      retries: 0,
      retryDelayMs: 0,
      expectation: {
        kind: "waitForChange",
        timeoutMs: 500,
        intervalMs: 50,
      },
    },
    ocrService: { async runOcr() { return { detections: [], backend: "stub" }; } },
    artifactStore: createArtifactStore(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.expectation.type, "waitForChange");
  assert.equal(result.data.snapshot.after.url, "https://example.com/workbench");
});

test("executeAction observes delayed navigation instead of reading the old loaded document", async () => {
  const base = createPngBuffer(0, 0, 0);
  const changed = createPngBuffer(255, 255, 255);
  const page = createPage([base, changed], {
    metas: [
      { url: "https://example.com/login", title: "Login", text: "Login" },
      { url: "https://example.com/dashboard", title: "Dashboard", text: "Dashboard" },
      { url: "https://example.com/dashboard", title: "Dashboard", text: "Dashboard" },
    ],
    advanceMetaOnWait: true,
  });

  const result = await executeAction({
    page,
    action: {
      id: "step-5",
      index: 4,
      raw: { type: "waitForIdle" },
      kind: "waitForIdle",
      query: "",
      hints: [],
      needRes: false,
      strictMatch: false,
      timeoutMs: 500,
      waitForChange: false,
      waitForNav: false,
      waitForIdle: false,
      navigationBehavior: "required",
      navigationTimeoutMs: 500,
      waitUntil: "domcontentloaded",
      stabilizationDelayMs: 0,
      navigationTarget: null,
      retries: 0,
      retryDelayMs: 0,
      expectation: null,
    },
    ocrService: { async runOcr() { return null; } },
    artifactStore: createArtifactStore(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.action.navigation.observed, true);
  assert.equal(result.data.action.navigation.finalUrl, "https://example.com/dashboard");
});
