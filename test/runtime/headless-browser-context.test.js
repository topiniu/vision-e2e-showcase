const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildHeadlessBrowserContext } = require("../../src/shared/browser-launch");
const { TestSessionStore } = require("../../runtime/server/session-store");
const { createTestSession } = require("../../runtime/server/test-session-runner");

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

// Minimal fake `run` that records the options each call was given, so we can
// assert the panel-aligned browser context is threaded all the way down.
function createRecordingRun() {
  const calls = [];
  const runImpl = async (payload, options) => {
    const steps = Array.isArray(payload) ? payload : JSON.parse(payload);
    calls.push({ steps, options });
    return {
      ok: true,
      type: "batch",
      data: { results: [] },
      telemetry: { durationMs: 1, steps: steps.length, okCount: steps.length, errorCount: 0, browserUrl: options.url || "" },
      testContext: options.testContext,
      runContext: options.runContext,
      evidence: { runDir: `/tmp/${options.runId}`, reportPath: `/tmp/${options.runId}/report.json`, steps: [] },
    };
  };
  return { runImpl, calls };
}

// --- Z09: pure headless context derivation -------------------------------

test("browser context preserves TLS, CORS and CSP checks by default", () => {
  const { launchOptions, contextOptions } = buildHeadlessBrowserContext({});
  assert.equal(launchOptions.args.includes("--disable-web-security"), false);
  assert.equal(contextOptions.bypassCSP, undefined);
  assert.equal(contextOptions.ignoreHTTPSErrors, false);
});

test("Z09 buildHeadlessBrowserContext supports explicit compatibility mode", () => {
  const { launchOptions, contextOptions } = buildHeadlessBrowserContext({}, { alignWebSecurity: true });
  assert.ok(launchOptions.args.includes("--disable-web-security"));
  assert.ok(launchOptions.args.includes("--disable-features=IsolateOrigins,site-per-process"));
  assert.equal(contextOptions.bypassCSP, true);
  assert.equal(contextOptions.ignoreHTTPSErrors, true);
});

test("Z09 buildHeadlessBrowserContext preserves proxy and merges its args", () => {
  const { launchOptions } = buildHeadlessBrowserContext(
    { proxy: { server: "http://127.0.0.1:7897", bypass: "*.test.example.org" } }, { alignWebSecurity: true },
  );
  assert.deepEqual(launchOptions.proxy, { server: "http://127.0.0.1:7897", bypass: "*.test.example.org" });
  assert.ok(launchOptions.args.includes("--disable-web-security"));
});

test("Z09 buildHeadlessBrowserContext carries direct-mode --no-proxy-server through", () => {
  const { launchOptions } = buildHeadlessBrowserContext({ args: ["--no-proxy-server"] }, { alignWebSecurity: true });
  assert.ok(launchOptions.args.includes("--no-proxy-server"));
  assert.ok(launchOptions.args.includes("--disable-web-security"));
});

test("Z09 buildHeadlessBrowserContext can opt out of web-security alignment", () => {
  const { launchOptions, contextOptions } = buildHeadlessBrowserContext({}, { alignWebSecurity: false });
  assert.equal(launchOptions.args.includes("--disable-web-security"), false);
  assert.equal(launchOptions.args.includes("--disable-features=IsolateOrigins,site-per-process"), false);
  assert.equal(contextOptions.bypassCSP, undefined);
  assert.equal(contextOptions.ignoreHTTPSErrors, false);
});

// v1.4: memory-safety args are independent of the web-security alignment — they
// are about surviving OOM, so they apply to every headless launch.
test("v1.4 buildHeadlessBrowserContext always passes the memory-safety args", () => {
  for (const options of [{}, { alignWebSecurity: false }]) {
    const { launchOptions } = buildHeadlessBrowserContext({}, options);
    assert.ok(
      launchOptions.args.includes("--disable-dev-shm-usage"),
      "a small /dev/shm makes the renderer die exactly like a real OOM",
    );
    assert.equal(
      launchOptions.args.some((arg) => arg.startsWith("--js-flags=")),
      false,
      "the heap ceiling stays off unless explicitly configured",
    );
  }
});

test("v1.4 an explicit heap ceiling becomes a --js-flags arg", () => {
  const { launchOptions } = buildHeadlessBrowserContext({}, { maxOldSpaceMb: 512 });
  assert.ok(launchOptions.args.includes("--js-flags=--max-old-space-size=512"));
});

// --- Z09: the context is threaded into every headless run ------------------

test("Z09 createTestSession threads browserContext into every runImpl call", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-z09-session-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-z09-workflows-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "qiankun-file.json"), {
    schemaVersion: 2,
    id: "qiankun-file",
    name: "Qiankun File",
    baseUrl: "http://master.test/login",
    cases: [{ id: "case-a", name: "Case A", priority: "P0", steps: [{ id: "case-a-step", type: "capture" }] }],
  });
  const store = new TestSessionStore({ outputRoot });
  const fake = createRecordingRun();
  const browserContext = buildHeadlessBrowserContext({ proxy: { server: "http://127.0.0.1:7897" } });

  const result = await createTestSession({
    testFilePath: "qiankun-file.json",
    authProfile: "demo-local",
    scope: "all",
  }, {
    store,
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: fake.runImpl,
    browserContext,
  });

  assert.equal(result.response.status, "passed");
  assert.ok(fake.calls.length >= 1);
  for (const call of fake.calls) {
    assert.deepEqual(call.options.launchOptions, browserContext.launchOptions);
    assert.deepEqual(call.options.contextOptions, browserContext.contextOptions);
    assert.equal(call.options.headless, true);
  }
});

test("Z09 createTestSession without browserContext leaves runImpl options unset", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-z09-nobc-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-z09-nobc-wf-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "plain-file.json"), {
    schemaVersion: 2,
    id: "plain-file",
    name: "Plain File",
    baseUrl: "http://master.test/login",
    cases: [{ id: "case-a", name: "Case A", priority: "P0", steps: [{ id: "case-a-step", type: "capture" }] }],
  });
  const store = new TestSessionStore({ outputRoot });
  const fake = createRecordingRun();

  await createTestSession({
    testFilePath: "plain-file.json",
    authProfile: "demo-local",
    scope: "all",
  }, {
    store,
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: fake.runImpl,
  });

  for (const call of fake.calls) {
    assert.equal(call.options.launchOptions, undefined);
    assert.equal(call.options.contextOptions, undefined);
  }
});
