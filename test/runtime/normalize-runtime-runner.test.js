const test = require("node:test");
const assert = require("node:assert/strict");
const {
  coercePayload,
  normalizePayload,
} = require("../../runtime/protocol/normalize");

test("coercePayload accepts relaxed JSON-like strings", () => {
  const parsed = coercePayload("{type:'click', target:{text:'账号登陆'}, needRes:true}");
  assert.equal(parsed.type, "click");
  assert.equal(parsed.target.text, "账号登陆");
  assert.equal(parsed.needRes, true);
});

test("normalizePayload preserves runtime-v2 retry and wait semantics", () => {
  const normalized = normalizePayload({
    type: "click",
    target: {
      text: "登录",
      autoScroll: {
        maxSteps: 4,
        deltaY: 200,
        settleMs: 90,
      },
    },
    needRes: true,
    waitForChange: true,
    waitForChangeTimeoutMs: 2400,
    retries: 2,
    retryDelayMs: 480,
  });

  assert.equal(normalized.mode, "single");
  assert.equal(normalized.actions[0].waitForChange, true);
  assert.equal(normalized.actions[0].waitForChangeTimeoutMs, 2400);
  assert.equal(normalized.actions[0].expectation.kind, "waitForChange");
  assert.equal(normalized.actions[0].retries, 2);
  assert.equal(normalized.actions[0].retryDelayMs, 480);
  assert.deepEqual(normalized.actions[0].autoScroll, {
    maxSteps: 4,
    deltaY: 200,
    settleMs: 90,
  });
});

test("normalizePayload falls back to timeoutMs for waitForChangeTimeoutMs", () => {
  const normalized = normalizePayload({
    type: "click",
    target: {
      text: "登录",
    },
    timeoutMs: 7300,
    waitForChange: true,
  });

  assert.equal(normalized.actions[0].waitForChangeTimeoutMs, 7300);
});

test("normalizePayload maps object expectations into runtime assertions", () => {
  const normalized = normalizePayload({
    type: "click",
    target: { text: "登录" },
    expectation: {
      type: "text-exists",
      text: ["欢迎回来"],
      timeoutMs: 6000,
      intervalMs: 300,
    },
  });

  assert.equal(normalized.actions[0].expectation.kind, "text-exists");
  assert.deepEqual(normalized.actions[0].expectation.texts, ["欢迎回来"]);
  assert.equal(normalized.actions[0].expectation.timeoutMs, 6000);
  assert.equal(normalized.actions[0].expectation.intervalMs, 300);
});

test("normalizePayload treats empty object expectations as absent", () => {
  const normalized = normalizePayload({
    type: "click",
    target: { text: "审价通过" },
    expectation: {},
  });

  assert.equal(normalized.actions[0].expectation, null);
});

test("normalizePayload keeps legacy waitForChange when expectation is empty", () => {
  const normalized = normalizePayload({
    type: "click",
    target: { text: "提交" },
    expectation: {},
    waitForChange: true,
    waitForChangeTimeoutMs: 7000,
  });

  assert.equal(normalized.actions[0].expectation.kind, "waitForChange");
  assert.equal(normalized.actions[0].expectation.timeoutMs, 7000);
});

test("normalizePayload preserves expectation scope", () => {
  const normalized = normalizePayload({
    type: "click",
    target: { text: "保存" },
    expectation: {
      kind: "text-absent",
      text: "请选择或搜索运营",
      scope: {
        role: "dialog",
        nearText: "创建任务任务",
        locator: ".ant-modal-content",
        testId: "demo-create-dialog",
      },
    },
  });

  assert.deepEqual(normalized.actions[0].expectation.scope, {
    nearText: "创建任务任务",
    role: "dialog",
    locator: ".ant-modal-content",
    testId: "demo-create-dialog",
  });
});

test("normalizePayload accepts texts alias on object expectations", () => {
  const normalized = normalizePayload({
    type: "click",
    target: { text: "搜索" },
    expectation: {
      kind: "text-exists",
      texts: ["共 132 条"],
    },
  });

  assert.deepEqual(normalized.actions[0].expectation.texts, ["共 132 条"]);
});

test("normalizePayload accepts navigation completion settings", () => {
  const normalized = normalizePayload({
    type: "click",
    target: { text: "登录" },
    navigationBehavior: "required",
    navigationTarget: {
      urlIncludes: "/dashboard",
      titleIncludes: "首页",
    },
    navigationTimeoutMs: 9000,
    waitUntil: "networkidle",
    stabilizationDelayMs: 420,
  });

  assert.equal(normalized.actions[0].navigationBehavior, "required");
  assert.equal(normalized.actions[0].navigationTimeoutMs, 9000);
  assert.equal(normalized.actions[0].waitUntil, "networkidle");
  assert.equal(normalized.actions[0].stabilizationDelayMs, 420);
  assert.deepEqual(normalized.actions[0].navigationTarget, {
    urlIncludes: "/dashboard",
    titleIncludes: "首页",
    pathEquals: "",
    urlMatches: "",
  });
});

test("normalizePayload carries run evidence profiles from options and action overrides", () => {
  const inherited = normalizePayload([
    { type: "capture" },
    { type: "click", target: { text: "提交" }, evidenceProfile: "turbo" },
  ], {
    runProfile: "fast",
  });

  assert.equal(inherited.evidenceProfile, "fast");
  assert.equal(inherited.actions[0].evidenceProfile, "fast");
  assert.equal(inherited.actions[0].runProfile, "fast");
  assert.equal(inherited.actions[1].evidenceProfile, "turbo");
  assert.equal(inherited.actions[1].runProfile, "turbo");

  const single = normalizePayload({
    type: "capture",
    profile: "turbo",
  });
  assert.equal(single.evidenceProfile, "turbo");
  assert.equal(single.actions[0].evidenceProfile, "turbo");
  assert.equal(single.actions[0].settleStrategy, "adaptive");
  assert.equal(single.actions[0].settleInitialMs, 50);
  assert.equal(single.actions[0].settleMaxMs, 800);

  const fallback = normalizePayload({ type: "capture", profile: "unknown" });
  assert.equal(fallback.evidenceProfile, "debug");
  assert.equal(fallback.actions[0].evidenceProfile, "debug");
  assert.equal(fallback.actions[0].settleStrategy, "fixed");
});

test("normalizePayload accepts explicit adaptive settle settings", () => {
  const normalized = normalizePayload({
    type: "capture",
    settleStrategy: "adaptive",
    settleInitialMs: 25,
    settleMaxMs: 300,
  });

  assert.equal(normalized.actions[0].settleStrategy, "adaptive");
  assert.equal(normalized.actions[0].settleInitialMs, 25);
  assert.equal(normalized.actions[0].settleMaxMs, 300);
});
