const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { RunBoard, registerBatchPlaceholders } = require("../../runtime/server/run-board");
const { handleRunBoardRoute } = require("../../runtime/server/run-board-http");
const { createAppRunQueue } = require("../../src/main/app-run-queue");
const { classifyHttpRequest } = require("../../src/shared/api-guard");
const { getRunBoard } = require("../../runtime/server/run-board");
const { observedRun } = require("../../runtime/server/observed-run");

// v1.11 REQ-Z33: the run board — live / queued / history for every run type.

function tempOutput() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zz-board-"));
}

test("v1.11 Z33: a session's run events become case/step progress and finishing moves it to history", async () => {
  const board = new RunBoard({ outputRoot: tempOutput() });
  board.register({ id: "session-1", sessionId: "session-1", kind: "headless-session", title: "f", caseTotal: 2, caseNames: { c1: "用例一", c2: "用例二" } });
  board.recordEvent("session-1", { type: "run-start", runId: "session-1-round-1-root-setup", totalSteps: 1 });
  board.recordEvent("session-1", { type: "run-complete", runId: "session-1-round-1-root-setup", status: "passed" });
  board.recordEvent("session-1", { type: "run-start", runId: "session-1-round-1-c1", totalSteps: 3 });
  board.recordEvent("session-1", { type: "step-start", stepIndex: 1, stepId: "s2", stepTitle: "点保存", actionType: "click" });
  let snapshot = await board.snapshot();
  assert.equal(snapshot.live.length, 1);
  const progress = snapshot.live[0].progress;
  assert.equal(progress.currentCase.name, "用例一");
  assert.equal(progress.step.title, "点保存");
  assert.equal(progress.step.total, 3);
  assert.equal(progress.casesDone, 0, "root setup is not a case");
  board.recordEvent("session-1", { type: "step-complete", status: "failed", stepId: "s2", error: { code: "x" }, message: "boom" });
  board.recordEvent("session-1", { type: "run-complete", runId: "session-1-round-1-c1", status: "failed" });
  board.finish("session-1", { status: "failed", ok: false, failureType: "assertion-false" });
  snapshot = await board.snapshot();
  assert.equal(snapshot.live.length, 0);
  const record = snapshot.history.find((item) => item.id === "session-1");
  assert.equal(record.status, "failed");
  assert.equal(record.casesFailed, 1);
  assert.equal(record.casesTotal, 2);
  assert.equal(record.firstFailure.message, "boom");
  assert.equal(snapshot.stats.today.failed, 1);
  assert.ok(fs.existsSync(path.join(board.dir, "history.jsonl")));
  assert.equal(fs.readdirSync(board.liveDir).length, 0, "live heartbeat removed on finish");
});

test("v1.11 Z33: batch items are queued until a worker starts them; the session then takes over", async () => {
  const board = new RunBoard({ outputRoot: tempOutput() });
  const placeholders = registerBatchPlaceholders(board, { items: [{ testFilePath: "a.json" }, { testFilePath: "b.json" }], trigger: "test-sessions/batch" });
  let snapshot = await board.snapshot();
  assert.deepEqual(snapshot.queued.map((item) => item.testFilePath), ["a.json", "b.json"]);
  placeholders.start(0);
  board.register({ id: "session-a", kind: "headless-session", title: "a", batchId: placeholders.batchId });
  snapshot = await board.snapshot();
  assert.deepEqual(snapshot.queued.map((item) => item.testFilePath), ["b.json"]);
  assert.equal(snapshot.live[0].batchId, placeholders.batchId);
  // removing a placeholder records no history
  assert.equal(snapshot.history.length, 0);
});

test("v1.11 Z33: the App-run queue reports queued → running → finished through its observer", async () => {
  const board = new RunBoard({ outputRoot: tempOutput() });
  const events = [];
  const queue = createAppRunQueue({
    maxConcurrent: 1,
    observer: (event, meta) => {
      events.push(event.type);
      if (event.type === "queued") board.register({ id: event.runId, kind: "app-run", status: "queued", title: meta.request.testFilePath });
      if (event.type === "running") board.start(event.runId);
      if (["completed", "failed", "cancelled"].includes(event.type)) board.finish(event.runId, { status: event.type, ok: event.result?.ok });
    },
  });
  queue.enqueue({ externalRunId: "r1", testFilePath: "x.json" });
  queue.enqueue({ externalRunId: "r2", testFilePath: "y.json" });
  let snapshot = await board.snapshot();
  assert.equal(snapshot.live.length, 1);
  assert.equal(snapshot.queued.length, 1);
  queue.complete("r1", { ok: true });
  snapshot = await board.snapshot();
  assert.equal(snapshot.live[0].id, "r2");
  assert.equal(snapshot.history[0].status, "passed");
  assert.ok(events.includes("running"));
});

test("v1.11 Z33: another live process's work is shown; a dead owner's leftover is not", async () => {
  const outputRoot = tempOutput();
  const board = new RunBoard({ outputRoot });
  fs.mkdirSync(board.liveDir, { recursive: true });
  const base = { kind: "headless-session", status: "running", startedAt: Date.now(), progress: {} };
  // the parent process (alive) as a "foreign" owner
  fs.writeFileSync(path.join(board.liveDir, "alive.json"), JSON.stringify({ ...base, id: "alive", host: { pid: process.ppid, hostname: os.hostname(), processStartedAt: 1 } }));
  fs.writeFileSync(path.join(board.liveDir, "dead.json"), JSON.stringify({ ...base, id: "dead", host: { pid: 2147483646, hostname: os.hostname(), processStartedAt: 1 } }));
  const snapshot = await board.snapshot();
  assert.deepEqual(snapshot.live.map((item) => item.id), ["alive"]);
  assert.equal(snapshot.live[0].foreign, true);
  assert.equal(fs.existsSync(path.join(board.liveDir, "dead.json")), false, "the stale heartbeat is cleaned up");
});

test("v1.11 Z33: finished sessions from before the board are backfilled from output/sessions", async () => {
  const outputRoot = tempOutput();
  const dir = path.join(outputRoot, "sessions", "session-20261001-101010-abcd1234");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({ id: "session-20261001-101010-abcd1234", status: "passed", createdAt: 1, updatedAt: 2, testFile: { name: "old" }, rounds: [{ id: "round-1", status: "passed", ok: true }] }),
  );
  const snapshot = await new RunBoard({ outputRoot }).snapshot();
  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.history[0].source, "sessions-archive");
  assert.equal(snapshot.history[0].status, "passed");
});

test("v1.11 Z33: /run-board routes serve the page, the snapshot and an SSE stream, and are reads for the guard", async () => {
  const outputRoot = tempOutput();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await handleRunBoardRoute(req, res, url, { outputRoot, label: "test" }))) {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/run-board`);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /Vision E2E 运行看板/);
    const data = await (await fetch(`${base}/run-board/data`)).json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.data.host.servers, ["test"]);
    const controller = new AbortController();
    const stream = await fetch(`${base}/run-board/events`, { signal: controller.signal });
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString("utf8"), /event: board/);
    controller.abort();
  } finally {
    server.close();
  }
  for (const route of ["/run-board", "/run-board/data", "/run-board/events"]) {
    assert.equal(classifyHttpRequest("GET", route), "read");
  }
});

test("v1.11 Z33: standalone runtime reports the real success event and removes failed or cancelled work", async () => {
  const outputRoot = tempOutput();
  const board = getRunBoard({ outputRoot });
  await observedRun([], { runId: "direct", onEvent: () => {} }, {
    outputRoot,
    runImpl: async (_, options) => {
      options.onEvent({ type: "run-start", runId: options.runId, totalSteps: 1 });
      options.onEvent({ type: "step-start", stepIndex: 0, stepId: "x", stepTitle: "检查" });
      assert.equal((await board.snapshot()).live[0].progress.step.title, "检查");
      options.onEvent({ type: "run-complete", status: "success", result: { ok: true } });
      return { ok: true };
    },
  });
  let snapshot = await board.snapshot();
  assert.equal(snapshot.history[0].casesPassed, 1);
  assert.equal(snapshot.history[0].casesFailed, 0);
  assert.equal(snapshot.live.length, 0);
  const error = Object.assign(new Error("cancelled"), { name: "AbortError" });
  await assert.rejects(observedRun([], { runId: "cancel" }, { outputRoot, kind: "cli-run", runImpl: async () => { throw error; } }), error);
  snapshot = await board.snapshot();
  assert.equal(snapshot.history[0].status, "cancelled");
  assert.equal(snapshot.history[0].kind, "cli-run");
  assert.equal(snapshot.live.length, 0);
});
