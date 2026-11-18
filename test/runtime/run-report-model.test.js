const test = require("node:test");
const assert = require("node:assert/strict");

async function loadModel() {
  return import("../../src/panel/lib/run-report-model.mjs");
}

function step(id, type, ok, phase = "case", extras = {}) {
  return {
    ok,
    index: extras.index ?? 0,
    input: {
      id,
      type,
      stepTitle: extras.title || id,
      phase,
    },
    error: ok === false ? { code: extras.code || "assertion-failed", message: extras.message || `${id} failed` } : null,
    data: {
      trace: { durationMs: extras.durationMs || 100 },
      evidence: {
        tracePath: extras.tracePath || null,
        beforeScreenshotPath: extras.beforeScreenshotPath || null,
        afterScreenshotPath: extras.afterScreenshotPath || null,
      },
    },
    evidence: {
      tracePath: extras.tracePath || null,
      beforeScreenshotPath: extras.beforeScreenshotPath || null,
      afterScreenshotPath: extras.afterScreenshotPath || null,
    },
  };
}

test("createRunReportModel aggregates file-level case results", async () => {
  const { createRunReportModel } = await loadModel();

  const model = createRunReportModel({
    testFile: {
      id: "file-a",
      name: "File A",
      path: "file-a.json",
      cases: [
        { id: "case-a", name: "Case A", priority: "P0", steps: [{ id: "a-1", type: "click" }] },
        { id: "case-b", name: "Case B", priority: "P1", steps: [{ id: "b-1", type: "assertDom" }] },
      ],
    },
    result: {
      ok: false,
      type: "test-file",
      caseResults: [
        {
          caseId: "case-a",
          caseName: "Case A",
          priority: "P0",
          result: {
            ok: true,
            telemetry: { durationMs: 300, steps: 1, okCount: 1, errorCount: 0 },
            data: { results: [step("a-1", "click", true, "case", { durationMs: 300 })] },
          },
        },
        {
          caseId: "case-b",
          caseName: "Case B",
          priority: "P1",
          result: {
            ok: false,
            telemetry: { durationMs: 420, steps: 1, okCount: 0, errorCount: 1 },
            data: {
              results: [
                step("b-1", "assertDom", false, "case", {
                  title: "Verify dashboard",
                  message: "Dashboard text missing",
                  tracePath: "/tmp/run/steps/01-trace.json",
                }),
              ],
            },
          },
        },
      ],
      telemetry: { durationMs: 720, steps: 2, okCount: 1, errorCount: 1, browserUrl: "https://example.test" },
    },
  });

  assert.equal(model.status, "failed");
  assert.equal(model.summary.caseCounts.total, 2);
  assert.equal(model.summary.caseCounts.passed, 1);
  assert.equal(model.summary.caseCounts.failed, 1);
  assert.equal(model.summary.passRate, 50);
  assert.equal(model.failures[0].stepTitle, "Verify dashboard");
  assert.equal(model.evidence.some((item) => item.value === "/tmp/run/steps/01-trace.json"), true);
  assert.deepEqual(model.charts.stepStatus[0], { name: "Steps", total: 2, passed: 1, failed: 1, skipped: 0, pending: 0 });
  assert.deepEqual(model.charts.caseStepStatus, [
    { caseId: "case-a", name: "Case 1", caseName: "Case A", status: "passed", total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
    { caseId: "case-b", name: "Case 2", caseName: "Case B", status: "failed", total: 1, passed: 0, failed: 1, skipped: 0, pending: 0 },
  ]);
  assert.equal(model.charts.caseDurations[0].name, "Case 2");
  assert.equal(model.charts.caseDurations[0].caseName, "Case B");
  assert.equal(model.charts.slowestSteps[0].caseLabel, "Case 1");
  assert.equal(model.charts.slowestSteps[0].name, "a-1");
  assert.equal(model.charts.slowestSteps[0].durationMs, 300);
});

test("createRunReportModel derives pending steps from total minus resolved statuses", async () => {
  const { createRunReportModel } = await loadModel();

  const model = createRunReportModel({
    result: {
      ok: false,
      type: "batch",
      telemetry: { steps: 5, okCount: 2, errorCount: 1 },
      data: { results: [] },
    },
  });

  assert.deepEqual(model.summary.stepCounts, { total: 5, passed: 2, failed: 1, skipped: 0, pending: 2 });
  assert.deepEqual(model.charts.stepStatus[0], { name: "Steps", total: 5, passed: 2, failed: 1, skipped: 0, pending: 2 });
});

test("createRunReportModel keeps source executable step totals when a run stops early", async () => {
  const { createRunReportModel } = await loadModel();

  const model = createRunReportModel({
    testFile: {
      id: "file-partial",
      name: "Partial File",
      path: "partial.json",
      cases: [
        {
          id: "case-partial",
          name: "Partial Case",
          fixtures: ["auth"],
          steps: [
            { id: "step-1", type: "click" },
            { id: "step-2", type: "fill" },
            { id: "step-3", type: "press" },
            { id: "step-4", type: "assertDom" },
            { id: "step-5", type: "assertDom" },
          ],
        },
      ],
      fixtures: {
        auth: {
          setup: [{ id: "fixture-setup", type: "callApi" }],
          teardown: [{ id: "fixture-teardown", type: "callApi" }],
        },
      },
    },
    result: {
      ok: false,
      type: "test-file",
      caseResults: [
        {
          caseId: "case-partial",
          caseName: "Partial Case",
          result: {
            ok: false,
            telemetry: { steps: 3, okCount: 2, errorCount: 1 },
            data: {
              results: [
                step("step-1", "click", true),
                step("step-2", "fill", true),
                step("step-3", "press", false),
              ],
            },
          },
        },
      ],
    },
  });

  assert.equal(model.cases[0].totalSteps, 7);
  assert.deepEqual(model.summary.stepCounts, { total: 7, passed: 2, failed: 1, skipped: 0, pending: 4 });
  assert.deepEqual(model.charts.stepStatus[0], { name: "Steps", total: 7, passed: 2, failed: 1, skipped: 0, pending: 4 });
  assert.deepEqual(model.charts.caseStepStatus[0], {
    caseId: "case-partial",
    name: "Case 1",
    caseName: "Partial Case",
    status: "failed",
    total: 7,
    passed: 2,
    failed: 1,
    skipped: 0,
    pending: 4,
  });
  assert.equal(model.charts.slowestSteps[0].caseLabel, "Case 1");
  assert.equal(model.charts.slowestSteps[0].durationMs, 100);
  assert.deepEqual(model.charts.actionTypes.map((item) => item.name), ["assertDom", "callApi", "click", "fill", "press"]);
});

test("createRunReportModel marks unrun cases skipped after root setup failure", async () => {
  const { createRunReportModel } = await loadModel();

  const model = createRunReportModel({
    testFile: {
      id: "file-root",
      name: "Root setup file",
      cases: [
        { id: "case-a", name: "Case A", steps: [{ id: "a-1", type: "click" }] },
        { id: "case-b", name: "Case B", steps: [{ id: "b-1", type: "fill" }] },
      ],
    },
    result: {
      ok: false,
      type: "test-file",
      error: { code: "root-setup-failed", message: "root-setup-failed" },
      caseResults: [],
      telemetry: { durationMs: 100, steps: 1, okCount: 0, errorCount: 1 },
    },
  });

  assert.equal(model.status, "failed");
  assert.equal(model.summary.caseCounts.skipped, 2);
  assert.equal(model.cases.every((caseItem) => caseItem.status === "skipped"), true);
});

test("createRunReportModel reads a persisted single-case runtime report", async () => {
  const { createRunReportModel } = await loadModel();

  const model = createRunReportModel({
    report: {
      startedAt: 1000,
      finishedAt: 1800,
      testContext: {
        testFileId: "file-history",
        testFilePath: "file-history.json",
        testFileName: "History File",
        caseId: "case-history",
        caseName: "History Case",
      },
      summary: {
        ok: true,
        type: "batch",
        data: { results: [step("history-1", "callApi", true, "case", { durationMs: 800 })] },
      },
      telemetry: { durationMs: 800, steps: 1, okCount: 1, errorCount: 0, browserUrl: "https://history.test" },
    },
    summary: {
      reportPath: "/tmp/output/runs/history/report.json",
      runDir: "/tmp/output/runs/history",
      status: "passed",
    },
  });

  assert.equal(model.status, "passed");
  assert.equal(model.context.testFileName, "History File");
  assert.equal(model.cases[0].caseName, "History Case");
  assert.equal(model.summary.durationMs, 800);
  assert.equal(model.evidence.some((item) => item.kind === "report"), true);
});

test("createRunReportModel preserves queue row skipped and stopped states", async () => {
  const { createRunReportModel } = await loadModel();

  const model = createRunReportModel({
    queueRows: [
      {
        caseId: "__root_steps__",
        caseName: "Root Steps",
        isRoot: true,
        status: "passed",
        steps: [{ stepId: "setup", title: "Login", type: "click", phase: "setup", status: "passed" }],
      },
      {
        caseId: "case-a",
        caseName: "Case A",
        status: "stopped",
        steps: [{ stepId: "a-1", title: "Create", type: "click", phase: "case", status: "stopped" }],
      },
      {
        caseId: "case-b",
        caseName: "Case B",
        status: "skipped",
        steps: [{ stepId: "b-1", title: "Verify", type: "assertDom", phase: "case", status: "skipped" }],
      },
    ],
    runProgress: { status: "stopped" },
  });

  assert.equal(model.status, "stopped");
  assert.equal(model.summary.caseCounts.skipped, 1);
  assert.equal(model.cases.find((item) => item.caseId === "case-a").status, "stopped");
  assert.equal(model.charts.phaseDistribution.some((item) => item.name === "setup"), true);
});
