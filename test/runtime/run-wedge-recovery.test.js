const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { run } = require("../../runtime/executor/run-orchestrator");

// REQ-Z12-1 (需求单v3): reproduces the reported freeze — an `openUrl` navigation
// step that never returns — and asserts the run now ends, writes evidence and
// produces a summary instead of hanging forever with no summary.json.

// A page whose probes answer instantly but whose navigation never settles.
function createWedgedPage() {
  return {
    url: () => "http://localhost:8000/demoCostOrder",
    async evaluate() {
      return {
        url: "http://localhost:8000/demoCostOrder",
        title: "cost order",
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
    // The hang: `page.goto` never resolves and never rejects.
    goto() {
      return new Promise(() => {});
    },
    on() {},
    off() {},
    context() {
      return { async storageState() { return {}; } };
    },
  };
}

function navStep(id) {
  return {
    id,
    kind: "openUrl",
    url: "http://localhost:8000/demoCostOrder",
    waitForNav: true,
    timeoutMs: 20000,
    // Pin the wall-clock bound so the test is fast and exact.
    hardTimeoutMs: 150,
    retries: 0,
  };
}

async function withTempOutputDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-wedge-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a run whose navigation step hangs still finishes and writes a summary (Z12-1)", async () => {
  await withTempOutputDir(async (outputDir) => {
    const startedAt = Date.now();
    const events = [];
    const result = await run([navStep("fg-nav-cost2")], {
      page: createWedgedPage(),
      outputDir,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.ok, false);
    const stepFailure = events.find(
      (event) => event.type === "step-complete" && event.status === "failed",
    );
    assert.equal(stepFailure.error.code, "step-hard-timeout");
    assert.match(stepFailure.error.message, /hard timeout/i);
    // The whole point: a summary exists on disk.
    assert.ok(result.evidence.summaryPath, "summary path is reported");
    const summary = JSON.parse(await fs.readFile(result.evidence.summaryPath, "utf8"));
    assert.ok(summary, "summary.json was written");
    assert.equal(result.telemetry.hardTimeouts, 1);
    assert.ok(
      events.some((event) => event.type === "run-complete"),
      "the run reported completion instead of going silent",
    );
    assert.ok(Date.now() - startedAt < 15000, "bounded wall clock, not an infinite hang");
  });
});

test("consecutive hard timeouts trip the wedge breaker; remaining steps stop and the run still summarizes (Z12-1)", async () => {
  await withTempOutputDir(async (outputDir) => {
    const events = [];
    const result = await run(
      [navStep("nav-1"), navStep("nav-2"), navStep("nav-3"), navStep("nav-4")],
      {
        page: createWedgedPage(),
        outputDir,
        // Keep going after a failure so the breaker (not stopOnFailure) decides.
        stopOnFailure: false,
        onEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.ok, false);
    const wedged = events.find((event) => event.type === "run-wedged");
    assert.ok(wedged, "the platform announced the wedge instead of grinding on");
    assert.equal(wedged.reason, "run-wedged");
    // Two steps burned their deadline; the rest were abandoned, not attempted.
    assert.equal(result.telemetry.hardTimeouts, 2);
    assert.equal(result.telemetry.wedged.code, "run-wedged");
    assert.ok(result.evidence.summaryPath, "a wedged run still produces a summary");
  });
});

test("a run-level wall-clock ceiling stops the remaining steps and summarizes (Z12-2)", async () => {
  await withTempOutputDir(async (outputDir) => {
    const result = await run([navStep("nav-1"), navStep("nav-2"), navStep("nav-3")], {
      page: createWedgedPage(),
      outputDir,
      stopOnFailure: false,
      // Budget smaller than a single step deadline -> trips before step 2.
      runTimeoutMs: 50,
    });
    assert.equal(result.telemetry.wedged.code, "run-hard-timeout");
    assert.ok(result.evidence.summaryPath);
  });
});
