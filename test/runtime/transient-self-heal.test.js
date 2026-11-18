const test = require("node:test");
const assert = require("node:assert/strict");
const { isTransientError } = require("../../runtime/executor/transient-errors");
const { executeWithRetries } = require("../../runtime/executor/run-orchestrator");

function createAttemptResult({ ok, durationMs = 10, tracePath = "/tmp/t.json", error = null }) {
  return {
    ok,
    type: "click",
    data: { telemetry: { durationMs, stages: { performAction: durationMs, total: durationMs } }, trace: { durationMs }, evidence: { tracePath }, retry: { attempts: 1, retries: 0 } },
    error,
    telemetry: { durationMs, stages: { performAction: durationMs, total: durationMs } },
    evidence: { tracePath },
  };
}

const noWaitPage = { async waitForTimeout() {} };

test("isTransientError matches known jitter signatures (Z04)", () => {
  assert.equal(isTransientError({ message: "page.screenshot: waiting for fonts" }), true);
  assert.equal(isTransientError({ message: "Execution context was destroyed, most likely because of a navigation" }), true);
  assert.equal(isTransientError({ code: "no-progress", message: "页面冻死: 0 步无进度" }), true);
  assert.equal(isTransientError({ message: "页面冻死" }), true);
  assert.equal(isTransientError({ retryable: true, message: "whatever" }), true);
  assert.equal(isTransientError({ code: "target-closed" }), true);
});

test("isTransientError does not match real assertion failures (Z04)", () => {
  assert.equal(isTransientError({ code: "expectation-not-met", message: "expected 5 got 3" }), false);
  assert.equal(isTransientError({ code: "target-missing", message: "no element" }), false);
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError({ message: "" }), false);
});

test("platform self-heals a transient jitter beyond author retries and marks selfHealed (Z04-1/Z04-2)", async () => {
  let calls = 0;
  const result = await executeWithRetries(
    { action: { retries: 0, retryDelayMs: 10 }, page: noWaitPage, signal: null },
    async () => {
      calls += 1;
      if (calls === 1) {
        return createAttemptResult({ ok: false, error: { message: "page.screenshot: waiting for fonts" } });
      }
      return createAttemptResult({ ok: true });
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 2); // author retries=0, but platform retried the transient once
  assert.equal(result.data.retry.transientRetries, 1);
  assert.equal(result.data.retry.selfHealed, true);
  assert.equal(result.data.retry.transientErrors.length, 1);
});

test("a real (non-transient) failure is NOT self-healed (Z04-2 distinguish real failures)", async () => {
  let calls = 0;
  const result = await executeWithRetries(
    { action: { retries: 0, retryDelayMs: 10 }, page: noWaitPage, signal: null },
    async () => {
      calls += 1;
      return createAttemptResult({ ok: false, error: { code: "expectation-not-met", message: "expected 5 got 3" } });
    },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1); // no author retries, non-transient -> no extra attempts
  assert.equal(result.data.retry.transientRetries, 0);
  assert.equal(result.data.retry.selfHealed, false);
});

test("transient self-heal budget is bounded; persistent transient still fails (Z04)", async () => {
  let calls = 0;
  const result = await executeWithRetries(
    { action: { retries: 0, retryDelayMs: 1 }, page: noWaitPage, signal: null },
    async () => {
      calls += 1;
      return createAttemptResult({ ok: false, error: { message: "page.screenshot: waiting for fonts" } });
    },
  );
  assert.equal(result.ok, false);
  // 1 initial + TRANSIENT_RETRY_BUDGET (default 2) = 3 attempts, then give up.
  assert.equal(calls, 3);
  assert.equal(result.data.retry.transientRetries, 2);
  assert.equal(result.data.retry.selfHealed, false);
});

test("author retries and transient budget compose (Z04)", async () => {
  let calls = 0;
  const result = await executeWithRetries(
    { action: { retries: 1, retryDelayMs: 1 }, page: noWaitPage, signal: null },
    async () => {
      calls += 1;
      // attempt 1: non-transient (uses author retry), attempt 2: transient, attempt 3: pass
      if (calls === 1) return createAttemptResult({ ok: false, error: { code: "expectation-not-met" } });
      if (calls === 2) return createAttemptResult({ ok: false, error: { message: "waiting for fonts" } });
      return createAttemptResult({ ok: true });
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(result.data.retry.authorRetries, 1);
  assert.equal(result.data.retry.transientRetries, 1);
  assert.equal(result.data.retry.selfHealed, true);
});
