
function slimResultForProgress(result) {
  if (!result || typeof result !== "object") {
    return result || null;
  }
  return {
    ok: result.ok ?? null,
    type: result.type ?? null,
    skipped: result.skipped ?? undefined,
    stopped: result.stopped ?? undefined,
    error: result.error ?? null,
    telemetry: result.telemetry ?? null,
    evidence: result.evidence ?? null,
    runContext: result.runContext ?? null,
    runtimeVariables: result.runtimeVariables ?? null,
    runtimeVariableSources: result.runtimeVariableSources ?? null,
  };
}

function getExecutionStepTitle(step = {}, index = 0) {
  return (
    step.stepTitle ||
    step.displayTitle ||
    step.title ||
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

function createStepExecutionState(step, index) {
  return {
    stepId: step.id,
    index,
    type: step.type,
    title: getExecutionStepTitle(step, index),
    query: step.query || "",
    phase: step.phase || "case",
    sourceMacro: step.sourceMacro || "",
    sourceFixture: step.sourceFixture || "",
    status: "pending",
    message: "",
    error: null,
    durationMs: null,
    evidence: null,
    diagnostics: null,
  };
}

function getStepIdentifier(step = {}) {
  return step.stepId || step.id || step.input?.id || step.raw?.input?.id || "";
}

function getStepPhase(step = {}) {
  return step.phase || step.input?.phase || step.raw?.input?.phase || "case";
}

function getStepSourceFixture(step = {}) {
  return step.sourceFixture || step.input?.sourceFixture || step.raw?.input?.sourceFixture || "";
}

function getStepSourceMacro(step = {}) {
  return step.sourceMacro || step.input?.sourceMacro || step.raw?.input?.sourceMacro || "";
}

export function getRunStepIdentity(step = {}, fallbackIndex = "") {
  const stepId = getStepIdentifier(step) || (fallbackIndex !== "" && fallbackIndex != null ? `index-${fallbackIndex}` : "");
  return [
    getStepPhase(step),
    getStepSourceFixture(step),
    getStepSourceMacro(step),
    stepId,
  ].join("::");
}

function createStepIdentityLookup(steps = []) {
  const byIdentity = new Map();
  const byStepId = new Map();
  steps.forEach((step, index) => {
    const identity = getRunStepIdentity(step, index);
    if (identity) {
      byIdentity.set(identity, step);
    }
    const stepId = getStepIdentifier(step);
    if (stepId) {
      const matches = byStepId.get(stepId) || [];
      matches.push(step);
      byStepId.set(stepId, matches);
    }
  });
  return { byIdentity, byStepId };
}

function createCaseExecutionState(caseItem, index) {
  const steps = Array.isArray(caseItem?.steps) ? caseItem.steps : [];
  return {
    caseId: caseItem?.id || `case-${index + 1}`,
    caseName: caseItem?.name || `Case ${index + 1}`,
    priority: caseItem?.priority || "P1",
    index,
    status: "pending",
    steps: steps.map((step, stepIndex) => createStepExecutionState(step, stepIndex)),
    completedSteps: 0,
    failedSteps: 0,
    durationMs: null,
    error: null,
    result: null,
    runId: null,
    startedAt: null,
    finishedAt: null,
  };
}

function getCurrentCase(progress) {
  if (!Array.isArray(progress?.cases) || !progress.cases.length) {
    return null;
  }
  return progress.cases.find((caseItem) => caseItem.caseId === progress.currentCaseId) || progress.cases[0] || null;
}

function countCompletedSteps(steps = []) {
  return steps.filter((step) => step.status === "passed" || step.status === "failed" || step.status === "skipped").length;
}

function countFailedSteps(steps = []) {
  return steps.filter((step) => step.status === "failed").length;
}

function getFallbackStepStatus(event) {
  if (event.status === "skipped" || event.result?.skipped) {
    return "skipped";
  }
  if (event.status === "stopped") {
    return "stopped";
  }
  if (event.status === "failed" || event.result?.ok === false || event.error) {
    return "failed";
  }
  if (event.status === "success" || event.result?.ok === true) {
    return "passed";
  }
  return "pending";
}

function getCompletedStepStatus(event) {
  if (event.status === "skipped" || event.result?.skipped) {
    return "skipped";
  }
  if (event.status === "stopped" || event.result?.stopped) {
    return "stopped";
  }
  if (event.status === "failed" || event.result?.ok === false || event.error) {
    return "failed";
  }
  if (event.status === "success" || event.status === "passed" || event.result?.ok === true) {
    return "passed";
  }
  return event.status || "passed";
}

function finalizeRunningSteps(steps = [], event) {
  const fallbackStatus = getFallbackStepStatus(event);
  return steps.map((step) => {
    if (step.status !== "running") {
      return step;
    }
    return {
      ...step,
      status: fallbackStatus,
      message: fallbackStatus === "failed"
        ? event.error?.message || event.result?.error?.message || "Run ended before this step reported completion."
        : fallbackStatus === "stopped"
          ? "Run stopped before this step reported completion."
          : step.message || "",
      error: fallbackStatus === "failed" ? event.error || event.result?.error || step.error : step.error,
    };
  });
}

function syncCaseCounters(caseItem) {
  const steps = caseItem.steps || [];
  return {
    ...caseItem,
    completedSteps: countCompletedSteps(steps),
    failedSteps: countFailedSteps(steps),
  };
}

function setCaseStatus(progress, caseId, status) {
  if (!caseId || !Array.isArray(progress?.cases)) {
    return progress;
  }
  return {
    ...progress,
    cases: progress.cases.map((caseItem) =>
      caseItem.caseId === caseId
        ? syncCaseCounters({
            ...caseItem,
            status,
          })
        : caseItem,
    ),
  };
}

function hasStartedCasePhase(caseItem) {
  return (caseItem?.steps || []).some((step) => {
    const phase = step.phase || "case";
    return phase === "case" && step.status !== "pending";
  });
}

function deriveCompletedCaseStatus(caseItem, event) {
  if (event.status === "stopped") {
    return "stopped";
  }
  const steps = Array.isArray(caseItem?.steps) ? caseItem.steps : [];
  if (steps.some((step) => step.status === "failed") || event.status === "failed" || event.result?.ok === false) {
    return "failed";
  }
  if (steps.length > 0 && steps.every((step) => step.status === "skipped")) {
    return "skipped";
  }
  if (
    steps.length > 0 &&
    steps.some((step) => step.status === "passed") &&
    steps.every((step) => step.status === "passed" || step.status === "skipped")
  ) {
    return "passed";
  }
  if (!steps.length && event.result?.ok === true) {
    return "passed";
  }
  if (caseItem.status === "running") {
    return "pending";
  }
  return caseItem.status;
}

function normalizeProgressOptions(steps, options = {}) {
  const cases = Array.isArray(options.cases) && options.cases.length
    ? options.cases.map((caseItem, index) => createCaseExecutionState(caseItem, index))
    : [];
  const selectedCaseId =
    options.selectedCaseId ||
    cases.find((caseItem) => caseItem.caseId === options.currentCaseId)?.caseId ||
    cases[0]?.caseId ||
    null;
  return {
    scope: options.scope || (cases.length > 1 ? "file" : "case"),
    currentCaseId: selectedCaseId,
    cases,
    steps: cases.length
      ? (cases.find((caseItem) => caseItem.caseId === selectedCaseId) || cases[0]).steps
      : steps.map((step, index) => createStepExecutionState(step, index)),
  };
}

function getRuntimeVariablePatch(event = {}) {
  const hasVariables = event.runtimeVariables && typeof event.runtimeVariables === "object" && !Array.isArray(event.runtimeVariables);
  const hasSources = event.runtimeVariableSources && typeof event.runtimeVariableSources === "object" && !Array.isArray(event.runtimeVariableSources);
  if (!hasVariables && !hasSources) {
    return {};
  }
  return {
    ...(hasVariables ? { runtimeVariables: { ...event.runtimeVariables } } : {}),
    ...(hasSources ? { runtimeVariableSources: { ...event.runtimeVariableSources } } : {}),
    runtimeVariablesUpdatedAt: event.finishedAt || event.startedAt || Date.now(),
  };
}

function stringifyRuntimeVariableValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildRuntimeVariableHistoryEntry(event = {}, key, value, previousValue, changeType) {
  return {
    key,
    value: stringifyRuntimeVariableValue(value),
    previousValue: previousValue == null ? "" : stringifyRuntimeVariableValue(previousValue),
    changeType,
    source: event.runtimeVariableSources?.[key] || "unknown",
    runId: event.runId || "",
    childRunId: event.childRunId || "",
    caseId: event.caseId || "",
    caseName: event.caseName || "",
    stepId: event.stepId || "",
    stepIndex: Number.isInteger(event.stepIndex) ? event.stepIndex : null,
    stepNumber: Number.isInteger(event.stepIndex) ? event.stepIndex + 1 : null,
    phase: event.phase || "",
    sourceFixture: event.sourceFixture || "",
    sourceMacro: event.sourceMacro || "",
    eventType: event.type || "",
    at: event.finishedAt || event.startedAt || Date.now(),
  };
}

function getRuntimeVariableHistoryPatch(progress = {}, event = {}) {
  const hasVariables = event.runtimeVariables && typeof event.runtimeVariables === "object" && !Array.isArray(event.runtimeVariables);
  if (!hasVariables) {
    return {};
  }
  const previousVariables =
    progress.runtimeVariables && typeof progress.runtimeVariables === "object" && !Array.isArray(progress.runtimeVariables)
      ? progress.runtimeVariables
      : {};
  const previousHistory =
    progress.runtimeVariableHistory && typeof progress.runtimeVariableHistory === "object" && !Array.isArray(progress.runtimeVariableHistory)
      ? progress.runtimeVariableHistory
      : {};
  const nextHistory = { ...previousHistory };
  let changed = false;
  for (const [key, value] of Object.entries(event.runtimeVariables)) {
    if (!key) {
      continue;
    }
    const currentValue = stringifyRuntimeVariableValue(value);
    const hasPreviousValue = Object.prototype.hasOwnProperty.call(previousVariables, key);
    const previousValue = hasPreviousValue ? stringifyRuntimeVariableValue(previousVariables[key]) : "";
    const existing = Array.isArray(nextHistory[key]) ? nextHistory[key] : [];
    if (!existing.length) {
      if (!currentValue) {
        continue;
      }
      const changeType = event.type === "run-start" || event.type === "case-start" ? "initial" : "update";
      nextHistory[key] = [
        buildRuntimeVariableHistoryEntry(event, key, value, null, changeType),
      ];
      changed = true;
      continue;
    }
    if (!hasPreviousValue || previousValue !== currentValue) {
      nextHistory[key] = [
        ...existing,
        buildRuntimeVariableHistoryEntry(event, key, value, previousVariables[key], "update"),
      ];
      changed = true;
    }
  }
  return changed ? { runtimeVariableHistory: nextHistory } : {};
}

function getRuntimeVariableEventPatch(progress = {}, event = {}) {
  return {
    ...getRuntimeVariableHistoryPatch(progress, event),
    ...getRuntimeVariablePatch(event),
  };
}

export function createRunProgress(steps = [], runId = null, options = {}) {
  const normalized = normalizeProgressOptions(steps, options);
  return {
    runId,
    scope: normalized.scope,
    status: "idle",
    currentCaseId: normalized.currentCaseId,
    currentCaseRunId: null,
    currentStepIndex: null,
    cases: normalized.cases,
    steps: normalized.steps,
    lastEvent: null,
    error: null,
    result: null,
    startedAt: null,
    finishedAt: null,
    runtimeVariables: options.runtimeVariables || null,
    runtimeVariableSources: options.runtimeVariableSources || null,
    runtimeVariableHistory: options.runtimeVariableHistory || {},
    runtimeVariablesUpdatedAt: null,
    runContext: options.runContext || null,
  };
}

export function getRunProgressForCase(progress, caseId) {
  if (!progress || !caseId || !Array.isArray(progress.cases)) {
    return progress;
  }
  const caseItem = progress.cases.find((item) => item.caseId === caseId);
  if (!caseItem) {
    return progress;
  }
  const isActiveCase = progress.currentCaseId === caseItem.caseId;
  return {
    ...progress,
    currentCaseId: caseItem.caseId,
    currentStepIndex: isActiveCase ? progress.currentStepIndex ?? null : null,
    status: caseItem.status || progress.status || "idle",
    steps: caseItem.steps || [],
    error: caseItem.error || null,
    result: caseItem.result || null,
    startedAt: caseItem.startedAt || progress.startedAt || null,
    finishedAt: caseItem.finishedAt || progress.finishedAt || null,
  };
}

export function syncRunProgressSteps(progress, steps = []) {
  const current = progress?.steps || [];
  const currentLookup = createStepIdentityLookup(current);
  const nextSteps = steps.map((step, index) => {
    const candidate = createStepExecutionState(step, index);
    const exactMatched = currentLookup.byIdentity.get(getRunStepIdentity(candidate, index));
    const idMatches = currentLookup.byStepId.get(candidate.stepId) || [];
    const matched = exactMatched || (idMatches.length === 1 ? idMatches[0] : null);
    return matched
      ? {
          ...matched,
          stepId: step.id,
          index,
          type: step.type,
          title: getExecutionStepTitle(step, index),
          query: step.query || "",
          phase: step.phase || "case",
          sourceMacro: step.sourceMacro || "",
          sourceFixture: step.sourceFixture || "",
        }
      : createStepExecutionState(step, index);
  });

  return {
    ...(progress || createRunProgress()),
    steps: nextSteps,
    cases: Array.isArray(progress?.cases)
      ? progress.cases.map((caseItem) =>
          caseItem.caseId === progress.currentCaseId
            ? syncCaseCounters({ ...caseItem, steps: nextSteps })
            : caseItem,
        )
      : [],
  };
}

function updateStep(progress, stepIndex, updater, caseId = progress.currentCaseId) {
  const shouldUpdateRootSteps = !caseId && Array.isArray(progress.rootSteps) && progress.rootSteps.length;
  const sourceSteps = shouldUpdateRootSteps
    ? progress.rootSteps
    : caseId && Array.isArray(progress.cases)
    ? progress.cases.find((caseItem) => caseItem.caseId === caseId)?.steps || []
    : progress.steps;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= sourceSteps.length) {
    return progress;
  }
  const nextSteps = sourceSteps.map((step, index) => (index === stepIndex ? updater(step) : step));
  if (!caseId || !Array.isArray(progress.cases) || !progress.cases.length) {
    return {
      ...progress,
      steps: shouldUpdateRootSteps && progress.currentCaseId ? progress.steps : nextSteps,
      ...(shouldUpdateRootSteps ? { rootSteps: nextSteps } : {}),
    };
  }
  const nextCases = progress.cases.map((caseItem) =>
    caseItem.caseId === caseId ? syncCaseCounters({ ...caseItem, steps: nextSteps }) : caseItem,
  );
  return {
    ...progress,
    cases: nextCases,
    steps: caseId === progress.currentCaseId ? nextSteps : progress.steps,
  };
}

function resolveStepIndex(progress, event) {
  if (event?.stepId) {
    const exactIdentity = getRunStepIdentity({
      stepId: event.stepId,
      phase: event.phase || "case",
      sourceFixture: event.sourceFixture || "",
      sourceMacro: event.sourceMacro || "",
    });
    const exactMatchedIndex = progress.steps.findIndex((step, index) => getRunStepIdentity(step, index) === exactIdentity);
    if (exactMatchedIndex >= 0) {
      return exactMatchedIndex;
    }
    if (event?.phase) {
      const phaseMatchedIndex = progress.steps.findIndex((step) => {
        if (step.stepId !== event.stepId || step.phase !== event.phase) {
          return false;
        }
        if (event.sourceFixture && step.sourceFixture !== event.sourceFixture) {
          return false;
        }
        if (event.sourceMacro && step.sourceMacro !== event.sourceMacro) {
          return false;
        }
        return true;
      });
      if (phaseMatchedIndex >= 0) {
        return phaseMatchedIndex;
      }
    }
    const idMatchedIndexes = progress.steps
      .map((step, index) => (step.stepId === event.stepId ? index : -1))
      .filter((index) => index >= 0);
    if (idMatchedIndexes.length === 1) {
      return idMatchedIndexes[0];
    }
  }
  return Number.isInteger(event?.stepIndex) ? event.stepIndex : null;
}

export function applyRuntimeRunEvent(progress, event) {
  if (!event) {
    return progress;
  }

  const base = progress || createRunProgress();
  const eventMatchesParentRun = base.runId && event.runId && base.runId === event.runId;
  const eventMatchesCurrentCaseRun = base.currentCaseRunId && event.runId && base.currentCaseRunId === event.runId;
  if (base.runId && event.runId && !eventMatchesParentRun && !eventMatchesCurrentCaseRun) {
    return base;
  }

  const isRootChildEvent = Boolean(event.childRunId || event.rootPhase) && !event.caseId;
  const activeCaseId =
    isRootChildEvent
      ? null
      : event.caseId ||
        (eventMatchesCurrentCaseRun
          ? base.currentCaseId
          : base.cases?.find((caseItem) => caseItem.runId === event.runId)?.caseId) ||
        base.currentCaseId;
  const activeCase = base.cases?.find((caseItem) => caseItem.caseId === activeCaseId) || null;
  const stepScope = isRootChildEvent && Array.isArray(base.rootSteps) && base.rootSteps.length
    ? { ...base, steps: base.rootSteps }
    : activeCase
      ? { ...base, steps: activeCase.steps }
      : base;
  const resolvedStepIndex = resolveStepIndex(stepScope, event);
  const runtimeVariableEvent = {
    ...event,
    caseId: event.caseId || activeCase?.caseId || "",
    caseName: event.caseName || activeCase?.caseName || "",
    stepIndex: Number.isInteger(event.stepIndex) ? event.stepIndex : resolvedStepIndex,
  };

  switch (event.type) {
    case "case-start": {
      const nextCases = (base.cases || []).map((caseItem) =>
        caseItem.caseId === event.caseId
          ? {
              ...caseItem,
              status: "pending",
              runId: event.caseRunId || event.runId || caseItem.runId,
              startedAt: event.startedAt || Date.now(),
              finishedAt: null,
              durationMs: null,
              error: null,
              result: null,
              completedSteps: 0,
              failedSteps: 0,
              steps: caseItem.steps.map((step) => ({
                ...step,
                status: "pending",
                message: "",
                error: null,
                durationMs: null,
                evidence: null,
                diagnostics: null,
              })),
            }
          : caseItem,
      );
      const currentCase = nextCases.find((caseItem) => caseItem.caseId === event.caseId);
      return {
        ...base,
        runId: event.runId || base.runId,
        status: "running",
        currentCaseId: event.caseId || base.currentCaseId,
        currentCaseRunId: event.caseRunId || base.currentCaseRunId,
        currentStepIndex: null,
        cases: nextCases,
        steps: currentCase?.steps || base.steps,
        lastEvent: event,
        ...getRuntimeVariableEventPatch(base, runtimeVariableEvent),
      };
    }
    case "case-complete": {
      const nextCases = (base.cases || []).map((caseItem) =>
        caseItem.caseId === event.caseId
          ? (() => {
              const nextSteps = finalizeRunningSteps(caseItem.steps, event);
              return syncCaseCounters({
                ...caseItem,
                status: event.status || (event.result?.ok ? "passed" : "failed"),
                steps: nextSteps,
                durationMs: event.durationMs ?? event.result?.telemetry?.durationMs ?? caseItem.durationMs,
                error: event.error || event.result?.error || null,
                result: slimResultForProgress(event.result),
                finishedAt: event.finishedAt || Date.now(),
              });
            })()
          : caseItem,
      );
      const currentCase = nextCases.find((caseItem) => caseItem.caseId === base.currentCaseId);
      return {
        ...base,
        status: event.status === "failed" ? "failed" : base.status,
        currentCaseRunId: null,
        cases: nextCases,
        steps: currentCase?.steps || base.steps,
        error: event.status === "failed" ? event.error || event.result?.error || base.error : base.error,
        lastEvent: event,
        ...getRuntimeVariableEventPatch(base, runtimeVariableEvent),
      };
    }
    case "run-start": {
      const nextSteps = base.steps.map((step) => ({
        ...step,
        status: "pending",
        message: "",
        error: null,
        durationMs: null,
        evidence: null,
        diagnostics: null,
      }));
      const nextCases = Array.isArray(base.cases)
        ? base.cases.map((caseItem) =>
            caseItem.caseId === activeCaseId
              ? syncCaseCounters({
                  ...caseItem,
                  status: "pending",
                  runId: event.runId || caseItem.runId,
                  startedAt: event.startedAt || Date.now(),
                  finishedAt: null,
                  durationMs: null,
                  error: null,
                  result: null,
                  steps: nextSteps,
                })
              : caseItem,
          )
        : [];
      return {
        ...base,
        runId: eventMatchesCurrentCaseRun && !eventMatchesParentRun ? base.runId : event.runId || base.runId,
        status: "running",
        currentCaseId: activeCaseId || base.currentCaseId,
        currentStepIndex: null,
        error: null,
        result: null,
        startedAt: event.startedAt || Date.now(),
        finishedAt: null,
        lastEvent: event,
        runContext: event.runContext || base.runContext || null,
        cases: nextCases,
        steps: nextSteps,
        ...getRuntimeVariableEventPatch(base, runtimeVariableEvent),
      };
    }
    case "step-start": {
      const activeStep = activeCase?.steps?.[resolvedStepIndex] || null;
      const activePhase = event.phase || activeStep?.phase || "case";
      const nextProgress = updateStep(
        {
          ...base,
          runId: eventMatchesCurrentCaseRun && !eventMatchesParentRun ? base.runId : event.runId || base.runId,
          status: "running",
          currentCaseId: isRootChildEvent ? null : activeCaseId || base.currentCaseId,
          currentStepIndex: resolvedStepIndex ?? base.currentStepIndex,
          lastEvent: event,
          ...getRuntimeVariableEventPatch(base, runtimeVariableEvent),
        },
        resolvedStepIndex,
        (step) => ({
          ...step,
          phase: event.phase || step.phase,
          status: "running",
          message: event.message || "Running step...",
          error: null,
        }),
        isRootChildEvent ? null : activeCaseId,
      );
      if (activePhase === "case") {
        return setCaseStatus(nextProgress, activeCaseId, "running");
      }
      const nextActiveCase = nextProgress.cases?.find((caseItem) => caseItem.caseId === activeCaseId) || null;
      return hasStartedCasePhase(nextActiveCase) ? nextProgress : setCaseStatus(nextProgress, activeCaseId, "pending");
    }
    case "step-complete": {
      const stepStatus = getCompletedStepStatus(event);
      return updateStep(
        {
          ...base,
          runId: eventMatchesCurrentCaseRun && !eventMatchesParentRun ? base.runId : event.runId || base.runId,
          status: stepStatus === "failed" ? "failed" : base.status,
          currentCaseId: isRootChildEvent ? null : activeCaseId || base.currentCaseId,
          currentStepIndex: resolvedStepIndex ?? base.currentStepIndex,
          error: stepStatus === "failed" ? event.error || event.result?.error || null : base.error,
          lastEvent: event,
          ...getRuntimeVariableEventPatch(base, runtimeVariableEvent),
        },
        resolvedStepIndex,
        (step) => ({
          ...step,
          phase: event.phase || step.phase,
          status: stepStatus,
          message: event.message || "",
          error: stepStatus === "failed" ? event.error || event.result?.error || null : null,
          durationMs: event.durationMs ?? null,
          evidence: event.evidence ?? null,
          diagnostics: event.diagnostics ?? null,
        }),
        isRootChildEvent ? null : activeCaseId,
      );
    }
    // v1.4: the browser died mid-run (OOM) or is approaching the memory cliff.
    // Keep it on the progress object so the run panel can say "the browser
    // crashed" instead of leaving the reader to infer it from a wall of failed
    // steps. `run-wedged` lands here too — it used to be dropped silently.
    case "browser-crashed":
    case "browser-memory-warning":
    case "run-wedged":
      return {
        ...base,
        lastEvent: event,
        browserHealth: {
          type: event.type,
          code: event.code || event.reason || null,
          crashKind: event.crashKind || null,
          message: event.message || null,
          heapUsedMb: event.heapUsedMb ?? null,
          peakHeapUsedMb: event.peakHeapUsedMb ?? null,
          at: event.at || Date.now(),
        },
      };
    case "run-complete":
      if (eventMatchesCurrentCaseRun && !eventMatchesParentRun) {
        return {
          ...base,
          lastEvent: event,
          ...getRuntimeVariableEventPatch(base, runtimeVariableEvent),
        };
      }
      const finalizedSteps = finalizeRunningSteps(base.steps, event);
      const finalizedCases = Array.isArray(base.cases)
        ? base.cases.map((caseItem) => {
            if (caseItem.status === "running" || caseItem.caseId === base.currentCaseId) {
              const nextSteps = caseItem.caseId === base.currentCaseId
                ? finalizedSteps
                : finalizeRunningSteps(caseItem.steps, event);
              const nextStatus = deriveCompletedCaseStatus({ ...caseItem, steps: nextSteps }, event);
              return syncCaseCounters({
                ...caseItem,
                status: nextStatus,
                steps: nextSteps,
                error: event.error || caseItem.error,
                result: slimResultForProgress(event.result) || caseItem.result,
                finishedAt: event.finishedAt || Date.now(),
              });
            }
            return caseItem;
          })
        : [];
      const currentCase = finalizedCases.find((caseItem) => caseItem.caseId === base.currentCaseId);
      return {
        ...base,
        runId: event.runId || base.runId,
        status: event.status || (event.result?.ok ? "success" : "failed"),
        currentCaseRunId: null,
        currentStepIndex:
          typeof base.currentStepIndex === "number"
            ? base.currentStepIndex
            : base.steps.length
              ? base.steps.length - 1
              : null,
        error: event.error || null,
        result: slimResultForProgress(event.result),
        finishedAt: event.finishedAt || Date.now(),
        lastEvent: event,
        runContext: event.runContext || event.result?.runContext || base.runContext || null,
        cases: finalizedCases,
        steps: currentCase?.steps || finalizedSteps,
        ...getRuntimeVariableEventPatch(base, runtimeVariableEvent),
      };
    default:
      return {
        ...base,
        lastEvent: event,
      };
  }
}
