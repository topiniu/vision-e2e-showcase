"use strict";


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { run } = require("../../runtime");
const { createPageDiagnostics } = require("../../runtime/perception/page-diagnostics");
const { classifyFailureClass, classifyStepFailureClass } = require("../../runtime/reporting/evidence-bundle");
const { buildReachDiagnosis } = require("../../runtime/server/reach-diagnosis");
const { createRepairContext } = require("../../runtime/server/diagnosis");
const { precheckTestFile } = require("../../src/shared/test-file-precheck");
const { buildGateRunOptions } = require("../../src/shared/run-gate-options");
const {
  buildNotFoundError,
  findCapability,
  findCapabilityByMistakenPath,
  listCapabilities,
  listCapabilityRoutes,
} = require("../../src/shared/capability-catalog");
const {
  buildEndpointDocument,
  markEndpointFileStaleSync,
  readEndpointFile,
  writeEndpointFile,
} = require("../../src/shared/service-discovery");
const { getCapabilityData } = require("../../runtime/server/capabilities");
const { createServer } = require("../../runtime/server/http");

const outputRoot = path.join(os.tmpdir(), "zhuzhu-qa-v5-facets");

function createHtmlServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

function readSummary(result) {
  return JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
}

// ---------------------------------------------------------------------------
// REQ-Z22 — authTrace
// ---------------------------------------------------------------------------

// The login page from the real round, reduced: a third-party script throws on
// load (the external SSO script), then a login button navigates to the app.
const LOGIN_HTML = `<!doctype html><html><body>
  <h1>登录</h1>
  <input placeholder="账号" /><input placeholder="密码" type="password" />
  <button data-testid="login-submit" onclick="location.href='/app'">登录</button>
  <script>setTimeout(function(){ throw new Error("SyntaxError: wecom sso cdn noise"); }, 0);</script>
</body></html>`;

const APP_HTML = `<!doctype html><html><body>
  <div data-testid="board">主看板</div>
  <div data-testid="total">99</div>
</body></html>`;

function createAppServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.url.startsWith("/app") ? APP_HTML : LOGIN_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base });
    });
  });
}

test("Z22-3: a run that never triggers recovery still states its auth status (field present, not omitted)", async () => {
  const { server, url } = await createHtmlServer(APP_HTML);
  try {
    const result = await run(
      [{ id: "assert-board", type: "assertDom", target: { testId: "board" }, property: "exists", expected: true }],
      { url, headless: true, outputDir: outputRoot, runId: "z22-3", evidenceProfile: "fast" },
    );
    assert.equal(result.ok, true);
    const summary = readSummary(result);
    assert.notEqual(summary.authTrace, null, "authTrace must exist — an absent field is what forced screenshot-reading");
    assert.equal(summary.authTrace.recovery.triggered, false, "explicitly false, never omitted");
  } finally {
    server.close();
  }
});

test("Z22-2: login succeeds, a later assertion fails -> succeeded=true, failureClass is NOT auth", async () => {
  const { server, base } = await createAppServer();
  try {
    const result = await run(
      [
        // Deliberately wrong expected value: this must be the reason for the red.
        { id: "assert-total", type: "assertDom", target: { testId: "total" }, property: "text", operator: "equals", expected: "42" },
      ],
      {
        url: `${base}/login`,
        headless: true,
        outputDir: outputRoot,
        runId: "z22-2",
        evidenceProfile: "fast",
        recovery: {
          login: {
            detect: { urlIncludes: "/login" },
            skipWhenAuthenticated: false,
            steps: [
              { id: "fill-user", type: "fill", target: { placeholder: "账号" }, value: "qa" },
              { id: "fill-pass", type: "fill", target: { placeholder: "密码" }, value: "pw" },
              { id: "submit", type: "click", target: { testId: "login-submit" } },
            ],
          },
        },
      },
    );

    const summary = readSummary(result);
    assert.equal(summary.authTrace.recovery.triggered, true);
    assert.equal(summary.authTrace.recovery.succeeded, true, "the login DID work — this is the fact the 14h round could not get");
    assert.equal(summary.authTrace.recovery.strategy, "account-password");
    assert.ok(summary.authTrace.recovery.tookMs >= 0);
    assert.match(String(summary.authTrace.recovery.finalUrl), /\/app/);

    // …and the case is red for the assertion, NOT for auth.
    assert.equal(result.ok, false);
    const failureClass = classifyFailureClass({ result, summary });
    assert.notEqual(failureClass, "auth", "recovery.succeeded===true must forbid an auth classification");
    assert.equal(failureClass, "value-assertion");
  } finally {
    server.close();
  }
});

test("Z22-1: a login that fails -> succeeded=false and failureClass=auth", () => {
  const summary = {
    status: "failed",
    firstFailure: { code: "target-not-found", stepId: "click-x" },
    authTrace: {
      profile: "bad-creds",
      statusBefore: "expired",
      recovery: { triggered: true, strategy: "account-password", attempts: 1, succeeded: false, finalUrl: "http://x/login", tookMs: 900 },
    },
  };
  assert.equal(classifyFailureClass({ result: { ok: false }, summary }), "auth");
});

test("Z22-2: repair-context carries the explicit 'login is fine, look elsewhere' note", () => {
  const aggregate = {
    caseResults: [],
    authTrace: { statusBefore: "expired", recovery: { triggered: true, succeeded: true, strategy: "account-password" } },
  };
  const repair = createRepairContext({ aggregate, diagnosis: { status: "failed", firstFailure: {} } });
  assert.ok(Array.isArray(repair.authNote));
  assert.ok(
    repair.authNote.some((note) => note.includes("登录已成功建立")),
    "the note must say login succeeded, so nobody re-derives it from retry screenshots",
  );
  assert.equal(repair.authTrace.recovery.succeeded, true);
});

test("Z22-4: authTrace is inside the signed bundle, so tampering with it is detectable", () => {
  const { buildEvidenceBundle, verifyEvidenceBundle } = require("../../runtime/reporting/evidence-bundle");
  const workspaceRoot = path.join(outputRoot, "z22-4");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const summary = {
    status: "failed",
    firstFailure: { code: "expectation-not-met", expectation: { ok: false, type: "assertDom", expected: "42", actual: "99" } },
    authTrace: {
      profile: "p1",
      statusBefore: "expired",
      recovery: { triggered: true, strategy: "account-password", attempts: 1, succeeded: true, finalUrl: "http://x/app", tookMs: 800 },
      authenticatedAt: 1,
    },
  };
  const bundle = buildEvidenceBundle({ sessionId: "s", caseId: "c1", result: { ok: false }, summary, workspaceRoot });
  assert.equal(bundle.authTrace.recovery.succeeded, true, "authTrace must be part of the bundle, not a side file");
  assert.equal(verifyEvidenceBundle({ bundle, workspaceRoot }).valid, true);

  // Flip the one field somebody would be tempted to flip — "login failed, so the
  // red was not my code's fault" — and the signature must catch it.
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.authTrace.recovery.succeeded = false;
  const verdict = verifyEvidenceBundle({ bundle: tampered, workspaceRoot });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.some((reason) => reason.field === "signature"));
});

// ---------------------------------------------------------------------------
// REQ-Z23 — page-error gate scope
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
test("Z23-1: phase auth-bootstrap is out of the gate by default, but the entry is still recorded", () => {
  const diagnostics = createPageDiagnostics({
    page: null,
    baseUrl: "https://product.example.com/board",
    authPhaseDetects: [{ urlIncludes: "/login" }],
    evaluateDetect: require("../../runtime/executor/recovery").evaluateDetect,
  });
  // Pretend the page is on /login while a third-party CDN script throws.
  diagnostics.readPageUrl = () => "https://sso.thirdparty.example.org/login";
  const entry = diagnostics.record({
    kind: "pageerror",
    message: "SyntaxError: Invalid or unexpected token",
    stack: "at https://sso.cdn.example.org/sso.js:1:1",
  });

  assert.equal(entry.phaseGroup, "auth-bootstrap");
  assert.equal(entry.origin, "third-party");
  assert.equal(diagnostics.takeNewGateFailures().length, 0, "the login window must not turn a case red by default");
  const report = diagnostics.getReport();
  assert.equal(report.total, 1, "the entry is STILL recorded — scoping is not erasing");
  assert.equal(report.phasePolicy["auth-bootstrap"], "off");
  assert.equal(report.phasePolicy["under-test"], "fail");
  assert.equal(report.outOfScope, 1, "and it is visibly out-of-scope rather than silently clean");
});

test("Z23-2: the same message in the under-test phase still turns the case red", () => {
  const diagnostics = createPageDiagnostics({
    page: null,
    baseUrl: "https://product.example.com/board",
    authPhaseDetects: [{ urlIncludes: "/login" }],
    evaluateDetect: require("../../runtime/executor/recovery").evaluateDetect,
  });
  diagnostics.readPageUrl = () => "https://product.example.com/board";
  const entry = diagnostics.record({ kind: "pageerror", message: "SyntaxError: Invalid or unexpected token" });
  assert.equal(entry.phaseGroup, "under-test");
  assert.equal(diagnostics.takeNewGateFailures().length, 1, "scoping must not become a global mute");
});

test("Z23-1: a scoped allowlist entry needs no `match` and only fires inside its scope", () => {
  const options = buildGateRunOptions({
    settings: {
      pageErrorAllowlist: [{ url: "**/login", origin: "third-party", phase: "auth-bootstrap", reason: "SSO CDN noise" }],
      pageErrorPolicy: { "auth-bootstrap": "fail", "under-test": "fail" },
    },
  });
  const { evaluateDetect } = require("../../runtime/executor/recovery");
  const diagnostics = createPageDiagnostics({
    page: null,
    baseUrl: "https://product.example.com/board",
    allowlist: options.pageErrorAllowlist,
    policy: options.pageErrorPolicy,
    authPhaseDetects: [{ urlIncludes: "/login" }],
    evaluateDetect,
  });

  diagnostics.readPageUrl = () => "https://sso.thirdparty.example.org/login";
  const inScope = diagnostics.record({ kind: "pageerror", message: "anything at all", stack: "at https://sso.thirdparty.example.org/x.js:1:1" });
  assert.equal(inScope.suppressed, true, "a scope-only entry silences the whole login-page third-party family");
  assert.equal(inScope.suppressedReason, "SSO CDN noise");

  // Same message, product page: out of scope, so NOT suppressed.
  diagnostics.readPageUrl = () => "https://product.example.com/board";
  const outOfScope = diagnostics.record({ kind: "pageerror", message: "anything at all", stack: "at https://product.example.com/app.js:1:1" });
  assert.equal(outOfScope.suppressed, false);
});

test("Z23-3: a red run reports EVERY distinct noise at once, as paste-ready scoped entries", () => {
  const diagnostics = createPageDiagnostics({ page: null, baseUrl: "https://product.example.com/board" });
  diagnostics.readPageUrl = () => "https://product.example.com/board";
  const noises = [
    ["pageerror", "SyntaxError: Invalid or unexpected token", "at https://sso.cdn.example.org/sso.js:1:1"],
    ["console-error", "Warning: `rowKey` function is deprecated", "at https://product.example.com/app.js:1:1"],
    ["console-error", "Encountered two children with the same key", "at https://product.example.com/app.js:2:1"],
    ["pageerror", "Failed to fetch", "at https://portal.other.example.org/mf.js:1:1"],
    ["console-error", "checkLoginState ERR_CONNECTION_CLOSED", "at https://localhost.work.weixin.qq.com/x.js:1:1"],
  ];
  for (const [kind, message, stack] of noises) {
    diagnostics.record({ kind, message, stack });
    diagnostics.record({ kind, message, stack }); // twice, to prove counting
  }

  const suggested = diagnostics.buildSuggestedAllowlist();
  assert.equal(suggested.length, 5, "all five families in ONE round — never one per round");
  for (const item of suggested) {
    assert.equal(item.count, 2);
    assert.equal(typeof item.isThirdParty, "boolean");
    assert.ok(item.suggestedEntry.reason, "every suggestion carries a reason draft");
    assert.ok(
      item.suggestedEntry.url || item.suggestedEntry.origin || item.suggestedEntry.phase,
      "every suggestion is SCOPED — suggesting a bare substring would recreate the problem",
    );
  }
  assert.ok(suggested.some((item) => item.isThirdParty), "third-party sources are marked as such");
});

test("Z23-4: a bare generic match is warned about, with what it would swallow", () => {
  const result = precheckTestFile({
    testFile: {
      schemaVersion: 2,
      id: "t",
      name: "t",
      baseUrl: "https://product.example.com/board",
      cases: [{ id: "c1", name: "c1", steps: [{ id: "s1", type: "openUrl", url: "https://product.example.com/" }] }],
      settings: { pageErrorAllowlist: [{ match: "deprecated", reason: "框架告警" }] },
    },
  });
  const issue = result.issues.find((item) => item.code === "page-error-allowlist-too-broad");
  assert.ok(issue, "a bare generic word must be flagged");
  assert.equal(issue.severity, "warning", "advisory — a false-blocking allowlist rule just gets switched off");
  assert.match(issue.message, /过宽/);
  assert.ok(issue.suggestedPatch, "and the fix is one field away");
});

test("Z23-5: a resource-class match with no url/origin scope is warned about", () => {
  const result = precheckTestFile({
    testFile: {
      schemaVersion: 2,
      id: "t",
      name: "t",
      baseUrl: "https://product.example.com/board",
      cases: [{ id: "c1", name: "c1", steps: [{ id: "s1", type: "openUrl", url: "https://product.example.com/" }] }],
      settings: { pageErrorAllowlist: [{ match: "Failed to fetch", reason: "第三方" }] },
    },
  });
  assert.ok(result.issues.some((item) => item.code === "page-error-allowlist-unscoped-resource"));
});

test("Z23-4: an entry naming the product's own host is called out separately", () => {
  const result = precheckTestFile({
    testFile: {
      schemaVersion: 2,
      id: "t",
      name: "t",
      baseUrl: "https://portal.test.example.org/demoWorkflow",
      cases: [{ id: "c1", name: "c1", steps: [{ id: "s1", type: "openUrl", url: "https://portal.test.example.org/" }] }],
      settings: { pageErrorAllowlist: [{ match: "portal.test.example.org", reason: "微前端宿主" }] },
    },
  });
  const issue = result.issues.find((item) => item.code === "page-error-allowlist-same-origin");
  assert.ok(issue, "silencing your own product's domain is the single most dangerous shape");
  assert.match(issue.message, /被测产品自己的域/);
});

test("Z23: a properly scoped entry produces NO breadth warnings", () => {
  const result = precheckTestFile({
    testFile: {
      schemaVersion: 2,
      id: "t",
      name: "t",
      baseUrl: "https://product.example.com/board",
      cases: [{ id: "c1", name: "c1", steps: [{ id: "s1", type: "openUrl", url: "https://product.example.com/" }] }],
      settings: {
        pageErrorAllowlist: [
          { url: "**/login", origin: "third-party", phase: "auth-bootstrap", match: "SyntaxError", reason: "SSO CDN" },
        ],
      },
    },
  });
  assert.equal(
    result.issues.filter((item) => item.code.startsWith("page-error-allowlist-")).length,
    0,
    "the recommended shape must be warning-free, or nobody will adopt it",
  );
});

// ---------------------------------------------------------------------------
// REQ-Z24 — reach vs target-drift
// ---------------------------------------------------------------------------

const CONTRACT_WITH_INVENTORY = {
  sources: { frontendInventory: { path: "ui-contract.json", testIds: 2 } },
  testIds: [
    {
      testId: "demo-review-approve-btn",
      declaredByFrontend: true,
      components: ["SampleReviewPanel"],
      routes: ["/sampleReview"],
      caseCount: 3,
      stability: { seen: 10, notFound: 0, unstable: false },
    },
    {
      testId: "demo-flaky-btn",
      declaredByFrontend: true,
      components: ["Legacy"],
      routes: ["/old"],
      caseCount: 1,
      stability: { seen: 10, notFound: 6, unstable: true },
    },
  ],
};

test("Z24-1: a testid that IS in the contract -> reach, and it says where to go", () => {
  const diagnosis = buildReachDiagnosis({
    step: {
      code: "target-not-found",
      target: { testId: "demo-review-approve-btn" },
      originalStep: { requiredTab: "待审核", requiredBoard: "sampleReview" },
    },
    contract: CONTRACT_WITH_INVENTORY,
    currentUrl: "http://localhost:8000/supplyChain",
  });
  assert.equal(diagnosis.verdict, "reach");
  assert.equal(diagnosis.testidInContract, true);
  assert.equal(diagnosis.requiredTab, "待审核");
  assert.equal(diagnosis.requiredBoard, "sampleReview");
  assert.deepEqual(diagnosis.declaredRoutes, ["/sampleReview"]);
  assert.match(diagnosis.fix, /先把状态造到位/);
  assert.doesNotMatch(diagnosis.fix, /改用例/, "a reach fix must never tell you to edit the test");
});

test("Z24-2: a testid the contract does not know -> target-drift, and the fix says 改用例", () => {
  const diagnosis = buildReachDiagnosis({
    step: { code: "target-not-found", target: { testId: "demo-renamed-btn" } },
    contract: CONTRACT_WITH_INVENTORY,
  });
  assert.equal(diagnosis.verdict, "target-drift");
  assert.equal(diagnosis.testidInContract, false);
  assert.match(diagnosis.fix, /改用例/);
  assert.doesNotMatch(diagnosis.fix, /造数/);
});

test("Z24-2: a testid history says keeps vanishing -> target-drift on run evidence alone", () => {
  const diagnosis = buildReachDiagnosis({
    step: { code: "target-not-found", target: { testId: "demo-flaky-btn" } },
    contract: CONTRACT_WITH_INVENTORY,
  });
  assert.equal(diagnosis.verdict, "target-drift");
  assert.match(diagnosis.reason, /历史 run/);
});

test("Z24-3: when the contract cannot answer, the verdict is unknown WITH a reason — never a guess", () => {
  const noInventory = { sources: { frontendInventory: null }, testIds: [], completeness: "history-only" };
  const diagnosis = buildReachDiagnosis({
    step: { code: "target-not-found", target: { testId: "whatever" } },
    contract: noInventory,
  });
  assert.equal(diagnosis.verdict, "unknown");
  assert.equal(diagnosis.testidInContract, null);
  assert.ok(diagnosis.reason.includes("不猜"), "the honest answer must be explicit about refusing to guess");

  // No contract at all is likewise honest, not absent.
  const noContract = buildReachDiagnosis({ step: { code: "target-not-found", target: { testId: "x" } }, contract: null });
  assert.equal(noContract.verdict, "unknown");
  assert.ok(noContract.reason);
});

test("Z24: a value-assertion failure is not dragged into the reach machinery", () => {
  const diagnosis = buildReachDiagnosis({
    step: { code: "expectation-not-met", expectation: { ok: false, expected: "42", actual: "99", property: "text" } },
    contract: CONTRACT_WITH_INVENTORY,
  });
  assert.equal(diagnosis, null, "a comparison that actually happened is not a reach problem");
});

test("Z24: the step-level failureClass shares the case-level value domain", () => {
  assert.equal(classifyStepFailureClass({ code: "target-not-found" }), "reach");
  assert.equal(classifyStepFailureClass({ code: "page-error" }), "page-error");
  assert.equal(classifyStepFailureClass({ code: "step-hard-timeout" }), "timeout");
  assert.equal(
    classifyStepFailureClass({ code: "expectation-not-met", expectation: { ok: false, type: "assertDom", expected: "x" } }),
    "value-assertion",
  );
  assert.equal(classifyStepFailureClass({}), null, "a passing step has no failure class");
});

// ---------------------------------------------------------------------------
// REQ-Z25 — GET /capabilities
// ---------------------------------------------------------------------------

test("Z25-1: /capabilities answers 200 and every entry is machine-usable", async () => {
  const server = createServer({
    outputRoot: path.join(outputRoot, "z25", "output"),
    outputRunsRoot: path.join(outputRoot, "z25", "output", "runs"),
    testWorkflowsRoot: path.join(outputRoot, "z25", "test-workflows"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const get = (route) =>
    new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${route}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
    });
  try {
    const response = await get("/capabilities");
    assert.equal(response.status, 200);
    const data = JSON.parse(response.body).data;
    assert.ok(Array.isArray(data.capabilities) && data.capabilities.length > 0);
    for (const item of data.capabilities) {
      assert.ok(item.id, "every capability has an id");
      assert.ok(["ga", "beta", "planned"].includes(item.status), `${item.id} declares a real status`);
      assert.ok("http" in item, `${item.id} states its HTTP path (or explicitly null)`);
    }
    // The capability the whole requirement is about.
    const verify = data.capabilities.find((item) => item.id === "verify_evidence");
    assert.equal(verify.status, "ga");
    assert.equal(verify.http.path, "/evidence/verify");
    assert.ok(verify.commonMistakes.includes("/verify-evidence"));
  } finally {
    server.close();
  }
});

test("Z25-1: no `ga` capability points at a path the bridge answers with 404", async () => {
  const server = createServer({
    outputRoot: path.join(outputRoot, "z25b", "output"),
    outputRunsRoot: path.join(outputRoot, "z25b", "output", "runs"),
    testWorkflowsRoot: path.join(outputRoot, "z25b", "test-workflows"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const probe = (method, route) =>
    new Promise((resolve) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: route, method },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      request.on("error", () => resolve(0));
      request.end(method === "POST" ? "{}" : undefined);
    });
  try {
    // Only the bridge-routable ones: `surface: "app"` capabilities live on the
    // desktop server and are legitimately absent here.
    const routable = listCapabilities({ surface: "bridge" }).filter(
      (item) => item.status === "ga" && item.http && !item.http.path.includes("{"),
    );
    assert.ok(routable.length >= 5, "the sanity of this test depends on it actually covering something");
    for (const item of routable) {
      const status = await probe(item.http.method, item.http.path);
      assert.notEqual(
        status,
        404,
        `${item.id} is declared ga at ${item.http.method} ${item.http.path} but the server 404s it — ` +
          "that is exactly the doc/implementation drift REQ-Z25 exists to prevent",
      );
    }
  } finally {
    server.close();
  }
});

test("Z25: a known wrong-guess path 404s with the REAL path, not a bare not-found", () => {
  const capability = findCapabilityByMistakenPath("/verify-evidence");
  assert.ok(capability, "the exact path office-lab guessed for two weeks must be recognised");
  assert.equal(capability.id, "verify_evidence");
  assert.equal(capability.http.path, "/evidence/verify");
});

// The first Z25 fix shipped the helpful 404 on the bridge only. The bridge binds
// loopback; the App Run server binds all interfaces. So the surface that got the
// fix is the one no remote consumer can reach, and office-lab — which reaches
// only the App Run server — kept getting a bare "Route not found." and recorded
// "verify_evidence 未上线" a SECOND time. Every test above probes the bridge, so
// nothing caught it. These two pin the message to one shared builder and assert
// neither surface hand-rolls its own.
test("Z25-4: the wrong-guess 404 body names the real path, from one shared builder", () => {
  const helpful = buildNotFoundError("/verify-evidence");
  assert.equal(helpful.capabilityId, "verify_evidence");
  assert.equal(helpful.statusHint, "ga");
  assert.match(helpful.message, /POST \/evidence\/verify/);
  assert.match(helpful.message, /never guess a path/);
  // An unknown path stays terse — the hint is for known wrong guesses only.
  assert.equal(buildNotFoundError("/nonsense").message, "Route not found.");
  assert.equal(buildNotFoundError("/nonsense").capabilityId, undefined);
});

test("Z25-5: both HTTP surfaces emit the shared 404 body, neither hand-rolls one", () => {
  const surfaces = [
    ["runtime/server/http.js", path.join(__dirname, "..", "..", "runtime", "server", "http.js")],
    ["src/main/main.js", path.join(__dirname, "..", "..", "src", "main", "main.js")],
  ];
  for (const [label, file] of surfaces) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(
      source,
      /buildNotFoundError/,
      `${label} must build its 404 from the shared capability-catalog builder`,
    );
    assert.doesNotMatch(
      source,
      /the closest real one is/,
      `${label} hand-rolls the wrong-guess 404 message — that is how the two surfaces drifted apart`,
    );
  }
});

// The 404 was only half of why office-lab concluded "verify_evidence 未上线".
// The other half: `POST /evidence/verify` — the form the integration doc leads
// with — was classified as a WRITE purely because of its verb, so a remote
// caller got 401 "Write/execute requests from outside the loopback interface are
// refused". A read-only capability must never answer that.
test("Z25-6: no read-only capability is gated as a write just for taking POST", () => {
  const { classifyHttpRequest } = require("../../src/shared/api-guard");
  const readOnlyPosts = listCapabilityRoutes().filter(
    (route) => route.method === "POST" && route.readOnly && !route.path.includes("{"),
  );
  assert.ok(
    readOnlyPosts.some((route) => route.path === "/evidence/verify"),
    "the capability this whole regression is about must be covered",
  );
  for (const route of readOnlyPosts) {
    assert.equal(
      classifyHttpRequest("POST", route.path),
      "read",
      `${route.capabilityId} is readOnly but POST ${route.path} is gated as a write — a remote consumer ` +
        "gets 401 and reads it as 'this capability is not available', which is how the false 未上线 happened",
    );
  }
});

test("Z25-6: classifying by capability did NOT open up any write route", () => {
  const { classifyHttpRequest } = require("../../src/shared/api-guard");
  // Fail-closed check: the writes that spend machine resources must stay writes.
  for (const route of ["/test-sessions", "/app-runs/run-file", "/test-files/write", "/checkpoints"]) {
    assert.equal(classifyHttpRequest("POST", route), "write", `POST ${route} must remain token-gated`);
  }
  assert.equal(classifyHttpRequest("DELETE", "/test-sessions/abc"), "write");
  // An unknown POST path is a write: fail closed, never guess.
  assert.equal(classifyHttpRequest("POST", "/nobody-implements-this"), "write");
});

test("Z25-7: a remote wrong guess reaches the 404 that names the real path", () => {
  const { classifyHttpRequest } = require("../../src/shared/api-guard");
  // 401 fires before 404. So while the guessed path counted as a write, the
  // remote caller got "Write/execute requests are refused" and never saw the
  // hint — the hint existed only for people who did not need it.
  for (const guess of ["/verify-evidence", "/evidence-verify", "/verify_evidence"]) {
    assert.equal(
      classifyHttpRequest("POST", guess),
      "read",
      `${guess} must fall through to the capability-aware 404, not be swallowed by the write gate`,
    );
    assert.match(buildNotFoundError(guess).message, /POST \/evidence\/verify/);
  }
  // Only wrong guesses at READ-ONLY capabilities get this. A guess at a write
  // capability stays token-gated.
  const writeGuess = listCapabilities()
    .filter((item) => item.readOnly !== true && (item.commonMistakes || []).length)
    .flatMap((item) => item.commonMistakes);
  for (const guess of writeGuess) {
    assert.equal(classifyHttpRequest("POST", guess), "write", `${guess} guesses at a write capability`);
  }
});

test("Z25-2: the MCP tool catalog and the capability catalog agree", () => {
  const { TOOL_CATALOG } = require("../../src/main/mcp-server");
  for (const tool of TOOL_CATALOG) {
    const capability = findCapability(tool.name);
    assert.ok(capability, `MCP tool ${tool.name} has no entry in the capability catalog — a consumer cannot wire it`);
    assert.equal(
      capability.readOnly,
      tool.readOnly,
      `${tool.name}: readOnly disagrees between the MCP catalog and the capability catalog`,
    );
  }
});

test("Z25-3: /auth/status without a profile is 400 (not 404, which reads as 'no such endpoint')", async () => {
  const server = createServer({
    outputRoot: path.join(outputRoot, "z25c", "output"),
    outputRunsRoot: path.join(outputRoot, "z25c", "output", "runs"),
    testWorkflowsRoot: path.join(outputRoot, "z25c", "test-workflows"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const { status, body } = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/auth/status`, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: text }));
      });
    });
    assert.equal(status, 400);
    assert.match(JSON.parse(body).error.message, /profile/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// REQ-Z26 — service discovery file
// ---------------------------------------------------------------------------

test("Z26-1/2/3: the discovery file is written, follows the port, and goes stale on exit", async () => {
  const filePath = path.join(outputRoot, "z26", "endpoint.json");
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });

  // Z26-1: present and usable after start.
  const first = await writeEndpointFile({ filePath, host: "127.0.0.1", port: 32147, version: "1.9.0" });
  assert.equal(first.ok, true);
  let record = readEndpointFile({ filePath });
  assert.equal(record.ok, true);
  assert.equal(record.document.appRunBaseUrl, "http://127.0.0.1:32147");
  assert.equal(record.document.mcpUrl, "http://127.0.0.1:32147/mcp");
  assert.equal(record.document.stale, false);

  // Z26-2: a port change is reflected without anybody editing a config — this is
  // the whole point (office-lab had 32148 stored while the App ran on 32147).
  await writeEndpointFile({ filePath, host: "127.0.0.1", port: 32150, version: "1.9.0" });
  record = readEndpointFile({ filePath });
  assert.equal(record.document.appRunBaseUrl, "http://127.0.0.1:32150");
  assert.equal(record.document.mcpUrl, "http://127.0.0.1:32150/mcp");

  // Z26-3: marked stale on exit, and a reader treats it as unusable while still
  // being able to see what it used to be.
  markEndpointFileStaleSync({ filePath });
  record = readEndpointFile({ filePath });
  assert.equal(record.ok, false);
  assert.equal(record.reason, "stale");
  assert.equal(record.document.appRunBaseUrl, "http://127.0.0.1:32150");
});

test("Z26: a record whose process is gone is stale even without a clean exit", async () => {
  const filePath = path.join(outputRoot, "z26b", "endpoint.json");
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // pid 999999 is not a live process on any realistic machine.
  fs.writeFileSync(filePath, JSON.stringify(buildEndpointDocument({ port: 32147, pid: 999999 })));
  const record = readEndpointFile({ filePath });
  assert.equal(record.ok, false, "a crashed App must not leave a confidently-wrong base URL behind");
  assert.equal(record.reason, "stale");
});

test("Z26: a 0.0.0.0 bind is advertised as a URL a consumer can actually reach", () => {
  const document = buildEndpointDocument({ host: "0.0.0.0", port: 32147 });
  assert.equal(document.appRunBaseUrl, "http://127.0.0.1:32147");
  assert.equal(document.bindHost, "0.0.0.0", "the real bind host is still reported, honestly");
});

test("Z26: another instance's record is never invalidated by our exit", () => {
  const filePath = path.join(outputRoot, "z26c", "endpoint.json");
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(buildEndpointDocument({ port: 32147, pid: process.pid + 1 })));
  const outcome = markEndpointFileStaleSync({ filePath });
  assert.equal(outcome.skipped, "owned-by-another-pid");
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).stale, false);
});

test("Z25/Z26: the capability catalog documents the discovery file as a non-HTTP capability", () => {
  const capability = findCapability("get_service_endpoint");
  assert.ok(capability);
  assert.equal(capability.http, null, "a discovery mechanism you need the base URL to reach is not one");
  assert.ok(capability.discoveryFile.includes("Vision E2E Showcase"));
  assert.equal(getCapabilityData().capabilities.some((item) => item.id === "get_service_endpoint"), true);
});
