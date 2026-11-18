const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { captureAuthProfile, getAuthProfileStatus, resetAuthProfile } = require("../../runtime/server/auth-profile");
const { createDiagnosis } = require("../../runtime/server/diagnosis");
const { TestSessionStore } = require("../../runtime/server/session-store");
const { createServer } = require("../../runtime/server/http");
const {
  createTestSession,
  filterAuthenticatedAuthBootstrapSteps,
} = require("../../runtime/server/test-session-runner");

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
    setup: {
      steps: [{ id: "root-setup", type: "capture" }],
    },
    teardown: {
      steps: [{ id: "root-teardown", type: "capture" }],
      alwaysRun: true,
    },
    fixtures: {
      loggedIn: {
        setup: [{ id: "fixture-setup", type: "capture" }],
        teardown: [{ id: "fixture-teardown", type: "capture" }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "Case A",
        priority: "P0",
        fixtures: ["loggedIn"],
        steps: [{ id: "case-a-step", type: "capture" }],
      },
      {
        id: "case-b",
        name: "Case B",
        priority: "P1",
        steps: [{ id: "case-b-step", type: "capture" }],
      },
    ],
  };
}

function createFakeRun({ failStepId = null } = {}) {
  const calls = [];
  const runImpl = async (payload, options) => {
    const steps = Array.isArray(payload) ? payload : JSON.parse(payload);
    calls.push({ steps, options });
    const failedIndex = failStepId ? steps.findIndex((step) => step.id === failStepId) : -1;
    const results = steps.map((step, index) => {
      const failed = index === failedIndex;
      return {
        ok: !failed,
        type: step.type || step.kind || "capture",
        index,
        input: step,
        error: failed
          ? {
              code: "expectation-not-met",
              message: "Expected true but got false.",
              details: {
                expectation: {
                  ok: false,
                  type: "expectDom",
                  property: "visible",
                  expected: true,
                  actual: false,
                },
              },
            }
          : null,
        evidence: {
          tracePath: `/tmp/${options.runId}/${String(index + 1).padStart(2, "0")}-trace.json`,
          afterScreenshotPath: `/tmp/${options.runId}/${String(index + 1).padStart(2, "0")}-after.png`,
        },
        data: {
          expectation: failed
            ? {
                ok: false,
                type: "expectDom",
                property: "visible",
                expected: true,
                actual: false,
              }
            : null,
          trace: { durationMs: 5 },
        },
      };
    });
    const ok = failedIndex < 0;
    return {
      ok,
      type: "batch",
      data: { results },
      error: ok ? null : results[failedIndex].error,
      telemetry: {
        durationMs: steps.length * 5,
        steps: steps.length,
        okCount: results.filter((item) => item.ok).length,
        errorCount: results.filter((item) => !item.ok).length,
        browserUrl: options.url || "",
      },
      testContext: options.testContext,
      runContext: options.runContext,
      evidence: {
        runDir: `/tmp/${options.runId}`,
        reportPath: `/tmp/${options.runId}/report.json`,
        steps: results.map((item) => item.evidence),
      },
    };
  };
  return { runImpl, calls };
}

test("auth profile status reads and resets storageState", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-auth-");
  const storageStatePath = path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json");
  await writeJson(storageStatePath, { cookies: [], origins: [] });

  const ready = await getAuthProfileStatus("demo-local", { outputRoot });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, "ready");

  const reset = await resetAuthProfile("demo-local", { outputRoot });
  assert.equal(reset.ok, true);

  const missing = await getAuthProfileStatus("demo-local", { outputRoot });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "auth-missing");
});

test("auth profile capture persists storageState payload", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-auth-capture-");
  const result = await captureAuthProfile("demo-local", {
    outputRoot,
    storageState: {
      cookies: [{ name: "sid", value: "abc", domain: "example.test", path: "/" }],
      origins: [{ origin: "http://example.test", localStorage: [{ name: "token", value: "t1" }] }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready");
  assert.equal(result.cookieCount, 1);
  assert.equal(result.originCount, 1);

  const ready = await getAuthProfileStatus("demo-local", { outputRoot });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, "ready");
  assert.equal(ready.authenticated, true);
});

test("diagnosis classifies auth, locator, assertion, and browser failures", () => {
  const auth = createDiagnosis({
    ok: false,
    data: {
      results: [{
        ok: false,
        input: { id: "api", type: "callApi" },
        data: {
          action: {
            apiResponse: { status: 200, body: { code: 601, messageEn: "no login", success: false } },
          },
        },
        error: { code: "expectation-not-met", message: "Response expectation was not met." },
      }],
    },
  });
  assert.equal(auth.failureType, "auth-expired");

  const locator = createDiagnosis({
    ok: false,
    data: { results: [{ ok: false, input: { id: "click", type: "click" }, error: { code: "target-not-found", message: "target-not-found" } }] },
  });
  assert.equal(locator.failureType, "locator-not-found");

  const assertion = createDiagnosis({
    ok: false,
    data: { results: [{ ok: false, input: { id: "assert", type: "assertVisible" }, error: { code: "expectation-not-met", message: "Expected text not found." } }] },
  });
  assert.equal(assertion.failureType, "assertion-false");

  const browser = createDiagnosis({ ok: false, error: { code: "browser-unavailable", message: "Failed to launch browser." } });
  assert.equal(browser.failureType, "browser-unavailable");
});

test("test session runner creates a passed file-level session and persists feedback", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-session-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-workflows-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "session-file.json"), sampleTestFile());
  const store = new TestSessionStore({ outputRoot });
  const fake = createFakeRun();

  const result = await createTestSession({
    testFilePath: "session-file.json",
    authProfile: "demo-local",
    scope: "all",
    feedback: "first run",
  }, {
    store,
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: fake.runImpl,
  });

  assert.equal(result.response.status, "passed");
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(fake.calls.map((call) => call.steps.map((step) => step.id)), [
    ["root-setup"],
    ["fixture-setup", "case-a-step", "fixture-teardown"],
    ["case-b-step"],
    ["root-teardown"],
  ]);

  const session = await store.readSession(result.response.sessionId);
  assert.equal(session.rounds.length, 1);
  assert.equal(session.feedback[0].message, "first run");
  assert.equal((await fs.readFile(session.rounds[0].reportPath, "utf8")).includes("All selected cases passed."), true);

  const withFeedback = await store.appendFeedback(session.id, { message: "用户确认继续优化" });
  assert.equal(withFeedback.feedback.length, 2);
});

test("test session runner reuses one shared browser across root-setup, cases, and teardown", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-session-reuse-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-workflows-reuse-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "session-file.json"), sampleTestFile());
  const store = new TestSessionStore({ outputRoot });
  const fake = createFakeRun();

  let launched = 0;
  let closed = 0;
  const sharedBrowser = { close: async () => { closed += 1; } };
  const launchBrowser = async () => { launched += 1; return sharedBrowser; };

  const result = await createTestSession({
    testFilePath: "session-file.json",
    authProfile: "demo-local",
    scope: "all",
  }, {
    store,
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: fake.runImpl,
    launchBrowser,
  });

  assert.equal(result.response.status, "passed");
  // One chromium.launch for the whole session (root-setup + 2 cases + teardown = 4 runSteps).
  assert.equal(launched, 1);
  assert.equal(closed, 1);
  assert.equal(fake.calls.length, 4);
  // Every runSteps received the same shared browser to spin its own context off.
  for (const call of fake.calls) {
    assert.equal(call.options.browser, sharedBrowser);
  }
});

test("test session runner honors reuseBrowser=false (no shared browser)", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-session-noreuse-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-workflows-noreuse-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "session-file.json"), sampleTestFile());
  const store = new TestSessionStore({ outputRoot });
  const fake = createFakeRun();

  let launched = 0;
  const launchBrowser = async () => { launched += 1; return { close: async () => {} }; };

  const result = await createTestSession({
    testFilePath: "session-file.json",
    authProfile: "demo-local",
    scope: "all",
    reuseBrowser: false,
  }, {
    store,
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: fake.runImpl,
    launchBrowser,
  });

  assert.equal(result.response.status, "passed");
  assert.equal(launched, 0);
  for (const call of fake.calls) {
    assert.equal(call.options.browser, undefined);
  }
});

test("filterAuthenticatedAuthBootstrapSteps strips the login block for App-run reuse when authenticated", () => {
  // Mirrors common/demo-base.json setup: login block + post-login navs.
  const steps = [
    { id: "setup-login-account-page", phase: "setup", type: "click", target: { text: "账号登陆", role: "tab" } },
    { id: "setup-fill-account", phase: "setup", type: "fill", target: { text: "账号" } },
    { id: "setup-fill-password", phase: "setup", type: "fill", target: { text: "密码" } },
    { id: "setup-click-login", phase: "setup", type: "click", target: { text: "登 录", role: "button" } },
    { id: "setup-nav-product-manage", phase: "setup", type: "click", target: { text: "开品管理" } },
    { id: "setup-nav-demo", phase: "setup", type: "click", target: { text: "示例任务" } },
  ];

  const authed = filterAuthenticatedAuthBootstrapSteps(steps, { authenticated: true }, { authBootstrap: "auto" });
  assert.deepEqual(authed.steps.map((s) => s.id), ["setup-nav-product-manage", "setup-nav-demo"]);
  assert.equal(authed.skipped.length, 4);

  // Not authenticated → keep the full login flow (first file of a session).
  const anon = filterAuthenticatedAuthBootstrapSteps(steps, { authenticated: false }, { authBootstrap: "auto" });
  assert.equal(anon.steps.length, steps.length);

  // authBootstrap:"run" → force login even when authenticated.
  const forced = filterAuthenticatedAuthBootstrapSteps(steps, { authenticated: true }, { authBootstrap: "run" });
  assert.equal(forced.steps.length, steps.length);
});

test("test session runner skips manual login bootstrap when auth profile is authenticated", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-session-auth-guard-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-workflows-auth-guard-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), {
    cookies: [],
    origins: [{
      origin: "http://example.test",
      localStorage: [{ name: "_TOKEN_", value: "token-1" }],
    }],
  });
  await writeJson(path.join(testWorkflowsRoot, "session-file.json"), {
    schemaVersion: 2,
    id: "auth-guard-file",
    name: "Auth Guard File",
    baseUrl: "http://example.test/login",
    setup: {
      steps: [
        { id: "setup-login-account-page", type: "click", target: { text: "账号登陆", role: "tab" } },
        { id: "setup-fill-account", type: "fill", target: { name: "账号", value: "demo-user" } },
        { id: "setup-fill-password", type: "fill", target: { name: "密码", value: "demo-password-not-valid" } },
        { id: "setup-click-login", type: "click", stepTitle: "点击登录", target: { text: "登 录", role: "button" } },
        { id: "setup-nav-business", type: "click", target: { text: "示例任务" } },
      ],
    },
    fixtures: {
      loginFixture: {
        setup: [
          { id: "fixture-login-tab", type: "click", target: { text: "账号登录", role: "tab" } },
          { id: "fixture-login-submit", type: "click", stepTitle: "点击登录", target: { text: "登 录", role: "button" } },
          { id: "fixture-nav-business", type: "click", target: { text: "示例任务" } },
        ],
      },
    },
    cases: [{
      id: "case-a",
      name: "Case A",
      fixtures: ["loginFixture"],
      steps: [{ id: "case-step", type: "capture" }],
    }],
  });
  const store = new TestSessionStore({ outputRoot });
  const fake = createFakeRun();

  const result = await createTestSession({
    testFilePath: "session-file.json",
    authProfile: "demo-local",
    scope: "all",
  }, {
    store,
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: fake.runImpl,
  });

  assert.equal(result.response.status, "passed");
  assert.deepEqual(fake.calls.map((call) => call.steps.map((step) => step.id)), [
    ["setup-nav-business"],
    ["fixture-nav-business", "case-step"],
  ]);
  assert.deepEqual(fake.calls[0].options.runContext.authGuard.skippedStepIds, [
    "setup-login-account-page",
    "setup-fill-account",
    "setup-fill-password",
    "setup-click-login",
  ]);
  assert.deepEqual(fake.calls[1].options.runContext.authGuard.skippedStepIds, [
    "fixture-login-tab",
    "fixture-login-submit",
  ]);

  const forceRun = createFakeRun();
  const forced = await createTestSession({
    testFilePath: "session-file.json",
    authProfile: "demo-local",
    scope: "all",
    authBootstrap: "run",
  }, {
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: forceRun.runImpl,
  });

  assert.equal(forced.response.status, "passed");
  assert.deepEqual(forceRun.calls[0].steps.map((step) => step.id), [
    "setup-login-account-page",
    "setup-fill-account",
    "setup-fill-password",
    "setup-click-login",
    "setup-nav-business",
  ]);
});

test("test session runner blocks missing auth profile with report", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-session-auth-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-workflows-auth-");
  await writeJson(path.join(testWorkflowsRoot, "session-file.json"), sampleTestFile());

  const result = await createTestSession({
    testFilePath: "session-file.json",
    authProfile: "missing-profile",
  }, {
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: createFakeRun().runImpl,
  });

  assert.equal(result.response.status, "blocked");
  assert.equal(result.response.firstFailure.code, "auth-missing");
  const report = await fs.readFile(result.response.reportPath, "utf8");
  assert.equal(report.includes("Auth profile"), true);
});

function requestJson(port, method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: body ? { "content-type": "application/json" } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: response.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.on("error", reject);
    if (body) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

test("http server exposes auth and test session routes", async () => {
  const outputRoot = await makeTempRoot("zhuzhu-http-");
  const testWorkflowsRoot = await makeTempRoot("zhuzhu-http-workflows-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "session-file.json"), sampleTestFile());
  const server = createServer({
    outputRoot,
    testWorkflowsRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    runImpl: createFakeRun().runImpl,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const auth = await requestJson(port, "GET", "/auth/status?profile=demo-local");
    assert.equal(auth.statusCode, 200);
    assert.equal(auth.body.ok, true);

    const captured = await requestJson(port, "POST", "/auth/capture", {
      profile: "demo-local-http",
      storageState: { cookies: [], origins: [] },
    });
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body.status, "ready");

    const capturedStatus = await requestJson(port, "GET", "/auth/status?profile=demo-local-http");
    assert.equal(capturedStatus.body.ok, true);

    const created = await requestJson(port, "POST", "/test-sessions", {
      testFilePath: "session-file.json",
      authProfile: "demo-local",
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.status, "passed");

    const feedback = await requestJson(port, "POST", `/test-sessions/${created.body.sessionId}/feedback`, {
      message: "rerun after review",
    });
    assert.equal(feedback.statusCode, 200);
    assert.equal(feedback.body.data.feedback.length, 1);

    const report = await requestJson(port, "GET", `/test-sessions/${created.body.sessionId}/report`);
    assert.equal(report.statusCode, 200);
    assert.equal(report.body.data.markdown.includes("Zhuzhu Headless Test Report"), true);

    const repair = await requestJson(port, "GET", `/test-sessions/${created.body.sessionId}/repair-context`);
    assert.equal(repair.statusCode, 200);
    assert.equal(repair.body.data.json.schemaVersion, 2);
    assert.equal(repair.body.data.latest.repairContextPath, created.body.repairContextPath);

    const schemas = await requestJson(port, "GET", "/schema/precheck-rules");
    assert.equal(schemas.statusCode, 200);
    assert.equal(Boolean(schemas.body.data["wait-for-change-only-business-proof"]), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
