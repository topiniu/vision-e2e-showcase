const { app, BrowserWindow, Menu, ipcMain, shell, screen, dialog, Notification, protocol, net } = require("electron");
const http = require("node:http");
const nodeFs = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const {
  clearWorkspacePreference,
  getWorkspacePreferencesPath,
  normalizeWorkspaceRoot,
  readWorkspacePreferenceSync,
  writeWorkspacePreference,
} = require("../shared/workspace-preferences");
const {
  getAuthRenewalConfigPath,
  readAuthRenewalConfigSync,
  writeAuthRenewalConfig,
  normalizeAuthRenewalConfig,
} = require("../shared/auth-renewal-config");
const { getIntegrationWorkspacePaths } = require("../shared/integration-workspace");

// v1.8 perf: evidence screenshots are served over a custom scheme instead of
// being base64-encoded into an IPC message.
//
// The old path read the PNG in the main process, `toString("base64")`-ed it (a
// synchronous +33% copy on the main thread), structured-cloned the string across
// IPC, and parked it in React state. Three copies of every screenshot, none of
// them eligible for Chromium's own image-cache eviction — a report view with a
// hundred step screenshots was tens of MB of strings in the renderer heap on top
// of the decoded bitmaps.
//
// With a real URL, Chromium streams the file, decodes it once, and evicts it
// when it is off-screen like any other image. The scheme must be registered as
// privileged *before* `app.whenReady()`.
const EVIDENCE_SCHEME = "zhuzhu-evidence";

const APP_NAME = "Vision E2E Showcase";
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const IS_PACKAGED_APP = app.isPackaged || path.basename(PROJECT_ROOT) === "app.asar";
const APP_MODE = process.env.ZHUZHU_APP_MODE === "development" ? "development" : "production";
app.setName(APP_NAME);

const CUSTOM_USER_DATA_DIR = String(process.env.ZHUZHU_USER_DATA_DIR || "").trim();
if (CUSTOM_USER_DATA_DIR) {
  app.setPath("userData", path.resolve(CUSTOM_USER_DATA_DIR));
}

const WORKSPACE_PREFERENCES_PATH = getWorkspacePreferencesPath(app.getPath("userData"));
const AUTH_RENEWAL_CONFIG_PATH = getAuthRenewalConfigPath(app.getPath("userData"));
const DEFAULT_APP_WORKSPACE_ROOT = IS_PACKAGED_APP
  ? path.join(app.getPath("userData"), "workspace")
  : PROJECT_ROOT;
const ENV_WORKSPACE_ROOT = normalizeWorkspaceRoot(process.env.ZHUZHU_WORKSPACE_DIR);
const SAVED_WORKSPACE_ROOT = readWorkspacePreferenceSync(WORKSPACE_PREFERENCES_PATH);
const APP_WORKSPACE_ROOT = ENV_WORKSPACE_ROOT || SAVED_WORKSPACE_ROOT || DEFAULT_APP_WORKSPACE_ROOT;

if (IS_PACKAGED_APP && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, "playwright-browsers");
}

const {
  PlaywrightVisibleBrowserAdapter,
} = require("./browser-adapter");
const { ensureReleaseWorkspace } = require("./release-workspace");
const {
  captureAuthProfile,
  getAuthProfileStatus,
  hasAuthEvidence,
} = require("../../runtime/server/auth-profile");
const {
  TestSessionStore,
  isSafeSessionId,
  summarizeSessionDoc,
} = require("../../runtime/server/session-store");
const {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  cancelTestSession,
  checkRunTargetGates,
  createTestSession,
  launchSharedBrowser,
  filterAuthenticatedAuthBootstrapSteps,
  isTestSessionActive,
  listActiveTestSessions,
} = require("../../runtime/server/test-session-runner");
const { precheckTestFile } = require("../shared/test-file-precheck");
const {
  buildHeadlessBrowserContext: buildHeadlessBrowserContextPure,
  buildMemoryLaunchArgs,
} = require("../shared/browser-launch");
const {
  runValidate,
  runHeadlessSession,
  runHeadlessBatch,
  cancelHeadlessSession,
  listHeadlessSessions,
  readHeadlessSession,
  // v1.7 Z-N: step-level SSE + budget for headless sessions.
  readHeadlessSessionBudget,
  streamHeadlessSessionEvents,
  handleCheckpointRoute,
} = require("./desktop-runtime-routes");
// v1.5 守航支撑：preflight / env-fingerprint / evidence-verify / report-card.
const {
  bootstrapProfile: bootstrapAuthProfileRoute,
  getReportCard: buildSessionReportCard,
  getUiContract: getUiContractRoute,
  handleGuardedRunRoute,
  preflight: runPreflightRoute,
  probeEnvironmentFingerprint,
  verifyEvidence: verifyEvidenceRoute,
} = require("./guarded-run-routes");
const { runBatch: runParallelBatch } = require("../../runtime/server/parallel-batch-runner");
const {
  listCheckpoints,
  clearCheckpoint,
  resolveCheckpointDir,
} = require("../../runtime/executor/checkpoint-store");
// v1.4: `isTerminal` is the queue's own口径 for "may I stop polling?" — reused
// (not duplicated) by the unified get_run_summary reader.
const { createAppRunQueue, isTerminal: isTerminalAppRunStatus } = require("./app-run-queue");
const {
  buildEnqueueResponse,
  resolveWaitStatus,
  streamRunEvents,
} = require("./app-run-http");
const {
  MCP_ROUTE,
  TOOL_CATALOG: MCP_TOOL_CATALOG,
  handleMcpHttpRequest,
} = require("./mcp-server");
const {
  buildTestFileName,
  createTestFileDraft,
  isSafeRelativeTestFilePath,
  normalizeTestFile,
} = require("../shared/test-file");
const { compareTestFileItems } = require("../shared/test-file-sort");
const { buildGateRunOptions } = require("../shared/run-gate-options");
const { buildViewportRunOptions } = require("../shared/viewport");
const { getRunBoard, registerBatchPlaceholders } = require("../../runtime/server/run-board");
const { handleRunBoardRoute } = require("../../runtime/server/run-board-http");
const { applyRunTarget, describeRunTarget, normalizeRunTarget } = require("../shared/run-target");
const {
  appendAuditRecord,
  authorize: authorizeApiRequest,
  classifyHttpRequest,
  classifyTool,
  isNetworkExposed,
  resolveApiToken,
  resolveBindHost,
  summarizeParams,
} = require("../shared/api-guard");
const { resolveAndNormalizeTestFile } = require("../shared/test-file-references");
const {
  collectReportPathsFromResult,
  listRunArchive,
  pruneRunArchive,
  readRunReport,
  rebuildRunArchive,
  updateRunArchiveIndex,
} = require("./run-archive");
const { capturePageStructure } = require("./dom-structure-snapshot");
const { writeProfessionalReportPdf } = require("./professional-report-pdf");
const {
  EXTERNAL_INTEGRATION_DOCUMENTS_PATH,
  getRequestOrigin,
  listAppRunNetworkEndpoints,
} = require("./network-endpoints");
// v1.9 REQ-Z25: machine-verifiable capability catalog served at GET /capabilities.
const { getCapabilityData } = require("../../runtime/server/capabilities");
// v1.9 REQ-Z25: so a 404 on a guessed path can name the real one. The bridge got
// this first; this surface needs it MORE, because the bridge binds loopback and
// the App Run server binds all interfaces — a remote consumer can only reach
// this one, so this is the only 404 it ever sees.
const { buildNotFoundError } = require("../shared/capability-catalog");
// v1.9 REQ-Z26: the fixed-path discovery file, so consumers stop recording ports.
const { markEndpointFileStaleSync, writeEndpointFile } = require("../shared/service-discovery");

const MIN_WINDOW_WIDTH = 920;
const MIN_WINDOW_HEIGHT = 720;
const CUSTOM_WELCOME_PAGE_URL = String(
  process.env.ZHUZHU_WELCOME_PAGE_URL || "",
).trim();
const CUSTOM_BROWSER_USER_AGENT = String(
  process.env.ZHUZHU_BROWSER_USER_AGENT || "",
).trim();
const CUSTOM_ACCEPT_LANGUAGES = String(
  process.env.ZHUZHU_ACCEPT_LANGUAGES || "zh-CN,zh;q=0.9,en;q=0.8",
).trim();
// v1.5 Z-M: the default is now LOOPBACK. Before v1.5 this port bound 0.0.0.0
// with no authentication while hosting `write_test_file` (writes the workspace)
// and `run_app` (drives the visible browser holding the QA login) — i.e. any host
// on the office LAN could operate this machine. Opening it to the network is now
// an explicit act: set ZHUZHU_APP_RUN_HOST=0.0.0.0.
const APP_RUN_HOST = resolveBindHost();
const APP_RUN_PORT = Number(process.env.ZHUZHU_APP_RUN_PORT || 32147);
const APP_RUN_TIMEOUT_MS = Number(process.env.ZHUZHU_APP_RUN_TIMEOUT_MS || 60 * 60 * 1000);
// The visible panel drives a single browser, so at most one visible run executes
// at a time. Overridable for future multi-window setups. Genuinely parallel
// multi-instance execution is served by the headed batch channel
// (`POST /app-runs/batch`, v1.3 Z10) rather than by raising this.
const APP_RUN_MAX_CONCURRENT = Math.max(1, Number(process.env.ZHUZHU_APP_RUN_MAX_CONCURRENT || 1));
// REQ-Z12-2 (需求单v3): a dispatched run that reports no event for this long is
// treated as wedged — force-failed with its slot released — so one frozen run
// can no longer lock the serial queue for the rest of an unattended session.
const APP_RUN_STALL_MS = Math.max(0, Number(process.env.ZHUZHU_APP_RUN_STALL_MS || 10 * 60 * 1000));
const APP_RUN_STALL_SWEEP_MS = Math.max(5_000, Number(process.env.ZHUZHU_APP_RUN_STALL_SWEEP_MS || 30_000));
// Z10 (v1.3): default concurrency of the *visible* parallel channel
// (`POST /app-runs/batch`). Each worker drives its own visible Chromium, so this
// is bounded by machine resources rather than by the panel's single browser.
const APP_RUN_PARALLEL_INSTANCES = Math.max(1, Number(process.env.ZHUZHU_APP_RUN_PARALLEL_INSTANCES || 2));
// Z09: align the headless browser's web-security posture to the visible panel so
// a qiankun master front-end can `loadMicroApp` (cross-origin remote-entry fetch)
// in headless too. Disabling web security + CSP for the *internal test browser*
// mirrors what the interactive channel tolerates; set to 0 to opt out.
const HEADLESS_ALIGN_WEB_SECURITY = String(
  process.env.ZHUZHU_HEADLESS_DISABLE_WEB_SECURITY ?? "0",
).trim() !== "0";
const PANEL_DEV_SERVER_URL = String(
  process.env.ZHUZHU_PANEL_DEV_SERVER_URL || "",
).trim();
const SKIP_INITIAL_BROWSER_LOAD = /^(1|true|yes)$/i.test(
  String(process.env.ZHUZHU_SKIP_INITIAL_BROWSER_LOAD || "").trim(),
);
const DEV_NO_FOCUS_ON_RESTART = /^(1|true|yes)$/i.test(
  String(process.env.ZHUZHU_DEV_NO_FOCUS || "").trim(),
);
const DEV_RESTART_LAUNCH = /^(1|true|yes)$/i.test(
  String(process.env.ZHUZHU_DEV_RESTART_LAUNCH || "").trim(),
);
const WELCOME_PAGE_URL =
  CUSTOM_WELCOME_PAGE_URL || "about:blank";
const BUNDLED_WORKSPACE_ROOT = path.join(process.resourcesPath, "default-workspace");
const WORKSPACE_SEED_ROOT = IS_PACKAGED_APP ? BUNDLED_WORKSPACE_ROOT : PROJECT_ROOT;
const RELEASE_RESOURCE_ROOT = IS_PACKAGED_APP ? process.resourcesPath : PROJECT_ROOT;
const APP_ICON_PATH = path.join(RELEASE_RESOURCE_ROOT, "assets", "app-icon.png");
const RUN_FILE_NOTIFICATION_ICONS = {
  passed: path.join(RELEASE_RESOURCE_ROOT, "assets", "run-file-passed.png"),
  failed: path.join(RELEASE_RESOURCE_ROOT, "assets", "run-file-failed.png"),
  stopped: path.join(RELEASE_RESOURCE_ROOT, "assets", "run-file-stopped.png"),
};
const OUTPUT_ROOT = path.join(APP_WORKSPACE_ROOT, "output");
const OUTPUT_RUNS_ROOT = path.join(OUTPUT_ROOT, "runs");
// Z11: root for data-gen checkpoint snapshots (per-id subdirectories).
const CHECKPOINTS_ROOT = path.join(OUTPUT_ROOT, "checkpoints");
const DEBUG_LOG_ROOT = path.join(OUTPUT_ROOT, "debug");
const BUILD_CASES_RUN_DEBUG_LOG = path.join(DEBUG_LOG_ROOT, "build-cases-run-debug.log");
const TEST_WORKFLOWS_ROOT = path.join(APP_WORKSPACE_ROOT, "test-workflows");
const INTEGRATION_WORKSPACE = getIntegrationWorkspacePaths(APP_WORKSPACE_ROOT);
const TEST_SESSION_STORE = new TestSessionStore({ outputRoot: OUTPUT_ROOT });
const RUNTIME_ROOT = path.join(PROJECT_ROOT, "runtime");
const EXTERNAL_INTEGRATION_DOCUMENTS = [
  {
    id: "external-api",
    title: "External tool integration",
    audience: "Tools",
    path: "docs/test-file-json-integration-guide.md",
    description: "Runtime API, validation, sessions, visible app runs, and report-driven reruns.",
  },
  {
    id: "ai-integration",
    title: "AI test generation integration",
    audience: "AI",
    path: "docs/ai-test-generation-integration.md",
    description: "How AI should generate, validate, execute, diagnose, and revise Zhuzhu test files.",
  },
  {
    id: "ai-trust-loop",
    title: "AI trust-loop contract",
    audience: "AI",
    path: "docs/0.6.0/ai-trust-loop-contract.md",
    description: "The versioned quality-gate and repair-context contract for AI collaboration.",
  },
];
const BROWSER_PROXY_MODES = ["system", "manual", "direct"];
const DEFAULT_PANEL_PREFERENCES = {
  openChromeOnSecondaryDisplay: true,
  maximizeChromeOnLaunch: true,
  browserProxyMode: "system",
  browserProxyServer: "",
  browserProxyBypass: "",
  // v1.2.1 App-run efficiency: keep ONE logged-in visible browser across a
  // testing session so login runs once, not once per file. Off = old behavior
  // (recreate a fresh browser + re-login for every file).
  appRunReuseLogin: true,
  // v1.2 memory reclaim: release the reused visible browser after this many
  // minutes with no run/navigation activity (heavy SPA stays resident otherwise).
  // The next run/navigation relaunches it lazily. 0 = never auto-release.
  browserIdleTimeoutMinutes: 15,
};
const IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

// Registered before `app.whenReady()` (see EVIDENCE_SCHEME). `standard` is what
// makes the URL parse with a host + path; `stream` lets Chromium range-request
// the file rather than buffering it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: EVIDENCE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

let mainWindow = null;
let browserAdapter = null;
let loadProgress = 0;
let loadStatus = "Idle";
const activeRuntimeRuns = new Map();
let testWorkflowWatcher = null;
let pendingTestWorkflowChangeTimer = null;
const pendingTestWorkflowChanges = new Map();
const recentInternalTestWorkflowWrites = new Map();
let panelPreferences = { ...DEFAULT_PANEL_PREFERENCES };
let appRunServer = null;
// REQ-Z12-2: interval handle for the wedged-run watchdog.
let appRunStallWatchdog = null;
// Auth auto-renewal (see src/shared/auth-renewal-config.js). Loaded sync at
// startup; the heartbeat timer is (re)armed whenever the config changes.
let authRenewalConfig = readAuthRenewalConfigSync(AUTH_RENEWAL_CONFIG_PATH);
let authRenewalTimer = null;
let authRenewalInFlight = false;
let externalAppRunSeq = 0;
let externalBatchSeq = 0;
let externalAppRunReady = false;
// Z01/Z02: per-run timeout timers, cleared on completion.
const appRunTimers = new Map();
// Z01/Z02: queue + event registry for visible App runs. `dispatch` hands a run
// to the panel (the single visible browser); a per-run timeout fails the run if
// the panel never reports back. See app-run-queue.js.
// REQ-Z12-2: feed the stall watchdog from the *engine*, not from the UI.
// The panel only reports one external-run progress event ("panel-started") for a
// whole file, so without this a legitimately long App-run (many cases, dozens of
// steps each) would look silent and get falsely swept — strictly worse than the
// freeze we are fixing. Every runtime event touches the idle clock; only case-level
// milestones and failures are appended to the event log, so a busy run cannot
// bloat the SSE replay buffer. Visible App-runs are serial, so "the active run"
// is unambiguous.
const APP_RUN_MILESTONE_EVENTS = new Set([
  "run-start",
  "run-complete",
  "run-wedged",
  "recovery-start",
  "recovery-complete",
  "checkpoint-saved",
  // v1.4: the browser died (OOM) / is approaching the memory cliff. Both are
  // already throttled at the source — `browser-crashed` fires once per run, and
  // `browser-memory-warning` only on the threshold crossing — so neither can
  // bloat the SSE replay buffer the way an unthrottled heartbeat would.
  "browser-crashed",
  "browser-memory-warning",
]);

// v1.10 Z27: run-target credentials for external App-runs, keyed by run id.
// Kept out of the queue record on purpose: the queue is what GET /app-runs
// returns, and a credential must never ride along in an API response.
const APP_RUN_TARGETS = new Map();

// The target of the active external App-run, if exactly one is active. With
// ZHUZHU_APP_RUN_MAX_CONCURRENT > 1 several could be active at once and a run
// cannot be attributed — then nothing is injected and the run's own login
// fails visibly, which is safer than injecting the wrong account.
const getActiveAppRunTarget = () => {
  let active = [];
  try {
    active = appRunQueue.queueSnapshot().active || [];
  } catch (_error) {
    return null;
  }
  if (active.length !== 1) {
    return null;
  }
  return APP_RUN_TARGETS.get(active[0].runId) || null;
};

const noteActiveAppRunActivity = (event) => {
  if (!event || typeof event !== "object") {
    return;
  }
  let activeRunIds = [];
  try {
    activeRunIds = (appRunQueue.queueSnapshot().active || []).map((item) => item.runId);
  } catch (_error) {
    return;
  }
  if (!activeRunIds.length) {
    return; // a panel-initiated manual run — nothing to keep alive
  }
  const isMilestone =
    APP_RUN_MILESTONE_EVENTS.has(event.type) ||
    (event.type === "step-complete" && event.status === "failed");
  for (const runId of activeRunIds) {
    appRunQueue.touch(runId);
    if (isMilestone) {
      appRunQueue.appendProgress(runId, {
        phase: event.type,
        stepIndex: typeof event.stepIndex === "number" ? event.stepIndex : null,
        stepTitle: event.stepId || null,
        status: event.status || null,
        detail: event.message || event.reason || null,
      });
    }
  }
};

// Z13/Z12-2: tear down the work behind a run that is being cancelled or swept.
// Two independent levers, because either one alone can leave a zombie:
//  1. abort the in-flight runtime AbortControllers in *this* process — that is
//     what actually stops the Playwright driving;
//  2. tell the panel to break out of its per-case loop, so it stops submitting
//     further cases and does not report a stale completion afterwards.
// Visible App-runs are serial (maxConcurrent=1), so aborting every active
// runtime run is precise here; raising maxConcurrent would need per-run tagging.
const tearDownAppRunWork = (record, { reason = "cancelled" } = {}) => {
  const runId = record?.runId || record?.request?.externalRunId || null;
  // The per-run dispatch timeout can no longer fire for this run — drop it so it
  // does not sit in the map for up to APP_RUN_TIMEOUT_MS.
  const timer = runId ? appRunTimers.get(runId) : null;
  if (timer) {
    clearTimeout(timer);
    appRunTimers.delete(runId);
  }
  // v1.10 Z27: a cancelled/timed-out run's credential goes with it.
  if (runId) {
    APP_RUN_TARGETS.delete(runId);
  }
  emitToPanel("external-app-run-cancel", { externalRunId: runId, reason });
  const targets = Array.from(activeRuntimeRuns.values());
  for (const target of targets) {
    try {
      target.controller.abort();
    } catch (_error) {
      // an already-aborted controller is fine
    }
  }
  void executeSessionCommand("stop").catch(() => {});
  logMainLifecycle("app-run-torn-down", { runId, reason, abortedRuntimeRuns: targets.length });
};

// v1.11 REQ-Z33: the visible App-run queue, mirrored onto the run board.
const observeAppRunForBoard = (event, meta = {}) => {
  const board = getRunBoard({ outputRoot: OUTPUT_ROOT });
  if (!board || !event?.runId) {
    return;
  }
  const request = meta.request || {};
  if (event.type === "queued") {
    board.register({
      id: event.runId,
      kind: "app-run",
      status: "queued",
      title: request.testFilePath || event.runId,
      testFilePath: request.testFilePath || null,
      trigger: request.triggerSurface || "app-runs",
      headed: true,
      queuePosition: meta.queuePosition || null,
      queuedAt: meta.queuedAt || null,
    });
    return;
  }
  if (event.type === "running") {
    board.start(event.runId, { startedAt: meta.startedAt || Date.now() });
    return;
  }
  if (isTerminalAppRunStatus(event.type)) {
    const result = event.result || {};
    board.finish(event.runId, {
      status: event.status || event.type,
      ok: typeof result.ok === "boolean" ? result.ok : null,
      firstFailure: result.firstFailure || (result.error ? { code: result.error.code, message: result.error.message } : null),
      reportPath: result.reportPath || null,
    });
  }
};

// v1.11 REQ-Z33: run()-level progress for the board. A runtime run that belongs
// to an active external App-run is reported under that App-run; one started from
// the panel by hand is its own board entry (registered in panel:runtime-run).
const recordRuntimeEventOnBoard = (runId, event, testContext = null) => {
  const board = getRunBoard({ outputRoot: OUTPUT_ROOT });
  if (!board || !event) {
    return;
  }
  const enriched = testContext?.caseName ? { ...event, caseName: testContext.caseName, caseId: testContext.caseId || null } : event;
  if (board.entries.has(runId)) {
    board.recordEvent(runId, enriched);
    return;
  }
  let active = [];
  try {
    active = appRunQueue.queueSnapshot().active || [];
  } catch (_error) {
    active = [];
  }
  for (const item of active) {
    board.recordEvent(item.runId, enriched);
  }
};

const appRunQueue = createAppRunQueue({
  maxConcurrent: APP_RUN_MAX_CONCURRENT,
  stallTimeoutMs: APP_RUN_STALL_MS,
  observer: observeAppRunForBoard,
  onCancel: (record, meta) => tearDownAppRunWork(record, meta),
  dispatch: (request) => {
    const timer = setTimeout(() => {
      appRunTimers.delete(request.externalRunId);
      appRunQueue.fail(
        request.externalRunId,
        { code: "app-run-timeout", message: "External app run timed out before the panel returned a result." },
        "timeout",
      );
    }, APP_RUN_TIMEOUT_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    appRunTimers.set(request.externalRunId, timer);
    emitToPanel("external-app-run-request", request);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  },
});
const externalActivityItems = new Map();

const navigationMeta = {
  requestedUrl: null,
  redirectChain: [],
  lastError: null,
};

const logMainLifecycle = (message, details = null) => {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[main] ${message}${suffix}`);
};

// ---------------------------------------------------------------------------
// v1.9: main-process memory watchdog.
//
// The console-handle leak (see runtime/perception/console-message-args.js) ran
// for five releases and was found by a human looking at Windows Task Manager,
// because nothing in the product ever reported its own footprint. A platform
// that measures the *browser's* heap (v1.4 browser-health) but not its own is
// blind in exactly the place this bug lived.
//
// Cheap by construction: one `process.memoryUsage()` per minute (microseconds),
// a ring of the last samples, and a log line only when a threshold is crossed
// or the trend is monotonic. It reports; it does not act — restarting the main
// process under a user's run would be a far worse failure than the leak.
// ---------------------------------------------------------------------------
const MEMORY_SAMPLE_INTERVAL_MS = 60_000;
const MEMORY_SAMPLE_RING = 30; // 30 minutes of history
const MEMORY_RSS_WARN_MB = Number(process.env.ZHUZHU_MAIN_RSS_WARN_MB) || 1024;
const MEMORY_GROWTH_WARN_MB = 256; // sustained growth across the whole ring

const memorySamples = [];
let memoryWatchdogTimer = null;
let memoryWarnedAtMb = 0;

const toMb = (bytes) => Math.round(bytes / 1048576);

const sampleMainProcessMemory = () => {
  const usage = process.memoryUsage();
  const sample = {
    at: Date.now(),
    rssMb: toMb(usage.rss),
    heapUsedMb: toMb(usage.heapUsed),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers ?? 0),
  };
  memorySamples.push(sample);
  if (memorySamples.length > MEMORY_SAMPLE_RING) {
    memorySamples.shift();
  }
  return sample;
};

const getMainProcessMemory = () => {
  const current = memorySamples[memorySamples.length - 1] || sampleMainProcessMemory();
  const oldest = memorySamples[0] || current;
  return {
    ...current,
    samples: memorySamples.length,
    windowMs: Math.max(0, current.at - oldest.at),
    growthMb: current.rssMb - oldest.rssMb,
    rssWarnMb: MEMORY_RSS_WARN_MB,
    // The host number is what actually decides whether the next browser starts.
    host: readHostMemory(),
  };
};

const checkMainProcessMemory = () => {
  const sample = sampleMainProcessMemory();
  const oldest = memorySamples[0];
  const growthMb = sample.rssMb - oldest.rssMb;
  // Re-warn only after another half-threshold of growth, so a process that
  // legitimately sits above the line does not print every single minute.
  const shouldWarnAbsolute =
    sample.rssMb >= MEMORY_RSS_WARN_MB && sample.rssMb >= memoryWarnedAtMb + MEMORY_RSS_WARN_MB / 2;
  const shouldWarnGrowth =
    memorySamples.length >= MEMORY_SAMPLE_RING && growthMb >= MEMORY_GROWTH_WARN_MB;
  if (shouldWarnAbsolute || shouldWarnGrowth) {
    memoryWarnedAtMb = sample.rssMb;
    logMainLifecycle("main-memory-pressure", {
      rssMb: sample.rssMb,
      heapUsedMb: sample.heapUsedMb,
      externalMb: sample.externalMb,
      growthMb,
      windowMs: sample.at - oldest.at,
      warnMb: MEMORY_RSS_WARN_MB,
      reason: shouldWarnGrowth ? "sustained-growth" : "above-threshold",
      host: readHostMemory(),
    });
  }
  reportHostMemoryPressure("watchdog");
};

// v1.9: the *host's* memory, not ours.
//
// A visible Chromium needs a few hundred MB to come up. When the machine is
// already at the ceiling it does not fail politely — the renderer dies of OOM
// and the operator sees "the browser crashed", with nothing anywhere saying the
// box had 300MB free. That is the 2026-09-08 report: "开一个浏览器就 out of
// Memory". Zhuzhu is one tenant among many on a dev workstation, so it cannot
// fix this; it can refuse to be silent about it.
//
// Advisory only — never blocks a launch. The operator decides what to close.
const HOST_MEMORY_WARN_FREE_MB = Number(process.env.ZHUZHU_HOST_FREE_WARN_MB) || 1024;

const readHostMemory = () => {
  const totalMb = toMb(os.totalmem());
  const freeMb = toMb(os.freemem());
  return {
    totalMb,
    freeMb,
    usedPercent: totalMb > 0 ? Math.round(((totalMb - freeMb) / totalMb) * 100) : 0,
  };
};

const HOST_MEMORY_WARN_INTERVAL_MS = 10 * 60_000;
let hostMemoryWarnedAt = 0;

const reportHostMemoryPressure = (trigger) => {
  try {
    const host = readHostMemory();
    if (host.freeMb >= HOST_MEMORY_WARN_FREE_MB) {
      return host;
    }
    // A launch is a decision point — always say something. The periodic sample
    // is throttled, so a box that simply lives near its ceiling does not turn
    // the log into a warning every minute.
    const now = Date.now();
    if (trigger !== "browser-launch" && now - hostMemoryWarnedAt < HOST_MEMORY_WARN_INTERVAL_MS) {
      return host;
    }
    hostMemoryWarnedAt = now;
    logMainLifecycle("host-memory-pressure", {
      trigger,
      ...host,
      warnFreeMb: HOST_MEMORY_WARN_FREE_MB,
      selfRssMb: toMb(process.memoryUsage().rss),
      note: "A visible Chromium may fail to start or be OOM-killed at this free-memory level.",
    });
    emitToPanel("host-memory-warning", { ...host, trigger, warnFreeMb: HOST_MEMORY_WARN_FREE_MB });
    return host;
  } catch (_error) {
    // Advisory only — a failed sample must never block a browser launch.
    return null;
  }
};

const startMemoryWatchdog = () => {
  if (memoryWatchdogTimer) {
    return;
  }
  sampleMainProcessMemory();
  memoryWatchdogTimer = setInterval(checkMainProcessMemory, MEMORY_SAMPLE_INTERVAL_MS);
  if (typeof memoryWatchdogTimer.unref === "function") {
    memoryWatchdogTimer.unref();
  }
};

const shouldShowMainWindowInactiveOnLaunch = () =>
  Boolean(PANEL_DEV_SERVER_URL && DEV_NO_FOCUS_ON_RESTART && DEV_RESTART_LAUNCH);

const showMainWindowForLaunch = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (shouldShowMainWindowInactiveOnLaunch() && typeof mainWindow.showInactive === "function") {
    mainWindow.showInactive();
    logMainLifecycle("main-window-show-inactive", {
      reason: "dev-restart",
    });
    return;
  }
  mainWindow.show();
};

const sendJsonResponse = (res, statusCode, body) => {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
};

const readRequestJson = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const readExternalIntegrationDocuments = async (requestOrigin = "") => {
  const endpoints = listAppRunNetworkEndpoints({ port: APP_RUN_PORT });
  const requestedBaseUrl = requestOrigin || endpoints[0].baseUrl;
  return {
    success: true,
    networkAccess: APP_RUN_HOST !== "127.0.0.1" && APP_RUN_HOST !== "::1",
    bindHost: APP_RUN_HOST,
    appRunBaseUrl: requestedBaseUrl,
    endpoint: `${requestedBaseUrl}${EXTERNAL_INTEGRATION_DOCUMENTS_PATH}`,
    endpoints,
    workspace: INTEGRATION_WORKSPACE,
    // v1.9 REQ-Z25-1: the machine-verifiable capability catalog, surfaced in the
    // doc itself. This is the "single source" the endpoint table is generated
    // from (REQ-Z25-2) — the doc no longer keeps a second copy that can drift.
    capabilities: getCapabilityData().capabilities,
    // Z12: self-describe the in-process MCP server so接入方 can discover the
    // typed-tool endpoint (and its protocol version + tool catalog) from the
    // same GET they already poll — no hardcoded host/port, no separate probe.
    mcp: {
      endpoint: `${requestedBaseUrl}${MCP_ROUTE}`,
      transport: "streamable-http",
      stateless: true,
      protocolVersion: app.getVersion?.() || null,
      serverName: "zhuzhu-e2e",
      tools: MCP_TOOL_CATALOG,
    },
    // v1.4 REQ-Z15/Z16-1: self-describe the headless channel's submit modes and
    // its isolation guarantee, so a caller never has to infer either from prose.
    // Z16-1 asked whether two overlapping sessions with `reuseBrowser:true` can
    // interfere: they cannot — `reuseBrowser` reuses one Chromium *within* a
    // single session (one process per session, a fresh context per case), it
    // never shares a browser across sessions. Concurrent submits are therefore
    // isolated by construction, and `reuseBrowser:false` is NOT required.
    headlessChannel: {
      submit: {
        endpoint: "POST /test-sessions",
        tool: "run_headless",
        modes: ["sync", "bounded-wait", "async"],
        asyncParam: "wait:false",
        waitTimeoutParam: "waitTimeoutMs",
        defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
        timeoutAlwaysReturnsHandle: true,
        handleFields: ["sessionId", "roundId", "partial.sessionId", "partial.roundId"],
      },
      poll: { endpoint: "GET /test-sessions/{sessionId}", tool: "get_run_summary", terminalField: "terminal" },
      list: { endpoint: "GET /test-sessions?testFileId=&limit=", tool: "list_sessions" },
      cancel: {
        endpoint: "POST /test-sessions/{sessionId}/cancel",
        aliases: ["POST /test-sessions/{sessionId}/stop", "POST /test-sessions/{sessionId}/abort", "DELETE /test-sessions/{sessionId}"],
        tool: "cancel_run",
        graceMs: DEFAULT_CANCEL_GRACE_MS,
        idempotent: true,
      },
      isolation: {
        browserPerSession: true,
        reuseBrowserScope: "session",
        contextScope: "case",
        concurrentSubmitsIsolated: true,
        reuseBrowserFalseRequiredForConcurrency: false,
        note:
          "Each session launches its own Chromium process and a fresh browser context per case/root phase. " +
          "reuseBrowser:true reuses that process inside one session only; overlapping sessions never share a " +
          "browser, context, cookie jar, storageState or runtime variable scope.",
      },
      activeSessions: listActiveTestSessions(),
    },
    documents: await Promise.all(EXTERNAL_INTEGRATION_DOCUMENTS.map(async (document) => ({
      ...document,
      markdown: await fs.readFile(path.join(PROJECT_ROOT, document.path), "utf8"),
    }))),
  };
};

const readConfiguredWorkspaceRoot = () =>
  normalizeWorkspaceRoot(process.env.ZHUZHU_WORKSPACE_DIR) ||
  readWorkspacePreferenceSync(WORKSPACE_PREFERENCES_PATH) ||
  DEFAULT_APP_WORKSPACE_ROOT;

const getWorkspaceSettings = () => {
  const configuredWorkspaceRoot = readConfiguredWorkspaceRoot();
  return {
    success: true,
    activeWorkspaceRoot: APP_WORKSPACE_ROOT,
    configuredWorkspaceRoot,
    defaultWorkspaceRoot: DEFAULT_APP_WORKSPACE_ROOT,
    projectRoot: PROJECT_ROOT,
    packaged: IS_PACKAGED_APP,
    restartRequired: path.resolve(configuredWorkspaceRoot) !== path.resolve(APP_WORKSPACE_ROOT),
    environmentOverride: Boolean(
      ENV_WORKSPACE_ROOT && process.env.ZHUZHU_WORKSPACE_SOURCE !== "preference",
    ),
  };
};

const prepareWorkspaceRoot = async (workspaceRoot) => {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  if (resolvedWorkspaceRoot === path.resolve(WORKSPACE_SEED_ROOT)) {
    await fs.mkdir(path.join(resolvedWorkspaceRoot, "output"), { recursive: true });
    return;
  }
  await ensureReleaseWorkspace({
    workspaceRoot: resolvedWorkspaceRoot,
    bundledWorkspaceRoot: WORKSPACE_SEED_ROOT,
  });
};

const chooseWorkspaceRoot = async () => {
  if (getWorkspaceSettings().environmentOverride) {
    return {
      success: false,
      error: "workspace-controlled-by-environment",
      message: "Remove ZHUZHU_WORKSPACE_DIR before changing the workspace in Settings.",
    };
  }
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "Choose Zhuzhu workspace",
    defaultPath: readConfiguredWorkspaceRoot(),
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  if (result.canceled || !result.filePaths[0]) {
    return { success: false, canceled: true };
  }
  const workspaceRoot = normalizeWorkspaceRoot(result.filePaths[0]);
  if (!workspaceRoot) {
    return { success: false, error: "invalid-workspace-root", message: "Choose a folder other than the filesystem root." };
  }
  await prepareWorkspaceRoot(workspaceRoot);
  await writeWorkspacePreference(WORKSPACE_PREFERENCES_PATH, workspaceRoot);
  return getWorkspaceSettings();
};

const resetWorkspaceRoot = async () => {
  if (getWorkspaceSettings().environmentOverride) {
    return {
      success: false,
      error: "workspace-controlled-by-environment",
      message: "Remove ZHUZHU_WORKSPACE_DIR before resetting the workspace in Settings.",
    };
  }
  await clearWorkspacePreference(WORKSPACE_PREFERENCES_PATH);
  await prepareWorkspaceRoot(DEFAULT_APP_WORKSPACE_ROOT);
  return getWorkspaceSettings();
};

const getExternalActivitySnapshot = () => {
  const items = [...externalActivityItems.values()]
    .sort((left, right) => String(right.startedAt || "").localeCompare(String(left.startedAt || "")));
  return {
    success: true,
    active: items.filter((item) => item.phase === "started"),
    recent: items.filter((item) => item.phase !== "started").slice(0, 12),
  };
};

const publishExternalActivity = (rawActivity = {}) => {
  const id = String(rawActivity.id || "").trim().slice(0, 120);
  if (!id) {
    return { success: false, error: "missing-activity-id" };
  }
  const previous = externalActivityItems.get(id) || {};
  const activity = {
    ...previous,
    id,
    capability: String(rawActivity.capability || previous.capability || "external.unknown").slice(0, 120),
    label: String(rawActivity.label || previous.label || "External capability").slice(0, 160),
    source: String(rawActivity.source || previous.source || "External tool").slice(0, 80),
    caller: String(rawActivity.caller || previous.caller || "local tool").slice(0, 120),
    method: String(rawActivity.method || previous.method || "").slice(0, 12),
    path: String(rawActivity.path || previous.path || "").slice(0, 240),
    detail: String(rawActivity.detail || previous.detail || "").slice(0, 240),
    phase: rawActivity.phase === "started" ? "started" : "completed",
    status: String(rawActivity.status || (rawActivity.phase === "started" ? "running" : "completed")).slice(0, 40),
    statusCode: Number.isFinite(Number(rawActivity.statusCode)) ? Number(rawActivity.statusCode) : null,
    startedAt: rawActivity.startedAt || previous.startedAt || new Date().toISOString(),
    finishedAt: rawActivity.finishedAt || previous.finishedAt || null,
  };
  externalActivityItems.set(id, activity);
  [...externalActivityItems.values()]
    .sort((left, right) => String(right.startedAt || "").localeCompare(String(left.startedAt || "")))
    .slice(30)
    .forEach((item) => externalActivityItems.delete(item.id));
  emitToPanel("external-activity", activity);
  return { success: true, activity };
};

const normalizeExternalAppRunScope = (value, hasCaseId = false) => {
  if (value === "selected" || value === "case") {
    return "selected";
  }
  return hasCaseId ? "selected" : "all";
};

const getExternalRunStatus = (result = {}) => {
  if (result.status === "busy" || result.status === "cancelled") {
    return result.status;
  }
  if (result.status === "stopped" || result?.error?.code === "run-stopped" || String(result.type || "").includes("stopped")) {
    return "stopped";
  }
  return result.ok ? "passed" : "failed";
};

const summarizeExternalRunResult = (payload = {}) => {
  const result = payload.result || payload;
  const caseResults = Array.isArray(result?.caseResults) ? result.caseResults : [];
  const status = getExternalRunStatus(result);
  const firstCaseRun = result?.evidence?.caseRuns?.find((item) => item?.reportPath || item?.summaryPath || item?.markdownReportPath);
  const firstStepRun = result?.evidence?.steps?.find((item) => item?.reportPath || item?.summaryPath || item?.markdownReportPath);
  const reportPath =
    result?.evidence?.reportPath ||
    firstCaseRun?.reportPath ||
    firstStepRun?.reportPath ||
    null;
  const summaryPath =
    result?.evidence?.summaryPath ||
    firstCaseRun?.summaryPath ||
    firstStepRun?.summaryPath ||
    null;
  const markdownReportPath =
    result?.evidence?.markdownReportPath ||
    firstCaseRun?.markdownReportPath ||
    firstStepRun?.markdownReportPath ||
    null;
  const totalCases = caseResults.length || (payload.scope === "selected" || payload.caseId ? 1 : 0);
  const passedCases = caseResults.length
    ? caseResults.filter((item) => item.result?.ok).length
    : result?.ok
      ? totalCases
      : 0;
  return {
    ok: status === "passed",
    status,
    externalRunId: payload.externalRunId || "",
    testFilePath: payload.testFilePath || "",
    scope: payload.scope || "all",
    caseId: payload.caseId || null,
    summary: {
      totalCases,
      passedCases,
      failedCases: Math.max(0, totalCases - passedCases),
      durationMs: result?.telemetry?.durationMs || 0,
      steps: result?.telemetry?.steps || 0,
      okCount: result?.telemetry?.okCount || 0,
      errorCount: result?.telemetry?.errorCount || (status === "failed" ? 1 : 0),
    },
    reportPath,
    summaryPath,
    markdownReportPath,
    error: result?.error || null,
  };
};

const sanitizeNotificationText = (value, fallback = "") => {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 160) : fallback;
};

const showRunFileCompleteNotification = (payload = {}) => {
  if (!Notification.isSupported()) {
    return { success: false, error: "notification-unsupported" };
  }
  const statusKey = payload.status === "stopped" ? "stopped" : payload.ok ? "passed" : "failed";
  const status = statusKey === "stopped" ? "Stopped" : statusKey === "passed" ? "Passed" : "Failed";
  const fileName = sanitizeNotificationText(payload.testFileName, "Run file");
  const passedCases = Number.isFinite(Number(payload.passedCases)) ? Number(payload.passedCases) : null;
  const totalCases = Number.isFinite(Number(payload.totalCases)) ? Number(payload.totalCases) : null;
  const durationText = sanitizeNotificationText(payload.durationText);
  const caseText = passedCases != null && totalCases != null ? `${passedCases}/${totalCases} cases` : "";
  const body = [fileName, caseText, durationText].filter(Boolean).join(" · ");
  const notification = new Notification({
    title: `Run file ${status}`,
    body: body || fileName,
    icon: RUN_FILE_NOTIFICATION_ICONS[statusKey] || APP_ICON_PATH,
    silent: false,
  });
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
  return { success: true };
};

const getPanelPreferencePath = () =>
  path.join(app.getPath("userData"), "panel-preferences.json");

const normalizePanelPreferences = (value = {}) => ({
  openChromeOnSecondaryDisplay: value.openChromeOnSecondaryDisplay !== false,
  maximizeChromeOnLaunch: value.maximizeChromeOnLaunch !== false,
  browserProxyMode: BROWSER_PROXY_MODES.includes(value.browserProxyMode)
    ? value.browserProxyMode
    : "system",
  browserProxyServer: typeof value.browserProxyServer === "string" ? value.browserProxyServer.trim() : "",
  browserProxyBypass: typeof value.browserProxyBypass === "string" ? value.browserProxyBypass.trim() : "",
  appRunReuseLogin: value.appRunReuseLogin !== false,
  browserIdleTimeoutMinutes: normalizeIdleTimeoutMinutes(value.browserIdleTimeoutMinutes),
});

// Clamp the idle-release window to a sane range. 0 disables auto-release; any
// positive value is rounded to whole minutes and capped so a typo can't arm a
// multi-day timer. Missing/invalid falls back to the default.
const IDLE_TIMEOUT_MAX_MINUTES = 240;
const normalizeIdleTimeoutMinutes = (value) => {
  if (value === 0 || value === "0") {
    return 0;
  }
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PANEL_PREFERENCES.browserIdleTimeoutMinutes;
  }
  return Math.min(parsed, IDLE_TIMEOUT_MAX_MINUTES);
};

// Translate the persisted proxy preference into Playwright launch options.
// - system : inherit the OS (WinINET) proxy — current default behavior.
// - direct : ignore any system proxy and connect directly (--no-proxy-server).
// - manual : route through the given proxy, sending `bypass` hosts direct.
//            Playwright turns `proxy.bypass` into --proxy-bypass-list and also
//            appends <-loopback>, which is exactly how internal domains (e.g.
//            *.example.test) get excluded from a local Clash/Mihomo proxy.
const buildBrowserProxyLaunchOptions = (preferences = {}) => {
  const mode = preferences.browserProxyMode || "system";
  if (mode === "direct") {
    return { args: ["--no-proxy-server"] };
  }
  if (mode === "manual") {
    const server = typeof preferences.browserProxyServer === "string" ? preferences.browserProxyServer.trim() : "";
    if (!server) {
      logMainLifecycle("browser-proxy-manual-missing-server", { mode });
      return {};
    }
    const bypass = typeof preferences.browserProxyBypass === "string" ? preferences.browserProxyBypass.trim() : "";
    return { proxy: { server, ...(bypass ? { bypass } : {}) } };
  }
  return {};
};

// Z09: derive the headless RunSession browser context from the same panel
// preferences the visible App-run browser uses, so headless test-sessions load
// the qiankun micro-app the same way the panel does. Returns plain
// launchOptions/contextOptions the framework-agnostic runtime forwards to
// Playwright — no Electron types cross the boundary.
const buildHeadlessBrowserContext = (preferences = {}) =>
  buildHeadlessBrowserContextPure(buildBrowserProxyLaunchOptions(preferences), {
    alignWebSecurity: HEADLESS_ALIGN_WEB_SECURITY,
  });

const readPanelPreferences = () => {
  try {
    const raw = nodeFs.readFileSync(getPanelPreferencePath(), "utf8");
    panelPreferences = normalizePanelPreferences(JSON.parse(raw));
  } catch (_error) {
    panelPreferences = { ...DEFAULT_PANEL_PREFERENCES };
  }
  return { ...panelPreferences };
};

const writePanelPreferences = async (patch = {}) => {
  panelPreferences = normalizePanelPreferences({
    ...panelPreferences,
    ...(patch && typeof patch === "object" ? patch : {}),
  });
  await fs.mkdir(path.dirname(getPanelPreferencePath()), { recursive: true });
  await fs.writeFile(
    getPanelPreferencePath(),
    `${JSON.stringify(panelPreferences, null, 2)}\n`,
    "utf8",
  );
  return { ...panelPreferences };
};

// ---------------------------------------------------------------------------
// Auth auto-renewal engine + heartbeat.
//
// The saved auth profile (headless storageState) silently expires, and today it
// is only discovered when a real run fails mid-way. This keeps it fresh: when
// enabled, a heartbeat re-runs the login-only workflow headlessly on an interval
// ("blind periodic refresh"), writing a fresh storageState back into the target
// profile. The login run's own post-login assert doubles as an active probe —
// if login/session is broken, the renewal is reported failed so the panel can
// warn *before* anyone uses it. Credentials live in the login workflow, not here.
// ---------------------------------------------------------------------------

const AUTH_RENEWAL_CHANNEL = "auth-renewal-status";

// A run is "active" when a visible App-run is queued/running or a headless
// runtime run is in flight. We avoid renewing during an active run: the shared
// single account means a concurrent re-login could disturb an in-progress run.
function isAnyRunActive() {
  if (activeRuntimeRuns.size > 0) {
    return true;
  }
  try {
    const snapshot = appRunQueue.queueSnapshot();
    return (snapshot?.activeCount || 0) > 0 || (snapshot?.queuedCount || 0) > 0;
  } catch (_error) {
    return false;
  }
}

async function persistAuthRenewalConfig(patch = {}) {
  authRenewalConfig = normalizeAuthRenewalConfig({ ...authRenewalConfig, ...patch }, authRenewalConfig);
  try {
    authRenewalConfig = await writeAuthRenewalConfig(AUTH_RENEWAL_CONFIG_PATH, authRenewalConfig);
  } catch (error) {
    logMainLifecycle("auth-renewal-config-write-failed", { message: error?.message || String(error) });
  }
  return { ...authRenewalConfig };
}

// Compute the panel-facing status: local freshness of the stored profile +
// renewal schedule metadata. Pure read (no network) so it is cheap to call on
// panel/Settings mount.
async function getAuthStatusSnapshot(profileOverride) {
  const profile = profileOverride || authRenewalConfig.profile;
  const status = await getAuthProfileStatus(profile, { outputRoot: OUTPUT_ROOT });
  const lastRenewAtMs = authRenewalConfig.lastRenewAt ? Date.parse(authRenewalConfig.lastRenewAt) : null;
  const nextRenewAtMs =
    authRenewalConfig.enabled && Number.isFinite(lastRenewAtMs)
      ? lastRenewAtMs + authRenewalConfig.intervalMinutes * 60 * 1000
      : null;
  return {
    ok: true,
    profile,
    status, // { status, authenticated, staleness, capturedAt, earliestCookieExpiry, expiresInMs, ... }
    renewal: {
      enabled: authRenewalConfig.enabled,
      profile: authRenewalConfig.profile,
      loginTestFilePath: authRenewalConfig.loginTestFilePath,
      intervalMinutes: authRenewalConfig.intervalMinutes,
      lastRenewAt: authRenewalConfig.lastRenewAt,
      lastRenewStatus: authRenewalConfig.lastRenewStatus,
      lastRenewError: authRenewalConfig.lastRenewError,
      nextRenewAt: Number.isFinite(nextRenewAtMs) ? new Date(nextRenewAtMs).toISOString() : null,
      inFlight: authRenewalInFlight,
    },
  };
}

function broadcastAuthRenewalStatus(snapshot) {
  emitToPanel(AUTH_RENEWAL_CHANNEL, snapshot);
}

// Run the login-only workflow headlessly against the target profile, forcing the
// login steps (authBootstrap:"run"). RunSession writes the fresh storageState
// back into the profile on close. Returns { ok, status, error }.
async function renewAuthProfile({ reason = "manual", force = false } = {}) {
  const profile = authRenewalConfig.profile;
  const loginTestFilePath = authRenewalConfig.loginTestFilePath;
  if (authRenewalInFlight) {
    return { ok: false, skipped: "in-flight" };
  }
  if (!force && isAnyRunActive()) {
    logMainLifecycle("auth-renewal-skipped-active-run", { reason, profile });
    return { ok: false, skipped: "active-run" };
  }
  authRenewalInFlight = true;
  broadcastAuthRenewalStatus(await getAuthStatusSnapshot());
  logMainLifecycle("auth-renewal-start", { reason, profile, loginTestFilePath });
  let outcome = { ok: false };
  try {
    const { statusCode, payload } = await runHeadlessSession(
      {
        testFilePath: loginTestFilePath,
        authProfile: profile,
        authBootstrap: "run",
        qualityGate: "advisory",
      },
      {
        createTestSession,
        store: TEST_SESSION_STORE,
        outputRoot: OUTPUT_ROOT,
        testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
        outputRunsRoot: OUTPUT_RUNS_ROOT,
        browserContext: buildHeadlessBrowserContext(panelPreferences),
        checkpointsRoot: CHECKPOINTS_ROOT,
        launchBrowser: launchSharedBrowser,
      },
    );
    const passed = statusCode === 200 && payload?.ok !== false && payload?.status === "passed";
    outcome = {
      ok: passed,
      status: payload?.status || null,
      error: passed
        ? null
        : {
            code: payload?.error?.code || "auth-renewal-failed",
            message:
              payload?.error?.message ||
              (payload?.firstFailure ? `Login run did not pass (${payload.status}).` : "Login run did not pass."),
          },
    };
  } catch (error) {
    outcome = {
      ok: false,
      status: null,
      error: { code: error?.code || "auth-renewal-error", message: error?.message || String(error) },
    };
  } finally {
    authRenewalInFlight = false;
  }
  await persistAuthRenewalConfig({
    lastRenewAt: new Date().toISOString(),
    lastRenewStatus: outcome.ok ? "passed" : "failed",
    lastRenewError: outcome.ok ? null : outcome.error,
  });
  logMainLifecycle("auth-renewal-done", { reason, profile, ok: outcome.ok, status: outcome.status });
  const snapshot = await getAuthStatusSnapshot();
  broadcastAuthRenewalStatus(snapshot);
  if (!outcome.ok && Notification.isSupported()) {
    // Surface a failed renewal proactively so it's known before someone uses it.
    try {
      const notification = new Notification({
        title: "Zhuzhu · 认证续期失败",
        body: sanitizeNotificationText(
          `auth profile「${profile}」自动续期失败：${outcome.error?.message || "登录未通过"}`,
        ),
        icon: RUN_FILE_NOTIFICATION_ICONS.failed || APP_ICON_PATH,
        silent: false,
      });
      notification.show();
    } catch (_error) {
      // notifications are best-effort
    }
  }
  return { ...outcome, snapshot };
}

// Arm/re-arm the heartbeat from the current config. When enabled, every
// intervalMinutes we blind-refresh (A-2) so the profile never drifts stale;
// active runs defer the tick. `.unref()` so the timer never keeps the app alive.
function restartAuthRenewalHeartbeat() {
  if (authRenewalTimer) {
    clearInterval(authRenewalTimer);
    authRenewalTimer = null;
  }
  if (!authRenewalConfig.enabled) {
    return;
  }
  const periodMs = Math.max(1, authRenewalConfig.intervalMinutes) * 60 * 1000;
  authRenewalTimer = setInterval(() => {
    renewAuthProfile({ reason: "heartbeat" }).catch((error) => {
      logMainLifecycle("auth-renewal-heartbeat-error", { message: error?.message || String(error) });
    });
  }, periodMs);
  if (typeof authRenewalTimer.unref === "function") {
    authRenewalTimer.unref();
  }
  logMainLifecycle("auth-renewal-heartbeat-armed", {
    intervalMinutes: authRenewalConfig.intervalMinutes,
    profile: authRenewalConfig.profile,
  });
}

// Called once the app run server is up: arm the heartbeat, and if enabled and
// overdue (last renew older than the interval), kick a background renew so a
// long-idle app doesn't wait a whole period before refreshing.
function initAuthRenewal() {
  restartAuthRenewalHeartbeat();
  if (!authRenewalConfig.enabled) {
    return;
  }
  const lastRenewAtMs = authRenewalConfig.lastRenewAt ? Date.parse(authRenewalConfig.lastRenewAt) : null;
  const overdue =
    !Number.isFinite(lastRenewAtMs) ||
    Date.now() - lastRenewAtMs >= authRenewalConfig.intervalMinutes * 60 * 1000;
  if (overdue) {
    renewAuthProfile({ reason: "startup-overdue" }).catch(() => {});
  }
}

function sanitizePdfFileName(value, fallback = "run-report") {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 90);
  return normalized || fallback;
}

function ensurePdfExtension(filePath) {
  return path.extname(filePath).toLowerCase() === ".pdf" ? filePath : `${filePath}.pdf`;
}

function waitForWebContentsLoad(webContents) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      webContents.removeListener("did-finish-load", handleFinish);
      webContents.removeListener("did-fail-load", handleFail);
      webContents.removeListener("render-process-gone", handleGone);
    };
    const handleFinish = () => {
      cleanup();
      resolve();
    };
    const handleFail = (_event, errorCode, errorDescription) => {
      cleanup();
      reject(new Error(`PDF document failed to load: ${errorCode} ${errorDescription}`));
    };
    const handleGone = (_event, details) => {
      cleanup();
      reject(new Error(`PDF document renderer exited: ${details?.reason || "unknown"}`));
    };
    webContents.once("did-finish-load", handleFinish);
    webContents.once("did-fail-load", handleFail);
    webContents.once("render-process-gone", handleGone);
  });
}

async function exportPanelPdf(event, payload = {}) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) {
    return {
      success: false,
      error: "window-unavailable",
      message: "The panel window is unavailable.",
    };
  }

  const title = sanitizePdfFileName(payload?.title || payload?.testFileName || "run-report");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultPath = path.join(app.getPath("downloads"), `${title}-${timestamp}.pdf`);
  const selection = await dialog.showSaveDialog(senderWindow, {
    title: "Export report PDF",
    defaultPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (selection.canceled || !selection.filePath) {
    return { success: false, canceled: true };
  }
  const targetPath = ensurePdfExtension(selection.filePath);

  let printWindow = null;
  let tempHtmlPath = "";
  try {
    if (payload?.kind === "professional-run-report" && payload?.model && typeof payload.model === "object") {
      await writeProfessionalReportPdf(targetPath, payload.model);
      const stat = await fs.stat(targetPath);
      return {
        success: true,
        path: targetPath,
        bytes: stat.size,
        engine: "pdfkit",
      };
    }

    const html = typeof payload?.html === "string" ? payload.html : "";
    const printTarget = html ? null : event.sender;
    if (html) {
      const tempDir = await fs.mkdtemp(path.join(app.getPath("temp"), "zhuzhu-report-pdf-"));
      tempHtmlPath = path.join(tempDir, "report.html");
      await fs.writeFile(tempHtmlPath, html, "utf8");
      printWindow = new BrowserWindow({
        show: false,
        width: 1240,
        height: 1754,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      const loadPromise = waitForWebContentsLoad(printWindow.webContents);
      await printWindow.loadFile(tempHtmlPath);
      await loadPromise;
      await printWindow.webContents.executeJavaScript("document.fonts?.ready ? document.fonts.ready.then(() => true) : true", true);
    }

    const pdfBuffer = await (printWindow?.webContents || printTarget).printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: {
        marginType: "custom",
        top: 0.08,
        bottom: 0.08,
        left: 0.08,
        right: 0.08,
      },
    });
    await fs.writeFile(targetPath, pdfBuffer);
    return {
      success: true,
      path: targetPath,
      bytes: pdfBuffer.length,
    };
  } finally {
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.close();
    }
    if (tempHtmlPath) {
      fs.rm(path.dirname(tempHtmlPath), { recursive: true, force: true }).catch(() => {});
    }
  }
}

const logMainError = (message, error) => {
  console.error(`[main] ${message}: ${error?.stack || error?.message || String(error)}`);
};

process.on("uncaughtException", (error) => {
  logMainError("uncaughtException", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logMainError("unhandledRejection", reason);
});

const getAssetUrl = (...segments) =>
  pathToFileURL(path.join(__dirname, "..", "..", ...segments)).toString();

const clearRuntimeRequireCache = () => {
  for (const modulePath of Object.keys(require.cache)) {
    if (modulePath === RUNTIME_ROOT || modulePath.startsWith(`${RUNTIME_ROOT}${path.sep}`)) {
      delete require.cache[modulePath];
    }
  }
};

// v1.8 perf: the runtime module tree is loaded once, not once per run.
//
// Purging ~40 modules from `require.cache` before every run meant re-parsing and
// re-instantiating all of them each time — and, worse, the discarded module
// objects stay alive for as long as anything still references them (a closure, a
// registered listener), so a long batch grew the main-process heap monotonically
// with no way to attribute it.
//
// The only thing the purge bought was picking up edited engine source without
// restarting, which matters in development and never in production. `npm run
// dev` already restarts the main process on file changes, so the default is now
// off; set ZHUZHU_RUNTIME_HOT_RELOAD=1 to get the old behaviour back.
const RUNTIME_HOT_RELOAD =
  process.env.ZHUZHU_RUNTIME_HOT_RELOAD === "1" || process.env.ZHUZHU_RUNTIME_HOT_RELOAD === "true";

const loadRuntimeRunner = () => {
  if (RUNTIME_HOT_RELOAD) {
    clearRuntimeRequireCache();
  }
  return require("../../runtime").run;
};

const isInsideDirectory = (targetPath, rootPath) => {
  const relative = path.relative(rootPath, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// Shared by the protocol handler and the legacy base64 reader, so there is one
// implementation of "may the renderer see this file" rather than two that can
// drift. Returns the resolved path + mime, or an error code.
const resolveEvidenceImagePath = (rawPath) => {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { error: "invalid-path" };
  }
  const targetPath = path.resolve(rawPath);
  if (!isInsideDirectory(targetPath, OUTPUT_ROOT)) {
    return { error: "path-not-allowed" };
  }
  const mimeType = IMAGE_MIME_BY_EXTENSION.get(path.extname(targetPath).toLowerCase());
  if (!mimeType) {
    return { error: "unsupported-image-type" };
  }
  return { targetPath, mimeType };
};

// `zhuzhu-evidence://image/?path=<absolute path>`. The absolute path travels in
// the query rather than the pathname because Windows paths contain a drive
// letter and backslashes, which a URL pathname mangles. It is validated against
// OUTPUT_ROOT on the way back in — the renderer cannot name a file outside it.
const buildEvidenceImageUrl = (rawPath) => {
  const resolved = resolveEvidenceImagePath(rawPath);
  if (resolved.error) {
    return null;
  }
  return `${EVIDENCE_SCHEME}://image/?path=${encodeURIComponent(resolved.targetPath)}`;
};

const registerEvidenceProtocol = () => {
  protocol.handle(EVIDENCE_SCHEME, async (request) => {
    let requestedPath = "";
    try {
      requestedPath = new URL(request.url).searchParams.get("path") || "";
    } catch (_error) {
      return new Response("bad request", { status: 400 });
    }
    const resolved = resolveEvidenceImagePath(requestedPath);
    if (resolved.error) {
      return new Response(resolved.error, { status: resolved.error === "path-not-allowed" ? 403 : 400 });
    }
    try {
      const response = await net.fetch(pathToFileURL(resolved.targetPath).toString());
      // Evidence files are immutable once written, so the renderer may cache
      // them for the life of the window; that is the whole point of moving off
      // data URLs.
      const headers = new Headers(response.headers);
      headers.set("Content-Type", resolved.mimeType);
      headers.set("Cache-Control", "private, max-age=31536000, immutable");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      logMainError(`failed to serve evidence image ${resolved.targetPath}`, error);
      return new Response("not found", { status: 404 });
    }
  });
};

const readEvidenceImage = async (rawPath) => {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { success: false, error: "invalid-path" };
  }

  const targetPath = path.resolve(rawPath);
  if (!isInsideDirectory(targetPath, OUTPUT_ROOT)) {
    return { success: false, error: "path-not-allowed" };
  }

  const mimeType = IMAGE_MIME_BY_EXTENSION.get(path.extname(targetPath).toLowerCase());
  if (!mimeType) {
    return { success: false, error: "unsupported-image-type" };
  }

  try {
    const file = await fs.readFile(targetPath);
    return {
      success: true,
      path: targetPath,
      mimeType,
      dataUrl: `data:${mimeType};base64,${file.toString("base64")}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "read-failed",
      message: error?.message || String(error),
    };
  }
};

const readEvidenceJson = async (rawPath) => {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { success: false, error: "invalid-path" };
  }

  const targetPath = path.resolve(rawPath);
  if (!isInsideDirectory(targetPath, OUTPUT_RUNS_ROOT)) {
    return { success: false, error: "path-not-allowed" };
  }
  if (path.extname(targetPath).toLowerCase() !== ".json") {
    return { success: false, error: "unsupported-json-type" };
  }

  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return {
      success: true,
      path: targetPath,
      data: JSON.parse(raw),
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "read-failed",
      message: error?.message || String(error),
    };
  }
};

const appendDebugLog = async (payload = {}) => {
  await fs.mkdir(DEBUG_LOG_ROOT, { recursive: true });
  const entry = {
    recordedAt: new Date().toISOString(),
    pid: process.pid,
    ...payload,
  };
  await fs.appendFile(BUILD_CASES_RUN_DEBUG_LOG, `${JSON.stringify(entry)}\n`, "utf8");
  return {
    success: true,
    path: BUILD_CASES_RUN_DEBUG_LOG,
  };
};

const ensureTestWorkflowsRoot = async () => {
  await fs.mkdir(TEST_WORKFLOWS_ROOT, { recursive: true });
};

const resolveTestWorkflowPath = (rawPath) => {
  if (!isSafeRelativeTestFilePath(rawPath)) {
    return null;
  }
  const targetPath = path.resolve(TEST_WORKFLOWS_ROOT, rawPath);
  if (!isInsideDirectory(targetPath, TEST_WORKFLOWS_ROOT) && targetPath !== TEST_WORKFLOWS_ROOT) {
    return null;
  }
  return targetPath;
};

const getRelativeTestWorkflowPath = (targetPath) =>
  path.relative(TEST_WORKFLOWS_ROOT, targetPath).split(path.sep).join("/");

const markInternalTestWorkflowWrite = (targetPath) => {
  recentInternalTestWorkflowWrites.set(path.resolve(targetPath), Date.now() + 2000);
};

const shouldIgnoreInternalTestWorkflowEvent = (targetPath) => {
  const resolvedPath = path.resolve(targetPath);
  const expiresAt = recentInternalTestWorkflowWrites.get(resolvedPath);
  if (!expiresAt) {
    return false;
  }
  if (Date.now() <= expiresAt) {
    return true;
  }
  recentInternalTestWorkflowWrites.delete(resolvedPath);
  return false;
};

const pruneInternalTestWorkflowWrites = () => {
  const now = Date.now();
  for (const [filePath, expiresAt] of recentInternalTestWorkflowWrites.entries()) {
    if (expiresAt <= now) {
      recentInternalTestWorkflowWrites.delete(filePath);
    }
  }
};

const queueTestWorkflowChange = (eventType, rawFilename) => {
  pruneInternalTestWorkflowWrites();
  const filename = typeof rawFilename === "string" ? rawFilename : rawFilename?.toString?.();
  if (!filename) {
    pendingTestWorkflowChanges.set("__unknown__", {
      path: null,
      eventType,
      updatedAt: new Date().toISOString(),
    });
  } else {
    const targetPath = path.resolve(TEST_WORKFLOWS_ROOT, filename);
    if (!isInsideDirectory(targetPath, TEST_WORKFLOWS_ROOT)) {
      return;
    }
    if (path.extname(targetPath).toLowerCase() !== ".json") {
      return;
    }
    if (shouldIgnoreInternalTestWorkflowEvent(targetPath)) {
      return;
    }
    const relativePath = getRelativeTestWorkflowPath(targetPath);
    pendingTestWorkflowChanges.set(relativePath, {
      path: relativePath,
      eventType,
      updatedAt: new Date().toISOString(),
    });
  }
  if (pendingTestWorkflowChangeTimer) {
    clearTimeout(pendingTestWorkflowChangeTimer);
  }
  pendingTestWorkflowChangeTimer = setTimeout(() => {
    pendingTestWorkflowChangeTimer = null;
    const changes = Array.from(pendingTestWorkflowChanges.values());
    pendingTestWorkflowChanges.clear();
    emitToPanel("test-file-change", { changes });
  }, 150);
};

const startTestWorkflowWatcher = async () => {
  if (testWorkflowWatcher) {
    return;
  }
  await ensureTestWorkflowsRoot();
  try {
    testWorkflowWatcher = nodeFs.watch(TEST_WORKFLOWS_ROOT, { recursive: true }, queueTestWorkflowChange);
    testWorkflowWatcher.on("error", (error) => {
      logMainError("test workflow watcher failed", error);
    });
    logMainLifecycle("test-workflow-watcher-started", {
      root: TEST_WORKFLOWS_ROOT,
    });
  } catch (error) {
    logMainError("test workflow watcher failed to start", error);
  }
};

const stopTestWorkflowWatcher = () => {
  if (pendingTestWorkflowChangeTimer) {
    clearTimeout(pendingTestWorkflowChangeTimer);
    pendingTestWorkflowChangeTimer = null;
  }
  pendingTestWorkflowChanges.clear();
  if (testWorkflowWatcher) {
    testWorkflowWatcher.close();
    testWorkflowWatcher = null;
  }
};

const listJsonFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(target));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      files.push(target);
    }
  }
  return files;
};

const listReportFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "steps") {
        continue;
      }
      files.push(...await listReportFiles(target));
    } else if (entry.isFile() && entry.name === "report.json") {
      files.push(target);
    }
  }
  return files;
};

const readTestWorkflowFile = async (relativePath) => {
  await ensureTestWorkflowsRoot();
  const targetPath = resolveTestWorkflowPath(relativePath);
  if (!targetPath) {
    return { success: false, error: "invalid-path" };
  }
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const testFile = resolveAndNormalizeTestFile(JSON.parse(raw), {
      rootDir: TEST_WORKFLOWS_ROOT,
      sourcePath: getRelativeTestWorkflowPath(targetPath),
    });
    return {
      success: true,
      path: getRelativeTestWorkflowPath(targetPath),
      testFile,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "read-failed",
      message: error?.message || String(error),
    };
  }
};

const readRawTestWorkflowJson = async (relativePath) => {
  await ensureTestWorkflowsRoot();
  const targetPath = resolveTestWorkflowPath(relativePath);
  if (!targetPath) {
    const error = new Error("Invalid test file path.");
    error.code = "invalid-path";
    throw error;
  }
  return {
    path: getRelativeTestWorkflowPath(targetPath),
    raw: JSON.parse(await fs.readFile(targetPath, "utf8")),
  };
};

const evaluateTestWorkflowFile = async (payload = {}) => {
  try {
    const mode = payload.mode === "gate" || payload.mode === "patch-review" ? payload.mode : "advisory";
    const source = payload.testFile && typeof payload.testFile === "object"
      ? { path: payload.path || "", raw: payload.testFile }
      : await readRawTestWorkflowJson(payload.testFilePath || payload.path);
    const result = precheckTestFile({
      testFile: source.raw,
      path: source.path,
      rootDir: TEST_WORKFLOWS_ROOT,
      mode,
      dryRun: payload.dryRun,
      appContract: payload.appContract,
    });
    return {
      success: true,
      path: source.path,
      mode,
      result,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code || "evaluate-failed",
      message: error?.message || String(error),
    };
  }
};

const runPanelTestSession = async (payload = {}) => {
  try {
    const result = await createTestSession({
      testFilePath: payload.testFilePath || payload.path,
      testFile: payload.testFile,
      // v1.10 Z27: a target that names its own profile must not collide with
      // the panel's default one.
      authProfile: payload.authProfile || (payload.target?.authProfile ? undefined : "demo-local"),
      ...(payload.target ? { target: payload.target } : {}),
      ...(payload.stepOcr ? { stepOcr: payload.stepOcr } : {}),
      scope: payload.scope || "all",
      caseIds: Array.isArray(payload.caseIds) ? payload.caseIds : [],
      runNow: payload.runNow !== false,
      qualityGate: payload.qualityGate || "gate",
      allowBlocked: payload.allowBlocked === true,
      authBootstrap: payload.authBootstrap || "auto",
      feedback: payload.feedback || "Panel Evaluate run",
      // Z11: optional checkpoint save / resume for this run.
      ...(payload.checkpoint ? { checkpoint: payload.checkpoint } : {}),
      ...(payload.resume ? { resume: payload.resume } : {}),
    }, {
      store: TEST_SESSION_STORE,
      outputRoot: OUTPUT_ROOT,
      testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
      outputRunsRoot: OUTPUT_RUNS_ROOT,
      browserContext: buildHeadlessBrowserContext(panelPreferences),
      checkpointsRoot: CHECKPOINTS_ROOT,
      launchBrowser: launchSharedBrowser,
    });
    const repairContext = result.response?.sessionId
      ? await TEST_SESSION_STORE.readLatestRoundArtifact(result.response.sessionId, "repair-context.json")
      : null;
    return {
      success: true,
      ...result.response,
      diagnosis: result.diagnosis || null,
      repairContext: repairContext?.json || null,
      repairContextPath: repairContext?.path || result.response?.repairContextPath || null,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code || "test-session-failed",
      message: error?.message || String(error),
    };
  }
};

// Z10 (panel entry): run several test files in parallel from the panel. Each
// file is an independent headless session (own Chromium), driven by the shared
// `runBatch` worker pool at concurrency K; per-item start/finish is pushed to the
// renderer over `test-batch-progress` so the UI streams live per-file status
// (the panel's equivalent of the HTTP SSE stream). Returns the aggregate once the
// whole batch settles.
const runPanelTestBatch = async (payload = {}) => {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    return { success: false, error: "empty-batch", message: "Select at least one test file to run." };
  }
  externalBatchSeq += 1;
  const batchId = `panel-batch-${Date.now()}-${externalBatchSeq}`;
  const concurrency = Number.isFinite(Number(payload.concurrency)) && Number(payload.concurrency) >= 1
    ? Math.floor(Number(payload.concurrency))
    : (APP_RUN_MAX_CONCURRENT > 1 ? APP_RUN_MAX_CONCURRENT : 2);
  const browserContext = buildHeadlessBrowserContext(panelPreferences);

  emitToPanel("test-batch-progress", {
    batchId,
    type: "batch-start",
    total: items.length,
    concurrency,
  });
  // v1.11 REQ-Z33: items waiting for a worker show up as queued on the run board.
  const boardPlaceholders = registerBatchPlaceholders(getRunBoard({ outputRoot: OUTPUT_ROOT }), {
    items,
    trigger: "panel-batch",
    batchId,
  });

  const { results, stats } = await runParallelBatch({
    items,
    concurrency,
    runItem: async (item, index) => {
      const testFilePath = item?.testFilePath || item?.path || null;
      boardPlaceholders.start(index);
      emitToPanel("test-batch-progress", {
        batchId,
        type: "item-start",
        index,
        testFilePath,
      });
      try {
        const result = await createTestSession({
          testFilePath,
          testFile: item?.testFile,
          // v1.10 Z27: per-item target wins over the batch-level one.
          authProfile: item?.authProfile || payload.authProfile
            || ((item?.target || payload.target)?.authProfile ? undefined : "demo-local"),
          ...((item?.target || payload.target) ? { target: item?.target || payload.target } : {}),
          ...((item?.stepOcr || payload.stepOcr) ? { stepOcr: item?.stepOcr || payload.stepOcr } : {}),
          scope: item?.scope || payload.scope || "all",
          caseIds: Array.isArray(item?.caseIds) ? item.caseIds : [],
          runNow: true,
          qualityGate: item?.qualityGate || payload.qualityGate || "gate",
          allowBlocked: item?.allowBlocked === true || payload.allowBlocked === true,
          authBootstrap: item?.authBootstrap || payload.authBootstrap || "auto",
          feedback: payload.feedback || "Panel batch run",
          batchId,
        }, {
          trigger: "panel-batch",
          store: TEST_SESSION_STORE,
          outputRoot: OUTPUT_ROOT,
          testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
          outputRunsRoot: OUTPUT_RUNS_ROOT,
          browserContext,
          launchBrowser: launchSharedBrowser,
        });
        emitToPanel("test-batch-progress", {
          batchId,
          type: "item-complete",
          index,
          testFilePath,
          status: result.response?.status || (result.response?.ok === false ? "failed" : "passed"),
          sessionId: result.response?.sessionId || null,
          reportPath: result.response?.reportPath || null,
        });
        return result.response;
      } catch (error) {
        // Always emit item-complete — otherwise a thrown session (e.g. bad path,
        // headless launch failure) leaves the panel row stuck at "running".
        const failure = {
          code: error?.code || "test-session-failed",
          message: error?.message || String(error),
        };
        logMainLifecycle("panel-batch-item-failed", { testFilePath, ...failure });
        emitToPanel("test-batch-progress", {
          batchId,
          type: "item-complete",
          index,
          testFilePath,
          status: "error",
          error: failure,
        });
        throw error;
      }
    },
  });

  const sessions = results.map((entry, index) => (entry?.ok
    ? { ok: true, testFilePath: items[index]?.testFilePath || items[index]?.path || null, ...entry.value }
    : {
        ok: false,
        testFilePath: items[index]?.testFilePath || items[index]?.path || null,
        error: entry?.error || { code: "batch-item-failed", message: "Unknown batch item failure." },
      }));
  emitToPanel("test-batch-progress", {
    batchId,
    type: "batch-complete",
    stats,
  });
  return { success: true, batchId, sessions, stats };
};

const readPanelRepairContext = async (payload = {}) => {
  const sessionId = payload.sessionId || payload.id;
  if (!sessionId) {
    return { success: false, error: "missing-session-id" };
  }
  const context = payload.roundId
    ? await TEST_SESSION_STORE.readRoundArtifact(sessionId, payload.roundId, "repair-context.json")
    : await TEST_SESSION_STORE.readLatestRoundArtifact(sessionId, "repair-context.json");
  if (!context) {
    return { success: false, error: "repair-context-not-found" };
  }
  return {
    success: true,
    path: context.path,
    json: context.json,
  };
};

const validateExternalAppRunRequest = async (body = {}) => {
  const testFilePath = typeof body.testFilePath === "string" ? body.testFilePath.trim() : "";
  if (!isSafeRelativeTestFilePath(testFilePath)) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        ok: false,
        status: "rejected",
        error: { code: "invalid-test-file-path", message: "testFilePath must be a safe relative JSON path under test-workflows/." },
      },
    };
  }
  const source = await readRawTestWorkflowJson(testFilePath);
  let resolvedTestFile = resolveAndNormalizeTestFile(source.raw, {
    rootDir: TEST_WORKFLOWS_ROOT,
    sourcePath: source.path,
  });
  // v1.10 Z27: the visible channel honours the same run target as headless —
  // origins materialised into the file, target vars merged over file vars, and
  // the credential injected at run time (never written into the file or queue).
  let appRunTarget = null;
  try {
    const target = normalizeRunTarget(body.target ?? null);
    const applied = applyRunTarget(resolvedTestFile, target);
    resolvedTestFile = target
      ? { ...applied.testFile, vars: { ...(applied.testFile.vars || {}), ...(target.vars || {}) } }
      : applied.testFile;
    if (target) {
      const gate = await checkRunTargetGates({ target, applied, workspaceRoot: APP_WORKSPACE_ROOT });
      if (!gate.ok) {
        return {
          ok: false,
          statusCode: 409,
          body: { ok: false, status: "blocked", error: { ...gate.error, failureType: "target-unavailable" } },
        };
      }
      appRunTarget = {
        description: describeRunTarget(target, applied),
        credentialVariables: gate.credentialVariables,
        secretValues: gate.secretValues,
      };
    }
  } catch (error) {
    return {
      ok: false,
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 400,
      body: {
        ok: false,
        status: "rejected",
        error: {
          code: error?.code || "invalid-target",
          message: error?.message || String(error),
          ...(error?.details ? { details: error.details } : {}),
        },
      },
    };
  }
  const precheck = precheckTestFile({
    testFile: resolvedTestFile,
    path: source.path,
    rootDir: TEST_WORKFLOWS_ROOT,
    mode: "gate",
  });
  if (precheck?.summary?.errorCount > 0) {
    return {
      ok: false,
      statusCode: 422,
      body: {
        ok: false,
        status: "precheck-failed",
        externalRunId: "",
        testFilePath: source.path,
        scope: normalizeExternalAppRunScope(body.scope, Boolean(body.caseId)),
        caseId: body.caseId || null,
        summary: null,
        reportPath: null,
        error: {
          code: "precheck-failed",
          message: `Precheck failed with ${precheck.summary.errorCount} error(s).`,
          precheck,
        },
      },
    };
  }
  const caseId = typeof body.caseId === "string" && body.caseId.trim() ? body.caseId.trim() : null;
  if (caseId && !resolvedTestFile.cases.some((item) => item.id === caseId)) {
    return {
      ok: false,
      statusCode: 404,
      body: {
        ok: false,
        status: "rejected",
        externalRunId: "",
        testFilePath: source.path,
        scope: "selected",
        caseId,
        summary: null,
        reportPath: null,
        error: { code: "case-not-found", message: `Case "${caseId}" was not found in ${source.path}.` },
      },
    };
  }
  const externalRunId = `external-app-run-${Date.now()}-${++externalAppRunSeq}`;
  if (appRunTarget) {
    APP_RUN_TARGETS.set(externalRunId, appRunTarget);
  }
  return {
    ok: true,
    request: {
      externalRunId,
      testFilePath: source.path,
      testFile: resolvedTestFile,
      scope: normalizeExternalAppRunScope(body.scope, Boolean(caseId)),
      caseId,
      runOptions: body.runOptions && typeof body.runOptions === "object" ? body.runOptions : {},
    },
  };
};

// Panel reports a finished visible run (via IPC). Look the run up in the queue,
// clear its timeout, summarize, and finalize it (which pumps the next queued run).
const completeExternalAppRun = (payload = {}) => {
  const runId = payload.externalRunId;
  const record = runId ? appRunQueue.getRun(runId) : null;
  if (!runId || !record) {
    return { success: false, error: "external-app-run-not-active" };
  }
  const timer = appRunTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
    appRunTimers.delete(runId);
  }
  // v1.10 Z27: the run is over; drop its credential.
  APP_RUN_TARGETS.delete(runId);
  const response = summarizeExternalRunResult({
    ...payload,
    testFilePath: payload.testFilePath || record.testFilePath,
    scope: payload.scope || record.scope,
    caseId: payload.caseId || record.caseId,
  });
  const finalized = appRunQueue.complete(runId, response);
  return finalized ? { success: true } : { success: false, error: "external-app-run-not-active" };
};

// Panel-pushed per-case / per-step progress for a live visible run (via IPC).
const recordExternalAppRunProgress = (payload = {}) => {
  const runId = payload.externalRunId;
  if (!runId) {
    return { success: false, error: "missing-run-id" };
  }
  const event = appRunQueue.appendProgress(runId, {
    phase: payload.phase || "progress",
    caseId: payload.caseId || null,
    caseName: payload.caseName || null,
    stepIndex: typeof payload.stepIndex === "number" ? payload.stepIndex : null,
    stepTitle: payload.stepTitle || null,
    status: payload.status || null,
    detail: payload.detail || null,
  });
  return { success: Boolean(event) };
};

// Z05: report whether the *live visible panel* browser is currently logged in,
// using the same hasAuthEvidence() semantics headless auth profiles use. Lets a
// test file / dispatcher query login state instead of guessing includeRootSteps.
const getPanelAuthStatus = async () => {
  if (!isBrowserAdapterReady() || !browserAdapter?.context) {
    return {
      ok: true,
      surface: "app-run-panel",
      ready: false,
      authenticated: false,
      url: null,
      cookieCount: 0,
    };
  }
  try {
    const storageState = await browserAdapter.context.storageState();
    return {
      ok: true,
      surface: "app-run-panel",
      ready: true,
      authenticated: hasAuthEvidence(storageState),
      url: browserAdapter.getURL?.() || null,
      cookieCount: Array.isArray(storageState?.cookies) ? storageState.cookies.length : 0,
    };
  } catch (error) {
    return {
      ok: false,
      surface: "app-run-panel",
      ready: true,
      authenticated: false,
      url: browserAdapter.getURL?.() || null,
      error: { code: "panel-auth-read-failed", message: error?.message || String(error) },
    };
  }
};

// Z12: enqueue a visible App-run from the MCP `run_app` tool, mirroring the
// /app-runs/run-file HTTP route (validate -> panel-ready check -> enqueue ->
// optional wait) but returning a plain payload object instead of writing HTTP.
const runExternalAppRunViaMcp = async (args = {}) => {
  const validated = await validateExternalAppRunRequest(args);
  if (!validated.ok) {
    return { ok: false, status: validated.body?.status || "rejected", ...validated.body };
  }
  if (!mainWindow || mainWindow.isDestroyed() || !externalAppRunReady) {
    return {
      ok: false,
      status: "app-unavailable",
      externalRunId: validated.request.externalRunId,
      testFilePath: validated.request.testFilePath,
      scope: validated.request.scope,
      caseId: validated.request.caseId,
      error: { code: "app-not-ready", message: "Zhuzhu panel is not ready to accept external app runs.", retriable: true },
    };
  }
  const enqueued = appRunQueue.enqueue(validated.request);
  if (args.wait === true) {
    return appRunQueue.wait(validated.request.externalRunId);
  }
  return buildEnqueueResponse(enqueued, validated.request);
};

// Z12: unified run-summary reader for the MCP `get_run_summary` tool. Accepts
// both App-run ids (queue) and headless session ids (session store), so callers
// poll one tool regardless of which run kind produced the id.
// v1.4 REQ-Z15-3: headless results are returned *flattened* (status / terminal /
// firstFailure / reportPath at the top level, identical to what a blocking
// `run_headless` returns) so polling a handle to a terminal state and blocking
// on the submit yield the same fields. The raw session document stays under
// `data` for callers that already read it.
const readRunSummaryViaMcp = async ({ runId } = {}) => {
  const id = typeof runId === "string" ? runId.trim() : "";
  if (!id) {
    return { ok: false, error: { code: "run-id-required", message: "runId is required.", retriable: false } };
  }
  const appRun = appRunQueue.getRun(id);
  if (appRun) {
    return { ok: true, kind: "app-run", terminal: isTerminalAppRunStatus(appRun.status), ...appRun };
  }
  const session = await TEST_SESSION_STORE.readSession(id).catch(() => null);
  if (session) {
    const summary = summarizeSessionDoc(session);
    return {
      ok: true,
      kind: "headless",
      ...summary,
      active: isTestSessionActive(id),
      ...(summary.terminal
        ? {}
        : {
            poll: { tool: "get_run_summary", args: { runId: id }, endpoint: `/test-sessions/${id}` },
          }),
      data: session,
    };
  }
  return { ok: false, error: { code: "not-found", message: `Run "${id}" was not found (checked App-run queue and headless sessions).`, retriable: false } };
};

// Z12: assemble the deps object the in-process MCP server calls. Each entry is a
// thin wrapper over the same helpers the HTTP routes use, so the MCP contract
// stays lock-step with the current protocol and the tool schema = current API.
// v1.5 Z-M: `requestContext` carries the calling request's headers + remote
// address so the write-group privilege gate can be evaluated per call. The MCP
// route hosts read AND write tools on one path, so authorization has to happen
// at tool granularity, not at the transport.
const buildMcpDeps = (requestOrigin, requestContext = {}) => ({
  serverVersion: app.getVersion?.() || "0.0.0",
  getIntegrationDoc: async () => ({ ok: true, ...(await readExternalIntegrationDocuments(requestOrigin)) }),
  // v1.9 REQ-Z25: the same catalog GET /capabilities serves, so the two surfaces
  // can never disagree about what exists or where it lives.
  getCapabilities: async (args) => {
    const data = getCapabilityData();
    const filtered = data.capabilities.filter((item) => {
      if (args?.surface && item.surface !== "both" && item.surface !== args.surface) {
        return false;
      }
      if (args?.status && item.status !== args.status) {
        return false;
      }
      return true;
    });
    return { ok: true, ...data, capabilities: filtered, capabilityIds: filtered.map((item) => item.id) };
  },
  validateTestFile: async (args) => {
    const { payload } = runValidate(args, {
      rootDir: TEST_WORKFLOWS_ROOT,
      precheck: precheckTestFile,
      strict: args?.strict === true || args?.mode === "gate",
    });
    return payload;
  },
  runHeadless: async (args) => {
    const { payload } = await runHeadlessSession(args, {
      createTestSession,
      store: TEST_SESSION_STORE,
      outputRoot: OUTPUT_ROOT,
      testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
      outputRunsRoot: OUTPUT_RUNS_ROOT,
      browserContext: buildHeadlessBrowserContext(panelPreferences),
      checkpointsRoot: CHECKPOINTS_ROOT,
      launchBrowser: launchSharedBrowser,
    });
    return payload;
  },
  runApp: (args) => runExternalAppRunViaMcp(args),
  getRunSummary: (args) => readRunSummaryViaMcp(args),
  // v1.3 REQ-Z13: same operation as POST /app-runs/{id}/cancel.
  // v1.4 REQ-Z16-2: the same tool now also cancels *headless* sessions — the id
  // decides which channel is addressed, so callers do not need to know which
  // kind of run produced the handle (same polymorphism get_run_summary has).
  cancelRun: async (args) => {
    const runId = typeof args?.runId === "string" ? args.runId.trim() : "";
    if (!runId) {
      return { ok: false, error: { code: "run-id-required", message: "runId is required.", retriable: false } };
    }
    if (!appRunQueue.has(runId) && isSafeSessionId(runId)) {
      const outcome = await cancelTestSession(
        runId,
        { reason: args?.reason || "Cancelled via the MCP cancel_run tool.", graceMs: args?.graceMs },
        { store: TEST_SESSION_STORE, outputRoot: OUTPUT_ROOT },
      );
      return { ...outcome, kind: "headless" };
    }
    const outcome = appRunQueue.cancel(runId, {
      reason: args?.reason || "Cancelled via the MCP cancel_run tool.",
    });
    const queue = appRunQueue.queueSnapshot();
    return outcome.found
      ? {
          ok: true,
          kind: "app-run",
          externalRunId: runId,
          status: outcome.status,
          cancelled: outcome.cancelled,
          reason: outcome.reason || null,
          wasRunning: outcome.wasRunning || false,
          wasQueued: outcome.wasQueued || false,
          activeCount: queue.activeCount,
          queuedCount: queue.queuedCount,
        }
      : {
          ok: false,
          externalRunId: runId,
          status: "not-found",
          error: { code: "not-found", message: `Run "${runId}" was not found.`, retriable: false },
        };
  },
  // v1.3 Z10: same operation as POST /app-runs/batch (parallel visible instances).
  runAppBatch: async (args) => {
    const { payload } = await runHeadlessBatch(args || {}, {
      runBatch: runParallelBatch,
      createTestSession,
      store: TEST_SESSION_STORE,
      outputRoot: OUTPUT_ROOT,
      testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
      outputRunsRoot: OUTPUT_RUNS_ROOT,
      browserContext: buildHeadlessBrowserContext(panelPreferences),
      launchBrowser: launchSharedBrowser,
      defaultConcurrency: APP_RUN_PARALLEL_INSTANCES,
      forceHeaded: true,
    });
    return payload;
  },
  // v1.4 REQ-Z15-5: reverse-lookup session handles by test file. Exists so no
  // caller ever has to guess "the newest session-* directory" again.
  listSessions: async (args) => {
    const { payload } = await listHeadlessSessions(
      {
        testFileId: args?.testFileId || "",
        testFilePath: args?.testFilePath || "",
        status: args?.status || "",
        limit: args?.limit,
      },
      { store: TEST_SESSION_STORE },
    );
    return { ...payload, active: listActiveTestSessions() };
  },
  listTestFiles: () => listTestWorkflowFiles(),
  readTestFile: (args) => readTestWorkflowFile(args?.testFilePath),
  writeTestFile: (args) =>
    args?.mode === "create" ? createTestWorkflowFile(args) : saveTestWorkflowFile(args),
  getAuthStatus: (args) =>
    args?.surface === "panel"
      ? getPanelAuthStatus()
      : getAuthProfileStatus(args?.profile || null, { outputRoot: OUTPUT_ROOT }),
  // --- v1.5 守航支撑 ---------------------------------------------------------
  preflight: async (args) => (await runPreflightRoute(args || {}, buildGuardedRunDeps())).payload,
  getEnvFingerprint: async (args) => (await probeEnvironmentFingerprint(args || {}, buildGuardedRunDeps())).payload,
  verifyEvidence: async (args) => (await verifyEvidenceRoute(args || {}, buildGuardedRunDeps())).payload,
  getReportCard: async (args) => (await buildSessionReportCard(args || {}, buildGuardedRunDeps())).payload,
  // --- v1.6 人工债清零 -------------------------------------------------------
  bootstrapAuthProfile: async (args) => (await bootstrapAuthProfileRoute(args || {}, buildGuardedRunDeps())).payload,
  getUiContract: async (args) => (await getUiContractRoute(args || {}, buildGuardedRunDeps())).payload,
  // v1.5 Z-M: per-tool privilege gate for the write/execute group. The MCP route
  // carries both groups, so the decision has to be made here rather than at the
  // transport (see src/shared/api-guard.js).
  authorizeWrite: async ({ tool }) => {
    const decision = authorizeApiRequest({
      scope: classifyTool(tool),
      headers: requestContext.headers || {},
      remoteAddress: requestContext.remoteAddress || null,
      workspaceRoot: APP_WORKSPACE_ROOT,
    });
    void appendAuditRecord({
      outputRoot: OUTPUT_ROOT,
      record: {
        surface: "mcp",
        tool,
        remoteAddress: requestContext.remoteAddress || null,
        allowed: decision.allowed,
        reason: decision.reason || null,
        tokenPresented: decision.tokenPresented,
        loopback: decision.loopback,
      },
    });
    return decision;
  },
});

// Shared dependency bundle for the v1.5 guarded-run routes. Built per call so it
// always reflects the current panel preferences / queue state.
const buildGuardedRunDeps = () => ({
  store: TEST_SESSION_STORE,
  // v1.6 Z-F: the bootstrap flow drives a real login in its own short-lived
  // headless context, so it needs the runner as well as the launcher.
  runImpl: loadRuntimeRunner(),
  outputRunsRoot: OUTPUT_RUNS_ROOT,
  outputRoot: OUTPUT_ROOT,
  workspaceRoot: APP_WORKSPACE_ROOT,
  testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
  precheck: precheckTestFile,
  launchBrowser: launchSharedBrowser,
  browserContext: buildHeadlessBrowserContext(panelPreferences),
  getAuthStatus: (args) => getAuthProfileStatus(args?.profile || null, { outputRoot: OUTPUT_ROOT }),
  listSessions: async (args) => {
    const { sessions } = await TEST_SESSION_STORE.listSessions({
      status: args?.status || "",
      limit: args?.limit || 20,
    });
    return { sessions };
  },
  appRunStatus: {
    available: Boolean(externalAppRunReady && mainWindow && !mainWindow.isDestroyed()),
    reason:
      externalAppRunReady && mainWindow && !mainWindow.isDestroyed()
        ? null
        : "the desktop panel is not up, so no visible run can be dispatched",
    queue: appRunQueue.queueSnapshot(),
  },
});

// v1.5 Z-M: two privilege groups + an audit trail. Reads stay open by default so
// the lab's existing polling is untouched (facet M-2); writes/executions need a
// bearer token (see `src/shared/api-guard.js` for the exact rule, including why
// loopback is permitted while no token is configured).
const guardExternalRequest = async ({ req, res, url }) => {
  const scope = classifyHttpRequest(req.method, url.pathname);
  if (scope === "mcp") {
    // The transport is neutral; each MCP tool is classified individually inside
    // buildMcpServer via `authorizeWrite`.
    return { allowed: true, scope, deferred: true };
  }
  const decision = authorizeApiRequest({
    scope,
    headers: req.headers || {},
    remoteAddress: req.socket?.remoteAddress || null,
    workspaceRoot: APP_WORKSPACE_ROOT,
  });
  if (scope === "write") {
    // Audited whether or not it was allowed — a refused attempt is exactly the
    // record you want when answering "what happened last night" (facet M-4).
    void appendAuditRecord({
      outputRoot: OUTPUT_ROOT,
      record: {
        surface: "http",
        method: req.method,
        path: url.pathname,
        remoteAddress: req.socket?.remoteAddress || null,
        allowed: decision.allowed,
        reason: decision.reason || null,
        tokenPresented: decision.tokenPresented,
        loopback: decision.loopback,
      },
    });
  }
  if (!decision.allowed) {
    sendJsonResponse(res, 401, {
      ok: false,
      success: false,
      error: {
        code: "unauthorized",
        message: decision.reason,
        retriable: false,
      },
    });
    return { allowed: false, scope };
  }
  return { ...decision, scope };
};

const handleExternalAppRunHttpRequest = async (req, res) => {
  const url = new URL(req.url, `http://${APP_RUN_HOST}`);
  const guard = await guardExternalRequest({ req, res, url });
  if (!guard.allowed) {
    return;
  }
  // Z12: in-process MCP endpoint. Stateless Streamable HTTP; POST carries one
  // JSON-RPC message. Handled first so it never falls through to the 404 guard.
  if (url.pathname === MCP_ROUTE || url.pathname.startsWith(`${MCP_ROUTE}/`)) {
    let body;
    if (req.method === "POST") {
      try {
        body = await readRequestJson(req);
      } catch (error) {
        sendJsonResponse(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: `Parse error: ${error?.message || String(error)}` },
          id: null,
        });
        return;
      }
    }
    await handleMcpHttpRequest({
      req,
      res,
      body,
      deps: buildMcpDeps(getRequestOrigin(req, APP_RUN_PORT), {
        headers: req.headers || {},
        remoteAddress: req.socket?.remoteAddress || null,
      }),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === EXTERNAL_INTEGRATION_DOCUMENTS_PATH) {
    try {
      sendJsonResponse(res, 200, await readExternalIntegrationDocuments(getRequestOrigin(req, APP_RUN_PORT)));
    } catch (error) {
      sendJsonResponse(res, 500, {
        success: false,
        error: error?.message || "integration-documents-unavailable",
      });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/external-activity/events") {
    try {
      const result = publishExternalActivity(await readRequestJson(req));
      sendJsonResponse(res, result.success ? 202 : 400, result);
    } catch (error) {
      sendJsonResponse(res, 400, { success: false, error: error?.message || "invalid-activity-event" });
    }
    return;
  }
  // v1.5 守航支撑路由：/preflight、/env-fingerprint、/evidence/verify、
  // /test-sessions/{id}/report-card。Handled before the older routes so the
  // report-card path is not swallowed by the generic /test-sessions matcher.
  // The path test comes FIRST and the body is read only for these routes:
  // `readRequestJson` consumes the request stream, so reading it speculatively
  // would silently starve every other POST handler below.
  if (
    url.pathname === "/preflight" ||
    url.pathname === "/env-fingerprint" ||
    url.pathname === "/evidence/verify" ||
    url.pathname === "/ui-contract" ||
    /^\/test-sessions\/[^/]+\/report-card$/.test(url.pathname) ||
    /^\/auth-profiles\/[^/]+\/bootstrap$/.test(url.pathname)
  ) {
    let guardedRunBody = null;
    if (req.method === "POST") {
      try {
        guardedRunBody = await readRequestJson(req);
      } catch (_error) {
        guardedRunBody = null;
      }
    }
    const guardedRun = await handleGuardedRunRoute(
      { method: req.method, pathname: url.pathname, query: url.searchParams, body: guardedRunBody },
      buildGuardedRunDeps(),
    );
    if (guardedRun) {
      sendJsonResponse(res, guardedRun.statusCode, guardedRun.payload);
      return;
    }
  }
  // v1.9 REQ-Z25: the machine-verifiable capability catalog, on the desktop
  // surface too. A consumer that reads this never has to guess a path and then
  // infer "未上线" from a 404 — the response states, per capability, whether it
  // is ga/beta/planned and exactly which method+path it lives at.
  // v1.11 REQ-Z33: the run board — every headless / batch / App-run / panel run.
  if (await handleRunBoardRoute(req, res, url, { outputRoot: OUTPUT_ROOT, label: "app" })) {
    return;
  }
  if (req.method === "GET" && url.pathname === "/capabilities") {
    sendJsonResponse(res, 200, { ok: true, data: getCapabilityData() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/test-files") {
    sendJsonResponse(res, 200, await listTestWorkflowFiles());
    return;
  }
  if (req.method === "GET" && url.pathname === "/test-files/read") {
    const result = await readTestWorkflowFile(url.searchParams.get("path"));
    sendJsonResponse(res, result.success ? 200 : result.error === "file-not-found" ? 404 : 400, result);
    return;
  }
  if (req.method === "POST" && (url.pathname === "/test-files/create" || url.pathname === "/test-files/save")) {
    try {
      const payload = await readRequestJson(req);
      const result = url.pathname.endsWith("/create")
        ? await createTestWorkflowFile(payload)
        : await saveTestWorkflowFile(payload);
      sendJsonResponse(res, result.success ? 200 : 400, result);
    } catch (error) {
      sendJsonResponse(res, 400, { success: false, error: error?.message || "invalid-test-file-payload" });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/app-runs/status") {
    const queueSnapshot = appRunQueue.queueSnapshot();
    sendJsonResponse(res, 200, {
      ok: true,
      service: "zhuzhu-app-run",
      ready: Boolean(externalAppRunReady && mainWindow && !mainWindow.isDestroyed()),
      networkAccess: APP_RUN_HOST !== "127.0.0.1" && APP_RUN_HOST !== "::1",
      bindHost: APP_RUN_HOST,
      endpoints: listAppRunNetworkEndpoints({ port: APP_RUN_PORT }),
      workspace: INTEGRATION_WORKSPACE,
      // Backwards-compatible field: first active run, if any.
      activeExternalRunId: queueSnapshot.active[0]?.runId || null,
      queue: queueSnapshot,
      // v1.9: the desktop process's own footprint. An unattended caller polling
      // this endpoint can now see the host approaching a memory cliff *before*
      // its runs start dying of it — which is the signal that was missing when
      // the console-handle leak took the main process to 1.6GB unnoticed.
      memory: getMainProcessMemory(),
      // v1.3: self-describe the freeze protections + the parallel channel so an
      // unattended caller discovers them from the status GET it already polls.
      freezeProtection: {
        cancelEndpoint: "/app-runs/{externalRunId}/cancel",
        deleteEndpoint: "/app-runs/{externalRunId}",
        stallTimeoutMs: APP_RUN_STALL_MS,
        stallSweepIntervalMs: APP_RUN_STALL_SWEEP_MS,
        stepHardTimeout: true,
      },
      parallelChannel: {
        endpoint: "/app-runs/batch",
        defaultConcurrency: APP_RUN_PARALLEL_INSTANCES,
        visible: true,
        note: "Each item runs in its own visible Chromium; overflow waits in the worker pool.",
      },
      // v1.4 REQ-Z15/Z16: the headless channel's submit modes, poll/list/cancel
      // endpoints and its isolation guarantee, discoverable from the same GET.
      headlessChannel: {
        submitEndpoint: "POST /test-sessions",
        asyncParam: "wait:false",
        defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
        timeoutAlwaysReturnsHandle: true,
        pollEndpoint: "GET /test-sessions/{sessionId}",
        listEndpoint: "GET /test-sessions?testFileId=&limit=",
        cancelEndpoint: "POST /test-sessions/{sessionId}/cancel",
        cancelGraceMs: DEFAULT_CANCEL_GRACE_MS,
        browserPerSession: true,
        concurrentSubmitsIsolated: true,
        activeSessions: listActiveTestSessions(),
      },
    });
    return;
  }
  // Z01: queue introspection — what is running / waiting / recently finished.
  if (req.method === "GET" && url.pathname === "/app-runs/queue") {
    sendJsonResponse(res, 200, { ok: true, ...appRunQueue.queueSnapshot() });
    return;
  }
  // REQ-Z13 (需求单v3): force-abort a queued/running App-run and release its
  // slot, so an unattended caller can clear a wedged run itself instead of
  // restarting the whole desktop App (which would drop this HTTP channel and the
  // panel login state). `POST /app-runs/{id}/cancel` and `DELETE /app-runs/{id}`
  // are the same operation; both are idempotent.
  if (
    (req.method === "POST" && /^\/app-runs\/[^/]+\/(cancel|stop|abort)$/.test(url.pathname)) ||
    (req.method === "DELETE" && /^\/app-runs\/[^/]+$/.test(url.pathname))
  ) {
    const runId = decodeURIComponent(url.pathname.split("/")[2]);
    const outcome = appRunQueue.cancel(runId, {
      reason: url.searchParams.get("reason") || "Cancelled via the App-run cancel endpoint.",
    });
    const queue = appRunQueue.queueSnapshot();
    sendJsonResponse(res, outcome.found ? 200 : 404, {
      ok: outcome.ok,
      externalRunId: runId,
      status: outcome.status,
      cancelled: outcome.cancelled,
      // false + reason:"not-running" is the idempotent case (Z13-3).
      reason: outcome.reason || null,
      wasRunning: outcome.wasRunning || false,
      wasQueued: outcome.wasQueued || false,
      activeCount: queue.activeCount,
      queuedCount: queue.queuedCount,
      ...(outcome.found
        ? {}
        : { error: { code: "not-found", message: `Run "${runId}" was not found.` } }),
    });
    return;
  }
  // Z02: SSE progress stream for a run. Supports ?cursor=N (or Last-Event-ID) to
  // backfill after a reconnect. Must be checked before the generic /app-runs/:id
  // status route below.
  if (req.method === "GET" && /^\/app-runs\/[^/]+\/events$/.test(url.pathname)) {
    const runId = decodeURIComponent(url.pathname.split("/")[2]);
    const cursor = Number(url.searchParams.get("cursor") || req.headers["last-event-id"] || 0) || 0;
    streamRunEvents({ queue: appRunQueue, runId, res, cursor, req });
    return;
  }
  // Z02: point-in-time run status + final result.
  if (req.method === "GET" && /^\/app-runs\/[^/]+$/.test(url.pathname) && url.pathname !== "/app-runs/status" && url.pathname !== "/app-runs/queue") {
    const runId = decodeURIComponent(url.pathname.split("/")[2]);
    const run = appRunQueue.getRun(runId);
    sendJsonResponse(res, run ? 200 : 404, run
      ? { ok: true, ...run }
      : { ok: false, status: "not-found", error: { code: "not-found", message: `Run "${runId}" was not found.` } });
    return;
  }
  // Z05: unified auth-state queries. `/auth/status?profile=` reports a stored
  // headless auth profile (same call headless uses); `/auth/panel-status`
  // reports the live visible browser's login state — both via hasAuthEvidence,
  // so App-run and headless share one login-state口径 and cases can conditionalize
  // login steps instead of trial-and-erroring includeRootSteps.
  if (req.method === "GET" && url.pathname === "/auth/status") {
    const profile = url.searchParams.get("profile");
    if (!profile || !String(profile).trim()) {
      // REQ-Z25-3: 404 for a missing required param reads as "no such endpoint",
      // which sent a prober down a two-week wrong conclusion ("未上线"). 400 is
      // the truth: the endpoint exists, the caller forgot `profile`.
      sendJsonResponse(res, 400, {
        ok: false,
        error: {
          code: "auth-missing",
          message: "auth/status requires a `profile` query parameter (a stored headless auth profile name).",
        },
      });
      return;
    }
    const status = await getAuthProfileStatus(profile, { outputRoot: OUTPUT_ROOT });
    sendJsonResponse(res, status.ok ? 200 : 404, status);
    return;
  }
  if (req.method === "GET" && url.pathname === "/auth/panel-status") {
    const status = await getPanelAuthStatus();
    sendJsonResponse(res, status.ok ? 200 : 500, status);
    return;
  }

  // Z03: precheck/validate on the desktop app port itself, so a single-open
  // desktop App gives the same fast validate channel as the standalone bridge.
  // Reuses the exact precheckTestFile the runtime server uses -> identical
  // errors/warnings structure.
  if (req.method === "POST" && url.pathname === "/validate-test-file") {
    try {
      const body = await readRequestJson(req);
      const { statusCode, payload } = runValidate(body, {
        rootDir: TEST_WORKFLOWS_ROOT,
        precheck: precheckTestFile,
        strict: url.searchParams.get("strict") === "1",
      });
      sendJsonResponse(res, statusCode, payload);
    } catch (error) {
      sendJsonResponse(res, 400, {
        ok: false,
        error: { code: "invalid-test-file", message: error?.message || String(error) },
      });
    }
    return;
  }

  // Z03: headless batch execution on the desktop app port. Each session launches
  // its own headless Chromium (runtime `run` with headless:true), fully
  // independent of the visible browser, so it is naturally concurrent and fast.
  if (req.method === "POST" && url.pathname === "/test-sessions") {
    const body = await readRequestJson(req);
    const { statusCode, payload } = await runHeadlessSession(body, {
      createTestSession,
      store: TEST_SESSION_STORE,
      outputRoot: OUTPUT_ROOT,
      testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
      outputRunsRoot: OUTPUT_RUNS_ROOT,
      browserContext: buildHeadlessBrowserContext(panelPreferences),
      checkpointsRoot: CHECKPOINTS_ROOT,
      launchBrowser: launchSharedBrowser,
    });
    sendJsonResponse(res, statusCode, payload);
    return;
  }

  // Z11: checkpoint management — GET /checkpoints (list), DELETE /checkpoints/{id}.
  if ((req.method === "GET" || req.method === "DELETE") && url.pathname.startsWith("/checkpoints")) {
    const checkpointResult = await handleCheckpointRoute(req.method, url.pathname, {
      listCheckpoints,
      clearCheckpoint,
      resolveCheckpointDir,
      checkpointsRoot: CHECKPOINTS_ROOT,
    });
    if (checkpointResult) {
      sendJsonResponse(res, checkpointResult.statusCode, checkpointResult.payload);
      return;
    }
  }

  // Z10 (v1.3): parallel **visible** App-runs — N test files, each in its own
  // independent visible Chromium, concurrency K, overflow queued in the worker
  // pool (nothing dropped). This is the "串行队列 -> 并行多实例" channel: it does
  // not go through the panel's single resident browser, so it is not bound by
  // that surface's serial `maxConcurrent: 1`, and one wedged instance cannot
  // block the others (each has its own browser + its own session deadline).
  if (req.method === "POST" && url.pathname === "/app-runs/batch") {
    const body = await readRequestJson(req);
    const { statusCode, payload } = await runHeadlessBatch(body, {
      runBatch: runParallelBatch,
      createTestSession,
      store: TEST_SESSION_STORE,
      outputRoot: OUTPUT_ROOT,
      testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
      outputRunsRoot: OUTPUT_RUNS_ROOT,
      browserContext: buildHeadlessBrowserContext(panelPreferences),
      launchBrowser: launchSharedBrowser,
      defaultConcurrency: APP_RUN_PARALLEL_INSTANCES,
      forceHeaded: true,
    });
    sendJsonResponse(res, statusCode, payload);
    return;
  }
  // Z10: parallel headless batch — run N sessions at concurrency K, each its own
  // independent Chromium, overflow queued in the worker pool. Wall-clock ~ sum/K.
  if (req.method === "POST" && url.pathname === "/test-sessions/batch") {
    const body = await readRequestJson(req);
    const { statusCode, payload } = await runHeadlessBatch(body, {
      runBatch: runParallelBatch,
      createTestSession,
      store: TEST_SESSION_STORE,
      outputRoot: OUTPUT_ROOT,
      testWorkflowsRoot: TEST_WORKFLOWS_ROOT,
      outputRunsRoot: OUTPUT_RUNS_ROOT,
      browserContext: buildHeadlessBrowserContext(panelPreferences),
      launchBrowser: launchSharedBrowser,
      defaultConcurrency: APP_RUN_MAX_CONCURRENT > 1 ? APP_RUN_MAX_CONCURRENT : 2,
    });
    sendJsonResponse(res, statusCode, payload);
    return;
  }
  // v1.4 REQ-Z16-2: cancel a running headless session (aliases /stop, /abort, and
  // DELETE /test-sessions/{id}). Registered *before* the generic session reader so
  // the cancel verbs are not swallowed by it.
  if ((req.method === "POST" || req.method === "DELETE") && url.pathname.startsWith("/test-sessions/")) {
    const body = req.method === "POST" ? await readRequestJson(req).catch(() => ({})) : {};
    const cancelResult = await cancelHeadlessSession(req.method, url.pathname, body, {
      cancelSession: cancelTestSession,
      store: TEST_SESSION_STORE,
      outputRoot: OUTPUT_ROOT,
    });
    if (cancelResult) {
      sendJsonResponse(res, cancelResult.statusCode, cancelResult.payload);
      return;
    }
  }
  // v1.4 REQ-Z15-5: reverse-lookup recent sessions by test file — the supported
  // way to find a handle again, replacing `ls -1dt session-*` mtime guessing.
  if (req.method === "GET" && url.pathname === "/test-sessions") {
    const listResult = await listHeadlessSessions(url.searchParams, { store: TEST_SESSION_STORE });
    sendJsonResponse(res, listResult.statusCode, listResult.payload);
    return;
  }
  // v1.7 Z-N: step-level progress SSE + budget. Registered BEFORE the generic
  // session reader so `/events` and `/budget` are not swallowed by it.
  if (req.method === "GET" && /^\/test-sessions\/[^/]+\/events$/.test(url.pathname)) {
    const streamed = streamHeadlessSessionEvents(url.pathname, {
      res,
      req,
      cursor: Number(url.searchParams.get("cursor")) || 0,
    });
    if (streamed && streamed.statusCode) {
      sendJsonResponse(res, streamed.statusCode, streamed.payload);
    }
    return;
  }
  if (req.method === "GET" && /^\/test-sessions\/[^/]+\/budget$/.test(url.pathname)) {
    const budget = readHeadlessSessionBudget(url.pathname);
    sendJsonResponse(res, budget.statusCode, budget.payload);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/test-sessions/")) {
    const sessionResult = await readHeadlessSession(url.pathname, { store: TEST_SESSION_STORE });
    if (sessionResult) {
      sendJsonResponse(res, sessionResult.statusCode, sessionResult.payload);
      return;
    }
  }

  if (req.method !== "POST" || url.pathname !== "/app-runs/run-file") {
    // v1.9 REQ-Z25: a guessed-path 404 is indistinguishable from "not built",
    // and that single ambiguity produced the false "Z-D 未上线" TWICE. The first
    // fix only landed on the bridge (loopback-bound); remote consumers reach
    // this server instead, so they kept getting a bare not-found and kept
    // concluding the capability was offline. Same message, both surfaces.
    sendJsonResponse(res, 404, {
      ok: false,
      status: "not-found",
      error: buildNotFoundError(url.pathname),
    });
    return;
  }

  const activityId = `app-run-http-${Date.now()}-${++externalAppRunSeq}`;
  publishExternalActivity({
    id: activityId,
    capability: "appRun.runFile",
    label: "Run file in Zhuzhu",
    source: "App Run API",
    caller: req.socket?.remoteAddress || "local tool",
    method: req.method,
    path: url.pathname,
    phase: "started",
  });
  try {
    const body = await readRequestJson(req);
    publishExternalActivity({ id: activityId, detail: body.testFilePath || "", phase: "started" });
    const validated = await validateExternalAppRunRequest(body);
    if (!validated.ok) {
      sendJsonResponse(res, validated.statusCode, validated.body);
      return;
    }
    // The visible panel must be up to accept a run. Fail fast (503) rather than
    // enqueue work that can never be dispatched.
    if (!mainWindow || mainWindow.isDestroyed() || !externalAppRunReady) {
      sendJsonResponse(res, 503, {
        ok: false,
        status: "app-unavailable",
        externalRunId: validated.request.externalRunId,
        testFilePath: validated.request.testFilePath,
        scope: validated.request.scope,
        caseId: validated.request.caseId,
        summary: null,
        reportPath: null,
        error: { code: "app-not-ready", message: "Zhuzhu panel is not ready to accept external app runs." },
      });
      return;
    }
    // Z01/Z02: enqueue and return immediately. No more 409-busy — a second
    // submission queues behind the first with its own runId. `?wait=1` (or body
    // { wait: true }) opts into the legacy blocking behaviour for callers that
    // still want the final summarized result on the same request.
    const enqueued = appRunQueue.enqueue(validated.request);
    const wantWait = body.wait === true || url.searchParams.get("wait") === "1";
    if (wantWait) {
      const result = await appRunQueue.wait(validated.request.externalRunId);
      sendJsonResponse(res, resolveWaitStatus(result), result);
    } else {
      sendJsonResponse(res, 202, buildEnqueueResponse(enqueued, validated.request));
    }
  } catch (error) {
    const statusCode = error?.code === "ENOENT" ? 404 : 500;
    sendJsonResponse(res, statusCode, {
      ok: false,
      status: statusCode === 404 ? "file-not-found" : "failed",
      error: {
        code: error?.code === "ENOENT" ? "file-not-found" : error?.code || "app-run-request-failed",
        message: error?.message || String(error),
      },
    });
  } finally {
    publishExternalActivity({
      id: activityId,
      phase: "completed",
      status: res.statusCode >= 400 ? "failed" : "completed",
      statusCode: res.statusCode,
      finishedAt: new Date().toISOString(),
    });
  }
};

// REQ-Z12-2: the freeze watchdog. Periodically sweeps dispatched runs that have
// gone silent, force-fails them and releases their slot so `activeCount` returns
// to zero and queued runs can proceed — without any human restarting the App.
const startAppRunStallWatchdog = () => {
  if (appRunStallWatchdog || APP_RUN_STALL_MS <= 0) {
    return;
  }
  appRunStallWatchdog = setInterval(() => {
    try {
      const swept = appRunQueue.sweepStalled({ stallMs: APP_RUN_STALL_MS });
      for (const item of swept) {
        logMainLifecycle("app-run-stall-swept", {
          runId: item.runId,
          idleMs: item.idleMs,
          stallMs: APP_RUN_STALL_MS,
        });
      }
    } catch (error) {
      logMainLifecycle("app-run-stall-sweep-failed", { message: error?.message || String(error) });
    }
  }, APP_RUN_STALL_SWEEP_MS);
  if (typeof appRunStallWatchdog.unref === "function") {
    appRunStallWatchdog.unref();
  }
};

const startExternalAppRunServer = () => {
  if (appRunServer || !Number.isFinite(APP_RUN_PORT) || APP_RUN_PORT <= 0) {
    return;
  }
  startAppRunStallWatchdog();
  appRunServer = http.createServer((req, res) => {
    void handleExternalAppRunHttpRequest(req, res);
  });
  appRunServer.on("error", (error) => {
    logMainLifecycle("external-app-run-server-error", {
      code: error?.code || "unknown",
      message: error?.message || String(error),
      host: APP_RUN_HOST,
      port: APP_RUN_PORT,
    });
  });
  appRunServer.listen(APP_RUN_PORT, APP_RUN_HOST, () => {
    logMainLifecycle("external-app-run-server-listening", {
      host: APP_RUN_HOST,
      port: APP_RUN_PORT,
    });
    // v1.9 REQ-Z26: publish the discovery file the moment the socket is actually
    // listening — not earlier. A record written before `listen` succeeded would
    // advertise a port nothing answers on, which is precisely the silent-wrong
    // state this file exists to abolish. Written with the REAL bound port, so an
    // env override or a port bump propagates to consumers without anyone editing
    // a config (facet Z26-2).
    void writeEndpointFile({
      host: APP_RUN_HOST,
      port: appRunServer.address()?.port || APP_RUN_PORT,
      mcpRoute: MCP_ROUTE,
      docPath: EXTERNAL_INTEGRATION_DOCUMENTS_PATH,
      version: app.getVersion?.() || null,
      workspaceRoot: APP_WORKSPACE_ROOT,
    }).then((result) => {
      logMainLifecycle(
        result.ok ? "endpoint-discovery-file-written" : "endpoint-discovery-file-failed",
        { filePath: result.filePath, ...(result.ok ? {} : { error: result.error }) },
      );
    });
  });
};

const stopExternalAppRunServer = () => {
  if (!appRunServer) {
    return;
  }
  appRunServer.close();
  appRunServer = null;
  // Z26-3: mark the record stale rather than deleting it, so a consumer can tell
  // "not running right now" from "never installed here".
  markEndpointFileStaleSync();
};

const listTestWorkflowFiles = async () => {
  await ensureTestWorkflowsRoot();
  const files = await listJsonFiles(TEST_WORKFLOWS_ROOT);
  const items = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (!raw) {
      continue;
    }
    try {
      const testFile = resolveAndNormalizeTestFile(JSON.parse(raw), {
        rootDir: TEST_WORKFLOWS_ROOT,
        sourcePath: getRelativeTestWorkflowPath(filePath),
      });
      items.push({
        path: getRelativeTestWorkflowPath(filePath),
        id: testFile.id,
        name: testFile.name,
        createdAt: testFile.createdAt,
        updatedAt: testFile.updatedAt,
        group: testFile.group,
        baseUrl: testFile.baseUrl,
        tags: testFile.tags,
        caseCount: testFile.cases.length,
        requirement: testFile.requirement,
      });
    } catch (_error) {
      items.push({
        path: getRelativeTestWorkflowPath(filePath),
        id: path.basename(filePath, ".json"),
        name: path.basename(filePath, ".json"),
        group: "",
        baseUrl: "",
        tags: [],
        caseCount: 0,
        requirement: {},
        invalid: true,
      });
    }
  }
  items.sort(compareTestFileItems);
  return { success: true, files: items };
};

const saveTestWorkflowFile = async ({ path: relativePath, testFile }) => {
  await ensureTestWorkflowsRoot();
  let normalized = normalizeTestFile(testFile);
  const targetPath = resolveTestWorkflowPath(relativePath || buildTestFileName(normalized.name));
  if (!targetPath) {
    return { success: false, error: "invalid-path" };
  }
  const existingRaw = await fs.readFile(targetPath, "utf8").catch(() => null);
  let existing = null;
  if (existingRaw) {
    try {
      existing = normalizeTestFile(JSON.parse(existingRaw));
      normalized = normalizeTestFile({
        ...normalized,
        createdAt: normalized.createdAt || existing.createdAt,
      });
    } catch (_error) {
      // Keep the incoming normalized file if the existing file cannot be parsed.
    }
  }
  const stableWithoutUpdatedAt = (value) => {
    const next = normalizeTestFile(value);
    delete next.updatedAt;
    return JSON.stringify(next);
  };
  const contentChanged = existing
    ? stableWithoutUpdatedAt(existing) !== stableWithoutUpdatedAt(normalized)
    : true;
  normalized = normalizeTestFile({
    ...normalized,
    updatedAt: contentChanged
      ? new Date().toISOString()
      : normalized.updatedAt || existing?.updatedAt || new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  markInternalTestWorkflowWrite(targetPath);
  await fs.writeFile(targetPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  markInternalTestWorkflowWrite(targetPath);
  return {
    success: true,
    path: getRelativeTestWorkflowPath(targetPath),
    testFile: normalized,
  };
};

const getAvailableCopyPath = async (sourcePath) => {
  const ext = path.extname(sourcePath) || ".json";
  const base = sourcePath.slice(0, -ext.length);
  let targetPath = `${base}-copy${ext}`;
  let counter = 2;
  while (true) {
    try {
      await fs.access(targetPath);
      targetPath = `${base}-copy-${counter}${ext}`;
      counter += 1;
    } catch (_error) {
      return targetPath;
    }
  }
};

const copyTestWorkflowFile = async ({ path: relativePath } = {}) => {
  await ensureTestWorkflowsRoot();
  const sourcePath = resolveTestWorkflowPath(relativePath);
  if (!sourcePath) {
    return { success: false, error: "invalid-path" };
  }
  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const sourceFile = normalizeTestFile(JSON.parse(raw));
    const copySuffix = Date.now().toString(36);
    const copiedFile = normalizeTestFile({
      ...sourceFile,
      id: `${sourceFile.id}-copy-${copySuffix}`,
      name: `${sourceFile.name} Copy`,
    });
    const targetPath = await getAvailableCopyPath(sourcePath);
    await fs.writeFile(targetPath, `${JSON.stringify(copiedFile, null, 2)}\n`, "utf8");
    return {
      success: true,
      path: getRelativeTestWorkflowPath(targetPath),
      testFile: copiedFile,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "copy-failed",
      message: error?.message || String(error),
    };
  }
};

const createTestWorkflowFile = async (payload = {}) => {
  const source = payload?.testFile || payload || {};
  const now = new Date().toISOString();
  const testFile = createTestFileDraft({
    ...source,
    createdAt: source.createdAt || now,
    updatedAt: source.updatedAt || now,
  });
  const requestedName = payload?.path || buildTestFileName(testFile.name);
  let targetPath = resolveTestWorkflowPath(requestedName);
  if (!targetPath) {
    return { success: false, error: "invalid-path" };
  }
  let counter = 2;
  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, -ext.length);
  while (true) {
    try {
      await fs.access(targetPath);
      targetPath = `${base}-${counter}${ext}`;
      counter += 1;
    } catch (_error) {
      break;
    }
  }
  return saveTestWorkflowFile({
    path: getRelativeTestWorkflowPath(targetPath),
    testFile,
  });
};

const listRunHistory = async ({
  testFilePath = null,
  limit = 20,
  page = 1,
  pageSize = null,
  status = "",
  query = "",
  dateFrom = null,
  dateTo = null,
  sort = "newest",
  scope = "",
  triggerSurface = "",
  excludeCaseRuns = false,
} = {}) => {
  const response = await listRunArchive(OUTPUT_RUNS_ROOT, {
    testFilePath,
    page,
    pageSize: pageSize || limit,
    status,
    query,
    dateFrom,
    dateTo,
    sort,
    scope,
    triggerSurface,
    excludeCaseRuns,
  });
  return {
    success: true,
    page: response.page,
    pageSize: response.pageSize,
    total: response.total,
    totalPages: response.totalPages,
    stats: response.stats,
    filteredStats: response.filteredStats,
    runs: (response.items || []).map((item) => ({
      reportPath: item.reportPath,
      runDir: item.runDir,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      ok: item.ok,
      mode: item.mode || "",
      telemetry: {
        durationMs: item.durationMs,
        steps: item.steps,
        okCount: item.okCount,
        errorCount: item.errorCount,
        browserUrl: item.browserUrl,
      },
      testContext: {
        testFileId: item.testFileId,
        testFilePath: item.testFilePath,
        testFileName: item.testFileName,
        caseId: item.caseId,
        caseName: item.caseName,
      },
      error: item.firstFailure,
      runContext: item.runContext,
    })),
  };
};

const parseHostname = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return new URL(value).hostname || null;
  } catch (_error) {
    return null;
  }
};

const getBrowserUserAgent = () => {
  const fallback = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  return CUSTOM_BROWSER_USER_AGENT || fallback;
};

const toDisplaySnapshot = (display) => {
  if (!display) {
    return null;
  }
  return {
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
  };
};

const getWorkAreaSize = (display) => {
  const workArea = display?.workArea || display?.bounds || {};
  return (workArea.width || 0) * (workArea.height || 0);
};

const getBrowserWindowPlacement = ({ preferSecondaryDisplay = true, maximizeOnLaunch = true } = {}) => {
  const displays = screen.getAllDisplays();
  if (!displays.length) {
    return null;
  }
  const appDisplay = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const candidates = displays.filter((display) => display.id !== appDisplay?.id);
  const targetPool = preferSecondaryDisplay && candidates.length ? candidates : [appDisplay || screen.getPrimaryDisplay()];
  const targetDisplay = targetPool
    .slice()
    .sort((left, right) => getWorkAreaSize(right) - getWorkAreaSize(left))[0];
  return {
    displayCount: displays.length,
    avoidsAppDisplay: Boolean(preferSecondaryDisplay && candidates.length && targetDisplay?.id !== appDisplay?.id),
    preferSecondaryDisplay,
    maximizeOnLaunch,
    appDisplay: toDisplaySnapshot(appDisplay),
    targetDisplay: toDisplaySnapshot(targetDisplay),
  };
};

// Sending to the panel is best-effort: timers/watchers can fire while the panel
// frame is being torn down (window close, panel reload, Vite HMR full reload).
// isDestroyed() on the window is not enough — the BrowserWindow can still be
// alive while its render frame is already disposed, which makes send() throw
// "Render frame was disposed before WebFrameMain could be accessed".
const emitToPanel = (channel, payload) => {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    return false;
  }
  try {
    contents.send(channel, payload);
    return true;
  } catch (error) {
    logMainError(`failed to emit "${channel}" to panel`, error);
    return false;
  }
};

// v1.8: panel renderer recovery + memory pressure watch.
//
// Reload budget: a renderer that dies once has probably hit a transient memory
// spike and comes back fine; one that dies three times in two minutes is in a
// loop, and reloading again just hides it.
const PANEL_RELOAD_WINDOW_MS = 120_000;
const PANEL_RELOAD_MAX_IN_WINDOW = 3;
// Sampled rather than event-driven because Chromium gives no "heap is getting
// big" signal — by the time it OOMs there is nothing left to report.
const PANEL_MEMORY_SAMPLE_MS = Math.max(
  5_000,
  Number(process.env.ZHUZHU_PANEL_MEMORY_SAMPLE_MS || 30_000),
);
const PANEL_MEMORY_WARN_MB = Math.max(
  128,
  Number(process.env.ZHUZHU_PANEL_MEMORY_WARN_MB || 1200),
);

const panelRecovery = {
  reloads: [],
  unresponsiveSince: null,
  memoryTimer: null,
  lastWarnedMb: 0,
};

const clearPanelMemoryWatch = () => {
  if (panelRecovery.memoryTimer) {
    clearInterval(panelRecovery.memoryTimer);
    panelRecovery.memoryTimer = null;
  }
};

const startPanelMemoryWatch = () => {
  clearPanelMemoryWatch();
  panelRecovery.memoryTimer = setInterval(async () => {
    const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (!contents || contents.isDestroyed() || contents.isCrashed()) {
      return;
    }
    try {
      const info = await contents.getProcessMemoryInfo();
      const residentMb = Math.round((info?.private ?? 0) / 1024);
      if (residentMb < PANEL_MEMORY_WARN_MB) {
        panelRecovery.lastWarnedMb = 0;
        return;
      }
      // Re-warn only on meaningful growth, so a panel parked just over the line
      // does not spam the activity log every sample.
      if (residentMb < panelRecovery.lastWarnedMb + 200) {
        return;
      }
      panelRecovery.lastWarnedMb = residentMb;
      logMainLifecycle("panel-memory-high", { residentMb, thresholdMb: PANEL_MEMORY_WARN_MB });
      emitToPanel("panel-memory-warning", { residentMb, thresholdMb: PANEL_MEMORY_WARN_MB });
    } catch (_error) {
      // Advisory only — a failed sample must never affect the app.
    }
  }, PANEL_MEMORY_SAMPLE_MS);
  if (typeof panelRecovery.memoryTimer.unref === "function") {
    panelRecovery.memoryTimer.unref();
  }
};

// v1.8: run-archive housekeeping. Fire-and-forget on purpose — retention must
// never delay a run's completion or the app's startup, and a failure to prune is
// not a failure of anything the operator asked for. Serialised through a single
// in-flight promise so a burst of finishing runs cannot start several walks of
// the same directory tree at once.
let runRetentionInFlight = null;
const scheduleRunRetention = (label) => {
  if (runRetentionInFlight) {
    return runRetentionInFlight;
  }
  runRetentionInFlight = pruneRunArchive(OUTPUT_RUNS_ROOT)
    .then((outcome) => {
      if (outcome?.deleted || outcome?.protected) {
        logMainLifecycle("run-retention", {
          trigger: label,
          deleted: outcome.deleted,
          freedMb: Math.round((outcome.freedBytes || 0) / 1024 / 1024),
          protectedRuns: outcome.protected,
          kept: outcome.kept,
          policy: outcome.policy,
        });
      }
      return outcome;
    })
    .catch((error) => {
      logMainError("run retention failed", error);
      return null;
    })
    .finally(() => {
      runRetentionInFlight = null;
    });
  return runRetentionInFlight;
};

const isBrowserAdapterReady = () =>
  Boolean(browserAdapter?.isAvailable?.() ?? browserAdapter?.page);

const normalizeUrl = (rawUrl) => {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return null;
  }
  try {
    const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(rawUrl);
    const target = hasProtocol ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    new URL(target);
    return target;
  } catch (_error) {
    return null;
  }
};

const resetNavigationMeta = (requestedUrl = null) => {
  navigationMeta.requestedUrl = requestedUrl;
  navigationMeta.redirectChain = [];
  navigationMeta.lastError = null;
};

const getBrowserState = async () => {
  const url = browserAdapter?.getURL?.() || "";
  const title = browserAdapter ? await browserAdapter.getTitle() : "";
  return {
    title,
    url,
    isWindowFullScreen: mainWindow?.isFullScreen?.() ?? false,
    requestedUrl: navigationMeta.requestedUrl,
    redirectChain: navigationMeta.redirectChain.slice(),
    lastError: navigationMeta.lastError,
    loadProgress,
    loadStatus,
    isLoading: browserAdapter?.isLoading?.() ?? false,
    browserMode: "playwright-visible",
    browserTarget: "Current Playwright window",
    browserDebug: browserAdapter?.getDebugState?.() || null,
    panelPreferences: { ...panelPreferences },
    runtimeEndpoint: "integrated-runtime-v2",
  };
};

// Perf: the visible (qiankun) page fires navigation/title/load-progress events
// continuously even while the operator is idle. Each used to push a fresh
// browser-state object to the renderer, re-rendering the whole App tree with no
// throttle or dedup. We now (a) dedup: skip the push when the serialized payload
// is unchanged, and (b) coalesce bursts via scheduleBrowserState (trailing
// window), so a chatty micro-frontend can't jank the panel on every tick.
let browserStateFlushTimer = null;
let lastBrowserStateSerialized = null;
const BROWSER_STATE_COALESCE_MS = 120;

const sendBrowserState = async ({ force = false } = {}) => {
  if (browserStateFlushTimer) {
    clearTimeout(browserStateFlushTimer);
    browserStateFlushTimer = null;
  }
  const state = await getBrowserState();
  const serialized = JSON.stringify(state);
  if (!force && serialized === lastBrowserStateSerialized) {
    return;
  }
  lastBrowserStateSerialized = serialized;
  emitToPanel("browser-state", state);
};

// Coalesce high-frequency, fire-and-forget browser events into at most one push
// per trailing window (deduped by sendBrowserState). Awaited callers still use
// sendBrowserState() directly for an immediate, in-order push.
const scheduleBrowserState = () => {
  if (browserStateFlushTimer) {
    return;
  }
  browserStateFlushTimer = setTimeout(() => {
    browserStateFlushTimer = null;
    scheduleBrowserState();
  }, BROWSER_STATE_COALESCE_MS);
  if (typeof browserStateFlushTimer.unref === "function") {
    browserStateFlushTimer.unref();
  }
};

// ---------------------------------------------------------------------------
// v1.9: idle crash recovery.
//
// v1.4 taught the platform to notice a renderer OOM (`page.on("crash")` →
// adapter `closed`) and wired recovery into the *run* path: a run that fails
// with `browser-oom` recreates the browser and reruns the case once. What it
// never wired is the other half — a crash while nothing is running. That path
// only ever set three UI variables, so the panel said "Browser closed" and the
// browser stayed dead until a human clicked something. From the 2026-09-08
// report: "开一个浏览器就 out of Memory 而且不会自动恢复".
//
// Recovery is bounded on purpose. A crash is usually a memory cliff, and
// relaunching into a machine that is already out of memory just crashes again;
// an unbounded retry would turn one dead browser into a relaunch loop that
// makes the whole box worse. Two attempts per window, then stop and say so.
// ---------------------------------------------------------------------------
const BROWSER_CRASH_REASONS = new Set(["renderer-crash-oom", "browser-disconnected"]);
const BROWSER_CRASH_RECOVERY_MAX_ATTEMPTS = 2;
const BROWSER_CRASH_RECOVERY_WINDOW_MS = 10 * 60_000;
const BROWSER_CRASH_RECOVERY_DELAY_MS = 2_000;

const browserCrashRecovery = { attempts: 0, windowStartedAt: 0, pending: false };

const maybeRecoverCrashedBrowser = (reason) => {
  if (!BROWSER_CRASH_REASONS.has(String(reason || ""))) {
    // A page the user (or `close()`) closed deliberately must stay closed.
    return;
  }
  if (browserCrashRecovery.pending) {
    return;
  }
  // A crash under a run is the run path's business — it recreates the browser
  // AND reruns the case. Doing it here too would race that teardown.
  if (isAnyRunActive()) {
    return;
  }
  const now = Date.now();
  if (now - browserCrashRecovery.windowStartedAt > BROWSER_CRASH_RECOVERY_WINDOW_MS) {
    browserCrashRecovery.windowStartedAt = now;
    browserCrashRecovery.attempts = 0;
  }
  if (browserCrashRecovery.attempts >= BROWSER_CRASH_RECOVERY_MAX_ATTEMPTS) {
    loadStatus = "Browser crashed repeatedly — not relaunching (likely out of memory)";
    logMainLifecycle("browser-crash-recovery-exhausted", {
      reason,
      attempts: browserCrashRecovery.attempts,
      windowMs: BROWSER_CRASH_RECOVERY_WINDOW_MS,
    });
    scheduleBrowserState();
    return;
  }
  browserCrashRecovery.attempts += 1;
  browserCrashRecovery.pending = true;
  const attempt = browserCrashRecovery.attempts;
  const requestedUrl = navigationMeta.requestedUrl || null;
  loadStatus = `Browser crashed (${reason}) — relaunching (${attempt}/${BROWSER_CRASH_RECOVERY_MAX_ATTEMPTS})`;
  scheduleBrowserState();
  logMainLifecycle("browser-crash-recovery-start", { reason, attempt, requestedUrl });
  // A short delay lets Chromium's own process teardown finish before we ask the
  // OS for a fresh one — relaunching into a half-dead process tree is how a
  // single crash becomes two.
  const timer = setTimeout(() => {
    recreateBrowserAdapter({ requestedUrl })
      .then(() => {
        logMainLifecycle("browser-crash-recovery-done", { reason, attempt });
      })
      .catch((error) => {
        loadStatus = "Browser crashed and could not be relaunched";
        logMainLifecycle("browser-crash-recovery-failed", {
          reason,
          attempt,
          error: error?.message || String(error),
        });
        scheduleBrowserState();
      })
      .finally(() => {
        browserCrashRecovery.pending = false;
      });
  }, BROWSER_CRASH_RECOVERY_DELAY_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
};

// ---------------------------------------------------------------------------
// Idle browser reclaim
//
// The visible Chromium is a long-lived fixture reused across runs (v1.2.1), so a
// heavy SPA stays resident for the whole app lifetime and its memory grows with
// every run/navigation. When nothing has used the browser for the configured
// idle window, release it to reclaim that memory; the next run or navigation
// relaunches it lazily via createBrowserAdapter. Login is the test case's own
// responsibility, so releasing an idle browser never breaks a later run — this
// is the same teardown recreateBrowserAdapter already performs on crash recovery.
// ---------------------------------------------------------------------------
let browserIdleTimer = null;

const getBrowserIdleTimeoutMs = () => {
  const minutes = normalizePanelPreferences(panelPreferences).browserIdleTimeoutMinutes;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
};

const clearBrowserIdleTimer = () => {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
};

const releaseIdleBrowser = async () => {
  if (!isBrowserAdapterReady()) {
    return;
  }
  // A run may have started while the timer was pending — never close under a run.
  if (isAnyRunActive()) {
    armBrowserIdleTimer();
    return;
  }
  logMainLifecycle("browser-idle-release", {
    idleTimeoutMs: getBrowserIdleTimeoutMs(),
  });
  browserAdapter.removeAllListeners();
  await browserAdapter.close?.().catch(() => {});
  browserAdapter = null;
  resetNavigationMeta(WELCOME_PAGE_URL);
  loadProgress = 0;
  loadStatus = "Browser released to save memory (idle)";
  await sendBrowserState().catch(() => {});
};

const armBrowserIdleTimer = () => {
  clearBrowserIdleTimer();
  const timeoutMs = getBrowserIdleTimeoutMs();
  if (timeoutMs <= 0 || !isBrowserAdapterReady()) {
    return;
  }
  browserIdleTimer = setTimeout(() => {
    browserIdleTimer = null;
    void releaseIdleBrowser().catch(() => {});
  }, timeoutMs);
  if (typeof browserIdleTimer.unref === "function") {
    browserIdleTimer.unref();
  }
};

// Push the idle-release deadline out on any browser-touching activity
// (run start/end, manual or run-driven navigation, load events).
const noteBrowserActivity = () => {
  armBrowserIdleTimer();
};

const getRuntimeBridgeState = async ({ includeCapabilities = false } = {}) => {
  return {
    available: true,
    endpoint: "integrated-runtime-v2",
    browserAvailable: isBrowserAdapterReady(),
    autoRecovery: true,
    capabilities: includeCapabilities
      ? [
          "run",
          "browser.openUrl",
          "browser.reload",
          "browser.goBack",
          "browser.goForward",
          "input.click",
          "input.type",
          "vision.inspect",
        ]
      : [],
    error: null,
  };
};

const registerBrowserEvents = () => {
  if (!browserAdapter) {
    return;
  }

  browserAdapter.on("did-start-navigation", ({ url }) => {
    resetNavigationMeta(url || null);
    loadProgress = 5;
    loadStatus = "Starting navigation";
    noteBrowserActivity();
    scheduleBrowserState();
  });

  browserAdapter.on("did-redirect-navigation", ({ url }) => {
    if (typeof url === "string" && url) {
      navigationMeta.redirectChain.push(url);
    }
    loadStatus = "Redirecting";
    scheduleBrowserState();
  });

  browserAdapter.on("did-start-loading", () => {
    loadStatus = "Loading";
    if (loadProgress < 15) {
      loadProgress = 15;
    }
    scheduleBrowserState();
  });

  browserAdapter.on("load-progress", ({ progress }) => {
    if (Number.isFinite(progress)) {
      loadProgress = Math.max(0, Math.min(100, Math.round(progress * 100)));
    }
    loadStatus = "Loading";
    scheduleBrowserState();
  });

  browserAdapter.on("did-stop-loading", () => {
    loadProgress = 100;
    loadStatus = "Idle";
    scheduleBrowserState();
  });

  browserAdapter.on("did-finish-load", () => {
    loadProgress = 100;
    loadStatus = "Loaded";
    navigationMeta.lastError = null;
    scheduleBrowserState();
  });

  browserAdapter.on("did-fail-load", ({ errorDescription, validatedUrl }) => {
    loadStatus = "Load failed";
    navigationMeta.lastError = {
      description: errorDescription || "navigation-failed",
      url: validatedUrl || null,
    };
    scheduleBrowserState();
  });

  browserAdapter.on("did-navigate", ({ url }) => {
    if (url && !navigationMeta.requestedUrl) {
      navigationMeta.requestedUrl = url;
    }
    noteBrowserActivity();
    scheduleBrowserState();
  });

  browserAdapter.on("page-title-updated", () => {
    scheduleBrowserState();
  });

  browserAdapter.on("closed", ({ reason } = {}) => {
    loadProgress = 0;
    loadStatus = "Browser closed";
    navigationMeta.lastError = {
      description: reason || "browser-closed",
      url: navigationMeta.requestedUrl,
    };
    scheduleBrowserState();
    maybeRecoverCrashedBrowser(reason);
  });
};

const createBrowserAdapter = async () => {
  if (isBrowserAdapterReady()) {
    return { adapter: browserAdapter, created: false };
  }

  reportHostMemoryPressure("browser-launch");

  if (browserAdapter) {
    browserAdapter.removeAllListeners();
    await browserAdapter.close?.().catch(() => {});
    browserAdapter = null;
  }

  const preferences = normalizePanelPreferences(panelPreferences);
  const windowPlacement = preferences.openChromeOnSecondaryDisplay
    ? getBrowserWindowPlacement({
        preferSecondaryDisplay: true,
        maximizeOnLaunch: preferences.maximizeChromeOnLaunch,
      })
    : null;
  logMainLifecycle("browser-window-placement", {
    displayCount: windowPlacement?.displayCount ?? 0,
    appDisplayId: windowPlacement?.appDisplay?.id ?? null,
    targetDisplayId: windowPlacement?.targetDisplay?.id ?? null,
    avoidsAppDisplay: windowPlacement?.avoidsAppDisplay ?? false,
    maximizeOnLaunch: preferences.maximizeChromeOnLaunch,
  });

  const proxyLaunchOptions = buildBrowserProxyLaunchOptions(preferences);
  logMainLifecycle("browser-proxy-mode", {
    mode: preferences.browserProxyMode,
    hasProxy: Boolean(proxyLaunchOptions.proxy),
    direct: Array.isArray(proxyLaunchOptions.args) && proxyLaunchOptions.args.includes("--no-proxy-server"),
  });
  browserAdapter = new PlaywrightVisibleBrowserAdapter({
    viewport: null,
    ignoreHTTPSErrors: false,
    userAgent: getBrowserUserAgent(),
    locale: CUSTOM_ACCEPT_LANGUAGES.split(",")[0]?.trim() || null,
    windowPlacement,
    maximizeOnLaunch: preferences.maximizeChromeOnLaunch,
    // v1.4: the resident visible Chrome gets the same memory-safety args every
    // headless session gets, so the two channels cannot drift on OOM behavior.
    launchOptions: {
      ...proxyLaunchOptions,
      args: [...(Array.isArray(proxyLaunchOptions.args) ? proxyLaunchOptions.args : []), ...buildMemoryLaunchArgs()],
    },
  });

  registerBrowserEvents();
  await browserAdapter.init();
  loadProgress = 0;
  loadStatus = "Booting";
  noteBrowserActivity();
  await sendBrowserState();
  return { adapter: browserAdapter, created: true };
};

const recreateBrowserAdapter = async ({ requestedUrl = null } = {}) => {
  if (browserAdapter) {
    browserAdapter.removeAllListeners();
    await browserAdapter.close?.().catch(() => {});
    browserAdapter = null;
  }
  resetNavigationMeta(requestedUrl);
  loadProgress = 0;
  loadStatus = "Restarting browser";
  await sendBrowserState();
  return createBrowserAdapter();
};

// v1.4: `browser-oom` joins this predicate, which is what makes the *existing*
// "recreate the browser and rerun once" path below fire on an OOM crash. Before,
// a renderer OOM surfaced as `step-hard-timeout` (and `batch-partial-failure` at
// the run level), so this recovery never triggered and the run just wedged.
// The retry is a single `if`, not a loop, so a case that crashes twice in a row
// is reported as failed instead of looping.
const isBrowserUnavailableRuntimeResult = (result) =>
  Boolean(
    result &&
      result.ok === false &&
      (result.error?.code === "browser-unavailable" ||
        result.error?.code === "browser-oom" ||
        result.error?.message === "browser-unavailable"),
  );

const buildRuntimeOptions = ({ options, runId, controller, forceUrl = null }) => {
  // Z11: resolve checkpoint/resume ids to on-disk directories for the visible
  // App-run path (callers pass `{ id, atStepId }` / `{ id }`; run() wants dirs).
  // v1.5: the panel forwards the file's raw `settings` as `testFileSettings` and
  // the expansion into gate options happens HERE rather than in the renderer, so
  // there is exactly one implementation of that mapping (the panel bundle cannot
  // require the CommonJS shared module, and a hand-kept `.mjs` mirror of a
  // security-relevant default is precisely the kind of drift that produces a
  // channel silently running without a gate).
  const { checkpoint, resume, testFileSettings, caseViewport, ...rest } = options || {};
  const checkpointDir =
    checkpoint && checkpoint.id && checkpoint.atStepId
      ? resolveCheckpointDir(CHECKPOINTS_ROOT, checkpoint.id)
      : null;
  const resumeDir = resume && resume.id ? resolveCheckpointDir(CHECKPOINTS_ROOT, resume.id) : null;
  // v1.10 Z27: the credential of the (single) active external App-run.
  const appRunTarget = getActiveAppRunTarget();
  return {
    ...rest,
    ...(appRunTarget
      ? {
          runtimeVariables: { ...(rest.runtimeVariables || {}), ...appRunTarget.credentialVariables },
          runtimeVariableSources: {
            ...(rest.runtimeVariableSources || {}),
            ...Object.fromEntries(Object.keys(appRunTarget.credentialVariables).map((key) => [key, "target"])),
          },
          secretValues: appRunTarget.secretValues,
          runContext: { ...(rest.runContext || {}), target: appRunTarget.description },
        }
      : {}),
    ...buildGateRunOptions(testFileSettings ? { settings: testFileSettings } : {}),
    // v1.11 REQ-Z30: same case > file resolution the headless channel uses; the
    // runtime emulates it on the resident page and restores the window size after.
    ...buildViewportRunOptions(testFileSettings ? { settings: testFileSettings } : {}, caseViewport ? { viewport: caseViewport } : null),
    ...(forceUrl ? { url: forceUrl } : {}),
    ...(checkpointDir ? { checkpoint: { dir: checkpointDir, atStepId: checkpoint.atStepId } } : {}),
    ...(resumeDir ? { resume: { dir: resumeDir } } : {}),
    runId,
    signal: controller.signal,
    page: isBrowserAdapterReady() ? browserAdapter.page : null,
    context: isBrowserAdapterReady() ? browserAdapter.context : null,
    browser: isBrowserAdapterReady() ? browserAdapter.browser : null,
    onEvent: (event) => {
      emitToPanel("runtime-run-event", event);
      noteActiveAppRunActivity(event);
      recordRuntimeEventOnBoard(runId, event, rest.testContext || null);
    },
  };
};

const executeSessionCommand = async (command) => {
  try {
    const { created } = await createBrowserAdapter();
    if (created) {
      resetNavigationMeta(WELCOME_PAGE_URL);
      await browserAdapter.loadURL(WELCOME_PAGE_URL);
    }
    switch (command) {
      case "back":
        if (!(await browserAdapter.canGoBack())) {
          return { success: false, reason: "no-history" };
        }
        await browserAdapter.goBack();
        break;
      case "forward":
        if (!(await browserAdapter.canGoForward())) {
          return { success: false, reason: "no-history" };
        }
        await browserAdapter.goForward();
        break;
      case "reload":
        await browserAdapter.reload();
        break;
      case "stop":
        if (!browserAdapter.isLoading()) {
          return { success: false, reason: "not-loading" };
        }
        await browserAdapter.stop();
        break;
      default:
        return { success: false, error: "invalid-command" };
    }
    scheduleBrowserState();
    return { success: true, url: browserAdapter.getURL() };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
};

const createApplicationMenu = () => {
  const isMac = process.platform === "darwin";
  const runBrowserCommand = (command) => {
    void executeSessionCommand(command).catch(() => {});
  };
  const stopActiveRun = () => {
    for (const target of activeRuntimeRuns.values()) {
      target.controller.abort();
    }
    void executeSessionCommand("stop").catch(() => {});
  };

  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about", label: `About ${APP_NAME}` },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide", label: `Hide ${APP_NAME}` },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit", label: `Quit ${APP_NAME}` },
            ],
          },
        ]
      : [
          {
            label: "File",
            submenu: [
              { role: "quit", label: `Quit ${APP_NAME}` },
            ],
          },
        ]),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggledevtools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Browser",
      submenu: [
        {
          label: "Back",
          accelerator: isMac ? "Cmd+[" : "Alt+Left",
          click: () => runBrowserCommand("back"),
        },
        {
          label: "Forward",
          accelerator: isMac ? "Cmd+]" : "Alt+Right",
          click: () => runBrowserCommand("forward"),
        },
        {
          label: "Reload Browser",
          accelerator: isMac ? "Cmd+Shift+R" : "Ctrl+Shift+R",
          click: () => runBrowserCommand("reload"),
        },
        {
          label: "Stop Loading",
          accelerator: "Esc",
          click: () => runBrowserCommand("stop"),
        },
      ],
    },
    {
      label: "Run",
      submenu: [
        {
          label: "Stop Active Run",
          accelerator: isMac ? "Cmd+." : "Ctrl+.",
          click: stopActiveRun,
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front" },
            ]
          : [
              { role: "close" },
            ]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Open README",
          click: () => {
            void shell.openPath(path.join(RELEASE_RESOURCE_ROOT, "README.md"));
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createMainWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 920,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    backgroundColor: "#0b1220",
    title: APP_NAME,
    icon: APP_ICON_PATH,
    show: false,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "panel.js"),
      additionalArguments: [`--zhuzhu-app-mode=${APP_MODE}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("closed", () => {
    logMainLifecycle("main-window-closed");
    externalAppRunReady = false;
    clearPanelMemoryWatch();
    clearBrowserIdleTimer();
    if (browserAdapter?.close) {
      void browserAdapter.close().catch(() => {});
    }
    browserAdapter = null;
    mainWindow = null;
  });

  mainWindow.webContents.on("did-finish-load", () => {
    externalAppRunReady = false;
    scheduleBrowserState();
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    logMainLifecycle("panel-load-failed", {
      errorCode,
      errorDescription,
      validatedUrl,
    });
  });

  // v1.8: the panel's renderer can die — most often by running out of memory
  // while holding run results and evidence screenshots. Until now the only
  // reaction was an app-level log line, so the window simply stayed on its last
  // frame or on the dark `backgroundColor`. That is what "the panel went black"
  // has been: not a paint bug, a dead renderer nobody revived.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const reason = details?.reason || "unknown";
    logMainLifecycle("panel-render-process-gone", {
      reason,
      exitCode: details?.exitCode ?? null,
      reloadsInWindow: panelRecovery.reloads.length,
    });
    // A clean exit (`clean-exit`) happens on ordinary teardown; reviving that
    // would fight the shutdown.
    if (reason === "clean-exit" || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const now = Date.now();
    panelRecovery.reloads = panelRecovery.reloads.filter(
      (at) => now - at < PANEL_RELOAD_WINDOW_MS,
    );
    if (panelRecovery.reloads.length >= PANEL_RELOAD_MAX_IN_WINDOW) {
      // Reloading into an immediate re-crash is a loop, not a recovery. Stop and
      // say so, rather than burning CPU pretending to heal.
      logMainLifecycle("panel-reload-giving-up", {
        reason,
        reloads: panelRecovery.reloads.length,
        windowMs: PANEL_RELOAD_WINDOW_MS,
      });
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        title: APP_NAME,
        message: "面板反复崩溃，已停止自动恢复。",
        detail: `最近 ${Math.round(PANEL_RELOAD_WINDOW_MS / 1000)} 秒内崩溃 ${panelRecovery.reloads.length + 1} 次（原因：${reason}）。请重启应用；运行产物与报告都已落盘，不会丢失。`,
      }).catch(() => {});
      return;
    }
    panelRecovery.reloads.push(now);
    mainWindow.webContents.reload();
  });

  // Deliberately advisory. A long synchronous render is not a crash, and killing
  // it would throw away work; the operator just needs to know the window is
  // wedged rather than idle.
  mainWindow.on("unresponsive", () => {
    logMainLifecycle("panel-unresponsive", { url: mainWindow?.webContents?.getURL?.() || "" });
    panelRecovery.unresponsiveSince = Date.now();
  });
  mainWindow.on("responsive", () => {
    logMainLifecycle("panel-responsive", {
      wedgedMs: panelRecovery.unresponsiveSince ? Date.now() - panelRecovery.unresponsiveSince : null,
    });
    panelRecovery.unresponsiveSince = null;
  });

  startPanelMemoryWatch();

  mainWindow.on("enter-full-screen", () => {
    scheduleBrowserState();
  });

  mainWindow.on("leave-full-screen", () => {
    scheduleBrowserState();
  });

  await mainWindow.loadURL(PANEL_DEV_SERVER_URL || getAssetUrl("dist", "panel", "index.html"));
  showMainWindowForLaunch();

  if (SKIP_INITIAL_BROWSER_LOAD) {
    resetNavigationMeta(WELCOME_PAGE_URL);
    loadProgress = 0;
    loadStatus = "Idle";
    await sendBrowserState();
    return;
  }

  await createBrowserAdapter();
  resetNavigationMeta(WELCOME_PAGE_URL);
  await browserAdapter.loadURL(WELCOME_PAGE_URL);
  await sendBrowserState();
};

const registerIpcHandlers = () => {
  ipcMain.handle("panel:navigate", async (_event, rawUrl) => {
    const targetUrl = normalizeUrl(rawUrl);
    if (!targetUrl) {
      return { success: false, error: "invalid-url" };
    }

    try {
      await createBrowserAdapter();
      noteBrowserActivity();
      resetNavigationMeta(targetUrl);
      loadProgress = 5;
      loadStatus = "Navigating";
      scheduleBrowserState();
      await browserAdapter.loadURL(targetUrl);
      return { success: true, url: targetUrl };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        url: browserAdapter.getURL(),
      };
    }
  });

  ipcMain.handle("panel:back", () => executeSessionCommand("back"));
  ipcMain.handle("panel:forward", () => executeSessionCommand("forward"));
  ipcMain.handle("panel:reload", () => executeSessionCommand("reload"));
  ipcMain.handle("panel:stop", () => executeSessionCommand("stop"));

  ipcMain.handle("panel:runtime-state", async () =>
    getRuntimeBridgeState({ includeCapabilities: true }),
  );
  ipcMain.handle("panel:workspace-settings", () => getWorkspaceSettings());
  ipcMain.handle("panel:choose-workspace", () => chooseWorkspaceRoot());
  ipcMain.handle("panel:reset-workspace", () => resetWorkspaceRoot());
  ipcMain.handle("panel:open-workspace", async (_event, workspaceRoot) => {
    const targetRoot = normalizeWorkspaceRoot(workspaceRoot) || APP_WORKSPACE_ROOT;
    const error = await shell.openPath(targetRoot);
    return error ? { success: false, error } : { success: true, path: targetRoot };
  });
  ipcMain.handle("panel:restart-app", () => {
    if (!IS_PACKAGED_APP) {
      return { success: false, error: "restart-dev-manually" };
    }
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
    return { success: true };
  });
  ipcMain.handle("panel:external-integration-documents", () => readExternalIntegrationDocuments());
  ipcMain.handle("panel:external-activity-snapshot", () => getExternalActivitySnapshot());
  // The main panel embeds this read-only page; resolving it never opens a window.
  ipcMain.handle("panel:run-board-url", async () => {
    if (!appRunServer?.listening) {
      return { success: false, error: "app-run-server-not-listening" };
    }
    const url = `http://127.0.0.1:${appRunServer.address()?.port || APP_RUN_PORT}/run-board`;
    return { success: true, url };
  });
  ipcMain.handle("panel:external-app-run-ready", () => {
    externalAppRunReady = true;
    return { success: true };
  });
  ipcMain.handle("panel:complete-external-app-run", (_event, payload = {}) =>
    completeExternalAppRun(payload),
  );
  ipcMain.handle("panel:external-app-run-progress", (_event, payload = {}) =>
    recordExternalAppRunProgress(payload),
  );

  ipcMain.handle("panel:get-preferences", async () => ({
    success: true,
    preferences: { ...panelPreferences },
  }));

  ipcMain.handle("panel:update-preferences", async (_event, payload = {}) => {
    const previous = { ...panelPreferences };
    const preferences = await writePanelPreferences(payload?.preferences || payload);
    // Proxy is a launch-time option, so a change only takes effect on a browser
    // relaunch. Compare the *computed* launch options (switching to Manual with
    // an empty server yields the same options as System, so it should not force
    // a relaunch). The relaunch runs detached — never awaited here — so saving a
    // preference always returns immediately and the UI control never stays
    // stuck/disabled waiting on a slow browser navigation.
    const proxyEffectivelyChanged =
      JSON.stringify(buildBrowserProxyLaunchOptions(previous)) !==
      JSON.stringify(buildBrowserProxyLaunchOptions(preferences));
    let browserRelaunching = false;
    if (proxyEffectivelyChanged && isBrowserAdapterReady()) {
      browserRelaunching = true;
      const currentUrl = browserAdapter?.getURL?.() || navigationMeta.requestedUrl || null;
      void (async () => {
        try {
          await recreateBrowserAdapter({ requestedUrl: currentUrl });
          if (currentUrl) {
            await browserAdapter.loadURL(currentUrl).catch(() => {});
          }
        } catch (error) {
          logMainLifecycle("browser-proxy-relaunch-failed", { message: error?.message || String(error) });
        }
      })();
    }
    // Apply a changed idle-timeout window immediately (re-arms with the new value,
    // or cancels the timer if the operator set it to "never").
    armBrowserIdleTimer();
    await sendBrowserState();
    return {
      success: true,
      preferences,
      browserRelaunching,
    };
  });

  ipcMain.handle("panel:notify-run-file-complete", async (_event, payload = {}) =>
    showRunFileCompleteNotification(payload),
  );

  ipcMain.handle("panel:capture-page-structure", async (_event, payload = {}) =>
    capturePageStructure(browserAdapter, payload),
  );

  ipcMain.handle("panel:capture-auth-profile", async (_event, payload = {}) => {
    const profile = payload?.profile || payload?.authProfile;
    if (!isBrowserAdapterReady()) {
      return {
        success: false,
        ok: false,
        error: {
          code: "browser-unavailable",
          message: "Open and log in with the controlled browser before capturing auth profile.",
        },
      };
    }
    const result = await captureAuthProfile(profile, {
      outputRoot: OUTPUT_ROOT,
      context: browserAdapter.context,
    });
    return {
      success: Boolean(result.ok),
      ...result,
    };
  });

  // Auth auto-renewal panel channels. get-auth-status is a cheap local read
  // (freshness + schedule) called on Settings/panel mount; renew-auth-profile
  // triggers an immediate headless re-login; get/set-auth-renewal-config manage
  // the enable toggle / interval / target profile / login workflow.
  ipcMain.handle("panel:get-auth-status", async (_event, payload = {}) => {
    const profile = payload && typeof payload === "object" ? payload.profile : null;
    return getAuthStatusSnapshot(profile || undefined);
  });

  ipcMain.handle("panel:get-auth-renewal-config", async () => ({
    ok: true,
    config: { ...authRenewalConfig },
  }));

  ipcMain.handle("panel:set-auth-renewal-config", async (_event, patch = {}) => {
    const previousEnabled = authRenewalConfig.enabled;
    const previousInterval = authRenewalConfig.intervalMinutes;
    await persistAuthRenewalConfig(patch && typeof patch === "object" ? patch : {});
    // Re-arm the heartbeat if the schedule-affecting fields changed.
    if (authRenewalConfig.enabled !== previousEnabled || authRenewalConfig.intervalMinutes !== previousInterval) {
      restartAuthRenewalHeartbeat();
    }
    return { ok: true, config: { ...authRenewalConfig }, snapshot: await getAuthStatusSnapshot() };
  });

  ipcMain.handle("panel:renew-auth-profile", async (_event, payload = {}) => {
    const force = Boolean(payload && typeof payload === "object" && payload.force);
    const result = await renewAuthProfile({ reason: "manual", force });
    return {
      ok: Boolean(result.ok),
      skipped: result.skipped || null,
      error: result.error || null,
      snapshot: result.snapshot || (await getAuthStatusSnapshot()),
    };
  });

  ipcMain.handle("panel:runtime-stop", async (_event, payload = {}) => {
    const runId = payload && typeof payload === "object" ? payload.runId : null;
    const targets = runId ? [activeRuntimeRuns.get(runId)].filter(Boolean) : Array.from(activeRuntimeRuns.values());
    for (const target of targets) {
      target.controller.abort();
    }
    try {
      await executeSessionCommand("stop");
    } catch (_error) {
      // Runtime cancellation should still proceed even if the browser stop command fails.
    }
    return { success: true, stopped: targets.length };
  });

  ipcMain.handle("panel:runtime-run", async (_event, payload) => {
    const body =
      payload && typeof payload === "object" ? payload : { payload };
    const options =
      body?.options && typeof body.options === "object" ? { ...body.options } : {};

    const controller = new AbortController();
    const runId = options.runId ?? `runtime-${Date.now()}`;
    activeRuntimeRuns.set(runId, { controller, startedAt: Date.now() });
    // v1.11 REQ-Z33: a run started from the panel by hand (no external App-run
    // active) is its own board entry; one inside an App-run reports under it.
    let boardPanelEntry = false;
    try {
      const board = getRunBoard({ outputRoot: OUTPUT_ROOT });
      if (board && !(appRunQueue.queueSnapshot().active || []).length) {
        const testContext = options.testContext || {};
        board.register({
          id: runId,
          kind: "panel-run",
          title: [testContext.testFileName, testContext.caseName].filter(Boolean).join(" · ") || runId,
          testFileName: testContext.testFileName || null,
          testFilePath: testContext.testFilePath || null,
          trigger: "panel",
          headed: true,
          caseTotal: 1,
        });
        boardPanelEntry = true;
      }
    } catch (_error) {
      boardPanelEntry = false;
    }
    let boardOutcome = null;
    // Hold the browser open for the whole run; re-arm the idle timer when it ends.
    clearBrowserIdleTimer();

    try {
      const fallbackUrl =
        typeof options.fallbackUrl === "string" && options.fallbackUrl.trim()
          ? options.fallbackUrl.trim()
          : null;
      const runPayloadValue = body?.payload ?? body;
      // Resident single-instance model: the visible Chrome is a long-lived
      // fixture launched at startup and REUSED for every run — a run never
      // closes/relaunches the browser. Browser lifecycle is fully decoupled from
      // running cases, and login/session is the test case's own responsibility
      // (Zhuzhu no longer isolates per run, strips "login" steps by text guess,
      // or drives recovery-login; a file may still declare its own recovery
      // handlers, which the runtime honors independently of browser lifecycle).
      // createBrowserAdapter reuses the live instance and only launches one when
      // it's missing (first run, or after a crash cleaned it up).
      const { created } = await createBrowserAdapter();
      const initialRunUrl = options.url || (created ? fallbackUrl : null);
      if (created && !initialRunUrl) {
        resetNavigationMeta(WELCOME_PAGE_URL);
        await browserAdapter.loadURL(WELCOME_PAGE_URL);
      } else if (created && initialRunUrl) {
        resetNavigationMeta(initialRunUrl);
      }
      const runRuntime = loadRuntimeRunner();
      let result = await runRuntime(
        runPayloadValue,
        buildRuntimeOptions({
          options,
          runId,
          controller,
          forceUrl: initialRunUrl,
        }),
      );
      if (
        isBrowserUnavailableRuntimeResult(result) &&
        !controller.signal.aborted
      ) {
        emitToPanel("runtime-run-event", {
          type: "browser-recovering",
          runId,
          status: "running",
          // v1.4: report *which* death triggered the rebuild — an OOM crash and
          // a browser that never launched need different follow-up from the
          // person reading the Activity log.
          reason: result?.error?.code || "browser-unavailable",
          detail: result?.error?.message || null,
          fallbackUrl,
          startedAt: Date.now(),
        });
        await recreateBrowserAdapter({
          requestedUrl: fallbackUrl || WELCOME_PAGE_URL,
        });
        result = await runRuntime(
          body?.payload ?? body,
          buildRuntimeOptions({
            options,
            runId,
            controller,
            forceUrl: options.url || fallbackUrl || null,
          }),
        );
      }
      const reportPaths = collectReportPathsFromResult(result);
      if (reportPaths.length) {
        await updateRunArchiveIndex(OUTPUT_RUNS_ROOT, reportPaths);
        void scheduleRunRetention("run-complete");
      }
      boardOutcome = {
        status: result?.ok ? "passed" : "failed",
        ok: Boolean(result?.ok),
        firstFailure: result?.error ? { code: result.error.code, message: result.error.message } : null,
        reportPath: result?.evidence?.reportPath || null,
      };
      return result;
    } catch (error) {
      const stopped = error?.name === "AbortError" || error?.code === "runtime-aborted" || controller.signal.aborted;
      const failedResult = {
        ok: false,
        type: stopped ? "run-stopped" : "run-failed",
        error: {
          code: stopped ? "run-stopped" : "runtime-request-failed",
          message: stopped ? "Run stopped by user." : error?.message || "runtime-request-failed",
          retryable: !stopped,
          details: error?.details || null,
        },
      };
      emitToPanel("runtime-run-event", {
        type: "run-complete",
        runId,
        status: stopped ? "stopped" : "failed",
        finishedAt: Date.now(),
        result: failedResult,
        error: failedResult.error,
      });
      return failedResult;
    } finally {
      activeRuntimeRuns.delete(runId);
      if (boardPanelEntry) {
        const stopped = controller.signal.aborted;
        getRunBoard({ outputRoot: OUTPUT_ROOT })?.finish(runId, boardOutcome || { status: stopped ? "stopped" : "error", ok: false });
      }
      // Run finished: start counting toward idle release again.
      noteBrowserActivity();
    }
  });

  ipcMain.handle("panel:read-evidence-image", async (_event, rawPath) =>
    readEvidenceImage(rawPath),
  );
  // v1.8: the preferred path — the renderer gets a URL and lets Chromium do the
  // loading, decoding and eviction. Kept as an IPC call (rather than computing
  // the URL in the renderer) so path validation stays in one place, in the main
  // process, exactly as it was for the base64 reader.
  ipcMain.handle("panel:get-evidence-image-url", async (_event, rawPath) => {
    const url = buildEvidenceImageUrl(rawPath);
    return url ? { success: true, url } : { success: false, error: "path-not-allowed" };
  });
  ipcMain.handle("panel:read-evidence-json", async (_event, rawPath) =>
    readEvidenceJson(rawPath),
  );

  ipcMain.handle("panel:list-test-files", () => listTestWorkflowFiles());
  ipcMain.handle("panel:read-test-file", (_event, relativePath) =>
    readTestWorkflowFile(relativePath),
  );
  ipcMain.handle("panel:save-test-file", (_event, payload) =>
    saveTestWorkflowFile(payload),
  );
  ipcMain.handle("panel:create-test-file", (_event, payload) =>
    createTestWorkflowFile(payload),
  );
  ipcMain.handle("panel:copy-test-file", (_event, payload) =>
    copyTestWorkflowFile(payload),
  );
  ipcMain.handle("panel:list-run-history", (_event, payload) =>
    listRunHistory(payload),
  );
  ipcMain.handle("panel:list-run-archive", (_event, payload) =>
    listRunArchive(OUTPUT_RUNS_ROOT, payload),
  );
  ipcMain.handle("panel:read-run-report", (_event, payload) =>
    readRunReport(OUTPUT_RUNS_ROOT, payload?.reportPath || payload?.path || payload),
  );
  ipcMain.handle("panel:evaluate-test-file", (_event, payload) =>
    evaluateTestWorkflowFile(payload),
  );
  ipcMain.handle("panel:run-test-session", (_event, payload) =>
    runPanelTestSession(payload),
  );
  ipcMain.handle("panel:run-test-batch", (_event, payload) =>
    runPanelTestBatch(payload),
  );
  // Z11: checkpoint management for the panel human UI.
  ipcMain.handle("panel:list-checkpoints", async () => {
    try {
      return { success: true, checkpoints: await listCheckpoints(CHECKPOINTS_ROOT) };
    } catch (error) {
      return { success: false, error: error?.code || "list-checkpoints-failed", message: error?.message || String(error) };
    }
  });
  ipcMain.handle("panel:clear-checkpoint", async (_event, payload = {}) => {
    const dir = resolveCheckpointDir(CHECKPOINTS_ROOT, payload?.id);
    if (!dir) {
      return { success: false, error: "invalid-checkpoint-id" };
    }
    try {
      await clearCheckpoint(dir);
      return { success: true, id: payload.id };
    } catch (error) {
      return { success: false, error: error?.code || "clear-checkpoint-failed", message: error?.message || String(error) };
    }
  });
  ipcMain.handle("panel:read-test-session-repair-context", (_event, payload) =>
    readPanelRepairContext(payload),
  );
  ipcMain.handle("panel:export-pdf", exportPanelPdf);
  ipcMain.handle("panel:rebuild-run-archive", () =>
    rebuildRunArchive(OUTPUT_RUNS_ROOT).then((index) => ({
      success: true,
      schemaVersion: index.schemaVersion,
      generatedAt: index.generatedAt,
      total: index.items?.length || 0,
    })),
  );
  ipcMain.handle("panel:append-debug-log", async (_event, payload = {}) => {
    try {
      return await appendDebugLog(payload);
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
      };
    }
  });

  ipcMain.on("panel:request-state", () => {
    // Renderer explicitly asked (mount/reload): force past the dedup guard.
    void sendBrowserState({ force: true });
  });
};

app.whenReady().then(async () => {
  await prepareWorkspaceRoot(APP_WORKSPACE_ROOT);
  process.chdir(APP_WORKSPACE_ROOT);
  readPanelPreferences();
  logMainLifecycle("app-ready", {
    name: app.getName(),
    version: app.getVersion(),
    packaged: IS_PACKAGED_APP,
    workspaceRoot: APP_WORKSPACE_ROOT,
    panelPreferences,
  });
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: APP_ICON_PATH,
  });
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(APP_ICON_PATH);
  }
  createApplicationMenu();
  registerEvidenceProtocol();
  registerIpcHandlers();
  startMemoryWatchdog();
  // Keep the integration API independent from panel/browser startup. The
  // initial browser page can take an unbounded amount of time to finish
  // loading, but external AI clients must be able to connect as soon as the
  // workspace is ready.
  startExternalAppRunServer();
  await startTestWorkflowWatcher();
  await createMainWindow();
  // Arm the auth auto-renewal heartbeat (and kick an overdue renew) once the
  // window + run server are up, so headless renewals have their deps ready.
  initAuthRenewal();
  // Housekeeping last, and not awaited: a large archive can take seconds to walk
  // and the operator should already have a usable window by then.
  void scheduleRunRetention("startup");
});

app.on("window-all-closed", () => {
  logMainLifecycle("window-all-closed", {
    platform: process.platform,
  });
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  logMainLifecycle("before-quit");
  stopExternalAppRunServer();
  stopTestWorkflowWatcher();
  if (authRenewalTimer) {
    clearInterval(authRenewalTimer);
    authRenewalTimer = null;
  }
  if (browserAdapter?.close) {
    void browserAdapter.close().catch(() => {});
  }
});

app.on("will-quit", () => {
  logMainLifecycle("will-quit");
  // v1.9 REQ-Z26-3: belt and braces. `before-quit` already marks it via
  // stopExternalAppRunServer, but a quit path that skips that (or a start that
  // never reached `listen`) must not leave a live-looking record behind — a
  // consumer trusting a dead base URL is the whole failure this replaces.
  markEndpointFileStaleSync();
});

app.on("render-process-gone", (_event, webContents, details) => {
  logMainLifecycle("render-process-gone", {
    reason: details?.reason || "unknown",
    exitCode: details?.exitCode ?? null,
    url: webContents?.getURL?.() || "",
  });
});

app.on("child-process-gone", (_event, details) => {
  logMainLifecycle("child-process-gone", {
    type: details?.type || "unknown",
    reason: details?.reason || "unknown",
    exitCode: details?.exitCode ?? null,
    serviceName: details?.serviceName || "",
  });
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});
