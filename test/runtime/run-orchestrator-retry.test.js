const test = require("node:test");
const assert = require("node:assert/strict");
const { executeWithRetries } = require("../../runtime/executor/run-orchestrator");

function createAttemptResult({ ok, durationMs, tracePath, error = null }) {
  return {
    ok,
    type: "click",
    data: {
      telemetry: {
        durationMs,
        stages: {
          performAction: durationMs,
          total: durationMs,
        },
      },
      trace: { durationMs },
      evidence: { tracePath },
      retry: { attempts: 1, retries: 0 },
    },
    error,
    telemetry: {
      durationMs,
      stages: {
        performAction: durationMs,
        total: durationMs,
      },
    },
    evidence: { tracePath },
  };
}

test("executeWithRetries keeps per-attempt evidence and reports cumulative duration", async () => {
  const calls = [];
  const waits = [];
  const result = await executeWithRetries({
    action: {
      retries: 1,
      retryDelayMs: 50,
    },
    page: {
      async waitForTimeout(timeoutMs) {
        waits.push(timeoutMs);
      },
    },
    signal: null,
  }, async (context) => {
    calls.push(context.artifactAttempt);
    if (calls.length === 1) {
      return createAttemptResult({
        ok: false,
        durationMs: 100,
        tracePath: "/tmp/01-attempt-1-trace.json",
        error: { code: "expectation-not-met", message: "first attempt failed" },
      });
    }
    return createAttemptResult({
      ok: true,
      durationMs: 200,
      tracePath: "/tmp/01-attempt-2-trace.json",
    });
  });

  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(waits, [50]);
  assert.equal(result.ok, true);
  assert.equal(result.telemetry.durationMs, 350);
  assert.equal(result.telemetry.stages.performAction, 300);
  assert.equal(result.telemetry.stages.retryDelay, 50);
  assert.equal(result.data.retry.attempts, 2);
  assert.equal(result.data.retry.retries, 1);
  assert.equal(result.data.retry.totalDurationMs, 350);
  assert.equal(result.evidence.tracePath, "/tmp/01-attempt-2-trace.json");
  assert.deepEqual(result.evidence.attempts.map((item) => item.tracePath), [
    "/tmp/01-attempt-1-trace.json",
    "/tmp/01-attempt-2-trace.json",
  ]);
});
