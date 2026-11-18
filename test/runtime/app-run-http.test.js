const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppRunQueue } = require("../../src/main/app-run-queue");
const {
  buildEnqueueResponse,
  resolveWaitStatus,
  streamRunEvents,
} = require("../../src/main/app-run-http");

function makeClock(start = 1000) {
  let t = start;
  return () => (t += 1);
}

function fakeRes() {
  return {
    headers: null,
    statusCode: null,
    chunks: [],
    ended: false,
    listeners: {},
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(String(chunk));
      this.ended = true;
    },
    get body() {
      return this.chunks.join("");
    },
  };
}

test("buildEnqueueResponse shapes the 202 body with links (Z02-1)", () => {
  const body = buildEnqueueResponse(
    { runId: "run-1", status: "queued", queuePosition: 2 },
    { testFilePath: "a.json", scope: "all", caseId: null },
  );
  assert.equal(body.externalRunId, "run-1");
  assert.equal(body.status, "queued");
  assert.equal(body.queuePosition, 2);
  assert.equal(body.accepted, true);
  assert.equal(body.links.events, "/app-runs/run-1/events");
  assert.equal(body.links.status, "/app-runs/run-1");
});

test("resolveWaitStatus maps status to HTTP codes (Z02-1 legacy sync)", () => {
  assert.equal(resolveWaitStatus({ status: "timeout" }), 504);
  assert.equal(resolveWaitStatus({ status: "app-unavailable" }), 503);
  assert.equal(resolveWaitStatus({ status: "passed", ok: true }), 200);
  assert.equal(resolveWaitStatus({ status: "failed", ok: false }), 200);
});

test("streamRunEvents replays backlog then ends on a terminal event (Z02-3 reconnect)", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue({ externalRunId: "run-1", testFilePath: "a.json", scope: "all" });
  queue.appendProgress("run-1", { phase: "case-1" });
  queue.complete("run-1", { ok: true, status: "completed" });

  const res = fakeRes();
  const outcome = streamRunEvents({ queue, runId: "run-1", res, cursor: 0 });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /text\/event-stream/);
  // All 4 events replayed (queued, running, progress, completed) then ended.
  assert.equal(res.ended, true);
  assert.equal(outcome.live, false);
  assert.match(res.body, /event: queued/);
  assert.match(res.body, /event: completed/);
  assert.match(res.body, /id: 4/);
});

test("streamRunEvents backfills only after the cursor (Z02-3)", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue({ externalRunId: "run-1", testFilePath: "a.json", scope: "all" });
  queue.appendProgress("run-1", { phase: "case-1" });
  queue.complete("run-1", { ok: true, status: "completed" });

  const res = fakeRes();
  streamRunEvents({ queue, runId: "run-1", res, cursor: 2 });
  // Only seq 3 (progress) and 4 (completed) after cursor=2.
  assert.doesNotMatch(res.body, /event: queued/);
  assert.match(res.body, /event: progress/);
  assert.match(res.body, /event: completed/);
});

test("streamRunEvents goes live and delivers future events, ending on completion (Z02-2)", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue({ externalRunId: "run-1", testFilePath: "a.json", scope: "all" });

  const res = fakeRes();
  const outcome = streamRunEvents({ queue, runId: "run-1", res, cursor: 0 });
  assert.equal(outcome.live, true);
  assert.equal(res.ended, false);

  queue.appendProgress("run-1", { phase: "case-1" });
  assert.match(res.body, /event: progress/);
  assert.equal(res.ended, false);

  queue.complete("run-1", { ok: true, status: "completed" });
  assert.equal(res.ended, true); // terminal event closes the stream
  assert.match(res.body, /event: completed/);
});

test("streamRunEvents returns 404 for unknown runs", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  const res = fakeRes();
  const outcome = streamRunEvents({ queue, runId: "ghost", res });
  assert.equal(outcome.ok, false);
  assert.equal(res.statusCode, 404);
});

test("req close unsubscribes so late events are not written after disconnect", () => {
  const queue = createAppRunQueue({ maxConcurrent: 1, now: makeClock() });
  queue.enqueue({ externalRunId: "run-1", testFilePath: "a.json", scope: "all" });
  const res = fakeRes();
  let closeHandler = null;
  const req = { on: (evt, fn) => { if (evt === "close") closeHandler = fn; } };
  streamRunEvents({ queue, runId: "run-1", res, cursor: 0, req });
  const beforeLen = res.chunks.length;
  closeHandler(); // client disconnects
  queue.appendProgress("run-1", { phase: "late" });
  assert.equal(res.chunks.length, beforeLen); // nothing written after close
});
