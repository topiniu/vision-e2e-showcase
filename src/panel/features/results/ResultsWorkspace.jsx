import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  CircleDashed,
  Clock3,
  Copy,
  FileJson,
  Globe,
  ImageOff,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Radar,
  RotateCcw,
  Trash2,
  Square,
  X,
} from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { RuntimeVariablesPanel } from "@panel/components/shared/RuntimeVariablesPanel";
import { FullTextTooltip } from "@panel/components/shared/FullTextTooltip";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@panel/components/ui/resizable";
import { getPanelPlatform, resolveEvidenceImageSrc } from "@panel/lib/panel-api";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import { retainEvidenceImageCache } from "@panel/lib/evidence-image-cache.mjs";
import { usePersistedPanelLayout } from "@panel/hooks/use-persisted-panel-layout";
import { createRunReportModel } from "@panel/lib/run-report-model.mjs";
import { buildExecutableCaseSteps } from "../../../shared/test-file.mjs";
import styles from "./ResultsWorkspace.module.css";

const RUN_WORKSPACE_LAYOUT = { queue: 38, detail: 62 };
const ROOT_QUEUE_ID = "__root_steps__";
const RUN_CONTROL_POSITION_KEY = "zhuzhu-run-control-bar-position";
const RunResultReportDialog = lazy(() =>
  import("./RunResultReportDialog").then((module) => ({ default: module.RunResultReportDialog })),
);

function durationLabel(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }
  const totalMs = Math.max(0, Number(value));
  if (totalMs < 1000) {
    return `${Math.round(totalMs)}ms`;
  }
  const totalSeconds = totalMs / 1000;
  if (totalSeconds < 10) {
    return `${totalSeconds.toFixed(1).replace(/\.0$/, "")}s`;
  }
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const parts = [];
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes) {
    parts.push(`${minutes}m`);
  }
  if (seconds || !parts.length) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

function safeJson(value) {
  if (value == null) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function toShortText(value) {
  if (value == null || value === "") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return safeJson(value);
}

function getRuntimeVariablesFromResult(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  return (
    result.runtimeVariables ||
    result.result?.runtimeVariables ||
    result.summary?.runtimeVariables ||
    result.raw?.runtimeVariables ||
    null
  );
}

function getRuntimeVariablesForDetail(result, selectedCase, selectedStep) {
  return (
    selectedStep?.raw?.runtimeVariables ||
    selectedStep?.raw?.data?.runtimeVariables ||
    selectedCase?.result?.runtimeVariables ||
    getRuntimeVariablesFromResult(result) ||
    null
	  );
	}

function getRunFeedbackReportPath(result, queueRows = []) {
  return (
    result?.evidence?.reportPath ||
    result?.reportPath ||
    result?.evidence?.caseRuns?.find((item) => item?.reportPath)?.reportPath ||
    queueRows.find((item) => item?.reportPath)?.reportPath ||
    null
  );
}

function formatRuntimeVariableValue(value) {
  const text = toShortText(value);
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function buildRuntimeVariableRows(runtimeVariables) {
  if (!runtimeVariables || typeof runtimeVariables !== "object" || Array.isArray(runtimeVariables)) {
    return [];
  }
  return Object.entries(runtimeVariables)
    .filter(([key]) => key)
    .map(([key, value]) => [key, formatRuntimeVariableValue(value)]);
}

function getExpectationIssue(expectation) {
  if (!expectation || typeof expectation !== "object") {
    return "";
  }
  if (Array.isArray(expectation.results)) {
    const failed = expectation.results.find((item) => item && item.ok === false);
    return getExpectationIssue(failed) || (expectation.ok === true ? "expectation=passed" : "");
  }
  if (Array.isArray(expectation.missing) && expectation.missing.length) {
    return `missing=${expectation.missing.join(", ")}`;
  }
  if (Array.isArray(expectation.present) && expectation.present.length) {
    return `present=${expectation.present.join(", ")}`;
  }
  if (expectation.property && Object.prototype.hasOwnProperty.call(expectation, "expected")) {
    return `${expectation.property}: expected ${toShortText(expectation.expected)}, got ${toShortText(expectation.actual)}`;
  }
  if (expectation.ok === true) {
    return "expectation=passed";
  }
  return expectation.type ? `expectation=${expectation.type}` : "";
}

function getResolutionIssue(resolution) {
  if (!resolution || typeof resolution !== "object") {
    return "";
  }
  const strategy = resolution.strategy || resolution.locatorSummary?.strategy;
  const count = resolution.locatorSummary?.count;
  if (!strategy && count == null) {
    return "";
  }
  return `resolution=${strategy || "unknown"}${count != null ? ` (${count})` : ""}`;
}

function formatErrorMessage(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  const details = value.details || {};
  const parts = [
    value.message || value.code || value.error,
    details.action ? `action=${details.action}` : "",
    getExpectationIssue(details.expectation),
    getResolutionIssue(details.resolution),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : safeJson(value);
}

function findFirstFailedResultError(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const caseResults = Array.isArray(value.caseResults) ? value.caseResults : [];
  for (const caseResult of caseResults) {
    const found = findFirstFailedResultError(caseResult?.result || caseResult);
    if (found) {
      return found;
    }
  }
  const resultSteps = Array.isArray(value.data?.results)
    ? value.data.results
    : Array.isArray(value.summary?.data?.results)
      ? value.summary.data.results
      : [];
  for (const step of resultSteps) {
    if (step?.ok === false) {
      return step.error || step.data?.action?.error || findFirstFailedResultError(step) || step;
    }
  }
  return value.ok === false ? value.error || null : null;
}

function statusLabel(status, fallback = "Pending") {
  switch (status) {
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "partial":
      return "Partial";
    case "stopped":
      return "Stopped";
    case "success":
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "idle":
      return "Idle";
    default:
      return fallback;
  }
}

function statusVariant(status) {
  if (status === "running" || status === "stopping") {
    return "running";
  }
  if (status === "partial") {
    return "warning";
  }
  if (status === "success" || status === "passed") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "skipped" || status === "stopped") {
    return "warning";
  }
  return "neutral";
}

function isCompleteStatus(status) {
  return status === "passed" || status === "success" || status === "failed" || status === "partial" || status === "stopped" || status === "skipped";
}

function getErrorMessage(value) {
  return formatErrorMessage(findFirstFailedResultError(value) || value);
}

function getStepEvidence(step) {
  return step?.evidence || step?.result?.evidence || step || null;
}

function getStepError(step) {
  return (
    step?.error ||
    step?.raw?.error ||
    step?.data?.action?.error ||
    step?.raw?.data?.action?.error ||
    step?.result?.error ||
    step?.raw?.result?.error ||
    null
  );
}

function getResultSteps(caseResult) {
  if (Array.isArray(caseResult?.data?.results)) {
    return caseResult.data.results;
  }
  if (Array.isArray(caseResult?.summary?.data?.results)) {
    return caseResult.summary.data.results;
  }
  if (Array.isArray(caseResult?.evidence?.steps)) {
    return caseResult.evidence.steps;
  }
  if (caseResult && !Array.isArray(caseResult?.data)) {
    return [caseResult];
  }
  return [];
}

function getResultStepPhase(step = {}) {
  if (!step) {
    return "";
  }
  return step.input?.phase || step.raw?.input?.phase || step.data?.normalizedAction?.phase || step.phase || "";
}

function getEvidenceStepPhase(step = {}) {
  if (!step) {
    return "";
  }
  return step.input?.phase || step.data?.normalizedAction?.phase || step.raw?.input?.phase || step.phase || "";
}

function getSourceStepTitle(step = {}, index = 0) {
  if (!step) {
    return `Step ${index + 1}`;
  }
  return (
    step.title ||
    step.stepTitle ||
    step.displayTitle ||
    step.query ||
    step.target?.name ||
    step.target?.text ||
    step.target?.placeholder ||
    step.macro ||
    step.request?.url ||
    step.type ||
    `Step ${index + 1}`
  );
}

function getStepPhaseLabel(step = {}) {
  if (!step) {
    return "Case";
  }
  if (step.phase === "setup") {
    return "Root setup";
  }
  if (step.phase === "fixtureSetup") {
    return step.sourceFixture ? `${step.sourceFixture} setup` : "Fixture setup";
  }
  if (step.phase === "fixtureTeardown") {
    return step.sourceFixture ? `${step.sourceFixture} teardown` : "Fixture teardown";
  }
  if (step.phase === "teardown") {
    return "Root teardown";
  }
  return "Case";
}

function isRootPhase(phase) {
  return phase === "setup" || phase === "teardown";
}

function getStepIdentity(step = {}, index = 0) {
  if (!step) {
    return `case:${index}`;
  }
  return `${step.phase || "case"}:${step.stepId || step.id || step.input?.id || index}`;
}

function getDisplayStepNumber(step = {}) {
  return (step.executionIndex ?? step.index ?? 0) + 1;
}

function findResultStep(resultSteps, stepIndex, stepId) {
  return (
    resultSteps.find((item) => item?.input?.id && item.input.id === stepId) ||
    resultSteps.find((item) => item?.data?.normalizedAction?.id && item.data.normalizedAction.id === stepId) ||
    resultSteps.find((item) => item?.index === stepIndex) ||
    resultSteps[stepIndex] ||
    null
  );
}

function hasCaseRunData(progressCase, caseResult) {
  return Boolean(
    caseResult ||
      progressCase?.result ||
      progressCase?.finishedAt ||
      (progressCase?.runId && progressCase.status && progressCase.status !== "pending"),
  );
}

function getCompletedFallbackStepStatus(progressCase, caseResult) {
  if (caseResult?.ok === true || progressCase?.status === "passed" || progressCase?.status === "success") {
    return "passed";
  }
  if (caseResult?.error?.code === "run-stopped" || progressCase?.status === "stopped") {
    return "stopped";
  }
  if (progressCase?.status === "skipped") {
    return "skipped";
  }
  return "pending";
}

function getResultStepStatus(resultStep) {
  if (!resultStep) {
    return null;
  }
  if (resultStep.stopped) {
    return "stopped";
  }
  if (resultStep.skipped) {
    return "skipped";
  }
  return resultStep.ok ? "passed" : "failed";
}

function deriveCaseStatus(progressCase, caseResult, steps) {
  if (progressCase?.status === "running" || progressCase?.status === "stopping") {
    return progressCase.status;
  }
  const executableSteps = steps.filter((step) => !isRootPhase(step.phase));
  const statusSteps = executableSteps.length ? executableSteps : steps;
  const completedSteps = statusSteps.filter((step) => isCompleteStatus(step.status));
  const hasPassedStep = statusSteps.some((step) => step.status === "passed" || step.status === "success");
  const hasFailedStep = statusSteps.some((step) => step.status === "failed");
  const hasInterruptedStep = statusSteps.some((step) => step.status === "stopped" || step.status === "skipped");
  const allPassed =
    statusSteps.length > 0 &&
    statusSteps.every((step) => step.status === "passed" || step.status === "success");
  const allSkipped = statusSteps.length > 0 && statusSteps.every((step) => step.status === "skipped");
  const allStopped = statusSteps.length > 0 && statusSteps.every((step) => step.status === "stopped");

  if (hasFailedStep || caseResult?.ok === false) {
    return "failed";
  }
  if (allSkipped) {
    return "skipped";
  }
  if (allStopped) {
    return "stopped";
  }
  if (allPassed) {
    return "passed";
  }
  if (hasPassedStep && (hasInterruptedStep || completedSteps.length < statusSteps.length)) {
    return "partial";
  }
  if (progressCase?.status === "failed") {
    return "failed";
  }
  if (completedSteps.length > 0) {
    return "partial";
  }
  if (!steps.length && caseResult?.ok === true) {
    return "passed";
  }
  if (progressCase?.status && progressCase.status !== "pending" && progressCase.status !== "success") {
    return progressCase.status;
  }
  return "pending";
}

function getExecutableDisplaySteps(testFile, caseItem) {
  if (!testFile || !caseItem?.id) {
    return caseItem?.steps || [];
  }
  try {
    return buildExecutableCaseSteps(testFile, caseItem.id, {
      includeRootSetup: false,
      includeRootTeardown: false,
    });
  } catch (_error) {
    return caseItem.steps || [];
  }
}

function mergeProgressIntoSourceSteps(sourceSteps = [], progressSteps = []) {
  if (!sourceSteps.length) {
    return progressSteps;
  }
  if (!progressSteps.length) {
    return sourceSteps;
  }
  const progressById = new Map(progressSteps.map((step) => [step.stepId || step.id, step]));
  return sourceSteps.map((sourceStep, index) => {
    const progressStep = progressById.get(sourceStep.id) || null;
    if (!progressStep) {
      return sourceStep;
    }
    return {
      ...sourceStep,
      ...progressStep,
      stepId: progressStep.stepId || sourceStep.id,
      id: sourceStep.id,
      index,
      phase: sourceStep.phase || progressStep.phase || "case",
      sourceFixture: sourceStep.sourceFixture || progressStep.sourceFixture || "",
      sourceMacro: sourceStep.sourceMacro || progressStep.sourceMacro || "",
    };
  });
}

function buildCaseRows({ testFile, runProgress, result, selectedCaseId }) {
  const sourceCases = testFile?.cases?.length
    ? testFile.cases
    : runProgress?.cases?.map((item) => ({
        id: item.caseId,
        name: item.caseName,
        priority: item.priority,
        steps: item.steps,
      })) || [];
  const resultCases = Array.isArray(result?.caseResults) ? result.caseResults : [];

  return sourceCases.map((caseItem, caseIndex) => {
    const progressCase = runProgress?.cases?.find((item) => item.caseId === caseItem.id);
    const resultCase = resultCases.find((item) => item.caseId === caseItem.id);
    const singleCaseResult = !resultCases.length && (selectedCaseId === caseItem.id || caseIndex === 0) ? result : null;
    const caseResult = resultCase?.result || singleCaseResult || null;
    const resultSteps = getResultSteps(caseResult).filter(Boolean).filter((step) => !isRootPhase(getResultStepPhase(step)));
    const evidenceSteps = (caseResult?.evidence?.steps || []).filter(Boolean).filter((step) => !isRootPhase(getEvidenceStepPhase(step)));
    const executableSourceSteps = getExecutableDisplaySteps(testFile, caseItem);
    const progressSteps = mergeProgressIntoSourceSteps(executableSourceSteps, progressCase?.steps || []);
    const sourceSteps = progressSteps.length ? progressSteps : caseItem.steps || [];
    const stepCount = Math.max(sourceSteps.length, resultSteps.length, evidenceSteps.length);
    const caseHasRunData = hasCaseRunData(progressCase, caseResult);
    const completedFallbackStatus = getCompletedFallbackStepStatus(progressCase, caseResult);
    const steps = Array.from({ length: stepCount }).map((_, stepIndex) => {
      const progressStep = progressSteps[stepIndex] || null;
      const sourceStep = sourceSteps[stepIndex] || caseItem.steps?.[stepIndex] || null;
      const resultStep = findResultStep(resultSteps, stepIndex, progressStep?.stepId || sourceStep?.id || caseItem.steps?.[stepIndex]?.id);
      const evidenceStep = evidenceSteps[stepIndex] || null;
      const error = getStepError(resultStep || progressStep || evidenceStep);
      const status =
        resultStep
          ? getResultStepStatus(resultStep)
          : progressStep?.status && progressStep.status !== "pending"
            ? progressStep.status
            : error
              ? "failed"
              : evidenceStep
                ? "passed"
                : caseHasRunData
                  ? completedFallbackStatus
                  : "pending";
      return {
        stepId: progressStep?.stepId || resultStep?.input?.id || evidenceStep?.stepId || `step-${stepIndex + 1}`,
        index: stepIndex,
        title:
          progressStep?.title ||
          getSourceStepTitle(sourceStep, stepIndex) ||
          getSourceStepTitle(resultStep?.input, stepIndex) ||
          resultStep?.type ||
          evidenceStep?.type ||
          evidenceStep?.data?.action?.detail?.kind ||
          `Step ${stepIndex + 1}`,
        type: progressStep?.type || resultStep?.type || evidenceStep?.type || evidenceStep?.data?.action?.detail?.kind || "runtime step",
        phase: progressStep?.phase || sourceStep?.phase || resultStep?.input?.phase || "case",
        sourceFixture: progressStep?.sourceFixture || sourceStep?.sourceFixture || resultStep?.input?.sourceFixture || "",
        sourceMacro: progressStep?.sourceMacro || sourceStep?.sourceMacro || resultStep?.input?.sourceMacro || "",
        status,
        durationMs: progressStep?.durationMs ?? resultStep?.data?.trace?.durationMs ?? evidenceStep?.data?.trace?.durationMs ?? evidenceStep?.data?.action?.durationMs ?? null,
        error,
        evidence: getStepEvidence(resultStep) || getStepEvidence(evidenceStep) || progressStep?.evidence || null,
        raw: resultStep || evidenceStep || progressStep || null,
      };
    });
    const displaySteps = steps
      .filter((step) => !isRootPhase(step.phase))
      .map((step, displayIndex) => ({
        ...step,
        displayIndex,
        executionIndex: step.index,
        index: displayIndex,
      }));
    const firstStepError = steps.find((step) => step.error)?.error || findFirstFailedResultError(caseResult);
    const failedSteps = displaySteps.filter((step) => step.status === "failed").length;
    const completedSteps = displaySteps.filter((step) => isCompleteStatus(step.status)).length;
    const caseStatus = deriveCaseStatus(progressCase, caseResult, steps);
    const normalizedStatus = caseStatus === "success" ? "passed" : caseStatus;
    return {
      caseId: caseItem.id,
      caseName: caseItem.name || `Case ${caseIndex + 1}`,
      priority: caseItem.priority || "P1",
      index: caseIndex,
      status: normalizedStatus,
      steps: displaySteps,
      executionSteps: steps,
      completedSteps,
      failedSteps,
      durationMs: progressCase?.durationMs ?? caseResult?.telemetry?.durationMs ?? null,
      error: firstStepError || progressCase?.error || caseResult?.error || null,
      result: caseResult,
      runDir: caseResult?.evidence?.runDir || null,
      reportPath: caseResult?.evidence?.reportPath || null,
      browserUrl: caseResult?.telemetry?.browserUrl || null,
    };
  });
}

function aggregateStepStatus(steps = []) {
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (steps.some((step) => step.status === "running" || step.status === "stopping")) {
    return "running";
  }
  if (steps.some((step) => step.status === "stopped")) {
    return "stopped";
  }
  if (steps.some((step) => step.status === "passed" || step.status === "success")) {
    return "passed";
  }
  if (steps.length && steps.every((step) => step.status === "skipped")) {
    return "skipped";
  }
  return "pending";
}

function buildRootQueueRow(caseRows, testFile, runProgress) {
  const runtimeRootSteps = Array.isArray(runProgress?.rootSteps) && runProgress.rootSteps.length
    ? runProgress.rootSteps
    : runProgress?.steps || [];
  const progressRootSteps = runtimeRootSteps.filter((step) => isRootPhase(step.phase));
  const rootSourceSteps = progressRootSteps.length ? [...progressRootSteps] : [];
  const seen = new Set();
  if (!rootSourceSteps.length) {
    caseRows.forEach((caseItem) => {
      (caseItem.executionSteps || []).forEach((step) => {
        if (!isRootPhase(step.phase)) {
          return;
        }
        const key = getStepIdentity(step, rootSourceSteps.length);
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        rootSourceSteps.push(step);
      });
    });
  }

  if (!rootSourceSteps.length) {
    const setupSteps = testFile?.setup?.steps || [];
    const teardownSteps = testFile?.teardown?.steps || [];
    setupSteps.forEach((step, index) => {
      rootSourceSteps.push({ ...step, stepId: step.id || `setup-${index + 1}`, phase: "setup", index });
    });
    teardownSteps.forEach((step, index) => {
      rootSourceSteps.push({ ...step, stepId: step.id || `teardown-${index + 1}`, phase: "teardown", index: setupSteps.length + index });
    });
  }

  if (!rootSourceSteps.length) {
    return null;
  }

  const steps = rootSourceSteps.map((sourceStep, index) => {
    const key = getStepIdentity(sourceStep, index);
    const relatedSteps = progressRootSteps.length
      ? progressRootSteps.filter((step) => getStepIdentity(step, index) === key)
      : caseRows.flatMap((caseItem) =>
          (caseItem.executionSteps || []).filter((step) => isRootPhase(step.phase) && getStepIdentity(step, index) === key),
        );
    const liveStep =
      relatedSteps.find((step) => step.status === "running" || step.status === "failed") ||
      [...relatedSteps].reverse().find((step) => step.status && step.status !== "pending") ||
      relatedSteps[0] ||
      null;
    return {
      ...sourceStep,
      ...liveStep,
      stepId: sourceStep.stepId || sourceStep.id || liveStep?.stepId || `root-step-${index + 1}`,
      index,
      executionIndex: sourceStep.executionIndex ?? sourceStep.index ?? index,
      title: sourceStep.title || liveStep?.title || getSourceStepTitle(sourceStep, index),
      type: sourceStep.type || liveStep?.type || "runtime step",
      phase: sourceStep.phase || liveStep?.phase || "setup",
      status: aggregateStepStatus(relatedSteps),
      durationMs: liveStep?.durationMs ?? null,
      error: relatedSteps.find((step) => step.error)?.error || null,
      evidence: liveStep?.evidence || null,
      raw: liveStep?.raw || liveStep || sourceStep,
    };
  });
  const status = aggregateStepStatus(steps);
  const completedSteps = steps.filter((step) => isCompleteStatus(step.status)).length;
  const failedSteps = steps.filter((step) => step.status === "failed").length;
  return {
    caseId: ROOT_QUEUE_ID,
    caseName: "Root Steps",
    priority: "ROOT",
    index: -1,
    status,
    steps,
    executionSteps: steps,
    completedSteps,
    failedSteps,
    durationMs: null,
    error: steps.find((step) => step.error)?.error || null,
    result: null,
    runDir: null,
    reportPath: null,
    browserUrl: null,
    isRoot: true,
  };
}

function buildQueueRows({ caseRows, testFile, runProgress }) {
  const rootRow = buildRootQueueRow(caseRows, testFile, runProgress);
  return rootRow ? [rootRow, ...caseRows] : caseRows;
}

function buildStats(queueRows, result, runProgress) {
  const caseRows = queueRows.filter((item) => !item.isRoot);
  const totalCases = caseRows.length;
  const completedCases = caseRows.filter((item) => isCompleteStatus(item.status)).length;
  const passedCases = caseRows.filter((item) => item.status === "passed" || item.status === "success").length;
  const failedCases = caseRows.filter((item) => item.status === "failed").length;
  const skippedCases = caseRows.filter((item) => item.status === "skipped").length;
  const totalSteps = queueRows.reduce((sum, item) => sum + item.steps.length, 0);
  const completedSteps = queueRows.reduce((sum, item) => sum + item.completedSteps, 0);
  const failedSteps = queueRows.reduce((sum, item) => sum + item.failedSteps, 0);
  const durationMs =
    result?.telemetry?.durationMs ??
    (runProgress?.startedAt ? (runProgress.finishedAt || Date.now()) - runProgress.startedAt : null);
  const firstError = queueRows.find((item) => item.error)?.error || runProgress?.error || result?.error || null;
  return {
    totalCases,
    completedCases,
    passedCases,
    failedCases,
    skippedCases,
    pendingCases: Math.max(0, totalCases - completedCases),
    totalSteps,
    completedSteps,
    failedSteps,
    durationMs,
    errorCount: result?.telemetry?.errorCount ?? failedCases,
    firstError,
  };
}

function getDefaultSelection(queueRows, runProgress) {
  const rootRow = queueRows.find((item) => item.isRoot) || null;
  const runningCase = queueRows.find((item) => item.caseId === runProgress?.currentCaseId) || null;
  const runningRootStep =
    rootRow && !runProgress?.currentCaseId && Number.isInteger(runProgress?.currentStepIndex)
      ? rootRow.steps[runProgress.currentStepIndex] || null
      : null;
  if (runningRootStep) {
    return {
      caseId: rootRow.caseId,
      stepIndex: runningRootStep.index,
    };
  }
  const runningStep =
    runningCase && Number.isInteger(runProgress?.currentStepIndex)
      ? (runningCase.executionSteps || runningCase.steps || [])[runProgress.currentStepIndex] || null
      : null;
  const currentCase = isRootPhase(runningStep?.phase)
    ? rootRow
    : runningCase ||
      queueRows.find((item) => item.status === "failed") ||
      queueRows[0] ||
      null;
  if (!currentCase) {
    return { caseId: null, stepIndex: null };
  }
  if (currentCase.isRoot && runningStep) {
    const rootStepIndex = currentCase.steps.findIndex((step) => getStepIdentity(step, step.index) === getStepIdentity(runningStep, runningStep.index));
    return {
      caseId: currentCase.caseId,
      stepIndex: rootStepIndex >= 0 ? rootStepIndex : null,
    };
  }
  if (currentCase && runningStep && Number.isInteger(runProgress?.currentStepIndex)) {
    const runningStepIndex = currentCase.steps.findIndex((step) => step.executionIndex === runProgress.currentStepIndex);
    if (runningStepIndex >= 0) {
      return {
        caseId: currentCase.caseId,
        stepIndex: runningStepIndex,
      };
    }
  }
  const currentStepIndex =
    currentCase?.steps.findIndex((step) => step.status === "failed") ??
    -1;
  return {
    caseId: currentCase?.caseId || null,
    stepIndex: currentStepIndex >= 0 ? currentStepIndex : null,
  };
}

export function ResultsWorkspace({
  result,
  testFile,
  selectedCaseId,
  runProgress,
  onRunPayload,
  onStopRun,
  onClearRunState,
  onSelectCase,
  isTestFileDirty,
  isRunning,
  isStoppingRun,
  lastRunAt,
}) {
  const caseRows = useMemo(
    () => buildCaseRows({ testFile, runProgress, result, selectedCaseId }),
    [testFile, runProgress, result, selectedCaseId],
  );
  const queueRows = useMemo(() => buildQueueRows({ caseRows, testFile, runProgress }), [caseRows, testFile, runProgress]);
  const stats = useMemo(() => buildStats(queueRows, result, runProgress), [queueRows, result, runProgress]);
  const defaultSelection = useMemo(() => getDefaultSelection(queueRows, runProgress), [queueRows, runProgress]);
  const [selectedCaseState, setSelectedCaseState] = useState(defaultSelection.caseId);
  const [selectedStepIndex, setSelectedStepIndex] = useState(defaultSelection.stepIndex);
  const [expandedCaseIds, setExpandedCaseIds] = useState(() => new Set(defaultSelection.caseId ? [defaultSelection.caseId] : []));
  const [imageCache, setImageCache] = useState({});
  const imageCacheRef = useRef({});
  const runningStepRef = useRef(null);
  const [lightbox, setLightbox] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [workspaceLayout, handleWorkspaceLayoutChanged] = usePersistedPanelLayout(
    "zhuzhu-run-workspace-layout",
    RUN_WORKSPACE_LAYOUT,
  );

  useEffect(() => {
    setSelectedCaseState(defaultSelection.caseId);
    setSelectedStepIndex(defaultSelection.stepIndex);
    setExpandedCaseIds(new Set(defaultSelection.caseId ? [defaultSelection.caseId] : []));
    setLightbox(null);
    setZoom(1);
  }, [result, defaultSelection.caseId, defaultSelection.stepIndex]);

  useEffect(() => {
    if (!selectedCaseId || !queueRows.some((item) => item.caseId === selectedCaseId)) {
      return;
    }
    setSelectedCaseState(selectedCaseId);
    setSelectedStepIndex(null);
    setExpandedCaseIds((current) => {
      if (current.has(selectedCaseId)) {
        return current;
      }
      return new Set([...current, selectedCaseId]);
    });
  }, [queueRows, selectedCaseId]);

  const selectedCase = queueRows.find((item) => item.caseId === selectedCaseState) || queueRows[0] || null;
  const selectedStep =
    selectedCase && Number.isInteger(selectedStepIndex) ? selectedCase.steps[selectedStepIndex] || null : null;
  const selectedEvidence = selectedStep?.evidence || null;
  const beforePath = selectedEvidence?.beforeScreenshotPath || selectedStep?.raw?.beforeScreenshotPath || "";
  const afterPath = selectedEvidence?.afterScreenshotPath || selectedStep?.raw?.afterScreenshotPath || "";
  const reportModel = useMemo(
    () => createRunReportModel({ result, testFile, runProgress, queueRows }),
    [result, testFile, runProgress, queueRows],
  );
  const canOpenReport = Boolean(result || runProgress?.result || runProgress?.finishedAt);
	  const runtimeVariables = runProgress?.runtimeVariables || getRuntimeVariablesFromResult(result);
	  const runtimeVariableSources = runProgress?.runtimeVariableSources || result?.runtimeVariableSources || result?.result?.runtimeVariableSources || null;
  const feedbackReportPath = getRunFeedbackReportPath(result, queueRows);
  const executionSource = runProgress?.runContext?.triggerSurface || result?.runContext?.triggerSurface || result?.result?.runContext?.triggerSurface || "";
	  const shouldAvoidTitlebar = getPanelPlatform() === "darwin";

  useEffect(() => {
    let cancelled = false;
    const activePaths = [...new Set([beforePath, afterPath].filter(Boolean))];
    const retainedCache = retainEvidenceImageCache(imageCacheRef.current, activePaths);
    imageCacheRef.current = retainedCache;
    setImageCache(retainedCache);
    setLightbox((current) => (
      current?.path && !activePaths.includes(current.path) ? null : current
    ));
    activePaths.forEach((imagePath) => {
      if (imageCacheRef.current[imagePath]) {
        return;
      }
      const loadingCache = {
        ...imageCacheRef.current,
        [imagePath]: { status: "loading" },
      };
      imageCacheRef.current = loadingCache;
      setImageCache(loadingCache);
      resolveEvidenceImageSrc(imagePath)
        .then((payload) => {
          if (cancelled) {
            return;
          }
          const nextCache = {
            ...imageCacheRef.current,
            [imagePath]: payload?.success
              ? { status: "loaded", src: payload.src, streamed: Boolean(payload.streamed) }
              : { status: "error", error: payload?.error || "read-failed" },
          };
          imageCacheRef.current = nextCache;
          setImageCache(nextCache);
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          const nextCache = {
            ...imageCacheRef.current,
            [imagePath]: { status: "error", error: error?.message || "read-failed" },
          };
          imageCacheRef.current = nextCache;
          setImageCache(nextCache);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [beforePath, afterPath]);

  const runningCase = isRunningLike(runProgress?.status)
    ? caseRows.find((item) => item.caseId === runProgress?.currentCaseId) || null
    : null;
  const runningStep =
    runningCase && Number.isInteger(runProgress?.currentStepIndex)
      ? (runningCase.executionSteps || [])[runProgress.currentStepIndex] || null
      : null;
  const rootRow = queueRows.find((item) => item.isRoot) || null;
  const runningRootStep =
    rootRow && isRunningLike(runProgress?.status) && !runProgress?.currentCaseId && Number.isInteger(runProgress?.currentStepIndex)
      ? rootRow.steps[runProgress.currentStepIndex] || null
      : null;
  const currentCase = isRunningLike(runProgress?.status)
    ? runningRootStep
      ? rootRow
      : isRootPhase(runningStep?.phase)
      ? rootRow || runningCase || selectedCase
      : runningCase || selectedCase
    : selectedCase;
  const currentStep =
    runningRootStep ||
    (currentCase?.isRoot && runningStep
      ? currentCase.steps.find((step) => getStepIdentity(step, step.index) === getStepIdentity(runningStep, runningStep.index)) || null
      : currentCase && Number.isInteger(runProgress?.currentStepIndex)
        ? currentCase.steps.find((step) => step.executionIndex === runProgress.currentStepIndex) || null
        : null);
  const isRunInProgress = isRunningLike(runProgress?.status);

  useEffect(() => {
    if (!isRunInProgress || !queueRows.length) {
      return;
    }
    setExpandedCaseIds((current) => {
      const nextIds = queueRows.map((item) => item.caseId);
      if (nextIds.every((caseId) => current.has(caseId)) && current.size === nextIds.length) {
        return current;
      }
      return new Set(nextIds);
    });
  }, [isRunInProgress, queueRows]);

  useEffect(() => {
    if (!isRunInProgress || !currentStep) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      runningStepRef.current?.scrollIntoView?.({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isRunInProgress, currentCase?.caseId, currentStep?.index, currentStep?.executionIndex, currentStep?.status]);

  const toggleCase = (caseId) => {
    setExpandedCaseIds((current) => {
      const next = new Set(current);
      if (next.has(caseId)) {
        next.delete(caseId);
      } else {
        next.add(caseId);
      }
      return next;
    });
  };

  const selectCase = (caseId) => {
    setSelectedCaseState(caseId);
    setSelectedStepIndex(null);
    if (caseId !== ROOT_QUEUE_ID) {
      onSelectCase?.(caseId);
    }
  };

  const selectStep = (caseId, stepIndex) => {
    setSelectedCaseState(caseId);
    setSelectedStepIndex(stepIndex);
    setExpandedCaseIds((current) => new Set([...current, caseId]));
    if (caseId !== ROOT_QUEUE_ID) {
      onSelectCase?.(caseId);
    }
  };

  return (
    <section className={styles.dashboard} aria-label="Run dashboard">
      <div className={styles.dashboardScroll}>
        <ResizablePanelGroup
          id="run-workspace-layout"
          orientation="horizontal"
          defaultLayout={workspaceLayout}
          onLayoutChanged={handleWorkspaceLayoutChanged}
          className={styles.workspaceGrid}
          resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
        >
          <ResizablePanel id="queue" defaultSize={`${workspaceLayout.queue}%`} minSize="300px" maxSize="520px" className={styles.resizablePanel}>
            <CaseRunQueue
              queueRows={queueRows}
              caseCount={caseRows.length}
              expandedCaseIds={expandedCaseIds}
              selectedCaseId={selectedCase?.caseId}
              selectedStepIndex={selectedStepIndex}
              runningCaseId={isRunInProgress ? currentCase?.caseId : null}
              runningStep={isRunInProgress ? currentStep : null}
              runningStepRef={runningStepRef}
              forceExpandAll={isRunInProgress}
              onToggleCase={toggleCase}
              onSelectCase={selectCase}
              onSelectStep={selectStep}
            />
          </ResizablePanel>
          <ResizableHandle withHandle className={styles.resizeHandle} />
          <ResizablePanel id="detail" defaultSize={`${workspaceLayout.detail}%`} minSize="360px" className={styles.resizablePanel}>
            <RunEvidencePanel
              result={result}
              selectedCase={selectedCase}
              selectedStep={selectedStep}
              beforePath={beforePath}
              afterPath={afterPath}
              beforeImage={imageCache[beforePath]}
              afterImage={imageCache[afterPath]}
              onPreview={(payload) => {
                setZoom(1);
                setLightbox(payload);
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

	      <RuntimeVariablesPanel
	        runtimeVariables={runtimeVariables}
	        runtimeVariableSources={runtimeVariableSources}
	        runtimeVariableHistory={runProgress?.runtimeVariableHistory}
        artifacts={feedbackReportPath ? [{ label: "Feedback report", value: feedbackReportPath, kind: "report-json" }] : []}
        executionSource={executionSource}
	        updatedAt={runProgress?.runtimeVariablesUpdatedAt || runProgress?.finishedAt || lastRunAt}
        compact
        floating
        className={styles.runtimeVariablesPanel}
      />

      <RunControlBar
        testFile={testFile}
        onRunFile={() => onRunPayload?.({ scope: "all", triggerSurface: "run" })}
        onStopRun={onStopRun}
        onClearRunState={onClearRunState}
        onOpenReport={() => setReportOpen(true)}
        currentCase={currentCase}
        currentStep={currentStep}
        stats={stats}
        isDirty={isTestFileDirty}
        isRunning={isRunning}
        isStoppingRun={isStoppingRun}
        runStatus={runProgress?.status}
        hasRunResult={Boolean(result || runProgress?.runId || runProgress?.finishedAt || runProgress?.result)}
        canOpenReport={canOpenReport}
      />

      {lightbox ? (
        <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label={`${lightbox.label} screenshot preview`}>
          <div className={styles.lightboxToolbar}>
            <div className={styles.lightboxTitle}>
              <span>{lightbox.label}</span>
              <span>{Math.round(zoom * 100)}%</span>
            </div>
            <div className={styles.lightboxActions}>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))}>
                <Minus />
              </Button>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Reset zoom" onClick={() => setZoom(1)}>
                <RotateCcw />
              </Button>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))}>
                <Plus />
              </Button>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Close preview" onClick={() => setLightbox(null)}>
                <X />
              </Button>
            </div>
          </div>
          <div className={styles.lightboxCanvas} onClick={() => setLightbox(null)}>
            <img
              src={lightbox.src}
              alt={`${lightbox.label} screenshot`}
              style={{ transform: `scale(${zoom})` }}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
          <div className={styles.lightboxPath}>{lightbox.path}</div>
        </div>
      ) : null}
      <Suspense fallback={null}>
        <RunResultReportDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          model={reportModel}
          titlebarSafe={shouldAvoidTitlebar}
        />
      </Suspense>
    </section>
  );
}

function RunControlBar({
  testFile,
  onRunFile,
  onStopRun,
  onClearRunState,
  onOpenReport,
  currentCase,
  currentStep,
  stats,
  isDirty,
  isRunning,
  isStoppingRun,
  runStatus,
  hasRunResult,
  canOpenReport,
}) {
  const controlRef = useRef(null);
  const dragStateRef = useRef(null);
  const [isControlCollapsed, setIsControlCollapsed] = useState(false);
  const [isControlHovered, setIsControlHovered] = useState(false);
  const [isAutoCollapseDisabled, setIsAutoCollapseDisabled] = useState(false);
  const [runActionFeedback, setRunActionFeedback] = useState(null);
  const [controlPosition, setControlPosition] = useState(() => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(RUN_CONTROL_POSITION_KEY) || "null");
      return Number.isFinite(parsed?.right) && Number.isFinite(parsed?.y) ? parsed : null;
    } catch (_error) {
      return null;
    }
  });
  const wasRunningRef = useRef(isRunning);

  const clampControlPosition = (nextPosition) => {
    const element = controlRef.current;
    const parent = element?.offsetParent;
    if (!element || !parent || !nextPosition) {
      return nextPosition;
    }
    const parentRect = parent.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const maxRight = Math.max(0, parentRect.width - rect.width);
    return {
      right: Math.min(Math.max(0, nextPosition.right), maxRight),
      y: Math.min(Math.max(12, nextPosition.y), Math.max(12, parentRect.height - rect.height - 12)),
    };
  };

  const persistControlPosition = (nextPosition) => {
    if (typeof window === "undefined" || !nextPosition) {
      return;
    }
    window.localStorage.setItem(RUN_CONTROL_POSITION_KEY, JSON.stringify(nextPosition));
  };

  useEffect(() => {
    if (isRunning) {
      setIsAutoCollapseDisabled(false);
      setIsControlCollapsed(true);
    } else if (wasRunningRef.current) {
      setIsControlCollapsed(false);
      setIsAutoCollapseDisabled(true);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    if (isRunning || isControlHovered || isAutoCollapseDisabled) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setIsControlCollapsed(true);
    }, 2000);
    return () => window.clearTimeout(timeout);
  }, [isRunning, isControlHovered, isAutoCollapseDisabled, testFile?.path, runStatus]);

  useEffect(() => {
    if (!controlPosition || typeof window === "undefined") {
      return undefined;
    }
    const onResize = () => {
      setControlPosition((current) => {
        const nextPosition = clampControlPosition(current);
        persistControlPosition(nextPosition);
        return nextPosition;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [controlPosition]);

  const startControlDrag = (event) => {
    if (event.button != null && event.button !== 0) {
      return;
    }
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches) {
      return;
    }
    const element = controlRef.current;
    const parent = element?.offsetParent;
    if (!element || !parent) {
      return;
    }
    const parentRect = parent.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const startPosition = {
      right: parentRect.right - rect.right,
      y: rect.top - parentRect.top,
    };
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition,
    };
    element.setPointerCapture?.(event.pointerId);
    setControlPosition(startPosition);
    setIsAutoCollapseDisabled(true);
    event.preventDefault();
  };

  const moveControlDrag = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const nextPosition = clampControlPosition({
      right: dragState.startPosition.right - (event.clientX - dragState.startX),
      y: dragState.startPosition.y + event.clientY - dragState.startY,
    });
    setControlPosition(nextPosition);
  };

  const endControlDrag = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = null;
    controlRef.current?.releasePointerCapture?.(event.pointerId);
    setControlPosition((current) => {
      const nextPosition = clampControlPosition(current);
      persistControlPosition(nextPosition);
      return nextPosition;
    });
  };

  const getRunActionStyle = (actionKey) => {
    const baseStyle = {
      backgroundColor: actionKey === "clear" ? "#ffffff" : "var(--panel-muted)",
      color: "var(--foreground)",
      fontWeight: 650,
    };
    if (runActionFeedback?.key !== actionKey) {
      return baseStyle;
    }
    return {
      ...baseStyle,
      backgroundColor: runActionFeedback.phase === "active" ? "var(--panel-strong)" : "var(--accent-soft)",
    };
  };
  const getRunActionHandlers = (actionKey, disabled) => {
    if (disabled) {
      return {};
    }
    return {
      onMouseEnter: () => setRunActionFeedback({ key: actionKey, phase: "hover" }),
      onMouseLeave: () => setRunActionFeedback(null),
      onMouseDown: () => setRunActionFeedback({ key: actionKey, phase: "active" }),
      onMouseUp: () => setRunActionFeedback({ key: actionKey, phase: "hover" }),
      onFocus: () => setRunActionFeedback({ key: actionKey, phase: "hover" }),
      onBlur: () => setRunActionFeedback(null),
    };
  };
  const clearRunDisabled = !hasRunResult;
  const openReportDisabled = !canOpenReport;
  const setControlHoverState = (nextValue) => {
    setIsControlHovered(nextValue);
    if (!nextValue) {
      setRunActionFeedback(null);
    }
  };

  return (
    <div
      ref={controlRef}
      className={styles.controlBar}
      style={controlPosition ? { right: `${controlPosition.right}px`, top: `${controlPosition.y}px` } : undefined}
      data-collapsed={isControlCollapsed}
      data-running={isRunning}
      data-dirty={isDirty}
      data-dragged={controlPosition ? "true" : "false"}
      onPointerMove={moveControlDrag}
      onPointerUp={endControlDrag}
      onPointerCancel={endControlDrag}
      onMouseEnter={() => setControlHoverState(true)}
      onMouseLeave={() => setControlHoverState(false)}
      onFocusCapture={() => setControlHoverState(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setControlHoverState(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.controlCollapseButton}
        aria-label={isControlCollapsed ? "Expand run controls" : "Collapse run controls"}
        aria-expanded={!isControlCollapsed}
        onClick={() => setIsControlCollapsed((value) => !value)}
      >
        {isControlCollapsed ? <ChevronsLeft /> : <ChevronsRight />}
      </button>
      <div className={styles.fileIdentity}>
        <Badge variant={statusVariant(runStatus)} className={styles.controlStatusBadge}>
          {isRunning ? "Running" : statusLabel(runStatus, "Ready")}
        </Badge>
        <div>
          <FullTextTooltip content={testFile?.name || "Untitled test file"} side="bottom">
            <strong>{testFile?.name || "Untitled test file"}</strong>
          </FullTextTooltip>
        </div>
      </div>

      <div
        className={styles.runStatusStrip}
        aria-label="Run summary"
        title="Drag run controls"
        onPointerDown={startControlDrag}
      >
        {isRunning ? (
          <span data-running="true">
            <i aria-hidden="true" />
            Running
          </span>
        ) : null}
        <span>{stats.completedCases}/{stats.totalCases} cases</span>
        <span>{stats.completedSteps}/{stats.totalSteps} steps</span>
        <span>{stats.failedSteps} failed</span>
        {isDirty ? <span data-warning="true">Unsaved</span> : null}
      </div>

      <div className={styles.runActions} data-running={isRunning ? "true" : "false"}>
        {isRunning ? (
          <Button variant="destructive" size="sm" onClick={onStopRun} disabled={isStoppingRun}>
            <Square data-icon="inline-start" />
            {isStoppingRun ? "Stopping" : "Stop run"}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearRunState}
              disabled={clearRunDisabled}
              style={getRunActionStyle("clear")}
              {...getRunActionHandlers("clear", clearRunDisabled)}
            >
              <Trash2 data-icon="inline-start" />
              Clear run
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onOpenReport}
              disabled={openReportDisabled}
              style={getRunActionStyle("old-report")}
              {...getRunActionHandlers("old-report", openReportDisabled)}
            >
              <FileJson data-icon="inline-start" />
              Old report
            </Button>
            <Button size="sm" onClick={onRunFile} disabled={!(testFile?.cases?.length)}>
              <Radar data-icon="inline-start" />
              Run file
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function isRunningLike(status) {
  return status === "running" || status === "stopping";
}

function CaseRunQueue({
  queueRows,
  caseCount,
  expandedCaseIds,
  selectedCaseId,
  selectedStepIndex,
  runningCaseId,
  runningStep,
  runningStepRef,
  forceExpandAll = false,
  onToggleCase,
  onSelectCase,
  onSelectStep,
}) {
  return (
    <section className={styles.queuePanel}>
      <div className={styles.panelHeader}>
        <div>
          <div className={styles.kicker}>Case queue</div>
          <h3>File execution path</h3>
        </div>
        <Badge variant="neutral">{queueRows.some((item) => item.isRoot) ? "1 root · " : ""}{caseCount} {caseCount === 1 ? "case" : "cases"}</Badge>
      </div>
      <div className={styles.caseList}>
        {queueRows.length ? (
          queueRows.map((caseItem) => {
            const active = selectedCaseId === caseItem.caseId;
            const expanded = forceExpandAll || expandedCaseIds.has(caseItem.caseId);
            return (
              <div
                key={caseItem.caseId}
                className={styles.caseBlock}
                data-active={active}
                data-expanded={expanded}
                data-status={caseItem.status}
                data-root={caseItem.isRoot}
              >
                <div className={styles.caseRow}>
                  <FullTextTooltip content={caseItem.caseName} side="right" align="start">
                    <button
                      type="button"
                      className={styles.caseSelectButton}
                      aria-expanded={expanded}
                      onClick={() => {
                        onSelectCase(caseItem.caseId);
                        if (!forceExpandAll) {
                          onToggleCase(caseItem.caseId);
                        }
                      }}
                    >
                      <span className={styles.statusDot} data-status={caseItem.status} />
                      <div className={styles.caseMain}>
                        <strong>{caseItem.caseName}</strong>
                        <span>{caseItem.completedSteps}/{caseItem.steps.length} {caseItem.isRoot ? "root steps" : "executable steps"} · {durationLabel(caseItem.durationMs)}</span>
                      </div>
                      <Badge variant={statusVariant(caseItem.status)}>{statusLabel(caseItem.status)}</Badge>
                      <span className={styles.expandButton} aria-hidden="true">
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                      </span>
                    </button>
                  </FullTextTooltip>
                </div>
                {expanded ? (
                  <div className={styles.stepList}>
                    {caseItem.steps.length ? (
                      caseItem.steps.map((step) => {
                        const runningStepActive =
                          runningCaseId === caseItem.caseId &&
                          runningStep &&
                          getStepIdentity(runningStep, runningStep.index) === getStepIdentity(step, step.index);
                        return (
                          <FullTextTooltip
                            key={`${caseItem.caseId}-${step.index}`}
                            content={step.title}
                            side="right"
                            align="start"
                          >
                            <button
                              type="button"
                              ref={runningStepActive ? runningStepRef : null}
                              className={styles.stepRow}
                              data-active={selectedCaseId === caseItem.caseId && selectedStepIndex === step.index}
                              data-running={runningStepActive}
                              data-status={step.status}
                              onClick={() => onSelectStep(caseItem.caseId, step.index)}
                            >
                              <StatusIcon status={step.status} />
                              <span>Step {(step.executionIndex ?? step.index) + 1}</span>
                              <strong>{step.title}</strong>
                              <small>{getStepPhaseLabel(step)} · {durationLabel(step.durationMs)}</small>
                            </button>
                          </FullTextTooltip>
                        );
                      })
                    ) : (
                      <div className={styles.emptyLine}>No steps in this case.</div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className={styles.emptyLine}>No cases in this test file.</div>
        )}
      </div>
    </section>
  );
}

function StatusIcon({ status }) {
  if (status === "running") {
    return <Loader2 className={styles.spinIcon} />;
  }
  if (status === "failed") {
    return <AlertCircle />;
  }
  if (status === "partial") {
    return <AlertCircle />;
  }
  if (status === "passed" || status === "success") {
    return <CheckCircle2 />;
  }
  if (status === "stopped") {
    return <Minus />;
  }
  if (status === "skipped") {
    return <Minus />;
  }
  return <CircleDashed />;
}

function RunEvidencePanel({ result, selectedCase, selectedStep, beforePath, afterPath, beforeImage, afterImage, onPreview }) {
  const stepError = selectedStep ? getStepError(selectedStep) : null;
  const failure = selectedStep ? stepError : selectedCase?.error || result?.error || null;
  const tracePath = selectedStep?.evidence?.tracePath || selectedStep?.raw?.data?.evidence?.tracePath || selectedStep?.raw?.tracePath || "";
  const runtimeVariableRows = buildRuntimeVariableRows(getRuntimeVariablesForDetail(result, selectedCase, selectedStep));
  return (
    <section className={styles.detailPanel}>
      <div className={styles.panelHeader}>
        <div>
          <div className={styles.kicker}>Detail panel</div>
          <FullTextTooltip content={selectedStep?.title || selectedCase?.caseName || "Run detail"} side="bottom" align="start">
            <h3>{selectedStep ? `Step ${getDisplayStepNumber(selectedStep)}` : selectedCase?.caseName || "Run detail"}</h3>
          </FullTextTooltip>
        </div>
        {selectedCase ? <Badge variant={statusVariant(selectedCase.status)}>{statusLabel(selectedCase.status)}</Badge> : null}
      </div>

      {selectedCase ? (
        <div className={styles.detailStack}>
          <DetailRow icon={Clock3} label={selectedCase.isRoot ? "Path" : "Case"} value={`${selectedCase.caseName} · ${selectedCase.completedSteps}/${selectedCase.steps.length} steps`} />
          <DetailRow icon={Globe} label="Last URL" value={selectedCase.browserUrl || result?.telemetry?.browserUrl || "-"} />
          <DetailRow icon={Radar} label="Run directory" value={selectedCase.runDir || result?.evidence?.runDir || "-"} />
          <DetailRow icon={FileJson} label="Report" value={selectedCase.reportPath || result?.evidence?.reportPath || "-"} copyable />
          <DetailRow icon={AlertCircle} label="Failure" value={getErrorMessage(failure) || "None"} danger={Boolean(failure)} />

          {selectedStep ? (
            <>
              <div className={styles.evidenceGrid}>
                <EvidenceThumb label="Before" path={beforePath} image={beforeImage} onPreview={onPreview} />
                <EvidenceThumb label="After" path={afterPath} image={afterImage} onPreview={onPreview} />
              </div>
              <DetailRow icon={FileJson} label="Trace" value={tracePath || "-"} copyable />
              <RunStepSummary step={selectedStep} />
              <RunVariablesSummary rows={runtimeVariableRows} />
            </>
          ) : (
            <div className={styles.emptyLine}>Select a step to inspect screenshots and trace details.</div>
          )}
        </div>
      ) : (
        <div className={styles.emptyLine}>Run the file or select a case to inspect evidence.</div>
      )}
    </section>
  );
}

function RunVariablesSummary({ rows }) {
  if (!rows.length) {
    return null;
  }
  return <SummarySection title="Run variables" rows={rows} />;
}

function getStepInput(step = {}) {
  if (!step) {
    return {};
  }
  return step.raw?.input || step.raw?.data?.normalizedAction || step.raw?.data?.action?.input || step.raw || step;
}

function getActionTargetLabel(input = {}) {
  if (!input) {
    return "-";
  }
  const target = input.target || {};
  return target.text || target.name || target.placeholder || target.ariaLabel || target.locator || input.query || input.request?.url || "-";
}

function buildRunStepSummaryRows(step = {}) {
  const safeStep = step || {};
  const input = getStepInput(safeStep);
  const action = safeStep.raw?.data?.action || safeStep.raw?.data?.result?.action || {};
  const trace = safeStep.raw?.data?.trace || safeStep.evidence?.data?.trace || {};
  const pageDiff = action.pageDiff || safeStep.raw?.data?.pageDiff || {};
  return {
    overview: [
      ["Status", statusLabel(safeStep.status, safeStep.status || "pending")],
      ["Phase", getStepPhaseLabel(safeStep)],
      ["Type", safeStep.type || input.type || "-"],
      ["Duration", durationLabel(safeStep.durationMs)],
      ["Failure", getErrorMessage(getStepError(safeStep)) || "-"],
    ],
    action: [
      ["Target", getActionTargetLabel(input)],
      ["Strategy", action.resolution?.strategy || action.locatorSummary?.strategy || "-"],
      ["Matched", action.success === true ? "Yes" : action.success === false ? "No" : "-"],
    ],
    result: [
      ["Before URL", trace.beforeUrl || action.beforeUrl || "-"],
      ["After URL", trace.afterUrl || action.afterUrl || "-"],
      ["Page diff", pageDiff.changed == null ? "-" : `${pageDiff.changed ? "changed" : "unchanged"}${pageDiff.ratio != null ? ` · ${pageDiff.ratio}` : ""}`],
    ],
  };
}

function RunStepSummary({ step }) {
  const sections = buildRunStepSummaryRows(step);
  return (
    <div className={styles.runStepSummary}>
      <SummarySection title="Overview" rows={sections.overview} />
      <SummarySection title="Action" rows={sections.action} />
      <SummarySection title="Result" rows={sections.result} />
    </div>
  );
}

function SummarySection({ title, rows }) {
  const visibleRows = rows.filter(([, value]) => value && value !== "-");
  if (!visibleRows.length) {
    return null;
  }
  return (
    <div className={styles.summarySection}>
      <h4>{title}</h4>
      <div className={styles.summaryRows}>
        {visibleRows.map(([label, value]) => (
          <div key={label} className={styles.summaryRow}>
            <span>{label}</span>
            <FullTextTooltip content={value} side="left" align="start">
              <strong>{value}</strong>
            </FullTextTooltip>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailRow({ icon: Icon, label, value, danger = false, copyable = false }) {
  const canCopy = copyable && value && value !== "-";
  return (
    <div className={styles.detailRow}>
      <span>
        <Icon />
        {label}
      </span>
      <div className={styles.detailValue}>
        <FullTextTooltip content={value} side="left" align="start">
          <strong data-danger={danger}>{value}</strong>
        </FullTextTooltip>
        {canCopy ? (
          <button
            type="button"
            className={styles.copyPathButton}
            onClick={() => copyTextToClipboard(value)}
            aria-label={`Copy ${label} path`}
            title={`Copy ${label} path`}
          >
            <Copy />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EvidenceThumb({ label, path: imagePath, image, onPreview }) {
  const hasPath = Boolean(imagePath);
  const ready = hasPath && image?.status === "loaded" && image.src;
  const loading = hasPath && (!image || image.status === "loading");
  const error = hasPath && image?.status === "error";

  return (
    <div className={styles.evidenceThumb}>
      <div className={styles.evidenceThumbHeader}>
        <span>{label}</span>
        {ready ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onPreview({ label, path: imagePath, src: image.src })}>
            <Maximize2 />
            放大
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.imagePreview}
        disabled={!ready}
        onClick={() => onPreview({ label, path: imagePath, src: image.src })}
      >
        {ready ? (
          <img src={image.src} alt={`${label} screenshot`} loading="lazy" decoding="async" />
        ) : (
          <span className={styles.imagePlaceholder}>
            {loading ? <Loader2 className={styles.spinIcon} /> : <ImageOff />}
            {hasPath ? (error ? image.error : "Loading screenshot") : "No screenshot"}
          </span>
        )}
      </button>
      <FullTextTooltip content={imagePath || "-"} side="top" align="start">
        <div className={styles.imagePath}>{imagePath || "-"}</div>
      </FullTextTooltip>
    </div>
  );
}
