const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  collectReportPathsFromResult,
  listRunArchive,
  readRunReport,
  rebuildRunArchive,
  summarizeReport,
  updateRunArchiveIndex,
} = require("../../src/main/run-archive");

function report(overrides = {}) {
  return {
    startedAt: 1000,
    finishedAt: 1500,
    mode: "batch",
    testContext: {
      testFileId: "file-a",
      testFilePath: "file-a.json",
      testFileName: "File A",
      caseId: "case-a",
      caseName: "Case A",
    },
    summary: {
      ok: true,
      type: "batch",
      data: { results: [] },
    },
    telemetry: {
      durationMs: 500,
      steps: 2,
      okCount: 2,
      errorCount: 0,
      browserUrl: "https://example.test",
    },
    ...overrides,
  };
}

async function writeReport(root, dirName, value) {
  const runDir = path.join(root, dirName);
  await fs.mkdir(path.join(runDir, "steps"), { recursive: true });
  const reportPath = path.join(runDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(value, null, 2), "utf8");
  return reportPath;
}

test("summarizeReport extracts legacy report metadata and defaults runContext", () => {
  const item = summarizeReport(report(), "/tmp/output/runs/run-1/report.json", "/tmp/output/runs");

  assert.equal(item.status, "passed");
  assert.equal(item.ok, true);
  assert.equal(item.testFilePath, "file-a.json");
  assert.equal(item.caseName, "Case A");
  assert.equal(item.runContext.triggerSurface, "unknown");
  assert.equal(item.relativeReportPath, "run-1/report.json");
});

test("summarizeReport extracts first failed step evidence", () => {
  const item = summarizeReport(
    report({
      summary: {
        ok: false,
        type: "batch",
        data: {
          results: [
            { ok: true, index: 0, input: { id: "setup", type: "click", stepTitle: "Setup" } },
            {
              ok: false,
              index: 1,
              input: { id: "verify", type: "callApi", stepTitle: "Verify API", phase: "case" },
              error: { code: "expectation-not-met", message: "status expected 200 got 404" },
              evidence: {
                tracePath: "/tmp/output/runs/run-2/steps/02-trace.json",
                afterScreenshotPath: "/tmp/output/runs/run-2/steps/02-after.png",
              },
              data: {
                action: {
                  apiRequest: { method: "POST", url: "/api/list" },
                  apiResponse: { status: 404, url: "/api/list" },
                },
              },
            },
          ],
        },
      },
      telemetry: { durationMs: 800, steps: 2, okCount: 1, errorCount: 1 },
    }),
    "/tmp/output/runs/run-2/report.json",
    "/tmp/output/runs",
  );

  assert.equal(item.status, "failed");
  assert.equal(item.firstFailure.message, "status expected 200 got 404");
  assert.equal(item.firstFailure.stepId, "verify");
  assert.equal(item.firstFailure.actionType, "callApi");
  assert.equal(item.firstFailure.response.status, 404);
});

test("summarizeReport handles browser unavailable reports", () => {
  const item = summarizeReport(
    report({
      summary: null,
      error: { code: "browser-unavailable", message: "Failed to launch browser." },
      telemetry: { durationMs: 12, steps: 4, okCount: 0, errorCount: 4 },
    }),
    "/tmp/output/runs/run-3/report.json",
    "/tmp/output/runs",
  );

  assert.equal(item.status, "failed");
  assert.equal(item.firstFailure.message, "Failed to launch browser.");
  assert.equal(item.firstFailure.code, "browser-unavailable");
});

test("run archive rebuilds, filters, paginates, and reads reports safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-run-archive-"));
  const failedPath = await writeReport(root, "20260620-failed", report({
    startedAt: 3000,
    finishedAt: 3500,
    testContext: {
      testFileId: "file-b",
      testFilePath: "file-b.json",
      testFileName: "File B",
      caseId: "case-b",
      caseName: "Case B",
    },
    summary: { ok: false, type: "run", error: { message: "case failed" } },
    telemetry: { durationMs: 500, steps: 1, okCount: 0, errorCount: 1 },
  }));
  await writeReport(root, "20260619-passed", report({ startedAt: 2000, finishedAt: 2500 }));

  const index = await rebuildRunArchive(root);
  assert.equal(index.items.length, 2);

  const failed = await listRunArchive(root, { status: "failed", query: "file b", page: 1, pageSize: 10 });
  assert.equal(failed.success, true);
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0].reportPath, failedPath);
  assert.equal(failed.stats.totalRuns, 2);
  assert.equal(failed.filteredStats.failedRuns, 1);

  const read = await readRunReport(root, failedPath);
  assert.equal(read.success, true);
  assert.equal(read.summary.status, "failed");

  const blocked = await readRunReport(root, path.join(root, "..", "report.json"));
  assert.equal(blocked.success, false);
  assert.equal(blocked.error, "path-not-allowed");
});

test("run archive can filter current test file run-file records only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-run-archive-file-history-"));
  const fileRunPath = await writeReport(root, "20260623-file-run", report({
    startedAt: 6000,
    finishedAt: 6800,
    testContext: {
      testFileId: "file-a",
      testFilePath: "file-a.json",
      testFileName: "File A",
      caseId: null,
      caseName: null,
    },
    runContext: {
      triggerSurface: "run",
      scope: "all",
    },
    telemetry: { durationMs: 800, steps: 4, okCount: 4, errorCount: 0 },
  }));
  await writeReport(root, "20260623-case-run", report({
    startedAt: 5000,
    finishedAt: 5400,
    testContext: {
      testFileId: "file-a",
      testFilePath: "file-a.json",
      testFileName: "File A",
      caseId: "case-a",
      caseName: "Case A",
    },
    runContext: {
      triggerSurface: "build-cases",
      scope: "selected",
    },
    telemetry: { durationMs: 400, steps: 2, okCount: 2, errorCount: 0 },
  }));
  await writeReport(root, "20260623-other-file", report({
    startedAt: 7000,
    finishedAt: 7400,
    testContext: {
      testFileId: "file-b",
      testFilePath: "file-b.json",
      testFileName: "File B",
      caseId: null,
      caseName: null,
    },
    runContext: {
      triggerSurface: "run",
      scope: "all",
    },
    telemetry: { durationMs: 400, steps: 2, okCount: 2, errorCount: 0 },
  }));

  const archive = await listRunArchive(root, {
    testFilePath: "file-a.json",
    scope: "all",
    excludeCaseRuns: true,
    page: 1,
    pageSize: 10,
  });

  assert.equal(archive.success, true);
  assert.equal(archive.total, 1);
  assert.equal(archive.items[0].reportPath, fileRunPath);
  assert.equal(archive.items[0].caseId, null);
  assert.equal(archive.items[0].runContext.scope, "all");
  assert.equal(archive.filteredStats.totalRuns, 1);

  const buildCasesArchive = await listRunArchive(root, {
    testFilePath: "file-a.json",
    triggerSurface: "build-cases",
    page: 1,
    pageSize: 10,
  });

  assert.equal(buildCasesArchive.success, true);
  assert.equal(buildCasesArchive.total, 1);
  assert.equal(buildCasesArchive.items[0].runContext.triggerSurface, "build-cases");
  assert.equal(buildCasesArchive.items[0].caseId, "case-a");
});

test("run archive incrementally updates index from result report paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-run-archive-update-"));
  await rebuildRunArchive(root);
  const reportPath = await writeReport(root, "20260622-new", report({
    startedAt: 5000,
    finishedAt: 5600,
    runContext: {
      triggerSurface: "run",
      scope: "selected",
      phase: "root-setup",
      runtimeVariableKeys: ["timestamp"],
    },
  }));

  await updateRunArchiveIndex(root, [reportPath]);
  const archive = await listRunArchive(root, { page: 1, pageSize: 5 });

  assert.equal(archive.total, 1);
  assert.equal(archive.items[0].runContext.triggerSurface, "run");
  assert.equal(archive.items[0].runContext.phase, "root-setup");
  assert.deepEqual(archive.items[0].runContext.runtimeVariableKeys, ["timestamp"]);
});

test("collectReportPathsFromResult handles single and all-case results", () => {
  const paths = collectReportPathsFromResult({
    evidence: {
      reportPath: "/tmp/a/report.json",
      caseRuns: [{ reportPath: "/tmp/b/report.json" }],
    },
    caseResults: [
      { result: { evidence: { reportPath: "/tmp/c/report.json" } } },
    ],
  });

  assert.deepEqual(paths.sort(), ["/tmp/a/report.json", "/tmp/b/report.json", "/tmp/c/report.json"]);
});
