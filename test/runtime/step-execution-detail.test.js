const test = require("node:test");
const assert = require("node:assert/strict");
const { createStepExecutionDetail } = require("../../src/panel/lib/step-execution-detail");

test("step execution detail prefers trace evidence and builds typed rows", () => {
  const detail = createStepExecutionDetail({
    step: {
      title: "Submit",
      status: "passed",
      type: "click",
      evidence: {
        tracePath: "/tmp/output/runs/run/steps/01-attempt-2-trace.json",
        attempts: [
          { attempt: 1, tracePath: "/tmp/output/runs/run/steps/01-attempt-1-trace.json" },
          { attempt: 2, tracePath: "/tmp/output/runs/run/steps/01-attempt-2-trace.json" },
        ],
      },
      raw: {
        data: {
          retry: { attempts: 2, retryDelayTotalMs: 50, wallDurationMs: 350 },
        },
      },
    },
    trace: {
      finalStatus: "ok",
      durationMs: 42,
      normalizedAction: { kind: "click", query: "提交" },
      normalizedTarget: { role: "button", text: "提交" },
      selectedLocatorStrategy: "accessibility:role-name",
      selectedCandidate: { text: "提交", role: "button" },
      executionPath: {
        target: { source: "dom", strategy: "accessibility:role-name" },
        action: "click",
        actionDetail: "locator-click",
        summary: "dom:accessibility:role-name -> click -> perform:locator-click",
      },
      runtimeVariables: {
        timestamp: "20260630-140838",
        caseToken: "自动化测试·复版历史·20260630-140838",
      },
      actionResult: {
        success: true,
        detail: "combo-search-select",
        popupTrace: {
          openedBy: "root-click:nested-keyboard",
          openDurationMs: 84,
          queryInput: { activation: "focus", method: "keyboard", durationMs: 82 },
          expansionProbes: [{ level: 0, durationMs: 180, expanded: false }],
        },
      },
      expectation: {
        ok: true,
        type: "expectNetworkResponse",
        observedCount: 2,
        response: { method: "POST", url: "/api/create", status: 200, body: { data: { status: 8 } } },
      },
      diffResult: { changed: true, ratio: 0.11 },
      tracePath: "/tmp/output/runs/run/steps/01-trace.json",
    },
  });

  assert.equal(detail.type, "click");
  assert.equal(detail.durationMs, 42);
  assert.equal(detail.executionPath.summary, "dom:accessibility:role-name -> click -> perform:locator-click");
  assert.equal(detail.rows.action.some((row) => row.label === "Execution path" && row.value === "dom:accessibility:role-name -> click -> perform:locator-click"), true);
  assert.equal(detail.rows.action.some((row) => row.label === "Locator strategy" && row.value === "accessibility:role-name"), true);
  assert.equal(detail.rows.action.some((row) => row.label === "Target" && row.json === true && row.rawValue?.text === "提交"), true);
  assert.equal(detail.rows.action.some((row) => row.label === "Selected candidate" && row.json === true && row.rawValue?.role === "button"), true);
  assert.equal(detail.rows.popup.some((row) => row.label === "Open duration" && row.value === "84 ms"), true);
  assert.equal(detail.rows.popup.some((row) => row.label === "Query input" && row.rawValue?.activation === "focus"), true);
  assert.equal(detail.rows.popup.some((row) => row.label === "Expansion probes" && row.rawValue?.[0]?.expanded === false), true);
  assert.equal(detail.rows.overview.some((row) => row.label === "Attempts" && row.value === 2), true);
  assert.equal(detail.rows.paths.some((row) => row.label === "Attempt traces" && row.value.includes("01-attempt-1-trace.json")), true);
  assert.equal(detail.rows.expectation.some((row) => row.label === "Observed count" && row.value === 2), true);
  assert.equal(detail.rows.response.some((row) => row.label === "Status" && row.value === 200), true);
  assert.equal(detail.rows.runtimeVariables.some((row) => row.label === "caseToken" && row.value === "自动化测试·复版历史·20260630-140838"), true);
});

test("step execution detail falls back to live diagnostics when trace is missing", () => {
  const detail = createStepExecutionDetail({
    step: { title: "Call detail", type: "callApi" },
    executionState: {
      status: "failed",
      durationMs: 15,
      diagnostics: {
        action: {
          success: true,
          detail: "api-response",
          apiRequest: { method: "GET", url: "/api/detail" },
          apiResponse: { method: "GET", url: "/api/detail", status: 500, bodyPreview: "{\"error\":true}" },
        },
        expectation: {
          ok: false,
          type: "expectResponse",
          failures: [{ field: "status", expected: 200, actual: 500 }],
        },
      },
    },
  });

  assert.equal(detail.status, "failed");
  assert.equal(detail.rows.request.some((row) => row.label === "URL" && row.value === "/api/detail"), true);
  assert.equal(detail.rows.response.some((row) => row.label === "Status" && row.value === 500), true);
  assert.equal(detail.rows.expectation.some((row) => row.label === "Failures" && row.json === true && row.rawValue[0].actual === 500), true);
});

test("step execution detail falls back to execution runtime variables", () => {
  const detail = createStepExecutionDetail({
    step: { title: "Failed step", type: "click" },
    executionState: {
      status: "failed",
      runtimeVariables: {
        runId: "panel-run-1",
        customFlag: true,
      },
    },
  });

  assert.equal(detail.runtimeVariables.runId, "panel-run-1");
  assert.equal(detail.rows.runtimeVariables.some((row) => row.label === "customFlag" && row.value === "true"), true);
});

test("step execution detail keeps callApi request and response bodies for structured viewers", () => {
  const detail = createStepExecutionDetail({
    step: { title: "Check backend state", type: "callApi" },
    trace: {
      input: {
        request: {
          method: "POST",
          url: "/api/list",
          body: { page: 1, status: 13 },
        },
      },
      apiRequest: {
        method: "POST",
        url: "http://localhost:8000/api/list",
        headers: { "content-type": "application/json" },
        hasBody: true,
      },
      apiResponse: {
        method: "POST",
        url: "http://localhost:8000/api/list",
        status: 200,
        body: { success: true, data: { content: [{ status: 13 }] } },
      },
      actionResult: { success: true, detail: "api-response" },
      expectation: {
        ok: true,
        type: "expectResponse",
        response: { status: 200, body: { success: true } },
      },
    },
  });

  assert.deepEqual(detail.action.request.body, { page: 1, status: 13 });
  assert.deepEqual(detail.action.response.body.data.content[0], { status: 13 });
  assert.equal(detail.rows.request.some((row) => row.label === "Body" && row.json === true && row.rawValue.status === 13), true);
  assert.equal(detail.rows.response.some((row) => row.label === "Body preview" && row.json === true && row.rawValue.data.content[0].status === 13), true);
});

test("step execution detail handles legacy result-only data", () => {
  const detail = createStepExecutionDetail({
    step: {
      raw: {
        ok: true,
        type: "assertVisible",
        data: {
          action: { success: true, detail: "assert-visible-resolved" },
          expectation: { ok: true, type: "expectDom", property: "visible", expected: true, actual: true },
          evidence: { tracePath: null },
        },
      },
    },
  });

  assert.equal(detail.status, "passed");
  assert.equal(detail.rows.expectation.some((row) => row.label === "Property" && row.value === "visible"), true);
});
