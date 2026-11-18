const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePayload } = require("../../runtime/protocol/normalize");

test("normalizePayload accepts single action strings", () => {
  const normalized = normalizePayload(
    '{"type":"click","target":{"text":"登录"},"retry":2}',
  );
  assert.equal(normalized.mode, "single");
  assert.equal(normalized.actions.length, 1);
  assert.equal(normalized.actions[0].kind, "click");
  assert.equal(normalized.actions[0].query, "登录");
  assert.equal(normalized.actions[0].retries, 2);
});

test("normalizePayload accepts batch payloads and expectation aliases", () => {
  const normalized = normalizePayload([
    {
      type: "type",
      target: { text: "账号", value: "DEMO_USER" },
      expected: { text: ["欢迎回来"], timeoutMs: 6000 },
    },
    {
      type: "click",
      target: { text: "登录" },
      waitForChange: true,
    },
  ]);

  assert.equal(normalized.mode, "batch");
  assert.equal(normalized.actions.length, 2);
  assert.equal(normalized.actions[0].kind, "fill");
  assert.deepEqual(normalized.actions[0].expectation.texts, ["欢迎回来"]);
  assert.equal(normalized.actions[1].waitForChange, true);
  assert.equal(normalized.actions[1].expectation.kind, "waitForChange");
});

test("normalizePayload maps inspect to assertVisible or capture", () => {
  const withQuery = normalizePayload({ type: "inspect", query: "创建任务" });
  const withoutQuery = normalizePayload({ type: "inspect" });

  assert.equal(withQuery.actions[0].kind, "assertVisible");
  assert.deepEqual(withQuery.actions[0].migration, {
    from: "inspect",
    to: "assertVisible",
  });
  assert.equal(withoutQuery.actions[0].kind, "capture");
});

test("normalizePayload converts top-level assertDom into capture with assertDom expectation", () => {
  const normalized = normalizePayload({
    id: "pt-finish-1",
    type: "assertDom",
    target: { testId: "demo-phase-lifecycle-finish-1" },
    property: "text",
    operator: "matches",
    expected: "\\d{4}-\\d{2}-\\d{2}",
    timeoutMs: 8000,
    intervalMs: 500,
  });

  assert.equal(normalized.actions[0].kind, "capture");
  assert.equal(normalized.actions[0].migration.from, "assertDom");
  assert.equal(normalized.actions[0].migration.to, "capture");
  assert.equal(normalized.actions[0].expectation.kind, "assertDom");
  assert.equal(normalized.actions[0].expectation.target.testId, "demo-phase-lifecycle-finish-1");
  assert.equal(normalized.actions[0].expectation.property, "text");
  assert.equal(normalized.actions[0].expectation.operator, "matches");
  assert.equal(normalized.actions[0].expectation.expected, "\\d{4}-\\d{2}-\\d{2}");
  assert.equal(normalized.actions[0].expectation.timeoutMs, 8000);
  assert.equal(normalized.actions[0].expectation.intervalMs, 500);
});

test("normalizePayload accepts search select and validates upload paths", () => {
  const selectAction = normalizePayload({
    type: "comboSearchSelect",
    target: {
      role: "combobox",
      name: "项目成员",
    },
    query: "示例团队",
    option: {
      text: "示例团队测试项目成员",
      match: "exact",
    },
  }).actions[0];

  assert.equal(selectAction.kind, "comboSearchSelect");
  assert.equal(selectAction.query, "示例团队");
  assert.equal(selectAction.target.name, "项目成员");
  assert.equal(selectAction.target.role, "combobox");
  assert.equal(selectAction.option.text, "示例团队测试项目成员");

  const targetlessSelectAction = normalizePayload({
    type: "comboSearchSelect",
    query: "示例团队",
    option: {
      text: "示例团队测试项目成员",
    },
  }).actions[0];
  assert.equal(targetlessSelectAction.kind, "comboSearchSelect");
  assert.equal(targetlessSelectAction.query, "示例团队");
  assert.equal(targetlessSelectAction.target.name, "");
  assert.equal(targetlessSelectAction.target.text, "");

  const placeholderSelectAction = normalizePayload({
    type: "comboSearchSelect",
    target: {
      placeholder: "请输入负责人姓名搜索",
    },
    query: "促",
    option: {
      text: "促佳贸易",
    },
  }).actions[0];
  assert.equal(placeholderSelectAction.target.placeholder, "请输入负责人姓名搜索");

  const delayedSelectAction = normalizePayload({
    type: "comboSearchSelect",
    target: {
      placeholder: "请输入负责人姓名搜索",
    },
    query: "促",
    option: {
      text: "促佳贸易",
      waitTimeoutMs: 9000,
      pollIntervalMs: 300,
    },
  }).actions[0];
  assert.equal(delayedSelectAction.optionWaitTimeoutMs, 9000);
  assert.equal(delayedSelectAction.optionPollIntervalMs, 300);

  const cascaderAction = normalizePayload({
    type: "cascaderSelect",
    target: {
      placeholder: "请选择类目",
      nearText: "创建任务任务",
    },
    option: {
      path: ["女士服装", "婚礼及活动", "花童 礼服"],
    },
  }).actions[0];
  assert.equal(cascaderAction.kind, "cascaderSelect");
  assert.deepEqual(cascaderAction.option.path, ["女士服装", "婚礼及活动", "花童 礼服"]);

  const scopedAction = normalizePayload({
    type: "fill",
    target: {
      placeholder: "重复输入",
      value: "scoped",
      scope: {
        testId: "scope-beta",
        nearText: "范围 B",
        locator: "",
      },
    },
  }).actions[0];
  assert.deepEqual(scopedAction.target.scope, {
    nearText: "范围 B",
    role: "",
    locator: "",
    testId: "scope-beta",
  });

  const topLevelScopedAction = normalizePayload({
    type: "comboSearchSelect",
    target: {
      placeholder: "请选择或搜索运营",
      role: "combobox",
    },
    targetScope: {
      testId: "demo-create-task-modal",
      nearText: "创建任务任务",
    },
    query: "促",
    option: {
      text: "促佳贸易",
    },
  }).actions[0];
  assert.deepEqual(topLevelScopedAction.target.scope, {
    nearText: "创建任务任务",
    role: "",
    locator: "",
    testId: "demo-create-task-modal",
  });

  const uploadAction = normalizePayload({
    type: "uploadFile",
    target: { text: "上传图片" },
    files: [{ path: "test-assets/demo/fixture.png" }],
  }).actions[0];
  assert.equal(uploadAction.kind, "uploadFile");
  assert.equal(uploadAction.files[0].path, "test-assets/demo/fixture.png");

  assert.throws(
    () =>
      normalizePayload({
        type: "uploadFile",
        target: { text: "上传图片" },
        files: [{ path: "../secret.jpg" }],
      }),
    /uploadFile path must be relative/,
  );
});

test("normalizePayload accepts expanded core web actions", () => {
  const normalized = normalizePayload([
    {
      type: "press",
      key: "Enter",
    },
    {
      type: "select",
      target: {
        name: "任务优先级",
      },
      optionValue: "P1",
    },
    {
      type: "assert.url",
      urlIncludes: "/demoWorkflow",
    },
    {
      type: "assert.count",
      target: {
        locator: ".result-row",
      },
      count: 2,
      operator: "atLeast",
    },
  ]);

  assert.equal(normalized.actions[0].kind, "press");
  assert.equal(normalized.actions[0].key, "Enter");
  assert.equal(normalized.actions[1].kind, "selectOption");
  assert.equal(normalized.actions[1].option.value, "P1");
  assert.equal(normalized.actions[2].kind, "assertUrl");
  assert.equal(normalized.actions[3].kind, "assertCount");
  assert.equal(normalized.actions[3].count, 2);
  assert.equal(normalized.actions[3].operator, "atLeast");
});

test("normalizePayload accepts v0.5 DOM and response assertions", () => {
  const normalized = normalizePayload([
    {
      type: "click",
      target: { text: "提交" },
      expectation: {
        kind: "networkResponse",
        urlIncludes: "/api/demo",
        status: 200,
        body: [{ path: "data.status", operator: "equals", expected: 8 }],
      },
    },
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
        body: [{ path: "data.phaseDone", expected: true }],
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
        operator: "equals",
        expected: "8",
      },
    },
  ]);

  assert.equal(normalized.actions[0].expectation.kind, "networkResponse");
  assert.equal(normalized.actions[0].expectation.status, 200);
  assert.deepEqual(normalized.actions[0].expectation.body, [
    // `first` is the v1.3 REQ-Z14 scalar-capture switch; defaults to false.
    { path: "data.status", operator: "equals", expected: 8, saveAs: "", first: false },
  ]);
  assert.equal(normalized.actions[1].kind, "callApi");
  assert.equal(normalized.actions[1].request.method, "POST");
  assert.equal(normalized.actions[1].request.url, "/api/demo/detail");
  assert.equal(normalized.actions[1].saveAs, "detail");
  assert.equal(normalized.actions[1].expectation.kind, "assertResponse");
  assert.equal(normalized.actions[2].expectation.kind, "assertDom");
  assert.equal(normalized.actions[2].expectation.target.tagText, "快速任务");
  assert.equal(normalized.actions[2].expectation.target.tagMatch, "exact");
  assert.equal(normalized.actions[2].expectation.property, "attribute");
  assert.equal(normalized.actions[2].expectation.attribute, "data-status");
});
