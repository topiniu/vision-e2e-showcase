const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createTestFileDraft,
  buildExecutableCaseSteps,
  getSelectedCaseId,
  isSafeRelativeTestFilePath,
  normalizeTestFile,
  runtimeDraftToTestFile,
  testFileToRuntimeDraft,
} = require("../../src/shared/test-file");
const {
  resolveAndNormalizeTestFile,
  resolveTestFileReferences,
} = require("../../src/shared/test-file-references");
const { compareTestFileItems } = require("../../src/shared/test-file-sort");

test("normalizeTestFile migrates v1 root steps into the default case", () => {
  const file = normalizeTestFile({
    schemaVersion: 1,
    name: "登录流程",
    tags: "app, login",
    steps: [{ id: "s1", type: "click", query: "登录" }],
  });

  assert.equal(file.schemaVersion, 2);
  assert.equal(file.id, "登录流程");
  assert.equal(file.name, "登录流程");
  assert.deepEqual(file.tags, ["app", "login"]);
  assert.equal(file.settings.evidence, true);
  assert.equal(file.settings.evidenceProfile, "debug");
  assert.equal(file.steps, undefined);
  assert.equal(file.cases.length, 1);
  assert.equal(file.cases[0].name, "默认用例");
  assert.equal(file.cases[0].steps.length, 1);
});

test("compareTestFileItems uses natural version order for test file groups", () => {
  const files = [
    { group: "示例任务/v5.9.1", name: "复版", path: "demo-5-9-1.json" },
    { group: "示例任务/v5.8", name: "快速任务", path: "demo-5-8.json" },
    { group: "示例任务/v5.9", name: "创建任务", path: "demo-5-9.json" },
    { group: "示例任务/demo.1", name: "旧版本", path: "demo-5-7-1.json" },
  ];

  assert.deepEqual(files.sort(compareTestFileItems).map((file) => file.group), [
    "示例任务/demo.1",
    "示例任务/v5.8",
    "示例任务/v5.9",
    "示例任务/v5.9.1",
  ]);
});

test("normalizeTestFile preserves v2 requirement, group, cases, and settings", () => {
  const file = normalizeTestFile({
    schemaVersion: 2,
    name: "demo 示例任务需求",
    createdAt: "2026-06-22T21:07:50+08:00",
    updatedAt: "2026-06-24T11:55:07+08:00",
    group: "示例任务/demo",
    requirement: {
      name: "示例任务",
      version: "demo",
      owner: "QA",
      module: "DEMO",
      description: "需求说明",
    },
    cases: [
      { id: "case-a", name: "A", priority: "P0", tags: "smoke", steps: [{ id: "a1" }] },
      { id: "case-b", name: "B", priority: "P1", steps: [{ id: "b1" }] },
    ],
    settings: {
      evidence: false,
      evidenceProfile: "fast",
      retries: 1,
    },
    vars: {
      caseToken: "自动化测试·{{$timestamp}}",
    },
    extends: "common/base.json",
  });

  assert.equal(file.schemaVersion, 2);
  assert.equal(file.group, "示例任务/demo");
  assert.equal(file.createdAt, "2026-06-22T21:07:50+08:00");
  assert.equal(file.updatedAt, "2026-06-24T11:55:07+08:00");
  assert.equal(file.requirement.version, "demo");
  assert.equal(file.cases.length, 2);
  assert.deepEqual(file.cases[0].tags, ["smoke"]);
  assert.equal(file.settings.evidence, false);
  assert.equal(file.settings.evidenceProfile, "fast");
  assert.equal(file.settings.retries, 1);
  assert.equal(file.vars.caseToken, "自动化测试·{{$timestamp}}");
  assert.equal(file.extends, "common/base.json");
});

test("normalizeTestFile falls back invalid evidence profile to debug", () => {
  const file = normalizeTestFile({
    name: "Invalid profile",
    settings: {
      evidenceProfile: "full",
    },
  });

  assert.equal(file.settings.evidenceProfile, "debug");
});

test("normalizeTestFile preserves v0.5 scaffold fields", () => {
  const file = normalizeTestFile({
    schemaVersion: 2,
    name: "Scaffold JSON",
    setup: { steps: [{ id: "setup-open", type: "click", target: { text: "Open" } }] },
    teardown: { steps: [{ id: "cleanup", type: "callApi", request: { url: "/cleanup" } }], alwaysRun: true },
    fixtures: {
      loginSession: {
        setup: [{ id: "login", type: "click", target: { text: "Login" } }],
        teardown: [{ id: "logout", type: "click", target: { text: "Logout" } }],
      },
    },
    macros: {
      openCreate: {
        steps: [{ id: "open-create", type: "click", target: { text: "Create" } }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: "loginSession",
        steps: [{ id: "use-open", type: "useMacro", macro: "openCreate" }],
      },
    ],
  });

  assert.equal(file.setup.steps[0].id, "setup-open");
  assert.equal(file.teardown.alwaysRun, true);
  assert.deepEqual(file.cases[0].fixtures, ["loginSession"]);
  assert.equal(file.fixtures.loginSession.setup[0].id, "login");
  assert.equal(file.macros.openCreate.steps[0].id, "open-create");
});

test("buildExecutableCaseSteps expands setup fixtures case macros and teardown in order", () => {
  const file = normalizeTestFile({
    name: "Executable scaffold",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    teardown: { steps: [{ id: "root-teardown", type: "capture" }] },
    fixtures: {
      loginSession: {
        setup: [{ id: "fixture-setup", type: "capture" }],
        teardown: [{ id: "fixture-teardown", type: "capture" }],
      },
    },
    macros: {
      openCreate: {
        steps: [
          { id: "open", type: "click", target: { text: "Create" } },
          { id: "ready", type: "assertVisible", target: { text: "Ready" } },
        ],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: ["loginSession"],
        steps: [
          { id: "macro-a", type: "useMacro", macro: "openCreate" },
          { id: "case-submit", type: "click", target: { text: "Submit" } },
        ],
      },
    ],
  });

  const steps = buildExecutableCaseSteps(file, "case-a");

  assert.deepEqual(steps.map((step) => step.phase), [
    "setup",
    "fixtureSetup",
    "case",
    "case",
    "case",
    "fixtureTeardown",
    "teardown",
  ]);
  assert.deepEqual(steps.map((step) => step.id), [
    "root-setup",
    "fixture-setup",
    "openCreate::open::1",
    "openCreate::ready::1",
    "case-submit",
    "fixture-teardown",
    "root-teardown",
  ]);
  assert.equal(steps[1].sourceFixture, "loginSession");
  assert.equal(steps[2].sourceMacro, "openCreate");
});

test("resolveTestFileReferences merges extends and local fixture refs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-test-refs-"));
  fs.mkdirSync(path.join(rootDir, "common"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "common", "base.json"), JSON.stringify({
    name: "Base",
    group: "示例任务/Base",
    baseUrl: "http://localhost/login",
    vars: { baseToken: "base-{{$timestamp}}", caseToken: "base-case" },
    setup: { steps: [{ id: "base-login", type: "click", target: { text: "登 录" } }] },
    fixtures: {
      baseFixture: { setup: [{ id: "base-fixture", type: "capture" }], teardown: [] },
    },
    macros: {
      baseMacro: { steps: [{ id: "base-macro", type: "capture" }] },
    },
    cases: [{ id: "base-case", name: "Base case", steps: [{ id: "should-not-inherit" }] }],
  }), "utf8");
  fs.writeFileSync(path.join(rootDir, "common", "login-fixture.json"), JSON.stringify({
    setup: [{ id: "ref-login", type: "capture" }],
    teardown: [{ id: "ref-clean", type: "capture" }],
  }), "utf8");

  const file = resolveAndNormalizeTestFile({
    extends: "common/base.json",
    name: "Child",
    vars: { caseToken: "child-{{$timestamp}}" },
    fixtures: {
      login: { $ref: "common/login-fixture.json" },
    },
    cases: [
      { id: "case-child", name: "Child case", fixtures: ["login"], steps: [{ id: "body", type: "capture" }] },
    ],
  }, { rootDir });
  const steps = buildExecutableCaseSteps(file, "case-child");

  assert.equal(file.name, "Child");
  assert.equal(file.group, "示例任务/Base");
  assert.equal(file.vars.baseToken, "base-{{$timestamp}}");
  assert.equal(file.vars.caseToken, "child-{{$timestamp}}");
  assert.equal(file.setup.steps[0].id, "base-login");
  assert.equal(file.cases.length, 1);
  assert.equal(file.cases[0].id, "case-child");
  assert.deepEqual(steps.map((step) => step.id), ["base-login", "ref-login", "body", "ref-clean"]);
});

test("resolveTestFileReferences rejects unsafe and cyclic references", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-test-refs-"));
  fs.writeFileSync(path.join(rootDir, "a.json"), JSON.stringify({ extends: "b.json", name: "A" }), "utf8");
  fs.writeFileSync(path.join(rootDir, "b.json"), JSON.stringify({ extends: "a.json", name: "B" }), "utf8");

  assert.throws(
    () => resolveTestFileReferences({ extends: "../outside.json" }, { rootDir }),
    /safe relative JSON path/,
  );
  assert.throws(
    () => resolveTestFileReferences({ extends: "a.json" }, { rootDir }),
    /Reference cycle detected/,
  );
});

test("buildExecutableCaseSteps can build file-run root and case segments separately", () => {
  const file = normalizeTestFile({
    name: "Segmented file run",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    teardown: { steps: [{ id: "root-teardown", type: "capture" }] },
    fixtures: {
      loginSession: {
        setup: [{ id: "fixture-setup", type: "capture" }],
        teardown: [{ id: "fixture-teardown", type: "capture" }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: ["loginSession"],
        steps: [{ id: "case-submit", type: "click", target: { text: "Submit" } }],
      },
    ],
  });

  const rootSetup = buildExecutableCaseSteps(file, "case-a", {
    includeRootSetup: true,
    includeFixtureSetup: false,
    includeCaseSteps: false,
    includeFixtureTeardown: false,
    includeRootTeardown: false,
  });
  const caseOnly = buildExecutableCaseSteps(file, "case-a", {
    includeRootSetup: false,
    includeRootTeardown: false,
  });
  const rootTeardown = buildExecutableCaseSteps(file, "case-a", {
    includeRootSetup: false,
    includeFixtureSetup: false,
    includeCaseSteps: false,
    includeFixtureTeardown: false,
    includeRootTeardown: true,
  });

  assert.deepEqual(rootSetup.map((step) => step.id), ["root-setup"]);
  assert.deepEqual(caseOnly.map((step) => step.id), ["fixture-setup", "case-submit", "fixture-teardown"]);
  assert.deepEqual(rootTeardown.map((step) => step.id), ["root-teardown"]);
});

test("buildExecutableCaseSteps limits case body by 1-based step range", () => {
  const file = normalizeTestFile({
    name: "Range",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    teardown: { steps: [{ id: "root-teardown", type: "capture" }] },
    fixtures: {
      loginSession: {
        setup: [{ id: "fixture-setup", type: "capture" }],
        teardown: [{ id: "fixture-teardown", type: "capture" }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: ["loginSession"],
        steps: [
          { id: "case-1", type: "click", target: { text: "One" } },
          { id: "case-2", type: "click", target: { text: "Two" } },
          { id: "case-3", type: "click", target: { text: "Three" } },
          { id: "case-4", type: "click", target: { text: "Four" } },
        ],
      },
    ],
  });

  const steps = buildExecutableCaseSteps(file, "case-a", {
    caseStepStartIndex: 2,
    caseStepEndIndex: 3,
  });

  assert.deepEqual(steps.map((step) => step.id), [
    "root-setup",
    "fixture-setup",
    "case-2",
    "case-3",
    "fixture-teardown",
    "root-teardown",
  ]);
});

test("buildExecutableCaseSteps can skip case fixtures while keeping case body", () => {
  const file = normalizeTestFile({
    name: "Case fixtures toggle",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    teardown: { steps: [{ id: "root-teardown", type: "capture" }] },
    fixtures: {
      loginSession: {
        setup: [{ id: "fixture-setup", type: "capture" }],
        teardown: [{ id: "fixture-teardown", type: "capture" }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: ["loginSession"],
        steps: [
          { id: "case-1", type: "click", target: { text: "One" } },
          { id: "case-2", type: "click", target: { text: "Two" } },
        ],
      },
    ],
  });

  const steps = buildExecutableCaseSteps(file, "case-a", {
    includeRootSetup: false,
    includeFixtureSetup: false,
    includeFixtureTeardown: false,
    includeRootTeardown: false,
  });

  assert.deepEqual(steps.map((step) => step.id), ["case-1", "case-2"]);
  assert.deepEqual(steps.map((step) => step.phase), ["case", "case"]);
});

test("buildExecutableCaseSteps expands only the selected macro step for step debug", () => {
  const file = normalizeTestFile({
    name: "Macro step debug",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    macros: {
      openCreate: {
        steps: [{ id: "open", type: "click", target: { text: "Create" } }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        steps: [
          { id: "macro-a", type: "useMacro", macro: "openCreate" },
          { id: "case-submit", type: "click", target: { text: "Submit" } },
        ],
      },
    ],
  });

  const steps = buildExecutableCaseSteps(file, "case-a", { stepId: "macro-a" });

  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, "openCreate::open::1");
  assert.equal(steps[0].phase, "case");
  assert.equal(steps[0].sourceMacro, "openCreate");
});

test("buildExecutableCaseSteps expands only the selected regular step for step debug", () => {
  const file = normalizeTestFile({
    name: "Single step debug",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    fixtures: {
      loginSession: {
        setup: [{ id: "fixture-setup", type: "capture" }],
        teardown: [{ id: "fixture-teardown", type: "capture" }],
      },
    },
    macros: {
      openCreate: {
        steps: [{ id: "open", type: "click", target: { text: "Create" } }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: ["loginSession"],
        steps: [
          { id: "macro-a", type: "useMacro", macro: "openCreate" },
          { id: "fill-dynamic", type: "fill", target: { text: "SPU" }, value: "{{spu}}" },
          { id: "submit", type: "click", target: { text: "Submit" } },
        ],
      },
    ],
  });

  const steps = buildExecutableCaseSteps(file, "case-a", {
    stepId: "fill-dynamic",
  });

  assert.deepEqual(steps.map((step) => step.id), ["fill-dynamic"]);
  assert.deepEqual(steps.map((step) => step.phase), ["case"]);
  assert.equal(steps.some((step) => step.id === "root-setup"), false);
  assert.equal(steps.some((step) => step.id === "fixture-setup"), false);
  assert.equal(steps.some((step) => step.id === "openCreate::open::1"), false);
  assert.equal(steps.some((step) => step.id === "fixture-teardown"), false);
  assert.equal(steps.some((step) => step.id === "submit"), false);
});

test("buildExecutableCaseSteps expands only the selected fixture step for step debug", () => {
  const file = normalizeTestFile({
    name: "Fixture step debug",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    fixtures: {
      fxHome: {
        setup: [{ id: "fx-open", type: "click", target: { text: "Home" } }],
        teardown: [{ id: "fx-clean", type: "click", target: { text: "Clean" } }],
      },
      fxSupply: {
        setup: [
          { id: "fx-owner", type: "comboSearchSelect", target: { placeholder: "负责人" }, query: "促" },
          { id: "fx-operator", type: "comboSearchSelect", target: { placeholder: "运营" }, query: "促" },
        ],
        teardown: [],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: ["fxHome", "fxSupply"],
        steps: [{ id: "case-submit", type: "click", target: { text: "Submit" } }],
      },
    ],
  });

  const setupSteps = buildExecutableCaseSteps(file, "case-a", {
    stepId: "fx-owner",
    stepPhase: "fixtureSetup",
    sourceFixture: "fxSupply",
  });
  const teardownSteps = buildExecutableCaseSteps(file, "case-a", {
    stepId: "fx-clean",
    stepPhase: "fixtureTeardown",
    sourceFixture: "fxHome",
  });

  assert.deepEqual(setupSteps.map((step) => step.id), ["fx-owner"]);
  assert.equal(setupSteps[0].phase, "fixtureSetup");
  assert.equal(setupSteps[0].sourceFixture, "fxSupply");
  assert.deepEqual(teardownSteps.map((step) => step.id), ["fx-clean"]);
  assert.equal(teardownSteps[0].phase, "fixtureTeardown");
  assert.equal(teardownSteps[0].sourceFixture, "fxHome");
});

test("case-aware draft conversion only updates the selected case", () => {
  const testFile = createTestFileDraft({
    name: "Workbench",
    cases: [
      { id: "case-a", name: "A", steps: [{ id: "a1", type: "inspect", query: "标题" }] },
      { id: "case-b", name: "B", steps: [{ id: "b1", type: "click", query: "保存" }] },
    ],
  });
  const runtimeDraft = testFileToRuntimeDraft(testFile, "case-b");
  const nextFile = runtimeDraftToTestFile(
    { steps: [...runtimeDraft.steps, { id: "b2", type: "inspect", query: "完成" }] },
    {
      ...testFile,
      result: { ok: true },
    },
    "case-b",
  );

  assert.equal(getSelectedCaseId(testFile, "missing"), "case-a");
  assert.equal(runtimeDraft.steps[0].id, "b1");
  assert.equal(runtimeDraft.steps[0].expectation.mode, "none");
  assert.equal(nextFile.name, "Workbench");
  assert.equal(nextFile.cases[0].steps.length, 1);
  assert.equal(nextFile.cases[1].steps.length, 2);
  assert.equal(nextFile.result, undefined);
});

test("runtimeDraftToTestFile saves runtime payload instead of visual draft fields", () => {
  const testFile = createTestFileDraft({
    name: "Upload JSON",
    cases: [
      {
        id: "case-upload",
        name: "上传图片",
        steps: [
          {
            id: "step-upload-front-image",
            type: "uploadFile",
            stepTitle: "上传正面图",
            query: "正面图",
            target: {
              testId: "demo-create-task-style-upload-front",
            },
            files: [{ path: "test-assets/demo/fixture.png" }],
            expectation: {
              kind: "waitForChange",
              timeoutMs: 15000,
            },
          },
        ],
      },
    ],
  });
  const runtimeDraft = testFileToRuntimeDraft(testFile, "case-upload");
  const nextFile = runtimeDraftToTestFile(runtimeDraft, testFile, "case-upload");
  const [step] = nextFile.cases[0].steps;

  assert.equal(step.type, "uploadFile");
  assert.equal(step.query, "正面图");
  assert.deepEqual(step.files, [{ path: "test-assets/demo/fixture.png" }]);
  assert.equal(step.filesText, undefined);
  assert.equal(step.uploadMode, undefined);
  assert.equal(step.targetExtras, undefined);
  assert.equal(step.rawExtras, undefined);
});

test("runtimeDraftToTestFile preserves file settings while saving cases", () => {
  const testFile = createTestFileDraft({
    name: "Settings JSON",
    settings: {
      evidence: true,
      evidenceProfile: "turbo",
      retries: 2,
      customSetting: "keep",
    },
    cases: [
      {
        id: "case-click",
        name: "点击",
        steps: [{ id: "step-click", type: "click", target: { text: "搜索" } }],
      },
    ],
  });
  const runtimeDraft = testFileToRuntimeDraft(testFile, "case-click");
  const nextFile = runtimeDraftToTestFile(runtimeDraft, testFile, "case-click");

  assert.equal(nextFile.settings.evidence, true);
  assert.equal(nextFile.settings.evidenceProfile, "turbo");
  assert.equal(nextFile.settings.retries, 2);
  assert.equal(nextFile.settings.customSetting, "keep");
});

test("testFileToRuntimeDraft recovers upload files from previously saved visual draft fields", () => {
  const testFile = createTestFileDraft({
    name: "Recovered upload JSON",
    cases: [
      {
        id: "case-upload",
        name: "上传图片",
        steps: [
          {
            id: "step-upload-front-image",
            type: "uploadFile",
            query: "正面图",
            testId: "demo-create-task-style-upload-front",
            filesText: "test-assets/demo/fixture.png",
            uploadMode: "input",
          },
        ],
      },
    ],
  });
  const runtimeDraft = testFileToRuntimeDraft(testFile, "case-upload");
  const nextFile = runtimeDraftToTestFile(runtimeDraft, testFile, "case-upload");
  const [step] = nextFile.cases[0].steps;

  assert.equal(runtimeDraft.steps[0].filesText, "test-assets/demo/fixture.png");
  assert.equal(runtimeDraft.steps[0].uploadMode, "input");
  assert.equal(step.query, "正面图");
  assert.deepEqual(step.files, [{ path: "test-assets/demo/fixture.png" }]);
  assert.equal(step.filesText, undefined);
  assert.equal(step.uploadMode, undefined);
});

test("testFileToRuntimeDraft normalizes external runtime steps for Build cases", () => {
  const testFile = createTestFileDraft({
    name: "External JSON",
    cases: [
      {
        id: "case-filter-spu",
        name: "SPU/项目编号 筛选",
        steps: [
          {
            id: "step-fill-spu",
            type: "fill",
            stepTitle: "输入 SPU 关键字",
            target: {
              placeholder: "请输入SPU或项目编号",
              value: "DEMO2026",
            },
          },
          {
            id: "step-click-search-spu",
            type: "click",
            target: {
              role: "button",
              text: "搜索",
            },
            expectation: {
              kind: "waitForChange",
              timeoutMs: 8000,
            },
          },
        ],
      },
    ],
  });

  const runtimeDraft = testFileToRuntimeDraft(testFile, "case-filter-spu");

  assert.equal(runtimeDraft.steps[0].id, "step-fill-spu");
  assert.equal(runtimeDraft.steps[0].stepTitle, "输入 SPU 关键字");
  assert.equal(runtimeDraft.steps[0].placeholder, "请输入SPU或项目编号");
  assert.equal(runtimeDraft.steps[0].value, "DEMO2026");
  assert.equal(runtimeDraft.steps[0].expectation.mode, "none");
  assert.equal(runtimeDraft.steps[1].expectation.mode, "waitForChange");
  assert.equal(runtimeDraft.steps[1].expectation.timeoutMs, 8000);
});

test("recovery model: demo base declares recovery.login and asserts the board via fxHome", () => {
  // v1.2.1 recovery model: login moved out of a setup-nav block into a
  // recovery.login handler (detect on /login); the "board is ready" assertion
  // now lives in the fxHome fixture that re-positions each case.
  const root = path.join(process.cwd(), "test", "fixtures");
  const raw = JSON.parse(fs.readFileSync(path.join(root, "recovery-workflow.json"), "utf8"));
  const resolved = resolveAndNormalizeTestFile(raw, { rootDir: root, sourcePath: "recovery-workflow.json" });

  // Login is now a declared recovery handler, not a text-guessed setup block.
  assert.equal(resolved.recovery?.login?.detect?.urlIncludes, "/login");
  assert.ok(resolved.recovery.login.steps.length >= 1);
  // No login logic leaks into setup any more.
  assert.equal((resolved.setup?.steps || []).length, 0);

  // The final "demo board visible" assertion moved into the fxHome nav step.
  const fxNav = (resolved.fixtures?.fxHome?.setup || []).find((step) => step.id === "fxhome-nav");
  assert.equal(fxNav?.expectation?.kind, "assertDom");
  assert.deepEqual(fxNav.expectation.target, { testId: "demo-search-create-task" });
  assert.equal(fxNav.expectation.property, "visible");
  assert.equal(fxNav.expectation.expected, true);
});

test("test file paths reject traversal and non-json files", () => {
  assert.equal(isSafeRelativeTestFilePath("login.json"), true);
  assert.equal(isSafeRelativeTestFilePath("app/login.json"), true);
  assert.equal(isSafeRelativeTestFilePath("../secret.json"), false);
  assert.equal(isSafeRelativeTestFilePath("/tmp/secret.json"), false);
  assert.equal(isSafeRelativeTestFilePath("login.txt"), false);
});
