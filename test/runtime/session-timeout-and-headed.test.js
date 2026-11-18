const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TestSessionStore } = require("../../runtime/server/session-store");
const { createTestSession } = require("../../runtime/server/test-session-runner");
const { runHeadlessBatch } = require("../../src/main/desktop-runtime-routes");
const { runBatch: runParallelBatch } = require("../../runtime/server/parallel-batch-runner");

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function sampleTestFile() {
  return {
    schemaVersion: 2,
    id: "session-file",
    name: "Session File",
    baseUrl: "http://example.test/login",
    setup: { steps: [{ id: "root-setup", type: "capture" }] },
    teardown: { steps: [{ id: "root-teardown", type: "capture" }], alwaysRun: true },
    cases: [
      { id: "case-a", name: "Case A", priority: "P0", steps: [{ id: "case-a-step", type: "capture" }] },
      { id: "case-b", name: "Case B", priority: "P1", steps: [{ id: "case-b-step", type: "capture" }] },
    ],
  };
}

// Minimal passing runImpl that records the options it was handed.
function recordingRun({ hangOn = null } = {}) {
  const calls = [];
  const runImpl = async (payload, options) => {
    calls.push(options);
    if (hangOn && String(options.runId).includes(hangOn)) {
      // The reported failure mode: a run that never comes back.
      return new Promise(() => {});
    }
    const steps = Array.isArray(payload) ? payload : [];
    return {
      ok: true,
      type: "batch",
      data: { results: steps.map(() => ({ ok: true })) },
      telemetry: { durationMs: 1, steps: steps.length, okCount: steps.length, errorCount: 0, browserUrl: null },
      evidence: { steps: [], runId: options.runId },
    };
  };
  return { calls, runImpl };
}

async function prepare() {
  const outputRoot = await makeTempRoot("zhuzhu-z12-session-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-z12-workflows-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "session-file.json"), sampleTestFile());
  return {
    outputRoot,
    testWorkflowsRoot,
    store: new TestSessionStore({ outputRoot }),
    outputRunsRoot: path.join(outputRoot, "runs"),
  };
}

// --- REQ-Z12-3: a headless session always terminates and always writes a round

test("a hung headless session still produces rounds/aggregate.json and returns (Z12-3)", async () => {
  const env = await prepare();
  const fake = recordingRun({ hangOn: "root-setup" });
  const startedAt = Date.now();

  const result = await createTestSession(
    {
      testFilePath: "session-file.json",
      authProfile: "demo-local",
      scope: "all",
      // Tiny budget so the test is fast; the platform default is minutes.
      sessionTimeoutMs: 200,
    },
    { ...env, runImpl: fake.runImpl },
  );

  // The reported symptom was: only session.json, never an aggregate, no response.
  assert.ok(result.response.sessionId, "the call returned instead of hanging");
  assert.equal(result.response.status, "failed");
  const roundDir = path.join(env.outputRoot, "sessions", result.response.sessionId, "rounds", "round-1");
  const aggregate = JSON.parse(await fs.readFile(path.join(roundDir, "aggregate.json"), "utf8"));
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.rootSetupResult.error.code, "session-hard-timeout");
  // The diagnosis + report are written too, so the caller has something to read.
  await fs.access(path.join(roundDir, "diagnosis.json"));
  await fs.access(path.join(roundDir, "report.md"));
  assert.ok(Date.now() - startedAt < 20000, "bounded, not an infinite stall");
});

test("once the session budget is gone the remaining cases are abandoned, not each given a fresh budget (Z12-3)", async () => {
  const env = await prepare();
  // Every run hangs -> without the early break this would cost one budget per case.
  const fake = recordingRun({ hangOn: "-" });
  const startedAt = Date.now();
  const result = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", sessionTimeoutMs: 200 },
    { ...env, runImpl: fake.runImpl },
  );
  assert.equal(result.response.status, "failed");
  // Only the root setup was attempted; cases + teardown were skipped.
  assert.equal(fake.calls.length, 1);
  assert.ok(Date.now() - startedAt < 20000);
});

test("a run wedged between steps is abandoned by the idle watchdog long before the session ceiling (2026-10-27)", async () => {
  const env = await prepare();
  // Hangs without ever emitting a run event — the shape of session-20261027-112316.
  const fake = recordingRun({ hangOn: "root-setup" });
  const startedAt = Date.now();
  const result = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", sessionTimeoutMs: 60_000, sessionIdleTimeoutMs: 300 },
    { ...env, runImpl: fake.runImpl },
  );
  assert.equal(result.response.status, "failed");
  const roundDir = path.join(env.outputRoot, "sessions", result.response.sessionId, "rounds", "round-1");
  const aggregate = JSON.parse(await fs.readFile(path.join(roundDir, "aggregate.json"), "utf8"));
  assert.equal(aggregate.rootSetupResult.error.code, "session-idle-timeout");
  assert.ok(Date.now() - startedAt < 10_000, "idle watchdog fired, not the 60s ceiling");
});

test("sessionIdleTimeoutMs: 0 disables the idle watchdog (the session ceiling still applies)", async () => {
  const env = await prepare();
  const fake = recordingRun({ hangOn: "root-setup" });
  const result = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", sessionTimeoutMs: 400, sessionIdleTimeoutMs: 0 },
    { ...env, runImpl: fake.runImpl },
  );
  const roundDir = path.join(env.outputRoot, "sessions", result.response.sessionId, "rounds", "round-1");
  const aggregate = JSON.parse(await fs.readFile(path.join(roundDir, "aggregate.json"), "utf8"));
  assert.equal(aggregate.rootSetupResult.error.code, "session-hard-timeout");
});

test("stopOnFailure:false reaches the case runs only; setup/teardown keep stopping (2026-10-27)", async () => {
  const env = await prepare();
  const fake = recordingRun();
  await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", stopOnFailure: false },
    { ...env, runImpl: fake.runImpl },
  );
  const caseRuns = fake.calls.filter((o) => /case-[ab]$/.test(String(o.runId)));
  assert.equal(caseRuns.length, 2);
  for (const o of caseRuns) assert.equal(o.stopOnFailure, false);
  for (const o of fake.calls.filter((o) => !/case-[ab]$/.test(String(o.runId)))) assert.equal(o.stopOnFailure, true);
});

test("a healthy session is unaffected by the deadline and still runs every phase (no regression)", async () => {
  const env = await prepare();
  const fake = recordingRun();
  const result = await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all" },
    { ...env, runImpl: fake.runImpl },
  );
  assert.equal(result.response.status, "passed");
  assert.equal(fake.calls.length, 4, "root setup + 2 cases + teardown");
  // Every run got a positive remaining budget handed down to run().
  for (const options of fake.calls) {
    assert.ok(options.runTimeoutMs > 0, "run() receives the remaining wall-clock budget");
  }
});

// --- Z10: parallel multi-instance *visible* execution ---------------------

test("headless is the default; `headed: true` runs the session in a visible browser (Z10)", async () => {
  const env = await prepare();
  const headlessRun = recordingRun();
  await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all" },
    { ...env, runImpl: headlessRun.runImpl },
  );
  assert.equal(headlessRun.calls.every((options) => options.headless === true), true);

  const headedEnv = await prepare();
  const headedRun = recordingRun();
  const launched = [];
  await createTestSession(
    { testFilePath: "session-file.json", authProfile: "demo-local", scope: "all", headed: true },
    {
      ...headedEnv,
      runImpl: headedRun.runImpl,
      launchBrowser: async (options) => {
        launched.push(options);
        return { close: async () => {} };
      },
    },
  );
  assert.equal(headedRun.calls.every((options) => options.headless === false), true);
  // The session's own browser is launched visible too.
  assert.deepEqual(launched.map((item) => item.headless), [false]);
});

test("POST /app-runs/batch forces visible mode on every item and reports the concurrency (Z10)", async () => {
  const env = await prepare();
  const seen = [];
  const { statusCode, payload } = await runHeadlessBatch(
    {
      items: [
        { testFilePath: "session-file.json", authProfile: "demo-local" },
        // An item that tries to opt out of visible mode must not win.
        { testFilePath: "session-file.json", authProfile: "demo-local", headed: false },
        { testFilePath: "session-file.json", authProfile: "demo-local" },
      ],
      concurrency: 2,
    },
    {
      runBatch: runParallelBatch,
      createTestSession: async (request) => {
        seen.push(request);
        return { response: { ok: true, sessionId: `s-${seen.length}`, status: "passed" } };
      },
      store: env.store,
      outputRoot: env.outputRoot,
      testWorkflowsRoot: env.testWorkflowsRoot,
      outputRunsRoot: env.outputRunsRoot,
      forceHeaded: true,
    },
  );

  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.headed, true);
  assert.equal(payload.data.concurrency, 2);
  assert.equal(payload.data.sessions.length, 3);
  assert.equal(seen.length, 3);
  assert.equal(seen.every((request) => request.headed === true), true, "forceHeaded is not per-item overridable");
});

test("the headless batch route still defaults to headless (Z10 channels stay separate)", async () => {
  const env = await prepare();
  const seen = [];
  const { payload } = await runHeadlessBatch(
    { items: [{ testFilePath: "session-file.json" }] },
    {
      runBatch: runParallelBatch,
      createTestSession: async (request) => {
        seen.push(request);
        return { response: { ok: true, sessionId: "s-1", status: "passed" } };
      },
      store: env.store,
      outputRoot: env.outputRoot,
      testWorkflowsRoot: env.testWorkflowsRoot,
      outputRunsRoot: env.outputRunsRoot,
    },
  );
  assert.equal(payload.data.headed, false);
  assert.equal(seen[0].headed, undefined, "no headed flag is injected into the headless channel");
});

test("session-store whitelists the new request fields", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-z12-store-");
  const store = new TestSessionStore({ outputRoot });
  const session = await store.createSession({ request: { headed: true, sessionTimeoutMs: 1234 } });
  assert.equal(session.request.headed, true);
  assert.equal(session.request.sessionTimeoutMs, 1234);
  const defaults = await store.createSession({ request: {} });
  assert.equal(defaults.request.headed, false);
  assert.equal(defaults.request.sessionTimeoutMs, 0, "0 means: use the platform default");
});
