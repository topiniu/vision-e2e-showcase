export function getPanelAPI() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.panelAPI ?? null;
}

export function getPanelPlatform() {
  return getPanelAPI()?.platform || "web";
}

export function getPanelAppMode() {
  return getPanelAPI()?.appMode || "web";
}

async function requestWebAPI(path, options = {}) {
  const response = await fetch(`/__zhuzhu${path}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!response.ok) {
    return {
      success: false,
      error: "web-api-request-failed",
      status: response.status,
    };
  }
  return response.json();
}

export async function getRuntimeState() {
  const api = getPanelAPI();
  if (api?.getRuntimeState) {
    return api.getRuntimeState();
  }
  return requestWebAPI("/runtime-state");
}

export async function getWorkspaceSettings() {
  const api = getPanelAPI();
  if (api?.getWorkspaceSettings) {
    return api.getWorkspaceSettings();
  }
  return { success: false, error: "workspace-settings-unavailable-in-web-mode" };
}

export async function chooseWorkspace() {
  const api = getPanelAPI();
  if (api?.chooseWorkspace) {
    return api.chooseWorkspace();
  }
  return { success: false, error: "workspace-settings-unavailable-in-web-mode" };
}

export async function resetWorkspace() {
  const api = getPanelAPI();
  if (api?.resetWorkspace) {
    return api.resetWorkspace();
  }
  return { success: false, error: "workspace-settings-unavailable-in-web-mode" };
}

export async function openWorkspace(workspaceRoot) {
  const api = getPanelAPI();
  if (api?.openWorkspace) {
    return api.openWorkspace(workspaceRoot);
  }
  return { success: false, error: "workspace-settings-unavailable-in-web-mode" };
}

export async function restartApp() {
  const api = getPanelAPI();
  if (api?.restartApp) {
    return api.restartApp();
  }
  return { success: false, error: "workspace-settings-unavailable-in-web-mode" };
}

export async function getExternalIntegrationDocuments() {
  const api = getPanelAPI();
  if (api?.getExternalIntegrationDocuments) {
    return api.getExternalIntegrationDocuments();
  }
  return requestWebAPI("/external-integration-documents");
}

// Resolve the read-only page for the main window's embedded board.
export async function getRunBoardUrl() {
  const api = getPanelAPI();
  if (api?.getRunBoardUrl) {
    return api.getRunBoardUrl();
  }
  return { success: true, url: new URL("/run-board", window.location.href).href };
}

export async function getExternalActivitySnapshot() {
  const api = getPanelAPI();
  if (api?.getExternalActivitySnapshot) {
    return api.getExternalActivitySnapshot();
  }
  return { success: true, active: [], recent: [] };
}

export function subscribeExternalActivity(callback) {
  const api = getPanelAPI();
  if (!api?.onExternalActivity) {
    return () => {};
  }
  return api.onExternalActivity(callback);
}

export async function markExternalAppRunReady() {
  const api = getPanelAPI();
  if (api?.markExternalAppRunReady) {
    return api.markExternalAppRunReady();
  }
  return { success: false, error: "external-app-run-unavailable-in-web-mode" };
}

export async function completeExternalAppRun(payload = {}) {
  const api = getPanelAPI();
  if (api?.completeExternalAppRun) {
    return api.completeExternalAppRun(payload);
  }
  return { success: false, error: "external-app-run-unavailable-in-web-mode" };
}

// Z02: push per-run progress milestones so external subscribers (SSE) get
// start/per-case/finish events without holding a long connection. Best-effort —
// never throws into the run loop.
export async function reportExternalAppRunProgress(payload = {}) {
  const api = getPanelAPI();
  if (api?.reportExternalAppRunProgress) {
    try {
      return await api.reportExternalAppRunProgress(payload);
    } catch (_error) {
      return { success: false, error: "progress-report-failed" };
    }
  }
  return { success: false, error: "external-app-run-unavailable-in-web-mode" };
}

const BROWSER_PROXY_MODES = ["system", "manual", "direct"];
const DEFAULT_PANEL_PREFERENCES = {
  openChromeOnSecondaryDisplay: true,
  maximizeChromeOnLaunch: true,
  browserProxyMode: "system",
  browserProxyServer: "",
  browserProxyBypass: "",
  browserIdleTimeoutMinutes: 15,
};

function normalizeIdleTimeoutMinutes(value) {
  if (value === 0 || value === "0") {
    return 0;
  }
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PANEL_PREFERENCES.browserIdleTimeoutMinutes;
  }
  return Math.min(parsed, 240);
}

function normalizePanelPreferences(value = {}) {
  return {
    openChromeOnSecondaryDisplay: value.openChromeOnSecondaryDisplay !== false,
    maximizeChromeOnLaunch: value.maximizeChromeOnLaunch !== false,
    browserProxyMode: BROWSER_PROXY_MODES.includes(value.browserProxyMode)
      ? value.browserProxyMode
      : "system",
    browserProxyServer: typeof value.browserProxyServer === "string" ? value.browserProxyServer.trim() : "",
    browserProxyBypass: typeof value.browserProxyBypass === "string" ? value.browserProxyBypass.trim() : "",
    browserIdleTimeoutMinutes: normalizeIdleTimeoutMinutes(value.browserIdleTimeoutMinutes),
  };
}

function readWebPanelPreferences() {
  if (typeof window === "undefined") {
    return { ...DEFAULT_PANEL_PREFERENCES };
  }
  try {
    return normalizePanelPreferences(
      JSON.parse(window.localStorage.getItem("zhuzhu-panel-preferences") || "null") || {},
    );
  } catch (_error) {
    return { ...DEFAULT_PANEL_PREFERENCES };
  }
}

export async function getPanelPreferences() {
  const api = getPanelAPI();
  if (api?.getPreferences) {
    return api.getPreferences();
  }
  return {
    success: true,
    preferences: readWebPanelPreferences(),
  };
}

export async function updatePanelPreferences(payload = {}) {
  const api = getPanelAPI();
  if (api?.updatePreferences) {
    return api.updatePreferences(payload);
  }
  const preferences = normalizePanelPreferences({
    ...readWebPanelPreferences(),
    ...(payload?.preferences || payload || {}),
  });
  window.localStorage.setItem("zhuzhu-panel-preferences", JSON.stringify(preferences));
  return {
    success: true,
    preferences,
  };
}

export async function notifyRunFileComplete(payload = {}) {
  const api = getPanelAPI();
  if (api?.notifyRunFileComplete) {
    return api.notifyRunFileComplete(payload);
  }
  return {
    success: false,
    error: "notification-unavailable-in-web-mode",
  };
}

export async function capturePageStructure(payload = {}) {
  const api = getPanelAPI();
  if (api?.capturePageStructure) {
    return api.capturePageStructure(payload);
  }
  return requestWebAPI("/page-structure", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function captureAuthProfile(payload) {
  const api = getPanelAPI();
  if (api?.captureAuthProfile) {
    return api.captureAuthProfile(payload);
  }
  return requestWebAPI("/auth/capture", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function getAuthStatus(payload) {
  const api = getPanelAPI();
  if (api?.getAuthStatus) {
    return api.getAuthStatus(payload);
  }
  return { ok: false, error: "auth-status-unavailable-in-web-mode" };
}

export async function getAuthRenewalConfig() {
  const api = getPanelAPI();
  if (api?.getAuthRenewalConfig) {
    return api.getAuthRenewalConfig();
  }
  return { ok: false, error: "auth-renewal-unavailable-in-web-mode" };
}

export async function setAuthRenewalConfig(payload) {
  const api = getPanelAPI();
  if (api?.setAuthRenewalConfig) {
    return api.setAuthRenewalConfig(payload);
  }
  return { ok: false, error: "auth-renewal-unavailable-in-web-mode" };
}

export async function renewAuthProfile(payload) {
  const api = getPanelAPI();
  if (api?.renewAuthProfile) {
    return api.renewAuthProfile(payload);
  }
  return { ok: false, error: "auth-renewal-unavailable-in-web-mode" };
}

export function subscribeAuthRenewalStatus(listener) {
  return getPanelAPI()?.onAuthRenewalStatus?.(listener) ?? (() => {});
}

export async function navigate(targetUrl) {
  const api = getPanelAPI();
  if (api?.navigate) {
    return api.navigate(targetUrl);
  }
  return {
    success: false,
    error: "browser-unavailable-in-web-mode",
    message: "Open the Zhuzhu desktop app to navigate the controlled browser.",
  };
}

export async function runRuntimePayload(payload) {
  const api = getPanelAPI();
  if (api?.runRuntimePayload) {
    return api.runRuntimePayload(payload);
  }
  return requestWebAPI("/runtime-run", {
    method: "POST",
    body: JSON.stringify(payload && typeof payload === "object" ? payload : { payload }),
  });
}

export async function stopRuntimeRun(payload) {
  const api = getPanelAPI();
  if (api?.stopRuntimeRun) {
    return api.stopRuntimeRun(payload);
  }
  return requestWebAPI("/runtime-stop", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function readEvidenceImage(rawPath) {
  const api = getPanelAPI();
  if (api?.readEvidenceImage) {
    return api.readEvidenceImage(rawPath);
  }
  return requestWebAPI("/evidence-image", {
    method: "POST",
    body: JSON.stringify({ path: rawPath }),
  });
}

// v1.8 perf: resolve an evidence screenshot to something an `<img>` can load.
//
// In Electron this is a `zhuzhu-evidence://` URL — Chromium streams the file,
// decodes it once and evicts it like any other image. In web mode (`npm run
// web`, no Electron, no custom scheme) it falls back to the base64 data URL,
// which is why the return shape is a plain string either way: callers set it as
// `src` and do not care which kind it is.
export async function resolveEvidenceImageSrc(rawPath) {
  if (!rawPath) {
    return { success: false, error: "invalid-path" };
  }
  const api = getPanelAPI();
  if (api?.getEvidenceImageUrl) {
    const payload = await api.getEvidenceImageUrl(rawPath);
    if (payload?.success && payload.url) {
      return { success: true, src: payload.url, streamed: true };
    }
    return { success: false, error: payload?.error || "image-unavailable" };
  }
  const payload = await readEvidenceImage(rawPath);
  if (payload?.success && payload.dataUrl) {
    return { success: true, src: payload.dataUrl, streamed: false };
  }
  return {
    success: false,
    error: payload?.message || payload?.error || "image-unavailable",
  };
}

export async function readEvidenceJson(rawPath) {
  const api = getPanelAPI();
  if (api?.readEvidenceJson) {
    return api.readEvidenceJson(rawPath);
  }
  return requestWebAPI("/evidence-json", {
    method: "POST",
    body: JSON.stringify({ path: rawPath }),
  });
}

export async function listTestFiles() {
  const api = getPanelAPI();
  if (api?.listTestFiles) {
    return api.listTestFiles();
  }
  return requestWebAPI("/test-files");
}

export async function readTestFile(relativePath) {
  const api = getPanelAPI();
  if (api?.readTestFile) {
    return api.readTestFile(relativePath);
  }
  return requestWebAPI(`/test-files/read?path=${encodeURIComponent(relativePath || "")}`);
}

export async function saveTestFile(payload) {
  const api = getPanelAPI();
  if (api?.saveTestFile) {
    return api.saveTestFile(payload);
  }
  return requestWebAPI("/test-files/save", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function createTestFile(payload) {
  const api = getPanelAPI();
  if (api?.createTestFile) {
    return api.createTestFile(payload);
  }
  return requestWebAPI("/test-files/create", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function copyTestFile(payload) {
  const api = getPanelAPI();
  if (api?.copyTestFile) {
    return api.copyTestFile(payload);
  }
  return requestWebAPI("/test-files/copy", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function listRunHistory(payload) {
  const api = getPanelAPI();
  if (api?.listRunHistory) {
    return api.listRunHistory(payload);
  }
  return requestWebAPI("/run-history", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function listRunArchive(payload) {
  const api = getPanelAPI();
  if (api?.listRunArchive) {
    return api.listRunArchive(payload);
  }
  return requestWebAPI("/run-archive", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function readRunReport(payload) {
  const api = getPanelAPI();
  if (api?.readRunReport) {
    return api.readRunReport(payload);
  }
  return requestWebAPI("/run-report", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function evaluateTestFile(payload) {
  const api = getPanelAPI();
  if (api?.evaluateTestFile) {
    return api.evaluateTestFile(payload);
  }
  return {
    success: false,
    error: "test-file-evaluate-unavailable-in-web-mode",
    message: "Open the Zhuzhu desktop app to evaluate test files through the trusted runtime path.",
  };
}

export async function runTestSession(payload) {
  const api = getPanelAPI();
  if (api?.runTestSession) {
    return api.runTestSession(payload);
  }
  return {
    success: false,
    error: "test-session-unavailable-in-web-mode",
    message: "Open the Zhuzhu desktop app to run test sessions.",
  };
}

export async function runTestBatch(payload) {
  const api = getPanelAPI();
  if (api?.runTestBatch) {
    return api.runTestBatch(payload);
  }
  return {
    success: false,
    error: "test-batch-unavailable-in-web-mode",
    message: "Open the Zhuzhu desktop app to run test files in parallel.",
  };
}

export async function listCheckpoints() {
  const api = getPanelAPI();
  if (api?.listCheckpoints) {
    return api.listCheckpoints();
  }
  return { success: false, error: "checkpoints-unavailable-in-web-mode", checkpoints: [] };
}

export async function clearCheckpoint(id) {
  const api = getPanelAPI();
  if (api?.clearCheckpoint) {
    return api.clearCheckpoint({ id });
  }
  return { success: false, error: "checkpoints-unavailable-in-web-mode" };
}

export async function readTestSessionRepairContext(payload) {
  const api = getPanelAPI();
  if (api?.readTestSessionRepairContext) {
    return api.readTestSessionRepairContext(payload);
  }
  return {
    success: false,
    error: "repair-context-unavailable-in-web-mode",
    message: "Open the Zhuzhu desktop app to read repair context.",
  };
}

export async function exportPdf(payload) {
  const api = getPanelAPI();
  if (api?.exportPdf) {
    return api.exportPdf(payload);
  }
  return {
    success: false,
    error: "pdf-export-unavailable-in-web-mode",
    message: "Open the Zhuzhu desktop app to export PDF reports.",
  };
}

export async function rebuildRunArchive() {
  const api = getPanelAPI();
  if (api?.rebuildRunArchive) {
    return api.rebuildRunArchive();
  }
  return requestWebAPI("/run-archive/rebuild", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function appendDebugLog(payload) {
  const api = getPanelAPI();
  if (api?.appendDebugLog) {
    return api.appendDebugLog(payload);
  }
  return requestWebAPI("/debug-log", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export function subscribeRuntimeRunEvents(listener) {
  return getPanelAPI()?.onRuntimeRunEvent?.(listener) ?? (() => {});
}

// v1.8: main warns when the panel renderer's resident memory crosses the
// threshold, so the operator sees pressure *before* the window dies.
export function subscribePanelMemoryWarnings(listener) {
  return getPanelAPI()?.onPanelMemoryWarning?.(listener) ?? (() => {});
}

// v1.9: the machine itself is near its ceiling, so the next visible browser may
// be OOM-killed as it launches. Distinct from the panel warning above: that one
// is about this renderer, this one is about every process on the box.
export function subscribeHostMemoryWarnings(listener) {
  return getPanelAPI()?.onHostMemoryWarning?.(listener) ?? (() => {});
}

export function subscribeExternalAppRunRequests(listener) {
  return getPanelAPI()?.onExternalAppRunRequest?.(listener) ?? (() => {});
}

// REQ-Z13: main asks the panel to abandon the App-run it is driving.
export function subscribeExternalAppRunCancels(listener) {
  return getPanelAPI()?.onExternalAppRunCancel?.(listener) ?? (() => {});
}

export function subscribeTestFileChanges(listener) {
  return getPanelAPI()?.onTestFileChange?.(listener) ?? (() => {});
}

export function subscribeTestBatchProgress(listener) {
  return getPanelAPI()?.onTestBatchProgress?.(listener) ?? (() => {});
}

export function subscribeBrowserState(listener) {
  return getPanelAPI()?.onBrowserState?.(listener) ?? (() => {});
}

export function requestBrowserState() {
  getPanelAPI()?.requestState?.();
}

export async function browserCommand(command) {
  const api = getPanelAPI();
  if (!api) {
    return null;
  }
  switch (command) {
    case "back":
      return api.back?.();
    case "forward":
      return api.forward?.();
    case "reload":
      return api.reload?.();
    case "stop":
      return api.stop?.();
    default:
      return null;
  }
}
