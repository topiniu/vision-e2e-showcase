function safeJson(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function previewValue(value, maxLength = 1200) {
  const text = safeJson(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactValue(value) {
  if (value == null || value === "") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return previewValue(value, 420);
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "") ?? null;
}

function normalizeEvidence(step, executionState, trace) {
  return {
    ...(step?.evidence || {}),
    ...(executionState?.evidence || {}),
    beforeScreenshotPath: firstValue(
      executionState?.evidence?.beforeScreenshotPath,
      step?.evidence?.beforeScreenshotPath,
      step?.raw?.data?.evidence?.beforeScreenshotPath,
      step?.raw?.evidence?.beforeScreenshotPath,
      trace?.beforeScreenshotPath,
    ),
    afterScreenshotPath: firstValue(
      executionState?.evidence?.afterScreenshotPath,
      step?.evidence?.afterScreenshotPath,
      step?.raw?.data?.evidence?.afterScreenshotPath,
      step?.raw?.evidence?.afterScreenshotPath,
      trace?.afterScreenshotPath,
    ),
    ocrPath: firstValue(
      executionState?.evidence?.ocrPath,
      step?.evidence?.ocrPath,
      step?.raw?.data?.evidence?.ocrPath,
      step?.raw?.evidence?.ocrPath,
      trace?.ocrPath,
    ),
    tracePath: firstValue(
      executionState?.evidence?.tracePath,
      step?.evidence?.tracePath,
      step?.raw?.data?.evidence?.tracePath,
      step?.raw?.evidence?.tracePath,
      step?.raw?.tracePath,
    ),
  };
}

function normalizeResponse(response) {
  if (!response) {
    return null;
  }
  return {
    url: response.url || "",
    method: response.method || "",
    status: response.status ?? "",
    headers: response.headers || null,
    body: response.body ?? response.bodyPreview ?? null,
    bodyPreview: response.bodyPreview || previewValue(response.body, 1200),
  };
}

function normalizeRequest(request, requestInput) {
  if (!request && !requestInput) {
    return null;
  }
  return {
    url: firstValue(request?.url, requestInput?.url, ""),
    inputUrl: requestInput?.url || "",
    method: firstValue(request?.method, requestInput?.method, ""),
    headers: request?.headers || requestInput?.headers || null,
    hasBody: request?.hasBody ?? requestInput?.body != null,
    body: requestInput?.body ?? request?.body ?? null,
  };
}

function normalizeExpectation(expectation) {
  if (!expectation) {
    return null;
  }
  const failedChild = Array.isArray(expectation.results)
    ? expectation.results.find((item) => item && item.ok === false) || expectation.results[0]
    : null;
  return {
    ...expectation,
    type: expectation.type || expectation.kind || "",
    failedChild: failedChild ? normalizeExpectation(failedChild) : null,
    response: normalizeResponse(expectation.response),
  };
}

function buildRows(items) {
  return items
    .map(([label, value, options = {}]) => ({
      label,
      value,
      danger: Boolean(options.danger),
      code: Boolean(options.code),
      json: Boolean(options.json),
      rawValue: options.rawValue,
    }))
    .filter((item) => item.value != null && item.value !== "");
}

function buildExpectationRows(expectation) {
  if (!expectation) {
    return [];
  }
  const effective = expectation.failedChild || expectation;
  const failures = Array.isArray(effective.failures) ? effective.failures : [];
  return buildRows([
    ["Type", effective.type],
    ["Status", effective.ok ? "passed" : "failed", { danger: !effective.ok }],
    ["Error", effective.error, { danger: true }],
    ["Property", effective.property],
    ["Operator", effective.operator],
    ["Expected", compactValue(effective.expected), { code: typeof effective.expected === "object", json: typeof effective.expected === "object", rawValue: effective.expected }],
    ["Actual", compactValue(effective.actual), { code: typeof effective.actual === "object", json: typeof effective.actual === "object", rawValue: effective.actual }],
    ["Missing", Array.isArray(effective.missing) ? effective.missing.join(", ") : ""],
    ["Present", Array.isArray(effective.present) ? effective.present.join(", ") : ""],
    ["Matched", Array.isArray(effective.matched) ? effective.matched.join(", ") : ""],
    ["Observed count", effective.observedCount],
    ["Failures", failures.length ? previewValue(failures, 1000) : "", { danger: true, code: true, json: true, rawValue: failures }],
  ]);
}

function buildResponseRows(response) {
  const normalized = normalizeResponse(response);
  if (!normalized) {
    return [];
  }
  return buildRows([
    ["Method", normalized.method],
    ["Status", normalized.status],
    ["URL", normalized.url],
    ["Headers", normalized.headers ? previewValue(normalized.headers, 800) : "", { code: true, json: true, rawValue: normalized.headers }],
    ["Body preview", normalized.bodyPreview, { code: true, json: typeof normalized.body === "object", rawValue: normalized.body }],
  ]);
}

function buildPopupRows(popupTrace) {
  if (!popupTrace) {
    return [];
  }
  const optionWait = popupTrace.optionWait || {};
  return buildRows([
    ["Opened by", popupTrace.openedBy],
    ["Open duration", popupTrace.openDurationMs != null ? `${popupTrace.openDurationMs} ms` : ""],
    ["Query", popupTrace.query],
    ["Query input", compactValue(popupTrace.queryInput), { code: typeof popupTrace.queryInput === "object", json: typeof popupTrace.queryInput === "object", rawValue: popupTrace.queryInput }],
    ["Option", compactValue(popupTrace.option), { code: typeof popupTrace.option === "object", json: typeof popupTrace.option === "object", rawValue: popupTrace.option }],
    ["Selected", compactValue(popupTrace.selected), { code: typeof popupTrace.selected === "object", json: typeof popupTrace.selected === "object", rawValue: popupTrace.selected }],
    ["Cascader path", Array.isArray(popupTrace.cascaderPath) ? popupTrace.cascaderPath.join(" / ") : ""],
    ["Clicked", Array.isArray(popupTrace.clicked) ? previewValue(popupTrace.clicked, 900) : "", { code: true, json: Array.isArray(popupTrace.clicked), rawValue: popupTrace.clicked }],
    ["Expansion probes", Array.isArray(popupTrace.expansionProbes) ? previewValue(popupTrace.expansionProbes, 900) : "", { code: true, json: Array.isArray(popupTrace.expansionProbes), rawValue: popupTrace.expansionProbes }],
    ["Wait attempts", optionWait.attempts],
    ["Wait duration", optionWait.durationMs != null ? `${optionWait.durationMs} ms` : ""],
    ["Click mode", popupTrace.optionClick],
  ]);
}

function compactExecutionPath(executionPath) {
  if (!executionPath) {
    return "";
  }
  if (executionPath.summary) {
    return executionPath.summary;
  }
  return [
    executionPath.target?.strategy || executionPath.target?.source,
    executionPath.action,
    executionPath.popupOpen ? `open:${executionPath.popupOpen}` : "",
    executionPath.optionResolve ? `option:${executionPath.optionResolve}` : "",
    executionPath.optionClick ? `click:${executionPath.optionClick}` : executionPath.actionDetail,
  ].filter(Boolean).join(" -> ");
}

function buildArtifactRows(inputArtifacts) {
  if (!inputArtifacts) {
    return [];
  }
  const files = Array.isArray(inputArtifacts.files) ? inputArtifacts.files : [];
  return buildRows([
    ["Mode", inputArtifacts.mode],
    ["Files", files.length ? files.map((file) => `${file.path || file.name || "file"}${file.size ? ` (${file.size} bytes)` : ""}`).join("\n") : ""],
  ]);
}

function normalizeRuntimeVariables(...sources) {
  const source = sources.find((item) => item && typeof item === "object" && !Array.isArray(item));
  return source || null;
}

function buildRuntimeVariableRows(runtimeVariables) {
  if (!runtimeVariables || typeof runtimeVariables !== "object") {
    return [];
  }
  return Object.entries(runtimeVariables)
    .filter(([key]) => key)
    .map(([key, value]) => [
      key,
      compactValue(value),
      { code: true, json: value != null && typeof value === "object", rawValue: value },
    ]);
}

function createStepExecutionDetail({ step = null, executionState = null, trace = null } = {}) {
  const diagnostics = executionState?.diagnostics || step?.diagnostics || null;
  const rawData = step?.raw?.data || {};
  const retry = diagnostics?.retry || rawData.retry || step?.retry || null;
  const actionResult = trace?.actionResult || diagnostics?.action || rawData.action || {};
  const requestInput = trace?.input?.request || step?.raw?.input?.request || rawData.input?.request || null;
  const action = {
    kind: firstValue(trace?.normalizedAction?.kind, step?.type, executionState?.type, step?.raw?.type),
    query: firstValue(trace?.normalizedAction?.query, step?.query, executionState?.query, step?.raw?.input?.query),
    key: trace?.normalizedAction?.key || step?.raw?.input?.key || "",
    count: trace?.normalizedAction?.count ?? step?.raw?.input?.count ?? null,
    operator: trace?.normalizedAction?.operator || step?.raw?.input?.operator || "",
    visibleOnly: trace?.normalizedAction?.visibleOnly ?? step?.raw?.input?.visibleOnly ?? null,
    target: trace?.normalizedTarget || step?.raw?.input?.target || null,
    request: normalizeRequest(trace?.apiRequest || actionResult.apiRequest || rawData.action?.apiRequest || null, requestInput),
    requestInput,
    response: normalizeResponse(trace?.apiResponse || actionResult.apiResponse || rawData.action?.apiResponse),
    detail: actionResult.detail || rawData.action?.detail || "",
    success: actionResult.success ?? rawData.action?.success ?? null,
    error: actionResult.error || rawData.action?.error || "",
    inputArtifacts: trace?.inputArtifacts || actionResult.inputArtifacts || rawData.action?.inputArtifacts || null,
    popupTrace: trace?.popupTrace || actionResult.popupTrace || rawData.action?.popupTrace || null,
  };
  const expectation = normalizeExpectation(trace?.expectation || diagnostics?.expectation || rawData.expectation || null);
  const resolution = trace
    ? {
        strategy: trace.selectedLocatorStrategy,
        candidate: trace.selectedCandidate,
        pipeline: trace.resolverPipeline,
        candidates: trace.candidateListTopN,
      }
    : diagnostics?.resolution || rawData.resolution || null;
  const navigation = trace?.navigation || actionResult.navigation || rawData.action?.navigation || null;
  const executionPath = trace?.executionPath || diagnostics?.executionPath || rawData.executionPath || null;
  const change = trace?.diffResult || diagnostics?.change || rawData.change || null;
  const evidence = normalizeEvidence(step, executionState, trace);
  const status = firstValue(executionState?.status, step?.status, trace?.finalStatus, step?.raw?.ok === false ? "failed" : step?.raw?.ok ? "passed" : null, "pending");
  const error = executionState?.error || step?.error || step?.raw?.error || null;
  const runtimeVariables = normalizeRuntimeVariables(
    trace?.runtimeVariables,
    executionState?.runtimeVariables,
    step?.runtimeVariables,
    step?.raw?.runtimeVariables,
    rawData.runtimeVariables,
  );
  const warnings = [
    trace?.stabilityRisk ? `Stability risk: ${trace.stabilityRisk}` : "",
    trace?.errorClassification ? `Error classification: ${trace.errorClassification}` : "",
    action.error ? `Action error: ${action.error}` : "",
  ].filter(Boolean);

  return {
    title: firstValue(step?.title, executionState?.title, action.query, action.kind, "Step"),
    status,
    type: action.kind || "runtime step",
    phase: firstValue(executionState?.phase, step?.phase, step?.raw?.input?.phase, "case"),
    sourceFixture: firstValue(executionState?.sourceFixture, step?.sourceFixture, step?.raw?.input?.sourceFixture, ""),
    sourceMacro: firstValue(executionState?.sourceMacro, step?.sourceMacro, step?.raw?.input?.sourceMacro, ""),
    durationMs: firstValue(executionState?.durationMs, step?.durationMs, trace?.durationMs, rawData.trace?.durationMs),
    message: firstValue(executionState?.message, step?.message, ""),
    errorMessage: error?.message || "",
    errorCode: error?.code || trace?.errorClassification || "",
    action,
    expectation,
    resolution,
    executionPath,
    navigation,
    change,
    domSummary: trace?.domSummary || null,
    runtimeVariables,
    retry,
    artifacts: evidence,
    warnings,
    trace,
    rows: {
      overview: buildRows([
        ["Status", status],
        ["Type", action.kind],
        ["Phase", firstValue(executionState?.phase, step?.phase, step?.raw?.input?.phase, "case")],
        ["Duration", firstValue(executionState?.durationMs, step?.durationMs, trace?.durationMs, rawData.trace?.durationMs) != null ? `${firstValue(executionState?.durationMs, step?.durationMs, trace?.durationMs, rawData.trace?.durationMs)} ms` : ""],
        ["Attempts", retry?.attempts],
        ["Retry delay", retry?.retryDelayTotalMs != null ? `${retry.retryDelayTotalMs} ms` : ""],
        ["Retry wall duration", retry?.wallDurationMs != null ? `${retry.wallDurationMs} ms` : ""],
        ["Message", firstValue(executionState?.message, step?.message, "")],
        ["Failure", error?.message || "", { danger: true }],
        ["Classification", trace?.errorClassification || error?.code || ""],
      ]),
      action: buildRows([
        ["Query", action.query],
        ["Detail", action.detail],
        ["Success", action.success == null ? "" : action.success ? "true" : "false", { danger: action.success === false }],
        ["Error", action.error, { danger: true }],
        ["Execution path", compactExecutionPath(executionPath), { code: true }],
        ["Target", action.target ? previewValue(action.target, 900) : "", { code: true, json: true, rawValue: action.target }],
        ["Locator strategy", resolution?.strategy || resolution?.source || ""],
        ["Selected candidate", resolution?.candidate ? previewValue(resolution.candidate, 900) : "", { code: true, json: true, rawValue: resolution?.candidate }],
        ["Stability risk", trace?.stabilityRisk || ""],
      ]),
      result: buildRows([
        ["Before URL", trace?.domSummary?.before?.url || rawData.snapshot?.before?.url],
        ["After URL", trace?.domSummary?.after?.url || rawData.snapshot?.after?.url],
        ["Navigation", navigation ? `${navigation.observed ? "observed" : "not observed"}${navigation.matchedTarget ? " · target matched" : ""}` : ""],
        ["Final URL", navigation?.finalUrl],
        ["Page diff", change ? `${change.changed ? "changed" : "unchanged"}${change.ratio != null ? ` · ratio ${change.ratio}` : ""}` : ""],
      ]),
      expectation: buildExpectationRows(expectation),
      request: buildRows([
        ["Method", action.request?.method],
        ["URL", action.request?.url],
        ["Headers", action.request?.headers ? previewValue(action.request.headers, 800) : "", { code: true, json: true, rawValue: action.request?.headers }],
        ["Has body", action.request?.hasBody == null ? "" : action.request.hasBody ? "true" : "false"],
        ["Body", action.request?.body != null ? previewValue(action.request.body, 1000) : "", { code: true, json: typeof action.request?.body === "object", rawValue: action.request?.body }],
      ]),
      response: buildResponseRows(action.response || expectation?.response),
      popup: buildPopupRows(action.popupTrace),
      artifacts: buildArtifactRows(action.inputArtifacts),
      runtimeVariables: buildRows(buildRuntimeVariableRows(runtimeVariables)),
      paths: buildRows([
        ["Trace", evidence.tracePath],
        ["OCR", evidence.ocrPath],
        ["Before", evidence.beforeScreenshotPath],
        ["After", evidence.afterScreenshotPath],
        ["Attempt traces", Array.isArray(evidence.attempts) ? evidence.attempts.map((item) => item?.tracePath).filter(Boolean).join("\n") : ""],
      ]),
    },
  };
}

export {
  safeJson,
  previewValue,
  createStepExecutionDetail,
};
