const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HardTimeoutError,
  isHardTimeoutError,
  resolveStepHardTimeoutMs,
  withHardTimeout,
} = require("../../runtime/executor/hard-timeout");
const { executeWithRetries } = require("../../runtime/executor/run-orchestrator");

const noWaitPage = { async waitForTimeout() {} };

function okResult(kind = "click") {
  const telemetry = { durationMs: 5, stages: { total: 5 } };
  return {
    ok: true,
    type: kind,
    data: { telemetry, trace: { durationMs: 5 }, evidence: {}, retry: { attempts: 1, retries: 0 } },
    error: null,
    telemetry,
    evidence: {},
  };
}

// --- withHardTimeout -------------------------------------------------------

test("withHardTimeout rejects a never-settling promise with a HardTimeoutError (Z12-1)", async () => {
  const started = Date.now();
  await assert.rejects(
    () => withHardTimeout(() => new Promise(() => {}), 60, { label: "forever" }),
    (error) => {
      assert.ok(error instanceof HardTimeoutError);
      assert.equal(error.code, "step-hard-timeout");
      assert.equal(error.timeoutMs, 60);
      // A hang must NOT be treated as a retryable transient jitter.
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, "the deadline fired instead of waiting forever");
});

test("withHardTimeout passes a fast result straight through", async () => {
  assert.equal(await withHardTimeout(() => Promise.resolve(42), 5000), 42);
});

test("withHardTimeout propagates the real error when the operation rejects first", async () => {
  await assert.rejects(
    () => withHardTimeout(() => Promise.reject(new Error("boom")), 5000),
    /boom/,
  );
});

test("withHardTimeout with a non-positive budget disables the deadline", async () => {
  assert.equal(await withHardTimeout(() => Promise.resolve("x"), 0), "x");
});

test("an abandoned operation that later rejects does not surface as an unhandled rejection", async () => {
  let rejectLater;
  const pending = new Promise((_resolve, reject) => {
    rejectLater = reject;
  });
  await assert.rejects(() => withHardTimeout(() => pending, 30), isHardTimeoutError);
  rejectLater(new Error("late failure"));
  // If the abandoned promise were unguarded, this tick would crash the process.
  await new Promise((resolve) => setTimeout(resolve, 30));
});

// --- resolveStepHardTimeoutMs ---------------------------------------------

test("resolveStepHardTimeoutMs honours an explicit hardTimeoutMs exactly (Z12-1)", () => {
  assert.equal(resolveStepHardTimeoutMs({ timeoutMs: 20000, hardTimeoutMs: 20000 }), 20000);
  assert.equal(resolveStepHardTimeoutMs({ raw: { hardTimeoutMs: 7000 } }), 7000);
});

test("resolveStepHardTimeoutMs derives a bounded budget from the declared waits", () => {
  // A step is a composite of bounded phases, so the derived bound is a multiple
  // of the declared timeout (default 2x) with a floor (default 30s).
  assert.equal(resolveStepHardTimeoutMs({ timeoutMs: 20000 }), 40000);
  assert.equal(resolveStepHardTimeoutMs({ timeoutMs: 5000 }), 30000); // floor wins
  assert.equal(resolveStepHardTimeoutMs({ timeoutMs: 60000 }), 120000);
  // The longest declared wait drives the budget, not just `timeoutMs`.
  assert.equal(resolveStepHardTimeoutMs({ timeoutMs: 5000, navigationTimeoutMs: 90000 }), 180000);
  // Never unbounded, even with no declarations.
  assert.equal(resolveStepHardTimeoutMs({}), 30000);
});

test("resolveStepHardTimeoutMs is capped so no step can declare an unbounded wait", () => {
  assert.equal(resolveStepHardTimeoutMs({ timeoutMs: 10 * 60 * 60 * 1000 }), 600000);
  assert.equal(resolveStepHardTimeoutMs({ hardTimeoutMs: 10 * 60 * 60 * 1000 }), 600000);
});

// --- executeWithRetries integration --------------------------------------

test("a hanging step is force-failed at its hard deadline and yields a usable result (Z12-1)", async () => {
  const saved = [];
  const artifactStore = {
    async saveJson(index, suffix, value) {
      saved.push({ index, suffix, value });
      return `/tmp/step-${index}-${suffix}.json`;
    },
  };
  const startedAt = Date.now();
  const result = await executeWithRetries(
    {
      action: { id: "fg-nav-cost2", index: 60, kind: "openUrl", timeoutMs: 20000, hardTimeoutMs: 120, retries: 0 },
      page: noWaitPage,
      artifactStore,
      signal: null,
    },
    // The reported failure: an openUrl/reload step that never returns.
    () => new Promise(() => {}),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "step-hard-timeout");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.details.hardTimeoutMs, 120);
  assert.equal(result.error.details.declaredTimeoutMs, 20000);
  assert.equal(result.data.retry.hardTimedOut, true);
  assert.equal(result.data.retry.hardTimeoutMs, 120);
  // Evidence: a trace is written even though the step never returned. With
  // retries:0 + the default transient budget, maxAttempts > 1, so the trace uses
  // the same `attempt-N-` prefix executeAction would have used.
  assert.equal(saved.length, 1);
  assert.equal(saved[0].suffix, "attempt-1-trace");
  assert.equal(saved[0].value.errorClassification, "step-hard-timeout");
  assert.equal(result.evidence.tracePath, "/tmp/step-60-attempt-1-trace.json");
  assert.ok(Date.now() - startedAt < 3000, "bounded, not an infinite hang");
});

test("a hard timeout does NOT consume author retries or the transient budget (no deadline stacking)", async () => {
  let calls = 0;
  const result = await executeWithRetries(
    {
      action: { id: "s", index: 1, kind: "click", hardTimeoutMs: 60, retries: 3, retryDelayMs: 1 },
      page: noWaitPage,
      signal: null,
    },
    () => {
      calls += 1;
      return new Promise(() => {});
    },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1, "a hang is terminal for the step — retrying just burns another full deadline");
  assert.equal(result.data.retry.transientRetries, 0);
});

test("a step that finishes inside its hard deadline is unaffected (no regression)", async () => {
  const result = await executeWithRetries(
    { action: { id: "s", index: 1, kind: "click", timeoutMs: 5000, retries: 0 }, page: noWaitPage, signal: null },
    async () => okResult(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.retry.hardTimedOut, false);
});

test("isHardTimeoutError distinguishes a platform hang from an ordinary failure", () => {
  assert.equal(isHardTimeoutError(new HardTimeoutError({ timeoutMs: 1 })), true);
  assert.equal(isHardTimeoutError({ code: "page-probe-hard-timeout" }), true);
  assert.equal(isHardTimeoutError({ code: "expectation-not-met" }), false);
  assert.equal(isHardTimeoutError(null), false);
});
