"use strict";


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { run } = require("../../runtime/executor/run-orchestrator");
const {
  classifyBrowserFailureError,
  createBrowserHealthMonitor,
} = require("../../runtime/executor/browser-health");
const { createDiagnosis } = require("../../runtime/server/diagnosis");

const URL = "http://localhost:8000/app";

async function withTempOutputDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-oom-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A page whose probes answer instantly, whose `goto` behavior is configurable,
// and which lets a test fire Playwright's real page events.
function createCrashablePage({
  gotoMode = "ok", // "ok" | "hang" | "crash-error"
  metrics = null,
  cdpHangs = false,
  noCdp = false,
} = {}) {
  const handlers = new Map();
  const gotoCalls = [];
  const page = {
    url: () => URL,
    isClosed: () => false,
    async evaluate() {
      return {
        url: URL,
        title: "app",
        text: "",
        interactables: [],
        viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
        antd: { detected: false, confidence: 0, versionHint: null, components: [], signals: {} },
      };
    },
    async waitForTimeout() {},
    async waitForLoadState() {},
    async screenshot() {
      return Buffer.alloc(0);
    },
    goto() {
      gotoCalls.push(Date.now());
      if (gotoMode === "hang") {
        // What a dead renderer does to a step: never settles, never rejects.
        return new Promise(() => {});
      }
      if (gotoMode === "crash-error") {
        // What Playwright does when a crash beats our own listener.
        return Promise.reject(new Error("Target crashed"));
      }
      return Promise.resolve(null);
    },
    on(event, handler) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event).push(handler);
    },
    off(event, handler) {
      const list = handlers.get(event) || [];
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
    context() {
      return {
        async storageState() {
          return {};
        },
        browser() {
          return { on() {}, off() {} };
        },
        ...(noCdp
          ? {}
          : {
              async newCDPSession() {
                return {
                  async send(method) {
                    if (cdpHangs) {
                      // The watchdog must never become a new source of the very
                      // freeze it exists to report.
                      return new Promise(() => {});
                    }
                    if (method === "Performance.getMetrics") {
                      return { metrics: metrics ? metrics() : [] };
                    }
                    return {};
                  },
                };
              },
            }),
      };
    },
    // --- test hooks ---
    __emit(event, payload) {
      for (const handler of [...(handlers.get(event) || [])]) {
        handler(payload);
      }
    },
    __listenerCount(event) {
      return (handlers.get(event) || []).length;
    },
    __gotoCalls: gotoCalls,
  };
  return page;
}

function navStep(id, { hardTimeoutMs = 20_000, retries = 0 } = {}) {
  return { id, kind: "openUrl", url: URL, waitForNav: true, timeoutMs: 5_000, hardTimeoutMs, retries };
}

const heapMetrics = (usedMb, { nodes = 1_000 } = {}) => () => [
  { name: "JSHeapUsedSize", value: usedMb * 1024 * 1024 },
  { name: "JSHeapTotalSize", value: (usedMb + 64) * 1024 * 1024 },
  { name: "Nodes", value: nodes },
  { name: "Documents", value: 3 },
  { name: "JSEventListeners", value: 42 },
];

// --- the freeze itself ------------------------------------------------------

test("a renderer crash fails the in-flight step in milliseconds instead of burning its hard deadline", async () => {
  await withTempOutputDir(async (outputDir) => {
    const page = createCrashablePage({ gotoMode: "hang" });
    const events = [];
    // A generous per-step deadline: without crash detection the only way out is
    // this deadline, and the wedge breaker needs two of them.
    const HARD_TIMEOUT_MS = 20_000;

    const startedAt = Date.now();
    const runPromise = run(
      [navStep("s1", { hardTimeoutMs: HARD_TIMEOUT_MS }), navStep("s2", { hardTimeoutMs: HARD_TIMEOUT_MS })],
      { page, outputDir, onEvent: (event) => events.push(event) },
    );
    // Crash once the run is actually inside the first step.
    setTimeout(() => page.__emit("crash"), 150);
    const result = await runPromise;
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed < HARD_TIMEOUT_MS / 2,
      `the run must end on the crash signal, not on the deadline (took ${elapsed}ms, deadline ${HARD_TIMEOUT_MS}ms)`,
    );
    assert.equal(result.ok, false);
    // Run-level attribution: NOT batch-partial-failure, NOT step-hard-timeout.
    assert.equal(result.error.code, "browser-oom");
    assert.match(result.error.message, /browser died/i);

    const steps = result.data.results;
    // The in-flight step is blamed on the crash...
    assert.equal(steps[0].error.code, "browser-oom");
    assert.equal(steps[0].data.retry.browserCrashed, true);
    assert.equal(steps[0].data.retry.hardTimedOut, false);
    // ...and the rest are stopped rather than each burning a deadline.
    assert.equal(steps[1].stopped, true);

    // Telemetry lets a report reader tell "the browser died" from "slow page".
    assert.equal(result.telemetry.browserCrash.code, "browser-oom");
    assert.equal(result.telemetry.browserCrash.crashKind, "renderer-crash");
    assert.equal(result.telemetry.hardTimeouts, 0, "a crash is not a timeout");

    // The evidence trail survives (v1.3's guarantee still holds).
    await fs.access(result.evidence.summaryPath);
    await fs.access(result.evidence.reportPath);

    // The crash is announced exactly once, and the run still completes.
    const crashEvents = events.filter((event) => event.type === "browser-crashed");
    assert.equal(crashEvents.length, 1);
    assert.equal(crashEvents[0].crashKind, "renderer-crash");
    assert.equal(events.at(-1).type, "run-complete");
  });
});

test("a crash never consumes the author's retries (retrying a dead page only burns another deadline)", async () => {
  await withTempOutputDir(async (outputDir) => {
    const page = createCrashablePage({ gotoMode: "hang" });
    const promise = run([navStep("s1", { hardTimeoutMs: 15_000, retries: 3 })], { page, outputDir });
    setTimeout(() => page.__emit("crash"), 150);
    const result = await promise;

    assert.equal(result.ok, false);
    assert.equal(page.__gotoCalls.length, 1, "exactly one attempt: the crash is terminal for the step");
    assert.equal(result.data.results[0].data.retry.attempts, 1);
    assert.equal(result.data.results[0].data.retry.browserCrashed, true);
  });
});

test("a crash between two steps stops the run without touching the page again", async () => {
  await withTempOutputDir(async (outputDir) => {
    const page = createCrashablePage({ gotoMode: "ok" });
    // Crash in the gap between step 1 finishing and step 2 starting — the case
    // where the *page*, not the step, is what died.
    const result = await run([navStep("s1"), navStep("s2"), navStep("s3")], {
      page,
      outputDir,
      onEvent: (event) => {
        if (event.type === "step-complete" && event.stepId === "s1") {
          page.__emit("crash");
        }
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "browser-oom");
    assert.equal(result.data.results[0].ok, true, "the step that already finished keeps its result");
    assert.equal(result.data.results[1].stopped, true);
    assert.equal(result.data.results[2].stopped, true);
    assert.equal(page.__gotoCalls.length, 1, "no navigation is attempted on a page known to be dead");
  });
});

test("a crash that surfaces only as a thrown error still takes the crash path", async () => {
  await withTempOutputDir(async (outputDir) => {
    const page = createCrashablePage({ gotoMode: "crash-error" });
    const result = await run([navStep("s1", { retries: 2 }), navStep("s2")], { page, outputDir });

    assert.equal(result.error.code, "browser-oom");
    assert.equal(page.__gotoCalls.length, 1, "not retried against a crashed target");
    assert.equal(result.data.results[0].data.retry.browserCrashed, true);
    assert.equal(result.data.results[1].stopped, true);
  });
});

// --- the other ways a browser can die (must NOT be called OOM) --------------

test("a closed page is reported as browser-unavailable, not as an OOM crash", async () => {
  await withTempOutputDir(async (outputDir) => {
    const page = createCrashablePage({ gotoMode: "hang" });
    const promise = run([navStep("s1", { hardTimeoutMs: 20_000 })], { page, outputDir });
    setTimeout(() => page.__emit("close"), 150);
    const result = await promise;

    assert.equal(result.error.code, "browser-unavailable", "a closed tab must not claim OOM");
    assert.equal(result.telemetry.browserCrash.crashKind, "page-closed");
  });
});

test("the health monitor classifies a thrown 'Target crashed' error as OOM, and ordinary failures as neither", () => {
  assert.equal(classifyBrowserFailureError(new Error("Page crashed")).code, "browser-oom");
  assert.equal(classifyBrowserFailureError(new Error("Target crashed")).code, "browser-oom");
  assert.equal(
    classifyBrowserFailureError(new Error("Target page, context or browser has been closed")).code,
    "browser-unavailable",
  );
  // Ordinary failures must NOT be mistaken for a dead browser.
  assert.equal(classifyBrowserFailureError(new Error("locator not found")), null);
  assert.equal(classifyBrowserFailureError(new Error("Expected true but got false")), null);
});

// --- the memory watchdog ----------------------------------------------------

test("JS heap is sampled between steps and the peak lands in telemetry", async () => {
  const previous = process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS;
  process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS = "0";
  try {
    await withTempOutputDir(async (outputDir) => {
      let usedMb = 200;
      const page = createCrashablePage({
        metrics: () => {
          usedMb += 300;
          return heapMetrics(usedMb, { nodes: usedMb * 10 })();
        },
      });
      const result = await run([navStep("s1"), navStep("s2"), navStep("s3")], { page, outputDir });

      assert.equal(result.ok, true);
      assert.ok(result.telemetry.memory, "memory telemetry is present when demo works");
      assert.ok(result.telemetry.memory.samples >= 2);
      assert.ok(
        result.telemetry.memory.peakJsHeapUsedMb >= result.telemetry.memory.lastJsHeapUsedMb,
        "peak is a peak",
      );
      assert.ok(result.telemetry.memory.peakNodes > 0);
      assert.equal(result.telemetry.browserCrash, null, "demo alone never fails a run");
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS;
    } else {
      process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS = previous;
    }
  }
});

test("the crash report carries the heap reading taken BEFORE the browser died", async () => {
  // The reading that matters ("the heap right before it died") only exists if it
  // was taken while the page was still alive — a dead renderer answers nothing.
  // This is why demo happens before each step, not after.
  const previous = process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS;
  process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS = "0";
  try {
    await withTempOutputDir(async (outputDir) => {
      const page = createCrashablePage({ gotoMode: "hang", metrics: heapMetrics(1900, { nodes: 184_000 }) });
      // Trigger only after the first pre-step sample. A wall-clock 150ms timer
      // can fire before startup finishes when the whole test suite is busy.
      const result = await run([navStep("s1", { hardTimeoutMs: 20_000 }), navStep("s2")], {
        page, outputDir,
        onEvent: (event) => {
          if (event.type === "step-start" && event.stepIndex === 0) {
            setTimeout(() => page.__emit("crash"), 0);
          }
        },
      });

      assert.equal(result.telemetry.browserCrash.heapUsedMb, 1900, "the pre-crash heap survives the crash");
      assert.equal(result.telemetry.browserCrash.peakNodes, 184_000);
      assert.equal(result.error.details.peakHeapUsedMb, 1900);
      assert.match(result.error.message, /Peak JS heap 1900MB/);
      // And the failed step's own error carries it too, so it reaches report.md.
      assert.match(result.data.results[0].error.message, /1900MB/);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS;
    } else {
      process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS = previous;
    }
  }
});

test("the memory warning fires on the threshold crossing only, not on every sample", async () => {
  const previousWarn = process.env.ZHUZHU_BROWSER_HEAP_WARN_MB;
  process.env.ZHUZHU_BROWSER_HEAP_WARN_MB = "100";
  try {
    const events = [];
    const page = createCrashablePage({ metrics: heapMetrics(512) });
    const monitor = createBrowserHealthMonitor({ page, onEvent: (event) => events.push(event), runId: "r1" });
    for (let index = 0; index < 5; index += 1) {
      await monitor.sampleMemory({ force: true });
    }
    const warnings = events.filter((event) => event.type === "browser-memory-warning");
    assert.equal(warnings.length, 1, "one warning for five over-threshold samples");
    assert.equal(warnings[0].heapUsedMb, 512);
    assert.equal(warnings[0].thresholdMb, 100);
    assert.equal(monitor.getMemoryReport().samples, 5);
    assert.equal(monitor.getMemoryReport().warned, true);
    monitor.dispose();
  } finally {
    if (previousWarn === undefined) {
      delete process.env.ZHUZHU_BROWSER_HEAP_WARN_MB;
    } else {
      process.env.ZHUZHU_BROWSER_HEAP_WARN_MB = previousWarn;
    }
  }
});

test("a hanging CDP memory probe is bounded and cannot slow the run down", async () => {
  const previousProbe = process.env.ZHUZHU_PROBE_HARD_TIMEOUT_MS;
  const previousInterval = process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS;
  process.env.ZHUZHU_PROBE_HARD_TIMEOUT_MS = "120";
  process.env.ZHUZHU_BROWSER_MEMORY_SAMPLE_MS = "0";
  try {
    await withTempOutputDir(async (outputDir) => {
      const page = createCrashablePage({ cdpHangs: true });
      const startedAt = Date.now();
      const result = await run([navStep("s1"), navStep("s2")], { page, outputDir });
      // The watchdog must not become the freeze: bounded by the probe deadline,
      // and it never fails the run.
      assert.equal(result.ok, true);
      assert.equal(result.telemetry.browserCrash, null);
      assert.equal(result.telemetry.memory, null, "a probe that never answers yields no telemetry");
      assert.ok(Date.now() - startedAt < 10_000, "a parked memory probe does not park the run");
    });
  } finally {
    for (const [key, value] of [
      ["ZHUZHU_PROBE_HARD_TIMEOUT_MS", previousProbe],
      ["ZHUZHU_BROWSER_MEMORY_SAMPLE_MS", previousInterval],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("a page without CDP support runs normally with no memory telemetry", async () => {
  await withTempOutputDir(async (outputDir) => {
    const page = createCrashablePage({ noCdp: true });
    const result = await run([navStep("s1")], { page, outputDir });
    assert.equal(result.ok, true);
    assert.equal(result.telemetry.memory, null, "absent rather than an empty block");
  });
});

// --- the monitor's own hygiene ----------------------------------------------

test("the monitor detaches its listeners on dispose and keeps the first cause", async () => {
  const page = createCrashablePage();
  const monitor = createBrowserHealthMonitor({ page, runId: "r1" });
  assert.equal(page.__listenerCount("crash"), 1);
  assert.equal(page.__listenerCount("close"), 1);

  page.__emit("crash");
  // A crash is normally followed by a close — the original cause must survive,
  // otherwise an OOM would be reported as a plain "page closed".
  page.__emit("close");
  assert.equal(monitor.getFailure().code, "browser-oom");
  assert.equal(monitor.getFailure().crashKind, "renderer-crash");
  assert.equal(monitor.isUnhealthy(), true);
  assert.deepEqual(await monitor.waitForFailure(), monitor.getFailure());

  monitor.dispose();
  assert.equal(page.__listenerCount("crash"), 0);
  assert.equal(page.__listenerCount("close"), 0);
});

// --- reporting attribution ---------------------------------------------------

test("diagnosis reports an OOM crash as browser-oom with memory-shaped fix hints", () => {
  const diagnosis = createDiagnosis({
    ok: false,
    type: "batch",
    data: {
      results: [
        {
          ok: false,
          index: 7,
          input: { id: "s8" },
          error: { code: "browser-oom", message: "The browser died during this run (renderer-crash)." },
        },
      ],
    },
  });
  assert.equal(diagnosis.status, "failed");
  assert.equal(diagnosis.failureType, "browser-oom");
  assert.match(diagnosis.fixHints.join(" "), /out of memory/i);
  assert.match(diagnosis.fixHints.join(" "), /Split the case/i);
  // The pre-v1.4 shape: a crash arriving as a hard timeout is NOT classified as
  // an OOM — which is exactly why the report used to blame the test case.
  const asTimeout = createDiagnosis({
    ok: false,
    type: "batch",
    data: {
      results: [{ ok: false, index: 7, input: { id: "s8" }, error: { code: "step-hard-timeout", message: "..." } }],
    },
  });
  assert.notEqual(asTimeout.failureType, "browser-oom");
});
