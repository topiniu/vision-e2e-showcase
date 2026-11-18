const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { precheckTestFile } = require("../../src/shared/test-file-precheck");

test("precheck returns scope schema and non-blocking warnings for risky unscoped text-absent", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Scoped expectation precheck",
    cases: [
      {
        id: "case-dialog",
        name: "Dialog",
        steps: [
          {
            id: "step-click-submit",
            type: "click",
            target: {
              role: "button",
              text: "确定",
            },
            expectation: {
              kind: "text-absent",
              text: "请选择或搜索运营",
              timeoutMs: 5000,
            },
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.summary.warningCount, 1);
  assert.equal(result.warnings[0].code, "unscoped-text-absent-risk");
  assert.equal(result.warnings[0].caseId, "case-dialog");
  assert.equal(result.warnings[0].stepId, "step-click-submit");
  assert.equal(result.schema.expectation.scope.fields.nearText.type, "string");
  assert.deepEqual(result.schema.expectation.scope.aliases, ["expectation.within"]);
  assert.equal(result.schema.target.scope.field, "target.scope");
  assert.match(result.schema.target.scope.description, /hard boundary/);
});

test("precheck does not warn when risky text-absent has scope", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Scoped expectation precheck",
    cases: [
      {
        id: "case-dialog",
        name: "Dialog",
        steps: [
          {
            id: "step-click-submit",
            type: "click",
            target: {
              role: "button",
              text: "确定",
            },
            expectation: {
              kind: "text-absent",
              text: "请选择或搜索运营",
              scope: {
                role: "dialog",
                nearText: "创建任务任务",
              },
              timeoutMs: 5000,
            },
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.warningCount, 0);
});

test("precheck returns blocking errors for invalid draft steps", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Invalid file",
    cases: [
      {
        id: "case-invalid",
        name: "Invalid",
        steps: [
          {
            id: "step-fill-empty",
            type: "fill",
            target: {
              placeholder: "请输入SPU货号",
            },
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.summary.errorCount, 1);
  assert.equal(result.errors[0].code, "draft-validation-error");
  assert.equal(result.errors[0].caseId, "case-invalid");
  assert.equal(result.errors[0].stepIndex, 0);
});

test("precheck warns when a case has too many steps", () => {
  const steps = Array.from({ length: 13 }, (_, index) => ({
    id: `step-${index + 1}`,
    type: "click",
    target: {
      role: "button",
      text: `按钮 ${index + 1}`,
    },
  }));

  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Long case file",
    cases: [
      {
        id: "case-long",
        name: "创建任务任务完整流程",
        steps,
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.warningCount, 1);
  assert.equal(result.warnings[0].code, "case-many-steps");
  assert.equal(result.warnings[0].caseId, "case-long");
  assert.equal(result.warnings[0].stepCount, 13);
  assert.equal(result.warnings[0].path, "cases[0].steps");
});

test("precheck strongly warns when a case is excessively long", () => {
  const steps = Array.from({ length: 21 }, (_, index) => ({
    id: `step-${index + 1}`,
    type: "click",
    target: {
      role: "button",
      text: `按钮 ${index + 1}`,
    },
  }));

  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Excessive case file",
    cases: [
      {
        id: "case-excessive",
        name: "创建任务任务全需求",
        steps,
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.warningCount, 1);
  assert.equal(result.warnings[0].code, "case-excessive-steps");
  assert.equal(result.warnings[0].stepCount, 21);
  assert.match(result.warnings[0].message, /Very long cases are hard to debug/);
});

test("precheck recognizes macro steps and nested composite proof without user-authored locator workarounds", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Automatic quality inference",
    macros: {
      createTask: {
        steps: [
          {
            id: "macro-create",
            type: "click",
            target: { testId: "create-task" },
            expectation: {
              kind: "text-exists",
              scope: { testId: "create-task-modal" },
              text: ["创建任务"],
            },
          },
        ],
      },
    },
    cases: [
      {
        id: "case-auto",
        name: "Auto inferred proof",
        steps: [
          { id: "use-create", type: "useMacro", macro: "createTask" },
          {
            id: "search",
            type: "click",
            stepTitle: "搜索任务",
            target: { testId: "search-task" },
            expectation: {
              kind: "composite",
              assertions: [
                { kind: "networkResponse", urlIncludes: "/tasks", status: 200 },
                { kind: "text-exists", scope: { testId: "task-table" }, text: ["TASK-1"] },
              ],
            },
          },
          {
            id: "submit",
            type: "click",
            stepTitle: "提交任务",
            target: { testId: "submit-task" },
            expectation: {
              kind: "text-absent",
              scope: { role: "dialog" },
              text: ["创建任务"],
            },
          },
          {
            id: "supplier",
            type: "comboSearchSelect",
            target: { testId: "supplier-select" },
            option: { text: "项目成员 A" },
          },
          {
            id: "navigate-by-text",
            type: "click",
            target: { text: "任务跟进", name: "任务跟进" },
            expectation: {
              kind: "assertDom",
              target: { testId: "supply-chain-search" },
              property: "visible",
              operator: "equals",
              expected: true,
            },
          },
          {
            id: "resident",
            type: "click",
            target: { role: "radio", name: "入驻项目成员", nearText: "项目成员类型" },
            expectation: {
              kind: "assertDom",
              target: { role: "radio", name: "入驻项目成员", nearText: "项目成员类型" },
              property: "checked",
              operator: "equals",
              expected: true,
            },
          },
          {
            id: "upload-front",
            type: "uploadFile",
            target: { testId: "upload-front" },
            files: [{ path: "test-assets/front.png" }],
            expectation: { kind: "waitForChange" },
          },
          {
            id: "verify-upload",
            type: "capture",
            expectation: {
              kind: "text-exists",
              scope: { testId: "uploaded-images" },
              text: ["1 张"],
            },
          },
        ],
      },
    ],
  });

  const codes = result.issues.map((item) => item.code);
  assert.equal(codes.includes("target-missing"), false);
  assert.equal(codes.includes("search-global-assert-visible"), false);
  assert.equal(codes.includes("combo-search-select-target-risk"), false);
  assert.equal(codes.includes("radio-checked-assertion-risk"), false);
  assert.equal(codes.includes("target-weak-text-only"), false);
  assert.equal(codes.includes("wait-for-change-only-risk"), false);
  assert.equal(codes.includes("wait-for-change-only-business-proof"), false);
  assert.equal(result.quality.steps.find((step) => step.stepId === "use-create")?.locatorGrade, "A");
  assert.ok(result.quality.steps.find((step) => step.stepId === "search")?.proofScore >= 55);
  assert.ok(result.quality.steps.find((step) => step.stepId === "submit")?.proofScore >= 55);
});

test("precheck exposes v0.5 business assertion schema and warnings", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "v0.5 precheck",
    cases: [
      {
        id: "case-business",
        name: "Business assertions",
        steps: [
          {
            id: "step-api",
            type: "callApi",
            request: {
              method: "GET",
              url: "/api/demo/detail",
            },
            expectation: {
              kind: "assertResponse",
              status: 200,
            },
          },
          {
            id: "step-submit",
            type: "click",
            target: {
              role: "button",
              text: "提交",
            },
            expectation: {
              kind: "networkResponse",
              status: 200,
            },
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.schema.expectation.assertDom.kind, "assertDom");
  assert.deepEqual(result.schema.expectation.response.kinds, ["assertResponse", "networkResponse"]);
  assert.equal(result.schema.actions.callApi.type, "callApi");
  assert.equal(result.schema.actions.useMacro.type, "useMacro");
  assert.equal(result.schema.scaffold.macros.field, "macros");
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "network-response-url-required");
});

test("precheck warns for orphan assertion token and accepts vars token binding", () => {
  const orphan = precheckTestFile({
    schemaVersion: 2,
    name: "Token lint",
    cases: [
      {
        id: "case-token",
        name: "Token",
        steps: [
          {
            id: "write-token",
            type: "fill",
            target: { placeholder: "请输入打样需求描述" },
            value: "自动化测试·复版历史·{{$timestamp}}",
          },
          {
            id: "assert-token",
            type: "click",
            target: { text: "搜索" },
            expectation: {
              kind: "text-exists",
              text: ["自动化测试·L1·sanity·供应链审版通过·{{$timestamp}}"],
            },
          },
        ],
      },
    ],
  });
  assert.equal(orphan.ok, true);
  assert.equal(orphan.warnings.some((item) => item.code === "orphan-assertion-token"), true);

  const bound = precheckTestFile({
    schemaVersion: 2,
    name: "Token lint",
    vars: {
      caseToken: "自动化测试·复版历史·{{$timestamp}}",
    },
    cases: [
      {
        id: "case-token",
        name: "Token",
        steps: [
          {
            id: "write-token",
            type: "fill",
            target: { placeholder: "请输入打样需求描述" },
            value: "{{caseToken}}",
          },
          {
            id: "assert-token",
            type: "click",
            target: { text: "搜索" },
            expectation: {
              kind: "text-exists",
              text: ["{{caseToken}}"],
            },
          },
        ],
      },
    ],
  });
  assert.equal(bound.warnings.some((item) => item.code === "orphan-assertion-token"), false);
});

test("precheck warns for missing login bootstrap and unknown variables", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Missing login",
    baseUrl: "http://localhost/login",
    cases: [
      {
        id: "case-business",
        name: "Business",
        steps: [
          {
            id: "open-create",
            type: "click",
            target: { testId: "demo-search-create-task" },
            expectation: {
              kind: "text-exists",
              text: ["{{missingToken}}"],
            },
          },
        ],
      },
    ],
  });
  const codes = result.warnings.map((item) => item.code);
  assert.equal(codes.includes("missing-login-bootstrap"), true);
  assert.equal(codes.includes("unknown-template-variable"), true);
});

// v1.4 REQ-Z17: with the recovery model in place the advice inverts — the file
// CAN log in, so the problem is that a login-page baseUrl makes every case start
// on /login (each case is re-navigated to baseUrl) instead of on the app page.
test("precheck swaps missing-login-bootstrap for base-url-login-page when login recovery exists", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Login recovery declared",
    baseUrl: "http://localhost/login",
    recovery: {
      login: {
        detect: { urlIncludes: "/login" },
        steps: [{ id: "click-login", type: "click", target: { text: "登 录", role: "button" } }],
      },
    },
    cases: [
      {
        id: "case-business",
        name: "Business",
        steps: [
          {
            id: "open-create",
            type: "click",
            target: { testId: "demo-search-create-task" },
          },
        ],
      },
    ],
  });
  const codes = result.warnings.map((item) => item.code);
  assert.equal(codes.includes("base-url-login-page"), true);
  assert.equal(codes.includes("missing-login-bootstrap"), false);
  const warning = result.warnings.find((item) => item.code === "base-url-login-page");
  assert.equal(warning.path, "baseUrl");
  assert.deepEqual(warning.recoveryKeys, ["login"]);
});

test("precheck stays quiet about login when baseUrl is a business page", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Business baseUrl",
    baseUrl: "http://localhost/demoWorkflow",
    recovery: {
      login: {
        detect: { urlIncludes: "/login" },
        steps: [{ id: "click-login", type: "click", target: { text: "登 录", role: "button" } }],
      },
    },
    cases: [
      {
        id: "case-business",
        name: "Business",
        steps: [{ id: "open-create", type: "click", target: { testId: "demo-search-create-task" } }],
      },
    ],
  });
  const codes = result.warnings.map((item) => item.code);
  assert.equal(codes.includes("base-url-login-page"), false);
  assert.equal(codes.includes("missing-login-bootstrap"), false);
});

test("precheck warns when updatedAt is stale for a changed file", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-precheck-"));
  const filePath = path.join(rootDir, "case.json");
  const existing = {
    schemaVersion: 2,
    name: "Original",
    updatedAt: "2026-06-30T00:00:00.000Z",
    cases: [{ id: "case-a", name: "A", steps: [] }],
  };
  fs.writeFileSync(filePath, JSON.stringify(existing), "utf8");

  const result = precheckTestFile({
    rootDir,
    path: "case.json",
    testFile: {
      ...existing,
      name: "Changed",
    },
  });

  assert.equal(result.warnings.some((item) => item.code === "updated-at-stale"), true);
});

test("precheck dry-run snapshot reports missing testId", () => {
  const result = precheckTestFile({
    testFile: {
      schemaVersion: 2,
      name: "Dry run",
      cases: [
        {
          id: "case-dry",
          name: "Dry",
          steps: [
            {
              id: "click-missing",
              type: "click",
              target: { testId: "demo-missing-button" },
            },
          ],
        },
      ],
    },
    dryRun: {
      mode: "snapshot",
      snapshot: {
        text: "页面已有内容",
        interactables: [{ text: "搜索", role: "button" }],
      },
    },
  });

  assert.equal(result.dryRun.checkedCount, 1);
  assert.equal(result.warnings.some((item) => item.code === "testid-never-rendered"), true);
});

test("precheck warns for unstable radio checked assertions", () => {
  const result = precheckTestFile({
    testFile: {
      schemaVersion: 2,
      name: "Radio checked risk",
      cases: [
        {
          id: "case-radio",
          name: "Radio",
          steps: [
            {
              id: "select-overtime",
              type: "click",
              target: { role: "radio", text: "已超时" },
              expectation: {
                kind: "assertDom",
                target: { role: "radio", name: "已超时" },
                property: "checked",
                operator: "equals",
                expected: true,
              },
            },
          ],
        },
      ],
    },
  });

  const issue = result.issues.find((item) => item.code === "radio-checked-assertion-risk");
  assert.equal(result.ok, true);
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.path, "cases[0].steps[0].expectation.target");
  assert.match(issue?.message || "", /RadioGroup-style controls/);
});

test("precheck allows radio checked assertions with stable targets", () => {
  const result = precheckTestFile({
    testFile: {
      schemaVersion: 2,
      name: "Stable radio checked",
      cases: [
        {
          id: "case-radio-stable",
          name: "Radio stable",
          steps: [
            {
              id: "select-overtime",
              type: "click",
              target: { testId: "demo-filter-phase-overtime-option-1" },
              expectation: {
                kind: "assertDom",
                target: { testId: "demo-filter-phase-overtime-option-1", role: "radio" },
                property: "checked",
                operator: "equals",
                expected: true,
              },
            },
          ],
        },
      ],
    },
  });

  assert.equal(result.issues.some((item) => item.code === "radio-checked-assertion-risk"), false);
});

test("precheck blocks missing fixture and macro references", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "scaffold errors",
    fixtures: {
      loginSession: {
        setup: [],
        teardown: [],
      },
    },
    macros: {
      openCreate: {
        steps: [{ id: "step-click", type: "click", target: { text: "Create" } }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        fixtures: ["missingFixture"],
        steps: [
          { id: "missing-name", type: "useMacro" },
          { id: "missing-macro", type: "useMacro", macro: "missingMacro" },
        ],
      },
    ],
  });

  const codes = result.errors.map((item) => item.code).sort();
  assert.equal(result.ok, false);
  assert.deepEqual(codes, [
    "draft-validation-error",
    "fixture-not-found",
    "macro-name-required",
    "macro-not-found",
  ]);
});

test("precheck blocks macro cycles and invalid scaffold step containers", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "macro cycle",
    setup: { steps: "bad" },
    fixtures: {
      login: {
        setup: "bad",
        teardown: [],
      },
    },
    macros: {
      a: { steps: [{ type: "useMacro", macro: "b" }] },
      b: { steps: [{ type: "useMacro", macro: "a" }] },
    },
    cases: [{ id: "case-a", name: "A", fixtures: ["login"], steps: [] }],
  });

  const codes = result.errors.map((item) => item.code).sort();
  assert.equal(result.ok, false);
  assert.ok(codes.includes("scaffold-steps-array-required"));
  assert.ok(codes.includes("macro-cycle"));
});

test("precheck exposes component and fallback assertion guardrail warnings", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "guardrails",
    cases: [
      {
        id: "case-guardrails",
        name: "Guardrails",
        steps: [
          {
            id: "submit-pixels",
            type: "click",
            target: { text: "提交" },
            expectation: { kind: "waitForChange" },
          },
          {
            id: "bad-select",
            type: "comboSearchSelect",
            target: { role: "textbox" },
            option: {},
          },
          {
            id: "bad-cascader",
            type: "cascaderSelect",
            target: { role: "combobox", placeholder: "类目" },
            option: { text: "猫用品" },
          },
          {
            id: "bad-row-dom",
            type: "assertVisible",
            target: { text: "快速任务" },
            expectation: { kind: "assertDom", target: { text: "快速任务" }, property: "text" },
          },
        ],
      },
    ],
  });

  const codes = result.warnings.map((item) => item.code).sort();
  assert.equal(result.ok, false);
  assert.ok(codes.includes("wait-for-change-only-risk"));
  assert.ok(codes.includes("combo-search-select-role-risk"));
  assert.ok(codes.includes("combo-search-select-target-risk"));
  assert.ok(codes.includes("combo-search-select-option-risk"));
  assert.ok(codes.includes("cascader-option-path-risk"));
  assert.ok(codes.includes("assert-dom-table-row-scope-risk"));
});

test("precheck warns for brittle dynamic count and search wait patterns", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "Search filter brittleness",
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
            stepTitle: "点击搜索并验证结果条数",
            target: {
              role: "button",
              text: "搜索",
            },
            expectation: {
              kind: "composite",
              assertions: [
                {
                  kind: "waitForChange",
                  timeoutMs: 8000,
                },
                {
                  kind: "text-exists",
                  text: "共 132 条",
                  timeoutMs: 8000,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const codes = result.warnings.map((item) => item.code).sort();
  assert.equal(result.ok, true);
  assert.ok(codes.includes("dynamic-count-literal-risk"));
  assert.ok(codes.includes("composite-waitforchange-first-risk"));
  assert.ok(codes.includes("search-waitforchange-after-fill-risk"));

  const countWarning = result.warnings.find((item) => item.code === "dynamic-count-literal-risk");
  assert.equal(countWarning.caseId, "case-filter-spu");
  assert.equal(countWarning.stepId, "step-click-search-spu");
  assert.match(countWarning.path, /expectation\.assertions\[1\]\.text/);
  assert.equal(countWarning.literal, "共 132 条");

  const searchWarning = result.warnings.find((item) => item.code === "search-waitforchange-after-fill-risk");
  assert.equal(searchWarning.previousStepId, "step-fill-spu");
});

test("precheck blocks top-level assertDom with nested expectation that would be shadowed", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    id: "shadowed-assertion",
    name: "Shadowed assertion",
    cases: [
      {
        id: "case-shadowed",
        name: "Shadowed",
        steps: [
          {
            id: "step-assert-shipping",
            type: "assertDom",
            target: {
              testId: "demo-supply-chain-submission-images-section",
            },
            property: "visible",
            operator: "equals",
            expected: true,
            expectation: {
              kind: "text-exists",
              scope: {
                testId: "demo-supply-chain-submission-images-section",
              },
              text: ["1 张", "暂无发货图片/单据截图"],
            },
          },
        ],
      },
    ],
  });

  const error = result.errors.find((item) => item.code === "top-level-assertdom-nested-expectation-shadowed");
  const issue = result.issues.find((item) => item.code === "top-level-assertdom-nested-expectation-shadowed");
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(error.path, "cases[0].steps[0].expectation");
  assert.equal(error.stepId, "step-assert-shipping");
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.category, "proof");
});

test("v0.6 validate gate exposes quality issues and advisory blocking without breaking legacy ok", () => {
  const result = precheckTestFile({
    mode: "advisory",
    testFile: {
      schemaVersion: 2,
      id: "ai-bad-json",
      name: "AI bad JSON",
      cases: [
        {
          id: "case-create",
          name: "Create",
          steps: [
            {
              id: "step-submit",
              type: "click",
              intent: "submit-create",
              target: { iconHint: "plus" },
              expectation: { kind: "waitForChange" },
            },
          ],
        },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.quality.summary.overall, "blocked");
  assert.equal(result.quality.steps[0].locatorGrade, "E");
  assert.equal(result.quality.steps[0].proofGrade, "E");
  const codes = result.issues.map((item) => item.code);
  assert.ok(codes.includes("icon-only-with-icon-hint-only"));
  assert.ok(codes.includes("wait-for-change-only-business-proof"));
  const issue = result.issues.find((item) => item.code === "wait-for-change-only-business-proof");
  assert.equal(issue.evidenceSource, "static-analysis");
  assert.equal(typeof issue.evidenceConfidence, "number");
});

test("precheck does not emit target-missing/locatorScore false positives for openUrl steps (Z07)", () => {
  const result = precheckTestFile({
    schemaVersion: 2,
    name: "openUrl navigation",
    cases: [
      {
        id: "case-open",
        name: "Open board",
        steps: [
          {
            id: "open-board",
            type: "openUrl",
            stepTitle: "打开主看板",
            url: "http://127.0.0.1:8000/demoWorkflow",
            expectation: {
              kind: "assertDom",
              target: { testId: "demo-search-create-task" },
              property: "visible",
              operator: "equals",
              expected: true,
            },
          },
        ],
      },
    ],
  });

  const openStepIssues = result.issues.filter((item) => item.stepId === "open-board");
  assert.equal(openStepIssues.some((item) => item.code === "target-missing"), false);
  // openUrl must not be scored as if it needs a locator.
  const openQuality = result.quality.steps.find((step) => step.stepId === "open-board");
  assert.equal(openQuality.locatorGrade, "A");
});

test("precheck does not crash on fill value echoed in its own expectation (Z07 hasScopedExpectation)", () => {
  // Regression: expressionHasGlobalInputAssertion referenced hasScopedExpectation
  // without importing it, throwing `hasScopedExpectation is not defined`.
  let result;
  assert.doesNotThrow(() => {
    result = precheckTestFile({
      schemaVersion: 2,
      name: "Echoed input",
      cases: [
        {
          id: "case-echo",
          name: "Echo",
          steps: [
            {
              id: "fill-spu",
              type: "fill",
              target: { placeholder: "请输入SPU货号" },
              value: "DEMO2026",
              expectation: {
                kind: "text-exists",
                text: ["DEMO2026"],
              },
            },
          ],
        },
      ],
    });
  });
  // Unscoped assertion echoing the input value is a real (now-reachable) finding.
  assert.equal(result.issues.some((item) => item.code === "search-global-assert-visible"), true);

  // Scoped variant proves hasScopedExpectation now resolves and suppresses the finding.
  const scoped = precheckTestFile({
    schemaVersion: 2,
    name: "Echoed input scoped",
    cases: [
      {
        id: "case-echo-scoped",
        name: "Echo scoped",
        steps: [
          {
            id: "fill-spu",
            type: "fill",
            target: { placeholder: "请输入SPU货号" },
            value: "DEMO2026",
            expectation: {
              kind: "text-exists",
              scope: { testId: "demo-result-table" },
              text: ["DEMO2026"],
            },
          },
        ],
      },
    ],
  });
  assert.equal(scoped.issues.some((item) => item.code === "search-global-assert-visible"), false);
});

test("v0.6 patch review blocks stale and proof-regressing patches", () => {
  const before = {
    schemaVersion: 2,
    id: "patch-file",
    name: "Patch file",
    cases: [
      {
        id: "case-create",
        name: "Create",
        steps: [
          {
            id: "step-submit",
            type: "click",
            intent: "submit-create",
            target: { testId: "submit" },
            expectation: {
              kind: "networkResponse",
              urlIncludes: "/create",
              body: [{ path: "data.id", saveAs: "taskId" }],
            },
          },
        ],
      },
    ],
  };
  const after = {
    ...before,
    cases: [
      {
        ...before.cases[0],
        steps: [
          {
            ...before.cases[0].steps[0],
            expectation: { kind: "text-exists", text: "创建成功" },
          },
        ],
      },
    ],
  };

  const result = precheckTestFile({
    mode: "patch-review",
    beforeHash: "stale",
    fileFingerprint: { contentHash: "stale" },
    before,
    after,
  });

  const codes = result.issues.map((item) => item.code);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("patch-stale"));
  assert.ok(codes.includes("proof-regression"));
  assert.equal(result.patchReview.beforeQuality.summary.proofGrade, "A");
});
