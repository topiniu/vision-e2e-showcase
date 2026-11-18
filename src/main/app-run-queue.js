"use strict";


const TERMINAL_STATUSES = new Set([
  "completed",
  "passed",
  "failed",
  "timeout",
  "error",
  "stopped",
  // Z13 (需求单v3): explicit caller-driven abort, distinct from a failure.
  "cancelled",
]);
const DEFAULT_RETAIN_FINISHED = 200;
// Z12-2 (需求单v3): a run that reports no event for this long is treated as
// wedged, force-failed, and its slot released. Under maxConcurrent=1 a wedged
// run used to lock every subsequent App-run indefinitely.
const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function createAppRunQueue({
  maxConcurrent = 1,
  dispatch = () => {},
  // Z13: invoked when a *running* run must be torn down (cancel / stall sweep),
  // so the host can abort the in-flight runtime run and tell the panel to stop.
  // Injected (not imported) to keep this module Electron-free and unit-testable.
  onCancel = () => {},
  now = () => Date.now(),
  retainFinished = DEFAULT_RETAIN_FINISHED,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  // v1.11 REQ-Z33: sees every queue event (queued / running / progress /
  // terminal) — how the run board learns about visible App-runs. Injected, and
  // a throwing observer never affects the queue.
  observer = null,
} = {}) {
  const runs = new Map(); // runId -> record (insertion-ordered)
  const queue = []; // runIds waiting for a worker
  const active = new Set(); // runIds currently dispatched
  const finishedOrder = []; // runIds of finished runs, for pruning

  function snapshotRun(record) {
    return {
      runId: record.runId,
      status: record.status,
      testFilePath: record.request?.testFilePath || null,
      scope: record.request?.scope || null,
      caseId: record.request?.caseId || null,
      queuePosition: record.status === "queued" ? queue.indexOf(record.runId) + 1 : 0,
      queuedAt: record.queuedAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      // Z12-2: last time this run produced *any* event. The stall watchdog and
      // any external monitor read liveness from here rather than guessing.
      lastActivityAt: record.lastActivityAt,
      idleMs: isTerminal(record.status) ? 0 : Math.max(0, now() - record.lastActivityAt),
      eventCursor: record.eventSeq,
      result: record.result,
    };
  }

  function appendEvent(record, event) {
    const seq = ++record.eventSeq;
    const enriched = { seq, at: now(), runId: record.runId, ...event };
    record.events.push(enriched);
    record.lastActivityAt = enriched.at;
    for (const fn of Array.from(record.subscribers)) {
      try {
        fn(enriched);
      } catch (_error) {
        // A broken subscriber must never break the run or other subscribers.
      }
    }
    if (typeof observer === "function") {
      try {
        observer(enriched, { request: record.request, queuedAt: record.queuedAt, startedAt: record.startedAt, queuePosition: record.status === "queued" ? queue.indexOf(record.runId) + 1 || queue.length : 0 });
      } catch (_error) {
        // observation only
      }
    }
    return enriched;
  }

  function pruneFinished() {
    while (finishedOrder.length > retainFinished) {
      const runId = finishedOrder.shift();
      const record = runs.get(runId);
      if (record && isTerminal(record.status) && record.subscribers.size === 0) {
        runs.delete(runId);
      }
    }
  }

  function pump() {
    while (active.size < maxConcurrent && queue.length) {
      const runId = queue.shift();
      const record = runs.get(runId);
      if (!record || record.status !== "queued") {
        continue;
      }
      active.add(runId);
      record.status = "running";
      record.startedAt = now();
      appendEvent(record, { type: "running", status: "running" });
      try {
        dispatch(record.request, record);
      } catch (error) {
        finalize(runId, {
          status: "error",
          result: {
            ok: false,
            status: "error",
            externalRunId: runId,
            error: { code: "dispatch-failed", message: error?.message || String(error) },
          },
        });
      }
    }
  }

  function enqueue(request) {
    const runId = request.externalRunId;
    if (!runId) {
      throw new Error("enqueue requires request.externalRunId");
    }
    if (runs.has(runId)) {
      throw new Error(`run ${runId} already exists`);
    }
    const record = {
      runId,
      request,
      status: "queued",
      events: [],
      eventSeq: 0,
      result: null,
      queuedAt: now(),
      startedAt: null,
      finishedAt: null,
      lastActivityAt: now(),
      subscribers: new Set(),
      waiters: [],
    };
    runs.set(runId, record);
    queue.push(runId);
    appendEvent(record, { type: "queued", status: "queued", queuePosition: queue.length });
    pump();
    return snapshotRun(record);
  }

  function finalize(runId, { status, result }) {
    const record = runs.get(runId);
    if (!record || isTerminal(record.status)) {
      return false;
    }
    record.status = status;
    record.result = result || record.result;
    record.finishedAt = now();
    active.delete(runId);
    appendEvent(record, { type: status, status, result: record.result });
    const waiters = record.waiters;
    record.waiters = [];
    for (const resolve of waiters) {
      resolve(record.result);
    }
    finishedOrder.push(runId);
    pruneFinished();
    pump();
    return true;
  }

  // Panel reports success/failure for a run. `result` is the summarized response.
  function complete(runId, result = {}) {
    const status = normalizeStatus(result);
    return finalize(runId, { status, result });
  }

  function fail(runId, error, statusOverride = "failed") {
    const record = runs.get(runId);
    return finalize(runId, {
      status: statusOverride,
      result: {
        ok: false,
        status: statusOverride,
        externalRunId: runId,
        testFilePath: record?.request?.testFilePath || null,
        scope: record?.request?.scope || null,
        caseId: record?.request?.caseId || null,
        error: error && typeof error === "object" ? error : { code: statusOverride, message: String(error || statusOverride) },
      },
    });
  }

  // Z13: force-abort a queued or running run and release its slot. Idempotent —
  // cancelling an already-finished run reports `not-running` instead of erroring,
  // so an unattended caller can fire-and-forget without special-casing races.
  function cancel(runId, { reason = "cancelled-by-request", code = "app-run-cancelled" } = {}) {
    const record = runs.get(runId);
    if (!record) {
      return { ok: false, found: false, cancelled: false, status: "not-found", reason: "not-found" };
    }
    if (isTerminal(record.status)) {
      return { ok: true, found: true, cancelled: false, status: record.status, reason: "not-running" };
    }
    const wasRunning = active.has(runId);
    if (wasRunning) {
      // Tear down the actual work first, then finalize — otherwise the slot is
      // reported free while a runtime run is still driving the browser.
      try {
        onCancel(record, { reason, code });
      } catch (_error) {
        // A failing teardown must not prevent the slot from being released;
        // leaving the run "running" forever is strictly worse.
      }
    } else {
      const position = queue.indexOf(runId);
      if (position >= 0) {
        queue.splice(position, 1);
      }
    }
    finalize(runId, {
      status: "cancelled",
      result: {
        ok: false,
        status: "cancelled",
        externalRunId: runId,
        testFilePath: record.request?.testFilePath || null,
        scope: record.request?.scope || null,
        caseId: record.request?.caseId || null,
        error: { code, message: reason, retriable: false },
      },
    });
    return { ok: true, found: true, cancelled: true, status: "cancelled", wasRunning, wasQueued: !wasRunning };
  }

  // Z12-2: sweep for wedged runs. A run that has produced no event for
  // `stallTimeoutMs` is force-failed and its slot released, so a single frozen
  // run can no longer lock the (serial) queue. Called on an interval by the host;
  // `now` is injected so this stays deterministic in tests.
  function sweepStalled({ stallMs = stallTimeoutMs } = {}) {
    if (!Number.isFinite(stallMs) || stallMs <= 0) {
      return [];
    }
    const at = now();
    const swept = [];
    for (const runId of Array.from(active)) {
      const record = runs.get(runId);
      if (!record || isTerminal(record.status)) {
        continue;
      }
      const idleMs = at - record.lastActivityAt;
      if (idleMs < stallMs) {
        continue;
      }
      try {
        onCancel(record, { reason: "app-run-stalled", code: "app-run-stalled" });
      } catch (_error) {
        // best-effort teardown; the slot is released regardless
      }
      finalize(runId, {
        status: "failed",
        result: {
          ok: false,
          status: "failed",
          externalRunId: runId,
          testFilePath: record.request?.testFilePath || null,
          scope: record.request?.scope || null,
          caseId: record.request?.caseId || null,
          error: {
            code: "app-run-stalled",
            message:
              `Run produced no event for ${idleMs}ms (stall threshold ${stallMs}ms). ` +
              "The platform force-failed it and released the queue slot.",
            retriable: true,
          },
        },
      });
      swept.push({ runId, idleMs });
    }
    return swept;
  }

  // Z12-2: pure liveness signal — refresh the idle clock WITHOUT appending to the
  // event log. The stall watchdog must distinguish "wedged" from "busy", and a
  // busy run can emit thousands of engine events; logging them all would bloat
  // the SSE replay buffer for every retained run. So the host touches on every
  // engine event and only appends real milestones via `appendProgress`.
  function touch(runId) {
    const record = runs.get(runId);
    if (!record || isTerminal(record.status)) {
      return false;
    }
    record.lastActivityAt = now();
    return true;
  }

  // Panel-pushed progress (per-case / per-step milestones). Does not finalize.
  function appendProgress(runId, event = {}) {
    const record = runs.get(runId);
    if (!record || isTerminal(record.status)) {
      return null;
    }
    return appendEvent(record, { type: "progress", ...event });
  }

  function normalizeStatus(result) {
    if (result && typeof result.status === "string" && result.status) {
      if (result.status === "busy") {
        return "error";
      }
      return result.status;
    }
    return result && result.ok === false ? "failed" : "completed";
  }

  function getRun(runId) {
    const record = runs.get(runId);
    return record ? snapshotRun(record) : null;
  }

  function getEventsSince(runId, cursor = 0) {
    const record = runs.get(runId);
    if (!record) {
      return null;
    }
    const from = Number.isFinite(cursor) ? cursor : 0;
    return record.events.filter((event) => event.seq > from);
  }

  function subscribe(runId, fn) {
    const record = runs.get(runId);
    if (!record) {
      return () => {};
    }
    record.subscribers.add(fn);
    return () => {
      record.subscribers.delete(fn);
    };
  }

  function wait(runId) {
    const record = runs.get(runId);
    if (!record) {
      return Promise.resolve(null);
    }
    if (isTerminal(record.status)) {
      return Promise.resolve(record.result);
    }
    return new Promise((resolve) => {
      record.waiters.push(resolve);
    });
  }

  function queueSnapshot() {
    const all = Array.from(runs.values());
    return {
      maxConcurrent,
      // Z12-2/Z13: self-describe the freeze protections so an unattended caller
      // can discover them from the same GET it already polls.
      stallTimeoutMs: stallTimeoutMs,
      cancelSupported: true,
      activeCount: active.size,
      queuedCount: queue.length,
      active: Array.from(active).map((runId) => snapshotRun(runs.get(runId))).filter(Boolean),
      queued: queue.map((runId) => snapshotRun(runs.get(runId))).filter(Boolean),
      recent: all.filter((record) => isTerminal(record.status)).slice(-20).map(snapshotRun),
    };
  }

  function has(runId) {
    return runs.has(runId);
  }

  return {
    enqueue,
    complete,
    fail,
    cancel,
    sweepStalled,
    touch,
    appendProgress,
    getRun,
    getEventsSince,
    subscribe,
    wait,
    queueSnapshot,
    has,
    isTerminal,
  };
}

module.exports = { createAppRunQueue, isTerminal };
