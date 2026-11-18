const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppRunQueue } = require("../../src/main/app-run-queue");

function makeClock(start = 1000) {
  let t = start;
  return () => (t += 1);
}

function req(id, extra = {}) {
  return { externalRunId: id, testFilePath: `${id}.json`, scope: "all", caseId: null, ...extra };
}

test("enqueue returns runId + queue position and dispatches first run immediately (Z01/Z02)", () => {
  const dispatched = [];
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock(), dispatch: (request) => dispatched.push(request.externalRunId) });

  const a = queue.enqueue(req("run-a"));
  assert.equal(a.runId, "run-a");
  assert.equal(a.status, "running"); // maxConcurrent=1, first one starts
  assert.deepEqual(dispatched, ["run-a"]);

  const b = queue.enqueue(req("run-b"));
  assert.equal(b.status, "queued");
  assert.equal(b.queuePosition, 1); // first in the waiting line
  assert.deepEqual(dispatched, ["run-a"]); // b not dispatched yet

  const c = queue.enqueue(req("run-c"));
  assert.equal(c.queuePosition, 2);
});

test("no submission is dropped; queue drains FIFO as runs complete (Z01-1/Z01-3)", () => {
  const dispatched = [];
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock(), dispatch: (r) => dispatched.push(r.externalRunId) });

  queue.enqueue(req("a"));
  queue.enqueue(req("b"));
  queue.enqueue(req("c"));
  assert.deepEqual(dispatched, ["a"]);

  queue.complete("a", { ok: true, status: "completed" });
  assert.deepEqual(dispatched, ["a", "b"]);
  assert.equal(queue.getRun("a").status, "completed");
  assert.equal(queue.getRun("b").status, "running");
  assert.equal(queue.getRun("c").status, "queued");
  assert.equal(queue.getRun("c").queuePosition, 1); // moved up

  queue.complete("b", { ok: true, status: "completed" });
  queue.complete("c", { ok: false, status: "failed" });
  assert.deepEqual(dispatched, ["a", "b", "c"]);
  assert.equal(queue.getRun("c").status, "failed");
});

test("maxConcurrent > 1 dispatches multiple runs in parallel (Z01 headless-style)", () => {
  const dispatched = [];
  const queue = createAppRunQueue({ maxConcurrent: 3, now: makeClock(), dispatch: (r) => dispatched.push(r.externalRunId) });
  queue.enqueue(req("a"));
  queue.enqueue(req("b"));
  queue.enqueue(req("c"));
  queue.enqueue(req("d"));
  assert.deepEqual(dispatched, ["a", "b", "c"]);
  assert.equal(queue.getRun("d").status, "queued");
  queue.complete("b", { ok: true });
  assert.deepEqual(dispatched, ["a", "b", "c", "d"]);
});

test("event log is ordered with monotonic cursors; getEventsSince backfills (Z02-2/Z02-3)", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue(req("a"));
  queue.appendProgress("a", { case: "case-1", phase: "started" });
  queue.appendProgress("a", { case: "case-1", phase: "passed" });
  queue.complete("a", { ok: true, status: "completed", summary: { pass: 1, fail: 0 } });

  const all = queue.getEventsSince("a", 0);
  assert.deepEqual(all.map((e) => e.type), ["queued", "running", "progress", "progress", "completed"]);
  for (let i = 0; i < all.length; i += 1) {
    assert.equal(all[i].seq, i + 1);
  }
  // Reconnect from a cursor mid-stream: only later events replay, incl. completion.
  const tail = queue.getEventsSince("a", 2);
  assert.deepEqual(tail.map((e) => e.type), ["progress", "progress", "completed"]);
  const completion = tail.at(-1);
  assert.equal(completion.result.summary.pass, 1);
});

test("live subscribers receive events; unsubscribe stops delivery (Z02-2)", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue(req("a"));
  const seen = [];
  const unsubscribe = queue.subscribe("a", (event) => seen.push(event.type));
  queue.appendProgress("a", { phase: "mid" });
  unsubscribe();
  queue.complete("a", { ok: true });
  assert.deepEqual(seen, ["progress"]); // completion arrived after unsubscribe
});

test("wait() resolves with the final result for the sync opt-in path (Z02-1 legacy)", async () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue(req("a"));
  const pending = queue.wait("a");
  queue.complete("a", { ok: true, status: "completed", summary: { pass: 2 } });
  const result = await pending;
  assert.equal(result.summary.pass, 2);
  // wait() after completion resolves immediately with the stored result.
  const again = await queue.wait("a");
  assert.equal(again.status, "completed");
});

test("fail() finalizes with an error result and pumps the next run (Z04 batch resilience)", () => {
  const dispatched = [];
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock(), dispatch: (r) => dispatched.push(r.externalRunId) });
  queue.enqueue(req("a"));
  queue.enqueue(req("b"));
  queue.fail("a", { code: "app-run-timeout", message: "timed out" }, "timeout");
  assert.equal(queue.getRun("a").status, "timeout");
  assert.equal(queue.getRun("a").result.error.code, "app-run-timeout");
  assert.deepEqual(dispatched, ["a", "b"]); // b still runs; one timeout doesn't stall the queue
});

test("complete/fail are idempotent and ignore unknown runs", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue(req("a"));
  assert.equal(queue.complete("a", { ok: true, status: "completed" }), true);
  assert.equal(queue.complete("a", { ok: false, status: "failed" }), false); // already terminal
  assert.equal(queue.getRun("a").status, "completed");
  assert.equal(queue.fail("ghost", { code: "x" }), false);
});

test("a throwing dispatch marks the run errored and continues the queue", () => {
  const queue = createAppRunQueue({
    maxConcurrent: 1,
    now: makeClock(),
    dispatch: (r) => {
      if (r.externalRunId === "a") throw new Error("panel exploded");
    },
  });
  queue.enqueue(req("a"));
  queue.enqueue(req("b"));
  assert.equal(queue.getRun("a").status, "error");
  assert.equal(queue.getRun("a").result.error.code, "dispatch-failed");
  assert.equal(queue.getRun("b").status, "running"); // pumped past the failed dispatch
});

test("queueSnapshot reports active/queued/recent (Z01-3 queue introspection)", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue(req("a"));
  queue.enqueue(req("b"));
  queue.enqueue(req("c"));
  queue.complete("a", { ok: true, status: "completed" });
  const snap = queue.queueSnapshot();
  assert.equal(snap.activeCount, 1);
  assert.equal(snap.queuedCount, 1);
  assert.equal(snap.active[0].runId, "b");
  assert.equal(snap.queued[0].runId, "c");
  assert.equal(snap.recent.some((r) => r.runId === "a"), true);
});

test("appendProgress after completion is ignored (no zombie events)", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue(req("a"));
  queue.complete("a", { ok: true, status: "completed" });
  assert.equal(queue.appendProgress("a", { phase: "late" }), null);
  assert.equal(queue.getEventsSince("a", 0).some((e) => e.type === "progress"), false);
});
