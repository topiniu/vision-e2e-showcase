import { buildExecutableCaseSteps } from "../../shared/test-file.mjs";

const COMPLETE_STATUSES = new Set(["passed", "success", "failed", "stopped", "skipped"]);
const PASS_STATUSES = new Set(["passed", "success"]);
const FAILURE_PHASE_PATTERN = /(setup|teardown|fixture)/i;

function toNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeText(value, fallback = "") {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return value.message || value.code || value.error || fallback;
  }
  return fallback;
}

function normalizeStatus(value, fallback = "pending") {
  if (value === "success") {
    return "passed";
  }
  if (value === "running" || value === "stopping" || value === "stopped" || value === "failed" || value === "skipped" || value === "passed") {
    return value;
  }
  return fallback;
}

function getErrorMessage(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  const detail = error.details || {};
  return (
    error.message ||
    error.code ||
    error.error ||
    detail.message ||
    detail.code ||
    ""
  );
}

function getStepError(step = {}) {
  return (
    step.error ||
    step.raw?.error ||
    step.data?.action?.error ||
    step.raw?.data?.action?.error ||
    step.data?.expectation?.error ||
    step.raw?.data?.expectation?.error ||
    step.result?.error ||
    null
  );
}

function getStepInput(step = {}) {
  return step.input || step.raw?.input || step.data?.normalizedAction || step.raw?.data?.normalizedAction || step.raw || step;
}

function getStepTitle(step = {}, index = 0) {
  const input = getStepInput(step);
  return (
    step.title ||
    step.stepTitle ||
    input.stepTitle ||
    input.title ||
    input.name ||
    input.query ||
    input.target?.name ||
    input.target?.text ||
    input.target?.placeholder ||
    input.macro ||
    input.request?.url ||
    input.type ||
    step.type ||
    `Step ${index + 1}`
  );
}

function getStepType(step = {}) {
  const input = getStepInput(step);
  return input.type || input.kind || step.type || step.kind || "runtime step";
}

function getStepPhase(step = {}) {
  const input = getStepInput(step);
  return input.phase || step.phase || step.raw?.input?.phase || step.data?.normalizedAction?.phase || "case";
}

function getTracePath(step = {}) {
  return (
    step.evidence?.tracePath ||
    step.raw?.evidence?.tracePath ||
    step.data?.evidence?.tracePath ||
    step.raw?.data?.evidence?.tracePath ||
    step.tracePath ||
    null
  );
}

function getScreenshotPath(step = {}, key) {
  return (
    step.evidence?.[key] ||
    step.raw?.evidence?.[key] ||
    step.data?.evidence?.[key] ||
    step.raw?.data?.evidence?.[key] ||
    step[key] ||
    null
  );
}

function getResultSteps(result = {}) {
  if (Array.isArray(result?.data?.results)) {
    return result.data.results;
  }
  if (Array.isArray(result?.summary?.data?.results)) {
    return result.summary.data.results;
  }
  if (Array.isArray(result?.evidence?.steps)) {
    return result.evidence.steps;
  }
  if (Array.isArray(result?.steps)) {
    return result.steps;
  }
  return [];
}

function deriveStepStatus(step = {}) {
  if (step.status) {
    return normalizeStatus(step.status);
  }
  if (step.ok === true || step.result?.ok === true) {
    return "passed";
  }
  if (step.ok === false || step.result?.ok === false || getStepError(step)) {
    return "failed";
  }
  return "pending";
}

function normalizeStep(step = {}, index = 0) {
  const input = getStepInput(step);
  const error = getStepError(step);
  return {
    stepId: step.stepId || step.id || input.id || `step-${index + 1}`,
    index: step.executionIndex ?? step.index ?? index,
    displayIndex: index,
    title: getStepTitle(step, index),
    type: getStepType(step),
    phase: getStepPhase(step),
    status: deriveStepStatus(step),
    durationMs: toNumber(step.durationMs ?? step.data?.trace?.durationMs ?? step.raw?.data?.trace?.durationMs ?? step.data?.action?.durationMs),
    error,
    message: getErrorMessage(error),
    tracePath: getTracePath(step),
    beforeScreenshotPath: getScreenshotPath(step, "beforeScreenshotPath"),
    afterScreenshotPath: getScreenshotPath(step, "afterScreenshotPath"),
    raw: step,
  };
}

function getSourceCase(testFile, caseResult = {}) {
  const cases = testFile?.cases || [];
  const result = caseResult.result || caseResult.summary || caseResult;
  const caseId = caseResult.caseId || result?.testContext?.caseId;
  const caseName = caseResult.caseName || result?.testContext?.caseName;
  return cases.find((item) => item.id && item.id === caseId)
    || cases.find((item) => item.name && item.name === caseName)
    || null;
}

function getSourceCaseSteps(testFile, sourceCase) {
  if (!testFile || !sourceCase) {
    return [];
  }
  try {
    return buildExecutableCaseSteps(testFile, sourceCase.id, {
      includeRootSetup: false,
      includeRootTeardown: false,
    });
  } catch {
    return sourceCase.steps || [];
  }
}

function getStepIdentity(step = {}, fallbackIndex = 0) {
  const input = getStepInput(step);
  return step.stepId || step.id || input.id || input.stepId || `step-${fallbackIndex + 1}`;
}

function mergeSourceAndResultSteps(sourceSteps = [], resultSteps = []) {
  if (!sourceSteps.length) {
    return resultSteps.map((step, index) => normalizeStep(step, index));
  }
  const normalizedResults = resultSteps.map((step, index) => normalizeStep(step, index));
  const resultById = new Map();
  normalizedResults.forEach((step) => {
    if (step.stepId) {
      resultById.set(step.stepId, step);
    }
  });
  const hasResultIds = resultById.size > 0;
  return sourceSteps.map((sourceStep, index) => {
    const sourceIdentity = getStepIdentity(sourceStep, index);
    const resultStep = resultById.get(sourceIdentity) || (hasResultIds ? null : normalizedResults[index]) || null;
    const normalizedSource = normalizeStep(sourceStep, index);
    if (!resultStep) {
      return normalizedSource;
    }
    return {
      ...normalizedSource,
      ...resultStep,
      stepId: normalizedSource.stepId || resultStep.stepId,
      index: normalizedSource.index ?? index,
      displayIndex: index,
      title: resultStep.title || normalizedSource.title,
      type: resultStep.type || normalizedSource.type,
      phase: resultStep.phase || normalizedSource.phase,
      raw: resultStep.raw,
    };
  });
}

function deriveCaseStatus(caseItem = {}, result = {}, steps = []) {
  if (caseItem.status) {
    return normalizeStatus(caseItem.status);
  }
  if (steps.some((step) => step.status === "failed") || result?.ok === false || result?.error) {
    return "failed";
  }
  if (steps.length && steps.every((step) => step.status === "skipped")) {
    return "skipped";
  }
  if (steps.length && steps.some((step) => PASS_STATUSES.has(step.status)) && steps.every((step) => PASS_STATUSES.has(step.status) || step.status === "skipped")) {
    return "passed";
  }
  if (!steps.length && result?.ok === true) {
    return "passed";
  }
  return "pending";
}

function normalizeCaseFromQueue(row = {}, index = 0) {
  const steps = (row.steps || []).map((step, stepIndex) => normalizeStep(step, stepIndex));
  const status = deriveCaseStatus(row, row.result, steps);
  return {
    caseId: row.caseId || `case-${index + 1}`,
    caseName: row.caseName || `Case ${index + 1}`,
    priority: row.priority || (row.isRoot ? "ROOT" : "P1"),
    index,
    status,
    isRoot: Boolean(row.isRoot),
    completedSteps: steps.filter((step) => COMPLETE_STATUSES.has(step.status)).length,
    failedSteps: steps.filter((step) => step.status === "failed").length,
    totalSteps: steps.length,
    durationMs: toNumber(row.durationMs),
    error: row.error || steps.find((step) => step.error)?.error || null,
    runDir: row.runDir || row.result?.evidence?.runDir || null,
    reportPath: row.reportPath || row.result?.evidence?.reportPath || null,
    browserUrl: row.browserUrl || row.result?.telemetry?.browserUrl || null,
    steps,
    result: row.result || null,
  };
}

function normalizeCaseFromResult(caseResult = {}, index = 0, sourceSteps = []) {
  const result = caseResult.result || caseResult.summary || caseResult;
  const resultSteps = getResultSteps(result);
  const steps = mergeSourceAndResultSteps(sourceSteps, resultSteps);
  const status = deriveCaseStatus(caseResult, result, steps);
  const isRoot = Boolean(caseResult.isRoot)
    || caseResult.priority === "ROOT"
    || /^root(?:-|$)/i.test(String(caseResult.caseId || result?.testContext?.caseId || ""));
  return {
    caseId: caseResult.caseId || result?.testContext?.caseId || `case-${index + 1}`,
    caseName: caseResult.caseName || result?.testContext?.caseName || `Case ${index + 1}`,
    priority: caseResult.priority || "P1",
    index,
    status,
    isRoot,
    completedSteps: steps.filter((step) => COMPLETE_STATUSES.has(step.status)).length,
    failedSteps: steps.filter((step) => step.status === "failed").length,
    totalSteps: steps.length || toNumber(result?.telemetry?.steps, 0),
    durationMs: toNumber(result?.telemetry?.durationMs),
    error: result?.error || steps.find((step) => step.error)?.error || null,
    runDir: result?.evidence?.runDir || null,
    reportPath: result?.evidence?.reportPath || null,
    browserUrl: result?.telemetry?.browserUrl || null,
    steps,
    result,
  };
}

function shouldMarkUnrunAsSkipped(sourceResult) {
  const message = getErrorMessage(sourceResult?.error).toLowerCase();
  return sourceResult?.type === "test-file-stopped" || FAILURE_PHASE_PATTERN.test(message);
}

function buildCases({ sourceResult, testFile, queueRows, report }) {
  if (Array.isArray(queueRows) && queueRows.length) {
    return queueRows.map(normalizeCaseFromQueue);
  }

  const cases = [];
  const resultCases = Array.isArray(sourceResult?.caseResults) ? sourceResult.caseResults : [];
  if (resultCases.length) {
    resultCases.forEach((item, index) => {
      const sourceCase = getSourceCase(testFile, item);
      cases.push(normalizeCaseFromResult(item, index, getSourceCaseSteps(testFile, sourceCase)));
    });
  } else {
    const reportContext = report?.testContext || {};
    const resultSteps = getResultSteps(sourceResult);
    if (resultSteps.length || reportContext.caseName) {
      cases.push(normalizeCaseFromResult({
        caseId: reportContext.caseId,
        caseName: reportContext.caseName,
        result: report?.summary === sourceResult
          ? {
              ...sourceResult,
              telemetry: report.telemetry,
              evidence: report.evidence,
              testContext: report.testContext,
            }
          : sourceResult,
      }, 0, getSourceCaseSteps(testFile, getSourceCase(testFile, { caseId: reportContext.caseId, caseName: reportContext.caseName, result: sourceResult }))));
    }
  }

  const seen = new Set(cases.map((item) => item.caseId).filter(Boolean));
  const skippedByRootFailure = shouldMarkUnrunAsSkipped(sourceResult);
  (testFile?.cases || []).forEach((caseItem, index) => {
    if (seen.has(caseItem.id)) {
      return;
    }
    cases.push({
      caseId: caseItem.id || `case-${index + 1}`,
      caseName: caseItem.name || `Case ${index + 1}`,
      priority: caseItem.priority || "P1",
      index: cases.length,
      status: skippedByRootFailure ? "skipped" : "pending",
      isRoot: false,
      completedSteps: skippedByRootFailure ? getSourceCaseSteps(testFile, caseItem).length : 0,
      failedSteps: 0,
      totalSteps: getSourceCaseSteps(testFile, caseItem).length,
      durationMs: null,
      error: null,
      runDir: null,
      reportPath: null,
      browserUrl: null,
      steps: getSourceCaseSteps(testFile, caseItem).map((step, stepIndex) => ({
        ...normalizeStep(step, stepIndex),
        status: skippedByRootFailure ? "skipped" : "pending",
      })),
      result: null,
    });
  });

  return cases;
}

function countBy(items, getKey) {
  const counts = new Map();
  items.forEach((item) => {
    const key = getKey(item) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

function countStepStatuses(steps = [], totalFallback = 0) {
  const total = steps.length || totalFallback || 0;
  const passed = steps.filter((step) => PASS_STATUSES.has(step.status)).length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const skipped = steps.filter((step) => step.status === "skipped").length;
  return {
    total,
    passed,
    failed,
    skipped,
    pending: Math.max(0, total - passed - failed - skipped),
  };
}

function buildFailures(cases) {
  return cases.flatMap((caseItem) =>
    caseItem.steps
      .filter((step) => step.status === "failed" || step.error)
      .map((step) => ({
        caseId: caseItem.caseId,
        caseName: caseItem.caseName,
        priority: caseItem.priority,
        stepId: step.stepId,
        stepIndex: step.index,
        stepTitle: step.title,
        actionType: step.type,
        phase: step.phase,
        message: step.message || "Step failed.",
        tracePath: step.tracePath,
        beforeScreenshotPath: step.beforeScreenshotPath,
        afterScreenshotPath: step.afterScreenshotPath,
        raw: step.raw,
      })),
  );
}

function collectEvidence(cases, sourceResult, summary) {
  const paths = [];
  const pushPath = (kind, value, label) => {
    if (!value || paths.some((item) => item.value === value)) {
      return;
    }
    paths.push({ kind, value, label });
  };

  pushPath("report", summary?.reportPath || sourceResult?.evidence?.reportPath, "Report");
  pushPath("run-dir", summary?.runDir || sourceResult?.evidence?.runDir, "Run directory");
  cases.forEach((caseItem) => {
    pushPath("report", caseItem.reportPath, `${caseItem.caseName} report`);
    pushPath("run-dir", caseItem.runDir, `${caseItem.caseName} run dir`);
  });

  const failedSteps = cases.flatMap((caseItem) =>
    caseItem.steps
      .filter((step) => step.status === "failed" || step.error)
      .map((step) => ({ caseItem, step })),
  );
  const representativeSteps = failedSteps.length
    ? failedSteps
    : cases.flatMap((caseItem) => caseItem.steps.slice(0, 4).map((step) => ({ caseItem, step }))).slice(0, 12);

  representativeSteps.forEach(({ caseItem, step }) => {
      pushPath("trace", step.tracePath, `${caseItem.caseName} · ${step.title}`);
      pushPath("screenshot", step.beforeScreenshotPath, `${step.title} before`);
      pushPath("screenshot", step.afterScreenshotPath, `${step.title} after`);
  });
  return paths;
}

function buildSummary({ sourceResult, report, summary, runProgress, cases, failures }) {
  const allSteps = cases.flatMap((caseItem) => caseItem.steps);
  const progressDuration =
    runProgress?.finishedAt && runProgress?.startedAt
      ? runProgress.finishedAt - runProgress.startedAt
      : null;
  const caseCounts = {
    total: cases.filter((item) => !item.isRoot).length,
    passed: cases.filter((item) => !item.isRoot && item.status === "passed").length,
    failed: cases.filter((item) => !item.isRoot && item.status === "failed").length,
    skipped: cases.filter((item) => !item.isRoot && item.status === "skipped").length,
    pending: cases.filter((item) => !item.isRoot && item.status === "pending").length,
  };
  const rawStepCounts = {
    total: allSteps.length || toNumber(sourceResult?.telemetry?.steps ?? report?.telemetry?.steps ?? summary?.steps, 0),
    passed: allSteps.filter((item) => PASS_STATUSES.has(item.status)).length || toNumber(sourceResult?.telemetry?.okCount ?? report?.telemetry?.okCount ?? summary?.okCount, 0),
    failed: allSteps.filter((item) => item.status === "failed").length || toNumber(sourceResult?.telemetry?.errorCount ?? report?.telemetry?.errorCount ?? summary?.errorCount, 0),
    skipped: allSteps.filter((item) => item.status === "skipped").length,
  };
  const stepCounts = {
    ...rawStepCounts,
    pending: Math.max(0, rawStepCounts.total - rawStepCounts.passed - rawStepCounts.failed - rawStepCounts.skipped),
  };
  const totalCases = caseCounts.total || cases.length;
  const passRate = totalCases ? Math.round((caseCounts.passed / totalCases) * 100) : sourceResult?.ok === true || summary?.ok === true ? 100 : 0;
  const status = sourceResult?.type === "test-file-stopped" || runProgress?.status === "stopped"
    ? "stopped"
    : failures.length || sourceResult?.ok === false || summary?.status === "failed"
      ? "failed"
      : sourceResult?.ok === true || summary?.status === "passed"
        ? "passed"
        : normalizeStatus(runProgress?.status || summary?.status, "pending");
  return {
    status,
    ok: status === "passed" ? true : status === "failed" || status === "stopped" ? false : null,
    passRate,
    caseCounts,
    stepCounts,
    durationMs: toNumber(sourceResult?.telemetry?.durationMs ?? report?.telemetry?.durationMs ?? summary?.durationMs ?? progressDuration),
    startedAt: toNumber(report?.startedAt ?? summary?.startedAt ?? runProgress?.startedAt),
    finishedAt: toNumber(report?.finishedAt ?? summary?.finishedAt ?? runProgress?.finishedAt),
    firstFailure: failures[0] || summary?.firstFailure || null,
    browserUrl: sourceResult?.telemetry?.browserUrl || report?.telemetry?.browserUrl || summary?.browserUrl || "",
  };
}

function createContext({ sourceResult, report, summary, testFile, runProgress }) {
  const reportContext = report?.testContext || {};
  const sourceContext = sourceResult?.testContext || {};
  return {
    testFileId: testFile?.id || reportContext.testFileId || sourceContext.testFileId || summary?.testFileId || "",
    testFileName: testFile?.name || reportContext.testFileName || sourceContext.testFileName || summary?.testFileName || "Untitled test file",
    testFilePath: testFile?.path || reportContext.testFilePath || sourceContext.testFilePath || summary?.testFilePath || "",
    triggerSurface: sourceResult?.runContext?.triggerSurface || report?.runContext?.triggerSurface || summary?.runContext?.triggerSurface || "unknown",
    scope: sourceResult?.runContext?.scope || report?.runContext?.scope || summary?.runContext?.scope || runProgress?.scope || "unknown",
    baseUrl: testFile?.baseUrl || "",
  };
}

export function createRunReportModel({ result = null, testFile = null, runProgress = null, queueRows = null, report = null, summary = null } = {}) {
  const sourceResult = result || report?.summary || summary?.result || null;
  const cases = buildCases({ sourceResult, testFile, queueRows, report });
  const failures = buildFailures(cases);
  const allSteps = cases.flatMap((caseItem) => caseItem.steps);
  const reportSummary = buildSummary({ sourceResult, report, summary, runProgress, cases, failures });
  const context = createContext({ sourceResult, report, summary, testFile, runProgress });
  const chartCases = cases
    .filter((caseItem) => !caseItem.isRoot)
    .map((caseItem, index) => ({
      ...caseItem,
      chartLabel: `Case ${index + 1}`,
    }));
  const statusData = [
    { name: "Passed", value: reportSummary.caseCounts.passed, status: "passed" },
    { name: "Failed", value: reportSummary.caseCounts.failed, status: "failed" },
    { name: "Skipped", value: reportSummary.caseCounts.skipped, status: "skipped" },
    { name: "Pending", value: reportSummary.caseCounts.pending, status: "pending" },
  ].filter((item) => item.value > 0);
  const stepStatusData = [
    {
      name: "Steps",
      total: reportSummary.stepCounts.total,
      passed: reportSummary.stepCounts.passed,
      failed: reportSummary.stepCounts.failed,
      skipped: reportSummary.stepCounts.skipped,
      pending: reportSummary.stepCounts.pending,
    },
  ];
  return {
    generatedAt: Date.now(),
    status: reportSummary.status,
    summary: reportSummary,
    context,
    cases,
    failures,
    evidence: collectEvidence(cases, sourceResult, summary),
    charts: {
      caseStatus: statusData,
      caseStepStatus: chartCases
        .map((caseItem) => ({
          caseId: caseItem.caseId,
          name: caseItem.chartLabel,
          caseName: caseItem.caseName,
          status: caseItem.status,
          ...countStepStatuses(caseItem.steps, caseItem.totalSteps),
        })),
      stepStatus: stepStatusData,
      phaseDistribution: countBy(allSteps, (step) => step.phase),
      actionTypes: countBy(allSteps, (step) => step.type).slice(0, 8),
      failureTypes: countBy(failures, (failure) => failure.actionType || failure.phase).slice(0, 8),
      caseDurations: chartCases
        .map((caseItem) => ({
          name: caseItem.chartLabel,
          caseName: caseItem.caseName,
          durationMs: caseItem.durationMs || 0,
          status: caseItem.status,
        }))
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 12),
      slowestSteps: chartCases
        .flatMap((caseItem) =>
          caseItem.steps.map((step) => ({
            caseId: caseItem.caseId,
            caseName: caseItem.caseName,
            caseLabel: caseItem.chartLabel,
            name: step.title,
            type: step.type,
            phase: step.phase,
            durationMs: step.durationMs || 0,
            status: step.status,
          })),
        )
        .filter((step) => step.durationMs > 0)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 8),
    },
    raw: {
      result: sourceResult,
      report,
      summary,
    },
  };
}
