const pageTitleEl = document.getElementById("page-title");
const pageUrlEl = document.getElementById("page-url");
const requestedUrlEl = document.getElementById("requested-url");
const redirectChainEl = document.getElementById("redirect-chain");
const browserTargetEl = document.getElementById("browser-target");
const browserErrorEl = document.getElementById("browser-error");
const loadProgressEl = document.getElementById("load-progress");
const loadStatusEl = document.getElementById("load-status");
const navigationNoteEl = document.getElementById("navigation-note");
const browserStatusPillEl = document.getElementById("browser-status-pill");
const navigationFormEl = document.getElementById("navigation-form");
const urlInputEl = document.getElementById("url-input");

const runtimeNoteEl = document.getElementById("runtime-note");
const payloadInputEl = document.getElementById("payload-input");
const runPayloadBtn = document.getElementById("run-payload");
const clearPayloadBtn = document.getElementById("clear-payload");
const runtimeStatusPillEl = document.getElementById("runtime-status-pill");
const previewCountPillEl = document.getElementById("preview-count-pill");
const previewErrorEl = document.getElementById("preview-error");
const previewListEl = document.getElementById("preview-list");
const resultPillEl = document.getElementById("result-pill");
const resultSummaryEl = document.getElementById("result-summary");
const reportPathEl = document.getElementById("report-path");
const runDirEl = document.getElementById("run-dir");
const stepEvidenceEl = document.getElementById("step-evidence");
const resultOutputEl = document.getElementById("result-output");

const templates = {
  "click-login": {
    type: "click",
    target: {
      text: "账号登陆",
    },
    needRes: true,
  },
  "type-username": {
    type: "type",
    target: {
      text: "账号",
      value: "DEMO_USER",
    },
    needRes: true,
  },
  "inspect-banner": {
    type: "inspect",
    query: "欢迎来到DEMO管理后台",
    needRes: true,
  },
};

const runtimeState = {
  busy: false,
  available: null,
};

function setPill(el, text, state = "") {
  if (!el) {
    return;
  }
  el.textContent = text;
  if (state) {
    el.dataset.state = state;
  } else {
    delete el.dataset.state;
  }
}

function stringifyCompact(value) {
  if (value == null) {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function updateBusyState() {
  const disabled = runtimeState.busy;
  if (runPayloadBtn) {
    runPayloadBtn.disabled = disabled;
  }
  if (clearPayloadBtn) {
    clearPayloadBtn.disabled = disabled;
  }
  if (payloadInputEl) {
    payloadInputEl.disabled = disabled;
  }
  document.querySelectorAll("[data-template]").forEach((button) => {
    button.disabled = disabled;
  });
}

function setRuntimeNote(text) {
  if (runtimeNoteEl) {
    runtimeNoteEl.textContent = text;
  }
}

function summarizeStepEvidence(result) {
  const steps = Array.isArray(result?.evidence?.steps) ? result.evidence.steps : [];
  if (!steps.length) {
    return "-";
  }
  return steps
    .map((step, index) => {
      const parts = [];
      if (step.beforeScreenshotPath) {
        parts.push(`before=${step.beforeScreenshotPath}`);
      }
      if (step.afterScreenshotPath) {
        parts.push(`after=${step.afterScreenshotPath}`);
      }
      if (step.tracePath) {
        parts.push(`trace=${step.tracePath}`);
      }
      return `step${index + 1}: ${parts.join(" | ")}`;
    })
    .join("\n");
}

function renderResult(result) {
  if (!resultOutputEl) {
    return;
  }

  if (!result) {
    setPill(resultPillEl, "No run yet");
    resultSummaryEl.textContent = "No execution yet.";
    reportPathEl.textContent = "-";
    runDirEl.textContent = "-";
    stepEvidenceEl.textContent = "-";
    resultOutputEl.textContent = "Awaiting runtime execution.";
    return;
  }

  const ok = Boolean(result.ok);
  setPill(resultPillEl, ok ? "Run passed" : "Run failed", ok ? "success" : "error");
  resultSummaryEl.textContent = ok
    ? `Completed in ${result.telemetry?.durationMs ?? "-"} ms`
    : result.error?.message || "Execution failed.";
  reportPathEl.textContent = result.evidence?.reportPath || "-";
  runDirEl.textContent = result.evidence?.runDir || "-";
  stepEvidenceEl.textContent = summarizeStepEvidence(result);
  resultOutputEl.textContent = JSON.stringify(result, null, 2);
}

function normalizeActions(raw) {
  const addAction = (bucket, entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const target =
      (entry.target && typeof entry.target === "object"
        ? entry.target.text ?? entry.target.query
        : null) ??
      entry.query ??
      entry.text ??
      null;
    const label = [entry.type || entry.kind || "inspect", target].filter(Boolean).join(" -> ");
    bucket.push({
      label: label || "inspect",
      waitForChange: entry.waitForChange === true,
      retries:
        entry.retry ??
        entry.retries ??
        entry.retryCount ??
        0,
      expectation: entry.expectation ?? entry.expect ?? entry.expected ?? null,
    });
  };

  if (Array.isArray(raw)) {
    return raw.reduce((bucket, entry) => {
      addAction(bucket, entry);
      return bucket;
    }, []);
  }

  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.actions)) {
      return raw.actions.reduce((bucket, entry) => {
        addAction(bucket, entry);
        return bucket;
      }, []);
    }
    if (Array.isArray(raw.steps)) {
      return raw.steps.reduce((bucket, entry) => {
        addAction(bucket, entry);
        return bucket;
      }, []);
    }
    const single = [];
    addAction(single, raw);
    return single;
  }

  return [];
}

function renderPreview() {
  if (!payloadInputEl || !previewListEl) {
    return;
  }

  const raw = payloadInputEl.value.trim();
  previewListEl.textContent = "";
  previewErrorEl.hidden = true;
  previewErrorEl.textContent = "";

  if (!raw) {
    previewCountPillEl.textContent = "0 actions";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Enter a payload to preview runtime actions.";
    previewListEl.append(empty);
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const actions = normalizeActions(parsed);
    previewCountPillEl.textContent = `${actions.length} action${actions.length === 1 ? "" : "s"}`;

    if (!actions.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No executable actions detected in payload.";
      previewListEl.append(empty);
      return;
    }

    actions.forEach((action, index) => {
      const item = document.createElement("div");
      item.className = "preview-item";
      if (index === 0) {
        item.classList.add("is-first");
      }

      const title = document.createElement("div");
      title.className = "preview-item__title";
      title.textContent = `${index + 1}. ${action.label}`;
      item.append(title);

      const meta = document.createElement("div");
      meta.className = "preview-item__meta";
      const metaParts = [];
      if (action.waitForChange) {
        metaParts.push("waitForChange");
      }
      if (action.retries) {
        metaParts.push(`retries=${action.retries}`);
      }
      if (action.expectation) {
        metaParts.push(`expect=${stringifyCompact(action.expectation)}`);
      }
      meta.textContent = metaParts.join(" | ") || "No extra modifiers.";
      item.append(meta);

      previewListEl.append(item);
    });
  } catch (error) {
    previewCountPillEl.textContent = "Parse error";
    previewErrorEl.hidden = false;
    previewErrorEl.textContent = `Invalid JSON payload: ${error.message || error}`;
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Fix the payload format to see action preview.";
    previewListEl.append(empty);
  }
}

async function refreshRuntimeState() {
  if (!window.panelAPI?.getRuntimeState) {
    setRuntimeNote("Runtime bridge unavailable.");
    return null;
  }
  const state = await window.panelAPI.getRuntimeState();

  runtimeState.available = Boolean(state?.available);
  if (runtimeState.available) {
    setRuntimeNote(
      "Runtime v2 is integrated into the desktop app and reuses the current Playwright window.",
    );
    setPill(runtimeStatusPillEl, "Ready", "success");
  } else {
    const errorMessage = state?.error?.message || "runtime-unavailable";
    setRuntimeNote(`Runtime unavailable: ${errorMessage}`);
    setPill(runtimeStatusPillEl, "Unavailable", "error");
  }
  return state;
}

function updateBrowserState(state = {}) {
  pageTitleEl.textContent = state.title || "Untitled";
  pageUrlEl.textContent = state.url || "-";
  requestedUrlEl.textContent = state.requestedUrl || "-";
  redirectChainEl.textContent =
    Array.isArray(state.redirectChain) && state.redirectChain.length
      ? state.redirectChain.join(" -> ")
      : "-";
  browserTargetEl.textContent =
    state.browserTarget || "Current Playwright window";
  browserErrorEl.textContent = state.lastError?.description || "-";
  if (typeof state.loadProgress === "number") {
    loadProgressEl.style.width = `${Math.max(0, Math.min(100, state.loadProgress))}%`;
  }
  loadStatusEl.textContent = state.loadStatus || "Idle";
  setPill(
    browserStatusPillEl,
    state.isLoading ? "Loading" : "Ready",
    state.lastError ? "error" : state.isLoading ? "running" : "success",
  );
  navigationNoteEl.textContent =
    state.url && state.url !== "-"
      ? `Runtime runs reuse the current page at ${state.url}`
      : "Runtime runs reuse the current Playwright page state.";
}

async function runPayload() {
  if (!payloadInputEl || !window.panelAPI?.runRuntimePayload || runtimeState.busy) {
    return;
  }
  const raw = payloadInputEl.value.trim();
  if (!raw) {
    setPill(runtimeStatusPillEl, "Payload required", "error");
    setRuntimeNote("Enter a JSON payload before running.");
    return;
  }

  runtimeState.busy = true;
  updateBusyState();
  setPill(runtimeStatusPillEl, "Running", "running");
  setRuntimeNote("Submitting payload to runtime-v2...");

  try {
    const state = await refreshRuntimeState();
    if (state?.available === false) {
      throw new Error(state?.error?.message || "runtime-unavailable");
    }
    const result = await window.panelAPI.runRuntimePayload({
      payload: raw,
      options: {},
    });
    renderResult(result);
    if (result?.ok) {
      setPill(runtimeStatusPillEl, "Completed", "success");
      setRuntimeNote("Run completed. Inspect the report and step evidence below.");
    } else {
      setPill(runtimeStatusPillEl, "Failed", "error");
      setRuntimeNote(result?.error?.message || "Runtime reported failure.");
    }
  } catch (error) {
    renderResult({
      ok: false,
      error: {
        message: error?.message || String(error),
      },
    });
    setPill(runtimeStatusPillEl, "Failed", "error");
    setRuntimeNote(`Runtime execution failed: ${error?.message || error}`);
  } finally {
    runtimeState.busy = false;
    updateBusyState();
  }
}

navigationFormEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = urlInputEl?.value?.trim();
  if (!target || !window.panelAPI?.navigate) {
    return;
  }
  const result = await window.panelAPI.navigate(target);
  if (!result?.success) {
    setPill(browserStatusPillEl, "Navigation failed", "error");
  }
});

document.querySelector('[data-action="back"]')?.addEventListener("click", () => {
  void window.panelAPI?.back?.();
});

document.querySelector('[data-action="forward"]')?.addEventListener("click", () => {
  void window.panelAPI?.forward?.();
});

document.querySelector('[data-action="reload"]')?.addEventListener("click", () => {
  void window.panelAPI?.reload?.();
});

document.querySelector('[data-action="stop"]')?.addEventListener("click", () => {
  void window.panelAPI?.stop?.();
});

payloadInputEl?.addEventListener("input", () => {
  renderPreview();
});

runPayloadBtn?.addEventListener("click", () => {
  void runPayload();
});

clearPayloadBtn?.addEventListener("click", () => {
  if (runtimeState.busy || !payloadInputEl) {
    return;
  }
  payloadInputEl.value = "";
  renderPreview();
  renderResult(null);
});

document.querySelectorAll("[data-template]").forEach((button) => {
  button.addEventListener("click", () => {
    const template = templates[button.dataset.template];
    if (!template || !payloadInputEl || runtimeState.busy) {
      return;
    }
    payloadInputEl.value = JSON.stringify(template, null, 2);
    renderPreview();
    payloadInputEl.focus();
  });
});

window.panelAPI?.onBrowserState?.((state) => {
  updateBrowserState(state);
});

window.panelAPI?.requestState?.();
renderPreview();
renderResult(null);
updateBusyState();
void refreshRuntimeState();
