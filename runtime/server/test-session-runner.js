const fs = require("node:fs/promises");
const path = require("node:path");
const { run: defaultRun } = require("..");
const {
  buildExecutableCaseSteps,
  isSafeRelativeTestFilePath,
  normalizeTestFile,
} = require("../../src/shared/test-file");
const {
  resolveAndNormalizeTestFile,
  resolveTestFileReferences,
} = require("../../src/shared/test-file-references");
const { precheckTestFile } = require("../../src/shared/test-file-precheck");
const { buildGateRunOptions } = require("../../src/shared/run-gate-options");
const { buildViewportRunOptions } = require("../../src/shared/viewport");
const { getRunBoard } = require("./run-board");
const { resolveCheckpointDir } = require("../executor/checkpoint-store");
const { launchSharedBrowser } = require("../executor/run-session");
const { HardTimeoutError, isHardTimeoutError, withHardTimeout } = require("../executor/hard-timeout");
const { createRuntimeVariables } = require("../protocol/runtime-vars");
const { getAuthProfileStatus } = require("./auth-profile");
const {
  buildAuthMatrixTable,
  normalizeAuthMatrix,
  readCredentialStore,
  toRuntimeVariables: credentialToRuntimeVariables,
} = require("./auth-bootstrap");
const { applyRunTarget, describeRunTarget, normalizeRunTarget } = require("../../src/shared/run-target");
const { probeHttp } = require("./preflight");
// v1.7 Z-N/Z-O: step-level progress + budget accounting, and an on-disk claim so
// a cancel can tell "abandoned" from "another process is running it".
const {
  createSessionEventBus,
  getSessionEventBus,
  retireSessionEventBus,
} = require("./session-events");
const {
  claimSession,
  inspectClaim,
  releaseSession,
} = require("./active-session-registry");
const { isProcessIsolationEnabled, runSessionInWorker } = require("./session-worker");
const { appendEngineFinding, createDiagnosis, createRepairContext, getStepInput, renderMarkdownReport } = require("./diagnosis");
const {
  buildEvidenceBundle,
  classifyStepFailureClass,
  writeEvidenceBundle,
} = require("../reporting/evidence-bundle");
// v1.9 REQ-Z24: joins a reach-class failure to the UI contract so "状态没到" and
// "testid 漂移" stop arriving as the same `target-not-found`.
const { diagnoseReach, isReachClassFailure } = require("./reach-diagnosis");
const {
  DEFAULT_OUTPUT_ROOT,
  TestSessionStore,
  isTerminalSessionStatus,
  summarizeSessionDoc,
} = require("./session-store");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_TEST_WORKFLOWS_ROOT = path.join(PROJECT_ROOT, "test-workflows");
// REQ-Z12-3 (需求单v3): a test session must ALWAYS terminate and always leave a
// `rounds/round-N/aggregate.json` behind. The reported failure mode was a
// session that only ever wrote `session.json` — no aggregate, no diagnosis, no
// HTTP response — because something inside the run never came back. This is the
// session's own wall-clock ceiling, independent of the visible App-run channel.
const DEFAULT_SESSION_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.ZHUZHU_SESSION_HARD_TIMEOUT_MS || 40 * 60 * 1000),
);
// 2026-10-27: a run can also wedge *between* steps (no step-start/step-complete
// event at all) — the step-level hard timeout never arms there, so the session sat
// on its 40min ceiling twice in one afternoon (session-20261027-112316, -105217:
// last trace at step 26, then silence for ~36min). An idle watchdog bounds that:
// no run event for this long ⇒ the run is wedged, abandon it like a hard timeout.
// Per-request override: `sessionIdleTimeoutMs` (0 disables).
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.ZHUZHU_SESSION_IDLE_TIMEOUT_MS || 5 * 60 * 1000),
);
// Launching Chromium can itself hang (contended profile dir, wedged host).
const BROWSER_LAUNCH_TIMEOUT_MS = Math.max(10_000, Number(process.env.ZHUZHU_BROWSER_LAUNCH_TIMEOUT_MS || 90_000));
// v1.4 REQ-Z15-2: how long a *blocking* submit is allowed to hold the HTTP /
// MCP call before it hands the caller a `partial:{sessionId, roundId}` handle
// and lets the session finish in the background. It exists because the caller's
// own client timeout is usually NOT under the caller's control (the MCP SDK
// default is 60s) while a long data-gen chain legitimately runs for minutes: a
// client-side timeout produces *zero information*, so the server must volunteer
// the handle before that happens. 0 = wait forever (pre-v1.4 behavior).
const DEFAULT_WAIT_TIMEOUT_MS = (() => {
  const raw = process.env.ZHUZHU_SESSION_WAIT_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === "") {
    return 50_000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 50_000;
})();
// v1.4 REQ-Z16-2: after `cancel` aborts the run we give it this long to unwind
// on its own (close the browser, persist its round). If it does not, the session
// document is force-finalized to `cancelled` so the caller always reaches a
// terminal status in bounded time.
const DEFAULT_CANCEL_GRACE_MS = Math.max(1_000, Number(process.env.ZHUZHU_SESSION_CANCEL_GRACE_MS || 20_000));

// v1.4: in-process registry of sessions still executing. It is what makes
// `wait:false` (Z15-1), `cancel` (Z16-2) and "is this handle still live" answerable
// without touching the filesystem. Terminal sessions are dropped — their truth
// lives on disk in `session.json`.
const activeSessions = new Map();

async function raceDeadline(operation, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error) {
  return Boolean(error && (error.name === "AbortError" || error.code === "runtime-aborted"));
}

// A submit is asynchronous when the caller says `wait:false` (or the legacy
// `async:true`). Otherwise it blocks, but only up to `waitTimeoutMs`.
function resolveWaitMode(request = {}) {
  const wait = request.wait === false || request.async === true ? false : true;
  const requested = Number(request.waitTimeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_WAIT_TIMEOUT_MS;
  return { wait, timeoutMs };
}

function resolveSessionIdleTimeoutMs(request = {}) {
  const requested = Number(request.sessionIdleTimeoutMs);
  if (Number.isFinite(requested) && requested >= 0) {
    return requested;
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

function resolveSessionTimeoutMs(request = {}) {
  const requested = Number(request.sessionTimeoutMs);
  if (Number.isFinite(requested) && requested > 0) {
    return requested;
  }
  return DEFAULT_SESSION_TIMEOUT_MS;
}

function isInsideDirectory(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pickRequestTestFile(body = {}) {
  return body.testFile || body.file || null;
}

function normalizeQualityGate(value) {
  return value === "off" || value === "advisory" || value === "gate" ? value : "advisory";
}

function shouldBlockForPrecheck(precheck, request = {}) {
  if (!precheck) {
    return false;
  }
  if (precheck.summary?.errorCount > 0) {
    return true;
  }
  if (request.allowBlocked === true) {
    return false;
  }
  return normalizeQualityGate(request.qualityGate) === "gate" && precheck.blocked;
}

async function resolveTestFile(body = {}, options = {}) {
  const inline = pickRequestTestFile(body);
  const root = path.resolve(options.testWorkflowsRoot || DEFAULT_TEST_WORKFLOWS_ROOT);
  if (inline && typeof inline === "object") {
    const resolvedRaw = resolveTestFileReferences(inline, { rootDir: root });
    const normalized = normalizeTestFile(resolvedRaw);
    return {
      raw: resolvedRaw,
      normalized,
      meta: {
        source: "inline",
        path: "",
        id: normalized.id,
        name: normalized.name,
      },
    };
  }
  if (!isSafeRelativeTestFilePath(body.testFilePath)) {
    const error = new Error("testFilePath must be a safe relative JSON path under test-workflows/ or testFile must be provided.");
    error.code = "invalid-test-file-path";
    error.statusCode = 400;
    throw error;
  }
  const target = path.resolve(root, body.testFilePath);
  if (!isInsideDirectory(target, root)) {
    const error = new Error("testFilePath is outside test-workflows/.");
    error.code = "invalid-test-file-path";
    error.statusCode = 400;
    throw error;
  }
  const raw = JSON.parse(await fs.readFile(target, "utf8"));
  const normalized = resolveAndNormalizeTestFile(raw, {
    rootDir: root,
    sourcePath: body.testFilePath,
  });
  return {
    raw,
    normalized,
    meta: {
      source: "path",
      path: body.testFilePath,
      absolutePath: target,
      id: normalized.id,
      name: normalized.name,
    },
  };
}

// ---- v1.10 Z27: run target ----------------------------------------------------

function createRequestError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.details = details;
  return error;
}

// Validates the caller's target and materialises `{{origin.*}}` in the resolved
// file. Throws a 400 (`invalid-target` / `target-origin-missing` /
// `target-origin-denied` / `target-auth-profile-conflict`) before any session
// document exists, so a mis-addressed run never even starts.
function prepareRunTarget(rawTarget, resolved, requestedAuthProfile) {
  const target = normalizeRunTarget(rawTarget ?? null);
  const applied = applyRunTarget(resolved.normalized, target);
  resolved.normalized = applied.testFile;
  const requested = String(requestedAuthProfile || "").trim();
  if (target?.authProfile && requested && target.authProfile !== requested) {
    throw createRequestError(
      "target-auth-profile-conflict",
      `authProfile "${requested}" and target.authProfile "${target.authProfile}" disagree; pass one of them.`,
      { authProfile: requested, targetAuthProfile: target.authProfile },
    );
  }
  return { target, applied, authProfile: requested || target?.authProfile || "" };
}

// What must hold before a targeted round may start. Returns the credential's
// runtime variables (as `credential.<field>`) and the secret values to mask, or
// a blocking error. Environment problems block the session (status `blocked`)
// rather than failing it: nothing was tested.
async function checkRunTargetGates({ target, applied, workspaceRoot, probe = probeHttp }) {
  const credentialVariables = {};
  const secretValues = [];
  if (!target) {
    return { ok: true, credentialVariables, secretValues };
  }
  if (target.credentialRef) {
    const store = await readCredentialStore(workspaceRoot);
    const entry = store[target.credentialRef];
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        error: {
          code: "target-credential-missing",
          message:
            `target.credentialRef "${target.credentialRef}" is not in ${workspaceRoot ? "the workspace's " : ""}.zhuzhu-credentials.json ` +
            `(known: ${Object.keys(store).join(", ") || "none"}).`,
        },
      };
    }
    const { variables, secretNames } = credentialToRuntimeVariables(entry);
    for (const [name, value] of Object.entries(variables)) {
      credentialVariables[`credential.${name}`] = value;
      if (secretNames.includes(name)) {
        secretValues.push(value);
      }
    }
  }
  const used = applied?.used || [];
  if (target.preflight && used.length) {
    const probes = await Promise.all(used.map(async (origin) => {
      const result = await probe(origin.url).catch((error) => ({ ok: false, status: null, error: error?.message || String(error) }));
      // Any HTTP answer below 502 means the service is up; a 4xx at the root of a
      // backend is normal. Connection failures and gateway errors are not.
      const reachable = result.status != null && ![502, 503, 504].includes(result.status);
      return { name: origin.name, url: origin.url, reachable, status: result.status ?? null, error: result.error || null };
    }));
    const down = probes.filter((item) => !item.reachable);
    if (down.length) {
      return {
        ok: false,
        probes,
        error: {
          code: "target-unreachable",
          message:
            `Target origin(s) not reachable: ${down.map((item) => `${item.name} ${item.url} (${item.error || `HTTP ${item.status}`})`).join("; ")}. ` +
            "Nothing was run.",
          details: { probes },
        },
      };
    }
    return { ok: true, credentialVariables, secretValues, probes };
  }
  return { ok: true, credentialVariables, secretValues };
}

function buildRootExecutionSteps(testFile, phase) {
  const firstCaseId = testFile.cases[0]?.id || null;
  if (!firstCaseId) {
    return [];
  }
  return buildExecutableCaseSteps(testFile, firstCaseId, {
    includeRootSetup: phase === "setup",
    includeFixtureSetup: false,
    includeCaseSteps: false,
    includeFixtureTeardown: false,
    includeRootTeardown: phase === "teardown",
  });
}

function buildCaseExecutionSteps(testFile, caseId) {
  return buildExecutableCaseSteps(testFile, caseId, {
    includeRootSetup: false,
    includeRootTeardown: false,
  });
}

function emptyRunResult(runId, testContext, runContext) {
  return {
    ok: true,
    type: "batch",
    data: { results: [] },
    telemetry: {
      durationMs: 0,
      steps: 0,
      okCount: 0,
      errorCount: 0,
      browserUrl: null,
    },
    testContext,
    runContext,
    evidence: {
      steps: [],
      runId,
    },
  };
}

function normalizeStepSearchText(step = {}) {
  return [
    step.id,
    step.stepTitle,
    step.title,
    step.name,
    step.target?.text,
    step.target?.name,
    step.target?.placeholder,
    step.target?.role,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isLoginBootstrapStart(step = {}) {
  const text = normalizeStepSearchText(step);
  return (
    text.includes("setup-login") ||
    text.includes("账号登陆") ||
    text.includes("账号登录") ||
    text.includes("account login") ||
    text.includes("login tab")
  );
}

function isLoginBootstrapSubmit(step = {}) {
  const text = normalizeStepSearchText(step).replace(/\s+/g, "");
  const role = String(step.target?.role || "").toLowerCase();
  const targetText = String(step.target?.text || step.target?.name || "").replace(/\s+/g, "");
  return (
    text.includes("click-login") ||
    text.includes("点击登录") ||
    text.includes("登录按钮") ||
    text.includes("登陆按钮") ||
    text.includes("loginbutton") ||
    ((targetText === "登录" || targetText === "登陆") && role === "button")
  );
}

function isAuthBootstrapPhase(step = {}) {
  return step.phase === "setup" || step.phase === "fixtureSetup";
}

function filterAuthenticatedAuthBootstrapSteps(steps = [], auth = {}, request = {}) {
  if (!auth?.authenticated || request.authBootstrap === "run") {
    return { steps, skipped: [] };
  }
  const source = Array.isArray(steps) ? steps : [];
  const skipped = [];
  const output = [];
  let skipping = false;
  for (const step of source) {
    if (!skipping && isAuthBootstrapPhase(step) && isLoginBootstrapStart(step)) {
      skipping = true;
    }
    if (skipping && isAuthBootstrapPhase(step)) {
      skipped.push(step);
      if (isLoginBootstrapSubmit(step)) {
        skipping = false;
      }
      continue;
    }
    output.push(step);
  }
  return { steps: output, skipped };
}

// v1.10 Z28-1: sources that describe what the round handed IN to a run. Only
// what a run produced itself (`capture`, `performance`, …) is carried forward.
const NON_CARRIED_VARIABLE_SOURCES = new Set(["builtin", "override", "file", "target"]);

function absorbRunCaptures(variables, sources, result) {
  const values = result?.runtimeVariables;
  const resultSources = result?.runtimeVariableSources;
  if (!values || typeof values !== "object" || !resultSources || typeof resultSources !== "object") {
    return [];
  }
  const absorbed = [];
  for (const [key, source] of Object.entries(resultSources)) {
    if (!source || NON_CARRIED_VARIABLE_SOURCES.has(source)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      continue;
    }
    variables[key] = values[key];
    sources[key] = source;
    absorbed.push(key);
  }
  return absorbed;
}

async function runSteps({
  runImpl,
  steps,
  runId,
  testFile,
  testFileMeta,
  auth,
  runtimeVariables,
  runtimeVariableSources = null,
  runContext,
  testContext,
  outputRunsRoot,
  browserContext = null,
  browser = null,
  checkpoint = null,
  resume = null,
  navigateToBaseUrl = false,
  stopAfterScaffoldFailure = false,
  stopAfterCaseFailure = false,
  // 2026-10-27: debug rounds may keep running a case past a failed step so one
  // round surfaces every broken step instead of exactly one (95% of red rounds
  // used to expose a single failure). Case phase only; setup always stops.
  stopOnFailure = true,
  // Z10 (需求单v2/v3): `false` runs this session in a *visible* browser of its
  // own. Combined with the batch worker pool this is the parallel multi-instance
  // channel — N files, N independent visible Chromiums, concurrency K — without
  // going through the panel's single resident browser.
  headless = true,
  // REQ-Z12: remaining wall-clock budget handed down to `run()`.
  runTimeoutMs = null,
  // v1.4 REQ-Z16-2: cooperative cancellation. `run()` already honours
  // `options.signal` (it checks between steps and races every await), so cancel
  // is just this signal reaching the orchestrator.
  signal = null,
  // v1.7 Z-N: step-level progress sink. `run()` has emitted these since v1.1;
  // until now only the visible channel subscribed, so a headless poller saw
  // `running` -> terminal and nothing in between.
  onEvent = null,
  // v1.10 Z29-1: request-level after-step OCR mode (beats settings.stepOcr).
  stepOcr = null,
  // v1.10 Z27-5: values masked in everything this run writes or returns.
  secretValues = [],
  // v1.11 REQ-Z30: `{ viewport, viewportSource }` for this run (case > file).
  viewportOptions = null,
}) {
  const authFiltered = filterAuthenticatedAuthBootstrapSteps(steps, auth, runContext || {});
  const executableSteps = authFiltered.steps;
  const nextRunContext = authFiltered.skipped.length
    ? {
        ...runContext,
        authGuard: {
          status: "authenticated-skip",
          skippedStepIds: authFiltered.skipped.map((step) => step.id || "").filter(Boolean),
        },
      }
    : runContext;
  if (!executableSteps.length) {
    return emptyRunResult(runId, testContext, nextRunContext);
  }
  return runImpl(executableSteps, {
    headless,
    ...(typeof onEvent === "function" ? { onEvent } : {}),
    ...(signal ? { signal } : {}),
    ...(Number.isFinite(Number(runTimeoutMs)) && Number(runTimeoutMs) > 0
      ? { runTimeoutMs: Number(runTimeoutMs) }
      : {}),
    runId,
    outputDir: outputRunsRoot,
    storageStatePath: auth.storageStatePath,
    // A snapshot per run: the round table keeps growing after this run returns.
    runtimeVariables: { ...(runtimeVariables || {}) },
    ...(runtimeVariableSources ? { runtimeVariableSources: { ...runtimeVariableSources } } : {}),
    // Z09: give the headless run the same browser context the panel uses.
    ...(browserContext?.launchOptions ? { launchOptions: browserContext.launchOptions } : {}),
    ...(browserContext?.contextOptions ? { contextOptions: browserContext.contextOptions } : {}),
    // v1.2.1: reuse the shared browser process across root-setup / cases /
    // teardown (RunSession creates a fresh isolated context per call from it),
    // so chromium.launch is paid once per session instead of once per case.
    ...(browser ? { browser } : {}),
    // v1.2.1 recovery model: pass the file's recovery handlers so run() can
    // log in on demand (proactive when landing on /login, reactive on a mid-run
    // session loss) instead of a text-guessed login setup block.
    ...(testFile?.recovery && Object.keys(testFile.recovery).length ? { recovery: testFile.recovery } : {}),
    // Z11: checkpoint save / resume for this run.
    ...(checkpoint ? { checkpoint } : {}),
    ...(resume ? { resume } : {}),
    ...(navigateToBaseUrl && testFile.baseUrl ? { url: testFile.baseUrl } : {}),
    // v1.5: the file-level trust gates (page errors, environment freshness,
    // download capture). Translated in one shared place so no channel can
    // silently run without a gate — see `src/shared/run-gate-options.js`.
    ...buildGateRunOptions(testFile),
    ...(stepOcr ? { stepOcr } : {}),
    ...(Array.isArray(secretValues) && secretValues.length ? { secretValues } : {}),
    ...(viewportOptions && viewportOptions.viewport ? viewportOptions : {}),
    stopOnFailure,
    stopAfterScaffoldFailure,
    stopAfterCaseFailure,
    testContext: {
      testFileId: testFileMeta.id,
      testFilePath: testFileMeta.path || null,
      testFileName: testFileMeta.name,
      ...testContext,
    },
    runContext: nextRunContext,
  });
}

// v1.9 REQ-Z22: pick the auth trace for a round. Case results each carry one; the
// interesting case is usually where login actually ran. Take the *last* result
// that has non-default evidence — later cases may have been gated to an
// already-authenticated state, and "last login that actually tried" is the
// truthful one. Falls back to the first non-null.
function aggregateAuthTrace(caseResults = []) {
  const traces = (caseResults || [])
    .map((item) => item?.result?.telemetry?.authTrace || item?.result?.authTrace || null)
    .filter(Boolean);
  if (!traces.length) {
    return null;
  }
  const lastTried = [...traces].reverse().find((trace) => trace?.recovery?.triggered) || null;
  return lastTried || traces[traces.length - 1] || null;
}

function summarizeAggregate({ session, roundId, rootSetupResult, rootTeardownResult, caseResults, status = null }) {
  const rootOk = rootSetupResult?.ok !== false && rootTeardownResult?.ok !== false;
  const ok = rootOk && caseResults.every((item) => item.result?.ok);
  // v1.5 Z-B: an environment block must survive aggregation. Without this the
  // round would report `one-or-more-cases-failed` and the whole point — "this
  // was not a test failure, the build under test was stale" — would be lost in
  // the flattening, exactly as v1.4 found with `batch-partial-failure`.
  const blockedRun = [rootSetupResult, ...caseResults.map((item) => item?.result), rootTeardownResult].find(
    (item) => item && item.blocked === true,
  );
  const effectiveStatus = status || (blockedRun ? "blocked" : null);
  const durationMs =
    (rootSetupResult?.telemetry?.durationMs || 0) +
    (rootTeardownResult?.telemetry?.durationMs || 0) +
    caseResults.reduce((sum, item) => sum + (item.result?.telemetry?.durationMs || 0), 0);
  const steps =
    (rootSetupResult?.telemetry?.steps || 0) +
    (rootTeardownResult?.telemetry?.steps || 0) +
    caseResults.reduce((sum, item) => sum + (item.result?.telemetry?.steps || 0), 0);
  return {
    ok,
    type: "test-session",
    sessionId: session.id,
    roundId,
    // v1.4 REQ-Z16-2: an explicit status (`cancelled`, and since v1.5 `blocked`)
    // overrides the passed/failed derivation, so a cancelled or environment-
    // blocked session is not reported as a test failure. `createDiagnosis` reads
    // `source.status` first.
    ...(effectiveStatus ? { status: effectiveStatus } : {}),
    ...(blockedRun ? { blockedReason: blockedRun.blockedReason || "blocked" } : {}),
    caseResults,
    rootSetupResult,
    rootTeardownResult,
    // v1.9 REQ-Z22: the run's login verdict, surfaced at the aggregate level so a
    // round-level repair context can state "login succeeded / failed" without the
    // reader having to open every case's summary. Merged from the last case run
    // that carried one (root-setup/teardown are not login-bearing).
    authTrace: aggregateAuthTrace(caseResults),
    error: ok
      ? null
      : status === "cancelled"
        ? { code: "session-cancelled", message: "This test session was cancelled before it finished." }
      : blockedRun
        ? blockedRun.error || { code: "blocked", message: "This session was blocked before it could test anything." }
      : rootSetupResult?.ok === false
        ? rootSetupResult.error || { code: "root-setup-failed", message: "root setup failed" }
        : rootTeardownResult?.ok === false
          ? rootTeardownResult.error || { code: "root-teardown-failed", message: "root teardown failed" }
          : { code: "one-or-more-cases-failed", message: "One or more cases failed." },
    telemetry: {
      durationMs,
      steps,
      okCount: caseResults.filter((item) => item.result?.ok).length,
      errorCount:
        (rootSetupResult?.ok === false ? 1 : 0) +
        (rootTeardownResult?.ok === false ? 1 : 0) +
        caseResults.filter((item) => !item.result?.ok).length,
    },
    evidence: {
      steps: [
        ...(rootSetupResult?.evidence?.steps || []),
        ...caseResults.flatMap((item) => item.result?.evidence?.steps || []),
        ...(rootTeardownResult?.evidence?.steps || []),
      ],
      rootSetup: rootSetupResult?.evidence || null,
      rootTeardown: rootTeardownResult?.evidence || null,
      caseRuns: caseResults.map((item) => ({
        caseId: item.caseId,
        caseName: item.caseName,
        runDir: item.result?.evidence?.runDir || null,
        reportPath: item.result?.evidence?.reportPath || null,
      })),
    },
  };
}

// v1.5 Z-D: one signed evidence bundle per case, written next to that case's
// `summary.json` (so the bundle and the thing it attests to travel together).
//
// Built here rather than inside `run()` because a bundle needs facts only the
// session layer has: which case of which test file this was, what the precheck
// said about that case's assertions (discriminative power), and the session/round
// identity. `run()` knows none of that — it is deliberately framework-agnostic.
async function writeCaseEvidenceBundles({ session, roundId, aggregate, testFile, precheck, workspaceRoot }) {
  const bundles = [];
  const caseById = new Map((testFile?.cases || []).map((item) => [item.id, item]));
  const issues = Array.isArray(precheck?.issues) ? precheck.issues : [];
  for (const entry of aggregate.caseResults || []) {
    const result = entry?.result;
    if (!result) {
      continue;
    }
    const summaryPath = result.evidence?.summaryPath || null;
    let summary = null;
    if (summaryPath) {
      try {
        summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
      } catch (_error) {
        summary = null;
      }
    }
    let bundle;
    try {
      bundle = buildEvidenceBundle({
        sessionId: session.id,
        roundId,
        caseId: entry.caseId,
        caseName: entry.caseName,
        testFile,
        caseItem: caseById.get(entry.caseId) || null,
        result,
        summary,
        precheckIssues: issues.filter((issue) => !issue.caseId || issue.caseId === entry.caseId),
        codeRefs: session.request?.codeRefs || null,
        workspaceRoot,
      });
    } catch (_error) {
      // A bundle is additive evidence; failing to build one must never lose the
      // round itself (which contains everything the bundle summarizes).
      continue;
    }
    const bundlePath = summaryPath
      ? path.join(path.dirname(summaryPath), "evidence-bundle.json")
      : null;
    if (bundlePath) {
      try {
        await writeEvidenceBundle(bundlePath, bundle);
      } catch (_error) {
        continue;
      }
    }
    bundles.push({
      caseId: entry.caseId,
      caseName: entry.caseName,
      bundlePath,
      verdict: bundle.verdict,
      failureClass: bundle.failureClass,
      discriminativePower: bundle.discriminativePower?.score ?? null,
      facets: bundle.facets,
    });
  }
  return bundles;
}

// v1.9 REQ-Z24: attach the step-level failure class and the reach/drift verdict
// to `diagnosis.firstFailure`, so the answer to "should I 造数 or 改用例" arrives
// with the failure instead of after a screenshot-reading round trip.
//
// Built here (not in `run()`) for the same reason the evidence bundle is: the
// verdict needs the UI contract, which is assembled from the workspace's test
// files and run history — facts the framework-agnostic engine deliberately does
// not know.
async function enrichFirstFailureWithReach({
  diagnosis,
  testWorkflowsRoot = null,
  outputRunsRoot = null,
  workspaceRoot = null,
}) {
  const failure = diagnosis?.firstFailure;
  if (!failure) {
    return diagnosis;
  }
  // Step-level class first: it is pure and always available, so it must not be
  // lost if the (I/O-bound) contract build fails below.
  failure.failureClass = classifyStepFailureClass({
    code: failure.code,
    actionType: failure.actionType,
    expectation: failure.raw?.data?.expectation || failure.raw?.error?.details?.expectation || null,
  });
  if (failure.failureClass !== "reach" && !isReachClassFailure({ code: failure.code })) {
    // `reachDiagnosis` is deliberately absent (not null) for non-reach failures:
    // present-but-null must keep meaning "reach failure we could not judge".
    return diagnosis;
  }
  try {
    failure.reachDiagnosis = await diagnoseReach({
      step: {
        code: failure.code,
        failureClass: failure.failureClass,
        expectation: failure.raw?.data?.expectation || null,
        target: getStepInput(failure.raw || {}).target || null,
        originalStep: getStepInput(failure.raw || {}),
      },
      testWorkflowsRoot,
      outputRunsRoot,
      frontendInventoryPath: workspaceRoot ? path.join(workspaceRoot, "ui-contract.json") : null,
      currentUrl: failure.raw?.data?.snapshot?.after?.url || null,
    });
  } catch (_error) {
    // Z24-3: an honest null with a reason beats a fabricated "go to tab X".
    failure.reachDiagnosis = {
      verdict: "unknown",
      testidInContract: null,
      reason: "构建 UI 契约失败，无法判定 reach / target-drift——不猜。",
    };
  }
  return diagnosis;
}

async function persistRound({ store, session, roundNo, aggregate, diagnosis, precheck, testFile = null, workspaceRoot = null, testWorkflowsRoot = null, outputRunsRoot = null }) {
  const roundId = `round-${roundNo}`;
  await enrichFirstFailureWithReach({ diagnosis, testWorkflowsRoot, outputRunsRoot, workspaceRoot });
  const aggregatePath = await store.writeRoundArtifact(session.id, roundNo, "aggregate.json", aggregate);
  const diagnosisPath = await store.writeRoundArtifact(session.id, roundNo, "diagnosis.json", diagnosis);
  const reportMarkdown = renderMarkdownReport({
    session,
    round: { id: roundId, status: diagnosis.status },
    diagnosis,
    precheck,
  });
  const reportPath = await store.writeRoundArtifact(session.id, roundNo, "report.md", reportMarkdown);
  const repairContext = createRepairContext({
    session,
    round: { id: roundId, roundNo, aggregatePath, diagnosisPath, reportPath },
    aggregate,
    diagnosis,
    precheck,
  });
  const repairContextPath = await store.writeRoundArtifact(session.id, roundNo, "repair-context.json", repairContext);
  diagnosis.repairContextPath = repairContextPath;
  await store.writeRoundArtifact(session.id, roundNo, "diagnosis.json", diagnosis);
  const evidenceBundles = await writeCaseEvidenceBundles({
    session,
    roundId,
    aggregate,
    testFile,
    precheck,
    workspaceRoot,
  });
  const round = {
    id: roundId,
    roundNo,
    createdAt: Date.now(),
    status: diagnosis.status,
    ok: diagnosis.ok,
    failureType: diagnosis.failureType,
    firstFailure: diagnosis.firstFailure,
    // v1.11 REQ-Z33: case tallies for the run board's history (no re-read of aggregate.json).
    caseCount: aggregate.caseResults.length,
    passedCount: aggregate.caseResults.filter((item) => item.result?.ok).length,
    failedCount: aggregate.caseResults.filter((item) => item.result && !item.result.ok).length,
    // v1.5 Z-D: per-case signed verdicts. `verify_evidence` consumes these; the
    // consumer no longer has to infer a verdict from paths and step titles.
    evidenceBundles,
    aggregatePath,
    diagnosisPath,
    repairContextPath,
    reportPath,
    runtimeReports: [
      aggregate.rootSetupResult?.evidence?.reportPath,
      ...aggregate.caseResults.map((item) => item.result?.evidence?.reportPath),
      aggregate.rootTeardownResult?.evidence?.reportPath,
    ].filter(Boolean),
  };
  const nextSession = await store.appendRound(session, round);
  await appendEngineFinding(path.join(store.outputRoot, "sessions", "engine-findings.jsonl"), {
    sessionId: session.id,
    roundId,
    diagnosis,
    aggregatePath,
  });
  return { round, session: nextSession, diagnosis };
}

async function persistBlockedRound({ store, session, roundNo, diagnosis, precheck = null, aggregate = null }) {
  const roundId = `round-${roundNo}`;
  const finalAggregate = aggregate || {
    ok: false,
    type: "test-session",
    sessionId: session.id,
    roundId,
    caseResults: [],
    error: diagnosis.firstFailure ? { code: diagnosis.failureType, message: diagnosis.firstFailure.message } : null,
    telemetry: { durationMs: 0, steps: 0, okCount: 0, errorCount: 1 },
    evidence: { steps: [] },
  };
  return persistRound({
    store,
    session,
    roundNo,
    aggregate: finalAggregate,
    diagnosis,
    precheck,
  });
}

async function runTestSessionRound({
  session,
  testFile,
  precheck,
  auth,
  store,
  runImpl = defaultRun,
  outputRunsRoot = path.join(DEFAULT_OUTPUT_ROOT, "runs"),
  // v1.9 REQ-Z24: where the UI contract's inputs live (authored test files +
  // the front-end testid inventory), so a reach-class failure can be judged.
  testWorkflowsRoot = null,
  browserContext = null,
  checkpointsRoot = null,
  // v1.2.1: inject a shared-browser launcher to enable browser-process reuse
  // across all runSteps in this session. Off unless a launcher is provided
  // (so existing unit tests with a mock runImpl are unaffected). Callers can
  // disable per-request via `request.reuseBrowser === false` or env
  // ZHUZHU_SESSION_REUSE_BROWSER=0.
  launchBrowser = null,
  // v1.4 REQ-Z16-2: abort signal owned by the session driver. Cancelling aborts
  // it; every runSteps below observes it and the round is still persisted (with
  // status `cancelled`), so a cancelled session leaves the same evidence trail
  // as any other terminal session.
  signal = null,
  deadlineSignal = null,
  // v1.7 Z-N: the session's event bus. Every `runSteps` publishes into it, so a
  // subscriber sees step-level progress across root setup, every case and teardown.
  eventBus = null,
  // v1.10 Z27: { target, applied, credentialVariables, secretValues, probes }.
  runTarget = null,
} = {}) {
  // Z11: per-request checkpoint save / resume config, scoped per case (dir keyed
  // by `<checkpointId>__<caseId>`) so a multi-case session never crosses state.
  const checkpointRequest = session.request?.checkpoint || null;
  const resumeRequest = session.request?.resume || null;
  const caseCheckpointConfig = (caseId) => {
    if (!checkpointsRoot) {
      return { checkpoint: null, resume: null };
    }
    const dirFor = (id) => (id ? resolveCheckpointDir(checkpointsRoot, `${id}__${caseId}`) : null);
    const checkpoint =
      checkpointRequest && checkpointRequest.id && checkpointRequest.atStepId
        ? { dir: dirFor(checkpointRequest.id), atStepId: checkpointRequest.atStepId }
        : null;
    const resume = resumeRequest && resumeRequest.id ? { dir: dirFor(resumeRequest.id) } : null;
    return {
      checkpoint: checkpoint && checkpoint.dir ? checkpoint : null,
      resume: resume && resume.dir ? resume : null,
    };
  };
  const roundNo = (session.rounds || []).length + 1;
  const roundId = `round-${roundNo}`;
  // REQ-Z12-3: every `runSteps` below is executed under the session's remaining
  // wall-clock budget, and the budget is enforced twice — as a `runTimeoutMs`
  // handed to `run()` (graceful: it stops the step loop and writes its own
  // summary) and as an outer `withHardTimeout` (absolute: it fires even if the
  // run never reaches its step loop, e.g. a hung `chromium.launch`). Whichever
  // trips, control returns here and the round is persisted with an aggregate.
  const sessionTimeoutMs = resolveSessionTimeoutMs(session.request || {});
  const sessionIdleTimeoutMs = resolveSessionIdleTimeoutMs(session.request || {});
  const sessionStartedAt = Date.now();
  const remainingBudgetMs = () => Math.max(1_000, sessionTimeoutMs - (Date.now() - sessionStartedAt));
  // Z10: `headed: true` on the request runs this session in its own visible
  // browser instead of headless.
  const headless = session.request?.headed !== true;
  let sessionTimedOut = false;
  let sessionCancelled = false;
  const publish = (event) => {
    if (eventBus) {
      eventBus.publish(event);
    }
  };
  // v1.10: per-session run options that apply to every run of the round.
  const stepOcr = session.request?.stepOcr || null;
  const secretValues = runTarget?.secretValues || [];
  const runStepsBounded = async (args) => {
    const deadline = new AbortController();
    const abandon = () => deadline.abort();
    deadlineSignal?.addEventListener("abort", abandon, { once: true });
    if (deadlineSignal?.aborted) abandon();
    const budgetMs = remainingBudgetMs();
    let lastEventAt = Date.now();
    let idleTimer = null;
    const onEvent = (event) => {
      lastEventAt = Date.now();
      return publish(event);
    };
    // Idle watchdog: rejects with a HardTimeoutError so the existing
    // hard-timeout degrade path below persists the round unchanged.
    const idleWatch = sessionIdleTimeoutMs > 0
      ? new Promise((_, reject) => {
          idleTimer = setInterval(() => {
            const idleMs = Date.now() - lastEventAt;
            if (idleMs >= sessionIdleTimeoutMs) {
              clearInterval(idleTimer);
              reject(new HardTimeoutError({
                code: "session-idle-timeout",
                timeoutMs: sessionIdleTimeoutMs,
                label: `test-session ${session.id} ${args.runId} (no step event for ${Math.round(idleMs / 1000)}s)`,
              }));
            }
          }, Math.min(15_000, sessionIdleTimeoutMs));
          if (typeof idleTimer.unref === "function") {
            idleTimer.unref();
          }
        })
      : null;
    if (idleWatch) {
      idleWatch.catch(() => {});
    }
    try {
      const bounded = withHardTimeout(
        () => runSteps({ ...args, headless, runTimeoutMs: budgetMs, signal, onEvent, stepOcr, secretValues }),
        budgetMs,
        { label: `test-session ${session.id} ${args.runId}`, signal: deadline.signal },
      );
      const value = await (idleWatch ? Promise.race([bounded, idleWatch]) : bounded);
      if (idleTimer) {
        clearInterval(idleTimer);
      }
      return value;
    } catch (error) {
      if (idleTimer) {
        clearInterval(idleTimer);
      }
      // v1.4 REQ-Z16-2: a cancel is not a failure of the test — degrade to a
      // result so the round is still persisted (with everything that already
      // ran) and the session reaches the `cancelled` terminal status.
      if (isAbortError(error)) {
        sessionCancelled = true;
        return {
          ok: false,
          type: "batch",
          data: { results: [] },
          error: {
            code: "session-cancelled",
            message: `Run "${args.runId}" was cancelled on request; the session stopped early.`,
            retryable: false,
          },
          telemetry: { durationMs: Date.now() - sessionStartedAt, steps: 0, okCount: 0, errorCount: 1, browserUrl: null },
          evidence: { steps: [], runId: args.runId },
        };
      }
      if (!isHardTimeoutError(error)) {
        throw error;
      }
      // Degrade to a failed *result* rather than throwing: the round still gets
      // an aggregate, and any earlier case results are preserved.
      sessionTimedOut = true;
      const idle = error && error.code === "session-idle-timeout";
      return {
        ok: false,
        type: "batch",
        data: { results: [] },
        error: {
          code: idle ? "session-idle-timeout" : "session-hard-timeout",
          message: idle
            ? `Run "${args.runId}" emitted no step event for ${sessionIdleTimeoutMs}ms (wedged between steps) and was abandoned ` +
              "so this session could still produce a round aggregate."
            : `Run "${args.runId}" did not finish within the session budget (${budgetMs}ms) and was abandoned ` +
              "so this session could still produce a round aggregate.",
          retryable: true,
        },
        telemetry: { durationMs: budgetMs, steps: 0, okCount: 0, errorCount: 1, browserUrl: null },
        evidence: { steps: [], runId: args.runId },
      };
    } finally {
      deadlineSignal?.removeEventListener("abort", abandon);
      deadline.abort();
    }
  };
  // v1.10 Z27: target vars override file vars; the credential arrives as
  // `credential.<field>` (its secret fields are masked in everything written).
  const targetVariables = {
    ...(runTarget?.target?.vars || {}),
    ...(runTarget?.credentialVariables || {}),
  };
  const runtimeVariables = createRuntimeVariables({
    runId: `${session.id}-${roundId}`,
    overrides: { ...(testFile.vars || {}), ...targetVariables },
  });
  // v1.10 Z28-1: the round's shared variable table. Each `run()` copies what it
  // is given, so a capture made in root setup used to die with that run — the
  // integration guide promised root-setup captures reach the cases and teardown,
  // the headless channel never delivered it (the panel channel did). Captured
  // values are now folded back after every run and handed to the next one, in
  // execution order: root setup → each case → root teardown. Sources travel with
  // them so a reader can tell a file-declared placeholder from a real capture.
  const runtimeVariableSources = {
    ...Object.fromEntries(Object.keys(testFile.vars || {}).map((key) => [key, "file"])),
    ...Object.fromEntries(Object.keys(targetVariables).map((key) => [key, "target"])),
  };
  const absorbCaptures = (result) => absorbRunCaptures(runtimeVariables, runtimeVariableSources, result);
  const runContextBase = {
    triggerSurface: "test-session",
    scope: session.request?.scope || "all",
    sessionId: session.id,
    roundId,
    runtimeVariableKeys: Object.keys(runtimeVariables),
    authBootstrap: session.request?.authBootstrap || "auto",
    // v1.9 REQ-Z22: which identity this round ran as, so `authTrace.profile`
    // names it. "登录成功了吗" is only half an answer without "as whom".
    authProfile: session.request?.authProfile || session.authProfile || auth?.profile || null,
    // v1.10 Z27: which environment this round ran against — addresses, the
    // credential's NAME and the var keys, never a secret. Lands in every run's
    // summary.json (runContext), so "which environment was this green on?" has
    // an answer in the evidence itself.
    target: runTarget?.target
      ? { ...describeRunTarget(runTarget.target, runTarget.applied), probes: runTarget.probes || null }
      : null,
    // The stored profile's own verdict, which is strictly better than what the
    // engine can infer from the live browser alone: it distinguishes "expired"
    // (a credential existed and timed out) from "missing" (there never was one),
    // and that distinction is what tells a reader whether to re-login or to go
    // create the profile.
    authStatusBefore: auth?.ok
      ? auth.staleness === "expired"
        ? "expired"
        : auth.authenticated
          ? "ready"
          : "expired"
      : auth?.status === "missing"
        ? "missing"
        : null,
  };
  const selectedCaseIds = Array.isArray(session.request?.caseIds) && session.request.caseIds.length
    ? new Set(session.request.caseIds)
    : null;
  const selectedCases = selectedCaseIds
    ? testFile.cases.filter((item) => selectedCaseIds.has(item.id))
    : testFile.cases;
  // v1.6 Z-F: `settings.authMatrix: ["app-admin","demo-limited"]` means "run every
  // case once per identity". Expanded into distinct case entries (id suffixed
  // with the profile) rather than looped inside the case, so each identity gets
  // its own isolated context, its own evidence and its own bundle — an identity
  // sharing a browser context with another identity is not a permission test.
  const authMatrix = normalizeAuthMatrix(testFile?.settings?.authMatrix);
  const cases = authMatrix.length
    ? selectedCases.flatMap((caseItem) =>
        authMatrix.map((identity) => ({
          ...caseItem,
          id: `${caseItem.id}@${identity.profile}`,
          name: `${caseItem.name}（${identity.label || identity.profile}）`,
          authProfile: identity.profile,
          // Keep the original id so evidence/report can group the identities back
          // together into one row of the matrix.
          matrixCaseId: caseItem.id,
          matrixProfile: identity.profile,
        })),
      )
    : selectedCases;
  if (!cases.length) {
    const diagnosis = createDiagnosis({
      ok: false,
      error: { code: "engine-error", message: "No matching cases found for this test session." },
    });
    return persistBlockedRound({ store, session, roundNo, diagnosis, precheck });
  }

  // v1.2.1: reuse one browser process for the whole session (root-setup + every
  // case + teardown) instead of a cold chromium.launch per runSteps. Each
  // runSteps still gets an isolated context (RunSession spins a fresh context
  // off this browser), so per-case isolation is preserved. Disabled if no
  // launcher injected, if the request opts out, or via env.
  const reuseBrowserEnabled =
    typeof launchBrowser === "function" &&
    session.request?.reuseBrowser !== false &&
    !/^(0|false|no)$/i.test(String(process.env.ZHUZHU_SESSION_REUSE_BROWSER || "").trim());
  let sharedBrowser = null;
  if (reuseBrowserEnabled) {
    try {
      // REQ-Z12-3: bounded — a hung launch used to leave the session with only
      // `session.json` on disk and no round at all.
      sharedBrowser = await withHardTimeout(
        () =>
          launchBrowser({
            headless,
            launchOptions: browserContext?.launchOptions || null,
          }),
        BROWSER_LAUNCH_TIMEOUT_MS,
        { label: "launchSharedBrowser" },
      );
    } catch (_error) {
      // Fall back to per-run launch (each runSteps launches its own browser).
      sharedBrowser = null;
    }
  }

  try {
    const rootSetupSteps = buildRootExecutionSteps(testFile, "setup");
    const rootTeardownSteps = buildRootExecutionSteps(testFile, "teardown");
    const rootSetupResult = await runStepsBounded({
      runImpl,
      steps: rootSetupSteps,
      runId: `${session.id}-${roundId}-root-setup`,
      viewportOptions: buildViewportRunOptions(testFile, null),
      testFile,
      testFileMeta: session.testFile,
      auth,
      runtimeVariables,
      runtimeVariableSources,
      outputRunsRoot,
      browserContext,
      browser: sharedBrowser,
      navigateToBaseUrl: true,
      stopAfterScaffoldFailure: true,
      runContext: { ...runContextBase, phase: "root-setup" },
      testContext: { caseId: null, caseName: "Root setup" },
    });
    absorbCaptures(rootSetupResult);

    const caseResults = [];
    if (rootSetupResult?.ok !== false) {
      for (const caseItem of cases) {
        // REQ-Z12-3: once the session budget is gone nothing later can succeed —
        // stop instead of burning the remaining minimum budget per case.
        // v1.4 REQ-Z16-2: same for a cancel — do not start another case.
        if (sessionTimedOut || sessionCancelled || signal?.aborted) {
          break;
        }
        const { checkpoint, resume } = caseCheckpointConfig(caseItem.id);
        // v1.6 Z-F: a case may run as a different identity (`case.authProfile`).
        // Resolved per case rather than per session so one file can cover an
        // admin path and a restricted path without being split in two.
        const caseAuth = caseItem.authProfile
          ? await getAuthProfileStatus(caseItem.authProfile, { outputRoot: store.outputRoot })
          : auth;
        if (caseItem.authProfile && !caseAuth.ok) {
          // A named identity that cannot be resolved must not silently fall back
          // to the session's identity — that would run the "restricted account"
          // case as an admin and report it green.
          caseResults.push({
            caseId: caseItem.id,
            caseName: caseItem.name,
            priority: caseItem.priority,
            result: {
              ok: false,
              blocked: true,
              blockedReason: "auth-missing",
              type: "batch",
              data: { results: [] },
              error: {
                code: "auth-missing",
                message:
                  `Case "${caseItem.id}" declares authProfile "${caseItem.authProfile}", which does not resolve ` +
                  "(create it with bootstrap_auth_profile). Reported as blocked rather than run as the session's " +
                  "identity, which would silently test the wrong account.",
              },
              telemetry: { durationMs: 0, steps: 0, okCount: 0, errorCount: 0 },
              evidence: { steps: [] },
            },
          });
          continue;
        }
        const result = await runStepsBounded({
          runImpl,
          steps: buildCaseExecutionSteps(testFile, caseItem.matrixCaseId || caseItem.id),
          runId: `${session.id}-${roundId}-${caseItem.id}`,
          // v1.11 REQ-Z30: one file, different widths per case.
          viewportOptions: buildViewportRunOptions(testFile, caseItem),
          testFile,
          testFileMeta: session.testFile,
          auth: caseAuth,
          runtimeVariables,
          runtimeVariableSources,
          outputRunsRoot,
          browserContext,
          browser: sharedBrowser,
          checkpoint,
          resume,
          // 每个 case 都是独立 runSteps（独立 context，不继承 root setup 导航后的页面），
          // 故必须各自导航到 baseUrl，否则有 root setup 时 case 会起于 about:blank。
          navigateToBaseUrl: true,
          stopAfterCaseFailure: true,
          stopOnFailure: session.request?.stopOnFailure !== false,
          runContext: runContextBase,
          testContext: { caseId: caseItem.id, caseName: caseItem.name },
        });
        absorbCaptures(result);
        caseResults.push({
          caseId: caseItem.id,
          caseName: caseItem.name,
          priority: caseItem.priority,
          ...(caseItem.matrixProfile
            ? { authProfile: caseItem.matrixProfile, matrixCaseId: caseItem.matrixCaseId }
            : caseItem.authProfile
              ? { authProfile: caseItem.authProfile }
              : {}),
          result,
        });
      }
    }

    const rootTeardownResult = testFile.teardown?.alwaysRun === false || sessionTimedOut || sessionCancelled
      ? null
      : await runStepsBounded({
          runImpl,
          steps: rootTeardownSteps,
          runId: `${session.id}-${roundId}-root-teardown`,
          viewportOptions: buildViewportRunOptions(testFile, null),
          testFile,
          testFileMeta: session.testFile,
          auth,
          runtimeVariables,
          runtimeVariableSources,
          outputRunsRoot,
          browserContext,
          browser: sharedBrowser,
          navigateToBaseUrl: false,
          runContext: { ...runContextBase, phase: "root-teardown" },
          testContext: { caseId: null, caseName: "Root teardown" },
        });

    const aggregate = summarizeAggregate({
      session,
      roundId,
      rootSetupResult,
      rootTeardownResult,
      caseResults,
      status: sessionCancelled ? "cancelled" : null,
    });
    // v1.6 Z-F facet F-4: the readable "who sees what" table. Reported, never
    // auto-failed — identities disagreeing is usually the POINT of a permission
    // matrix (a restricted account SHOULD fail the export case).
    if (authMatrix.length) {
      aggregate.authMatrix = buildAuthMatrixTable(
        authMatrix.map((identity) => ({
          profile: identity.profile,
          caseResults: caseResults
            .filter((item) => item.authProfile === identity.profile)
            .map((item) => ({ caseId: item.matrixCaseId || item.caseId, result: item.result })),
        })),
      );
    }
    const diagnosis = createDiagnosis(aggregate);
    return persistRound({
      store,
      session,
      roundNo,
      aggregate,
      diagnosis,
      precheck,
      // v1.5 Z-D: the bundle needs the case definitions (to hash WHAT was run)
      // and the workspace root (to resolve the signing key).
      testFile,
      // The store owns `<workspace>/output`; the signing key lives at the
      // workspace root next to `test-workflows/`.
      workspaceRoot: store?.outputRoot ? path.dirname(store.outputRoot) : null,
      // v1.9 REQ-Z24: inputs for the reach/target-drift verdict.
      testWorkflowsRoot,
      outputRunsRoot,
    });
  } catch (error) {
    const cancelled = isAbortError(error);
    const aggregate = {
      ok: false,
      type: "test-session",
      sessionId: session.id,
      roundId,
      ...(cancelled ? { status: "cancelled" } : {}),
      caseResults: [],
      error: cancelled
        ? { code: "session-cancelled", message: "This test session was cancelled before it finished." }
        : { code: error.code || "engine-error", message: error.message || "Test session failed." },
      telemetry: { durationMs: 0, steps: 0, okCount: 0, errorCount: 1 },
      evidence: { steps: [] },
    };
    const diagnosis = createDiagnosis(aggregate, {
      failureType: "engine-error",
      error: aggregate.error,
      message: aggregate.error.message,
    });
    return persistBlockedRound({ store, session, roundNo, diagnosis, precheck, aggregate });
  } finally {
    // Close the shared browser process once the whole session is done (its
    // per-case contexts were already closed by each RunSession.close()).
    // REQ-Z12-3: bounded — closing a wedged browser must not park the response.
    if (sharedBrowser) {
      try {
        await withHardTimeout(() => sharedBrowser.close(), BROWSER_LAUNCH_TIMEOUT_MS, {
          label: "sharedBrowser.close",
        });
      } catch (_error) {
        // best-effort teardown
      }
    }
  }
}

// v1.4 REQ-Z15: everything that happens *after* the session document exists —
// precheck gate, auth gate, then the actual round. Factored out of
// `createTestSession` so it can run either inline (blocking submit) or detached
// (`wait:false`), with the exact same persisted outcome either way.
async function executeTestSession({ session, resolved, precheck, qualityGate, body = {}, options = {}, store, signal = null }) {
  if (shouldBlockForPrecheck(precheck, { qualityGate, allowBlocked: body.allowBlocked === true })) {
    const diagnosis = createDiagnosis({
      ok: false,
      error: {
        code: "precheck-blocked",
        message: `Precheck blocked with ${precheck.summary.errorCount} error(s) and ${precheck.summary.blockingCount || 0} blocking issue(s).`,
      },
    }, {
      failureType: "engine-error",
      message: `Precheck blocked with ${precheck.summary.errorCount} error(s) and ${precheck.summary.blockingCount || 0} blocking issue(s).`,
      precheck,
    });
    const persisted = await persistBlockedRound({
      store,
      session,
      roundNo: 1,
      diagnosis,
      precheck,
    });
    return { ...persisted, diagnosis, response: buildSessionResponse(persisted.session, persisted.round) };
  }

  const auth = await getAuthProfileStatus(body.authProfile, { outputRoot: options.outputRoot });
  if (!auth.ok) {
    const diagnosis = createDiagnosis({
      ok: false,
      error: auth.error,
    }, {
      failureType: "auth-missing",
      error: auth.error,
      message: auth.error.message,
    });
    const persisted = await persistBlockedRound({ store, session, roundNo: 1, diagnosis, precheck });
    return { ...persisted, diagnosis, response: buildSessionResponse(persisted.session, persisted.round) };
  }

  // v1.10 Z27: the target's credential must exist and its origins must answer.
  const targetGate = await checkRunTargetGates({
    target: resolved.runTarget?.target || null,
    applied: resolved.runTarget?.applied || null,
    workspaceRoot: store?.outputRoot ? path.dirname(store.outputRoot) : null,
    probe: options.probeTargetOrigin || probeHttp,
  });
  if (!targetGate.ok) {
    const diagnosis = createDiagnosis({ ok: false, error: targetGate.error }, {
      error: targetGate.error,
      message: targetGate.error.message,
    });
    const persisted = await persistBlockedRound({ store, session, roundNo: 1, diagnosis, precheck });
    return { ...persisted, diagnosis, response: buildSessionResponse(persisted.session, persisted.round) };
  }

  const persisted = await runTestSessionRound({
    session,
    testFile: resolved.normalized,
    precheck,
    auth,
    store,
    runTarget: resolved.runTarget
      ? {
          ...resolved.runTarget,
          credentialVariables: targetGate.credentialVariables,
          secretValues: targetGate.secretValues,
          probes: targetGate.probes || null,
        }
      : null,
    runImpl: options.runImpl || defaultRun,
    outputRunsRoot: options.outputRunsRoot,
    testWorkflowsRoot: options.testWorkflowsRoot || null,
    browserContext: options.browserContext || null,
    checkpointsRoot: options.checkpointsRoot || null,
    // v1.2.1: browser-process reuse. Enabled only when a launcher is injected —
    // real callers pass `launchBrowser: launchSharedBrowser`; unit tests that
    // mock runImpl pass nothing, so they keep the per-run behavior untouched.
    launchBrowser: options.launchBrowser || null,
    deadlineSignal: options.deadlineSignal || null,
    // v1.4 REQ-Z16-2.
    signal,
    // v1.7 Z-N: the per-session event bus (created at submit time, so a caller
    // that subscribes immediately after getting the handle misses nothing).
    eventBus: getSessionEventBus(session.id),
  });
  return { ...persisted, response: buildSessionResponse(persisted.session, persisted.round) };
}

// v1.4: last line of defence for a *detached* execution. With `wait:false`
// nobody is awaiting the promise, so an unexpected throw (a failing store write,
// a bug in a persist path) used to leave the session document stuck in `running`
// with no round — the very "只创建 session.json 就永久静默" failure mode v1.3's
// Z12-3 set out to make impossible. So: persist a terminal round; if the store
// itself is the problem, at least move the session out of `running`.
async function finalizeUnexpectedFailure({ store, session, precheck = null, error }) {
  const message = error?.message || String(error);
  const failure = { code: error?.code || "engine-error", message };
  const diagnosis = createDiagnosis(
    { ok: false, error: failure },
    { failureType: "engine-error", error: failure, message, precheck },
  );
  try {
    const persisted = await persistBlockedRound({
      store,
      session,
      roundNo: (session.rounds || []).length + 1,
      diagnosis,
      precheck,
    });
    return { ...persisted, diagnosis, response: buildSessionResponse(persisted.session, persisted.round) };
  } catch (_persistError) {
    const fallback = await store
      .writeSession({ ...session, status: "failed", error: { code: "session-finalize-failed", message } })
      .catch(() => null);
    return fallback
      ? { session: fallback, round: null, diagnosis, response: buildSessionResponse(fallback, null) }
      : null;
  }
}

// v1.4 REQ-Z15: create the session document and kick execution off, returning
// the handle (`sessionId` + planned `roundId`) plus a `completion` promise. This
// is the seam every submit mode shares — blocking, bounded-wait, and async.
async function startTestSession(body = {}, options = {}) {
  const store = options.store || new TestSessionStore({ outputRoot: options.outputRoot });
  const resolved = await resolveTestFile(body, options);
  // v1.10 Z27: where/as whom this run happens is the caller's call. Rejected
  // here (400, no session) if the file needs an origin the target lacks.
  const runTarget = prepareRunTarget(body.target, resolved, body.authProfile);
  resolved.runTarget = runTarget;
  body = {
    ...body,
    ...(runTarget.authProfile ? { authProfile: runTarget.authProfile } : {}),
    target: runTarget.target,
  };
  const qualityGate = normalizeQualityGate(body.qualityGate);
  const precheck = precheckTestFile({ testFile: resolved.raw, mode: qualityGate === "gate" ? "gate" : "advisory" });
  const created = await store.createSession({
    request: body,
    authProfile: body.authProfile || "",
    feedback: body.feedback || "",
    testFile: {
      ...resolved.meta,
      ...(resolved.meta.source === "inline" ? { inlineTestFile: resolved.raw } : {}),
    },
  });
  const plannedRoundId = `round-${(created.rounds || []).length + 1}`;

  if (body.runNow === false) {
    return {
      session: created,
      plannedRoundId,
      started: false,
      completion: Promise.resolve({
        session: created,
        round: null,
        diagnosis: null,
        response: buildSessionResponse(created, null),
      }),
    };
  }

  // Flip to `running` *before* the handle goes out: a caller that polls
  // immediately must never see `pending` for a session already executing.
  const session = await store.writeSession({ ...created, status: "running" });
  const controller = new AbortController();
  const deadlineController = new AbortController();
  const entry = {
    sessionId: session.id,
    roundId: plannedRoundId,
    status: "running",
    startedAt: Date.now(),
    testFileId: session.testFile?.id || null,
    testFilePath: session.testFile?.path || null,
    controller,
    deadlineController,
    cancelRequest: null,
  };
  activeSessions.set(session.id, entry);
  // v1.7 Z-N: the bus exists BEFORE execution starts, so a caller that
  // subscribes the moment it receives the handle cannot miss `run-start`.
  const eventBus = createSessionEventBus(session.id);
  entry.eventBus = eventBus;
  // v1.7 Z-O: when this session runs inside an isolated child process, the child
  // forwards its run events here so the parent's stream and budget are identical
  // either way — process isolation must not change what a consumer sees.
  if (typeof options.onSessionEvent === "function") {
    eventBus.subscribe(options.onSessionEvent);
  }
  // v1.11 REQ-Z33: every headless/headed session — MCP, HTTP, batch, panel,
  // isolated worker — reports to the run board through its own event bus.
  const board = getRunBoard({ outputRoot: store.outputRoot });
  const boardCases = Array.isArray(resolved.normalized?.cases) ? resolved.normalized.cases : [];
  const selectedCaseIds = Array.isArray(body.caseIds) && body.caseIds.length ? new Set(body.caseIds) : null;
  board?.register({
    id: session.id,
    sessionId: session.id,
    kind: body.headed === true ? "headed-session" : "headless-session",
    title: session.testFile?.name || session.testFile?.path || session.id,
    testFileName: session.testFile?.name || null,
    testFilePath: session.testFile?.path || null,
    trigger: body.trigger || options.trigger || null,
    batchId: body.batchId || null,
    headed: body.headed === true,
    caseTotal: selectedCaseIds ? boardCases.filter((item) => selectedCaseIds.has(item.id)).length : boardCases.length,
    caseNames: Object.fromEntries(boardCases.map((item) => [item.id, item.name || item.id])),
  });
  const unsubscribeBoard = board ? eventBus.subscribe((event) => board.recordEvent(session.id, event)) : () => {};
  // v1.7 Z-O: an on-disk claim carrying this process's pid. Without it a cancel
  // cannot tell "abandoned by a restarted host" from "running in another
  // process" — v1.4 assumed the former and would overwrite a live session's
  // document with `cancelled`.
  void claimSession({
    outputRoot: store.outputRoot,
    sessionId: session.id,
    roundId: plannedRoundId,
    testFileId: session.testFile?.id || null,
    testFilePath: session.testFile?.path || null,
  });
  const completion = executeTestSession({
    session,
    resolved,
    precheck,
    qualityGate,
    body,
    options: { ...options, deadlineSignal: deadlineController.signal },
    store,
    signal: controller.signal,
  })
    .catch(async (error) => {
      const finalized = await finalizeUnexpectedFailure({ store, session, precheck, error });
      if (finalized) {
        return finalized;
      }
      throw error;
    })
    .finally(async () => {
      if (activeSessions.get(session.id) === entry) {
        activeSessions.delete(session.id);
      }
      // Publish a terminal event so a subscriber learns the session ended
      // without having to poll, then keep the bus around briefly for late
      // reconnects (see RETENTION_MS) and drop the on-disk claim.
      let finalStatus = null;
      try {
        const doc = await store.readSession(session.id);
        finalStatus = doc ? summarizeSessionDoc(doc).status : null;
      } catch (_error) {
        finalStatus = null;
      }
      eventBus.publish({
        type: "session-complete",
        sessionId: session.id,
        roundId: plannedRoundId,
        status: finalStatus,
        terminal: true,
        budget: eventBus.getBudget({ finishedAt: Date.now() }),
      });
      unsubscribeBoard();
      try {
        const doc = await store.readSession(session.id);
        const summary = doc ? summarizeSessionDoc(doc) : null;
        const latest = doc?.rounds?.at(-1) || null;
        board?.finish(session.id, {
          status: summary?.status || finalStatus || "failed",
          ok: summary?.ok ?? null,
          failureType: summary?.failureType || null,
          firstFailure: summary?.firstFailure || null,
          reportPath: summary?.reportPath || null,
          casesTotal: latest?.caseCount ?? null,
          casesPassed: latest?.passedCount ?? null,
          casesFailed: latest?.failedCount ?? null,
        });
      } catch (_error) {
        board?.finish(session.id, { status: finalStatus || "failed" });
      }
      retireSessionEventBus(session.id);
      await releaseSession({ outputRoot: store.outputRoot, sessionId: session.id });
    });
  entry.completion = completion;
  // With `wait:false` nobody awaits this promise. Log it (a silent background
  // failure is how a session goes missing) and sink it, so it can never surface
  // as an unhandled rejection and take the host process down.
  completion.catch((error) => {
    console.error(`[zhuzhu] test session ${session.id} could not be finalized:`, error?.message || error);
  });
  return { session, plannedRoundId, started: true, completion, entry };
}

// v1.4 REQ-Z15-1: the async-submit response. It carries the same handle fields a
// terminal response does (`sessionId`/`roundId`/`status`) plus `partial`, so a
// caller can use one accessor regardless of which mode it got back.
function buildSubmitResponse({ session, plannedRoundId }) {
  return {
    ok: true,
    sessionId: session.id,
    roundId: plannedRoundId,
    status: "running",
    terminal: false,
    mode: "async",
    partial: { sessionId: session.id, roundId: plannedRoundId },
    poll: {
      tool: "get_run_summary",
      args: { runId: session.id },
      endpoint: `/test-sessions/${session.id}`,
    },
    diagnosisPath: null,
    repairContextPath: null,
    reportPath: null,
    firstFailure: null,
  };
}

// v1.4 REQ-Z15-2: the "server ran out of blocking budget" response. The session
// keeps running; the caller gets a handle instead of nothing. A timeout must
// never mean zero information.
function buildWaitTimeoutResponse({ session, plannedRoundId }, waitedMs) {
  return {
    ...buildSubmitResponse({ session, plannedRoundId }),
    mode: "wait-timeout",
    waitTimedOut: true,
    waitedMs,
    message:
      `This session is still running after ${waitedMs}ms of blocking wait; the call returned a handle instead ` +
      "of timing out. It keeps executing in the background — poll get_run_summary(sessionId) " +
      `or GET /test-sessions/${session.id} until \`terminal\` is true. ` +
      "Pass waitTimeoutMs:0 to block indefinitely, or wait:false to submit without blocking at all.",
  };
}

// v1.4 REQ-Z16-2: cancel a headless session. `cancel` is cooperative first
// (abort the signal so the run unwinds, closes its browser and persists its
// round with status `cancelled`) and authoritative second (if the run has not
// reached a terminal status within the grace window, force-finalize the session
// document). Either way the caller reaches a terminal status in bounded time.
async function cancelTestSession(sessionId, { reason = "cancelled-by-request", graceMs } = {}, options = {}) {
  const id = String(sessionId || "").trim();
  const store = options.store || new TestSessionStore({ outputRoot: options.outputRoot });
  const entry = activeSessions.get(id);
  if (!entry) {
    const doc = await store.readSession(id);
    if (!doc) {
      return {
        ok: false,
        found: false,
        cancelled: false,
        sessionId: id,
        status: "not-found",
        error: { code: "not-found", message: `Test session "${id}" was not found.`, retriable: false },
      };
    }
    const summary = summarizeSessionDoc(doc);
    if (summary.terminal) {
      // Idempotent, like the App-run cancel: cancelling a finished session
      // reports that instead of failing, so an unattended caller can fire and forget.
      return {
        ok: true,
        found: true,
        cancelled: false,
        forced: false,
        sessionId: id,
        status: summary.status,
        terminal: true,
        reason: "not-running",
      };
    }
    // v1.7 Z-O: not terminal and not tracked in THIS process. Before v1.7 that
    // was assumed to mean "orphaned" and force-finalized — which, when another
    // process was in fact executing it, wrote `cancelled` over a live session
    // that then kept writing rounds, leaving a self-contradicting document.
    // Now the on-disk claim is consulted first.
    const claim = await inspectClaim({ outputRoot: store.outputRoot, sessionId: id });
    if (claim.claimed && claim.alive) {
      return {
        ok: false,
        found: true,
        cancelled: false,
        forced: false,
        sessionId: id,
        status: summary.status,
        terminal: false,
        claim: {
          pid: claim.claim.pid,
          hostname: claim.claim.hostname,
          claimedAt: claim.claim.claimedAt,
        },
        error: {
          code: "session-owned-elsewhere",
          message:
            `Test session "${id}" is being executed by another process (${claim.reason}). ` +
            "Not force-finalized: doing so would write a terminal status over a session that is still running. " +
            "Cancel it from the process that owns it, or stop that process.",
          retriable: true,
        },
      };
    }
    const finalized = await store.writeSession({
      ...doc,
      status: "cancelled",
      cancelledAt: Date.now(),
      cancelReason:
        `${reason} (orphaned session force-finalized; ` +
        `${claim.claimed ? claim.reason : "no on-disk claim exists, so nothing is executing it"})`,
    });
    await releaseSession({ outputRoot: store.outputRoot, sessionId: id });
    return {
      ok: true,
      found: true,
      cancelled: true,
      forced: true,
      orphaned: true,
      sessionId: id,
      status: finalized.status,
      terminal: true,
      reason,
      ...(claim.claimed ? { claim: { pid: claim.claim.pid, hostname: claim.claim.hostname } } : {}),
    };
  }

  entry.cancelRequest = { reason, at: Date.now() };
  entry.status = "cancelling";
  entry.controller.abort();
  // Surface the intent immediately so a poller sees `cancelling` rather than a
  // stale `running` while the run unwinds. Best-effort: the round persist that
  // follows writes the terminal status and wins.
  const current = await store.readSession(id).catch(() => null);
  if (current && !isTerminalSessionStatus(current.status)) {
    await store
      .writeSession({ ...current, status: "cancelling", cancelRequestedAt: Date.now(), cancelReason: reason })
      .catch(() => {});
  }
  const grace = Math.max(0, Number.isFinite(Number(graceMs)) ? Number(graceMs) : DEFAULT_CANCEL_GRACE_MS);
  const settled = await raceDeadline(
    entry.completion.then(
      () => true,
      () => true,
    ), grace, false,
  );
  const doc = await store.readSession(id).catch(() => null);
  const summary = doc ? summarizeSessionDoc(doc) : null;
  if (!settled && (!summary || !summary.terminal)) {
    const finalized = await store.writeSession({
      ...(doc || { id }),
      status: "cancelled",
      cancelledAt: Date.now(),
      cancelReason: `${reason} (force-finalized after a ${grace}ms cancel grace window)`,
    });
    entry.deadlineController?.abort();
    return {
      ok: true,
      found: true,
      cancelled: true,
      forced: true,
      sessionId: id,
      status: finalized.status,
      terminal: true,
      reason,
    };
  }
  // Report what actually happened, not what was requested: a session can win the
  // race and finish normally between the abort and the grace deadline. Claiming
  // `cancelled: true` next to `status: "passed"` would make the caller distrust
  // every other field.
  const finalStatus = summary?.status || "cancelled";
  const reallyCancelled = finalStatus === "cancelled";
  return {
    ok: true,
    found: true,
    cancelled: reallyCancelled,
    forced: false,
    sessionId: id,
    status: finalStatus,
    terminal: summary ? summary.terminal : true,
    roundId: summary?.roundId || null,
    reportPath: summary?.reportPath || null,
    reason: reallyCancelled ? reason : "finished-before-cancel",
  };
}

// v1.4: in-flight sessions known to this process (observability + self-describe).
function listActiveTestSessions() {
  return [...activeSessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    roundId: entry.roundId,
    status: entry.status,
    startedAt: entry.startedAt,
    elapsedMs: Date.now() - entry.startedAt,
    testFileId: entry.testFileId,
    testFilePath: entry.testFilePath,
    cancelRequest: entry.cancelRequest,
  }));
}

function isTestSessionActive(sessionId) {
  return activeSessions.has(String(sessionId || "").trim());
}

async function createTestSession(body = {}, options = {}) {
  // v1.7 Z-O: opt-in process isolation. Delegating the WHOLE submit (rather than
  // just the run loop) is what makes cancel a kill: there is nothing of this
  // session left in the parent to unwind.
  if (isProcessIsolationEnabled(body) && !options.__insideWorker) {
    return runIsolatedTestSession(body, options);
  }
  const started = await startTestSession(body, options);
  const { wait, timeoutMs } = resolveWaitMode(body);
  // `runNow:false` never executes, and an unbounded blocking wait is the
  // pre-v1.4 behavior — both just resolve the completion.
  if (!started.started || (wait && !timeoutMs)) {
    return started.completion;
  }
  if (!wait) {
    return {
      session: started.session,
      round: null,
      diagnosis: null,
      response: buildSubmitResponse(started),
    };
  }
  const settled = await raceDeadline(
    started.completion.then(
      (value) => ({ done: true, value }),
      (error) => ({ done: true, error }),
    ), timeoutMs, { done: false },
  );
  if (settled.done) {
    if (settled.error) {
      throw settled.error;
    }
    return settled.value;
  }
  return {
    session: started.session,
    round: null,
    diagnosis: null,
    response: buildWaitTimeoutResponse(started, timeoutMs),
  };
}

// v1.7 Z-O: run a submit in a child process and surface it through the same
// registry / event bus / claim machinery the in-process path uses, so callers
// cannot tell the difference except that cancel is now immediate.
async function runIsolatedTestSession(body = {}, options = {}) {
  const store = options.store || new TestSessionStore({ outputRoot: options.outputRoot });
  const controller = new AbortController();
  // The child creates the session document, so the parent does not know the id
  // until the first event arrives. Everything that needs the id is wired lazily.
  let sessionId = null;
  let bus = null;
  const entry = {
    sessionId: null,
    roundId: null,
    status: "running",
    startedAt: Date.now(),
    testFileId: null,
    testFilePath: null,
    controller,
    cancelRequest: null,
    isolated: true,
  };

  const adopt = (event) => {
    if (!sessionId && event?.sessionId) {
      sessionId = event.sessionId;
      entry.sessionId = sessionId;
      activeSessions.set(sessionId, entry);
      bus = getSessionEventBus(sessionId) || createSessionEventBus(sessionId);
    }
    if (bus) {
      bus.publish(event);
    }
  };

  const completion = runSessionInWorker({
    request: body,
    options: {
      outputRoot: store.outputRoot,
      outputRunsRoot: options.outputRunsRoot || null,
      testWorkflowsRoot: options.testWorkflowsRoot || null,
      browserContext: options.browserContext || null,
      checkpointsRoot: options.checkpointsRoot || null,
    },
    onEvent: adopt,
    signal: controller.signal,
  }).finally(async () => {
    if (sessionId && activeSessions.get(sessionId) === entry) {
      activeSessions.delete(sessionId);
    }
    if (sessionId) {
      // The child may have been killed before it could finalize; the parent owns
      // making sure the document reaches a terminal status regardless.
      try {
        const doc = await store.readSession(sessionId);
        if (doc && !isTerminalSessionStatus(doc.status)) {
          await store.writeSession({
            ...doc,
            status: "cancelled",
            cancelledAt: Date.now(),
            cancelReason: "isolated session worker exited before reaching a terminal status",
          });
        }
      } catch (_error) {
        // best effort
      }
      retireSessionEventBus(sessionId);
      await releaseSession({ outputRoot: store.outputRoot, sessionId });
    }
  });
  entry.completion = completion;
  completion.catch((error) => {
    console.error("[zhuzhu] isolated test session failed:", error?.message || error);
  });

  const outcome = await completion;
  if (outcome?.response) {
    return { session: null, round: null, diagnosis: null, response: outcome.response, isolated: true };
  }
  return {
    session: null,
    round: null,
    diagnosis: null,
    isolated: true,
    response: {
      ok: false,
      sessionId,
      status: outcome?.killed ? "cancelled" : "failed",
      terminal: true,
      error: outcome?.error || { code: "session-worker-failed", message: "The isolated session worker produced no result." },
    },
  };
}

async function rerunTestSession(sessionId, body = {}, options = {}) {
  const store = options.store || new TestSessionStore({ outputRoot: options.outputRoot });
  const session = await store.readSession(sessionId);
  if (!session) {
    return null;
  }
  const request = {
    ...session.request,
    ...body,
    authProfile: body.authProfile || session.authProfile,
  };
  const resolved = session.testFile?.source === "inline"
    ? await resolveTestFile({ testFile: session.testFile.inlineTestFile }, options)
    : await resolveTestFile({ testFilePath: session.testFile.path }, options);
  // v1.10 Z27: a rerun keeps the session's target unless the caller passes a
  // new one (e.g. the same session against another environment).
  const runTarget = prepareRunTarget(body.target ?? session.request?.target ?? null, resolved, request.authProfile);
  if (runTarget.authProfile) {
    request.authProfile = runTarget.authProfile;
  }
  const qualityGate = normalizeQualityGate(request.qualityGate);
  const precheck = precheckTestFile({ testFile: resolved.raw, mode: qualityGate === "gate" ? "gate" : "advisory" });
  const auth = await getAuthProfileStatus(request.authProfile, { outputRoot: options.outputRoot });
  const nextSession = await store.writeSession({
    ...session,
    authProfile: request.authProfile || session.authProfile,
    request: {
      ...session.request,
      scope: request.scope || session.request?.scope || "all",
      caseIds: Array.isArray(request.caseIds) ? request.caseIds : session.request?.caseIds || [],
      qualityGate,
      allowBlocked: request.allowBlocked === true || session.request?.allowBlocked === true,
      authBootstrap: request.authBootstrap || session.request?.authBootstrap || "auto",
      ...(runTarget.target ? { target: runTarget.target } : {}),
      ...(typeof body.stepOcr === "string" && body.stepOcr ? { stepOcr: body.stepOcr } : {}),
    },
  });
  if (shouldBlockForPrecheck(precheck, nextSession.request)) {
    const diagnosis = createDiagnosis({ ok: false, error: { code: "precheck-blocked", message: "Precheck blocked this test session rerun." } }, {
      failureType: "engine-error",
      message: "Precheck blocked this test session rerun.",
      precheck,
    });
    const persisted = await persistBlockedRound({
      store,
      session: nextSession,
      roundNo: (nextSession.rounds || []).length + 1,
      diagnosis,
      precheck,
    });
    return { ...persisted, response: buildSessionResponse(persisted.session, persisted.round) };
  }
  if (!auth.ok) {
    const diagnosis = createDiagnosis({ ok: false, error: auth.error }, {
      failureType: "auth-missing",
      error: auth.error,
      message: auth.error.message,
    });
    const persisted = await persistBlockedRound({
      store,
      session: nextSession,
      roundNo: (nextSession.rounds || []).length + 1,
      diagnosis,
      precheck,
    });
    return { ...persisted, response: buildSessionResponse(persisted.session, persisted.round) };
  }
  const targetGate = await checkRunTargetGates({
    target: runTarget.target,
    applied: runTarget.applied,
    workspaceRoot: store?.outputRoot ? path.dirname(store.outputRoot) : null,
    probe: options.probeTargetOrigin || probeHttp,
  });
  if (!targetGate.ok) {
    const diagnosis = createDiagnosis({ ok: false, error: targetGate.error }, {
      error: targetGate.error,
      message: targetGate.error.message,
    });
    const persisted = await persistBlockedRound({
      store,
      session: nextSession,
      roundNo: (nextSession.rounds || []).length + 1,
      diagnosis,
      precheck,
    });
    return { ...persisted, response: buildSessionResponse(persisted.session, persisted.round) };
  }
  const persisted = await runTestSessionRound({
    session: nextSession,
    testFile: resolved.normalized,
    precheck,
    auth,
    store,
    runTarget: runTarget.target
      ? {
          ...runTarget,
          credentialVariables: targetGate.credentialVariables,
          secretValues: targetGate.secretValues,
          probes: targetGate.probes || null,
        }
      : null,
    runImpl: options.runImpl || defaultRun,
    outputRunsRoot: options.outputRunsRoot,
    testWorkflowsRoot: options.testWorkflowsRoot || null,
    browserContext: options.browserContext || null,
    checkpointsRoot: options.checkpointsRoot || null,
  });
  return { ...persisted, response: buildSessionResponse(persisted.session, persisted.round) };
}

function buildSessionResponse(session, round) {
  const latest = round || (session.rounds || []).at(-1) || null;
  const status = latest?.status || session.status;
  return {
    ok: true,
    sessionId: session.id,
    roundId: latest?.id || null,
    status,
    // v1.4 REQ-Z15-3: one flag every submit/poll response carries, so callers
    // stop polling on a fact instead of on a status allow-list of their own.
    terminal: isTerminalSessionStatus(status),
    mode: "sync",
    diagnosisPath: latest?.diagnosisPath || null,
    repairContextPath: latest?.repairContextPath || null,
    reportPath: latest?.reportPath || null,
    firstFailure: latest?.firstFailure || null,
  };
}

module.exports = {
  DEFAULT_TEST_WORKFLOWS_ROOT,
  absorbRunCaptures,
  checkRunTargetGates,
  prepareRunTarget,
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  buildCaseExecutionSteps,
  buildRootExecutionSteps,
  buildSessionResponse,
  buildSubmitResponse,
  buildWaitTimeoutResponse,
  cancelTestSession,
  createTestSession,
  runIsolatedTestSession,
  filterAuthenticatedAuthBootstrapSteps,
  isTestSessionActive,
  launchSharedBrowser,
  listActiveTestSessions,
  rerunTestSession,
  resolveTestFile,
  resolveWaitMode,
  runTestSessionRound,
  startTestSession,
};
