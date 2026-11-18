const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TestSessionStore } = require("../../runtime/server/session-store");
const { createTestSession } = require("../../runtime/server/test-session-runner");

// v1.10 session-level changes: Z28-1 (variables flow root setup → cases →
// teardown) and Z27 (the run target is supplied by the caller).

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

// A fake `run()` that honours one convention: a step carrying `fakeCapture:
// { name, value }` captures that variable, exactly like a `saveAs` would.
function createCapturingRun() {
  const calls = [];
  const runImpl = async (steps, options) => {
    calls.push({ steps, options: JSON.parse(JSON.stringify(options, (key, value) => (key === "signal" || key === "onEvent" ? undefined : value))) });
    const runtimeVariables = { ...(options.runtimeVariables || {}) };
    const runtimeVariableSources = {
      ...Object.fromEntries(Object.keys(options.runtimeVariables || {}).map((key) => [key, "override"])),
      ...(options.runtimeVariableSources || {}),
    };
    for (const step of steps) {
      if (step.fakeCapture) {
        runtimeVariables[step.fakeCapture.name] = step.fakeCapture.value;
        runtimeVariableSources[step.fakeCapture.name] = "capture";
      }
    }
    const results = steps.map((step, index) => ({ ok: true, type: step.type, index, input: step, data: { trace: { durationMs: 1 } } }));
    return {
      ok: true,
      type: "batch",
      data: { results },
      error: null,
      telemetry: { durationMs: steps.length, steps: steps.length, okCount: steps.length, errorCount: 0, browserUrl: options.url || "" },
      testContext: options.testContext,
      runContext: options.runContext,
      runtimeVariables,
      runtimeVariableSources,
      evidence: { runDir: `/tmp/${options.runId}`, steps: [] },
    };
  };
  return { runImpl, calls };
}

async function startSession(testFile, body = {}, extra = {}) {
  // <workspace>/output — the credential store lives at the workspace root.
  const workspaceRoot = await makeTempRoot("zz-v110-ws-");
  const outputRoot = path.join(workspaceRoot, "output");
  if (extra.credentials) {
    await writeJson(path.join(workspaceRoot, ".zhuzhu-credentials.json"), extra.credentials);
  }
  const testWorkflowsRoot = await makeTempRoot("zz-v110-workflows-");
  await writeJson(path.join(outputRoot, "auth-profiles", "demo-local", "storageState.json"), { cookies: [], origins: [] });
  await writeJson(path.join(testWorkflowsRoot, "file.json"), testFile);
  const store = new TestSessionStore({ outputRoot });
  const fake = extra.fake || createCapturingRun();
  const result = await createTestSession(
    { testFilePath: "file.json", authProfile: "demo-local", scope: "all", ...body },
    {
      store,
      outputRoot,
      testWorkflowsRoot,
      outputRunsRoot: path.join(outputRoot, "runs"),
      runImpl: fake.runImpl,
      ...(extra.options || {}),
    },
  );
  return { result, fake, store, outputRoot, workspaceRoot };
}

test("v1.10 Z28-1: a root-setup capture reaches every case and the root teardown, beating the file's empty placeholder", async () => {
  const { result, fake } = await startSession({
    schemaVersion: 2,
    id: "vars-file",
    name: "Vars",
    baseUrl: "http://example.test/",
    vars: { cardId: "" },
    setup: { steps: [{ id: "root-capture", type: "capture", fakeCapture: { name: "cardId", value: "2104963408662110212" } }] },
    teardown: { steps: [{ id: "root-teardown", type: "capture" }], alwaysRun: true },
    cases: [
      { id: "case-a", name: "A", steps: [{ id: "a1", type: "capture", fakeCapture: { name: "fromA", value: "A-1" } }] },
      { id: "case-b", name: "B", steps: [{ id: "b1", type: "capture" }] },
    ],
  });
  assert.equal(result.response.status, "passed");
  const [rootSetup, caseA, caseB, teardown] = fake.calls;
  assert.equal(rootSetup.options.runtimeVariables.cardId, "", "root setup starts from the file placeholder");
  assert.equal(rootSetup.options.runtimeVariableSources.cardId, "file");
  assert.equal(caseA.options.runtimeVariables.cardId, "2104963408662110212");
  assert.equal(caseA.options.runtimeVariableSources.cardId, "capture");
  assert.equal(caseB.options.runtimeVariables.cardId, "2104963408662110212");
  assert.equal(caseB.options.runtimeVariables.fromA, "A-1", "captures flow in execution order, like the panel channel");
  assert.equal(teardown.options.runtimeVariables.cardId, "2104963408662110212");
  assert.equal(teardown.options.runtimeVariables.fromA, "A-1", "teardown can clean up what a case created");
});

// ---- Z27: run target -------------------------------------------------------

function targetedFile(extra = {}) {
  return {
    schemaVersion: 2,
    id: "targeted",
    name: "Targeted",
    baseUrl: "{{origin.app}}/demoWorkflow",
    vars: { spu: "file-spu" },
    recovery: {
      login: {
        detect: { urlIncludes: "/login" },
        steps: [{ id: "login-user", type: "fill", target: { placeholder: "账号" }, value: "{{credential.username}}" }],
      },
    },
    cases: [
      {
        id: "c1",
        name: "C1",
        steps: [
          { id: "open", type: "openUrl", url: "{{origin.app}}/demoOrders" },
          { id: "api", type: "callApi", request: { method: "POST", url: "{{origin.web}}/api/list" } },
        ],
      },
    ],
    ...extra,
  };
}

const reachable = async () => ({ ok: true, status: 200 });

test("v1.10 Z27: a file that references {{origin.*}} without a target is rejected before any session exists", async () => {
  await assert.rejects(
    startSession(targetedFile(), {}, { options: { probeTargetOrigin: reachable } }),
    (error) => {
      assert.equal(error.code, "target-origin-missing");
      assert.equal(error.statusCode, 400);
      assert.deepEqual(error.details.missing, ["app", "web"]);
      return true;
    },
  );
});

test("v1.10 Z27: a target missing one referenced origin is rejected — no fallback", async () => {
  await assert.rejects(
    startSession(targetedFile(), { target: { origins: { app: "http://198.51.100.3:8004" } } }, { options: { probeTargetOrigin: reachable } }),
    (error) => error.code === "target-origin-missing" && error.details.missing.join() === "web",
  );
});

test("v1.10 Z27: origins are substituted everywhere and the target is recorded in runContext", async () => {
  const { result, fake } = await startSession(
    targetedFile(),
    { target: { origins: { app: "http://198.51.100.3:8004/", web: "http://198.51.100.3:8041" }, vars: { spu: "target-spu" } } },
    { options: { probeTargetOrigin: reachable } },
  );
  assert.equal(result.response.status, "passed");
  const call = fake.calls.find((item) => item.steps.some((step) => step.id === "open"));
  assert.equal(call.options.url, "http://198.51.100.3:8004/demoWorkflow", "trailing slash trimmed, baseUrl materialised");
  assert.equal(call.steps.find((step) => step.id === "open").url, "http://198.51.100.3:8004/demoOrders");
  assert.equal(call.steps.find((step) => step.id === "api").request.url, "http://198.51.100.3:8041/api/list");
  assert.equal(JSON.stringify(call.options.recovery).includes("{{origin"), false, "recovery is materialised too");
  assert.equal(call.options.runtimeVariables.spu, "target-spu", "target vars beat file vars");
  assert.equal(call.options.runtimeVariableSources.spu, "target");
  assert.deepEqual(call.options.runContext.target.origins, { app: "http://198.51.100.3:8004", web: "http://198.51.100.3:8041" });
  assert.deepEqual(call.options.runContext.target.usedOrigins, ["app", "web"]);
  assert.equal(call.options.runContext.target.probes.length, 2);
});

test("v1.10 Z27: an unreachable origin blocks the session as an environment problem and runs nothing", async () => {
  const { result, fake } = await startSession(
    targetedFile(),
    { target: { origins: { app: "http://198.51.100.3:8004", web: "http://198.51.100.3:8041" } } },
    {
      options: {
        probeTargetOrigin: async (url) => (url.includes(":8041") ? { ok: false, status: null, error: "ECONNREFUSED" } : { ok: true, status: 200 }),
      },
    },
  );
  assert.equal(fake.calls.length, 0, "nothing was run");
  assert.equal(result.response.status, "blocked");
  assert.equal(result.diagnosis.failureType, "target-unavailable");
  assert.match(result.diagnosis.firstFailure.message, /web http:\/\/198\.51\.100\.3:8041 \(ECONNREFUSED\)/);
});

test("v1.10 Z27: preflight:false skips the origin probe", async () => {
  let probed = 0;
  const { result } = await startSession(
    targetedFile(),
    { target: { origins: { app: "http://198.51.100.3:8004", web: "http://198.51.100.3:8041" }, preflight: false } },
    { options: { probeTargetOrigin: async () => { probed += 1; return { ok: false, status: null }; } } },
  );
  assert.equal(probed, 0);
  assert.equal(result.response.status, "passed");
});

test("v1.10 Z27: a production host is refused, as an origin or as a legacy literal baseUrl", async () => {
  await assert.rejects(
    startSession(targetedFile(), { target: { origins: { app: "https://app.production.example.org", web: "http://198.51.100.3:8041" } } }),
    (error) => error.code === "target-origin-denied" && error.details.pattern === "*.production.example.org",
  );
  await assert.rejects(
    startSession({
      schemaVersion: 2,
      id: "legacy",
      name: "Legacy",
      baseUrl: "https://app.production.example.org/login",
      cases: [{ id: "c", name: "c", steps: [{ id: "s", type: "capture" }] }],
    }),
    (error) => error.code === "target-origin-denied",
  );
});

test("v1.10 Z27: authProfile and target.authProfile must agree", async () => {
  await assert.rejects(
    startSession(targetedFile(), {
      authProfile: "demo-local",
      target: { origins: { app: "http://198.51.100.3:8004", web: "http://198.51.100.3:8041" }, authProfile: "demo-limited" },
    }),
    (error) => error.code === "target-auth-profile-conflict",
  );
});

test("v1.10 Z27: credentialRef injects credential.<field> and marks only its secret fields for masking", async () => {
  const { result, fake } = await startSession(
    targetedFile(),
    { target: { origins: { app: "http://198.51.100.3:8004", web: "http://198.51.100.3:8041" }, credentialRef: "qa-admin" } },
    {
      credentials: { "qa-admin": { username: "demo-user", password: "S3cret-PW-1" } },
      options: { probeTargetOrigin: reachable },
    },
  );
  assert.equal(result.response.status, "passed");
  const call = fake.calls[0];
  assert.equal(call.options.runtimeVariables["credential.username"], "demo-user");
  assert.equal(call.options.runtimeVariables["credential.password"], "S3cret-PW-1");
  assert.deepEqual(call.options.secretValues, ["S3cret-PW-1"], "the username is not a secret");
  assert.equal(call.options.runContext.target.credentialRef, "qa-admin");
  assert.equal(JSON.stringify(call.options.runContext).includes("S3cret-PW-1"), false);
});

test("v1.10 Z27: an unknown credentialRef blocks the session (target-unavailable)", async () => {
  const { result, fake } = await startSession(
    targetedFile(),
    { target: { origins: { app: "http://198.51.100.3:8004", web: "http://198.51.100.3:8041" }, credentialRef: "nobody" } },
    { credentials: { "qa-admin": { username: "u", password: "pw-x" } }, options: { probeTargetOrigin: reachable } },
  );
  assert.equal(fake.calls.length, 0);
  assert.equal(result.response.status, "blocked");
  assert.equal(result.diagnosis.failureType, "target-unavailable");
});

test("v1.10 Z27-5: a secret never reaches disk, events or the returned result, though a real step used it", async () => {
  const http = require("node:http");
  const { run } = require("../../runtime");
  const secret = "S3cret-PW-zz";
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/login")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ success: true, echo: JSON.parse(body || "{}") }));
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><html><body><main><input placeholder=\"密码\" /></main></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const outputDir = await makeTempRoot("zz-v110-redact-");
  const events = [];
  try {
    const result = await run(
      [
        { id: "pw", type: "fill", target: { placeholder: "密码" }, value: "{{credential.password}}", needRes: true },
        {
          id: "login",
          type: "callApi",
          request: { method: "POST", url: `${base}/api/login`, body: { password: "{{credential.password}}" } },
          expectation: { kind: "assertResponse", status: 200, body: [{ path: "echo.password", operator: "equals", expected: "{{credential.password}}" }] },
          needRes: true,
        },
      ],
      {
        url: `${base}/`,
        outputDir,
        headless: true,
        runtimeVariables: { "credential.password": secret },
        runtimeVariableSources: { "credential.password": "target" },
        secretValues: [secret],
        onEvent: (event) => events.push(event),
      },
    );
    assert.equal(result.ok, true, "the secret was really sent (the API echoed it back and the assertion matched)");
    assert.equal(JSON.stringify(result).includes(secret), false, "returned result is masked");
    assert.equal(JSON.stringify(events).includes(secret), false, "progress events are masked");
    const leaks = [];
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (!entry.name.endsWith(".png")) {
          if ((await fs.readFile(full, "utf8")).includes(secret)) {
            leaks.push(full);
          }
        }
      }
    };
    await walk(outputDir);
    assert.deepEqual(leaks, [], "no artifact on disk contains the secret");
  } finally {
    server.close();
  }
});
