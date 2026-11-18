const path = require("node:path");

const RUN_FEEDBACK_SCHEMA_VERSION = 1;

function toNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeString(value, fallback = "") {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value.message || value.code || value.error || fallback;
}

function compactJson(value, maxLength = 240) {
  if (value == null) {
    return null;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeStatus(report = {}) {
  if (report.summary?.ok === true) {
    return "passed";
  }
  if (report.summary?.ok === false || report.error) {
    return "failed";
  }
  if (report.telemetry?.errorCount != null) {
    return Number(report.telemetry.errorCount) > 0 ? "failed" : "passed";
  }
  return "unknown";
}

function getResultSteps(report = {}) {
  if (Array.isArray(report.summary?.data?.results)) {
    return report.summary.data.results;
  }
  if (report.summary && (report.summary.input || report.summary.error || report.summary.evidence)) {
    return [report.summary];
  }
  return [];
}

function getStepInput(step = {}) {
  return step.input || step.raw?.input || step.data?.normalizedAction || step.raw?.data?.normalizedAction || step;
}

function getStepTitle(step = {}, fallbackIndex = 0) {
  const input = getStepInput(step);
  return (
    input.stepTitle ||
    input.title ||
    input.name ||
    input.id ||
    step.stepTitle ||
    step.title ||
    step.id ||
    `Step ${fallbackIndex + 1}`
  );
}

function getStepType(step = {}) {
  const input = getStepInput(step);
  return input.type || input.kind || step.type || step.kind || "";
}

function getStepId(step = {}, fallbackIndex = 0) {
  const input = getStepInput(step);
  return input.id || input.stepId || step.id || `step-${fallbackIndex + 1}`;
}

function getStepPhase(step = {}) {
  const input = getStepInput(step);
  return input.phase || step.phase || "case";
}

function getStepError(step = {}) {
  return (
    step.error ||
    step.data?.action?.error ||
    step.data?.expectation?.error ||
    step.data?.expectation?.failures?.find?.((item) => item) ||
    null
  );
}

function getStepErrorCode(step = {}) {
  const error = getStepError(step);
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  const code = error.code || error.error || null;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function getExpectation(step = {}) {
  return step.data?.expectation || step.raw?.data?.expectation || null;
}

function getExpectationSummary(step = {}) {
  const expectation = getExpectation(step);
  const inputExpectation = getStepInput(step).expectation;
  if (!expectation && !inputExpectation) {
    return null;
  }
  const source = expectation || inputExpectation;
  const summary = {
    type: source.type || source.kind || inputExpectation?.kind || null,
    ok: expectation?.ok ?? null,
  };
  if (source.urlIncludes) {
    summary.urlIncludes = source.urlIncludes;
  }
  if (source.status != null) {
    summary.status = source.status;
  }
  if (source.property) {
    summary.property = source.property;
  }
  if (source.operator) {
    summary.operator = source.operator;
  }
  if (source.expected != null) {
    summary.expected = compactJson(source.expected);
  }
  if (source.actual != null) {
    summary.actual = compactJson(source.actual);
  }
  if (Array.isArray(source.missing) && source.missing.length) {
    summary.missing = source.missing.slice(0, 8);
  }
  if (Array.isArray(source.present) && source.present.length) {
    summary.present = source.present.slice(0, 8);
  }
  if (Array.isArray(source.failures) && source.failures.length) {
    summary.failures = source.failures.slice(0, 5);
  }
  if (source.response) {
    summary.response = {
      url: source.response.url || null,
      method: source.response.method || null,
      status: source.response.status ?? null,
      bodyPreview: compactJson(source.response.body, 400),
    };
  }
  if (Array.isArray(source.results)) {
    summary.results = source.results.map((item) => ({
      type: item?.type || item?.kind || null,
      ok: item?.ok ?? null,
      error: item?.error || null,
      missing: Array.isArray(item?.missing) ? item.missing.slice(0, 8) : undefined,
      failures: Array.isArray(item?.failures) ? item.failures.slice(0, 5) : undefined,
    }));
  }
  return summary;
}

function getTracePath(step = {}) {
  return step.evidence?.tracePath || step.data?.evidence?.tracePath || step.raw?.data?.evidence?.tracePath || null;
}

function getScreenshotPath(step = {}, key) {
  return step.evidence?.[key] || step.data?.evidence?.[key] || step.raw?.data?.evidence?.[key] || null;
}

function getStepStatus(step = {}) {
  if (step.stopped) {
    return "stopped";
  }
  if (step.skipped) {
    return "skipped";
  }
  if (step.ok === true) {
    return "passed";
  }
  if (step.ok === false || getStepError(step)) {
    return "failed";
  }
  return "unknown";
}

// v1.11: a step the engine elided on purpose (v1.10 Z29-4) is not a skipped
// step in the sense consumers read `stepCounts.skipped` — "something the case
// asked for did not run". office-lab's reconcile requires skipped === 0 for a
// clean green, so counting the elided fresh-context reload as skipped made every
// headless fxHome case ineligible for COVERED_GREEN. It is counted on its own.
function isElidedStep(step = {}) {
  if (!step.skipped) {
    return false;
  }
  const detail = step.data?.action?.detail || step.raw?.data?.action?.detail || "";
  return String(detail).startsWith("elided-");
}

function getStepMessage(step = {}) {
  const error = getStepError(step);
  if (error) {
    return safeString(error, "Step failed.");
  }
  const expectation = getExpectation(step);
  if (expectation && expectation.ok === false) {
    return safeString(expectation.error, "Expectation failed.");
  }
  if (step.stopped) {
    return "Step stopped after a previous failure.";
  }
  if (step.skipped) {
    // v1.10 Z29-4: an elided step was skipped on purpose because it could not
    // change the outcome; say which rule elided it rather than a bare "skipped".
    const detail = step.data?.action?.detail || step.raw?.data?.action?.detail || "";
    if (String(detail).startsWith("elided-")) {
      return `Step elided (${detail}): redundant in a fresh browser context, not executed.`;
    }
    return "Step skipped.";
  }
  return "";
}

function createStepSummary(step = {}, displayIndex = 0) {
  const input = getStepInput(step);
  return {
    index: step.index ?? input.index ?? displayIndex,
    displayIndex,
    stepId: getStepId(step, displayIndex),
    title: getStepTitle(step, displayIndex),
    actionType: getStepType(step),
    phase: getStepPhase(step),
    sourceFixture: input.sourceFixture || step.sourceFixture || null,
    sourceMacro: input.sourceMacro || step.sourceMacro || null,
    status: getStepStatus(step),
    ...(isElidedStep(step) ? { elided: true } : {}),
    durationMs: toNumber(step.telemetry?.durationMs ?? step.data?.trace?.durationMs),
    retry: step.data?.retry || null,
    // v1.5: the machine-readable failure code (`page-error`, `step-hard-timeout`,
    // `browser-oom`, `target-not-found`, …). Consumers previously had to regex
    // the human `message` — which is exactly the fragile coupling Z-D removes.
    code: getStepErrorCode(step),
    message: getStepMessage(step),
    expectation: getExpectationSummary(step),
    tracePath: getTracePath(step),
    beforeScreenshotPath: getScreenshotPath(step, "beforeScreenshotPath"),
    afterScreenshotPath: getScreenshotPath(step, "afterScreenshotPath"),
  };
}

function createTopLevelFailure(report = {}) {
  const error = report.summary?.error || report.error || null;
  if (!error) {
    return null;
  }
  return {
    index: null,
    displayIndex: null,
    stepId: null,
    title: "Run failed before a step completed",
    actionType: report.summary?.type || report.mode || "run",
    phase: report.runContext?.phase || null,
    sourceFixture: null,
    sourceMacro: null,
    status: "failed",
    durationMs: toNumber(report.telemetry?.durationMs),
    code: typeof error === "string" ? error : error.code || null,
    message: safeString(error, "Run failed."),
    expectation: null,
    tracePath: null,
    beforeScreenshotPath: null,
    afterScreenshotPath: null,
  };
}

function createRunSummary(report = {}, reportPath = null) {
  const steps = getResultSteps(report).map((step, index) => createStepSummary(step, index));
  const failedSteps = steps.filter((step) => step.status === "failed");
  if (!failedSteps.length) {
    const topLevelFailure = createTopLevelFailure(report);
    if (topLevelFailure) {
      failedSteps.push(topLevelFailure);
    }
  }
  const stoppedSteps = steps.filter((step) => step.status === "stopped");
  const skippedSteps = steps.filter((step) => step.status === "skipped" && !step.elided);
  const elidedSteps = steps.filter((step) => step.elided);
  const passedSteps = steps.filter((step) => step.status === "passed");
  const status = normalizeStatus(report);
  const runDir = reportPath ? path.dirname(reportPath) : report.evidence?.runDir || null;
  return {
    schemaVersion: RUN_FEEDBACK_SCHEMA_VERSION,
    generatedAt: Date.now(),
    status,
    ok: status === "passed" ? true : status === "failed" ? false : null,
    mode: report.mode || "",
    startedAt: toNumber(report.startedAt),
    finishedAt: toNumber(report.finishedAt),
    durationMs: toNumber(report.telemetry?.durationMs),
    evidenceProfile: report.evidenceProfile || null,
    testContext: report.testContext || null,
    runContext: report.runContext || null,
    stepCounts: {
      total: toNumber(report.telemetry?.steps, steps.length),
      executed: steps.length,
      passed: toNumber(report.telemetry?.okCount, passedSteps.length),
      failed: toNumber(report.telemetry?.errorCount, failedSteps.length),
      skipped: skippedSteps.length,
      elided: elidedSteps.length,
      stopped: stoppedSteps.length,
    },
    runtimeVariables: report.runtimeVariables || {},
    runtimeVariableSources: report.runtimeVariableSources || {},
    firstFailure: failedSteps[0] || null,
    failedSteps,
    steps,
    // v1.5 Z-A: always present when the page-error collector ran (A-2: the
    // entries are recorded even with the gate off). `null` marks a run from
    // before the gate existed — a consumer must be able to tell those apart.
    pageErrors: report.telemetry?.pageErrors ?? null,
    // v1.11 REQ-Z31: request faults this run installed and how often each fired.
    ...(report.telemetry?.routeFaults ? { routeFaults: report.telemetry.routeFaults } : {}),
    // v1.5 Z-B / Z-C: environment fingerprint + captured download artifacts.
    environmentFingerprint: report.telemetry?.environmentFingerprint ?? null,
    downloads: report.telemetry?.downloads ?? null,
    // v1.6 Z-G: long-task / DOM-size timeline + per-metric jitter band.
    performance: report.telemetry?.performance ?? null,
    // v1.6 Z-E / Z-I: appearance review material and the created-data ledger.
    visualReview: report.telemetry?.visualReview ?? null,
    dataResidue: report.telemetry?.dataResidue ?? null,
    // v1.9 REQ-Z22: did login/recovery happen, and did it work. Always an object
    // when the engine ran (never omitted), because an absent field is what made
    // "登录建立了吗" a screenshot-reading exercise for a whole night.
    authTrace: report.telemetry?.authTrace ?? null,
    artifacts: {
      runDir,
      reportPath,
      summaryPath: runDir ? path.join(runDir, "summary.json") : null,
      markdownReportPath: runDir ? path.join(runDir, "report.md") : null,
      stepsDir: runDir ? path.join(runDir, "steps") : null,
    },
  };
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function formatDuration(value) {
  const ms = toNumber(value, 0);
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatExpectationForMarkdown(expectation) {
  if (!expectation) {
    return "";
  }
  const parts = [expectation.type].filter(Boolean);
  if (expectation.urlIncludes) {
    parts.push(expectation.urlIncludes);
  }
  if (expectation.status != null) {
    parts.push(`status ${expectation.status}`);
  }
  if (expectation.property) {
    parts.push(expectation.property);
  }
  if (expectation.missing?.length) {
    parts.push(`missing: ${expectation.missing.join(", ")}`);
  }
  if (expectation.response?.status != null) {
    parts.push(`response ${expectation.response.status}`);
  }
  return parts.join(" / ");
}

function createRunMarkdownReport(summary = {}) {
  const context = summary.testContext || {};
  const firstFailure = summary.firstFailure;
  const lines = [
    "# Run Feedback",
    "",
    `- Status: ${summary.status}`,
    `- Test file: ${context.testFilePath || "-"}`,
    `- Case: ${context.caseId || "-"}${context.caseName ? ` (${context.caseName})` : ""}`,
    `- Started: ${formatDate(summary.startedAt)}`,
    `- Finished: ${formatDate(summary.finishedAt)}`,
    `- Duration: ${formatDuration(summary.durationMs)}`,
    `- Steps: ${summary.stepCounts?.passed || 0}/${summary.stepCounts?.total || 0} passed, ${summary.stepCounts?.failed || 0} failed`,
    "",
    "## First Failure",
    "",
  ];
  if (firstFailure) {
    const failureLabel = firstFailure.stepId
      ? `#${(firstFailure.displayIndex ?? 0) + 1} ${firstFailure.stepId} - ${firstFailure.title}`
      : firstFailure.title;
    lines.push(
      `- Step: ${failureLabel}`,
      `- Type: ${firstFailure.actionType || "-"}`,
      `- Phase: ${firstFailure.phase || "-"}`,
      `- Message: ${firstFailure.message || "-"}`,
      `- Trace: ${firstFailure.tracePath || "-"}`,
      "",
    );
  } else {
    lines.push("- None", "");
  }
  lines.push("## Runtime Variables", "");
  const variableEntries = Object.entries(summary.runtimeVariables || {});
  if (variableEntries.length) {
    variableEntries.forEach(([key, value]) => {
      lines.push(`- ${key}: ${compactJson(value, 160)}`);
    });
  } else {
    lines.push("- None");
  }
  lines.push("", "## Step Timeline", "", "| # | Status | Step | Type | Duration | Expectation | Trace |", "| --- | --- | --- | --- | --- | --- | --- |");
  (summary.steps || []).forEach((step) => {
    lines.push([
      step.displayIndex + 1,
      step.status,
      `${step.stepId} - ${String(step.title || "").replace(/\|/g, "\\|")}`,
      step.actionType || "-",
      formatDuration(step.durationMs),
      String(formatExpectationForMarkdown(step.expectation) || "-").replace(/\|/g, "\\|"),
      step.tracePath || "-",
    ].join(" | "));
  });
  lines.push("", "## Artifacts", "", `- summary.json: ${summary.artifacts?.summaryPath || "-"}`, `- raw report.json: ${summary.artifacts?.reportPath || "-"}`, `- steps: ${summary.artifacts?.stepsDir || "-"}`, "");
  return `${lines.join("\n")}\n`;
}

module.exports = {
  RUN_FEEDBACK_SCHEMA_VERSION,
  createRunMarkdownReport,
  createRunSummary,
};
