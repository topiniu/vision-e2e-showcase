const test = require("node:test");
const assert = require("node:assert/strict");
const { executeAction } = require("../../runtime");
const {
  invalidateUiFrameworkCache,
  observeNavigationAfterAction,
  safeDetectUiFrameworks,
  settlePageBeforeAction,
} = require("../../runtime/executor/navigation-recovery");

function createFakePage() {
  let evaluateCount = 0;
  const page = {
    url: () => "http://example.test/app",
    async waitForLoadState() {},
    async waitForTimeout() {},
    async screenshot() {
      return Buffer.from("fake-png");
    },
    async evaluate(fn) {
      evaluateCount += 1;
      const source = String(fn);
      if (source.includes("scriptsAndStyles")) {
        return {
          antd: {
            detected: true,
            confidence: 0.8,
            versionHint: null,
            components: ["select"],
            signals: { antClass: 8 },
          },
        };
      }
      return {
        url: "http://example.test/app",
        title: "Fixture",
        text: "Ready",
        interactables: [],
        viewport: {
          width: 1280,
          height: 720,
          scrollX: 0,
          scrollY: 0,
        },
      };
    },
    get evaluateCount() {
      return evaluateCount;
    },
  };
  return page;
}

function createArtifactStore() {
  const screenshots = [];
  const json = [];
  return {
    screenshots,
    json,
    async saveScreenshot(index, suffix, buffer) {
      screenshots.push({ index, suffix, buffer });
      return `/tmp/${index}-${suffix}.png`;
    },
    async saveJson(index, suffix, data) {
      json.push({ index, suffix, data });
      return `/tmp/${index}-${suffix}.json`;
    },
  };
}

function createTimingFakePage(options = {}) {
  const timeouts = [];
  const loadStates = [];
  const readinessQueue = [...(options.readinessQueue || [])];
  return {
    timeouts,
    loadStates,
    async waitForLoadState(state, options = {}) {
      loadStates.push({ state, timeout: options.timeout });
    },
    async waitForTimeout(ms) {
      timeouts.push(ms);
    },
    async evaluate(_fn, arg = null) {
      if (arg?.targetTexts) {
        return readinessQueue.length
          ? readinessQueue.shift()
          : {
              url: "http://example.test/app",
              title: "Fixture",
              textLength: 0,
              interactableCount: 0,
              targetTextMatched: false,
            };
      }
      return {
        url: "http://example.test/app",
        title: "Fixture",
      };
    },
  };
}

function createCaptureAction(overrides = {}) {
  return {
    id: "step-1",
    index: 0,
    raw: { type: "capture", needRes: true, evidenceProfile: "fast" },
    kind: "capture",
    phase: "case",
    query: "",
    target: {},
    actionDefinition: { needsTarget: false, mutatesPage: false },
    needRes: true,
    evidenceProfile: "fast",
    timeoutMs: 50,
    navigationBehavior: "ignore",
    waitUntil: "domcontentloaded",
    stabilizationDelayMs: 0,
    retries: 0,
    option: {},
    files: [],
    hints: [],
    strictMatch: false,
    expectation: null,
    ...overrides,
  };
}

test("fast evidence profile keeps trace telemetry without writing success screenshots or OCR", async () => {
  const page = createFakePage();
  const artifactStore = createArtifactStore();

  const result = await executeAction({
    page,
    action: createCaptureAction(),
    ocrService: {
      async runOcr() {
        throw new Error("OCR should not run in fast success path");
      },
    },
    artifactStore,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.beforeScreenshotPath, null);
  assert.equal(result.evidence.afterScreenshotPath, null);
  assert.equal(result.evidence.ocrPath, null);
  assert.equal(result.evidence.tracePath, "/tmp/0-trace.json");
  assert.equal(artifactStore.screenshots.length, 0);
  assert.equal(artifactStore.json.length, 1);
  const trace = artifactStore.json[0].data;
  assert.equal(trace.telemetry.evidenceProfile, "fast");
  assert.equal(trace.telemetry.stages.beforeState >= 0, true);
  assert.equal(trace.telemetry.stages.beforeSnapshot, 0);
  assert.equal(trace.telemetry.stages.performAction >= 0, true);
  assert.equal(trace.telemetry.stages.total >= 0, true);
  assert.equal(result.telemetry.evidenceProfile, "fast");
});

test("ui framework detection cache reuses same-page context until invalidated", async () => {
  const page = createFakePage();
  invalidateUiFrameworkCache(page);

  const first = await safeDetectUiFrameworks(page);
  const second = await safeDetectUiFrameworks(page);
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(page.evaluateCount, 1);

  invalidateUiFrameworkCache(page);
  const third = await safeDetectUiFrameworks(page);
  assert.equal(third.cache.hit, false);
  assert.equal(page.evaluateCount, 2);
});

test("adaptive settle returns immediately when page meta is readable", async () => {
  const page = createTimingFakePage();

  await settlePageBeforeAction(page, {
    kind: "capture",
    timeoutMs: 5000,
    settleStrategy: "adaptive",
    settleInitialMs: 50,
    settleMaxMs: 800,
  });

  assert.deepEqual(page.timeouts, []);
  assert.deepEqual(page.loadStates, []);
});

test("adaptive settle waits for target readiness instead of returning on readable meta only", async () => {
  const page = createTimingFakePage({
    readinessQueue: [
      {
        url: "http://example.test/login",
        title: "登录",
        textLength: 0,
        interactableCount: 0,
        targetTextMatched: false,
      },
      {
        url: "http://example.test/login",
        title: "登录",
        textLength: 12,
        interactableCount: 0,
        targetTextMatched: true,
      },
    ],
  });

  await settlePageBeforeAction(page, {
    kind: "click",
    query: "账号登陆",
    target: { text: "账号登陆" },
    actionDefinition: { needsTarget: true, mutatesPage: true },
    timeoutMs: 5000,
    settleStrategy: "adaptive",
    settleInitialMs: 50,
    settleMaxMs: 800,
  });

  assert.deepEqual(page.timeouts, [50]);
  assert.deepEqual(page.loadStates, []);
});

test("adaptive ignore navigation observation skips fixed stabilization delay", async () => {
  const page = createTimingFakePage();

  const navigation = await observeNavigationAfterAction(
    page,
    {
      kind: "capture",
      navigationBehavior: "ignore",
      waitForNav: false,
      waitForIdle: false,
      waitForChange: false,
      settleStrategy: "adaptive",
      stabilizationDelayMs: 250,
    },
    {
      url: "http://example.test/app",
      title: "Fixture",
    },
  );

  assert.equal(navigation.finalUrl, "http://example.test/app");
  assert.equal(navigation.finalTitle, "Fixture");
  assert.deepEqual(page.timeouts, []);
});

test("adaptive ignore navigation keeps stabilization for page-mutating actions", async () => {
  const page = createTimingFakePage();

  const navigation = await observeNavigationAfterAction(
    page,
    {
      kind: "click",
      actionDefinition: { mutatesPage: true },
      navigationBehavior: "ignore",
      waitForNav: false,
      waitForIdle: false,
      waitForChange: false,
      settleStrategy: "adaptive",
      stabilizationDelayMs: 250,
    },
    {
      url: "http://example.test/app",
      title: "Fixture",
    },
  );

  assert.equal(navigation.behavior, "ignore");
  assert.deepEqual(page.timeouts, [250]);
});
