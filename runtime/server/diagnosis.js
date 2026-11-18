const fs = require("node:fs/promises");
const path = require("node:path");

const SENSITIVE_KEY_PATTERN = /authorization|cookie|set-cookie|token|accessToken|refreshToken|secret|password|apiKey|x-csrf-token|x-xsrf-token|phone|email|idCard|address/i;
const BODY_SUMMARY_MAX_BYTES = 12000;
const BODY_PATH_MAX_DEPTH = 6;
const NEARBY_PATHS_LIMIT = 20;

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

function redactString(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b1[3-9]\d{9}\b/g, "[redacted-phone]")
    .replace(/\b\d{15}(?:\d{2}[0-9Xx])?\b/g, "[redacted-id]");
}

function sanitizeValue(value, key = "", depth = 0) {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (depth > BODY_PATH_MAX_DEPTH) {
    return "[truncated-depth]";
  }
  if (typeof value === "string") {
    const text = redactString(value);
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item, index) => sanitizeValue(item, String(index), depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 80).map(([childKey, item]) => [childKey, sanitizeValue(item, childKey, depth + 1)]),
    );
  }
  return value;
}

function flattenBodyPaths(value, prefix = "", depth = 0, output = []) {
  if (output.length >= NEARBY_PATHS_LIMIT || depth > BODY_PATH_MAX_DEPTH || value == null || typeof value !== "object") {
    return output;
  }
  Object.entries(value).forEach(([key, item]) => {
    if (output.length >= NEARBY_PATHS_LIMIT) {
      return;
    }
    const nextPath = prefix ? `${prefix}.${key}` : key;
    output.push(nextPath);
    flattenBodyPaths(item, nextPath, depth + 1, output);
  });
  return output;
}

function summarizeBody(body) {
  if (body == null) {
    return null;
  }
  const sanitized = sanitizeValue(body);
  const raw = JSON.stringify(sanitized);
  return {
    truncated: raw.length > BODY_SUMMARY_MAX_BYTES,
    summary: raw.length > BODY_SUMMARY_MAX_BYTES ? `${raw.slice(0, BODY_SUMMARY_MAX_BYTES)}...` : sanitized,
    nearbyPaths: flattenBodyPaths(body),
  };
}

function getResultSteps(result = {}) {
  if (Array.isArray(result?.data?.results)) {
    return result.data.results;
  }
  if (Array.isArray(result?.summary?.data?.results)) {
    return result.summary.data.results;
  }
  return [];
}

function findFailedStep(value = {}, caseMeta = {}) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.rootSetupResult) {
    const found = findFailedStep(value.rootSetupResult, { ...caseMeta, phase: "root-setup" });
    if (found) {
      return found;
    }
  }
  const caseResults = Array.isArray(value.caseResults) ? value.caseResults : [];
  for (const caseResult of caseResults) {
    const found = findFailedStep(caseResult?.result || caseResult, {
      caseId: caseResult?.caseId,
      caseName: caseResult?.caseName,
      priority: caseResult?.priority,
    });
    if (found) {
      return found;
    }
  }
  if (value.rootTeardownResult) {
    const found = findFailedStep(value.rootTeardownResult, { ...caseMeta, phase: "root-teardown" });
    if (found) {
      return found;
    }
  }
  for (const step of getResultSteps(value)) {
    if (step?.ok === false || step?.status === "failed") {
      return { step, caseMeta };
    }
  }
  if (value.ok === false && (value.error || value.evidence || value.input)) {
    return { step: value, caseMeta };
  }
  return null;
}

function getStepInput(step = {}) {
  return step.input || step.raw?.input || step.data?.normalizedAction || step.raw?.data?.normalizedAction || {};
}

function getStepTitle(step = {}) {
  const input = getStepInput(step);
  return (
    input.stepTitle ||
    input.title ||
    input.name ||
    input.id ||
    step.stepTitle ||
    step.title ||
    step.id ||
    "Runtime step"
  );
}

function getActionType(step = {}) {
  const input = getStepInput(step);
  return input.type || input.kind || step.type || step.kind || "run";
}

function getExpectation(step = {}) {
  return (
    step.error?.details?.expectation ||
    step.data?.expectation ||
    step.raw?.data?.expectation ||
    step.result?.data?.expectation ||
    null
  );
}

function getResponse(step = {}) {
  return (
    step.data?.action?.apiResponse ||
    step.data?.expectation?.response ||
    step.error?.details?.expectation?.response ||
    step.raw?.data?.action?.apiResponse ||
    step.raw?.data?.expectation?.response ||
    null
  );
}

function getError(step = {}) {
  return step.error || step.data?.action?.error || step.data?.expectation?.error || step.result?.error || null;
}

function getEvidence(step = {}) {
  const evidence = step.evidence || step.data?.evidence || step.raw?.data?.evidence || {};
  return {
    tracePath: evidence.tracePath || step.tracePath || null,
    beforeScreenshotPath: evidence.beforeScreenshotPath || step.beforeScreenshotPath || null,
    afterScreenshotPath: evidence.afterScreenshotPath || step.afterScreenshotPath || null,
    ocrPath: evidence.ocrPath || null,
    runDir: step.evidence?.runDir || null,
    reportPath: step.evidence?.reportPath || null,
  };
}

function getResolution(step = {}) {
  const resolution =
    step.data?.action?.resolution ||
    step.data?.resolution ||
    step.raw?.data?.action?.resolution ||
    step.raw?.data?.resolution ||
    step.resolution ||
    null;
  if (!resolution) {
    return null;
  }
  return sanitizeValue({
    strategy: resolution.strategy || resolution.selectedLocatorStrategy || null,
    matchedCount: resolution.locatorSummary?.count ?? resolution.matchedCount ?? null,
    triedStrategies: resolution.triedStrategies || resolution.resolverPipeline || resolution.pipeline || [],
    selectedCandidate: resolution.selectedCandidate || null,
    candidates: (resolution.candidates || resolution.candidateListTopN || []).slice(0, 10),
  });
}

function getObservedRequests(step = {}) {
  const candidates = [
    step.data?.expectation?.observedRequests,
    step.data?.expectation?.requests,
    step.error?.details?.expectation?.observedRequests,
    step.raw?.data?.expectation?.observedRequests,
    step.data?.network,
  ];
  const requests = candidates.find((item) => Array.isArray(item)) || [];
  return requests.slice(0, 20).map((request) => {
    const bodySummary = summarizeBody(request.body || request.responseBody || request.json);
    return sanitizeValue({
      method: request.method || "",
      url: request.url || "",
      status: request.status ?? null,
      matchedReason: request.matchedReason || request.reason || "",
      matchAnalysis: request.matchAnalysis || null,
      bodySummary,
    });
  });
}

function getExpectedActual(expectation = {}) {
  const failure = Array.isArray(expectation?.failures) ? expectation.failures[0] : null;
  if (failure) {
    return {
      expected: failure.expected ?? null,
      actual: failure.actual ?? null,
      field: failure.field || null,
      operator: failure.operator || null,
    };
  }
  if (Array.isArray(expectation?.missing) && expectation.missing.length) {
    return { expected: expectation.missing.join(", "), actual: "not found", field: "text", operator: "contains" };
  }
  if (Array.isArray(expectation?.present) && expectation.present.length) {
    return { expected: "absent", actual: expectation.present.join(", "), field: "text", operator: "absent" };
  }
  if (expectation?.expected != null || expectation?.actual != null) {
    return {
      expected: expectation.expected ?? null,
      actual: expectation.actual ?? null,
      field: expectation.property || null,
      operator: expectation.operator || null,
    };
  }
  return { expected: null, actual: null, field: null, operator: null };
}

function containsAuthExpiredSignal(step = {}) {
  const response = getResponse(step);
  const body = response?.body || {};
  const message = `${safeText(body.messageCn)} ${safeText(body.messageEn)} ${safeText(body.message)} ${safeText(body.code)} ${safeText(step?.data?.snapshot?.after?.url)}`.toLowerCase();
  return (
    body.code === 601 ||
    body.success === false && /no login|not login|未登录|没有登录|login/.test(message) ||
    /no login|not login|未登录|没有登录/.test(message)
  );
}

// v1.5: `fallbackError` is the run/aggregate-level error, used when no failing
// *step* exists. A session blocked before its first step (stale artifact, no
// auth profile) has all of its information at the run level, and classifying it
// as a generic `engine-error` sent readers looking for an engine bug.
function classifyFailure(step = {}, explicitType = null, fallbackError = null) {
  if (explicitType) {
    return explicitType;
  }
  const error = getError(step) || fallbackError;
  const expectation = getExpectation(step);
  const code = safeText(error?.code || error?.error || expectation?.error).toLowerCase();
  const message = safeText(error?.message || expectation?.error || error).toLowerCase();
  const actionType = getActionType(step);
  if (code === "auth-missing") {
    return "auth-missing";
  }
  if (containsAuthExpiredSignal(step)) {
    return "auth-expired";
  }
  // v1.4: the browser died of (almost certainly) out-of-memory. Checked BEFORE
  // browser-unavailable and before the timeout patterns below, because an OOM
  // crash used to be reported as `step-hard-timeout` — i.e. "your case timed
  // out" — which sends the reader off optimizing waits instead of memory.
  if (code === "browser-oom" || /target crashed|page crashed|out of memory/.test(message)) {
    return "browser-oom";
  }
  if (code === "browser-unavailable" || message.includes("failed to launch browser")) {
    return "browser-unavailable";
  }
  // v1.5 Z-A: "the page threw" is its own category and must be checked BEFORE
  // the assertion/locator patterns — the gate's message quotes the app's own
  // exception text, which frequently contains words like "expected" or the name
  // of an element and would otherwise be misfiled as an assertion failure,
  // sending the reader to fix a test that is not broken.
  if (code === "page-error" || code === "page-diagnostics-unavailable") {
    return "page-error";
  }
  // v1.5 Z-B: the environment, not the product, is the problem. Mapped to the
  // `blocked` status below so it is never counted as a failed test (which would
  // send someone debugging a case that never ran) nor as a pass.
  if (code === "stale-artifact" || code === "fingerprint-unavailable") {
    return "stale-artifact";
  }
  // v1.10 Z27: the caller's run target could not be used — an origin did not
  // answer, or the named credential does not exist. Nothing was tested.
  if (code === "target-unreachable" || code === "target-credential-missing") {
    return "target-unavailable";
  }
  if (/navigation.*timeout|timeout.*navigation|net::err|waiting for .* failed/.test(message)) {
    return "navigation-timeout";
  }
  if (code.includes("target-not-found") || code.includes("low-confidence-target") || message.includes("target-not-found")) {
    return "locator-not-found";
  }
  if (actionType === "callApi" || expectation?.type === "expectResponse" || expectation?.type === "expectNetworkResponse") {
    return "api-failed";
  }
  if (code.includes("expectation") || expectation?.ok === false || message.includes("expected")) {
    return "assertion-false";
  }
  return "engine-error";
}

function buildFixHints(failureType) {
  switch (failureType) {
    case "auth-missing":
      return ["Create output/auth-profiles/<profile>/storageState.json before running this test session."];
    case "auth-expired":
      return ["Refresh the auth profile storageState, then rerun the session."];
    case "locator-not-found":
      return ["Prefer testId, ariaLabel, title, role+name, or target.scope for this step target."];
    case "assertion-false":
      return ["Compare expected and actual values, then adjust the assertion or confirm the business behavior."];
    case "api-failed":
      return ["Inspect the API response body and status; add auth/session data if the response says no login."];
    case "navigation-timeout":
      return ["Use a stable destination-state assertDom/assertUrl check instead of only waiting for page change."];
    case "stale-artifact":
      return [
        "This is an ENVIRONMENT problem, not a test or product problem — the session is blocked, not failed. Do not touch the test file.",
        "The page was running an artifact that is older than declared, or byte-identical to the previous round despite a claimed code change (a dead dev-server file watcher looks exactly like this).",
        "Restart/rebuild the front-end (for umi/vite dev servers: kill the process, clear its cache dir, restart), then re-probe with get_env_fingerprint before rerunning.",
        "Check environment/fingerprint.json in the run directory for the build id that was actually served.",
      ];
    case "page-error":
      return [
        "The application itself threw an uncaught error while this case ran — this is an APP defect, not a test defect. Do not 'fix' the step.",
        "Read the quoted message and stack in the failure (full list: diagnostics/page-errors.json in the run directory) and hand it to the front-end owner.",
        "If the message is known harmless framework noise, allowlist it with settings.pageErrorAllowlist: [{match, reason}] — a reason is mandatory so muting stays auditable.",
        "To collect noise without failing runs during a transition, set settings.pageErrorPolicy to \"warn\"; the entries are still recorded either way.",
      ];
    case "browser-oom":
      return [
        "The browser ran out of memory — this is a resource problem, not a locator or assertion problem. Do not 'fix' the step.",
        "Split the case: a 60+ step chain accumulates DOM nodes, listeners and JS heap in one long-lived page.",
        "Lower concurrency (parallel visible instances / headless batch) and close other Chrome windows on the machine.",
        "Check the page itself for a leak — compare telemetry.memory.peakJsHeapUsedMb and peakNodes across steps.",
        "If the run legitimately needs more heap, raise it with ZHUZHU_BROWSER_MAX_OLD_SPACE_MB.",
      ];
    case "browser-unavailable":
      return ["Verify Playwright Chromium can launch in the current headless environment."];
    case "target-unavailable":
      return [
        "This is an ENVIRONMENT problem with the run target, not a test or product problem — the session is blocked, nothing was tested. Do not touch the test file.",
        "If an origin is unreachable: start that service (or fix the address you passed in target.origins), make sure it listens on an address this runner can reach (not only 127.0.0.1 when the runner is on another machine), then rerun.",
        "If the credential is missing: add it to .zhuzhu-credentials.json in the workspace root, or pass a credentialRef that exists.",
        "Set target.preflight to false only if the origin is deliberately not probe-able; the run then fails later and less clearly.",
      ];
    default:
      return ["Inspect the trace and attach a minimal reproduction to the runtime engine backlog."];
  }
}

function createDiagnosis(source = {}, options = {}) {
  const explicitType = options.failureType || null;
  const found = findFailedStep(source);
  const step = options.step || found?.step || {};
  const caseMeta = options.caseMeta || found?.caseMeta || {};
  const error = options.error || getError(step) || source.error || null;
  const expectation = getExpectation(step);
  const failureType = source.ok === true && !explicitType ? null : classifyFailure(step, explicitType, source.error || null);
  const expectedActual = getExpectedActual(expectation);
  const firstFailure = failureType
    ? {
        caseId: caseMeta.caseId || source.testContext?.caseId || null,
        caseName: caseMeta.caseName || source.testContext?.caseName || null,
        stepId: getStepInput(step).id || step.id || null,
        stepIndex: step.index ?? null,
        stepTitle: getStepTitle(step),
        phase: getStepInput(step).phase || step.phase || caseMeta.phase || null,
        actionType: getActionType(step),
        message: options.message || safeText(error?.message || error?.code || expectation?.error || error, "Run failed."),
        code: error?.code || expectation?.error || null,
        ...expectedActual,
        evidence: getEvidence(step),
        response: getResponse(step),
        raw: step || null,
      }
    : null;
  // v1.5 Z-B: `stale-artifact` joins `auth-missing` as an environment-class
  // failure that resolves to `blocked` — "we could not test this build" is a
  // third outcome, not a red.
  const BLOCKED_FAILURE_TYPES = ["auth-missing", "stale-artifact", "target-unavailable"];
  const status =
    source.status ||
    (source.ok === true ? "passed" : BLOCKED_FAILURE_TYPES.includes(failureType) ? "blocked" : "failed");
  return {
    schemaVersion: 2,
    generatedAt: Date.now(),
    status,
    // v1.4: `cancelled` (REQ-Z16-2) is a terminal, not-passed status — it must
    // not read as `ok: null` ("unknown") to a polling caller.
    ok: status === "passed" ? true : status === "failed" || status === "blocked" || status === "cancelled" ? false : null,
    failureType,
    firstFailure,
    expected: firstFailure?.expected ?? null,
    actual: firstFailure?.actual ?? null,
    evidence: firstFailure?.evidence || source.evidence || null,
    resolution: firstFailure ? getResolution(step) : null,
    assertion: firstFailure ? sanitizeValue({
      kind: expectationKind(expectation),
      expected: firstFailure?.expected ?? null,
      actual: firstFailure?.actual ?? null,
      field: firstFailure?.field || null,
      operator: firstFailure?.operator || null,
    }) : null,
    observedRequests: firstFailure ? getObservedRequests(step) : [],
    validateIssues: Array.isArray(options.precheck?.issues) ? options.precheck.issues.slice(0, 20) : [],
    repairContextPath: null,
    fixHints: failureType ? buildFixHints(failureType) : [],
  };
}

function expectationKind(expectation = {}) {
  return String(expectation?.kind || expectation?.mode || expectation?.type || "").trim();
}

// v1.5 Z-A: collect every page error this round produced — from the failing
// step's own attachment first (so the ones that caused the failure lead), then
// from each case run's telemetry (so errors under *passing* steps, e.g. under a
// `warn` policy, are in the repair context too). An app defect must reach the
// person reading the repair context verbatim: message + stack, not a summary.
function collectRoundPageErrors(aggregate = {}, rawStep = null) {
  const collected = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || !entry.message) {
      return;
    }
    const key = `${entry.at || ""}|${entry.kind || ""}|${entry.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    collected.push(entry);
  };
  for (const entry of rawStep?.data?.pageErrors || []) {
    push(entry);
  }
  const runs = [
    aggregate.rootSetupResult,
    ...(Array.isArray(aggregate.caseResults) ? aggregate.caseResults.map((item) => item?.result) : []),
    aggregate.rootTeardownResult,
  ].filter(Boolean);
  for (const run of runs) {
    for (const entry of run?.telemetry?.pageErrors?.entries || []) {
      if (!entry.suppressed) {
        push(entry);
      }
    }
  }
  return collected.slice(0, 30);
}

// v1.9 REQ-Z23-3: merge every case run's suggested allowlist into ONE list for
// the round, so a red file's repair context answers "what do I need to allowlist"
// completely, on the first read. Deduped by (url × origin × message) — the same
// triple the runtime clusters on — with counts summed across cases.
function collectSuggestedAllowlist(aggregate = {}) {
  const merged = new Map();
  const runs = [
    aggregate.rootSetupResult,
    ...(Array.isArray(aggregate.caseResults) ? aggregate.caseResults.map((item) => item?.result) : []),
    aggregate.rootTeardownResult,
  ].filter(Boolean);
  for (const run of runs) {
    for (const item of run?.telemetry?.pageErrors?.suggestedAllowlist || []) {
      const key = `${item.suggestedEntry?.url || ""}|${item.origin || ""}|${item.observedMessage || ""}`;
      const found = merged.get(key);
      if (found) {
        found.count += Number(item.count) || 0;
        continue;
      }
      merged.set(key, { ...item, count: Number(item.count) || 0 });
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count).slice(0, 40);
}

// v1.9 REQ-Z22-2: when the case is red but `authTrace` says login SUCCEEDED, make
// that a first-class note. This is the exact sentence the 14-hour round needed:
// the platform asserting "login is fine, go look somewhere else", rather than a
// QA having to reverse-engineer it from degenerate retry screenshots.
function authTraceNotes(authTrace) {
  if (!authTrace || typeof authTrace !== "object") {
    return [];
  }
  const notes = [];
  const recovery = authTrace.recovery || {};
  if (recovery.succeeded === true) {
    notes.push(
      "登录已成功建立（见 authTrace），本次失败与登录态无关——请去失败步骤自身找原因，不要再怀疑登录。",
    );
  }
  if (recovery.succeeded === false) {
    notes.push("登录未能建立（authTrace.recovery.succeeded=false），失败可能被登录失败完全解释——先修登录/凭据再谈别的。");
  }
  if (recovery.triggered === false && authTrace.statusBefore === "ready") {
    notes.push("开始即已登录（statusBefore=ready，未触发 recovery），本次失败与登录态无关。");
  }
  return notes;
}

function createRepairContext({ session = {}, round = {}, aggregate = {}, diagnosis = {}, precheck = null } = {}) {
  const failure = diagnosis.firstFailure || {};
  const rawStep = failure.raw || null;
  const normalizedTarget = rawStep ? getStepInput(rawStep).target || null : null;
  const pageErrors = collectRoundPageErrors(aggregate, rawStep);
  const authTrace = aggregate?.authTrace || null;
  return sanitizeValue({
    schemaVersion: 2,
    generatedAt: Date.now(),
    sessionId: session.id || aggregate.sessionId || null,
    roundId: round.id || aggregate.roundId || null,
    status: diagnosis.status,
    failureType: diagnosis.failureType,
    firstFailure: {
      caseId: failure.caseId || null,
      stepId: failure.stepId || null,
      stepTitle: failure.stepTitle || null,
      actionType: failure.actionType || null,
      message: failure.message || null,
    },
    originalStep: rawStep ? getStepInput(rawStep) : null,
    normalizedTarget,
    resolution: diagnosis.resolution || null,
    assertion: diagnosis.assertion || null,
    expected: diagnosis.expected,
    actual: diagnosis.actual,
    observedRequests: diagnosis.observedRequests || [],
    // v1.5 Z-A (facet A-1): the app's own exception text and stack, verbatim.
    pageErrors,
    // v1.9 REQ-Z23-3: all of this round's distinct noise, as paste-ready scoped
    // allowlist entries. One round, one complete list — never one per round.
    suggestedAllowlist: collectSuggestedAllowlist(aggregate),
    runtimeVariables: aggregate.runtimeVariables || aggregate.runContext?.runtimeVariables || null,
    validateIssues: Array.isArray(precheck?.issues) ? precheck.issues.slice(0, 50) : [],
    suggestedPatches: Array.isArray(precheck?.suggestedPatches) ? precheck.suggestedPatches.slice(0, 20) : [],
    evidence: diagnosis.evidence || null,
    // v1.9 REQ-Z22: the login verdict, which the caller MUST apply before
    // deciding "what went wrong". Carried verbatim in the repair context because
    // the repair context is what a person/LLM reads to decide a fix.
    authTrace,
    authNote: authTraceNotes(authTrace),
    artifactPaths: {
      aggregatePath: round.aggregatePath || null,
      diagnosisPath: round.diagnosisPath || null,
      reportPath: round.reportPath || null,
      runtimeReports: round.runtimeReports || [],
    },
  });
}

function renderMarkdownReport({ session = {}, round = {}, diagnosis = {}, precheck = null } = {}) {
  const lines = [];
  lines.push(`# Zhuzhu Headless Test Report`);
  lines.push("");
  lines.push(`- Session: ${session.id || "-"}`);
  lines.push(`- Round: ${round.id || "-"}`);
  lines.push(`- Status: ${diagnosis.status || round.status || "-"}`);
  lines.push(`- Test file: ${session.testFile?.path || session.testFile?.name || "inline"}`);
  lines.push(`- Auth profile: ${session.authProfile || "-"}`);
  lines.push("");
  if (precheck) {
    lines.push(`## Precheck`);
    lines.push(`- Errors: ${precheck.summary?.errorCount ?? 0}`);
    lines.push(`- Warnings: ${precheck.summary?.warningCount ?? 0}`);
    lines.push("");
  }
  if (diagnosis.firstFailure) {
    const failure = diagnosis.firstFailure;
    lines.push("## First Failure");
    lines.push(`- Type: ${diagnosis.failureType}`);
    lines.push(`- Case: ${failure.caseName || failure.caseId || "-"}`);
    lines.push(`- Step: ${failure.stepTitle || failure.stepId || "-"}`);
    lines.push(`- Message: ${failure.message || "-"}`);
    if (failure.field || failure.expected != null || failure.actual != null) {
      lines.push(`- Expected: ${failure.expected == null ? "-" : JSON.stringify(failure.expected)}`);
      lines.push(`- Actual: ${failure.actual == null ? "-" : JSON.stringify(failure.actual)}`);
      if (failure.field) {
        lines.push(`- Field: ${failure.field}`);
      }
    }
    lines.push("");
    lines.push("## Evidence");
    Object.entries(failure.evidence || {}).forEach(([key, value]) => {
      if (value) {
        lines.push(`- ${key}: ${value}`);
      }
    });
    lines.push("");
  } else {
    lines.push("## Result");
    lines.push(diagnosis.status === "passed" ? "All selected cases passed." : "No runtime failure details were recorded.");
    lines.push("");
  }
  if (Array.isArray(diagnosis.fixHints) && diagnosis.fixHints.length) {
    lines.push("## Suggested Next Steps");
    diagnosis.fixHints.forEach((hint) => lines.push(`- ${hint}`));
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function appendEngineFinding(filePath, finding) {
  if (!filePath || !finding?.diagnosis?.failureType) {
    return null;
  }
  if (!["engine-error", "locator-not-found"].includes(finding.diagnosis.failureType)) {
    return null;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify({ recordedAt: Date.now(), ...finding })}\n`, "utf8");
  return filePath;
}

module.exports = {
  appendEngineFinding,
  classifyFailure,
  createRepairContext,
  createDiagnosis,
  findFailedStep,
  // v1.9 REQ-Z24: the session layer needs the same "which step payload is this"
  // unwrapping to feed the reach diagnosis.
  getStepInput,
  renderMarkdownReport,
  sanitizeValue,
};
