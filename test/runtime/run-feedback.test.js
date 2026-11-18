const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRunMarkdownReport, createRunSummary } = require("../../runtime/reporting/run-feedback");

test("createRunSummary creates compact feedback for AI triage", () => {
  const reportPath = "/tmp/output/runs/run-1/report.json";
  const summary = createRunSummary({
    startedAt: 1000,
    finishedAt: 2500,
    mode: "batch",
    evidenceProfile: "fast",
    testContext: {
      testFilePath: "file-a.json",
      caseId: "case-a",
      caseName: "Case A",
    },
    runContext: {
      triggerSurface: "external-app-run",
      scope: "selected",
    },
    runtimeVariables: {
      taskSpuNo: "DEMO2026A00001",
    },
    runtimeVariableSources: {
      taskSpuNo: "capture",
    },
    telemetry: {
      durationMs: 1500,
      steps: 2,
      okCount: 1,
      errorCount: 1,
    },
    summary: {
      ok: false,
      type: "batch",
      data: {
        results: [
          {
            ok: true,
            index: 0,
            type: "click",
            input: { id: "open", type: "click", stepTitle: "Open modal", phase: "case" },
            telemetry: { durationMs: 120 },
            evidence: { tracePath: "/tmp/output/runs/run-1/steps/01-trace.json" },
          },
          {
            ok: false,
            index: 1,
            type: "click",
            input: {
              id: "submit",
              type: "click",
              stepTitle: "Submit form",
              phase: "case",
              expectation: { kind: "networkResponse", urlIncludes: "/submit", status: 200 },
            },
            error: { code: "expectation-not-met", message: "status expected 200 got 500" },
            telemetry: { durationMs: 600 },
            data: {
              expectation: {
                ok: false,
                type: "expectNetworkResponse",
                failures: [{ field: "status", expected: 200, actual: 500 }],
                response: { url: "http://localhost/submit", method: "POST", status: 500, body: { success: false } },
              },
            },
            evidence: { tracePath: "/tmp/output/runs/run-1/steps/02-trace.json" },
          },
        ],
      },
    },
  }, reportPath);

  assert.equal(summary.status, "failed");
  assert.equal(summary.stepCounts.total, 2);
  assert.equal(summary.failedSteps.length, 1);
  assert.equal(summary.firstFailure.stepId, "submit");
  assert.equal(summary.firstFailure.message, "status expected 200 got 500");
  assert.equal(summary.firstFailure.expectation.response.status, 500);
  assert.equal(summary.steps[0].tracePath, "/tmp/output/runs/run-1/steps/01-trace.json");
  assert.equal(summary.artifacts.summaryPath, path.join(path.dirname(reportPath), "summary.json"));
  assert.equal(summary.artifacts.markdownReportPath, path.join(path.dirname(reportPath), "report.md"));
});

test("createRunMarkdownReport writes a readable run feedback entry", () => {
  const summary = createRunSummary({
    startedAt: 1000,
    finishedAt: 2500,
    testContext: { testFilePath: "file-a.json", caseId: "case-a", caseName: "Case A" },
    telemetry: { durationMs: 1500, steps: 1, okCount: 1, errorCount: 0 },
    runtimeVariables: { taskSpuNo: "DEMO2026A00001" },
    summary: {
      ok: true,
      type: "batch",
      data: {
        results: [{
          ok: true,
          index: 0,
          input: { id: "submit", type: "click", stepTitle: "Submit form" },
          evidence: { tracePath: "/tmp/output/runs/run-2/steps/01-trace.json" },
        }],
      },
    },
  }, "/tmp/output/runs/run-2/report.json");
  const markdown = createRunMarkdownReport(summary);

  assert.match(markdown, /Status: passed/);
  assert.match(markdown, /First Failure/);
  assert.match(markdown, /None/);
  assert.match(markdown, /taskSpuNo: DEMO2026A00001/);
  assert.match(markdown, /raw report\.json: \/tmp\/output\/runs\/run-2\/report\.json/);
  assert.match(markdown, /01-trace\.json/);
});

test("createRunSummary promotes run-level errors to firstFailure", () => {
  const summary = createRunSummary({
    startedAt: 1000,
    finishedAt: 1012,
    mode: "batch",
    telemetry: { durationMs: 12, steps: 4, okCount: 0, errorCount: 4 },
    summary: null,
    error: { code: "browser-unavailable", message: "Failed to launch browser." },
  }, "/tmp/output/runs/run-3/report.json");

  assert.equal(summary.status, "failed");
  assert.equal(summary.firstFailure.stepId, null);
  assert.equal(summary.firstFailure.message, "Failed to launch browser.");
  assert.equal(summary.failedSteps.length, 1);
});
