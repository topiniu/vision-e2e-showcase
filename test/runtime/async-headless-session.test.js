"use strict";


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { TestSessionStore, summarizeSessionDoc } = require("../../runtime/server/session-store");
const {
  cancelTestSession,
  createTestSession,
  listActiveTestSessions,
} = require("../../runtime/server/test-session-runner");
const { createServer } = require("../../runtime/server/http");
const {
  cancelHeadlessSession,
  listHeadlessSessions,
  readHeadlessSession,
  runHeadlessBatch,
  runHeadlessSession,
} = require("../../src/main/desktop-runtime-routes");
const { runBatch: runParallelBatch } = require("../../runtime/server/parallel-batch-runner");

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function sampleTestFile(id = "session-file") {
  return {
    schemaVersion: 2,
    id,
    name: `Session File ${id}`,
    baseUrl: "http://example.test/login",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    teardown: { steps: [{ id: "root-teardown", type: "capture" }], alwaysRun: true },
    cases: [
      { id: "case-a", name: "Case A", priority: "P0", steps: [{ id: "case-a-step", type: "capture" }] },
      { id: "case-b", name: "Case B", priority: "P1", steps: [{ id: "case-b-step", type: "capture" }] },
    ],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A runImpl that takes real (small) wall-clock time, records the busy interval of
// every runSteps call, and can fail a step, hang, or honour the abort signal.
function timedRun({ stepMs = 20, failStepId = null, hangOn = null, hangIgnoresSignal = false } = {}) {
  const calls = [];
  const runImpl = async (payload, options) => {
    const steps = Array.isArray(payload) ? payload : [];
    const call = { runId: options.runId, startedAt: Date.now(), finishedAt: 0, options, steps };
    calls.push(call);
    if (hangOn && String(options.runId).includes(hangOn)) {
      if (hangIgnoresSignal) {
        // A truly wedged run: it never comes back and never observes the signal.
        return new Promise(() => {});
      }
      // Cooperative: the real `run()` races every await against options.signal.
      await new Promise((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("Run stopped by user.");
          error.name = "AbortError";
          error.code = "runtime-aborted";
          reject(error);
        };
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    await sleep(stepMs * Math.max(1, steps.length));
    call.finishedAt = Date.now();
    const failedIndex = failStepId ? steps.findIndex((step) => step.id === failStepId) : -1;
    const results = steps.map((step, index) => ({
      ok: index !== failedIndex,
      type: step.type || "capture",
      index,
      input: step,
      error: index === failedIndex ? { code: "expectation-not-met", message: "Expected true but got false." } : null,
    }));
    const errorCount = results.filter((item) => !item.ok).length;
    return {
      ok: errorCount === 0,
      type: "batch",
      data: { results },
      error: errorCount ? { code: "expectation-not-met", message: "Expected true but got false." } : null,
      telemetry: {
        durationMs: stepMs,
        steps: steps.length,
        okCount: steps.length - errorCount,
        errorCount,
        browserUrl: null,
      },
      evidence: { steps: [], runId: options.runId },
    };
  };
  return { calls, runImpl };
}

async function prepare(fileIds = ["session-file"]) {
  const outputRoot = await makeTempRoot("zhuzhu-z15-session-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-z15-workflows-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  for (const id of fileIds) {
    await writeJson(path.join(testWorkflowsRoot, `${id}.json`), sampleTestFile(id));
  }
  return {
    outputRoot,
    testWorkflowsRoot,
    store: new TestSessionStore({ outputRoot }),
    outputRunsRoot: path.join(outputRoot, "runs"),
  };
}

// Poll the session document until it reaches a terminal status (the exact loop a
// caller runs against get_run_summary / GET /test-sessions/{id}).
async function waitForTerminal(store, sessionId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const doc = await store.readSession(sessionId);
    last = doc ? summarizeSessionDoc(doc) : null;
    if (last?.terminal) {
      return last;
    }
    await sleep(15);
  }
  throw new Error(`Session ${sessionId} never reached a terminal status. Last: ${JSON.stringify(last)}`);
}

// --- Z15-1: wait:false returns a handle immediately ------------------------

test("Z15-1 wait:false returns {sessionId, roundId, status} fast and the session finishes in the background", async () => {
  const env = await prepare();
  const fake = timedRun({ stepMs: 120 });
  const startedAt = Date.now();

  const submitted = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", wait: false },
    { ...env, runImpl: fake.runImpl },
  );
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 2000, `submit must return in ~1s, took ${elapsed}ms`);
  assert.equal(submitted.response.ok, true);
  assert.ok(submitted.response.sessionId, "the handle carries a sessionId");
  assert.equal(submitted.response.roundId, "round-1", "the round it will write is known up front");
  assert.equal(submitted.response.status, "running");
  assert.equal(submitted.response.terminal, false);
  assert.equal(submitted.response.mode, "async");
  assert.deepEqual(submitted.response.partial, {
    sessionId: submitted.response.sessionId,
    roundId: "round-1",
  });
  assert.equal(submitted.response.poll.tool, "get_run_summary");
  // A caller polling immediately must not see `pending` for a live session.
  const immediate = summarizeSessionDoc(await env.store.readSession(submitted.response.sessionId));
  assert.equal(immediate.status, "running");
  assert.equal(immediate.terminal, false);
  assert.equal(listActiveTestSessions().some((item) => item.sessionId === submitted.response.sessionId), true);

  const terminal = await waitForTerminal(env.store, submitted.response.sessionId);
  assert.equal(terminal.status, "passed");
  assert.equal(terminal.roundId, "round-1");
  // The session ran to completion on its own: root setup + 2 cases + teardown.
  assert.equal(fake.calls.length, 4);
  const roundDir = path.join(env.outputRoot, "sessions", submitted.response.sessionId, "rounds", "round-1");
  await fs.access(path.join(roundDir, "aggregate.json"));
  await fs.access(path.join(roundDir, "report.md"));
  assert.equal(listActiveTestSessions().some((item) => item.sessionId === submitted.response.sessionId), false);
});

// --- Z15-2: a blocking submit that runs out of budget still hands over the id ---

test("Z15-2 a bounded blocking wait returns partial:{sessionId, roundId} instead of an empty timeout", async () => {
  const env = await prepare();
  const fake = timedRun({ stepMs: 200 });

  const result = await createTestSession(
    {
      testFilePath: "session-file.json",
      authProfile: "demo-local",
      scope: "all",
      // Far shorter than the session needs — the exact situation a client-side
      // MCP timeout creates, except the server now answers first.
      waitTimeoutMs: 120,
    },
    { ...env, runImpl: fake.runImpl },
  );

  assert.equal(result.response.waitTimedOut, true, "the response says the wait expired");
  assert.equal(result.response.mode, "wait-timeout");
  assert.equal(result.response.status, "running");
  assert.equal(result.response.terminal, false);
  assert.ok(result.response.partial?.sessionId, "a timeout is never zero-information");
  assert.equal(result.response.partial.roundId, "round-1");
  assert.equal(result.response.sessionId, result.response.partial.sessionId);
  assert.match(result.response.message, /poll get_run_summary/);

  // The handle is real: the session keeps running and reaches a terminal state.
  const terminal = await waitForTerminal(env.store, result.response.partial.sessionId);
  assert.equal(terminal.status, "passed");
});

test("Z15-2 waitTimeoutMs:0 keeps the pre-v1.4 blocking behavior (no early handoff)", async () => {
  const env = await prepare();
  const fake = timedRun({ stepMs: 30 });
  const result = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", waitTimeoutMs: 0 },
    { ...env, runImpl: fake.runImpl },
  );
  assert.equal(result.response.status, "passed");
  assert.equal(result.response.terminal, true);
  assert.equal(result.response.mode, "sync");
  assert.equal(result.response.waitTimedOut, undefined);
});

// --- Z15-3: polling a handle to终态 agrees with the blocking result ---------

test("Z15-3 the polled terminal result matches the blocking result field-for-field", async () => {
  const env = await prepare();
  // A failing step so there is a real firstFailure to compare, not just `passed`.
  const syncRun = timedRun({ stepMs: 5, failStepId: "case-b-step" });
  const asyncRun = timedRun({ stepMs: 5, failStepId: "case-b-step" });

  const blocking = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", waitTimeoutMs: 0 },
    { ...env, runImpl: syncRun.runImpl },
  );
  const submitted = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", wait: false },
    { ...env, runImpl: asyncRun.runImpl },
  );
  const polled = await waitForTerminal(env.store, submitted.response.sessionId);

  assert.equal(blocking.response.status, "failed");
  assert.equal(polled.status, blocking.response.status);
  assert.equal(polled.terminal, true);
  assert.equal(polled.roundId, blocking.response.roundId);
  assert.equal(polled.firstFailure.stepId, blocking.response.firstFailure.stepId);
  assert.equal(polled.firstFailure.caseId, blocking.response.firstFailure.caseId);
  assert.equal(polled.firstFailure.code, blocking.response.firstFailure.code);
  assert.equal(path.basename(polled.reportPath), path.basename(blocking.response.reportPath));
  assert.equal(polled.ok, false);
});

// --- Z15-4: several async submits actually overlap -------------------------

test("Z15-4 three wait:false submits run concurrently, stay independent, and beat the serial sum", async () => {
  const env = await prepare(["file-a", "file-b", "file-c"]);
  const fake = timedRun({ stepMs: 120 });
  const startedAt = Date.now();

  const submitted = [];
  for (const id of ["file-a", "file-b", "file-c"]) {
    submitted.push(
      await createTestSession(
        { testFilePath: `${id}.json`, authProfile: "demo-local", scope: "all", wait: false },
        { ...env, runImpl: fake.runImpl },
      ),
    );
  }
  const ids = submitted.map((item) => item.response.sessionId);
  assert.equal(new Set(ids).size, 3, "each submit owns an independent session id");

  const terminals = [];
  for (const id of ids) {
    terminals.push(await waitForTerminal(env.store, id));
  }
  const wallClock = Date.now() - startedAt;

  assert.deepEqual(terminals.map((item) => item.status), ["passed", "passed", "passed"]);
  // Results are not cross-wired: each session reports its own test file.
  assert.deepEqual(
    terminals.map((item) => item.testFileId).sort(),
    ["file-a", "file-b", "file-c"],
  );

  // The busy intervals of the three sessions must overlap — that is the whole
  // point of Z15-4 (17 serial sessions burned 48% of the QA round's wall clock).
  const intervalFor = (sessionId) => {
    const own = fake.calls.filter((call) => String(call.runId).startsWith(sessionId));
    return { start: Math.min(...own.map((c) => c.startedAt)), end: Math.max(...own.map((c) => c.finishedAt)) };
  };
  const intervals = ids.map(intervalFor);
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  assert.equal(overlaps(intervals[0], intervals[1]), true, "session 1 and 2 overlap in time");
  assert.equal(overlaps(intervals[1], intervals[2]), true, "session 2 and 3 overlap in time");

  const serialSum = intervals.reduce((sum, item) => sum + (item.end - item.start), 0);
  assert.ok(wallClock < serialSum, `wall clock ${wallClock}ms must beat the serial sum ${serialSum}ms`);
});

// --- Z15-5: find the handle again without touching the filesystem ---------

test("Z15-5 listSessions finds recent handles by testFileId, newest first, without mtime guessing", async () => {
  const env = await prepare(["file-a", "file-b"]);
  const fake = timedRun({ stepMs: 5 });
  const first = await createTestSession(
    { testFilePath: "file-a.json", authProfile: "demo-local", waitTimeoutMs: 0 },
    { ...env, runImpl: fake.runImpl },
  );
  const other = await createTestSession(
    { testFilePath: "file-b.json", authProfile: "demo-local", waitTimeoutMs: 0 },
    { ...env, runImpl: fake.runImpl },
  );
  const second = await createTestSession(
    { testFilePath: "file-a.json", authProfile: "demo-local", waitTimeoutMs: 0 },
    { ...env, runImpl: fake.runImpl },
  );

  const listed = await env.store.listSessions({ testFileId: "file-a", limit: 10 });
  assert.equal(listed.sessions.length, 2, "only file-a's sessions, not the concurrent file-b one");
  assert.deepEqual(
    listed.sessions.map((item) => item.sessionId).sort(),
    [first.response.sessionId, second.response.sessionId].sort(),
  );
  assert.ok(listed.sessions[0].createdAt >= listed.sessions[1].createdAt, "newest first");
  for (const item of listed.sessions) {
    assert.equal(item.status, "passed");
    assert.equal(item.terminal, true);
    assert.equal(item.testFilePath, "file-a.json");
    assert.ok(item.reportPath, "the handle comes with its evidence path");
  }

  // Unfiltered listing sees every session; the limit is honoured.
  const all = await env.store.listSessions({ limit: 2 });
  assert.equal(all.sessions.length, 2);
  const everything = await env.store.listSessions({ limit: 100 });
  assert.equal(everything.sessions.length, 3);
  assert.ok(everything.sessions.some((item) => item.sessionId === other.response.sessionId));

  // Status filter, and an empty result is empty rather than "the newest one".
  assert.equal((await env.store.listSessions({ status: "failed" })).sessions.length, 0);
  assert.equal((await env.store.listSessions({ testFileId: "nope" })).sessions.length, 0);
});

test("Z15-5 listSessions on a workspace with no sessions yet returns empty, not an error", async () => {
  const env = await prepare();
  const listed = await env.store.listSessions({ limit: 5 });
  assert.deepEqual(listed.sessions, []);
});

// --- Z16-1: overlapping sessions are isolated by construction -------------

test("Z16-1 overlapping sessions never share a browser even with reuseBrowser:true (default)", async () => {
  const env = await prepare(["file-a", "file-b"]);
  const fake = timedRun({ stepMs: 80 });
  const launched = [];
  const launchBrowser = async () => {
    const browser = { id: `browser-${launched.length + 1}`, close: async () => {} };
    launched.push(browser);
    return browser;
  };

  const first = await createTestSession(
    { testFilePath: "file-a.json", authProfile: "demo-local", wait: false },
    { ...env, runImpl: fake.runImpl, launchBrowser },
  );
  const second = await createTestSession(
    { testFilePath: "file-b.json", authProfile: "demo-local", wait: false },
    { ...env, runImpl: fake.runImpl, launchBrowser },
  );
  await waitForTerminal(env.store, first.response.sessionId);
  await waitForTerminal(env.store, second.response.sessionId);

  assert.equal(launched.length, 2, "one Chromium process per session, not one shared process");
  const browsersOf = (sessionId) =>
    new Set(
      fake.calls
        .filter((call) => String(call.runId).startsWith(sessionId))
        .map((call) => call.options.browser?.id),
    );
  const firstBrowsers = browsersOf(first.response.sessionId);
  const secondBrowsers = browsersOf(second.response.sessionId);
  assert.equal(firstBrowsers.size, 1, "reuseBrowser reuses ONE browser inside a session");
  assert.equal(secondBrowsers.size, 1);
  assert.equal([...firstBrowsers][0] !== [...secondBrowsers][0], true, "…and never across sessions");
});

// --- Z16-2: cancel a running headless session -----------------------------

test("Z16-2 cancel drives a running session to the `cancelled` terminal status and persists its round", async () => {
  const env = await prepare();
  // Hangs on case-a but honours the abort signal, like the real orchestrator.
  const fake = timedRun({ stepMs: 5, hangOn: "case-a" });
  const submitted = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", wait: false },
    { ...env, runImpl: fake.runImpl },
  );
  const sessionId = submitted.response.sessionId;
  // Let it get past root setup and into the hanging case.
  while (!fake.calls.some((call) => String(call.runId).includes("case-a"))) {
    await sleep(10);
  }

  const startedAt = Date.now();
  const outcome = await cancelTestSession(sessionId, { reason: "clearing the lane", graceMs: 5_000 }, env);
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.ok, true);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.forced, false, "the run unwound cooperatively, no force-finalize needed");
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.terminal, true);
  assert.ok(elapsed < 5_000, `cancel must be bounded, took ${elapsed}ms`);

  const summary = summarizeSessionDoc(await env.store.readSession(sessionId));
  assert.equal(summary.status, "cancelled");
  assert.equal(summary.terminal, true);
  assert.equal(summary.ok, false, "cancelled is terminal-and-not-passed, never `unknown`");
  // Z12-3's guarantee still holds: a cancelled session leaves evidence behind.
  const roundDir = path.join(env.outputRoot, "sessions", sessionId, "rounds", "round-1");
  const aggregate = JSON.parse(await fs.readFile(path.join(roundDir, "aggregate.json"), "utf8"));
  assert.equal(aggregate.status, "cancelled");
  assert.equal(aggregate.error.code, "session-cancelled");
  await fs.access(path.join(roundDir, "report.md"));
  // The browser was released and no further case was started.
  assert.equal(fake.calls.some((call) => String(call.runId).includes("case-b")), false);
  assert.equal(listActiveTestSessions().some((item) => item.sessionId === sessionId), false);
});

test("Z16-2 a wedged session that ignores the abort is still force-finalized to `cancelled` in bounded time", async () => {
  const env = await prepare();
  const fake = timedRun({ stepMs: 5, hangOn: "root-setup", hangIgnoresSignal: true });
  const submitted = await createTestSession(
    {
      testFilePath: "session-file.json",
      authProfile: "demo-local",
      wait: false,
      // Long enough that the session's own deadline is NOT what ends this test.
      sessionTimeoutMs: 600_000,
    },
    { ...env, runImpl: fake.runImpl },
  );
  const sessionId = submitted.response.sessionId;
  while (!fake.calls.length) {
    await sleep(10);
  }

  const startedAt = Date.now();
  const outcome = await cancelTestSession(sessionId, { reason: "wedged", graceMs: 150 }, env);
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.forced, true, "the grace window expired, so the document was finalized");
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.terminal, true);
  assert.ok(elapsed < 5_000, `bounded even when the run never unwinds, took ${elapsed}ms`);
  const summary = summarizeSessionDoc(await env.store.readSession(sessionId));
  assert.equal(summary.terminal, true);
});

test("Z16-2 cancel is idempotent: finished, unknown and orphaned sessions all answer sanely", async () => {
  const env = await prepare();
  const fake = timedRun({ stepMs: 5 });
  const done = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", waitTimeoutMs: 0 },
    { ...env, runImpl: fake.runImpl },
  );

  // Already terminal -> reports, does not fail.
  const finished = await cancelTestSession(done.response.sessionId, {}, env);
  assert.equal(finished.ok, true);
  assert.equal(finished.cancelled, false);
  assert.equal(finished.reason, "not-running");
  assert.equal(finished.status, "passed");

  // Unknown id -> not-found, not a crash.
  const missing = await cancelTestSession("session-20260101-000000-deadbeef", {}, env);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "not-found");
  assert.equal(missing.error.code, "not-found");

  // A session that wins the race and finishes normally between the abort and the
  // grace deadline must be reported honestly, not as "cancelled".
  const racing = timedRun({ stepMs: 5 });
  const submitted = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", wait: false },
    { ...env, runImpl: racing.runImpl },
  );
  const raced = await cancelTestSession(submitted.response.sessionId, { graceMs: 5_000 }, env);
  assert.equal(raced.status, "passed");
  assert.equal(raced.cancelled, false, "it finished on its own — do not claim it was cancelled");
  assert.equal(raced.reason, "finished-before-cancel");

  // Orphaned: the document says running but nothing in this process is executing
  // it (the host restarted). Nothing could ever finish it, so cancel finalizes it.
  const orphan = await env.store.createSession({
    request: {},
    testFile: { source: "path", path: "session-file.json", id: "session-file", name: "Session File" },
  });
  await env.store.writeSession({ ...orphan, status: "running" });
  const recovered = await cancelTestSession(orphan.id, {}, env);
  assert.equal(recovered.cancelled, true);
  assert.equal(recovered.orphaned, true);
  assert.equal(recovered.status, "cancelled");
});

// --- a detached submit must never leave a session stuck in `running` -------

test("an unexpected failure in the background path still drives the session to a terminal status", async () => {
  const env = await prepare();
  const fake = timedRun({ stepMs: 5 });
  // Break artifact persistence: both the round persist and the finalizer's
  // fallback round persist fail, so only the last-resort session write is left.
  // Nobody is awaiting the promise (wait:false), so without the finalizer this
  // session would sit at `running` forever — v1.3's Z12-3 promise, undone.
  const brokenStore = Object.create(env.store);
  brokenStore.writeRoundArtifact = async () => {
    throw new Error("disk is on fire");
  };

  const submitted = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", wait: false },
    { ...env, store: brokenStore, runImpl: fake.runImpl },
  );
  const terminal = await waitForTerminal(env.store, submitted.response.sessionId, 5_000);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.terminal, true);
});

// --- the desktop App-run server's route helpers ----------------------------

test("the desktop routes expose submit / poll / list / cancel with the same口径", async () => {
  const env = await prepare(["file-a"]);
  const fake = timedRun({ stepMs: 90 });
  const deps = {
    createTestSession: (request, options) => createTestSession(request, { ...options, runImpl: fake.runImpl }),
    store: env.store,
    outputRoot: env.outputRoot,
    testWorkflowsRoot: env.testWorkflowsRoot,
    outputRunsRoot: env.outputRunsRoot,
  };

  // POST /test-sessions with wait:false -> a handle, HTTP 200.
  const submitted = await runHeadlessSession(
    { testFilePath: "file-a.json", authProfile: "demo-local", wait: false },
    deps,
  );
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.payload.status, "running");
  const sessionId = submitted.payload.partial.sessionId;

  // GET /test-sessions/{id} while running -> the same projection, not terminal.
  const pending = await readHeadlessSession(`/test-sessions/${sessionId}`, { store: env.store });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.payload.summary.sessionId, sessionId);
  assert.equal(pending.payload.summary.terminal, false);
  assert.ok(pending.payload.data, "the raw session document is still there for existing callers");

  await waitForTerminal(env.store, sessionId);

  // GET /test-sessions?testFileId=... -> the handle, found without mtime.
  const listed = await listHeadlessSessions(new URLSearchParams({ testFileId: "file-a", limit: "5" }), {
    store: env.store,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.payload.data.count, 1);
  assert.equal(listed.payload.data.sessions[0].sessionId, sessionId);
  assert.equal(listed.payload.data.filters.testFileId, "file-a");

  // POST /test-sessions/{id}/cancel on a finished session -> idempotent.
  const cancelled = await cancelHeadlessSession("POST", `/test-sessions/${sessionId}/cancel`, {}, {
    cancelSession: cancelTestSession,
    store: env.store,
    outputRoot: env.outputRoot,
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.payload.cancelled, false);
  assert.equal(cancelled.payload.reason, "not-running");

  // A non-cancel path falls through so the reader routes keep working.
  assert.equal(
    await cancelHeadlessSession("GET", `/test-sessions/${sessionId}`, {}, { cancelSession: cancelTestSession }),
    null,
  );
  assert.equal(
    await cancelHeadlessSession("POST", "/test-sessions/batch", {}, { cancelSession: cancelTestSession }),
    null,
    "the batch route must not be swallowed by the cancel matcher",
  );
});

// --- the standalone runtime bridge (:32146) --------------------------------

function requestJson(port, method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, method, path: pathname, headers: body ? { "content-type": "application/json" } : {} },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ statusCode: response.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    request.on("error", reject);
    if (body) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

test("the standalone bridge serves wait:false, the session list and cancel too", async () => {
  const env = await prepare(["file-a"]);
  const fake = timedRun({ stepMs: 80 });
  const server = createServer({
    outputRoot: env.outputRoot,
    testWorkflowsRoot: env.testWorkflowsRoot,
    outputRunsRoot: env.outputRunsRoot,
    runImpl: fake.runImpl,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const submitted = await requestJson(port, "POST", "/test-sessions", {
      testFilePath: "file-a.json",
      authProfile: "demo-local",
      wait: false,
    });
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.body.status, "running");
    const sessionId = submitted.body.sessionId;
    assert.ok(sessionId);

    // Polling the id reports the shared projection alongside the raw document.
    const polled = await requestJson(port, "GET", `/test-sessions/${sessionId}`);
    assert.equal(polled.statusCode, 200);
    assert.equal(polled.body.summary.sessionId, sessionId);

    const terminal = await waitForTerminal(env.store, sessionId);
    assert.equal(terminal.status, "passed");

    const listed = await requestJson(port, "GET", "/test-sessions?testFileId=file-a&limit=5");
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.data.sessions[0].sessionId, sessionId);

    const cancelled = await requestJson(port, "POST", `/test-sessions/${sessionId}/cancel`, { reason: "done" });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.body.cancelled, false, "already terminal — idempotent, not an error");

    const unknown = await requestJson(port, "POST", "/test-sessions/session-20260101-000000-abcdabcd/cancel");
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.body.error.code, "not-found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- regression guard: the batch channel must stay blocking ----------------

test("the batch channel is unaffected by the per-submit wait ceiling (every item reports a terminal status)", async () => {
  const env = await prepare(["file-a", "file-b"]);
  // Each item takes far longer than any plausible wait ceiling.
  const fake = timedRun({ stepMs: 60 });
  const { statusCode, payload } = await runHeadlessBatch(
    { items: [{ testFilePath: "file-a.json" }, { testFilePath: "file-b.json" }], authProfile: "demo-local", concurrency: 2 },
    {
      runBatch: runParallelBatch,
      createTestSession: (request, options) => createTestSession(request, { ...options, runImpl: fake.runImpl }),
      store: env.store,
      outputRoot: env.outputRoot,
      testWorkflowsRoot: env.testWorkflowsRoot,
      outputRunsRoot: env.outputRunsRoot,
    },
  );

  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.sessions.length, 2);
  for (const session of payload.data.sessions) {
    assert.equal(session.status, "passed", "batch waits for the real result, never returns `running`");
    assert.equal(session.terminal, true);
  }
});
