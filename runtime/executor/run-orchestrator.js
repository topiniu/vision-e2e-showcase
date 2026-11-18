const path = require('node:path');
const { normalizePayload } = require('../protocol/normalize');
const { createRuntimeVariables, createRuntimeVariableSources, interpolateRuntimeTemplates } = require('../protocol/runtime-vars');
const { ArtifactStore } = require('../reporting/artifact-store');
const { createSecretRedactor } = require('../reporting/secret-redactor');
const { OcrService } = require('../perception/ocr-service');
const { RunSession } = require('./run-session');
const { executeAction } = require('./action-runner');
const { assertNotAborted, raceAbort } = require('./abort');
const { buildError, buildStepDiagnostics, createSkippedResult, createStoppedResult, summarizeBatch } = require('./result-shaping');
const { isTransientError } = require('./transient-errors');
const {
  STEP_HARD_TIMEOUT_CODE,
  isHardTimeoutError,
  resolveStepHardTimeoutMs,
  withHardTimeout,
} = require('./hard-timeout');
const {
  BROWSER_OOM_CODE,
  createBrowserHealthMonitor,
} = require('./browser-health');
const {
  PAGE_ERROR_CODE,
  createPageDiagnostics,
  describePageErrorFailure,
} = require('../perception/page-diagnostics');
const {
  collectEnvironmentFingerprint,
  evaluateFreshness,
} = require('../perception/environment-fingerprint');
const { DownloadCollector } = require('../perception/file-artifacts');
const { createPerformanceCollector } = require('../perception/performance-metrics');
const { buildVisualReview } = require('../perception/visual-baseline');
const { DataTenantRegistry, normalizeDataTenant } = require('../../src/shared/data-tenant');
const { saveCheckpoint, loadCheckpoint, planResume } = require('./checkpoint-store');
const { evaluateDetect, selectFiredRecoveries, selectReactiveRecoveries } = require('./recovery');
const { hasAuthEvidence } = require('./auth-evidence');
const { applyInjectedViewport, describeViewport, measureViewport } = require('./viewport-emulation');
const { RouteFaultRegistry, buildUnmetResult } = require('./route-faults');
const { parseViewport } = require('../../src/shared/viewport');

// Z04: platform self-heal budget for known transient failures, applied on top
// of the author-declared `action.retries`. A transient jitter (render freeze,
// fonts-not-ready, transient screenshot failure, ...) is retried a bounded
// number of extra times so an unattended batch is not killed by one flake.
const TRANSIENT_RETRY_BUDGET = Math.max(0, Number(process.env.ZHUZHU_TRANSIENT_RETRY_BUDGET ?? 2));
const TRANSIENT_RETRY_DELAY_MS = Math.max(0, Number(process.env.ZHUZHU_TRANSIENT_RETRY_DELAY_MS ?? 800));

// REQ-Z12 (需求单v3): once a step hard-times-out, the page/renderer is wedged —
// every following step will burn its own full deadline for nothing. After this
// many *consecutive* hard timeouts the run gives up immediately, marks the rest
// stopped and still writes a summary, instead of grinding through N x deadline.
const HARD_TIMEOUT_CIRCUIT_BREAK = Math.max(1, Number(process.env.ZHUZHU_HARD_TIMEOUT_CIRCUIT_BREAK ?? 2));
// REQ-Z12: absolute wall-clock ceiling for one `run()`. 0 disables it.
const RUN_HARD_TIMEOUT_MS = Math.max(0, Number(process.env.ZHUZHU_RUN_HARD_TIMEOUT_MS ?? 45 * 60 * 1000));
// REQ-Z12: browser/OCR teardown budget — a wedged page must not park the finally.
const SESSION_CLOSE_HARD_TIMEOUT_MS = Math.max(1000, Number(process.env.ZHUZHU_SESSION_CLOSE_TIMEOUT_MS ?? 20_000));

// v1.4 REQ-Z17: auth gate for *proactive* recovery. A file's `baseUrl` is
// re-navigated before every case, so a login-page baseUrl made `recovery.login`'s
// `/login` detect match on a browser that was already logged in — every case paid
// a full re-login. Being on `/login` is not evidence of being logged out; a
// credential in the live context is evidence of the opposite. The gate is
// proactive-only: reactive recovery (a step actually failed) must still be able
// to re-login when a stored token turned out to be dead. Set
// `ZHUZHU_RECOVERY_AUTH_GATE=0` to fall back to the pre-v1.4 behaviour.
// Read at call time (like the page-probe budgets) so the switch can be flipped
// per process without a rebuild, and so tests can cover both directions.
function isRecoveryAuthGateEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.ZHUZHU_RECOVERY_AUTH_GATE || "").trim());
}

// v1.9 REQ-Z23: every `detect` the file declares. Being on a URL that triggers a
// recovery handler means, by the file's own definition, that we are NOT in the
// product yet (we are on the login page, or in whatever broken state the handler
// repairs). The page-error gate uses this to place an error in the
// `auth-bootstrap` window instead of blaming the case for it.
function collectRecoveryDetects(recoveryMap) {
  const source = recoveryMap && typeof recoveryMap === "object" && !Array.isArray(recoveryMap) ? recoveryMap : {};
  return Object.values(source)
    .map((handler) => (handler && typeof handler === "object" ? handler.detect : null))
    .filter(Boolean);
}

// v1.9 REQ-Z22: name the login mechanism from the steps themselves, so the trace
// says "account-password" vs "qr-code" vs "storage-state" without the file having
// to declare it. Read from what the steps actually do — a fill into a password
// field is account-password, no matter what the step titles say.
function describeRecoveryStrategy(actions = []) {
  const blob = JSON.stringify(actions || []).toLowerCase();
  if (/password|密码/.test(blob)) {
    return "account-password";
  }
  if (/qrcode|qr-code|二维码|扫码/.test(blob)) {
    return "qr-code";
  }
  if (/sso|oauth|saml/.test(blob)) {
    return "sso";
  }
  return actions.length ? "declared-steps" : null;
}

// v1.5 Z-B: collected on EVERY run, not only when a freshness rule is declared —
// the point of the fingerprint is that evidence can always answer "which build
// produced this". `ZHUZHU_ENV_FINGERPRINT=0` opts out (one bounded
// `page.evaluate`, but a machine with a pathological target should be able to
// skip it).
function isEnvironmentFingerprintEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.ZHUZHU_ENV_FINGERPRINT || "").trim());
}
// Reading the live storageState touches the renderer (localStorage per origin),
// so it is hard-bounded like every other page probe: a wedged page must not turn
// a cheap optimization into a hang. On timeout we assume "no evidence" and run
// the recovery — the safe direction.
const AUTH_EVIDENCE_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.ZHUZHU_AUTH_EVIDENCE_PROBE_TIMEOUT_MS ?? 8000),
);

// v1.5 Z-A: turn a passing (or already failing) step into a page-error failure.
// Shape-compatible with `executeAction`'s output so every downstream consumer
// (diagnostics / summary / report / repair-context) treats it as an ordinary
// failed step — the gate must not need special-casing anywhere else.
//
// When the step had already failed we keep its original error (the page error is
// then almost always a *symptom* of that failure, and the author needs the
// original cause) but still attach the entries so the report shows both.
function applyPageErrorGate(result, action, entries) {
  if (!result || !entries.length) {
    return result;
  }
  const pageErrors = entries.map((item) => ({
    kind: item.kind,
    message: item.message,
    stack: item.stack,
    at: item.at,
    url: item.url,
    stepId: item.stepId,
    stepIndex: item.stepIndex,
  }));
  if (result.data) {
    result.data.pageErrors = pageErrors;
  }
  if (!result.ok) {
    return result;
  }
  const message = describePageErrorFailure(entries);
  const next = {
    ...result,
    ok: false,
    error: buildError(
      PAGE_ERROR_CODE,
      message,
      {
        action: action.kind,
        stepId: action.id || null,
        stepIndex: action.index ?? null,
        pageErrors,
      },
      // Not retryable: re-running the same step against the same build will
      // throw again. Retrying would only hide the defect behind a flake story.
      false,
    ),
  };
  if (next.data) {
    next.data = {
      ...next.data,
      action: {
        ...(next.data.action || {}),
        // The action itself DID succeed — say so, and put the gate verdict in
        // its own field. Rewriting `success` to false would make the trace lie
        // about what the click/fill actually did.
        gate: PAGE_ERROR_CODE,
      },
      pageErrors,
    };
  }
  return next;
}

// `page.url()` is normally sync + safe, but a closed/crashed page throws. The
// run must still be able to write its summary.
function readBrowserUrlSafely(session) {
  try {
    return session?.page?.url?.() ?? null;
  } catch (_error) {
    return null;
  }
}

// v1.8 perf: what `run-complete` carries to a *listener*, as opposed to what
// `run()` returns to its caller.
//
// The event used to carry the whole result — every step with its resolution,
// expectation, telemetry and (until this version) the page's full innerText.
// Measured at 2–3MB for a 58-step run on a light page. That object was
// structured-cloned across the Electron IPC boundary and then held in the
// panel's React state *per case*, which is how a 20-case batch put ~60MB of
// dead JSON in the renderer heap and took it toward OOM (the panel's "black
// screen").
//
// Consumers of the event only ever read the verdict, the counters, the error and
// the evidence paths — the per-step array is read from `report.json` on demand.
// `run()`'s return value is deliberately NOT slimmed: `test-session-runner`
// aggregates it into the round artifact on disk.
function slimRunResultForEvent(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const { data, ...rest } = result;
  if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
    return result;
  }
  const { results, ...dataRest } = data;
  return {
    ...rest,
    data: {
      ...dataRest,
      // The step array is the payload; it stays reachable via the counters plus
      // `evidence.reportPath`. `resultsOmitted` exists so a consumer can tell
      // "there were no steps" from "the steps were not shipped in this event".
      resultsOmitted: results.length,
    },
  };
}

async function emitRunEvent(onEvent, event) {
  if (typeof onEvent !== "function" || !event) {
    return;
  }
  try {
    await onEvent(event);
  } catch (_error) {
    // Runtime progress delivery must never fail the run itself.
  }
}

function createAttemptSummary(result, attempt, maxAttempts) {
  return {
    attempt,
    maxAttempts,
    ok: Boolean(result?.ok),
    durationMs: Number(result?.telemetry?.durationMs || 0),
    error: result?.error
      ? {
          code: result.error.code || null,
          message: result.error.message || String(result.error),
          retryable: Boolean(result.error.retryable),
        }
      : null,
    evidence: result?.evidence || null,
    telemetry: result?.telemetry || null,
  };
}

function aggregateRetryTelemetry(attemptResults, retryDelayTotalMs, wallDurationMs) {
  const lastTelemetry = attemptResults.at(-1)?.telemetry || {};
  const durationMs = attemptResults.reduce(
    (total, item) => total + Number(item.durationMs || 0),
    Number(retryDelayTotalMs || 0),
  );
  if (attemptResults.length <= 1) {
    return lastTelemetry;
  }
  const stages = {};
  for (const attempt of attemptResults) {
    for (const [stage, value] of Object.entries(attempt.telemetry?.stages || {})) {
      if (stage === "total") {
        continue;
      }
      stages[stage] = Number(stages[stage] || 0) + Number(value || 0);
    }
  }
  stages.retryDelay = Number(retryDelayTotalMs || 0);
  stages.total = durationMs;
  return {
    ...lastTelemetry,
    durationMs,
    wallDurationMs,
    stages,
    attempts: attemptResults.map((item) => ({
      attempt: item.attempt,
      ok: item.ok,
      durationMs: item.durationMs,
    })),
  };
}

// REQ-Z12: a step attempt that blew its hard deadline never returned a result,
// so we synthesize one that is shaped exactly like `executeAction`'s output.
// Downstream (diagnostics / summary / report / evidence index) then treats it as
// an ordinary failed step instead of choking on a missing result.
// `cause` is the HardTimeoutError that actually fired: either the step deadline
// itself, or one of the bounded page probes (which surfaces earlier, at ~20s).
// Reporting its label/budget keeps the trace honest about what timed out.
function createHardTimeoutResult(action, hardTimeoutMs, attemptNumber, maxAttempts, tracePath = null, cause = null) {
  const telemetry = {
    durationMs: hardTimeoutMs,
    evidenceProfile: action.evidenceProfile || null,
    stages: { hardTimeout: hardTimeoutMs, total: hardTimeoutMs },
  };
  const evidence = { beforeScreenshotPath: null, afterScreenshotPath: null, ocrPath: null, tracePath };
  return {
    ok: false,
    type: action.kind,
    data: {
      action: {
        success: false,
        error: STEP_HARD_TIMEOUT_CODE,
        detail: "step-abandoned-after-hard-timeout",
        navigation: null,
        inputArtifacts: null,
        popupTrace: null,
        apiRequest: null,
        apiResponse: null,
      },
      resolution: null,
      executionPath: {
        target: null,
        action: action.kind || null,
        actionDetail: "step-abandoned-after-hard-timeout",
        actionError: STEP_HARD_TIMEOUT_CODE,
        fallback: null,
        risk: "hardTimeout",
        summary: `${action.kind} -> hard-timeout(${hardTimeoutMs}ms)`,
      },
      snapshot: { before: null, after: null },
      change: null,
      expectation: null,
      captures: [],
      telemetry,
      retry: { attempts: attemptNumber, retries: Math.max(0, attemptNumber - 1) },
      trace: { durationMs: hardTimeoutMs, telemetry },
      evidence,
    },
    error: buildError(
      STEP_HARD_TIMEOUT_CODE,
      `Step "${action.id || action.kind}" exceeded its hard timeout of ${hardTimeoutMs}ms and was force-failed ` +
        "so the run could continue (a step is never allowed to hang indefinitely).",
      {
        action: action.kind,
        stepId: action.id || null,
        stepIndex: action.index ?? null,
        hardTimeoutMs,
        declaredTimeoutMs: action.timeoutMs ?? null,
        attempt: attemptNumber,
        maxAttempts,
        timedOutAt: cause?.label || null,
        timedOutAfterMs: cause?.timeoutMs ?? hardTimeoutMs,
        timedOutKind: cause?.code || STEP_HARD_TIMEOUT_CODE,
      },
      false,
    ),
    telemetry,
    evidence,
    hardTimeout: {
      hardTimeoutMs,
      declaredTimeoutMs: action.timeoutMs ?? null,
      attempt: attemptNumber,
      timedOutAt: cause?.label || null,
      timedOutAfterMs: cause?.timeoutMs ?? hardTimeoutMs,
      timedOutKind: cause?.code || STEP_HARD_TIMEOUT_CODE,
    },
  };
}

// v1.4: a step that was in flight when the browser died. Same shape as
// `createHardTimeoutResult` (so diagnostics / summary / report treat it as an
// ordinary failed step) but with the *honest* cause: the renderer crashed, which
// for Chromium almost always means it ran out of memory. Crucially this is
// produced in milliseconds instead of after the step's hard deadline — the whole
// point of listening to `page.on('crash')`.
// No screenshot is attempted: the target is gone, so every evidence call would
// only park until its own probe deadline expired.
function createBrowserCrashResult(action, failure, attemptNumber, maxAttempts, durationMs, tracePath = null) {
  const code = failure?.code || BROWSER_OOM_CODE;
  const detail = `step-abandoned-after-${failure?.crashKind || "browser-crash"}`;
  const telemetry = {
    durationMs,
    evidenceProfile: action.evidenceProfile || null,
    stages: { browserCrash: durationMs, total: durationMs },
  };
  const evidence = { beforeScreenshotPath: null, afterScreenshotPath: null, ocrPath: null, tracePath };
  const heapNote = failure?.heapUsedMb
    ? ` JS heap was ${failure.heapUsedMb}MB at that point (peak ${failure.peakHeapUsedMb ?? failure.heapUsedMb}MB).`
    : "";
  return {
    ok: false,
    type: action.kind,
    data: {
      action: {
        success: false,
        error: code,
        detail,
        navigation: null,
        inputArtifacts: null,
        popupTrace: null,
        apiRequest: null,
        apiResponse: null,
      },
      resolution: null,
      executionPath: {
        target: null,
        action: action.kind || null,
        actionDetail: detail,
        actionError: code,
        fallback: null,
        risk: "browserCrash",
        summary: `${action.kind} -> ${failure?.crashKind || "browser-crash"}`,
      },
      snapshot: { before: null, after: null },
      change: null,
      expectation: null,
      captures: [],
      telemetry,
      retry: { attempts: attemptNumber, retries: Math.max(0, attemptNumber - 1) },
      trace: { durationMs, telemetry },
      evidence,
    },
    error: buildError(
      code,
      `Step "${action.id || action.kind}" was abandoned because the browser died mid-step ` +
        `(${failure?.crashKind || "browser-crash"}).${heapNote} ${failure?.message || ""}`.trim(),
      {
        action: action.kind,
        stepId: action.id || null,
        stepIndex: action.index ?? null,
        crashKind: failure?.crashKind || null,
        heapUsedMb: failure?.heapUsedMb ?? null,
        peakHeapUsedMb: failure?.peakHeapUsedMb ?? null,
        peakNodes: failure?.peakNodes ?? null,
        attempt: attemptNumber,
        maxAttempts,
      },
      // Retriable at the *run* level: the visible channel rebuilds the browser
      // and reruns once. Not retriable at the step level (see below).
      true,
    ),
    telemetry,
    evidence,
    browserCrash: {
      code,
      crashKind: failure?.crashKind || null,
      attempt: attemptNumber,
      heapUsedMb: failure?.heapUsedMb ?? null,
      peakHeapUsedMb: failure?.peakHeapUsedMb ?? null,
    },
  };
}

// Best-effort trace for a step killed by a browser crash. Mirrors
// `writeHardTimeoutTrace`: JSON only, no page access.
async function writeBrowserCrashTrace(context, action, failure, attemptNumber, maxAttempts) {
  const artifactStore = context.artifactStore;
  if (!artifactStore || typeof artifactStore.saveJson !== "function") {
    return null;
  }
  const suffix = maxAttempts > 1 ? `attempt-${attemptNumber}-trace` : "trace";
  try {
    return await artifactStore.saveJson(action.index, suffix, {
      input: action.raw,
      normalizedAction: { id: action.id, kind: action.kind, query: action.query, timeoutMs: action.timeoutMs },
      finalStatus: "failed",
      errorClassification: failure?.code || BROWSER_OOM_CODE,
      browserCrash: {
        code: failure?.code || BROWSER_OOM_CODE,
        crashKind: failure?.crashKind || null,
        message: failure?.message || null,
        heapUsedMb: failure?.heapUsedMb ?? null,
        peakHeapUsedMb: failure?.peakHeapUsedMb ?? null,
        peakNodes: failure?.peakNodes ?? null,
        attempt: attemptNumber,
        reason:
          "The browser target died while this step was running. Playwright reports a Chromium renderer " +
          "out-of-memory kill as page.on('crash'); no screenshot could be taken because the target was gone.",
      },
    });
  } catch (_error) {
    return null;
  }
}

// Best-effort trace for a hard-timed-out step. The requirement is explicit that
// such a step must still leave evidence behind ("判失败、写 trace").
async function writeHardTimeoutTrace(context, action, hardTimeoutMs, attemptNumber, maxAttempts, cause = null) {
  const artifactStore = context.artifactStore;
  if (!artifactStore || typeof artifactStore.saveJson !== "function") {
    return null;
  }
  // Same suffix convention `executeAction` uses, so the timed-out attempt sits
  // alongside its siblings in `steps/` instead of shadowing them.
  const suffix = maxAttempts > 1 ? `attempt-${attemptNumber}-trace` : "trace";
  try {
    return await artifactStore.saveJson(action.index, suffix, {
      input: action.raw,
      normalizedAction: { id: action.id, kind: action.kind, query: action.query, timeoutMs: action.timeoutMs },
      finalStatus: "failed",
      errorClassification: STEP_HARD_TIMEOUT_CODE,
      hardTimeout: {
        hardTimeoutMs,
        declaredTimeoutMs: action.timeoutMs ?? null,
        navigationTimeoutMs: action.navigationTimeoutMs ?? null,
        attempt: attemptNumber,
        // Which bounded operation actually fired: the step deadline, or an
        // individual page probe (`page.evaluate` / `page.screenshot`).
        timedOutAt: cause?.label || null,
        timedOutAfterMs: cause?.timeoutMs ?? hardTimeoutMs,
        timedOutKind: cause?.code || STEP_HARD_TIMEOUT_CODE,
        reason:
          "The step attempt did not settle within its hard deadline (typically a wedged renderer parking a " +
          "page probe) and was abandoned. Playwright page.evaluate has no timeout of its own, so the platform " +
          "enforces one.",
      },
      durationMs: hardTimeoutMs,
    });
  } catch (_error) {
    return null;
  }
}

async function executeWithRetries(context, execute = executeAction) {
  const { action, signal, health } = context;
  const authorRetries = Math.max(0, Number(action.retries) || 0);
  // Upper bound on attempts: author retries + 1 initial + platform transient budget.
  const maxAttempts = authorRetries + 1 + TRANSIENT_RETRY_BUDGET;
  // REQ-Z12: every attempt runs under a wall-clock hard deadline. Without it a
  // single unbounded Playwright call (page.evaluate has no timeout) parks the
  // step — and with it the whole run and its queue slot — forever.
  const hardTimeoutMs = resolveStepHardTimeoutMs(action);
  const retryStartedAt = Date.now();
  const attemptResults = [];
  let retryDelayTotalMs = 0;
  let transientRetries = 0;
  const transientErrors = [];
  let lastResult = null;
  let attempt = 0;
  let hardTimedOut = false;
  let browserCrashed = false;
  // Unified attempt loop: consume the author's retries first, then — only for
  // *transient* failures — draw down the platform self-heal budget.
  for (;;) {
    assertNotAborted(signal);
    const attemptNumber = attempt + 1;
    // v1.4: never start an attempt on a browser that is already gone — that is
    // how a crash used to cost one full hard deadline per remaining step.
    if (health?.isUnhealthy()) {
      const failure = health.getFailure();
      const tracePath = await writeBrowserCrashTrace(context, action, failure, attemptNumber, maxAttempts);
      lastResult = createBrowserCrashResult(action, failure, attemptNumber, maxAttempts, 0, tracePath);
      attemptResults.push(createAttemptSummary(lastResult, attemptNumber, maxAttempts));
      browserCrashed = true;
      break;
    }
    const attemptStartedAt = Date.now();
    try {
      // Three racers: the step's own hard deadline, the caller's abort signal,
      // and — new in v1.4 — the browser's health. The third one is what turns a
      // renderer OOM from "wait out the deadline" into "fail in milliseconds".
      const attemptPromise = raceAbort(
        withHardTimeout(
          () => execute({
            ...context,
            artifactAttempt: maxAttempts > 1 ? attemptNumber : null,
            maxAttempts,
          }),
          hardTimeoutMs,
          { label: `step ${action.index ?? "?"} (${action.kind})`, detail: action.id || null },
        ),
        signal,
      );
      if (health) {
        // Swallow the loser's settlement so an abandoned attempt can never
        // surface as an unhandled rejection (same discipline as withHardTimeout).
        attemptPromise.catch(() => {});
        const outcome = await Promise.race([
          attemptPromise.then((value) => ({ kind: "result", value }), (error) => ({ kind: "error", error })),
          health.waitForFailure().then((failure) => ({ kind: "crash", failure })),
        ]);
        if (outcome.kind === "crash") {
          const tracePath = await writeBrowserCrashTrace(context, action, outcome.failure, attemptNumber, maxAttempts);
          lastResult = createBrowserCrashResult(
            action,
            outcome.failure,
            attemptNumber,
            maxAttempts,
            Date.now() - attemptStartedAt,
            tracePath,
          );
          attemptResults.push(createAttemptSummary(lastResult, attemptNumber, maxAttempts));
          browserCrashed = true;
          break;
        }
        if (outcome.kind === "error") {
          throw outcome.error;
        }
        lastResult = outcome.value;
      } else {
        lastResult = await attemptPromise;
      }
    } catch (error) {
      // A crash can also surface as a thrown Playwright error ("Target crashed")
      // that beats our listener. Classify it here so it takes the crash path
      // rather than being retried against a dead page.
      const crashFailure = health?.noteError(error) || null;
      if (crashFailure) {
        const tracePath = await writeBrowserCrashTrace(context, action, crashFailure, attemptNumber, maxAttempts);
        lastResult = createBrowserCrashResult(
          action,
          crashFailure,
          attemptNumber,
          maxAttempts,
          Date.now() - attemptStartedAt,
          tracePath,
        );
        attemptResults.push(createAttemptSummary(lastResult, attemptNumber, maxAttempts));
        browserCrashed = true;
        break;
      }
      if (!isHardTimeoutError(error)) {
        throw error;
      }
      const tracePath = await writeHardTimeoutTrace(context, action, hardTimeoutMs, attemptNumber, maxAttempts, error);
      lastResult = createHardTimeoutResult(action, hardTimeoutMs, attemptNumber, maxAttempts, tracePath, error);
      attemptResults.push(createAttemptSummary(lastResult, attemptNumber, maxAttempts));
      hardTimedOut = true;
      // A hang is terminal for this step: retrying it just burns another full
      // deadline on the same wedged page.
      break;
    }
    attemptResults.push(createAttemptSummary(lastResult, attemptNumber, maxAttempts));
    if (lastResult.ok) {
      break;
    }
    // v1.4: the most common way a crash actually reaches us. `executeAction`
    // catches Playwright's rejection and returns a *failed result*, so the
    // "Target crashed" evidence arrives as `result.error`, not as a throw. Feed
    // it to the monitor so the run learns the browser is dead — otherwise the
    // step gets retried against a corpse and the run is later mislabelled a
    // plain `batch-partial-failure`.
    if (health?.noteError(lastResult.error)) {
      browserCrashed = true;
      break;
    }
    let delayMs = 0;
    if (attempt < authorRetries) {
      // Author-declared retry (any failure kind).
      delayMs = action.retryDelayMs;
    } else if (isTransientError(lastResult.error) && transientRetries < TRANSIENT_RETRY_BUDGET) {
      // Platform self-heal for a known transient jitter.
      transientRetries += 1;
      transientErrors.push({
        code: lastResult.error?.code || null,
        message: lastResult.error?.message || String(lastResult.error),
      });
      delayMs = Math.max(action.retryDelayMs || 0, TRANSIENT_RETRY_DELAY_MS);
    } else {
      // No retry budget left (or a non-transient failure) — this is a real failure.
      break;
    }
    if (delayMs > 0) {
      await raceAbort(context.page.waitForTimeout(delayMs), signal);
      retryDelayTotalMs += delayMs;
    }
    attempt += 1;
  }
  if (!lastResult) {
    return lastResult;
  }
  const wallDurationMs = Date.now() - retryStartedAt;
  const telemetry = aggregateRetryTelemetry(attemptResults, retryDelayTotalMs, wallDurationMs);
  const selfHealed = Boolean(lastResult.ok && transientRetries > 0);
  const retry = {
    attempts: attemptResults.length,
    retries: Math.max(0, attemptResults.length - 1),
    authorRetries,
    transientRetries,
    // True when a transient jitter was retried and the step ultimately passed —
    // lets reports distinguish "self-healed flake" from "real failure".
    selfHealed,
    transientErrors,
    maxAttempts,
    // REQ-Z12: surfaced so reports/diagnosis can tell "the step failed" from
    // "the step never came back and the platform force-failed it".
    hardTimedOut,
    // v1.4: "the browser died under this step" — distinct from a timeout, so a
    // report can tell an OOM crash apart from a slow page.
    browserCrashed,
    hardTimeoutMs,
    retryDelayTotalMs,
    totalDurationMs: Number(telemetry?.durationMs || 0),
    wallDurationMs,
    attemptResults,
  };
  const evidence = {
    ...(lastResult.evidence || {}),
    attempts: attemptResults.map((item) => ({
      attempt: item.attempt,
      ok: item.ok,
      durationMs: item.durationMs,
      error: item.error,
      ...item.evidence,
    })),
  };
  lastResult.telemetry = telemetry;
  lastResult.evidence = evidence;
  if (lastResult.data) {
    lastResult.data.retry = retry;
    lastResult.data.telemetry = telemetry;
    lastResult.data.evidence = evidence;
    lastResult.data.trace = {
      ...(lastResult.data.trace || {}),
      durationMs: Number(telemetry?.durationMs || 0),
      telemetry,
    };
  }
  return lastResult;
}

// v1.10 Z27-5: `options.secretValues` (e.g. a credential's password) are masked
// everywhere this run writes or returns data — artifact JSON, progress events
// and the result object. Wrapped around the whole run so no return path (early
// failure, abort, normal finish) can bypass it.
async function run(payload, options = {}) {
  const redactor = createSecretRedactor(options.secretValues);
  if (!redactor.active) {
    return runUnredacted(payload, options);
  }
  const innerOnEvent = options.onEvent;
  const result = await runUnredacted(payload, {
    ...options,
    secretRedactor: redactor,
    ...(typeof innerOnEvent === "function"
      ? { onEvent: (event) => innerOnEvent(redactor.redact(event)) }
      : {}),
  });
  return redactor.redact(result);
}

// v1.10 Z27: a run-target reference nobody resolved. Every channel that accepts
// a `target` materialises origins before calling run(); reaching here with one
// left means the run was started without a target (e.g. a manual panel run of
// a migrated file). Navigating to the literal "{{origin.app}}/x" fails with an
// unreadable URL error — say what is actually missing instead.
function findUnresolvedRunTargetReferences(value, variables) {
  const missing = new Set();
  const visit = (node) => {
    if (typeof node === "string") {
      if (!node.includes("{{")) {
        return;
      }
      for (const match of node.matchAll(/\{\{\s*((?:origin|credential)\.[A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g)) {
        if (!Object.prototype.hasOwnProperty.call(variables, match[1])) {
          missing.add(match[1]);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return [...missing].sort();
}

async function runUnredacted(payload, options = {}) {
  // Steps and the start URL only: `recovery` is checked when a login actually
  // runs (see executeRecoverySteps).
  const unresolvedTargetRefs = findUnresolvedRunTargetReferences(
    { payload, url: options.url || null },
    options.runtimeVariables || {},
  );
  if (unresolvedTargetRefs.length) {
    const origins = unresolvedTargetRefs.filter((name) => name.startsWith("origin."));
    const error = new Error(
      `This run references ${unresolvedTargetRefs.map((name) => `{{${name}}}`).join(", ")} but no run target supplied ` +
        `${origins.length ? "those origins" : "that credential"}. Start it with target.origins` +
        `${origins.length === unresolvedTargetRefs.length ? "" : " / target.credentialRef"} (POST /test-sessions, run_headless, run_app).`,
    );
    error.code = origins.length ? "target-origin-missing" : "target-credential-missing";
    error.retryable = false;
    error.details = { missing: unresolvedTargetRefs };
    throw error;
  }
  const signal = options.signal || null;
  const testContext = options.testContext && typeof options.testContext === "object" ? options.testContext : null;
  // `let`: v1.11 REQ-Z30 adds the measured viewport once the page exists.
  let runContext = options.runContext && typeof options.runContext === "object" ? options.runContext : null;
  // v1.11 REQ-Z30: the viewport this run must render at (case > file > none).
  const parsedViewport = parseViewport(options.viewport);
  if (parsedViewport.errors.length) {
    const error = new Error(parsedViewport.errors.join("; "));
    error.code = "invalid-viewport";
    throw error;
  }
  const requestedViewport = parsedViewport.viewport;
  let restoreViewport = null;
  const stopOnFailure = options.stopOnFailure !== false;
  const stopAfterScaffoldFailure = options.stopAfterScaffoldFailure === true;
  const stopAfterCaseFailure = options.stopAfterCaseFailure === true;
  assertNotAborted(signal);
  const artifactStore = await ArtifactStore.create({
    outputDir: options.outputDir,
    runId: options.runId,
  });
  artifactStore.setRedactor(options.secretRedactor || null);
  const runId = artifactStore.runId;
  // v1.6 Z-E: visual baselines live OUTSIDE the per-run directory (they must
  // survive the run that recorded them): `<output>/visual-baselines/<profile>/`.
  const visualBaselineRoot =
    options.visualBaselineRoot ||
    path.join(path.dirname(path.resolve(options.outputDir || path.join(process.cwd(), "output", "runs"))), "visual-baselines");
  // Z11: if resuming, load the checkpoint up front — it restores the created-data
  // ids (runtimeVariables snapshot) and the browser state (storageState), and
  // tells us which step to resume after. Loaded before runtimeVariables/session so
  // both can be seeded from it.
  const resumeCheckpoint = options.resume && options.resume.dir
    ? await loadCheckpoint(options.resume.dir)
    : null;
  // v1.6 Z-I: the data tenant. Resolved before runtime variables so
  // `{{tenantPrefix}}` is available to the very first造数 step — a prefix that
  // arrives after the first entity is created is worse than none, because half
  // the round's data would be untraceable.
  const dataTenantConfig = normalizeDataTenant(options.dataTenant, runId);
  const dataTenant = dataTenantConfig
    ? new DataTenantRegistry({ prefix: dataTenantConfig.prefix, runId })
    : null;
  const runtimeVariables = createRuntimeVariables({
    runId,
    overrides: {
      ...(dataTenantConfig ? { tenantPrefix: dataTenantConfig.prefix } : {}),
      ...(options.runtimeVariables || {}),
      ...(resumeCheckpoint && resumeCheckpoint.runtimeVariables ? resumeCheckpoint.runtimeVariables : {}),
    },
  });
  const runtimeVariableSources = createRuntimeVariableSources({
    overrides: options.runtimeVariables,
    sources: options.runtimeVariableSources,
  });
  const normalizeOptions = {
    profile: options.profile,
    runProfile: options.runProfile,
    evidenceProfile: options.evidenceProfile,
  };
  const normalized = normalizePayload(payload, normalizeOptions);
  const materializeAction = (action) => {
    const [nextAction] = normalizePayload(
      [interpolateRuntimeTemplates(action.raw || action, runtimeVariables)],
      normalizeOptions,
    ).actions;
    return {
      ...nextAction,
      index: action.index,
      phase: nextAction.phase || action.phase,
      sourceFixture: nextAction.sourceFixture || action.sourceFixture,
      sourceMacro: nextAction.sourceMacro || action.sourceMacro,
    };
  };
  // Z11: a resume checkpoint's storageState (captured mid-chain, includes auth +
  // whatever the chain established) takes precedence over the plain auth profile.
  const effectiveStorageStatePath =
    (resumeCheckpoint && resumeCheckpoint.storageStatePath) || options.storageStatePath || null;
  const session = new RunSession({
    headless: options.headless ?? true,
    storageStatePath: effectiveStorageStatePath
      ? path.resolve(effectiveStorageStatePath)
      : null,
    ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? true,
    ...(requestedViewport ? { viewport: requestedViewport } : {}),
    // Z09: pass through the panel-aligned browser context (proxy/TLS/CORS/host).
    launchOptions: options.launchOptions ?? null,
    contextOptions: requestedViewport
      ? { ...(options.contextOptions || {}), viewport: requestedViewport }
      : options.contextOptions ?? null,
    page: options.page ?? null,
    context: options.context ?? null,
    browser: options.browser ?? null,
  });
  const ocrService = new OcrService();
  const startedAt = Date.now();
  // v1.4: watches THIS run's page for the death signals nobody used to listen
  // for — above all `page.on('crash')`, which is how a Chromium renderer that
  // ran out of memory announces itself. Created after `session.start()` below,
  // once there is a page to attach to (an injected visible page is already live;
  // a headless one is created by start()).
  let health = null;
  // v1.5 Z-A: watches THIS run's page for uncaught exceptions / console errors.
  // Created alongside `health` once a page exists.
  let diagnostics = null;
  // v1.11 REQ-Z31: request faults installed by `routeFault` steps. Removed
  // when the run ends so they cannot leak into the next case on a shared page.
  let routeFaults = null;
  // v1.5 Z-C: captures every download the page produces so its *contents* can be
  // asserted (and so the file survives the page closing).
  let downloads = null;
  // v1.6 Z-G: long tasks / DOM size / interaction latency. Installed lazily and
  // entirely advisory — it must never be the reason a run fails.
  let performance = null;
  // v1.6 Z-E: material collected by each visual assertion, written out as
  // `visual-review.json` for a human/LLM to judge appearance from.
  const visualReviewEntries = [];

  try {
    assertNotAborted(signal);
      await emitRunEvent(options.onEvent, {
        type: "run-start",
        runId,
        status: "running",
        totalSteps: normalized.actions.length,
        startedAt,
        runtimeVariables: { ...runtimeVariables },
        runtimeVariableSources: { ...runtimeVariableSources },
      });
    try {
      await raceAbort(session.start(), signal);
      // v1.11 REQ-Z30: an injected (visible) page outlives this run, so the
      // requested size is emulated now and cleared in `finally`. Then measure
      // what the page actually renders at — the evidence records the measured
      // size, and a mismatch fails the run instead of passing at the wrong width.
      let viewportMechanism = requestedViewport ? "context" : null;
      if (requestedViewport && options.page) {
        const applied = await raceAbort(applyInjectedViewport(session.page, requestedViewport), signal);
        restoreViewport = applied.restore;
        viewportMechanism = applied.mechanism;
      }
      const viewportRecord = describeViewport({
        requested: requestedViewport,
        source: options.viewportSource || null,
        effective: await measureViewport(session.page),
        mechanism: viewportMechanism,
      });
      runContext = { ...(runContext || {}), viewport: viewportRecord };
      if (requestedViewport && viewportRecord.matches !== true) {
        const effective = viewportRecord.effective;
        const mismatch = new Error(
          `Viewport ${requestedViewport.width}x${requestedViewport.height} was requested but the page renders at ` +
            `${effective ? `${effective.width}x${effective.height}` : "an unmeasurable size"}. ` +
            "A layout verdict at the wrong size would be meaningless, so the run stops here.",
        );
        mismatch.code = "viewport-not-applied";
        throw mismatch;
      }
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "runtime-aborted") {
        throw error;
      }
      // v1.11 REQ-Z30: viewport failures are not "the browser is unavailable" —
      // the visible channel would otherwise recreate the browser and retry.
      const startFailureCode = String(error?.code || "").startsWith("viewport-") ? error.code : "browser-unavailable";
      const telemetry = {
        durationMs: Date.now() - startedAt,
        steps: normalized.actions.length,
        okCount: 0,
        errorCount: normalized.actions.length,
        browserUrl: null,
      };
      const feedback = await artifactStore.writeRunFeedback({
        startedAt,
        finishedAt: Date.now(),
        mode: normalized.mode,
        evidenceProfile: normalized.evidenceProfile,
        testContext,
        runContext,
        runtimeVariables,
        runtimeVariableSources,
        input: normalized.input,
        summary: null,
        telemetry,
        error: {
          code: startFailureCode,
          message: error.message || "Failed to launch browser.",
        },
      });
      const failedResult = {
        ok: false,
        type:
          normalized.mode === "batch"
            ? "batch"
            : normalized.actions[0]?.kind ?? "run",
        data: null,
        error: buildError(
          startFailureCode,
          error.message || "Failed to launch browser.",
          { cause: String(error) },
          startFailureCode === "browser-unavailable",
        ),
        telemetry,
        testContext,
        runContext,
        runtimeVariables,
        runtimeVariableSources,
        input: normalized.input,
        evidenceProfile: normalized.evidenceProfile,
        evidence: {
          runDir: artifactStore.runDir,
          steps: [],
          reportPath: feedback.reportPath,
          summaryPath: feedback.summaryPath,
          markdownReportPath: feedback.markdownReportPath,
        },
      };
      await emitRunEvent(options.onEvent, {
        type: "run-complete",
        runId,
        status: "failed",
        finishedAt: Date.now(),
        telemetry,
        result: failedResult,
        error: failedResult.error,
        runtimeVariables: { ...runtimeVariables },
        runtimeVariableSources: { ...runtimeVariableSources },
      });
      return failedResult;
    }

    // v1.4: attach the health monitor as soon as there is a page. Everything
    // after this point — navigation, recovery, every step — is watched, so a
    // renderer OOM is noticed at once instead of being discovered one hard
    // deadline at a time.
    health = createBrowserHealthMonitor({ page: session.page, onEvent: options.onEvent, runId });
    routeFaults = new RouteFaultRegistry({ page: session.page });
    // v1.5 Z-A: attached at the same moment as the health monitor, i.e. BEFORE
    // the baseUrl navigation and before recovery — an app that throws during
    // bootstrap or login is exactly as broken as one that throws mid-case, and
    // used to be exactly as invisible.
    diagnostics = createPageDiagnostics({
      page: session.page,
      onEvent: options.onEvent,
      runId,
      policy: options.pageErrorPolicy ?? null,
      allowlist: options.pageErrorAllowlist ?? null,
      caseId: testContext?.caseId ?? null,
      // v1.9 REQ-Z23: `third-party` is judged relative to the product under test,
      // and the login window is recognised from the file's OWN recovery detects —
      // so the author never has to describe the login page a second time just to
      // keep its third-party scripts out of the gate.
      baseUrl: options.url || null,
      authPhaseDetects: collectRecoveryDetects(options.recovery),
      evaluateDetect,
    });
    diagnostics.setInjectedFaultMatcher?.((url) => routeFaults.matchesFaultedUrl(url));
    // Z-C: on by default. A run that downloads nothing pays one idle listener;
    // a run that downloads something can finally be asked what was in it.
    if (options.captureDownloads !== false) {
      downloads = new DownloadCollector({
        page: session.page,
        artifactStore,
        onEvent: options.onEvent,
        runId,
      });
    }
    if (options.capturePerformance !== false) {
      performance = createPerformanceCollector({ page: session.page, runId });
      // Installed before navigation so a long task during bootstrap is counted:
      // a long task that happened before anybody was observing is unmeasurable
      // afterwards.
      await performance.install();
    }

    if (options.url) {
      await raceAbort(session.navigate(options.url), signal);
    }

    // v1.5 Z-B: fingerprint the artifact under test, then gate on freshness.
    // Placed after navigation (there must be a real page to read a build id
    // from) and BEFORE recovery/steps — a run against a stale bundle must not
    // spend minutes producing a verdict that cannot mean anything.
    let environmentFingerprint = null;
    let freshnessBlock = null;
    if (isEnvironmentFingerprintEnabled()) {
      try {
        environmentFingerprint = await raceAbort(
          collectEnvironmentFingerprint(session.page, {
            baseUrl: options.url || null,
            backendProbes: options.environment?.backendProbes || [],
            frontendProbe: options.environment?.frontendProbe || null,
          }),
          signal,
        );
      } catch (error) {
        if (error?.name === "AbortError" || error?.code === "runtime-aborted") {
          throw error;
        }
        // The fingerprint is evidence, not a dependency: a failed collection is
        // recorded as unknown, it never fails a run on its own.
        environmentFingerprint = {
          collectedAt: Date.now(),
          frontend: { source: "unknown", buildId: "unknown", reason: `collection failed: ${error?.message || error}` },
          backends: [],
          unknowns: [{ what: "environmentFingerprint", reason: String(error?.message || error) }],
          compositeId: "fe:unknown",
        };
      }
      if (options.environment?.freshness) {
        freshnessBlock = evaluateFreshness(environmentFingerprint, options.environment.freshness);
      }
      try {
        await artifactStore.saveRunJson("environment/fingerprint.json", {
          runId,
          testContext,
          ...environmentFingerprint,
          ...(freshnessBlock ? { freshness: freshnessBlock } : {}),
        });
      } catch (_error) {
        // best-effort persistence
      }
    }

    if (freshnessBlock) {
      // A third terminal state. NOT `failed` (nothing about the product was
      // disproved) and never `passed` (nothing was proved either) — see the
      // roadmap §4 discipline: "没测到" must never be expressible as green.
      const telemetry = {
        durationMs: Date.now() - startedAt,
        steps: normalized.actions.length,
        okCount: 0,
        errorCount: 0,
        browserUrl: readBrowserUrlSafely(session),
        environmentFingerprint,
        blocked: freshnessBlock,
        pageErrors: diagnostics?.getReport() || null,
      };
      const blockedError = buildError(
        freshnessBlock.blockedReason,
        freshnessBlock.message,
        { rule: freshnessBlock.rule, ...(freshnessBlock.details || {}) },
        // Retryable in the sense that fixing the environment and rerunning is
        // the correct response — there is nothing wrong with the test.
        true,
      );
      const feedback = await artifactStore.writeRunFeedback({
        startedAt,
        finishedAt: Date.now(),
        mode: normalized.mode,
        evidenceProfile: normalized.evidenceProfile,
        testContext,
        runContext,
        runtimeVariables,
        runtimeVariableSources,
        input: normalized.input,
        summary: null,
        telemetry,
        error: { code: blockedError.code, message: blockedError.message },
      });
      const blockedResult = {
        ok: false,
        blocked: true,
        blockedReason: freshnessBlock.blockedReason,
        type: normalized.mode === "batch" ? "batch" : normalized.actions[0]?.kind ?? "run",
        data: { results: [] },
        error: blockedError,
        telemetry,
        testContext,
        runContext,
        runtimeVariables,
        runtimeVariableSources,
        input: normalized.input,
        evidenceProfile: normalized.evidenceProfile,
        evidence: {
          runDir: artifactStore.runDir,
          steps: [],
          reportPath: feedback.reportPath,
          summaryPath: feedback.summaryPath,
          markdownReportPath: feedback.markdownReportPath,
        },
      };
      await emitRunEvent(options.onEvent, {
        type: "run-complete",
        runId,
        status: "blocked",
        finishedAt: Date.now(),
        telemetry,
        result: blockedResult,
        error: blockedError,
        runtimeVariables: { ...runtimeVariables },
        runtimeVariableSources: { ...runtimeVariableSources },
      });
      return blockedResult;
    }

    // Recovery (v1.2.1 recovery model): run declared "problem -> fix steps"
    // handlers on demand. Cases assume a stable, logged-in, persistent browser;
    // recovery is the ONLY place login logic runs — so we no longer text-guess
    // which steps are "login". Proactive (below) fixes a bad starting state
    // (e.g. a fresh/reused browser sitting on /login); reactive (in the loop)
    // fixes a mid-run session loss.
    // v1.9 REQ-Z22: what login/recovery actually did, as a first-class fact.
    //
    // The 2026-08-26 round burned 14 hours on this exact hole. `recovery.login`
    // ran and SUCCEEDED; the case went red for an unrelated reason; the only
    // artefact the QA could see was the third retry's screenshot (a degenerate
    // QR-code login page) and 98 page errors from the login transition. She
    // concluded "登录只有活人能做", wrote a blocking report, and stopped for the
    // night. Nothing in the results said "login succeeded" — recovery was a
    // platform-internal action, invisible to the caller by construction.
    //
    // So: every run now states, in `summary.authTrace`, whether a recovery fired,
    // which strategy, how many attempts, whether it worked and where it landed.
    // `succeeded: true` is the important direction — it turns "login is fine, the
    // red is something else" from a human inference into a machine-readable fact.
    const authTrace = {
      profile: runContext?.authProfile || options.authProfile || null,
      bootstrap: runContext?.authBootstrap || options.authBootstrap || null,
      // Prefer the session layer's verdict on the STORED profile when it has one:
      // it can tell "expired" (a credential existed and aged out) from "missing"
      // (there never was one), which the live-browser probe below cannot.
      statusBefore: runContext?.authStatusBefore || null,
      recovery: { triggered: false, strategy: null, attempts: 0, succeeded: null, finalUrl: null, tookMs: null },
      authenticatedAt: null,
    };
    const RECOVERY_INDEX_BASE = 100000;
    let recoveryStepSeq = 0;
    // Which recovery handlers count as "logging in". The conventional key is
    // `login`; anything whose key mentions login/auth is treated the same, so a
    // file that calls it `relogin` or `authRecovery` still gets an authTrace.
    const isLoginRecovery = (key) => /login|auth/i.test(String(key || ""));
    let loginAttempts = 0;
    const recordAuthSkip = () => {
      // The login detect fired but the browser already carried a credential
      // (v1.4 REQ-Z17 gate). That is not "no information" — it is the strongest
      // possible statement that auth is established, so it must be recorded as
      // such rather than left null for a reader to interpret.
      authTrace.statusBefore = authTrace.statusBefore || "ready";
      authTrace.recovery.succeeded = authTrace.recovery.succeeded ?? true;
      authTrace.recovery.strategy = authTrace.recovery.strategy || "already-authenticated";
      authTrace.authenticatedAt = authTrace.authenticatedAt || Date.now();
    };
    const buildRecoveryCtx = () => {
      let url = "";
      try {
        url = session.page?.url?.() || "";
      } catch (_error) {
        url = "";
      }
      return { url };
    };
    const executeRecoverySteps = async (recoveryKey, handler) => {
      const rawSteps = Array.isArray(handler?.steps) ? handler.steps : [];
      if (!rawSteps.length) {
        return { ok: true, attempts: 0 };
      }
      const recoveryActions = normalizePayload(rawSteps, normalizeOptions).actions;
      const recoveryStartedAt = Date.now();
      const login = isLoginRecovery(recoveryKey);
      if (login) {
        // v1.9 REQ-Z22: the login window opens here. Recorded BEFORE the steps
        // run, so a recovery that hangs or crashes still leaves "we were trying
        // to log in" in the trace instead of nothing at all.
        loginAttempts += 1;
        authTrace.recovery.triggered = true;
        authTrace.recovery.strategy = describeRecoveryStrategy(recoveryActions) || "account-password";
        authTrace.recovery.attempts = loginAttempts;
        // Reaching a login recovery at all means we did not start authenticated.
        // `statusBefore` may already be set by the auth gate (`ready`), in which
        // case we do not overwrite it.
        authTrace.statusBefore =
          authTrace.statusBefore || (authTrace.profile ? "expired" : "missing");
      }
      await emitRunEvent(options.onEvent, {
        type: "recovery-start",
        runId,
        recoveryKey,
        steps: recoveryActions.length,
        startedAt: recoveryStartedAt,
      });
      let ok = true;
      // v1.10 Z27: a login written as `{{credential.username}}` needs the run's
      // target to carry a credentialRef. Checked here — when a login is actually
      // needed — not at run start: a run whose storageState is still valid never
      // logs in and must not be refused for a credential it would not use.
      const unresolvedRecoveryRefs = findUnresolvedRunTargetReferences(rawSteps, runtimeVariables);
      if (unresolvedRecoveryRefs.length) {
        ok = false;
        if (login) {
          authTrace.recovery.error = {
            code: "target-credential-missing",
            missing: unresolvedRecoveryRefs,
            message:
              `Login was needed but ${unresolvedRecoveryRefs.map((name) => `{{${name}}}`).join(", ")} is not supplied — ` +
              "start the run with target.credentialRef (or a valid authProfile so no login is needed).",
          };
        }
      }
      for (const baseAction of unresolvedRecoveryRefs.length ? [] : recoveryActions) {
        assertNotAborted(signal);
        // Offset recovery step indices far above the case steps so their evidence
        // files never collide with the main run's step artifacts.
        const action = materializeAction({
          ...baseAction,
          index: RECOVERY_INDEX_BASE + recoveryStepSeq++,
          phase: "recovery",
          sourceRecovery: recoveryKey,
        });
        const stepResult = await executeWithRetries({
          page: session.page,
          action,
          ocrService,
          // v1.10 Z29-1: after-step OCR mode (default onFailure).
          stepOcr: options.stepOcr ?? null,
          artifactStore,
          runtimeVariables,
          runtimeVariableSources,
          runProfile: normalized.evidenceProfile,
          signal,
          // v1.5 Z-A: recovery steps run on the same page, so they are watched
          // too (a login page that throws is a real finding, not noise).
          diagnostics,
          downloads,
        });
        if (!stepResult.ok) {
          ok = false;
          break;
        }
      }
      if (login) {
        // v1.9 REQ-Z22: the answer the 14-hour round could not get. `succeeded`
        // is deliberately the *last* login outcome, not an OR across attempts: a
        // reactive re-login that finally worked means auth IS established now,
        // which is what a reader needs to know before blaming the login.
        authTrace.recovery.succeeded = ok;
        authTrace.recovery.tookMs = Date.now() - recoveryStartedAt;
        authTrace.recovery.finalUrl = buildRecoveryCtx().url || null;
        authTrace.authenticatedAt = ok ? Date.now() : null;
      }
      await emitRunEvent(options.onEvent, {
        type: "recovery-complete",
        runId,
        recoveryKey,
        ok,
        finishedAt: Date.now(),
        ...(login ? { authTrace: JSON.parse(JSON.stringify(authTrace)) } : {}),
      });
      return { ok, attempts: login ? loginAttempts : 0 };
    };
    // v1.4 REQ-Z17: is there a credential in the *live* browser context? Probed
    // at most once per run (proactive recovery is the only caller and it runs
    // before any step, so the answer cannot change underneath us).
    let authEvidenceProbe = null;
    const hasLiveAuthEvidence = async () => {
      if (authEvidenceProbe) {
        return authEvidenceProbe.value;
      }
      let value = false;
      try {
        const storageState = await withHardTimeout(
          () => session.captureStorageState(),
          AUTH_EVIDENCE_PROBE_TIMEOUT_MS,
          { label: "captureStorageState:recovery-auth-gate" },
        );
        value = hasAuthEvidence(storageState);
      } catch (_error) {
        // Probe failed / timed out -> behave exactly as before the gate existed.
        value = false;
      }
      authEvidenceProbe = { value };
      return value;
    };
    // A handler is auth-gated when it says so via `skipWhenAuthenticated`; the
    // conventional `login` key defaults to gated so existing files (which declare
    // login in a shared base and cannot be expected to be re-authored) benefit
    // without an edit.
    const isAuthGatedRecovery = (key, handler) => {
      const declared = handler?.skipWhenAuthenticated;
      return declared == null ? key === "login" : Boolean(declared);
    };
    const recoverySkips = [];
    const shouldSkipRecoveryAsAuthenticated = async (key, handler) => {
      if (!isRecoveryAuthGateEnabled() || !isAuthGatedRecovery(key, handler)) {
        return false;
      }
      return hasLiveAuthEvidence();
    };
    const runProactiveRecovery = async () => {
      if (!options.recovery) {
        return;
      }
      const MAX_ROUNDS = 3;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const fired = selectFiredRecoveries(options.recovery, buildRecoveryCtx());
        if (!fired.length) {
          return;
        }
        let executed = 0;
        for (const { key, handler } of fired) {
          if (await shouldSkipRecoveryAsAuthenticated(key, handler)) {
            recoverySkips.push({ key, reason: "authenticated" });
            if (isLoginRecovery(key)) {
              recordAuthSkip();
            }
            await emitRunEvent(options.onEvent, {
              type: "recovery-skipped",
              runId,
              recoveryKey: key,
              reason: "authenticated",
              at: Date.now(),
            });
            continue;
          }
          executed += 1;
          const outcome = await executeRecoverySteps(key, handler);
          if (!outcome.ok) {
            return; // recovery itself failed — let the main run surface the problem
          }
        }
        if (!executed) {
          // Everything that fired was gated away — re-evaluating the same detects
          // would just skip them again (the detect condition is intentionally
          // still true: we are on the login URL, we simply are not logged out).
          return;
        }
        // loop: re-evaluate detects to confirm the recovery cleared the condition
      }
    };

    // v1.9 REQ-Z22-3: state the starting auth state even when nothing fires.
    // `recovery.triggered: false` plus `statusBefore: "ready"` is the fact the
    // 14-hour round needed and could not get — an ABSENT field is exactly what
    // made "登录到底成没成" a guess. Probed only when auth is part of this run's
    // picture (a stored profile or a recovery map), and the result is the same
    // cached probe the v1.4 auth gate below consumes, so this costs one bounded
    // storageState read, not two.
    if (!authTrace.statusBefore && (options.storageStatePath || options.recovery)) {
      authTrace.statusBefore = (await hasLiveAuthEvidence())
        ? "ready"
        : authTrace.profile || options.storageStatePath
          ? "expired"
          : "missing";
    }
    if (authTrace.statusBefore === "ready") {
      authTrace.authenticatedAt = authTrace.authenticatedAt || Date.now();
    }

    await runProactiveRecovery();

    // Z11: resume from a checkpoint — skip every step before startIndex (they were
    // already executed and their state was restored via storageState + runtime
    // variables), and optionally persist a fresh checkpoint after a chosen step.
    // A checkpoint may target a step by id (robust to payload edits) or by index.
    const resumePlan = resumeCheckpoint ? planResume(normalized.actions, resumeCheckpoint) : null;
    const resumeStartIndex = Math.max(
      0,
      Number(options.startIndex) || 0,
      resumePlan ? resumePlan.startIndex : 0,
    );
    const checkpointConfig =
      options.checkpoint &&
      options.checkpoint.dir &&
      (Number.isInteger(options.checkpoint.atIndex) || options.checkpoint.atStepId)
        ? options.checkpoint
        : null;

    const results = [];
    let scaffoldSetupFailed = false;
    let caseStepFailed = false;
    // REQ-Z12: run-level wedge detection. Each step is already hard-bounded, so
    // these two guards only decide how *early* a wedged run gives up — the run
    // always reaches the end and writes a summary either way.
    const runHardTimeoutMs = Number.isFinite(Number(options.runTimeoutMs))
      ? Math.max(0, Number(options.runTimeoutMs))
      : RUN_HARD_TIMEOUT_MS;
    let consecutiveHardTimeouts = 0;
    let wedgedRun = null;
    // v1.10 Z29-4: a `reload` that is the run's first step, in a context this
    // run created and just navigated itself, followed directly by an `openUrl`,
    // reloads a page that is one second old and is about to be replaced anyway.
    // That is exactly the shared `fxHome`/`fxCatalog` opening (reload → openUrl),
    // which exists to reset the *visible* channel's long-lived page between
    // cases; headless cases already start in a fresh context. Measured at a
    // median 3.8s per case. An injected page (visible channel) never elides.
    let leadingReloadElidable =
      Boolean(options.url) &&
      !options.page &&
      options.elideLeadingReload !== false &&
      !/^(0|false|no)$/i.test(String(process.env.ZHUZHU_ELIDE_LEADING_RELOAD || "").trim());
    for (const [actionPosition, baseAction] of normalized.actions.entries()) {
      assertNotAborted(signal);
      if (stopAfterScaffoldFailure && scaffoldSetupFailed) {
        break;
      }
      if (!wedgedRun && consecutiveHardTimeouts >= HARD_TIMEOUT_CIRCUIT_BREAK) {
        wedgedRun = {
          code: "run-wedged",
          message:
            `${consecutiveHardTimeouts} consecutive steps exceeded their hard timeout — the page/browser is ` +
            "wedged. Abandoning the remaining steps and finalizing the run so it cannot hang or hold its slot.",
        };
      }
      if (!wedgedRun && runHardTimeoutMs > 0 && Date.now() - startedAt > runHardTimeoutMs) {
        wedgedRun = {
          code: "run-hard-timeout",
          message: `Run exceeded its hard wall-clock budget of ${runHardTimeoutMs}ms. Remaining steps were stopped.`,
        };
      }
      // v1.4: the browser is gone. Reuse the wedged-run path (mark the rest
      // stopped, finalize, still write a summary) but with the honest cause —
      // and, unlike the timeout-driven breaker, without paying a single deadline
      // first. This is what turns "run file freezes on OOM" into a fast failure.
      if (!wedgedRun && health?.isUnhealthy()) {
        const failure = health.getFailure();
        wedgedRun = {
          code: failure.code,
          message: `${failure.message} Remaining steps were stopped.`,
        };
      }
      if (wedgedRun && !wedgedRun.announced) {
        wedgedRun.announced = true;
        await emitRunEvent(options.onEvent, {
          type: "run-wedged",
          runId,
          reason: wedgedRun.code,
          message: wedgedRun.message,
          at: Date.now(),
        });
      }
      const action = materializeAction(baseAction);
      const actionPhase = action.phase || "case";
      // v1.5 Z-A: stamp every page error with the step that was running. Set
      // before the step so an error fired during it is attributed correctly.
      diagnostics?.setStep({ stepId: action.id || null, stepIndex: action.index ?? null, phase: actionPhase });
      downloads?.setStep({ stepId: action.id || null, stepIndex: action.index ?? null });
      if (stopAfterCaseFailure && stopOnFailure && caseStepFailed && actionPhase === "case") {
        continue;
      }
      // v1.4: sample the renderer's JS heap BEFORE running the step (throttled).
      // Deliberately before, not after: once the renderer is dead no sample is
      // possible, so the reading that matters — "the heap right before it died" —
      // only exists if it was taken while the page was still alive. Advisory: a
      // failed or slow sample never affects the run.
      if (health && !wedgedRun) {
        await health.sampleMemory();
      }
      await emitRunEvent(options.onEvent, {
        type: "step-start",
        runId,
        stepIndex: action.index,
        stepId: action.id,
        // v1.11 REQ-Z33: the human title, so a progress view can say what is running.
        stepTitle: action.raw?.stepTitle || action.raw?.title || "",
        phase: action.phase || "case",
        sourceFixture: action.sourceFixture || "",
        sourceMacro: action.sourceMacro || "",
        actionType: action.kind,
        query: action.query ?? "",
        status: "running",
        startedAt: Date.now(),
        runtimeVariables: { ...runtimeVariables },
        runtimeVariableSources: { ...runtimeVariableSources },
      });
      const stepStartedAt = Date.now();
      const shouldSkipForSetupFailure =
        scaffoldSetupFailed && ["setup", "fixtureSetup", "case"].includes(actionPhase);
      const shouldStopForCaseFailure = stopOnFailure && caseStepFailed && actionPhase === "case";
      const shouldResumeSkip = action.index < resumeStartIndex;
      const nextAction = normalized.actions[actionPosition + 1] || null;
      const elideAsFreshReload =
        leadingReloadElidable &&
        action.kind === "reload" &&
        !action.expectation &&
        nextAction?.kind === "openUrl";
      leadingReloadElidable = false;
      let result = wedgedRun
        ? createStoppedResult(action, wedgedRun.code)
        : shouldResumeSkip
        ? createSkippedResult(action, "resumed-from-checkpoint")
        : elideAsFreshReload
        ? createSkippedResult(action, "elided-fresh-context-reload")
        : shouldSkipForSetupFailure
        ? createSkippedResult(action, "skipped-after-setup-failure")
        : shouldStopForCaseFailure
          ? createStoppedResult(action, "stopped-after-failed-step")
          : action.kind === "routeFault"
          ? await routeFaults.install(action)
          : await executeWithRetries({
              page: session.page,
              action,
              ocrService,
              // v1.10 Z29-1: after-step OCR mode (default onFailure).
              stepOcr: options.stepOcr ?? null,
              artifactStore,
              runtimeVariables,
              runtimeVariableSources,
              runProfile: action.evidenceProfile || normalized.evidenceProfile,
              signal,
              // v1.4: lets the attempt lose the race to a browser crash.
              health,
              // v1.5 Z-A: backs the explicit `assertNoPageError` assertion.
              diagnostics,
              // v1.5 Z-C: backs `assertFile` (source.from = "download").
              downloads,
              // v1.6 Z-G: backs `assertPerf`.
              performance,
              // v1.6 Z-E: where baselines live, plus a sink for the actual
              // screenshot so a failure can show both images.
              visualBaselineRoot,
              visualProfile: options.visualProfile || normalized.evidenceProfile || "default",
              saveVisualArtifact: (relativePath, buffer) =>
                artifactStore.saveRunFile(relativePath, buffer).catch(() => null),
              collectVisualReview: (entry) => {
                visualReviewEntries.push(entry);
              },
              // v1.6 Z-I: backs `assertResidue` and receives creation registrations.
              dataTenant,
            });
      assertNotAborted(signal);
      // v1.4: a crashed browser cannot be recovered by re-running steps on it,
      // so skip reactive recovery entirely — otherwise the recovery steps would
      // each burn their own deadline against the same dead page.
      if (health?.isUnhealthy() && !result.ok) {
        action.__recoveryRetried = true;
      }
      // Reactive recovery: a step failed and a recovery detect now matches (e.g.
      // the session dropped mid-run and the app redirected to /login). Run the
      // matching recovery, then retry this step once. Gated by the detect, so
      // ordinary assertion failures on the app page don't trigger it.
      // v1.4 REQ-Z17: deliberately NOT auth-gated. Here we have an actual
      // failure, so a credential that exists but is server-side dead must still
      // be replaced by a real login — this is the path that keeps the gate above
      // safe.
      if (
        !result.ok &&
        !result.skipped &&
        !result.stopped &&
        options.recovery &&
        !action.__recoveryRetried
      ) {
        const reactive = selectReactiveRecoveries(options.recovery, buildRecoveryCtx());
        if (reactive.length) {
          let recovered = false;
          for (const { key, handler } of reactive) {
            const outcome = await executeRecoverySteps(key, handler);
            if (outcome.ok) {
              recovered = true;
            }
          }
          if (recovered) {
            action.__recoveryRetried = true;
            const retry = await executeWithRetries({
              page: session.page,
              action,
              ocrService,
              // v1.10 Z29-1: after-step OCR mode (default onFailure).
              stepOcr: options.stepOcr ?? null,
              artifactStore,
              runtimeVariables,
              runtimeVariableSources,
              runProfile: action.evidenceProfile || normalized.evidenceProfile,
              signal,
              diagnostics,
              downloads,
              performance,
              visualBaselineRoot,
              visualProfile: options.visualProfile || normalized.evidenceProfile || "default",
              saveVisualArtifact: (relativePath, buffer) =>
                artifactStore.saveRunFile(relativePath, buffer).catch(() => null),
              collectVisualReview: (entry) => {
                visualReviewEntries.push(entry);
              },
              dataTenant,
            });
            assertNotAborted(signal);
            result = retry;
          }
        }
      }
      // v1.5 Z-A: the gate. Consumed per step, so ONE page error fails the step
      // it happened under — not every step after it. Skipped for steps that
      // never ran (a stopped/skipped step cannot be blamed for an error).
      if (diagnostics?.isGateEnforcing() && !result.skipped && !result.stopped) {
        const pageErrorEntries = diagnostics.takeNewGateFailures();
        if (pageErrorEntries.length) {
          result = applyPageErrorGate(result, action, pageErrorEntries);
        }
      }
      // REQ-Z12: count consecutive hard timeouts to detect a wedged page early.
      if (result?.data?.retry?.hardTimedOut || result?.hardTimeout) {
        consecutiveHardTimeouts += 1;
      } else if (!result?.skipped && !result?.stopped) {
        consecutiveHardTimeouts = 0;
      }
      // v1.6 Z-I: register what this step created / cleaned. Two sources: the
      // author's explicit declaration on the step, and any capture whose value
      // carries this run's tenant prefix (a value with our prefix can only have
      // been created by us). Never allowed to affect the step's verdict.
      if (dataTenant && !result.skipped && !result.stopped) {
        try {
          const declaredCreate = action.raw?.registerCreated;
          if (declaredCreate) {
            const entries = Array.isArray(declaredCreate) ? declaredCreate : [declaredCreate];
            for (const entry of entries) {
              dataTenant.register({
                kind: entry?.kind || entry?.entity || "entity",
                identifier: interpolateRuntimeTemplates(entry?.identifier ?? entry, runtimeVariables),
                stepId: action.id || null,
                stepIndex: action.index ?? null,
              });
            }
          }
          const declaredClean = action.raw?.registerCleaned;
          if (declaredClean) {
            for (const entry of Array.isArray(declaredClean) ? declaredClean : [declaredClean]) {
              dataTenant.markCleaned(interpolateRuntimeTemplates(entry?.identifier ?? entry, runtimeVariables));
            }
          }
          for (const capture of result.data?.captures || []) {
            dataTenant.registerFromCapture({
              name: capture?.name,
              value: capture?.value,
              stepId: action.id || null,
              stepIndex: action.index ?? null,
            });
          }
          const baselineSnapshot = action.raw?.baselineGuardSnapshot;
          if (baselineSnapshot) {
            dataTenant.snapshotBaseline(
              baselineSnapshot === "after" ? "after" : "before",
              interpolateRuntimeTemplates(action.raw?.baselineGuardValues ?? {}, runtimeVariables),
            );
          }
        } catch (_error) {
          // Bookkeeping must never fail a step.
        }
      }
      artifactStore.recordStep(action.index, result.evidence);
      // Z11: after the designated step passes, snapshot browser state +
      // runtime-variable ids so a later run can resume from here. Never let a
      // checkpoint-save failure break the run itself.
      const matchesCheckpoint =
        checkpointConfig &&
        (checkpointConfig.atStepId
          ? action.id === checkpointConfig.atStepId
          : action.index === checkpointConfig.atIndex);
      if (matchesCheckpoint && result.ok) {
        try {
          const storageState = await session.captureStorageState();
          const saved = await saveCheckpoint(checkpointConfig.dir, {
            atIndex: action.index,
            atStepId: action.id || null,
            runtimeVariables,
            storageState,
          });
          await emitRunEvent(options.onEvent, {
            type: "checkpoint-saved",
            runId,
            stepIndex: action.index,
            stepId: action.id,
            checkpointPath: saved.checkpointPath,
            storageStatePath: saved.storageStatePath,
          });
        } catch (_error) {
          // checkpoint is best-effort; the run continues regardless.
        }
      }
      if (!result.ok && ["setup", "fixtureSetup"].includes(actionPhase)) {
        scaffoldSetupFailed = true;
      }
      if (!result.ok && actionPhase === "case") {
        caseStepFailed = true;
      }
      results.push({
        ...result,
        index: action.index,
        input: action.raw,
      });
      await emitRunEvent(options.onEvent, {
        type: "step-complete",
        runId,
        stepIndex: action.index,
        stepId: action.id,
        stepTitle: action.raw?.stepTitle || action.raw?.title || "",
        phase: actionPhase,
        sourceFixture: action.sourceFixture || "",
        sourceMacro: action.sourceMacro || "",
        actionType: action.kind,
        query: action.query ?? "",
        status: result.stopped ? "stopped" : result.skipped ? "skipped" : result.ok ? "passed" : "failed",
        durationMs: Date.now() - stepStartedAt,
        message: result.stopped
          ? "Step stopped after a previous case step failed."
          : result.skipped
          ? "Step skipped after setup failure."
          : result.ok
            ? "Step completed."
            : result.error?.message || `Step failed: ${action.kind}`,
        error: result.error ?? null,
        evidence: result.evidence ?? null,
        diagnostics: buildStepDiagnostics(result),
        runtimeVariables: { ...runtimeVariables },
        runtimeVariableSources: { ...runtimeVariableSources },
      });
    }

    // v1.11 REQ-Z31: stop faulting before reporting, then hold every fault to
    // its promise. A fault that intercepted nothing means the case observed the
    // normal path while believing it observed the failure path — that must not
    // read as green. Only added when nothing failed earlier: a case that already
    // stopped never reached the request, and a second red would bury the first.
    let routeFaultReport = null;
    let routeFaultCheckCount = 0;
    if (routeFaults?.hasFaults()) {
      await routeFaults.dispose();
      routeFaultReport = routeFaults.getReport();
      if (!wedgedRun && results.every((item) => item.ok)) {
        for (const fault of routeFaults.getUnmet()) {
          results.push({ ...buildUnmetResult(fault), index: fault.stepIndex, input: { id: `${fault.stepId || "routeFault"}::hit-check`, type: "routeFault", stepTitle: "routeFault 命中次数检查" } });
          routeFaultCheckCount += 1;
        }
      }
      try {
        await artifactStore.saveRunJson("network/route-faults.json", { runId, testContext, generatedAt: Date.now(), faults: routeFaultReport });
      } catch (_error) {
        // best-effort persistence
      }
    }

    // v1.4: index of the step the browser died under, for the crash report.
    const crashStepIndex = results.find((item) => item?.data?.retry?.browserCrashed || item?.browserCrash)?.index ?? null;
    const browserCrash = health?.getCrashReport(crashStepIndex) || null;
    const memory = health?.getMemoryReport() || null;

    // v1.5 Z-A: an error can also land *after* the last step settled (an async
    // throw, a late microtask, an error boundary rendering). Nobody is left to
    // blame for it, so it is attributed to the run rather than to a step — but
    // it must still turn the verdict red, otherwise "throws on unmount" stays
    // permanently invisible.
    const trailingPageErrors = diagnostics?.isGateEnforcing() ? diagnostics.takeNewGateFailures() : [];
    const pageErrorReport = diagnostics?.getReport() || null;
    // v1.5 Z-C: a download triggered by the last step may still be writing. Wait
    // for the in-flight saves before reporting, otherwise the evidence index can
    // miss the very file the case was about.
    if (downloads) {
      await downloads.settle();
    }
    const downloadReport = downloads?.getReport() || null;
    // v1.6 Z-G: one final sample so the report has an end-of-run reading even
    // when the file declared no `assertPerf`, then persist the timeline.
    if (performance) {
      await performance.sample({ label: "run-end" });
    }
    const performanceReport = performance?.getReport() || null;
    const dataResidue = dataTenant?.getReport() || null;
    if (dataResidue) {
      try {
        dataResidue.artifactPath = await artifactStore.saveRunJson("data-tenant.json", {
          runId,
          testContext,
          generatedAt: Date.now(),
          ...dataResidue,
        });
      } catch (_error) {
        // best-effort persistence
      }
    }
    const visualReview = buildVisualReview(visualReviewEntries);
    if (visualReview) {
      try {
        visualReview.artifactPath = await artifactStore.saveRunJson("visual-review.json", {
          runId,
          testContext,
          ...visualReview,
        });
      } catch (_error) {
        // best-effort persistence
      }
    }
    if (performanceReport) {
      try {
        performanceReport.artifactPath = await artifactStore.saveRunJson("performance.json", {
          runId,
          testContext,
          generatedAt: Date.now(),
          ...performanceReport,
        });
      } catch (_error) {
        // best-effort persistence
      }
    }
    if (pageErrorReport) {
      // v1.9 REQ-Z23-3: every distinct noise this run saw, clustered into
      // paste-ready scoped allowlist entries — ALL of them, in one round. Last
      // round's QA re-ran the 3-minute flow ten times because each round revealed
      // exactly one new message to allowlist (the noise is non-deterministic: the
      // AntD `rowKey` warning only fires once the SKU step renders its table).
      // Attached to the report itself so it survives into summary.json and the
      // repair context without another collection pass.
      pageErrorReport.suggestedAllowlist = diagnostics?.buildSuggestedAllowlist() || [];
      // A-2: recorded even when the gate is `off`. Turning the gate off must not
      // erase the evidence.
      try {
        pageErrorReport.artifactPath = await artifactStore.saveRunJson("diagnostics/page-errors.json", {
          runId,
          testContext,
          generatedAt: Date.now(),
          ...pageErrorReport,
        });
      } catch (_error) {
        // Diagnostics persistence is best-effort — never fail a run over it.
      }
    }

    const baseSummary =
      normalized.mode === "batch"
        ? summarizeBatch(results)
        : {
            ...results[0],
          };
    // v1.4: `summarizeBatch` flattens every failure into `batch-partial-failure`,
    // which hides the single most actionable fact a run can report. When the
    // browser died, say so at the run level — that is what the visible channel's
    // auto-recovery predicate and `get_run_summary` key on.
    const summaryAfterPageErrorGate =
      trailingPageErrors.length && baseSummary?.ok !== false
        ? {
            ...baseSummary,
            ok: false,
            error: buildError(
              PAGE_ERROR_CODE,
              describePageErrorFailure(trailingPageErrors),
              {
                phase: "after-last-step",
                pageErrors: trailingPageErrors.map((item) => ({
                  kind: item.kind,
                  message: item.message,
                  stack: item.stack,
                  at: item.at,
                  url: item.url,
                })),
              },
              false,
            ),
          }
        : baseSummary;

    const summary = browserCrash
      ? {
          ...summaryAfterPageErrorGate,
          ok: false,
          error: buildError(
            browserCrash.code,
            `The browser died during this run (${browserCrash.crashKind}). ` +
              (browserCrash.peakHeapUsedMb ? `Peak JS heap ${browserCrash.peakHeapUsedMb}MB. ` : "") +
              browserCrash.message,
            {
              crashKind: browserCrash.crashKind,
              atStepIndex: browserCrash.atStepIndex,
              heapUsedMb: browserCrash.heapUsedMb,
              peakHeapUsedMb: browserCrash.peakHeapUsedMb,
              peakNodes: browserCrash.peakNodes,
            },
            true,
          ),
        }
      : summaryAfterPageErrorGate;

    const telemetry = {
      durationMs: Date.now() - startedAt,
      steps: normalized.actions.length + routeFaultCheckCount,
      okCount: results.filter((item) => item.ok).length,
      errorCount: results.filter((item) => !item.ok).length,
      browserUrl: readBrowserUrlSafely(session),
      // v1.11 REQ-Z31: every request fault and how often it fired.
      ...(routeFaultReport ? { routeFaults: routeFaultReport } : {}),
      // REQ-Z12: present only when the platform force-ended a wedged run, so a
      // report reader can tell "the case failed" from "the browser wedged".
      hardTimeouts: results.filter((item) => item?.data?.retry?.hardTimedOut || item?.hardTimeout).length,
      wedged: wedgedRun ? { code: wedgedRun.code, message: wedgedRun.message } : null,
      // v1.4: "the browser died" vs "the page was merely slow" — the distinction
      // the OOM freeze report was missing. Present only when it actually died.
      browserCrash,
      // v1.4: renderer JS-heap telemetry (peak / last / DOM node peak). Null when
      // no sample could be taken (non-Chromium page, CDP unavailable).
      memory,
      // v1.4 REQ-Z17: proactive recovery handlers that were gated away because the
      // browser already carried a credential. Present only when something was
      // actually skipped, so a report reader can tell "re-login avoided" from
      // "never evaluated".
      ...(recoverySkips.length ? { recoverySkipped: recoverySkips } : {}),
      // v1.5 Z-A: always present when the gate ran (even with zero entries), so
      // a consumer can distinguish "watched, page was clean" from "this run
      // predates the gate" (field absent / null).
      pageErrors: pageErrorReport,
      // v1.5 Z-B: which build this verdict is actually about.
      environmentFingerprint,
      // v1.5 Z-C: files the page produced during this run (size/mime/sha256).
      downloads: downloadReport,
      // v1.6 Z-G: long-task / DOM-size timeline with the per-metric jitter band.
      // Regression material only — never an absolute performance promise.
      performance: performanceReport,
      // v1.6 Z-E: screenshots + box models + design tokens + peer diffs + a11y
      // facts. Material for a human/LLM appearance review, never a verdict.
      visualReview: visualReview
        ? { items: visualReview.items.length, artifactPath: visualReview.artifactPath ?? null }
        : null,
      // v1.6 Z-I: what this round created, what is still there, and whether any
      // declared-untouchable record drifted. Not a failure — but never invisible.
      dataResidue,
      // v1.9 REQ-Z22: what login/recovery did, always present (even when nothing
      // fired), so "was auth established for this run?" is answered in-band.
      authTrace,
    };

    const report = {
      startedAt,
      finishedAt: Date.now(),
      mode: normalized.mode,
      evidenceProfile: normalized.evidenceProfile,
      testContext,
      runContext,
      runtimeVariables,
      runtimeVariableSources,
      input: normalized.input,
      summary,
      telemetry,
      evidence: {
        runDir: artifactStore.runDir,
        steps: artifactStore.stepArtifacts,
      },
    };
    const feedback = await artifactStore.writeRunFeedback(report);

    const finalResult = {
      ...summary,
      telemetry,
      testContext,
      runContext,
      runtimeVariables,
      runtimeVariableSources,
      input: normalized.input,
      evidenceProfile: normalized.evidenceProfile,
      evidence: {
        runDir: artifactStore.runDir,
        steps: artifactStore.stepArtifacts,
        reportPath: feedback.reportPath,
        summaryPath: feedback.summaryPath,
        markdownReportPath: feedback.markdownReportPath,
      },
    };
    await emitRunEvent(options.onEvent, {
      type: "run-complete",
      runId,
      status: finalResult.ok ? "success" : "failed",
      finishedAt: Date.now(),
      telemetry,
      result: slimRunResultForEvent(finalResult),
      error: finalResult.error ?? null,
      runtimeVariables: { ...runtimeVariables },
      runtimeVariableSources: { ...runtimeVariableSources },
    });
    return finalResult;
  } finally {
    // REQ-Z12: teardown itself must be bounded. `context.close()` /
    // `storageState()` both talk to the renderer, so on a wedged page they can
    // park forever — which used to leave the caller (and the App-run queue slot)
    // hanging *after* the run had logically finished.
    // v1.4: detach the crash/close listeners before teardown, so closing the
    // context on purpose cannot look like a crash to a later reader.
    health?.dispose();
    // v1.5 Z-A: detach before teardown, so errors raised by the page *because*
    // we are tearing it down cannot be attributed to the test.
    diagnostics?.dispose();
    downloads?.dispose();
    // v1.11 REQ-Z31: never leave an interception on a page that outlives the run.
    if (routeFaults) {
      await withHardTimeout(() => routeFaults.dispose(), SESSION_CLOSE_HARD_TIMEOUT_MS, { label: "routeFaults.dispose" }).catch(() => {});
    }
    // v1.11 REQ-Z30: give the shared visible page its own size back.
    if (restoreViewport) {
      await withHardTimeout(() => restoreViewport(), SESSION_CLOSE_HARD_TIMEOUT_MS, { label: "viewport.restore" }).catch(() => {});
    }
    await Promise.allSettled([
      withHardTimeout(() => session.close(), SESSION_CLOSE_HARD_TIMEOUT_MS, { label: "session.close" }),
      withHardTimeout(() => ocrService.dispose(), SESSION_CLOSE_HARD_TIMEOUT_MS, { label: "ocrService.dispose" }),
    ]);
  }
}

module.exports = {
  executeWithRetries,
  run,
};
