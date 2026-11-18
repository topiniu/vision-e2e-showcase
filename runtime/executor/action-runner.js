const { computeImageDiff } = require('../perception/image-diff');
const { resolveActionTarget } = require('./locator-resolver');
const { assertResponseShape } = require('../assertions');
const { setRuntimeVariable } = require('../protocol/runtime-vars');
const { executeDomAction } = require('./action-handlers');
const {
  invalidateUiFrameworkCache,
  observeNavigationAfterAction,
  safeCapturePageSnapshot,
  safeCapturePageState,
  safeDetectUiFrameworks,
  readPageReadiness,
  safeRunExpectation,
  settlePageBeforeAction,
} = require('./navigation-recovery');
const { buildError, compactActionResult, formatExpectationError, redactHeaders, sanitizeResolution } = require('./result-shaping');

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findWaitForChangeExpectation(expectation) {
  if (!expectation) {
    return null;
  }
  if (expectation.kind === "waitForChange" || expectation.type === "waitForChange") {
    return expectation;
  }
  if (expectation.kind === "composite" || expectation.type === "composite") {
    const assertions = Array.isArray(expectation.assertions) ? expectation.assertions : [];
    for (const assertion of assertions) {
      const found = findWaitForChangeExpectation(assertion);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function expectationIncludesKind(expectation, kinds) {
  if (!expectation) {
    return false;
  }
  const kind = expectation.kind || expectation.type;
  if (kinds.includes(kind)) {
    return true;
  }
  return Array.isArray(expectation.assertions)
    ? expectation.assertions.some((item) => expectationIncludesKind(item, kinds))
    : false;
}

function buildExecutionPath(action, resolution, actionResult, stabilityRisk) {
  const popupTrace = actionResult?.popupTrace || null;
  const targetSource = resolution?.source || (resolution?.strategy ? "dom" : null);
  const optionFallback = popupTrace?.optionScope?.includes("visible-fallback")
    ? "visible-option-fallback"
    : null;
  const fallback =
    resolution?.source === "ocr"
      ? "ocr"
      : String(actionResult?.detail || "").startsWith("bbox-") || String(resolution?.strategy || "").includes("bbox")
        ? "coordinate"
        : optionFallback;
  const segments = [];
  if (resolution?.strategy) {
    segments.push(`${targetSource || "target"}:${resolution.strategy}`);
  }
  if (action?.kind) {
    segments.push(action.kind);
  }
  if (popupTrace?.openedBy) {
    segments.push(`open:${popupTrace.openedBy}`);
  }
  if (popupTrace?.optionScope) {
    segments.push(`option:${popupTrace.optionScope}`);
  }
  if (popupTrace?.optionClick) {
    segments.push(`click:${popupTrace.optionClick}`);
  } else if (actionResult?.detail) {
    segments.push(`perform:${actionResult.detail}`);
  }

  return {
    target: resolution
      ? {
          source: targetSource,
          strategy: resolution.strategy ?? null,
          confidence: resolution.confidence ?? null,
          matchedText: resolution.matchedText ?? null,
        }
      : null,
    action: action?.kind || null,
    actionDetail: actionResult?.detail || null,
    actionError: actionResult?.error || null,
    popupOpen: popupTrace?.openedBy || null,
    optionResolve: popupTrace?.optionScope || null,
    optionClick: popupTrace?.optionClick || null,
    selectedRead: popupTrace?.selected || null,
    fallback,
    risk: stabilityRisk || null,
    summary: segments.join(" -> "),
  };
}

async function summarizeApiResponse(response, requestMeta = {}) {
  const headers = typeof response.headers === "function"
    ? await response.headers()
    : response.headers?.() || response.headers || {};
  const rawText = typeof response.text === "function" ? await response.text() : "";
  // A response without a `content-length` can still be huge; cap it here so the
  // pre-read filter is not the only bound.
  const oversized = rawText.length > NETWORK_BODY_MAX_BYTES;
  const text = oversized ? rawText.slice(0, NETWORK_BODY_MAX_BYTES) : rawText;
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    body = text;
  }
  return {
    url: typeof response.url === "function" ? response.url() : response.url || requestMeta.url,
    method: requestMeta.method || "",
    status: typeof response.status === "function" ? response.status() : response.status,
    headers,
    body,
    bodyText: typeof body === "string" ? body : text,
    ...(oversized ? { bodyTruncated: true, bodyBytes: rawText.length } : {}),
  };
}

// v1.8 perf: bounds on the response collector.
//
// It used to call `response.text()` on EVERY response the page produced — JS
// chunks, fonts, images included — and keep every body in an unbounded array
// for the whole step. One route change on a real front-end pulls several MB of
// chunks, so a step with a `networkResponse` expectation could hold tens of MB
// of strings that no assertion could ever match.
const NETWORK_BODY_MAX_BYTES = Math.max(
  1024,
  Number(process.env.ZHUZHU_NETWORK_BODY_MAX_BYTES || 512 * 1024),
);
const NETWORK_ENTRY_LIMIT = Math.max(
  10,
  Number(process.env.ZHUZHU_NETWORK_ENTRY_LIMIT || 200),
);

// Only textual API-shaped responses can satisfy a response-shape assertion, so
// only those get their body read. Everything else is still recorded (url,
// method, status) — the assertion can still see that the request happened.
function shouldReadResponseBody(response) {
  try {
    const headers = typeof response.headers === "function" ? response.headers() : response.headers || {};
    const contentType = String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
    if (contentType && !/json|text|xml|javascript|x-www-form-urlencoded/.test(contentType)) {
      return { read: false, reason: "non-textual-content-type", contentType };
    }
    const declaredLength = Number(headers["content-length"] || headers["Content-Length"]);
    if (Number.isFinite(declaredLength) && declaredLength > NETWORK_BODY_MAX_BYTES) {
      return { read: false, reason: "body-too-large", contentType, declaredLength };
    }
    return { read: true, contentType };
  } catch (_error) {
    // Header access can throw on a response whose request was aborted; treat it
    // as "read it" so behaviour degrades toward the old, more permissive path.
    return { read: true };
  }
}

function createNetworkCollector(page) {
  const entries = [];
  const pending = new Set();
  let skipped = 0;
  const push = (summary) => {
    entries.push(summary);
    // Ring behaviour: an unbounded array is what made a chatty page expensive.
    if (entries.length > NETWORK_ENTRY_LIMIT) {
      entries.splice(0, entries.length - NETWORK_ENTRY_LIMIT);
    }
  };
  const listener = (response) => {
    const decision = shouldReadResponseBody(response);
    if (!decision.read) {
      skipped += 1;
      const request = response.request?.();
      push({
        url: response.url?.(),
        method: request?.method?.() || "",
        status: response.status?.(),
        headers: {},
        body: null,
        bodyText: "",
        bodySkipped: decision.reason,
      });
      return;
    }
    const promise = (async () => {
      const request = response.request?.();
      const summary = await summarizeApiResponse(response, {
        method: request?.method?.() || "",
        url: response.url?.(),
      });
      push(summary);
      return summary;
    })().catch((error) => {
      const request = response.request?.();
      const summary = {
        url: response.url?.(),
        method: request?.method?.() || "",
        status: response.status?.(),
        headers: {},
        body: null,
        error: error?.message || String(error),
      };
      push(summary);
      return summary;
    }).finally(() => {
      pending.delete(promise);
    });
    pending.add(promise);
  };
  page.on("response", listener);
  const flush = async () => {
    if (pending.size) {
      await Promise.allSettled([...pending]);
    }
  };
  return {
    // Exposed so a failing expectation can say "200 responses seen, 47 bodies
    // skipped as non-textual" rather than leaving the author guessing.
    stats() {
      return { retained: entries.length, bodiesSkipped: skipped };
    },
    dispose() {
      page.off("response", listener);
      // Releasing the bodies matters as much as removing the listener: the step
      // result keeps only the matched entry, so holding the rest until GC is
      // pure retention.
      entries.length = 0;
      pending.clear();
    },
    async waitForNetworkResponse(expectation = {}) {
      const timeoutMs = expectation.timeoutMs ?? 4000;
      const intervalMs = expectation.intervalMs ?? 250;
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        await flush();
        for (const entry of entries) {
          const result = assertResponseShape(entry, expectation);
          if (result.ok) {
            return {
              ok: true,
              type: "expectNetworkResponse",
              response: {
                url: entry.url,
                method: entry.method,
                status: entry.status,
                headers: redactHeaders(entry.headers),
                body: entry.body,
              },
              failures: [],
              captures: result.captures || [],
              observedCount: entries.length,
            };
          }
        }
        await page.waitForTimeout(intervalMs);
      }
      await flush();
      const last = entries.at(-1) || null;
      const lastResult = last ? assertResponseShape(last, expectation) : null;
      return {
        ok: false,
        type: "expectNetworkResponse",
        error: entries.length ? null : "network-response-not-observed",
        failures: lastResult?.failures || [],
        observedCount: entries.length,
        observed: entries.map((entry) => ({
          url: entry.url,
          method: entry.method,
          status: entry.status,
        })).slice(-10),
      };
    },
  };
}

function getWaitForChangeExpectation(action) {
  const expectation = findWaitForChangeExpectation(action.expectation);
  if (expectation) {
    return expectation;
  }
  if (action.waitForChange) {
    return {
      kind: "waitForChange",
      timeoutMs: action.waitForChangeTimeoutMs,
    };
  }
  return null;
}

function getAssertVisibleTexts(action) {
  if (action.kind !== "assertVisible") {
    return [];
  }
  const target = action.target || {};
  return [action.query, target.text, target.query]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

function hasTargetHints(action) {
  const target = action?.target || {};
  return Boolean(
    action?.query ||
      target.text ||
      target.name ||
      target.query ||
      target.role ||
      target.locator ||
      target.placeholder ||
      target.ariaLabel ||
      target.title ||
      target.testId ||
      target.nearText ||
      target.iconHint,
  );
}

function splitOptionPath(option = {}) {
  const explicitPath = Array.isArray(option.path) ? option.path : [];
  const source = explicitPath.length
    ? explicitPath
    : [option.text || option.value || ""];
  return source
    .flatMap((item) =>
      typeof item === "string" ? item.split(/\r?\n|[>/]|→|›/) : [item],
    )
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function normalizeEvidenceProfile(value) {
  return ["debug", "fast", "turbo"].includes(value) ? value : "debug";
}

function createStageTelemetry(startedAt = Date.now()) {
  const stages = {
    settle: 0,
    beforeSnapshot: 0,
    beforeState: 0,
    detectFrameworkBeforeAction: 0,
    resolveTarget: 0,
    performAction: 0,
    navigationObservation: 0,
    afterSnapshot: 0,
    afterState: 0,
    change: 0,
    detectFrameworkBeforeExpectation: 0,
    expectation: 0,
    ocr: 0,
    artifactWrite: 0,
    total: 0,
  };
  return {
    stages,
    async measure(name, operation) {
      const started = Date.now();
      try {
        return await operation();
      } finally {
        stages[name] = (stages[name] || 0) + Date.now() - started;
      }
    },
    finish() {
      stages.total = Date.now() - startedAt;
      return stages;
    },
  };
}

function isResolutionRetryableOnEmptyPage(resolution) {
  const error = resolution?.error || "";
  return !resolution?.success && ["low-confidence-target", "target-not-found", "action-target-unresolved"].includes(error);
}

function snapshotInteractableCount(snapshot) {
  return Array.isArray(snapshot?.interactables) ? snapshot.interactables.length : 0;
}

async function waitForTargetResolveRetryReadiness(page, action, actionStartedAt) {
  const timeoutMs = Math.max(0, toFiniteNumber(action.timeoutMs, 5000));
  const maxMs = Math.min(Math.max(timeoutMs - (Date.now() - actionStartedAt), 0), 3000);
  const startedAt = Date.now();
  let delayMs = 120;
  let lastReadiness = null;

  while (Date.now() - startedAt <= maxMs) {
    try {
      lastReadiness = await readPageReadiness(page, action);
      if (lastReadiness?.interactableCount > 0 || lastReadiness?.targetTextMatched) {
        return {
          ready: true,
          waitedMs: Date.now() - startedAt,
          readiness: lastReadiness,
        };
      }
    } catch (error) {
      lastReadiness = {
        error: error?.message || "readiness-unavailable",
      };
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= maxMs) {
      break;
    }
    const waitMs = Math.min(delayMs, maxMs - elapsedMs);
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs).catch(() => {});
    }
    delayMs = Math.min(delayMs * 2, 500);
  }

  return {
    ready: false,
    waitedMs: Date.now() - startedAt,
    readiness: lastReadiness,
  };
}

// v1.10 Z29-1: when the after-step OCR runs. It used to run after every
// `needRes` step and was 36% of all session wall-clock (313 real sessions,
// 2026-09-25..10-06), yet its output only ever lands in `ocr.json` — no
// verdict, locator or proof reads it. Target-resolution OCR (the visual
// fallback in locator-resolver) is a different path and is unaffected.
//   "onFailure" (default) — only for a failed step, where a reader may want it
//   "always"              — the pre-v1.10 behaviour
//   "off"                 — never
const STEP_OCR_MODES = ["onFailure", "always", "off"];

function resolveStepOcrMode(...candidates) {
  for (const value of [...candidates, process.env.ZHUZHU_STEP_OCR]) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) {
      continue;
    }
    if (["always", "on", "true", "1"].includes(text)) {
      return "always";
    }
    if (["onfailure", "on-failure", "failure", "failed"].includes(text)) {
      return "onFailure";
    }
    if (["off", "never", "false", "0", "no"].includes(text)) {
      return "off";
    }
  }
  return "onFailure";
}

// v1.10 Z29-3: a callApi step talks to the backend over the page's request
// context; the page itself does not move. Screenshotting it before and after
// (and OCR-ing the result) recorded two identical pictures of an unrelated page.
const PAGE_NEUTRAL_KINDS = new Set(["callApi"]);

function createEvidencePolicy(action, waitForChangeExpectation, stepOcrMode = "onFailure") {
  const profile = normalizeEvidenceProfile(action.evidenceProfile || action.runProfile);
  const persistArtifacts = Boolean(action.needRes);
  const needsImageDiff = Boolean(waitForChangeExpectation);
  const pageNeutral = PAGE_NEUTRAL_KINDS.has(action.kind);
  if (profile === "fast" || profile === "turbo") {
    return {
      profile,
      persistArtifacts: false,
      captureBeforeScreenshot: needsImageDiff,
      captureAfterScreenshot: needsImageDiff,
      captureBeforeState: true,
      captureAfterState: Boolean(action.expectation || action.needRes || needsImageDiff),
      captureOcr: false,
      stepOcr: "off",
      captureTrace: true,
      captureFailureScreenshot: true,
    };
  }
  const screenshots = needsImageDiff || (persistArtifacts && !pageNeutral);
  return {
    profile,
    persistArtifacts,
    captureBeforeScreenshot: screenshots,
    captureAfterScreenshot: screenshots,
    captureBeforeState: true,
    captureAfterState: Boolean(persistArtifacts || action.expectation || needsImageDiff),
    captureOcr: persistArtifacts && stepOcrMode !== "off",
    stepOcr: persistArtifacts ? stepOcrMode : "off",
    captureTrace: persistArtifacts,
    captureFailureScreenshot: false,
  };
}

function applyRuntimeProfileDefaults(action, runProfile) {
  const profile = normalizeEvidenceProfile(action.evidenceProfile || action.runProfile || runProfile);
  const next = {
    ...action,
    ...(action.evidenceProfile ? {} : runProfile ? { evidenceProfile: runProfile, runProfile } : {}),
  };
  if (!next.settleStrategy && (profile === "fast" || profile === "turbo")) {
    next.settleStrategy = "adaptive";
    next.settleInitialMs = next.settleInitialMs ?? 50;
    next.settleMaxMs = next.settleMaxMs ?? 800;
  }
  return next;
}

async function executeAction({
  page,
  action,
  ocrService,
  artifactStore,
  runtimeVariables = null,
  runtimeVariableSources = null,
  runProfile = null,
  artifactAttempt = null,
  maxAttempts = null,
  // v1.5 Z-A / Z-C: run-scoped collectors owned by the orchestrator. Passed
  // through to the expectation context so assertion kinds that reason about the
  // *run* (no page errors so far, which files were downloaded) can be evaluated
  // in the same place as every other assertion.
  diagnostics = null,
  downloads = null,
  performance = null,
  visualBaselineRoot = null,
  visualProfile = null,
  saveVisualArtifact = null,
  collectVisualReview = null,
  dataTenant = null,
  // v1.10 Z29-1: run-level after-step OCR mode; a step may override it with
  // its own `stepOcr`.
  stepOcr = null,
}) {
  const actionStartedAt = Date.now();
  action = applyRuntimeProfileDefaults(action, runProfile);
  const waitForChangeExpectation = getWaitForChangeExpectation(action);
  const evidencePolicy = createEvidencePolicy(
    action,
    waitForChangeExpectation,
    resolveStepOcrMode(action.raw?.stepOcr, stepOcr),
  );
  const stageTelemetry = createStageTelemetry(actionStartedAt);
  const artifactSuffix = (suffix) =>
    Number.isInteger(artifactAttempt) && artifactAttempt > 0
      ? `attempt-${artifactAttempt}-${suffix}`
      : suffix;
  await stageTelemetry.measure("settle", () => settlePageBeforeAction(page, action));
  const expectsPageChange = Boolean(waitForChangeExpectation);
  const recoveryTimeoutMs = Math.max(
    toFiniteNumber(action.navigationTimeoutMs, 0) ?? 0,
    toFiniteNumber(action.timeoutMs, 0) ?? 0,
    toFiniteNumber(waitForChangeExpectation?.timeoutMs, 0) ?? 0,
    toFiniteNumber(action.waitForChangeTimeoutMs, 0) ?? 0,
    5000,
  );
  const recovery = {
    expectNavigation:
      Boolean(action.navigationBehavior && action.navigationBehavior !== "ignore") ||
      expectsPageChange,
    waitUntil: action.waitUntil,
    timeoutMs: recoveryTimeoutMs,
    stabilizationDelayMs: action.stabilizationDelayMs ?? 0,
  };

  let beforeSnapshot = await stageTelemetry.measure(
    evidencePolicy.captureBeforeScreenshot ? "beforeSnapshot" : "beforeState",
    () => evidencePolicy.captureBeforeScreenshot
      ? safeCapturePageSnapshot(page, {}, recovery)
      : safeCapturePageState(page, {}, recovery),
  );
  let uiContextBeforeAction = await stageTelemetry.measure(
    "detectFrameworkBeforeAction",
    () => safeDetectUiFrameworks(page, recovery),
  );
  const networkCollector = expectationIncludesKind(action.expectation, ["networkResponse", "expectNetworkResponse"])
    ? createNetworkCollector(page)
    : null;
  let beforePath = null;
  if (evidencePolicy.persistArtifacts && beforeSnapshot.screenshotBuffer) {
    beforePath = await stageTelemetry.measure(
      "artifactWrite",
      () => artifactStore.saveScreenshot(
        action.index,
        artifactSuffix("before"),
        beforeSnapshot.screenshotBuffer,
      ),
    );
  }

  const assertVisibleTexts = getAssertVisibleTexts(action);
  const needsResolution = (Boolean(action.actionDefinition?.needsTarget) ||
      (action.kind === "press" && hasTargetHints(action)))
    && !(action.kind === "assertVisible" && assertVisibleTexts.length);
  let resolution = needsResolution
    ? await stageTelemetry.measure("resolveTarget", () => resolveActionTarget(page, action, {
      ocrService,
      uiContext: {
        beforeAction: uiContextBeforeAction,
      },
    }))
    : null;
  let targetResolveRetry = null;
  if (
    needsResolution &&
    isResolutionRetryableOnEmptyPage(resolution) &&
    snapshotInteractableCount(beforeSnapshot) === 0
  ) {
    targetResolveRetry = {
      reason: "empty-page-before-resolve",
      firstError: resolution?.error || null,
      firstStrategy: resolution?.strategy || null,
      firstInteractableCount: snapshotInteractableCount(beforeSnapshot),
    };
    const readiness = await stageTelemetry.measure(
      "resolveTarget",
      () => waitForTargetResolveRetryReadiness(page, action, actionStartedAt),
    );
    targetResolveRetry.waitedMs = readiness.waitedMs;
    targetResolveRetry.readiness = readiness.readiness || null;
    if (readiness.ready) {
      beforeSnapshot = await stageTelemetry.measure(
        evidencePolicy.captureBeforeScreenshot ? "beforeSnapshot" : "beforeState",
        () => evidencePolicy.captureBeforeScreenshot
          ? safeCapturePageSnapshot(page, {}, recovery)
          : safeCapturePageState(page, {}, recovery),
      );
      uiContextBeforeAction = await stageTelemetry.measure(
        "detectFrameworkBeforeAction",
        () => safeDetectUiFrameworks(page, recovery, { forceRefresh: true }),
      );
      resolution = await stageTelemetry.measure("resolveTarget", () => resolveActionTarget(page, action, {
        ocrService,
        uiContext: {
          beforeAction: uiContextBeforeAction,
        },
      }));
      targetResolveRetry.retrySuccess = Boolean(resolution?.success);
      targetResolveRetry.retryError = resolution?.success ? null : resolution?.error || "target-not-found";
      targetResolveRetry.retryStrategy = resolution?.strategy || null;
    } else {
      targetResolveRetry.retrySuccess = false;
      targetResolveRetry.retryError = "page-not-ready";
      targetResolveRetry.retryStrategy = null;
    }
  }
  const actionResult = {
    success: true,
    error: null,
    detail: null,
    inputArtifacts: null,
    popupTrace: null,
    apiResponse: null,
    apiRequest: null,
  };

  if (
    needsResolution && (!resolution || !resolution.success)
  ) {
    actionResult.success = false;
    actionResult.error = resolution?.error || "target-not-found";
  } else if (["waitForNav", "waitForIdle", "waitForText"].includes(action.kind)) {
    actionResult.detail = "wait-only";
  } else {
    let performed = null;
    performed = await stageTelemetry.measure("performAction", async () => {
      try {
        return await executeDomAction(page, action, resolution);
      } catch (error) {
        return {
          success: false,
          error: error?.message || "action-exception",
          detail: "action-exception",
        };
      }
    });
    actionResult.success = Boolean(performed?.success);
    actionResult.error = performed?.error || null;
    actionResult.detail = performed?.detail || null;
    actionResult.inputArtifacts = performed?.inputArtifacts || null;
    actionResult.popupTrace = performed?.popupTrace || null;
    actionResult.apiResponse = performed?.apiResponse || null;
    actionResult.apiRequest = performed?.requestTrace || null;
  }

  if (actionResult.success && action.actionDefinition?.mutatesPage) {
    invalidateUiFrameworkCache(page);
  }
  if (actionResult.success) {
    actionResult.navigation = await stageTelemetry.measure(
      "navigationObservation",
      () => observeNavigationAfterAction(page, action, beforeSnapshot),
    );
    if (actionResult.navigation?.observed) {
      invalidateUiFrameworkCache(page);
    }
    if (
      action.navigationBehavior === "required" &&
      (!actionResult.navigation.observed || !actionResult.navigation.matchedTarget || actionResult.navigation.error)
    ) {
      actionResult.success = false;
      actionResult.error =
        actionResult.navigation.error ||
        (!actionResult.navigation.observed ? "navigation-not-observed" : "navigation-target-mismatch");
    }
  } else {
    actionResult.navigation = null;
  }

  let afterSnapshot = null;
  let change = null;
  let afterPath = null;
  const resolveChange = async () => {
    afterSnapshot = await stageTelemetry.measure(
      "afterSnapshot",
      () => safeCapturePageSnapshot(page, {}, recovery),
    );
    const changeThreshold = toFiniteNumber(waitForChangeExpectation?.threshold, 0.02);
    change = await stageTelemetry.measure(
      "change",
      async () => computeImageDiff(
        beforeSnapshot.screenshotBuffer,
        afterSnapshot.screenshotBuffer,
        {
          threshold: changeThreshold,
        },
      ),
    );
    return change;
  };

  if (waitForChangeExpectation) {
    await resolveChange();
  } else if (evidencePolicy.captureAfterScreenshot) {
    // v1.10 Z29-2: the after picture is evidence; the pixel diff against the
    // before picture only matters to `waitForChange`. Decoding two PNGs and
    // diffing them synchronously on every step cost 3% of session time to fill
    // an informational "page diff" field nobody judged on.
    afterSnapshot = await stageTelemetry.measure(
      "afterSnapshot",
      () => safeCapturePageSnapshot(page, {}, recovery),
    );
  } else if (evidencePolicy.captureAfterState && !afterSnapshot) {
    afterSnapshot = await stageTelemetry.measure(
      "afterState",
      () => safeCapturePageState(page, {}, recovery),
    );
  }

  const shouldDetectBeforeExpectation = Boolean(
    waitForChangeExpectation ||
      action.expectation ||
      ["comboSearchSelect", "cascaderSelect", "waitForText", "assertUrl", "assertCount", "assertVisible"].includes(action.kind),
  );
  const uiContextBeforeExpectation = shouldDetectBeforeExpectation
    ? await stageTelemetry.measure(
        "detectFrameworkBeforeExpectation",
        () => safeDetectUiFrameworks(page, recovery, {
          forceRefresh: Boolean(actionResult.success && action.actionDefinition?.mutatesPage),
        }),
      )
    : null;
  const buildExpectationContext = (extra = {}) => ({
    ...extra,
    diagnostics,
    downloads,
    performance,
    visualBaselineRoot,
    visualProfile,
    saveVisualArtifact,
    collectVisualReview,
    dataTenant,
    action,
    // v1.6 Z-J: read access to the run's variables. `assertConsistency` compares
    // the per-probe capture slots, which only exist here. Passed as the live
    // object (not a copy) because captures written by earlier steps of the same
    // action must be visible.
    runtimeVariables: runtimeVariables || {},
    setRuntimeVariable: (name, value, source = "capture") =>
      setRuntimeVariable(runtimeVariables || {}, runtimeVariableSources || {}, name, value, source),
    uiContext: {
      beforeAction: uiContextBeforeAction,
      beforeExpectation: uiContextBeforeExpectation,
    },
  });

  let expectation = null;
  if (waitForChangeExpectation) {
    expectation = await stageTelemetry.measure(
      "expectation",
      () => safeRunExpectation(
        page,
        {
          ...waitForChangeExpectation,
          kind: waitForChangeExpectation.kind || waitForChangeExpectation.type || "waitForChange",
          timeoutMs: waitForChangeExpectation.timeoutMs ?? action.waitForChangeTimeoutMs,
        },
        buildExpectationContext({
          change,
          response: actionResult.apiResponse,
          apiResponse: actionResult.apiResponse,
          waitForNetworkResponse: networkCollector?.waitForNetworkResponse,
          waitForTimeout: (timeoutMs) => page.waitForTimeout(timeoutMs),
          resolveChange,
        }),
        recovery,
      ),
    );
  }
  if (action.expectation && action.expectation !== waitForChangeExpectation && (!expectation || expectation.ok)) {
    expectation = await stageTelemetry.measure(
      "expectation",
      () => safeRunExpectation(
        page,
        action.expectation,
        buildExpectationContext({
          change,
          response: actionResult.apiResponse,
          apiResponse: actionResult.apiResponse,
          waitForNetworkResponse: networkCollector?.waitForNetworkResponse,
          waitForTimeout: (timeoutMs) => page.waitForTimeout(timeoutMs),
          resolveChange,
        }),
        recovery,
      ),
    );
  }
  if (!expectation && ["comboSearchSelect", "cascaderSelect"].includes(action.kind) && (action.option?.text || action.option?.value || action.option?.path?.length)) {
    const expectedText = action.kind === "cascaderSelect"
      ? splitOptionPath(action.option).at(-1)
      : action.option.text || action.option.value;
    expectation = await stageTelemetry.measure(
      "expectation",
      () => safeRunExpectation(
        page,
        {
          kind: "text-exists",
          texts: [expectedText],
          timeoutMs: action.timeoutMs,
        },
        buildExpectationContext({ change }),
        recovery,
      ),
    );
  }
  if (action.kind === "waitForText") {
    expectation = await stageTelemetry.measure(
      "expectation",
      () => safeRunExpectation(
        page,
        {
          kind: "text-exists",
          texts: [action.query],
          timeoutMs: action.timeoutMs,
        },
        buildExpectationContext({ change }),
        recovery,
      ),
    );
  }
  if (!expectation && action.kind === "assertUrl") {
    expectation = await stageTelemetry.measure(
      "expectation",
      () => safeRunExpectation(
        page,
        {
          kind: "url-matches",
          urlIncludes: action.raw?.urlIncludes || action.query || action.navigationTarget?.urlIncludes || "",
          urlMatches: action.raw?.urlMatches || action.navigationTarget?.urlMatches || "",
          pathEquals: action.raw?.pathEquals || action.navigationTarget?.pathEquals || "",
          titleIncludes: action.raw?.titleIncludes || action.navigationTarget?.titleIncludes || "",
        },
        buildExpectationContext({ change }),
        recovery,
      ),
    );
  }
  if (!expectation && action.kind === "assertCount") {
    expectation = await stageTelemetry.measure(
      "expectation",
      () => safeRunExpectation(
        page,
        {
          kind: "count",
          target: action.target,
          count: action.count,
          operator: action.operator,
          visibleOnly: action.visibleOnly,
        },
        buildExpectationContext({ change }),
        recovery,
      ),
    );
  }
  if (!expectation && action.kind === "assertVisible") {
    if (assertVisibleTexts.length) {
      expectation = await stageTelemetry.measure(
        "expectation",
        () => safeRunExpectation(
          page,
          {
            kind: "text-exists",
            texts: assertVisibleTexts,
            timeoutMs: action.timeoutMs,
            scope: action.target?.scope ?? null,
          },
          buildExpectationContext({ change }),
          recovery,
        ),
      );
    }
  }

  if (evidencePolicy.persistArtifacts && afterSnapshot?.screenshotBuffer) {
    afterPath = await stageTelemetry.measure(
      "artifactWrite",
      () => artifactStore.saveScreenshot(
        action.index,
        artifactSuffix("after"),
        afterSnapshot.screenshotBuffer,
      ),
    );
  }

  const ok = Boolean(actionResult.success && (!expectation || expectation.ok));
  if (!ok && evidencePolicy.captureFailureScreenshot && !afterPath) {
    if (!afterSnapshot?.screenshotBuffer) {
      afterSnapshot = await stageTelemetry.measure(
        "afterSnapshot",
        () => safeCapturePageSnapshot(page, {}, recovery),
      );
    }
    afterPath = await stageTelemetry.measure(
      "artifactWrite",
      () => artifactStore.saveScreenshot(
        action.index,
        artifactSuffix("after"),
        afterSnapshot.screenshotBuffer,
      ),
    );
  }

  const wantsStepOcr = evidencePolicy.captureOcr
    && (evidencePolicy.stepOcr === "always" || (evidencePolicy.stepOcr === "onFailure" && !ok));
  const ocrSummary = resolution?.ocr || (
    afterSnapshot?.screenshotBuffer && wantsStepOcr
      ? await stageTelemetry.measure(
          "ocr",
          () => ocrService.runOcr({
            imageBuffer: afterSnapshot.screenshotBuffer,
            width: afterSnapshot.viewport.width,
            height: afterSnapshot.viewport.height,
          }),
        )
      : null
  );
  const ocrPath = ocrSummary
    && evidencePolicy.captureOcr
    ? await stageTelemetry.measure(
        "artifactWrite",
        () => artifactStore.saveJson(action.index, artifactSuffix("ocr"), ocrSummary),
      )
    : null;

  const durationMs = Date.now() - actionStartedAt;
  const stabilityRisk =
    resolution?.source === "ocr"
      ? "ocrClick"
      : resolution?.strategy?.includes("bbox")
        ? "coordinateFallback"
        : resolution?.targetSummary?.index != null
          ? "indexOnly"
          : null;
  const executionPath = buildExecutionPath(action, resolution, actionResult, stabilityRisk);
  const finalStatus = ok ? "ok" : "failed";
  const errorClassification =
    !actionResult.success
      ? actionResult.error === "low-confidence-target"
        ? "low-confidence-target"
        : actionResult.error === "target-scope-not-found"
          ? "target-scope-not-found"
        : actionResult.error === "action-target-unresolved"
          ? "action-target-unresolved"
        : actionResult.error === "target-not-found"
          ? "target-not-found"
          : actionResult.error === "invalid-url"
            ? "invalid-input"
            : actionResult.error === "file-not-allowed"
              ? "file-not-allowed"
            : actionResult.error === "file-not-found"
              ? "file-not-found"
            : actionResult.error === "upload-timeout"
              ? "upload-timeout"
            : actionResult.error === "option-not-found"
              ? "option-not-found"
            : actionResult.error === "browser-unavailable"
              ? "browser-unavailable"
          : actionResult.error === "navigation-not-observed" ||
              actionResult.error === "navigation-target-mismatch"
            ? "navigation-failed"
          : "action-failed"
      : expectation && !expectation.ok
        ? expectation.type === "waitForChange"
          ? "wait-timeout"
          : "expectation-not-met"
        : null;
  const telemetryStages = stageTelemetry.finish();
  const stepTelemetry = {
    durationMs,
    evidenceProfile: evidencePolicy.profile,
    stages: telemetryStages,
  };
  const trace = {
    input: action.raw,
    runtimeVariables,
    actionDefinition: action.actionDefinition,
    normalizedTarget: action.target ?? null,
    migration: action.migration ?? null,
    normalizedAction: {
      id: action.id,
      kind: action.kind,
      query: action.query,
      hints: action.hints,
      needRes: action.needRes,
      evidenceProfile: evidencePolicy.profile,
      strictMatch: action.strictMatch,
      retries: action.retries,
      option: action.option,
      files: action.files,
      key: action.key,
      count: action.count,
      operator: action.operator,
      visibleOnly: action.visibleOnly,
    },
    uiContext: {
      beforeAction: uiContextBeforeAction,
      beforeExpectation: uiContextBeforeExpectation,
    },
    selectedLocatorStrategy: resolution?.strategy ?? null,
    selectedCandidate: resolution?.targetSummary ?? null,
    adapterDiagnostics: resolution?.adapter ?? null,
    resolverPipeline: resolution?.attempts ?? [],
    candidateListTopN: resolution?.rankedCandidates ?? [],
    targetResolveRetry,
    stabilityRisk,
    executionPath,
    inputArtifacts: actionResult.inputArtifacts,
    popupTrace: actionResult.popupTrace,
    captures: expectation?.captures || [],
    actionResult: compactActionResult(actionResult),
    apiRequest: actionResult.apiRequest,
    apiResponse: actionResult.apiResponse
      ? {
          url: actionResult.apiResponse.url,
          method: actionResult.apiResponse.method,
          status: actionResult.apiResponse.status,
          headers: redactHeaders(actionResult.apiResponse.headers),
          body: actionResult.apiResponse.body,
        }
      : null,
    beforeScreenshotPath: beforePath,
    afterScreenshotPath: afterPath,
    evidencePolicy,
    ocrSummary,
    domSummary: {
      before: {
        title: beforeSnapshot.title,
        url: beforeSnapshot.url,
        interactableCount: beforeSnapshot.interactables.length,
        // v1.8: the probe now caps what it returns, so evidence has to say when
        // it did — otherwise a truncated sample reads as a complete one.
        pageTextLength: beforeSnapshot.textLength ?? null,
        pageTextTruncated: Boolean(beforeSnapshot.textTruncated),
      },
      after: afterSnapshot
        ? {
            title: afterSnapshot.title,
            url: afterSnapshot.url,
            interactableCount: afterSnapshot.interactables.length,
            pageTextLength: afterSnapshot.textLength ?? null,
            pageTextTruncated: Boolean(afterSnapshot.textTruncated),
          }
        : null,
    },
    diffResult: change,
    navigation: actionResult.navigation,
    retriesAttempted: Math.max(0, (artifactAttempt ?? 1) - 1),
    retrySummary: {
      attempts: artifactAttempt ?? 1,
      retries: Math.max(0, (artifactAttempt ?? 1) - 1),
      maxAttempts: maxAttempts ?? 1,
    },
    attempt: Number.isInteger(artifactAttempt) && artifactAttempt > 0
      ? {
          number: artifactAttempt,
          maxAttempts: maxAttempts ?? artifactAttempt,
        }
      : null,
    expectation,
    runtimeVariableSources,
    telemetry: stepTelemetry,
    durationMs,
    finalStatus,
    errorClassification,
  };
  const tracePath = evidencePolicy.captureTrace
    ? await stageTelemetry.measure(
        "artifactWrite",
        () => artifactStore.saveJson(action.index, artifactSuffix("trace"), trace),
      )
    : null;

  if (networkCollector) {
    networkCollector.dispose();
  }

  const error = ok
    ? null
    : buildError(
        trace.errorClassification || "action-failed",
        actionResult.error ||
          formatExpectationError(expectation) ||
          `Step failed: ${action.kind}`,
        {
          action: action.kind,
          expectation,
          resolution: sanitizeResolution(resolution),
          inputArtifacts: actionResult.inputArtifacts,
          popupTrace: actionResult.popupTrace,
        },
        trace.errorClassification === "wait-timeout" ||
          trace.errorClassification === "target-not-found",
      );

  return {
    ok,
    type: action.kind,
    data: {
      action: {
        success: actionResult.success,
        error: actionResult.error,
        detail: actionResult.detail,
        navigation: actionResult.navigation,
        inputArtifacts: actionResult.inputArtifacts,
        popupTrace: actionResult.popupTrace,
        apiRequest: actionResult.apiRequest,
        apiResponse: actionResult.apiResponse
          ? {
              url: actionResult.apiResponse.url,
              method: actionResult.apiResponse.method,
              status: actionResult.apiResponse.status,
              headers: redactHeaders(actionResult.apiResponse.headers),
              body: actionResult.apiResponse.body,
            }
          : null,
      },
      resolution: sanitizeResolution(resolution),
      executionPath,
      // v1.8 perf: `text` used to be the page's *full* `innerText`, before and
      // after every step, with no bound at all — measured at 52,820 chars per
      // sample on a 20k-node page, and 49% of a real 2.3MB report.json.
      //
      // It is kept (assertions and human triage legitimately read "what does the
      // page say now") but is now bounded by the probe's own cap, and carries the
      // true length plus a truncation flag so a clipped sample cannot be mistaken
      // for a complete one. The single knob is ZHUZHU_PAGE_TEXT_LIMIT.
      snapshot: {
        before: {
          title: beforeSnapshot.title,
          url: beforeSnapshot.url,
          text: beforeSnapshot.text,
          textLength: beforeSnapshot.textLength ?? (beforeSnapshot.text || "").length,
          textTruncated: Boolean(beforeSnapshot.textTruncated),
        },
        after: afterSnapshot
          ? {
              title: afterSnapshot.title,
              url: afterSnapshot.url,
              text: afterSnapshot.text,
              textLength: afterSnapshot.textLength ?? (afterSnapshot.text || "").length,
              textTruncated: Boolean(afterSnapshot.textTruncated),
            }
          : null,
      },
      change,
      expectation,
      captures: expectation?.captures || [],
      runtimeVariables,
      runtimeVariableSources,
      telemetry: stepTelemetry,
      retry: {
        attempts: 1,
        retries: 0,
      },
      trace: {
        durationMs,
        telemetry: stepTelemetry,
      },
      evidence: {
        beforeScreenshotPath: beforePath,
        afterScreenshotPath: afterPath,
        ocrPath,
        tracePath,
      },
    },
    error,
    telemetry: stepTelemetry,
    evidence: {
      beforeScreenshotPath: beforePath,
      afterScreenshotPath: afterPath,
      ocrPath,
      tracePath,
    },
  };
}

module.exports = {
  executeAction,
  createEvidencePolicy,
  resolveStepOcrMode,
  STEP_OCR_MODES,
};
