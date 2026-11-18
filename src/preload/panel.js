const { contextBridge, ipcRenderer } = require("electron");

const browserStateListeners = new Set();
const runtimeRunEventListeners = new Set();
const testFileChangeListeners = new Set();
const externalAppRunRequestListeners = new Set();
// REQ-Z13: main tells the panel to abandon a run it is currently driving (cancel
// endpoint or the stall watchdog), so the per-case loop stops instead of
// finishing and reporting a result for an already-cancelled run.
const externalAppRunCancelListeners = new Set();
const externalActivityListeners = new Set();
const testBatchProgressListeners = new Set();
const authRenewalStatusListeners = new Set();
// v1.8: main samples the panel renderer's resident memory and warns before it
// OOMs, because Chromium gives no signal of its own — by the time the renderer
// dies there is nothing left to report.
const panelMemoryWarningListeners = new Set();
// v1.9: the same idea one level up — the *machine* is running out of memory, so
// the next visible Chromium may be OOM-killed on launch. Zhuzhu is one tenant
// among many on a dev box and cannot fix that, but staying silent about it is
// how "开一个浏览器就 out of Memory" became a mystery instead of a reading.
const hostMemoryWarningListeners = new Set();
const appMode = process.argv.includes("--zhuzhu-app-mode=development") ? "development" : "production";

ipcRenderer.on("browser-state", (_event, payload) => {
  browserStateListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("browser-state listener error", error);
    }
  });
});

ipcRenderer.on("runtime-run-event", (_event, payload) => {
  runtimeRunEventListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("runtime-run-event listener error", error);
    }
  });
});

ipcRenderer.on("panel-memory-warning", (_event, payload) => {
  panelMemoryWarningListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("panel-memory-warning listener error", error);
    }
  });
});

ipcRenderer.on("host-memory-warning", (_event, payload) => {
  hostMemoryWarningListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("host-memory-warning listener error", error);
    }
  });
});

ipcRenderer.on("test-file-change", (_event, payload) => {
  testFileChangeListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("test-file-change listener error", error);
    }
  });
});

ipcRenderer.on("external-app-run-request", (_event, payload) => {
  externalAppRunRequestListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("external-app-run-request listener error", error);
    }
  });
});

ipcRenderer.on("external-app-run-cancel", (_event, payload) => {
  externalAppRunCancelListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("external-app-run-cancel listener error", error);
    }
  });
});

ipcRenderer.on("external-activity", (_event, payload) => {
  externalActivityListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("external-activity listener error", error);
    }
  });
});

ipcRenderer.on("test-batch-progress", (_event, payload) => {
  testBatchProgressListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("test-batch-progress listener error", error);
    }
  });
});

ipcRenderer.on("auth-renewal-status", (_event, payload) => {
  authRenewalStatusListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (error) {
      console.error("auth-renewal-status listener error", error);
    }
  });
});

contextBridge.exposeInMainWorld("panelAPI", {
  platform: process.platform,
  appMode,
  navigate: (rawUrl) => ipcRenderer.invoke("panel:navigate", rawUrl),
  back: () => ipcRenderer.invoke("panel:back"),
  forward: () => ipcRenderer.invoke("panel:forward"),
  reload: (options) => ipcRenderer.invoke("panel:reload", options),
  stop: () => ipcRenderer.invoke("panel:stop"),
  getRuntimeState: () => ipcRenderer.invoke("panel:runtime-state"),
  getWorkspaceSettings: () => ipcRenderer.invoke("panel:workspace-settings"),
  chooseWorkspace: () => ipcRenderer.invoke("panel:choose-workspace"),
  resetWorkspace: () => ipcRenderer.invoke("panel:reset-workspace"),
  openWorkspace: (workspaceRoot) => ipcRenderer.invoke("panel:open-workspace", workspaceRoot),
  restartApp: () => ipcRenderer.invoke("panel:restart-app"),
  getExternalIntegrationDocuments: () => ipcRenderer.invoke("panel:external-integration-documents"),
  getExternalActivitySnapshot: () => ipcRenderer.invoke("panel:external-activity-snapshot"),
  getRunBoardUrl: () => ipcRenderer.invoke("panel:run-board-url"),
  markExternalAppRunReady: () => ipcRenderer.invoke("panel:external-app-run-ready"),
  completeExternalAppRun: (payload) => ipcRenderer.invoke("panel:complete-external-app-run", payload),
  reportExternalAppRunProgress: (payload) => ipcRenderer.invoke("panel:external-app-run-progress", payload),
  getPreferences: () => ipcRenderer.invoke("panel:get-preferences"),
  updatePreferences: (payload) => ipcRenderer.invoke("panel:update-preferences", payload),
  notifyRunFileComplete: (payload) => ipcRenderer.invoke("panel:notify-run-file-complete", payload),
  capturePageStructure: (payload) => ipcRenderer.invoke("panel:capture-page-structure", payload),
  captureAuthProfile: (payload) => ipcRenderer.invoke("panel:capture-auth-profile", payload),
  getAuthStatus: (payload) => ipcRenderer.invoke("panel:get-auth-status", payload),
  getAuthRenewalConfig: () => ipcRenderer.invoke("panel:get-auth-renewal-config"),
  setAuthRenewalConfig: (payload) => ipcRenderer.invoke("panel:set-auth-renewal-config", payload),
  renewAuthProfile: (payload) => ipcRenderer.invoke("panel:renew-auth-profile", payload),
  runRuntimePayload: (payload) => ipcRenderer.invoke("panel:runtime-run", payload),
  stopRuntimeRun: (payload) => ipcRenderer.invoke("panel:runtime-stop", payload),
  readEvidenceImage: (rawPath) => ipcRenderer.invoke("panel:read-evidence-image", rawPath),
  getEvidenceImageUrl: (rawPath) => ipcRenderer.invoke("panel:get-evidence-image-url", rawPath),
  readEvidenceJson: (rawPath) => ipcRenderer.invoke("panel:read-evidence-json", rawPath),
  listTestFiles: () => ipcRenderer.invoke("panel:list-test-files"),
  readTestFile: (relativePath) => ipcRenderer.invoke("panel:read-test-file", relativePath),
  saveTestFile: (payload) => ipcRenderer.invoke("panel:save-test-file", payload),
  createTestFile: (payload) => ipcRenderer.invoke("panel:create-test-file", payload),
  copyTestFile: (payload) => ipcRenderer.invoke("panel:copy-test-file", payload),
  listRunHistory: (payload) => ipcRenderer.invoke("panel:list-run-history", payload),
  listRunArchive: (payload) => ipcRenderer.invoke("panel:list-run-archive", payload),
  readRunReport: (payload) => ipcRenderer.invoke("panel:read-run-report", payload),
  evaluateTestFile: (payload) => ipcRenderer.invoke("panel:evaluate-test-file", payload),
  runTestSession: (payload) => ipcRenderer.invoke("panel:run-test-session", payload),
  runTestBatch: (payload) => ipcRenderer.invoke("panel:run-test-batch", payload),
  listCheckpoints: () => ipcRenderer.invoke("panel:list-checkpoints"),
  clearCheckpoint: (payload) => ipcRenderer.invoke("panel:clear-checkpoint", payload),
  readTestSessionRepairContext: (payload) => ipcRenderer.invoke("panel:read-test-session-repair-context", payload),
  exportPdf: (payload) => ipcRenderer.invoke("panel:export-pdf", payload),
  rebuildRunArchive: () => ipcRenderer.invoke("panel:rebuild-run-archive"),
  appendDebugLog: (payload) => ipcRenderer.invoke("panel:append-debug-log", payload),
  requestState: () => ipcRenderer.send("panel:request-state"),
  onBrowserState: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onBrowserState expects a callback function");
    }
    browserStateListeners.add(callback);
    return () => browserStateListeners.delete(callback);
  },
  onRuntimeRunEvent: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onRuntimeRunEvent expects a callback function");
    }
    runtimeRunEventListeners.add(callback);
    return () => runtimeRunEventListeners.delete(callback);
  },
  onPanelMemoryWarning: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onPanelMemoryWarning expects a callback function");
    }
    panelMemoryWarningListeners.add(callback);
    return () => panelMemoryWarningListeners.delete(callback);
  },
  onHostMemoryWarning: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onHostMemoryWarning expects a callback function");
    }
    hostMemoryWarningListeners.add(callback);
    return () => hostMemoryWarningListeners.delete(callback);
  },
  onTestFileChange: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onTestFileChange expects a callback function");
    }
    testFileChangeListeners.add(callback);
    return () => testFileChangeListeners.delete(callback);
  },
  onExternalAppRunRequest: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onExternalAppRunRequest expects a callback function");
    }
    externalAppRunRequestListeners.add(callback);
    return () => externalAppRunRequestListeners.delete(callback);
  },
  onExternalAppRunCancel: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onExternalAppRunCancel expects a callback function");
    }
    externalAppRunCancelListeners.add(callback);
    return () => externalAppRunCancelListeners.delete(callback);
  },
  onExternalActivity: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onExternalActivity expects a callback function");
    }
    externalActivityListeners.add(callback);
    return () => externalActivityListeners.delete(callback);
  },
  onTestBatchProgress: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onTestBatchProgress expects a callback function");
    }
    testBatchProgressListeners.add(callback);
    return () => testBatchProgressListeners.delete(callback);
  },
  onAuthRenewalStatus: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("panelAPI.onAuthRenewalStatus expects a callback function");
    }
    authRenewalStatusListeners.add(callback);
    return () => authRenewalStatusListeners.delete(callback);
  },
});
