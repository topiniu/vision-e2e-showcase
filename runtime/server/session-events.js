"use strict";


const DEFAULT_BUFFER_SIZE = Math.max(50, Number(process.env.ZHUZHU_SESSION_EVENT_BUFFER ?? 500));

// Event types worth streaming. `run()` emits more than this (memory samples,
// page errors); those are useful in the report but would make the stream noisy
// for a progress consumer, so they are counted rather than streamed.
const STREAMED_TYPES = new Set([
  "run-start",
  "step-start",
  "step-complete",
  "run-complete",
  "run-wedged",
  "recovery-start",
  "recovery-complete",
  "recovery-skipped",
  "browser-crashed",
  "download-captured",
  "checkpoint-saved",
]);

const TERMINAL_TYPES = new Set(["session-complete"]);

class SessionEventBus {
  constructor({ sessionId, bufferSize = DEFAULT_BUFFER_SIZE } = {}) {
    this.sessionId = sessionId;
    // Floor of 2 only guards against 0/negative. A higher floor would silently
    // ignore an explicit bound the caller chose, which is a surprise that costs
    // debugging time for no safety benefit.
    this.bufferSize = Math.max(2, Number(bufferSize) || DEFAULT_BUFFER_SIZE);
    this.events = [];
    this.dropped = 0;
    this.seq = 0;
    this.subscribers = new Set();
    this.terminal = null;
    // Set when the terminal event arrives, so a finished session's budget stops
    // moving (see `getBudget`).
    this.finishedAt = null;
    // Z-N budget accounting. Accumulated from the events the runs emit, so it
    // costs nothing extra and cannot disagree with the report.
    this.budget = {
      startedAt: Date.now(),
      wallMs: 0,
      steps: 0,
      retries: 0,
      transientRetries: 0,
      hardTimeouts: 0,
      browserRestarts: 0,
      pageErrors: 0,
      downloads: 0,
      runs: 0,
    };
  }

  publish(event) {
    if (!event || typeof event !== "object") {
      return null;
    }
    this.accrue(event);
    if (!STREAMED_TYPES.has(event.type) && !TERMINAL_TYPES.has(event.type)) {
      return null;
    }
    this.seq += 1;
    const enriched = { ...event, seq: this.seq, sessionId: this.sessionId, at: event.at ?? Date.now() };
    this.events.push(enriched);
    // Drop the oldest, never the terminal event: a late subscriber must still be
    // able to learn that the session ended.
    while (this.events.length > this.bufferSize) {
      const oldest = this.events.findIndex((item) => !TERMINAL_TYPES.has(item.type));
      if (oldest < 0) {
        break;
      }
      this.events.splice(oldest, 1);
      this.dropped += 1;
    }
    if (TERMINAL_TYPES.has(event.type)) {
      this.terminal = enriched;
      // Freeze the clock. Without this, `getBudget()` on a FINISHED session keeps
      // growing `elapsedMs` with wall time, so polling the budget route ten
      // minutes later reports ten extra minutes the session never spent — and the
      // whole point of Z-N is that these numbers can be settled against.
      this.finishedAt = enriched.at;
    }
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(enriched);
      } catch (_error) {
        // A broken subscriber is dropped; progress delivery is never part of the test.
        this.subscribers.delete(subscriber);
      }
    }
    return enriched;
  }

  // Budget accrual reads the fields `run()` already puts on its events, so the
  // numbers here and the numbers in the report come from one source.
  accrue(event) {
    if (event.type === "run-start") {
      this.budget.runs += 1;
      return;
    }
    if (event.type === "step-complete") {
      this.budget.steps += 1;
      const retry = event.diagnostics?.retry || event.retry || null;
      if (retry) {
        this.budget.retries += Math.max(0, Number(retry.retries) || 0);
        this.budget.transientRetries += Math.max(0, Number(retry.transientRetries) || 0);
        if (retry.hardTimedOut) {
          this.budget.hardTimeouts += 1;
        }
      }
      return;
    }
    if (event.type === "browser-crashed") {
      this.budget.browserRestarts += 1;
      return;
    }
    if (event.type === "page-error") {
      this.budget.pageErrors += 1;
      return;
    }
    if (event.type === "download-captured") {
      this.budget.downloads += 1;
      return;
    }
    if (event.type === "run-complete") {
      this.budget.wallMs += Math.max(0, Number(event.telemetry?.durationMs) || 0);
    }
  }

  getEventsSince(cursor = 0) {
    const from = Number(cursor) || 0;
    return this.events.filter((item) => item.seq > from);
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  // The budget an unattended dispatcher settles its contract against. `wallMs` is
  // the SUM of the runs' own durations; `elapsedMs` is the session's wall clock —
  // they differ, and reporting both prevents "the session took 12 minutes but the
  // runs only account for 4" from looking like a bug.
  getBudget({ finishedAt = null } = {}) {
    const endedAt = finishedAt ?? this.finishedAt ?? Date.now();
    const elapsedMs = Math.max(0, endedAt - this.budget.startedAt);
    return {
      ...this.budget,
      elapsedMs,
      overheadMs: Math.max(0, elapsedMs - this.budget.wallMs),
      eventsBuffered: this.events.length,
      eventsDropped: this.dropped,
      finishedAt: this.finishedAt,
      // `true` once the terminal event has been seen — a consumer can tell a
      // frozen budget from one that is still accruing.
      final: this.finishedAt != null,
    };
  }

  dispose() {
    this.subscribers.clear();
  }
}

// Registry of live buses, keyed by session id. A session that has finished keeps
// its bus for a grace period so a client that reconnects right after the terminal
// event can still replay it — otherwise the last thing a poller sees is a 404.
const buses = new Map();
const RETENTION_MS = Math.max(10_000, Number(process.env.ZHUZHU_SESSION_EVENT_RETENTION_MS ?? 5 * 60 * 1000));

function createSessionEventBus(sessionId, options = {}) {
  const bus = new SessionEventBus({ sessionId, ...options });
  buses.set(sessionId, bus);
  return bus;
}

function getSessionEventBus(sessionId) {
  return buses.get(String(sessionId || "").trim()) || null;
}

function retireSessionEventBus(sessionId) {
  const bus = buses.get(sessionId);
  if (!bus) {
    return;
  }
  const timer = setTimeout(() => {
    if (buses.get(sessionId) === bus) {
      bus.dispose();
      buses.delete(sessionId);
    }
  }, RETENTION_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function listSessionEventBuses() {
  return [...buses.keys()];
}

module.exports = {
  DEFAULT_BUFFER_SIZE,
  RETENTION_MS,
  STREAMED_TYPES,
  SessionEventBus,
  createSessionEventBus,
  getSessionEventBus,
  listSessionEventBuses,
  retireSessionEventBus,
};
