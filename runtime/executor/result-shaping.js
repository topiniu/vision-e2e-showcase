
function buildError(code, message, details = null, retryable = false) {
  return {
    code,
    message,
    retryable,
    details,
  };
}

function formatExpectationError(expectation) {
  if (!expectation) {
    return "";
  }
  if (expectation.error === "expected-text-required") {
    return "Expected text is required.";
  }
  if (expectation.error) {
    return expectation.error;
  }
  if (expectation.type === "composite") {
    const failed = Array.isArray(expectation.results)
      ? expectation.results.find((item) => item && !item.ok)
      : null;
    return formatExpectationError(failed) || "Composite expectation was not met.";
  }
  if (Array.isArray(expectation.missing) && expectation.missing.length) {
    return `Expected text not found: ${expectation.missing.join(", ")}`;
  }
  if (Array.isArray(expectation.present) && expectation.present.length) {
    return `Unexpected text still visible: ${expectation.present.join(", ")}`;
  }
  if (expectation.type === "waitForChange") {
    return "Page did not change within timeout.";
  }
  if (expectation.type === "expectUrl" && Array.isArray(expectation.failures)) {
    return `URL expectation was not met: ${expectation.failures.map((item) => item.field).join(", ")}`;
  }
  if (expectation.type === "expectCount") {
    return `Expected ${expectation.expected} matching elements, found ${expectation.actual}.`;
  }
  if (expectation.type === "expectDom") {
    return `DOM expectation was not met: ${expectation.property || "state"}.`;
  }
  if (expectation.type === "expectResponse" || expectation.type === "expectNetworkResponse") {
    const fields = Array.isArray(expectation.failures)
      ? expectation.failures.map((item) => item.field).join(", ")
      : "";
    return `Response expectation was not met${fields ? `: ${fields}` : "."}`;
  }
  return "";
}

function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      /authorization|cookie|token|secret|password/i.test(key) ? "[redacted]" : value,
    ]),
  );
}

function previewJsonValue(value, maxLength = 2000) {
  if (value == null) {
    return null;
  }
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...` : raw;
}

function compactResponse(response) {
  if (!response) {
    return null;
  }
  return {
    url: response.url,
    method: response.method,
    status: response.status,
    headers: redactHeaders(response.headers),
    bodyPreview: previewJsonValue(response.body),
  };
}

function compactActionResult(action = {}) {
  return {
    success: Boolean(action.success),
    error: action.error ?? null,
    detail: action.detail ?? null,
    navigation: action.navigation ?? null,
    inputArtifacts: action.inputArtifacts ?? null,
    popupTrace: action.popupTrace ?? null,
    apiRequest: action.apiRequest ?? null,
    apiResponse: compactResponse(action.apiResponse),
  };
}

function compactExpectationResult(expectation) {
  if (!expectation) {
    return null;
  }
  const compact = {
    ok: Boolean(expectation.ok),
    type: expectation.type || expectation.kind || "",
    error: expectation.error || null,
  };
  [
    "property",
    "operator",
    "expected",
    "actual",
    "failures",
    "missing",
    "present",
    "matched",
    "observedCount",
    "observed",
    "target",
    "state",
    "diff",
  ].forEach((key) => {
    if (expectation[key] != null) {
      compact[key] = expectation[key];
    }
  });
  if (expectation.response) {
    compact.response = compactResponse(expectation.response);
  }
  if (Array.isArray(expectation.results)) {
    compact.results = expectation.results.map((item) => compactExpectationResult(item));
  }
  return compact;
}

function sanitizeResolution(resolution) {
  if (!resolution) {
    return null;
  }
  return {
    source: resolution.source ?? null,
    strategy: resolution.strategy ?? null,
    confidence: resolution.confidence ?? null,
    matchedText: resolution.matchedText ?? null,
    targetSummary: resolution.targetSummary ?? null,
    locatorSummary: resolution.locatorSummary ?? null,
    bbox: resolution.bbox ?? resolution.targetSummary?.bbox ?? null,
    rankedCandidates: resolution.rankedCandidates ?? [],
    attempts: resolution.attempts ?? [],
    error: resolution.error ?? null,
  };
}

function buildStepDiagnostics(result) {
  if (!result?.data) {
    return null;
  }
  const data = result.data;
  return {
    action: compactActionResult(data.action || {}),
    expectation: compactExpectationResult(data.expectation),
    resolution: sanitizeResolution(data.resolution),
    executionPath: data.executionPath ?? null,
    change: data.change
      ? {
          changed: Boolean(data.change.changed),
          ratio: data.change.ratio ?? null,
          diffPixels: data.change.diffPixels ?? null,
          threshold: data.change.threshold ?? null,
          bounds: data.change.bounds ?? null,
        }
      : null,
    retry: data.retry ?? null,
    evidence: data.evidence ?? result.evidence ?? null,
  };
}

function summarizeBatch(results) {
  const okCount = results.filter((item) => item.ok).length;
  const errorCount = results.length - okCount;
  return {
    ok: errorCount === 0,
    type: "batch",
    data: {
      results,
      count: results.length,
      okCount,
      errorCount,
    },
    error:
      errorCount > 0
        ? buildError("batch-partial-failure", "batch-partial-failure", {
            okCount,
            errorCount,
          })
        : null,
  };
}

function createSkippedResult(action, reason) {
  return {
    ok: true,
    skipped: true,
    type: action.kind,
    data: {
      action: {
        success: true,
        error: null,
        detail: reason,
        navigation: null,
        inputArtifacts: null,
        popupTrace: null,
        apiRequest: null,
        apiResponse: null,
      },
      resolution: null,
      snapshot: null,
      expectation: null,
      retry: {
        attempts: 0,
        retries: 0,
      },
    },
    error: null,
    telemetry: {
      durationMs: 0,
    },
    evidence: null,
  };
}

function createStoppedResult(action, reason) {
  return {
    ok: true,
    skipped: true,
    stopped: true,
    type: action.kind,
    data: {
      action: {
        success: true,
        error: null,
        detail: reason,
        navigation: null,
        inputArtifacts: null,
        popupTrace: null,
        apiRequest: null,
        apiResponse: null,
      },
      resolution: null,
      snapshot: null,
      expectation: null,
      retry: {
        attempts: 0,
        retries: 0,
      },
    },
    error: null,
    telemetry: {
      durationMs: 0,
    },
    evidence: null,
  };
}

module.exports = {
  buildError,
  formatExpectationError,
  redactHeaders,
  compactActionResult,
  compactExpectationResult,
  sanitizeResolution,
  buildStepDiagnostics,
  summarizeBatch,
  createSkippedResult,
  createStoppedResult,
};
