
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const {
  SessionEventBus,
  createSessionEventBus,
  getSessionEventBus,
  retireSessionEventBus,
} = require("../../runtime/server/session-events");
const {
  claimSession,
  inspectClaim,
  isProcessAlive,
  listClaims,
  readClaim,
  releaseSession,
} = require("../../runtime/server/active-session-registry");
const { isProcessIsolationEnabled, runSessionInWorker } = require("../../runtime/server/session-worker");
const {
  readHeadlessSessionBudget,
  streamHeadlessSessionEvents,
} = require("../../src/main/desktop-runtime-routes");
const { createTestSession, cancelTestSession } = require("../../runtime/server/test-session-runner");
const { TestSessionStore } = require("../../runtime/server/session-store");
const { launchSharedBrowser } = require("../../runtime/executor/run-session");
const { startSelfcheckApp } = require("../fixtures/selfcheck-app");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-v17-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeWorkspace(t) {
  const root = tempRoot(t);
  await fsp.mkdir(path.join(root, "test-workflows"), { recursive: true });
  const outputRoot = path.join(root, "output");
  const profileDir = path.join(outputRoot, "auth-profiles", "wk");
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.writeFile(path.join(profileDir, "storageState.json"), JSON.stringify({ cookies: [], origins: [] }));
  return {
    root,
    outputRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    testWorkflowsRoot: path.join(root, "test-workflows"),
    store: new TestSessionStore({ outputRoot }),
  };
}

// --- Z-N: the event bus ------------------------------------------------------

test("the bus streams step-level events and pins the terminal one", () => {
  const bus = new SessionEventBus({ sessionId: "s1", bufferSize: 4 });
  bus.publish({ type: "run-start", totalSteps: 3 });
  for (let i = 0; i < 6; i += 1) {
    bus.publish({ type: "step-complete", stepId: `s${i}`, status: "passed" });
  }
  bus.publish({ type: "session-complete", status: "passed" });

  const events = bus.getEventsSince(0);
  // Buffer is bounded and dropped the OLDEST, but the terminal event survives:
  // a late subscriber must always be able to learn the session ended.
  assert.ok(events.length <= 5, `buffer grew to ${events.length}`);
  assert.equal(events.at(-1).type, "session-complete");
  assert.ok(bus.dropped > 0);
  // Sequence numbers are monotonic so a client can resume with ?cursor=.
  const seqs = events.map((item) => item.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("noisy event types are counted but not streamed", () => {
  const bus = new SessionEventBus({ sessionId: "s2" });
  bus.publish({ type: "browser-memory-warning", heapUsedMb: 1600 });
  bus.publish({ type: "page-error", entry: { message: "boom" } });
  assert.equal(bus.getEventsSince(0).length, 0, "memory samples must not flood the replay buffer");
  // ...but the page error still lands in the budget.
  assert.equal(bus.getBudget().pageErrors, 1);
});

test("cursor-based replay returns only what a client has not seen", () => {
  const bus = new SessionEventBus({ sessionId: "s3" });
  bus.publish({ type: "step-complete", stepId: "a" });
  bus.publish({ type: "step-complete", stepId: "b" });
  assert.equal(bus.getEventsSince(0).length, 2);
  assert.equal(bus.getEventsSince(1).length, 1);
  assert.equal(bus.getEventsSince(2).length, 0);
});

test("a subscriber that throws is dropped, not propagated", () => {
  const bus = new SessionEventBus({ sessionId: "s4" });
  bus.subscribe(() => {
    throw new Error("bad subscriber");
  });
  let good = 0;
  bus.subscribe(() => {
    good += 1;
  });
  // Progress delivery is never part of the test.
  assert.doesNotThrow(() => bus.publish({ type: "step-complete", stepId: "a" }));
  bus.publish({ type: "step-complete", stepId: "b" });
  assert.equal(good, 2);
  assert.equal(bus.subscribers.size, 1);
});

// --- Z-N: budget -------------------------------------------------------------

test("the budget accrues steps, retries, crashes and downloads from the events", () => {
  const bus = new SessionEventBus({ sessionId: "s5" });
  bus.publish({ type: "run-start" });
  bus.publish({ type: "step-complete", stepId: "a", diagnostics: { retry: { retries: 2, transientRetries: 1 } } });
  bus.publish({ type: "step-complete", stepId: "b", diagnostics: { retry: { retries: 0, hardTimedOut: true } } });
  bus.publish({ type: "browser-crashed", code: "browser-oom" });
  bus.publish({ type: "download-captured", download: {} });
  bus.publish({ type: "run-complete", telemetry: { durationMs: 4000 } });

  const budget = bus.getBudget();
  assert.equal(budget.runs, 1);
  assert.equal(budget.steps, 2);
  assert.equal(budget.retries, 2);
  assert.equal(budget.transientRetries, 1);
  assert.equal(budget.hardTimeouts, 1);
  assert.equal(budget.browserRestarts, 1);
  assert.equal(budget.downloads, 1);
  assert.equal(budget.wallMs, 4000);
  // Both numbers are reported: `wallMs` is the sum of the runs, `elapsedMs` is
  // the session's wall clock. Reporting only one makes the difference look like a bug.
  assert.ok(budget.elapsedMs >= 0);
  assert.ok(budget.overheadMs >= 0);
  assert.equal(budget.final, false, "a running session's budget is still accruing");
});

test("a finished session's budget is FROZEN at the terminal event", async () => {
  const bus = new SessionEventBus({ sessionId: "s6" });
  bus.publish({ type: "run-complete", telemetry: { durationMs: 100 } });
  bus.publish({ type: "session-complete", status: "passed" });
  const first = bus.getBudget();
  assert.equal(first.final, true);
  assert.ok(first.finishedAt);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const later = bus.getBudget();
  // Polling the budget route ten minutes later must not report ten extra minutes
  // the session never spent — the whole point is that these numbers settle.
  assert.equal(later.elapsedMs, first.elapsedMs);
});

// --- Z-N: the HTTP surfaces --------------------------------------------------

test("the budget route reports a live session and 404s an unknown one", () => {
  const bus = createSessionEventBus("session-budget-1");
  bus.publish({ type: "step-complete", stepId: "a" });
  const found = readHeadlessSessionBudget("/test-sessions/session-budget-1/budget");
  assert.equal(found.statusCode, 200);
  assert.equal(found.payload.data.budget.steps, 1);

  const missing = readHeadlessSessionBudget("/test-sessions/nope/budget");
  assert.equal(missing.statusCode, 404);
  assert.match(missing.payload.error.message, /session-complete/);

  // Non-matching paths fall through so the caller keeps dispatching.
  assert.equal(readHeadlessSessionBudget("/test-sessions/x"), null);
  retireSessionEventBus("session-budget-1");
});

test("the SSE route replays the backlog then streams live, and ends on terminal", async () => {
  const bus = createSessionEventBus("session-sse-1");
  bus.publish({ type: "run-start", totalSteps: 2 });
  bus.publish({ type: "step-complete", stepId: "a", status: "passed" });

  // A minimal fake `res` capturing the SSE frames.
  const chunks = [];
  let ended = false;
  const res = {
    writeHead: () => {},
    write: (chunk) => chunks.push(String(chunk)),
    end: () => {
      ended = true;
    },
  };
  const req = { on: () => {} };
  const outcome = streamHeadlessSessionEvents("/test-sessions/session-sse-1/events", { res, req, cursor: 0 });
  assert.equal(outcome.streamed, true);
  assert.equal(outcome.replayed, 2);
  assert.equal(outcome.live, true);
  assert.match(chunks.join(""), /event: run-start/);
  assert.match(chunks.join(""), /event: step-complete/);

  // Live delivery, then the terminal event closes the stream.
  bus.publish({ type: "step-complete", stepId: "b", status: "passed" });
  assert.equal(chunks.filter((chunk) => chunk.includes("step-complete")).length, 2);
  bus.publish({ type: "session-complete", status: "passed" });
  assert.equal(ended, true, "a terminal event must close the stream, not leave the client hanging");
  retireSessionEventBus("session-sse-1");
});

test("the SSE route 404s a session with no live stream, with a pointer to the alternative", () => {
  const res = { writeHead: () => {}, write: () => {}, end: () => {} };
  const result = streamHeadlessSessionEvents("/test-sessions/ghost/events", { res, req: { on: () => {} } });
  assert.equal(result.statusCode, 404);
  assert.match(result.payload.error.message, /GET \/test-sessions\/\{id\}/);
  assert.equal(streamHeadlessSessionEvents("/test-sessions/x", { res }), null);
});

test("a real headless session emits step-level progress and a final budget", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);

  const testFile = {
    schemaVersion: 2,
    id: "progress-file",
    name: "progress",
    baseUrl: app.baseUrl,
    settings: { evidence: true, evidenceProfile: "fast" },
    cases: [
      {
        id: "case-1",
        name: "两步",
        steps: [
          { id: "s1", type: "assertDom", target: { testId: "demo-category-list" }, property: "exists", expected: true },
          { id: "s2", type: "click", target: { testId: "demo-category-copy-btn" } },
        ],
      },
    ],
  };

  const seen = [];
  const { listSessionEventBuses } = require("../../runtime/server/session-events");
  // Snapshot the existing bus ids first and look for the NEW one. Picking "the
  // newest" would be the same mistake v1.4 removed from session lookup: with any
  // concurrency it hands you somebody else's handle.
  const before = new Set(listSessionEventBuses());
  // Subscribe as soon as the bus exists. `startTestSession` creates it before
  // execution begins, which is why `run-start` cannot be missed.
  const submitted = createTestSession(
    { testFile, authProfile: "wk", wait: true, waitTimeoutMs: 0 },
    {
      store: workspace.store,
      outputRoot: workspace.outputRoot,
      outputRunsRoot: workspace.outputRunsRoot,
      testWorkflowsRoot: workspace.testWorkflowsRoot,
      launchBrowser: launchSharedBrowser,
    },
  );
  // Poll briefly for the bus (the session id is not known until the doc exists).
  let bus = null;
  for (let i = 0; i < 200 && !bus; i += 1) {
    const fresh = listSessionEventBuses().filter((id) => !before.has(id));
    if (fresh.length) {
      bus = getSessionEventBus(fresh[0]);
    }
    if (!bus) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(bus, "a bus must exist while the session runs");
  bus.subscribe((event) => seen.push(event.type));

  const result = await submitted;
  assert.equal(result.response.status, "passed", JSON.stringify(result.response.firstFailure || result.response));

  // Step-level progress actually arrived (the whole point of Z-N).
  assert.ok(seen.includes("step-complete") || bus.getEventsSince(0).some((item) => item.type === "step-complete"));
  const budget = bus.getBudget();
  assert.ok(budget.steps >= 2, `budget recorded ${budget.steps} steps`);
  assert.ok(budget.wallMs > 0);
  assert.ok(budget.elapsedMs >= budget.wallMs - 1);
});

// --- Z-O: the persisted claim ------------------------------------------------

test("a claim records this process and reports itself as owner", async (t) => {
  const root = tempRoot(t);
  const claim = await claimSession({ outputRoot: root, sessionId: "session-a", roundId: "round-1" });
  assert.equal(claim.pid, process.pid);
  assert.equal(claim.hostname, os.hostname());

  const inspected = await inspectClaim({ outputRoot: root, sessionId: "session-a" });
  assert.equal(inspected.claimed, true);
  assert.equal(inspected.ownedByThisProcess, true);
  assert.equal(inspected.alive, true);
  assert.match(inspected.reason, /this process/);

  await releaseSession({ outputRoot: root, sessionId: "session-a" });
  assert.equal(await readClaim({ outputRoot: root, sessionId: "session-a" }), null);
  assert.equal((await inspectClaim({ outputRoot: root, sessionId: "session-a" })).claimed, false);
});

test("a claim from a dead pid is recognized as abandoned", async (t) => {
  const root = tempRoot(t);
  await claimSession({ outputRoot: root, sessionId: "session-dead" });
  // Rewrite the claim with a pid that cannot be running.
  const file = path.join(root, "sessions", "active", "session-dead.json");
  const claim = JSON.parse(await fsp.readFile(file, "utf8"));
  await fsp.writeFile(file, JSON.stringify({ ...claim, pid: 2 ** 22 }));

  const inspected = await inspectClaim({ outputRoot: root, sessionId: "session-dead" });
  assert.equal(inspected.claimed, true);
  assert.equal(inspected.alive, false);
  assert.match(inspected.reason, /no longer running/);
});

test("a claim from another host is assumed alive (liveness is uncheckable from here)", async (t) => {
  const root = tempRoot(t);
  await claimSession({ outputRoot: root, sessionId: "session-remote" });
  const file = path.join(root, "sessions", "active", "session-remote.json");
  const claim = JSON.parse(await fsp.readFile(file, "utf8"));
  await fsp.writeFile(file, JSON.stringify({ ...claim, hostname: "some-other-box", pid: 2 ** 22 }));

  const inspected = await inspectClaim({ outputRoot: root, sessionId: "session-remote" });
  // Never force-finalize a session another machine might be executing.
  assert.equal(inspected.alive, true);
  assert.equal(inspected.sameHost, false);
  assert.match(inspected.reason, /another host/);
});

test("listClaims can prune dead claims and leaves live ones alone", async (t) => {
  const root = tempRoot(t);
  await claimSession({ outputRoot: root, sessionId: "live-one" });
  await claimSession({ outputRoot: root, sessionId: "dead-one" });
  const deadFile = path.join(root, "sessions", "active", "dead-one.json");
  const dead = JSON.parse(await fsp.readFile(deadFile, "utf8"));
  await fsp.writeFile(deadFile, JSON.stringify({ ...dead, pid: 2 ** 22 }));

  const before = await listClaims({ outputRoot: root });
  assert.equal(before.length, 2);
  await listClaims({ outputRoot: root, pruneDead: true });
  const after = await listClaims({ outputRoot: root });
  assert.deepEqual(
    after.map((item) => item.sessionId),
    ["live-one"],
  );
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2 ** 22), false);
  assert.equal(isProcessAlive("nope"), false);
});

test("Z-O: cancel refuses to force-finalize a session another live process owns", async (t) => {
  const workspace = await makeWorkspace(t);
  // A session document stuck in `running`, plus a live claim held by THIS process
  // (which is not in `activeSessions`, exactly like a second app instance).
  const session = await workspace.store.writeSession({
    id: "session-owned",
    status: "running",
    createdAt: Date.now(),
    request: {},
    rounds: [],
    testFile: { id: "f", name: "f", path: "f.json" },
  });
  await claimSession({ outputRoot: workspace.outputRoot, sessionId: session.id });

  const refused = await cancelTestSession(session.id, {}, { store: workspace.store });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "session-owned-elsewhere");
  assert.match(refused.error.message, /still running/);
  assert.equal(refused.claim.pid, process.pid);
  // The document was NOT overwritten — that is the whole point.
  const after = await workspace.store.readSession(session.id);
  assert.equal(after.status, "running");
});

test("Z-O: cancel DOES force-finalize a genuinely abandoned session", async (t) => {
  const workspace = await makeWorkspace(t);
  const session = await workspace.store.writeSession({
    id: "session-abandoned",
    status: "running",
    createdAt: Date.now(),
    request: {},
    rounds: [],
    testFile: { id: "f", name: "f", path: "f.json" },
  });
  // No claim at all = nothing is executing it.
  const cancelled = await cancelTestSession(session.id, { reason: "nightly sweep" }, { store: workspace.store });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.forced, true);
  assert.equal(cancelled.orphaned, true);
  const after = await workspace.store.readSession(session.id);
  assert.equal(after.status, "cancelled");
  assert.match(after.cancelReason, /no on-disk claim exists/);
});

// --- Z-O: process isolation --------------------------------------------------

test("process isolation is opt-in and both switches work", () => {
  const previous = process.env.ZHUZHU_SESSION_PROCESS_ISOLATION;
  delete process.env.ZHUZHU_SESSION_PROCESS_ISOLATION;
  try {
    // Default OFF: the in-process path has real guarded-run mileage, this one
    // does not yet. The switch is the deliverable, not the default.
    assert.equal(isProcessIsolationEnabled({}), false);
    assert.equal(isProcessIsolationEnabled({ processIsolation: true }), true);
    process.env.ZHUZHU_SESSION_PROCESS_ISOLATION = "1";
    assert.equal(isProcessIsolationEnabled({}), true);
    // A per-request `false` still wins over the machine-level switch.
    assert.equal(isProcessIsolationEnabled({ processIsolation: false }), false);
  } finally {
    if (previous === undefined) {
      delete process.env.ZHUZHU_SESSION_PROCESS_ISOLATION;
    } else {
      process.env.ZHUZHU_SESSION_PROCESS_ISOLATION = previous;
    }
  }
});

test("an isolated session runs in a child process, streams events and writes the same artifacts", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);

  const testFile = {
    schemaVersion: 2,
    id: "isolated-file",
    name: "isolated",
    baseUrl: app.baseUrl,
    settings: { evidence: true, evidenceProfile: "fast" },
    cases: [
      {
        id: "case-1",
        name: "一步",
        steps: [
          { id: "s1", type: "assertDom", target: { testId: "demo-category-list" }, property: "exists", expected: true },
        ],
      },
    ],
  };

  const events = [];
  const outcome = await runSessionInWorker({
    request: { testFile, authProfile: "wk" },
    options: {
      outputRoot: workspace.outputRoot,
      outputRunsRoot: workspace.outputRunsRoot,
      testWorkflowsRoot: workspace.testWorkflowsRoot,
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(outcome.ok, true, JSON.stringify(outcome.error || outcome));
  assert.equal(outcome.isolated, true);
  assert.equal(outcome.response.status, "passed", JSON.stringify(outcome.response));
  // Events crossed the process boundary, so the parent's stream is whole.
  assert.ok(events.some((event) => event.type === "step-complete"), JSON.stringify(events.map((e) => e.type)));

  // Process isolation must NOT change the evidence layout — the same session
  // directory, round and aggregate a normal run produces.
  const session = await workspace.store.readSession(outcome.response.sessionId);
  assert.ok(session, "the child writes the session document itself");
  const round = (session.rounds || []).at(-1);
  assert.ok(round?.aggregatePath && fs.existsSync(round.aggregatePath));
  assert.ok(round.evidenceBundles?.length >= 1, "evidence bundles are produced identically");
});

test("killing an isolated session is immediate and reported as a cancel, not an engine error", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);

  const testFile = {
    schemaVersion: 2,
    id: "isolated-slow",
    name: "slow",
    baseUrl: app.baseUrl,
    settings: { evidence: true, evidenceProfile: "fast" },
    cases: [
      {
        id: "case-1",
        name: "很多步",
        steps: [{
          id: "blocked-until-cancel",
          type: "assertDom",
          target: { testId: "intentionally-absent" },
          property: "exists",
          expected: true,
          timeoutMs: 60000,
        }],
      },
    ],
  };

  const controller = new AbortController();
  const startedAt = Date.now();
  const promise = runSessionInWorker({
    request: { testFile, authProfile: "wk" },
    options: {
      outputRoot: workspace.outputRoot,
      outputRunsRoot: workspace.outputRunsRoot,
      testWorkflowsRoot: workspace.testWorkflowsRoot,
    },
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "step-start") controller.abort();
    },
    killGraceMs: 1000,
  });
  const deadline = setTimeout(() => controller.abort(), 20000);
  const outcome = await promise.finally(() => clearTimeout(deadline));
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.killed, true, JSON.stringify({ killed: outcome.killed, error: outcome.error, status: outcome.response?.status }));
  assert.equal(outcome.error.code, "session-killed");
  // The value of Z-O: the caller does not wait for the in-flight step's hard
  // deadline. 40 steps at 3s each would be minutes; this must return in seconds.
  assert.ok(elapsed < 30_000, `cancel took ${elapsed}ms`);
});

test("a worker that cannot even start reports an error instead of hanging", async (t) => {
  const workspace = await makeWorkspace(t);
  const outcome = await runSessionInWorker({
    // No test file at all: the child fails fast inside createTestSession.
    request: { testFilePath: "does-not-exist.json", authProfile: "wk" },
    options: {
      outputRoot: workspace.outputRoot,
      outputRunsRoot: workspace.outputRunsRoot,
      testWorkflowsRoot: workspace.testWorkflowsRoot,
    },
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error);
  assert.ok(outcome.error.code);
});
