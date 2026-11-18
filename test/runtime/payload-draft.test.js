const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDefaultDraft,
  draftToRuntimePayload,
  getDraftWarnings,
  getStepDisplayTitle,
  parseLooseJson,
  runtimePayloadToDraft,
  summarizeDraftActions,
  validateDraft,
} = require("../../src/panel/lib/payload-draft");

test("draftToRuntimePayload serializes visual steps into runtime payload", () => {
  const draft = createDefaultDraft();
  const payload = draftToRuntimePayload(draft);

  assert.ok(Array.isArray(payload));
  assert.equal(payload.length, draft.steps.length);
  assert.equal(payload[0].id, draft.steps[0].id);
  assert.equal(payload[1].id, draft.steps[1].id);
  assert.equal(payload[0].type, "click");
  assert.equal(payload[1].target.value, "DEMO_USER");
  assert.ok(payload.some((step, index) => step.id === draft.steps[index].id));
  assert.ok(payload.some((step) => step.expectation?.kind === "text-exists"));
});

test("runtimePayloadToDraft preserves unsupported raw fields for round-trip editing", () => {
  const input = {
    id: "step-login",
    type: "click",
    target: {
      text: "登录",
      candidateIndex: 2,
    },
    customFlag: "keep-me",
    expectation: {
      type: "text-exists",
      text: "欢迎回来",
      customExpectationFlag: true,
    },
  };

  const draft = runtimePayloadToDraft(input);
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].id, "step-login");
  assert.equal(draft.steps[0].rawExtras.customFlag, "keep-me");
  assert.equal(draft.steps[0].targetExtras.candidateIndex, 2);
  assert.equal(draft.steps[0].expectation.rawExtras.customExpectationFlag, true);
  assert.equal(payload.id, draft.steps[0].id);
  assert.equal(payload.customFlag, "keep-me");
  assert.equal(payload.target.candidateIndex, 2);
  assert.equal(payload.expectation.customExpectationFlag, true);
});

test("runtimePayloadToDraft converts top-level assertDom into assertDom expectation", () => {
  const draft = runtimePayloadToDraft([
    {
      id: "pt-finish-1",
      type: "assertDom",
      stepTitle: "断环节结束时间为真实日期",
      target: { testId: "demo-phase-lifecycle-finish-1" },
      property: "text",
      operator: "matches",
      expected: "\\d{4}-\\d{2}-\\d{2}",
      timeoutMs: 8000,
      intervalMs: 500,
      retries: 1,
    },
  ]);
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].type, "capture");
  assert.equal(draft.steps[0].expectation.mode, "assertDom");
  assert.equal(draft.steps[0].expectation.rawExtras.target.testId, "demo-phase-lifecycle-finish-1");
  assert.equal(draft.steps[0].expectation.rawExtras.property, "text");
  assert.equal(draft.steps[0].expectation.rawExtras.operator, "matches");
  assert.equal(draft.steps[0].expectation.rawExtras.expected, "\\d{4}-\\d{2}-\\d{2}");
  assert.equal(payload.type, "capture");
  assert.deepEqual(payload.expectation, {
    kind: "assertDom",
    target: { testId: "demo-phase-lifecycle-finish-1" },
    property: "text",
    operator: "matches",
    expected: "\\d{4}-\\d{2}-\\d{2}",
    timeoutMs: 8000,
    intervalMs: 500,
  });
});

test("runtimePayloadToDraft preserves openUrl steps instead of downgrading to capture", () => {
  const draft = runtimePayloadToDraft({
    id: "nav-costorder",
    type: "openUrl",
    stepTitle: "跳转核价跟进页",
    url: "http://localhost:8000/demoCostOrder",
    needRes: true,
    timeoutMs: 15000,
    retries: 1,
    expectation: {
      kind: "assertDom",
      target: { testId: "demo-costorder-table" },
      property: "visible",
      expected: true,
      timeoutMs: 12000,
      intervalMs: 500,
    },
  });
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].type, "openUrl");
  assert.equal(draft.steps[0].query, "http://localhost:8000/demoCostOrder");
  assert.equal(payload.type, "openUrl");
  assert.equal(payload.url, "http://localhost:8000/demoCostOrder");
  assert.equal(payload.target, undefined);
  assert.equal(payload.expectation.kind, "assertDom");
  assert.deepEqual(validateDraft(draft), []);
});

test("validateDraft accepts targetless browser navigation controls", () => {
  const draft = runtimePayloadToDraft([
    { id: "reload-page", type: "reload" },
    { id: "back-page", type: "goBack" },
    { id: "forward-page", type: "goForward" },
    { id: "scroll-page", type: "scroll" },
  ]);

  assert.deepEqual(validateDraft(draft), []);
});

test("runtimePayloadToDraft accepts optional expectation and preserves expectation mode", () => {
  const draft = runtimePayloadToDraft([
    {
      id: "step-without-expectation",
      type: "fill",
      target: {
        placeholder: "请输入SPU或项目编号",
        value: "DEMO2026",
      },
    },
    {
      id: "step-with-mode-expectation",
      type: "click",
      target: {
        role: "button",
        text: "搜索",
      },
      expectation: {
        mode: "waitForChange",
        timeoutMs: 8000,
      },
    },
  ]);

  assert.equal(draft.steps[0].id, "step-without-expectation");
  assert.equal(draft.steps[0].expectation.mode, "none");
  assert.equal(draft.steps[0].placeholder, "请输入SPU或项目编号");
  assert.equal(draft.steps[0].value, "DEMO2026");
  assert.equal(draft.steps[1].expectation.mode, "waitForChange");
  assert.equal(draft.steps[1].expectation.timeoutMs, 8000);
});

test("runtimePayloadToDraft treats empty object expectations as absent", () => {
  const draft = runtimePayloadToDraft({
    id: "step-empty-expectation",
    type: "click",
    target: {
      testId: "demo-supply-chain-follow-review-approve-btn",
    },
    expectation: {},
  });
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].expectation.mode, "none");
  assert.equal(payload.expectation, undefined);
});

test("expectation scope round-trips through visual draft payload conversion", () => {
  const draft = runtimePayloadToDraft({
    id: "step-check-owner-placeholder",
    type: "click",
    target: {
      text: "选择运营",
    },
    expectation: {
      kind: "text-absent",
      text: "请选择或搜索运营",
      timeoutMs: 5000,
      scope: {
        role: "dialog",
        nearText: "创建任务任务",
        locator: ".ant-modal-content",
        testId: "create-task-modal",
      },
    },
  });
  const payload = draftToRuntimePayload(draft);

  assert.deepEqual(draft.steps[0].expectation.scope, {
    role: "dialog",
    nearText: "创建任务任务",
    locator: ".ant-modal-content",
    testId: "create-task-modal",
  });
  assert.deepEqual(payload.expectation.scope, {
    role: "dialog",
    nearText: "创建任务任务",
    locator: ".ant-modal-content",
    testId: "create-task-modal",
  });
});

test("target scope round-trips through visual draft payload conversion", () => {
  const draft = runtimePayloadToDraft({
    id: "step-scoped-fill",
    type: "fill",
    target: {
      placeholder: "重复输入",
      value: "scoped",
      scope: {
        locator: ".ant-modal-content",
        testId: "create-task-modal",
        role: "dialog",
        nearText: "创建任务任务",
      },
    },
  });
  const payload = draftToRuntimePayload(draft);

  assert.deepEqual(draft.steps[0].targetScope, {
    locator: ".ant-modal-content",
    testId: "create-task-modal",
    role: "dialog",
    nearText: "创建任务任务",
  });
  assert.deepEqual(payload.target.scope, {
    locator: ".ant-modal-content",
    testId: "create-task-modal",
    role: "dialog",
    nearText: "创建任务任务",
  });
  assert.equal(draft.steps[0].targetExtras.scope, undefined);
});

test("draft warnings flag unscoped high-reuse text-absent checks", () => {
  const draft = runtimePayloadToDraft({
    id: "step-risky-absent",
    type: "click",
    target: {
      text: "选择运营",
    },
    expectation: {
      kind: "text-absent",
      text: "请选择或搜索运营",
      timeoutMs: 5000,
    },
  });

  const warnings = getDraftWarnings(draft);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "unscoped-text-absent-risk");
  assert.match(warnings[0].message, /建议|consider adding expectation\.scope/);
});

test("draft warnings do not flag scoped text-absent checks", () => {
  const draft = runtimePayloadToDraft({
    id: "step-scoped-absent",
    type: "click",
    target: {
      text: "选择运营",
    },
    expectation: {
      kind: "text-absent",
      text: "请选择或搜索运营",
      scope: {
        role: "dialog",
        nearText: "创建任务任务",
      },
    },
  });

  assert.deepEqual(getDraftWarnings(draft), []);
});

test("validateDraft accepts icon-only target hints without requiring query", () => {
  const draft = runtimePayloadToDraft({
    id: "step-click-icon-add",
    type: "click",
    target: {
      role: "button",
      iconHint: "add",
      nearText: "款式图",
    },
  });

  assert.deepEqual(validateDraft(draft), []);
});

test("validateDraft reports missing target instead of missing query", () => {
  const draft = runtimePayloadToDraft({
    id: "step-click-missing-target",
    type: "click",
  });
  const errors = validateDraft(draft);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /target is required/);
});

test("draftToRuntimePayload round-trips advanced timing and runtime flags", () => {
  const input = {
    type: "click",
    target: {
      text: "登录",
    },
    needRes: false,
    timeoutMs: 6400,
    expectation: {
      kind: "waitForChange",
      timeoutMs: 2200,
      threshold: 0.002,
    },
    retries: 3,
    retryDelayMs: 480,
    strictMatch: true,
    enableScroll: true,
    waitForNav: true,
    waitForIdle: true,
    navigationBehavior: "required",
    navigationTimeoutMs: 7200,
    waitUntil: "networkidle",
    settleStrategy: "adaptive",
    settleInitialMs: 25,
    settleMaxMs: 500,
    stabilizationDelayMs: 450,
    navigationTarget: {
      urlIncludes: "/dashboard",
    },
    autoScroll: {
      maxSteps: 8,
      deltaY: 240,
      settleMs: 120,
    },
  };

  const draft = runtimePayloadToDraft(input);
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].expectation.mode, "waitForChange");
  assert.equal(draft.steps[0].expectation.timeoutMs, 2200);
  assert.equal(draft.steps[0].expectation.threshold, 0.002);
  assert.equal(draft.steps[0].needRes, false);
  assert.equal(draft.steps[0].strictMatch, true);
  assert.equal(draft.steps[0].enableScroll, true);
  assert.equal(draft.steps[0].waitForNav, true);
  assert.equal(draft.steps[0].waitForIdle, true);
  assert.equal(draft.steps[0].navigationBehavior, "required");
  assert.equal(draft.steps[0].navigationTimeoutMs, 7200);
  assert.equal(draft.steps[0].waitUntil, "networkidle");
  assert.equal(draft.steps[0].settleStrategy, "adaptive");
  assert.equal(draft.steps[0].settleInitialMs, 25);
  assert.equal(draft.steps[0].settleMaxMs, 500);
  assert.equal(draft.steps[0].stabilizationDelayMs, 450);
  assert.deepEqual(payload.autoScroll, {
    maxSteps: 8,
    deltaY: 240,
    settleMs: 120,
  });
  assert.equal(payload.expectation.kind, "waitForChange");
  assert.equal(payload.expectation.timeoutMs, 2200);
  assert.equal(payload.expectation.threshold, 0.002);
  assert.equal(payload.needRes, false);
  assert.equal(payload.strictMatch, true);
  assert.equal(payload.enableScroll, true);
  assert.equal(payload.waitForNav, true);
  assert.equal(payload.waitForIdle, true);
  assert.equal(payload.navigationBehavior, "required");
  assert.equal(payload.navigationTimeoutMs, 7200);
  assert.equal(payload.waitUntil, "networkidle");
  assert.equal(payload.settleStrategy, "adaptive");
  assert.equal(payload.settleInitialMs, 25);
  assert.equal(payload.settleMaxMs, 500);
  assert.equal(payload.stabilizationDelayMs, 450);
  assert.deepEqual(payload.navigationTarget, {
    urlIncludes: "/dashboard",
  });
});

test("runtimePayloadToDraft folds waitForChange and expectation into composite expectation", () => {
  const draft = runtimePayloadToDraft({
    type: "click",
    target: { text: "登录" },
    waitForChange: true,
    waitForChangeTimeoutMs: 1800,
    expectation: {
      type: "text-exists",
      text: ["欢迎回来"],
      timeoutMs: 6000,
    },
  });

  assert.equal(draft.steps[0].expectation.mode, "composite");
  assert.equal(draft.steps[0].expectation.assertions.length, 2);
  assert.equal(draft.steps[0].expectation.assertions[0].mode, "waitForChange");
  assert.equal(draft.steps[0].expectation.assertions[0].timeoutMs, 1800);
  assert.equal(draft.steps[0].expectation.assertions[1].mode, "text-exists");
});

test("runtimePayloadToDraft round-trips core web action fields", () => {
  const draft = runtimePayloadToDraft([
    {
      type: "comboSearchSelect",
      target: {
        strategy: "role",
        role: "combobox",
        name: "项目成员",
        nearText: "创建任务",
      },
      query: "示例团队",
      option: {
        text: "示例团队测试项目成员",
        match: "contains",
      },
      optionWaitTimeoutMs: 9000,
      optionPollIntervalMs: 300,
    },
    {
      type: "cascaderSelect",
      target: {
        strategy: "auto",
        name: "请选择类目",
        nearText: "创建任务",
      },
      option: {
        path: ["女士服装", "婚礼及活动", "花童 礼服"],
        match: "contains",
      },
    },
    {
      type: "uploadFile",
      target: {
        strategy: "label",
        name: "上传图片",
      },
      files: [{ path: "test-assets/demo/fixture.png" }],
      mode: "input",
    },
    {
      type: "inspect",
      query: "上传成功",
    },
  ]);
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].type, "comboSearchSelect");
  assert.equal(draft.steps[0].targetName, "项目成员");
  assert.equal(draft.steps[0].role, "combobox");
  assert.equal(draft.steps[0].optionText, "示例团队测试项目成员");
  assert.equal(draft.steps[0].optionWaitTimeoutMs, 9000);
  assert.equal(draft.steps[0].optionPollIntervalMs, 300);
  assert.equal(draft.steps[1].type, "cascaderSelect");
  assert.equal(draft.steps[1].optionPathText, "女士服装 / 婚礼及活动 / 花童 礼服");
  assert.equal(draft.steps[2].type, "uploadFile");
  assert.equal(draft.steps[2].filesText, "test-assets/demo/fixture.png");
  assert.equal(draft.steps[3].type, "assertVisible");
  assert.equal(payload[0].option.text, "示例团队测试项目成员");
  assert.equal(payload[0].optionWaitTimeoutMs, 9000);
  assert.equal(payload[0].optionPollIntervalMs, 300);
  assert.equal(payload[0].target.name, "项目成员");
  assert.equal(payload[0].target.placeholder, "项目成员");
  assert.deepEqual(payload[1].option.path, ["女士服装", "婚礼及活动", "花童 礼服"]);
  assert.equal(payload[2].files[0].path, "test-assets/demo/fixture.png");
  assert.equal(payload[3].type, "assertVisible");
});

test("runtimePayloadToDraft round-trips expanded core web action fields", () => {
  const draft = runtimePayloadToDraft([
    {
      type: "press",
      key: "Enter",
    },
    {
      type: "selectOption",
      target: {
        name: "任务优先级",
      },
      option: {
        value: "P1",
        index: 1,
      },
    },
    {
      type: "assertUrl",
      urlIncludes: "/demoWorkflow",
    },
    {
      type: "assertCount",
      target: {
        locator: ".result-row",
      },
      count: 2,
      operator: "atLeast",
    },
  ]);
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].type, "press");
  assert.equal(draft.steps[0].value, "Enter");
  assert.equal(draft.steps[1].type, "selectOption");
  assert.equal(draft.steps[1].optionValue, "P1");
  assert.equal(draft.steps[1].optionIndex, 1);
  assert.equal(draft.steps[2].type, "assertUrl");
  assert.equal(draft.steps[2].query, "/demoWorkflow");
  assert.equal(draft.steps[3].type, "assertCount");
  assert.equal(draft.steps[3].value, "2");
  assert.equal(draft.steps[3].rawExtras.operator, "atLeast");
  assert.equal(validateDraft(draft).length, 0);
  assert.equal(payload[0].key, "Enter");
  assert.equal(payload[1].option.value, "P1");
  assert.equal(payload[1].option.index, 1);
  assert.equal(payload[2].urlIncludes, "/demoWorkflow");
  assert.equal(payload[3].count, 2);
  assert.equal(payload[3].operator, "atLeast");
});

test("step titles round-trip separately from target title and drive summaries", () => {
  const draft = runtimePayloadToDraft([
    {
      type: "click",
      stepTitle: "打开创建任务",
      target: {
        title: "create-task-button",
      },
    },
    {
      type: "cascaderSelect",
      target: {
        name: "请选择类目",
      },
      option: {
        path: ["宠物用品", "宠物用品", "猫用品"],
      },
    },
  ]);
  const payload = draftToRuntimePayload(draft);
  const summaries = summarizeDraftActions(draft);

  assert.equal(draft.steps[0].stepTitle, "打开创建任务");
  assert.equal(draft.steps[0].title, "create-task-button");
  assert.equal(payload[0].stepTitle, "打开创建任务");
  assert.equal(payload[0].target.title, "create-task-button");
  assert.equal(getStepDisplayTitle(draft.steps[0]), "打开创建任务");
  assert.equal(getStepDisplayTitle(draft.steps[1]), "宠物用品 / 宠物用品 / 猫用品");
  assert.equal(summaries[0].title, "1. click -> 打开创建任务");
  assert.equal(summaries[1].title, "2. cascaderSelect -> 宠物用品 / 宠物用品 / 猫用品");
});

test("runtimePayloadToDraft round-trips v0.5 business assertion fields", () => {
  const draft = runtimePayloadToDraft([
    {
      type: "callApi",
      request: {
        method: "POST",
        url: "/api/demo/detail",
        headers: { "x-test": "1" },
        query: { id: "A001" },
        body: { status: 8 },
      },
      saveAs: "detail",
      expectation: {
        kind: "assertResponse",
        status: 200,
        body: [{ path: "data.status", expected: 8 }],
      },
    },
    {
      type: "click",
      target: { text: "提交" },
      expectation: {
        kind: "networkResponse",
        urlIncludes: "/api/demo",
        status: 200,
      },
    },
    {
      type: "assertVisible",
      target: { testId: "quick-task-row" },
      expectation: {
        kind: "assertDom",
        target: { testId: "quick-task-row", hasText: "自动化测试-快速任务-001", tagText: "快速任务", tagMatch: "exact" },
        property: "attribute",
        attribute: "data-status",
        expected: "8",
      },
    },
  ]);
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].type, "callApi");
  assert.equal(draft.steps[0].requestMethod, "POST");
  assert.equal(draft.steps[0].requestUrl, "/api/demo/detail");
  assert.match(draft.steps[0].requestBodyText, /"status": 8/);
  assert.equal(payload[0].request.method, "POST");
  assert.equal(payload[0].saveAs, "detail");
  assert.equal(payload[0].expectation.kind, "assertResponse");
  assert.deepEqual(payload[1].expectation, {
    kind: "networkResponse",
    urlIncludes: "/api/demo",
    status: 200,
  });
  assert.equal(payload[2].expectation.kind, "assertDom");
  assert.equal(payload[2].expectation.target.testId, "quick-task-row");
  assert.equal(payload[2].expectation.target.hasText, "自动化测试-快速任务-001");
  assert.equal(payload[2].expectation.target.tagText, "快速任务");
  assert.equal(payload[2].expectation.target.tagMatch, "exact");
  assert.equal(payload[2].expectation.attribute, "data-status");
});

test("draft warnings flag weak v0.5 business assertions", () => {
  const draft = runtimePayloadToDraft([
    {
      type: "uploadFile",
      target: { text: "上传图片" },
      files: [{ path: "test-assets/demo/fixture.png" }],
      expectation: { kind: "waitForChange" },
    },
    {
      type: "click",
      target: { text: "提交" },
      expectation: { kind: "networkResponse", status: 200 },
    },
    {
      type: "assertVisible",
      target: { text: "快速任务" },
      expectation: { kind: "assertDom", target: { text: "快速任务" }, property: "exists" },
    },
    {
      type: "comboSearchSelect",
      target: { role: "textbox" },
      option: {},
    },
    {
      type: "cascaderSelect",
      target: { role: "combobox", placeholder: "类目" },
      option: { text: "猫用品" },
    },
    {
      type: "click",
      target: { placeholder: "请选择或搜索项目成员" },
    },
  ]);

  const codes = getDraftWarnings(draft).map((item) => item.code).sort();
  assert.deepEqual(codes, [
    "antd-select-click-risk",
    "assert-dom-table-row-scope-risk",
    "assert-dom-target-risk",
    "cascader-option-path-risk",
    "combo-search-select-option-risk",
    "combo-search-select-role-risk",
    "combo-search-select-target-risk",
    "network-response-url-required",
    "wait-for-change-only-risk",
  ]);
});

test("runtimePayloadToDraft round-trips useMacro actions", () => {
  const draft = runtimePayloadToDraft([
    {
      id: "use-open-create",
      type: "useMacro",
      macro: "openCreateSamplingTask",
    },
  ]);
  const payload = draftToRuntimePayload(draft);

  assert.equal(draft.steps[0].type, "useMacro");
  assert.equal(draft.steps[0].macro, "openCreateSamplingTask");
  assert.equal(getStepDisplayTitle(draft.steps[0]), "openCreateSamplingTask");
  assert.deepEqual(validateDraft(draft), []);
  assert.deepEqual(payload, {
    id: "use-open-create",
    type: "useMacro",
    macro: "openCreateSamplingTask",
  });
});

test("parseLooseJson accepts relaxed JSON syntax used by the old panel", () => {
  const payload = parseLooseJson("{type:'click', target:{text:'账号登陆'}, needRes:true}");
  assert.equal(payload.type, "click");
  assert.equal(payload.target.text, "账号登陆");
  assert.equal(payload.needRes, true);
});
