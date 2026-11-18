const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppRunQueue } = require("../../src/main/app-run-queue");

// Controllable clock so the stall watchdog is deterministic.
function makeClock(start = 1_000_000) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => {
    value += ms;
  };
  return now;
}

function req(id, extra = {}) {
  return { externalRunId: id, testFilePath: `${id}.json`, scope: "all", caseId: null, ...extra };
}

function setup({ maxConcurrent = 1, stallTimeoutMs = 600_000 } = {}) {
  const now = makeClock();
  const dispatched = [];
  const cancelled = [];
  const queue = createAppRunQueue({
    maxConcurrent,
    stallTimeoutMs,
    now,
    dispatch: (request) => dispatched.push(request.externalRunId),
    onCancel: (record, meta) => cancelled.push({ runId: record.runId, ...meta }),
  });
  return { now, queue, dispatched, cancelled };
}

// --- REQ-Z13: cancel endpoint semantics -----------------------------------

test("cancelling a running run aborts the work, marks it cancelled and frees the slot (Z13-1)", () => {
  const { queue, cancelled } = setup();
  queue.enqueue(req("run-a"));
  assert.equal(queue.queueSnapshot().activeCount, 1);

  const outcome = queue.cancel("run-a", { reason: "operator cleared a wedged run" });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.wasRunning, true);
  assert.equal(queue.getRun("run-a").status, "cancelled");
  assert.equal(queue.getRun("run-a").result.error.code, "app-run-cancelled");
  assert.equal(queue.queueSnapshot().activeCount, 0, "the slot is released");
  // The in-flight work was torn down, not just relabelled.
  assert.deepEqual(cancelled.map((item) => item.runId), ["run-a"]);
  assert.equal(cancelled[0].reason, "operator cleared a wedged run");
});

test("a new run submitted right after a cancel enqueues and executes cleanly (Z13-2)", () => {
  const { queue, dispatched } = setup();
  queue.enqueue(req("run-a"));
  queue.cancel("run-a");

  const next = queue.enqueue(req("run-b"));
  assert.equal(next.status, "running");
  assert.deepEqual(dispatched, ["run-a", "run-b"]);
  assert.equal(queue.queueSnapshot().activeCount, 1);
  // The cancelled run leaves no residue in the active/queued sets.
  assert.equal(queue.queueSnapshot().active[0].runId, "run-b");
  assert.equal(queue.queueSnapshot().queuedCount, 0);
});

test("cancelling an already-finished run is idempotent, not an error (Z13-3)", () => {
  const { queue, cancelled } = setup();
  queue.enqueue(req("run-a"));
  queue.complete("run-a", { ok: true, status: "completed" });

  const outcome = queue.cancel("run-a");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.reason, "not-running");
  assert.equal(outcome.status, "completed", "the terminal status is preserved");
  assert.equal(cancelled.length, 0, "nothing was torn down for a finished run");

  // Cancelling twice stays idempotent.
  assert.equal(queue.cancel("run-a").cancelled, false);
});

test("cancelling an unknown run reports not-found without throwing (Z13-3)", () => {
  const { queue } = setup();
  const outcome = queue.cancel("ghost");
  assert.equal(outcome.found, false);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "not-found");
});

test("cancelling a queued run removes it from the line and never dispatches it", () => {
  const { queue, dispatched, cancelled } = setup();
  queue.enqueue(req("a"));
  queue.enqueue(req("b"));
  queue.enqueue(req("c"));

  const outcome = queue.cancel("b");
  assert.equal(outcome.wasQueued, true);
  assert.equal(cancelled.length, 0, "a queued run has no in-flight work to tear down");
  queue.complete("a", { ok: true, status: "completed" });
  assert.deepEqual(dispatched, ["a", "c"], "b was never dispatched");
});

test("a cancelled run is terminal for SSE and for wait()", async () => {
  const { queue } = setup();
  queue.enqueue(req("a"));
  const pending = queue.wait("a");
  queue.cancel("a");
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(queue.isTerminal("cancelled"), true);
  const events = queue.getEventsSince("a", 0);
  assert.equal(events.at(-1).type, "cancelled");
});

// --- REQ-Z12-2: stall watchdog -------------------------------------------

test("a run that goes silent past the stall threshold is force-failed and its slot freed (Z12-2)", () => {
  const { now, queue, dispatched, cancelled } = setup({ stallTimeoutMs: 600_000 });
  queue.enqueue(req("frozen"));
  queue.enqueue(req("waiting"));
  assert.equal(queue.queueSnapshot().activeCount, 1);

  // Not yet stale: the watchdog must not touch a merely slow run.
  now.advance(300_000);
  assert.deepEqual(queue.sweepStalled(), []);
  assert.equal(queue.getRun("frozen").status, "running");

  now.advance(400_000); // total idle 700s > 600s threshold
  const swept = queue.sweepStalled();

  assert.equal(swept.length, 1);
  assert.equal(swept[0].runId, "frozen");
  assert.equal(queue.getRun("frozen").status, "failed");
  assert.equal(queue.getRun("frozen").result.error.code, "app-run-stalled");
  assert.equal(queue.getRun("frozen").result.error.retriable, true);
  // Z12-2 core assertion: activeCount returns to zero and the next run proceeds.
  assert.equal(queue.queueSnapshot().activeCount, 1, "the queued run took the freed slot");
  assert.equal(queue.getRun("waiting").status, "running");
  assert.deepEqual(dispatched, ["frozen", "waiting"]);
  assert.deepEqual(cancelled.map((item) => item.reason), ["app-run-stalled"]);
});

test("progress events keep a long-but-live run out of the watchdog's reach (Z12-2)", () => {
  const { now, queue } = setup({ stallTimeoutMs: 600_000 });
  queue.enqueue(req("long"));
  for (let i = 0; i < 5; i += 1) {
    now.advance(500_000);
    queue.appendProgress("long", { phase: "step", stepIndex: i });
    assert.deepEqual(queue.sweepStalled(), [], "each progress event resets the idle clock");
  }
  assert.equal(queue.getRun("long").status, "running");
  assert.equal(queue.getRun("long").idleMs, 0);
});

test("touch() keeps a busy run alive without bloating its event log (Z12-2)", () => {
  const { now, queue } = setup({ stallTimeoutMs: 600_000 });
  queue.enqueue(req("busy"));
  const baseline = queue.getEventsSince("busy", 0).length;

  // Simulate an engine emitting many step events over a long run. The panel
  // itself reports almost nothing for an external run, so liveness has to come
  // from here — otherwise a legitimately long run gets falsely swept.
  for (let i = 0; i < 500; i += 1) {
    now.advance(1_000);
    assert.equal(queue.touch("busy"), true);
    assert.deepEqual(queue.sweepStalled(), [], `still alive at event ${i}`);
  }

  assert.equal(queue.getRun("busy").status, "running");
  assert.equal(
    queue.getEventsSince("busy", 0).length,
    baseline,
    "500 touches added zero events — the SSE replay buffer stays small",
  );
  assert.equal(queue.getRun("busy").idleMs, 0);

  // Stop touching -> the watchdog reclaims it.
  now.advance(700_000);
  assert.equal(queue.sweepStalled().length, 1);
});

test("touch() is a no-op for terminal and unknown runs", () => {
  const { queue } = setup();
  queue.enqueue(req("a"));
  queue.complete("a", { ok: true, status: "completed" });
  assert.equal(queue.touch("a"), false);
  assert.equal(queue.touch("ghost"), false);
});

test("the watchdog is disabled when the stall threshold is 0 (opt out)", () => {
  const { now, queue } = setup({ stallTimeoutMs: 0 });
  queue.enqueue(req("a"));
  now.advance(10 * 60 * 60 * 1000);
  assert.deepEqual(queue.sweepStalled(), []);
  assert.equal(queue.getRun("a").status, "running");
});

test("queue snapshot self-describes the freeze protections and per-run liveness", () => {
  const { now, queue } = setup({ stallTimeoutMs: 600_000 });
  queue.enqueue(req("a"));
  now.advance(120_000);
  const snapshot = queue.queueSnapshot();
  assert.equal(snapshot.stallTimeoutMs, 600_000);
  assert.equal(snapshot.cancelSupported, true);
  assert.ok(snapshot.active[0].idleMs >= 120_000, "callers can see how long a run has been silent");
  assert.ok(snapshot.active[0].lastActivityAt > 0);
});

test("a failing teardown still releases the slot (never leave a run stuck as running)", () => {
  const now = makeClock();
  const dispatched = [];
  const queue = createAppRunQueue({
    maxConcurrent: 1,
    now,
    dispatch: (request) => dispatched.push(request.externalRunId),
    onCancel: () => {
      throw new Error("panel is unreachable");
    },
  });
  queue.enqueue(req("a"));
  queue.enqueue(req("b"));
  assert.equal(queue.cancel("a").cancelled, true);
  assert.equal(queue.getRun("a").status, "cancelled");
  assert.deepEqual(dispatched, ["a", "b"]);
});
