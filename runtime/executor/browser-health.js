"use strict";


const { withProbeTimeout } = require("./hard-timeout");

// Playwright's own documentation for the `crash` event: "Page crash usually
// happens when Chromium runs out of memory." We surface that as its own code so
// the report, the fix hints, and the visible-channel auto-recovery can all key
// on "the browser died of OOM" rather than on a generic timeout.
const BROWSER_OOM_CODE = "browser-oom";
// A closed page / a disconnected browser process is also fatal to the run, but
// it is NOT evidence of OOM (the user may simply have closed the tab). Reuse the
// pre-existing code so `classifyFailure` and the main-process recovery predicate
// already understand it.
const BROWSER_UNAVAILABLE_CODE = "browser-unavailable";

function readEnvNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Warn when the renderer's JS heap crosses this. Chromium's default cap is
// ~2-4 GB depending on platform/flags, so 1.5 GB is "getting dangerous" without
// being noisy for ordinary runs.
function getHeapWarnBytes() {
  return readEnvNumber("ZHUZHU_BROWSER_HEAP_WARN_MB", 1536) * 1024 * 1024;
}

// Minimum spacing between samples. Sampling is a CDP round-trip; once per step
// on a fast step loop would be pure overhead.
function getMemorySampleIntervalMs() {
  return readEnvNumber("ZHUZHU_BROWSER_MEMORY_SAMPLE_MS", 3_000);
}

function toMegabytes(bytes) {
  return Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null;
}

// Recognize a crash that surfaced as a thrown error rather than as an event —
// Playwright rejects in-flight calls on a crashed target with these messages, and
// they can win the race against our own `crash` listener.
function isBrowserCrashError(error) {
  const text = `${error?.message || error || ""}`.toLowerCase();
  return (
    text.includes("target crashed") ||
    text.includes("page crashed") ||
    text.includes("out of memory") ||
    text.includes("oom")
  );
}

function isBrowserGoneError(error) {
  const text = `${error?.message || error || ""}`.toLowerCase();
  return (
    isBrowserCrashError(error) ||
    text.includes("target closed") ||
    text.includes("browser has been closed") ||
    text.includes("browser closed")
  );
}

// Classify a thrown error into the same `failure` shape the event listeners
// produce, so callers have one vocabulary regardless of how the death surfaced.
function classifyBrowserFailureError(error) {
  if (isBrowserCrashError(error)) {
    return {
      code: BROWSER_OOM_CODE,
      crashKind: "renderer-crash",
      message: error?.message || "The page crashed (Chromium renderer out of memory).",
    };
  }
  if (isBrowserGoneError(error)) {
    return {
      code: BROWSER_UNAVAILABLE_CODE,
      crashKind: "target-closed",
      message: error?.message || "The browser target is gone.",
    };
  }
  return null;
}

class BrowserHealthMonitor {
  constructor({ page = null, onEvent = null, runId = null } = {}) {
    this.page = page;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.runId = runId;
    this.failure = null;
    this.disposed = false;
    this.cdpSession = null;
    this.cdpUnavailable = false;
    this.lastSampleAt = 0;
    this.warned = false;
    this.samples = 0;
    this.peakJsHeapUsedSize = 0;
    this.lastJsHeapUsedSize = null;
    this.jsHeapTotalSize = null;
    this.peakNodes = 0;
    this.lastSampleError = null;
    // A promise every in-flight operation can race against. It is deliberately a
    // *pending* promise that only ever settles on failure, so racing it is free.
    this.failurePromise = new Promise((resolve) => {
      this.signalFailure = resolve;
    });
    // Nobody may await this promise (a healthy run never touches it) — keep it
    // from ever looking like an unhandled rejection by resolving, not rejecting.
    this.listeners = [];
    this.attach();
  }

  attach() {
    const page = this.page;
    if (!page || typeof page.on !== "function") {
      return;
    }
    // THE missing listener. A renderer OOM lands here and nowhere else.
    this.bind(page, "crash", () =>
      this.recordFailure({
        code: BROWSER_OOM_CODE,
        crashKind: "renderer-crash",
        message:
          "The Chromium renderer crashed, which is almost always an out-of-memory kill. " +
          "The page is unusable: every remaining step would only burn its own timeout.",
      }),
    );
    this.bind(page, "close", () =>
      this.recordFailure({
        code: BROWSER_UNAVAILABLE_CODE,
        crashKind: "page-closed",
        message: "The page was closed, so the run has no target left to drive.",
      }),
    );
    // The whole browser process going away (e.g. killed by the OS OOM killer)
    // shows up on the Browser object, not the page.
    const browser = this.resolveBrowser();
    if (browser && typeof browser.on === "function") {
      this.bind(browser, "disconnected", () =>
        this.recordFailure({
          code: BROWSER_UNAVAILABLE_CODE,
          crashKind: "browser-disconnected",
          message:
            "The browser process disconnected (crashed, was closed, or was killed by the OS — " +
            "a system-level out-of-memory kill looks like this).",
        }),
      );
    }
  }

  resolveBrowser() {
    try {
      const context = typeof this.page?.context === "function" ? this.page.context() : null;
      return typeof context?.browser === "function" ? context.browser() : null;
    } catch (_error) {
      return null;
    }
  }

  bind(target, event, handler) {
    try {
      target.on(event, handler);
      this.listeners.push({ target, event, handler });
    } catch (_error) {
      // A fake/limited page in tests may not support every event — not fatal.
    }
  }

  // First failure wins: once the browser is gone the later events it triggers
  // (a crash is often followed by a close) must not overwrite the real cause.
  recordFailure(failure) {
    if (this.failure || this.disposed) {
      return this.failure;
    }
    this.failure = {
      ...failure,
      at: Date.now(),
      heapUsedMb: toMegabytes(this.lastJsHeapUsedSize),
      peakHeapUsedMb: toMegabytes(this.peakJsHeapUsedSize) || null,
      peakNodes: this.peakNodes || null,
    };
    this.signalFailure(this.failure);
    this.emit({
      type: "browser-crashed",
      runId: this.runId,
      code: this.failure.code,
      crashKind: this.failure.crashKind,
      message: this.failure.message,
      heapUsedMb: this.failure.heapUsedMb,
      peakHeapUsedMb: this.failure.peakHeapUsedMb,
      peakNodes: this.failure.peakNodes,
      at: this.failure.at,
    });
    return this.failure;
  }

  // Let a caller feed back a thrown error that turned out to be a crash, so the
  // rest of the run takes the same path as an event-detected crash.
  noteError(error) {
    if (this.failure) {
      return this.failure;
    }
    const classified = classifyBrowserFailureError(error);
    return classified ? this.recordFailure(classified) : null;
  }

  isUnhealthy() {
    return Boolean(this.failure);
  }

  getFailure() {
    return this.failure;
  }

  // Race this against any in-flight operation. Resolves (never rejects) with the
  // failure, so the caller decides what to do instead of catching.
  waitForFailure() {
    return this.failurePromise;
  }

  emit(event) {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent(event);
    } catch (_error) {
      // Telemetry delivery must never affect the run.
    }
  }

  async resolveCdpSession() {
    if (this.cdpSession || this.cdpUnavailable) {
      return this.cdpSession;
    }
    try {
      const context = typeof this.page?.context === "function" ? this.page.context() : null;
      if (!context || typeof context.newCDPSession !== "function") {
        this.cdpUnavailable = true;
        return null;
      }
      const session = await withProbeTimeout(() => context.newCDPSession(this.page), {
        label: "newCDPSession(memory)",
      });
      await withProbeTimeout(() => session.send("Performance.enable"), { label: "Performance.enable" });
      this.cdpSession = session;
      return session;
    } catch (_error) {
      // No CDP (non-Chromium, a fake page in tests, or an already-dead target).
      // Memory telemetry is a nice-to-have; give up permanently and stay quiet.
      this.cdpUnavailable = true;
      return null;
    }
  }

  // Sample the renderer's JS heap. Advisory ONLY:
  //  - it never marks the browser unhealthy (a failed sample is not proof of
  //    death, and a false positive here would kill legitimate heavy cases);
  //  - it is bounded by the probe deadline, so the watchdog can never become a
  //    new source of the very freeze it exists to report.
  // Note the honest limit: this is the renderer's *JS heap*, not Chrome's total
  // RSS. An OOM caused by native/GPU/tab memory will not show up here — that
  // case is covered by the crash event above.
  async sampleMemory({ force = false } = {}) {
    if (this.disposed || this.failure) {
      return null;
    }
    const now = Date.now();
    if (!force && this.lastSampleAt && now - this.lastSampleAt < getMemorySampleIntervalMs()) {
      return null;
    }
    this.lastSampleAt = now;
    const session = await this.resolveCdpSession();
    if (!session) {
      return null;
    }
    let metrics;
    try {
      const response = await withProbeTimeout(() => session.send("Performance.getMetrics"), {
        label: "Performance.getMetrics",
      });
      metrics = Array.isArray(response?.metrics) ? response.metrics : [];
    } catch (error) {
      this.lastSampleError = error?.message || String(error);
      return null;
    }
    const read = (name) => {
      const entry = metrics.find((item) => item?.name === name);
      return Number.isFinite(entry?.value) ? entry.value : null;
    };
    const sample = {
      sampledAt: now,
      jsHeapUsedSize: read("JSHeapUsedSize"),
      jsHeapTotalSize: read("JSHeapTotalSize"),
      nodes: read("Nodes"),
      documents: read("Documents"),
      jsEventListeners: read("JSEventListeners"),
    };
    this.samples += 1;
    if (Number.isFinite(sample.jsHeapUsedSize)) {
      this.lastJsHeapUsedSize = sample.jsHeapUsedSize;
      this.peakJsHeapUsedSize = Math.max(this.peakJsHeapUsedSize, sample.jsHeapUsedSize);
    }
    if (Number.isFinite(sample.jsHeapTotalSize)) {
      this.jsHeapTotalSize = sample.jsHeapTotalSize;
    }
    if (Number.isFinite(sample.nodes)) {
      this.peakNodes = Math.max(this.peakNodes, sample.nodes);
    }
    // Emit on the *crossing* only. Emitting per sample would flood the App-run
    // SSE replay buffer — the same mistake the v1.3 heartbeat had to unlearn.
    const warnBytes = getHeapWarnBytes();
    if (!this.warned && warnBytes > 0 && Number.isFinite(sample.jsHeapUsedSize) && sample.jsHeapUsedSize >= warnBytes) {
      this.warned = true;
      this.emit({
        type: "browser-memory-warning",
        runId: this.runId,
        heapUsedMb: toMegabytes(sample.jsHeapUsedSize),
        heapTotalMb: toMegabytes(sample.jsHeapTotalSize),
        thresholdMb: toMegabytes(warnBytes),
        nodes: sample.nodes,
        documents: sample.documents,
        jsEventListeners: sample.jsEventListeners,
        message:
          `The browser's JS heap reached ${toMegabytes(sample.jsHeapUsedSize)}MB ` +
          `(warn threshold ${toMegabytes(warnBytes)}MB). A Chromium renderer that runs out of memory ` +
          "crashes the page, so consider splitting this case or lowering concurrency.",
        at: now,
      });
    }
    return sample;
  }

  // Compact projection for `telemetry.memory`. Null when nothing was sampled, so
  // a report never shows an empty memory block.
  getMemoryReport() {
    if (!this.samples) {
      return null;
    }
    return {
      samples: this.samples,
      peakJsHeapUsedMb: toMegabytes(this.peakJsHeapUsedSize),
      lastJsHeapUsedMb: toMegabytes(this.lastJsHeapUsedSize),
      jsHeapTotalMb: toMegabytes(this.jsHeapTotalSize),
      peakNodes: this.peakNodes || null,
      warnThresholdMb: toMegabytes(getHeapWarnBytes()),
      warned: this.warned,
      lastSampleError: this.lastSampleError,
    };
  }

  // Compact projection for `telemetry.browserCrash`.
  getCrashReport(atStepIndex = null) {
    if (!this.failure) {
      return null;
    }
    return {
      code: this.failure.code,
      crashKind: this.failure.crashKind,
      message: this.failure.message,
      at: this.failure.at,
      atStepIndex,
      heapUsedMb: this.failure.heapUsedMb,
      peakHeapUsedMb: this.failure.peakHeapUsedMb,
      peakNodes: this.failure.peakNodes,
    };
  }

  dispose() {
    this.disposed = true;
    for (const { target, event, handler } of this.listeners) {
      try {
        target.off?.(event, handler);
      } catch (_error) {
        // best-effort detach
      }
    }
    this.listeners = [];
    // Do not close the CDP session explicitly: on a crashed/closed target that
    // call can park, and the context teardown reclaims it anyway.
    this.cdpSession = null;
  }
}

function createBrowserHealthMonitor(options = {}) {
  return new BrowserHealthMonitor(options);
}

module.exports = {
  BROWSER_OOM_CODE,
  BROWSER_UNAVAILABLE_CODE,
  BrowserHealthMonitor,
  classifyBrowserFailureError,
  createBrowserHealthMonitor,
  getHeapWarnBytes,
  getMemorySampleIntervalMs,
  isBrowserCrashError,
  isBrowserGoneError,
};
