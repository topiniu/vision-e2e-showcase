"use strict";


const STEP_HARD_TIMEOUT_CODE = "step-hard-timeout";
const PROBE_HARD_TIMEOUT_CODE = "page-probe-hard-timeout";

function readEnvNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// A single page probe (one `page.evaluate` / `page.screenshot`) never
// legitimately takes this long; past it the renderer is wedged, not slow.
function getProbeHardTimeoutMs() {
  return readEnvNumber("ZHUZHU_PROBE_HARD_TIMEOUT_MS", 20_000);
}

// A step is a *composite* of bounded phases (settle -> before-snapshot ->
// resolve -> action -> navigation observation -> expectation -> evidence), and
// several of them are each allowed to consume the declared `timeoutMs`. So the
// step-level hard deadline is a multiple of the declared budget, not equal to
// it. Authors who want an exact bound declare `hardTimeoutMs` on the step.
function getStepHardTimeoutMultiplier() {
  return Math.max(1, readEnvNumber("ZHUZHU_STEP_HARD_TIMEOUT_MULTIPLIER", 2));
}

function getStepHardTimeoutFloorMs() {
  return readEnvNumber("ZHUZHU_STEP_HARD_TIMEOUT_FLOOR_MS", 30_000);
}

function getStepHardTimeoutCeilingMs() {
  return readEnvNumber("ZHUZHU_STEP_HARD_TIMEOUT_MAX_MS", 600_000);
}

class HardTimeoutError extends Error {
  constructor({ code = STEP_HARD_TIMEOUT_CODE, timeoutMs = 0, label = "operation", detail = null } = {}) {
    super(
      `Hard timeout after ${timeoutMs}ms: ${label} did not settle. ` +
        "The operation was abandoned so the run could continue.",
    );
    this.name = "HardTimeoutError";
    this.code = code;
    this.timeoutMs = timeoutMs;
    this.label = label;
    this.detail = detail;
    this.hardTimeout = true;
    // A hang is NOT a transient jitter: retrying it just burns another full
    // deadline. Keep it out of the Z04 self-heal budget.
    this.retryable = false;
  }
}

function isHardTimeoutError(error) {
  return Boolean(error && (error.hardTimeout === true || error.code === STEP_HARD_TIMEOUT_CODE || error.code === PROBE_HARD_TIMEOUT_CODE));
}

// Wraps `operation` (a promise, or a factory returning one) in a wall-clock
// deadline. `timeoutMs <= 0` disables the deadline (pass-through).
function withHardTimeout(operation, timeoutMs, { code = STEP_HARD_TIMEOUT_CODE, label = "operation", detail = null, signal = null } = {}) {
  let started;
  try {
    started = typeof operation === "function" ? operation() : operation;
  } catch (error) {
    // A factory that throws synchronously must still surface as a rejection, so
    // every caller can rely on a single `await ... catch` shape.
    return Promise.reject(error);
  }
  const budgetMs = Number(timeoutMs);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return Promise.resolve(started);
  }
  const pending = Promise.resolve(started);
  return new Promise((resolve, reject) => {
    let settled = false;
    const detach = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      const error = new Error("The awaited operation was abandoned.");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      detach();
      // Do not await the abandoned operation — swallow whatever it eventually
      // does so it cannot surface as an unhandled rejection later.
      pending.then(
        () => {},
        () => {},
      );
      reject(new HardTimeoutError({ code, timeoutMs: budgetMs, label, detail }));
    }, budgetMs);
    // This deadline owns an awaited operation and must keep CLI runs alive.
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    pending.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        detach();
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        detach();
        reject(error);
      },
    );
  });
}

// Bounds a single page probe. Returns `fallback` instead of throwing when the
// probe is a best-effort read (snapshots, readiness polls) — a wedged renderer
// must degrade the evidence, not park the run.
//
// v1.8: `fallback` is now actually implemented. Until then this comment
// described a contract the function did not have, and every caller therefore
// got the throwing behaviour whether it wanted it or not. Opting in is explicit
// (the sentinel below distinguishes "no fallback given" from `fallback:
// undefined`), so existing callers that rely on the throw — `capturePageState`
// and friends, asserted in page-probe-timeout.test.js — are unchanged.
const NO_FALLBACK = Symbol("no-fallback");

async function withProbeTimeout(
  operation,
  { label = "page-probe", timeoutMs = null, fallback = NO_FALLBACK } = {},
) {
  try {
    return await withHardTimeout(operation, timeoutMs ?? getProbeHardTimeoutMs(), {
      code: PROBE_HARD_TIMEOUT_CODE,
      label,
    });
  } catch (error) {
    // Only this bound's own expiry degrades to the fallback. A *step* deadline
    // travelling through must keep travelling — swallowing it here would hide
    // the very thing the step layer needs to see.
    if (fallback !== NO_FALLBACK && error?.code === PROBE_HARD_TIMEOUT_CODE) {
      return fallback;
    }
    throw error;
  }
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// The hard deadline for one step attempt. Explicit `hardTimeoutMs` wins (exact
// control for authors); otherwise it is derived from every wait the step
// declares, so a step that legitimately declares long waits gets a long bound.
function resolveStepHardTimeoutMs(action = {}) {
  const explicit = toPositiveNumber(action.hardTimeoutMs ?? action.raw?.hardTimeoutMs);
  const ceiling = getStepHardTimeoutCeilingMs();
  if (explicit) {
    return Math.min(explicit, ceiling);
  }
  const declared = Math.max(
    toPositiveNumber(action.timeoutMs),
    toPositiveNumber(action.navigationTimeoutMs),
    toPositiveNumber(action.waitForChangeTimeoutMs),
    toPositiveNumber(action.optionWaitTimeoutMs),
    toPositiveNumber(action.settleMaxMs),
    toPositiveNumber(action.stabilizationDelayMs),
    toPositiveNumber(action.expectation?.timeoutMs),
    5_000,
  );
  const budget = declared * getStepHardTimeoutMultiplier();
  return Math.min(Math.max(budget, getStepHardTimeoutFloorMs()), ceiling);
}

module.exports = {
  HardTimeoutError,
  PROBE_HARD_TIMEOUT_CODE,
  STEP_HARD_TIMEOUT_CODE,
  getProbeHardTimeoutMs,
  isHardTimeoutError,
  resolveStepHardTimeoutMs,
  withHardTimeout,
  withProbeTimeout,
};
