
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const {
  checkAuthProfile,
  checkConcurrency,
  checkOrphanSessions,
  runPreflight,
  summarize,
} = require("../../runtime/server/preflight");
const {
  appendAuditRecord,
  auditFilePath,
  authorize,
  classifyHttpRequest,
  classifyTool,
  ensureApiToken,
  isLoopbackAddress,
  isNetworkExposed,
  resolveBindHost,
} = require("../../src/shared/api-guard");

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-preflight-"));
  fs.mkdirSync(path.join(root, "test-workflows"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function findCheck(report, name) {
  return report.checks.find((item) => item.name === name);
}

// --- Z-L ---------------------------------------------------------------------

test("L-1: an unreachable front-end is a `fail` that names the front-end and says what to do", async (t) => {
  const root = makeWorkspace(t);
  const report = await runPreflight({
    workspaceRoot: root,
    // Port 1 is reliably closed.
    baseUrl: "http://127.0.0.1:1/",
    headlessAvailable: true,
  });
  const check = findCheck(report, "frontend.reachable");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /not reachable/);
  assert.match(check.fix, /front-end/i);
  assert.equal(report.ready, false);
  assert.equal(report.verdict, "do-not-run");
  assert.match(report.message, /Do not start/);
  assert.match(report.message, /frontend\.reachable/);
});

test("a reachable front-end passes and the build identity is reported", async (t) => {
  const root = makeWorkspace(t);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html><head><meta name=\"build-id\" content=\"b-42\"></head><body>ok</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const report = await runPreflight({
    workspaceRoot: root,
    baseUrl,
    // Injected rather than launching a real browser: preflight must be fast.
    collectFingerprint: async () => ({ frontend: { buildId: "b-42", source: "meta:build-id" }, backends: [], unknowns: [] }),
  });
  assert.equal(findCheck(report, "frontend.reachable").status, "pass");
  assert.equal(findCheck(report, "frontend.buildId").status, "pass");
  assert.match(findCheck(report, "frontend.buildId").detail, /b-42/);
});

test("an unreadable build identity is a warn (not a fail) that explains the consequence", async (t) => {
  const root = makeWorkspace(t);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html><body>no build info</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const report = await runPreflight({
    workspaceRoot: root,
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    collectFingerprint: async () => ({ frontend: { buildId: "unknown", reason: "no meta tag" }, backends: [], unknowns: [] }),
  });
  const check = findCheck(report, "frontend.buildId");
  assert.equal(check.status, "warn");
  assert.match(check.fix, /build-id|__BUILD_ID__/);
  assert.equal(report.ready, true, "a missing build id degrades evidence quality, it does not stop the night");
});

test("L-2: a missing auth profile fails, a stale one warns with a bootstrap suggestion", () => {
  const missing = checkAuthProfile({ exists: false }, "demo-local");
  assert.equal(missing.status, "fail");
  assert.match(missing.fix, /bootstrap_auth_profile/);

  const stale = checkAuthProfile({ exists: true, stale: true, ageMinutes: 4000 }, "demo-local");
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /stale/);
  assert.match(stale.fix, /bootstrap_auth_profile/);

  const fresh = checkAuthProfile({ exists: true, stale: false }, "demo-local");
  assert.equal(fresh.status, "pass");

  // No profile named at all is a warn about the blind spot, not a silent pass.
  const unnamed = checkAuthProfile(null, null);
  assert.equal(unnamed.status, "warn");
  assert.match(unnamed.fix, /profile=/);
});

test("L-3: sessions left running are listed by id with a concrete cancel command", () => {
  const check = checkOrphanSessions([
    { id: "session-aaa", status: "running", startedAt: 1 },
    { id: "session-bbb", status: "passed" },
    { id: "session-ccc", status: "running", startedAt: 2 },
  ]);
  assert.equal(check.status, "warn");
  assert.match(check.detail, /session-aaa/);
  assert.match(check.detail, /session-ccc/);
  assert.equal(check.detail.includes("session-bbb"), false);
  assert.match(check.fix, /cancel_run\(\{runId:"session-aaa"\}\)/);
  assert.equal(check.data.sessions.length, 2);

  assert.equal(checkOrphanSessions([]).status, "pass");
});

test("the concurrency advice is derived from real host resources and is bounded", () => {
  const check = checkConcurrency();
  assert.ok(["pass", "warn"].includes(check.status));
  assert.ok(check.data.recommended >= 1 && check.data.recommended <= 6);
  assert.match(check.detail, /recommended concurrency/);
});

test("a missing workspace fails, and writability is proven by writing", async (t) => {
  const absent = await runPreflight({ workspaceRoot: path.join(os.tmpdir(), `zhuzhu-nope-${process.pid}`) });
  assert.equal(findCheck(absent, "workspace").status, "fail");
  assert.equal(absent.ready, false);

  const root = makeWorkspace(t);
  const present = await runPreflight({ workspaceRoot: root });
  assert.equal(findCheck(present, "workspace.writable").status, "pass");
  assert.equal(findCheck(present, "workspace.test-workflows").status, "pass");
});

test("a missing test-workflows directory fails (no file could be resolved)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-preflight-bare-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = await runPreflight({ workspaceRoot: root });
  assert.equal(findCheck(report, "workspace.test-workflows").status, "fail");
});

test("the headless channel being unavailable is a fail with an install hint", async (t) => {
  const root = makeWorkspace(t);
  const report = await runPreflight({ workspaceRoot: root, headlessAvailable: false });
  const check = findCheck(report, "channel.headless");
  assert.equal(check.status, "fail");
  assert.match(check.fix, /playwright install/);
});

test("the summary verdict is a single actionable sentence in all three states", () => {
  assert.equal(summarize([{ name: "a", status: "pass" }]).verdict, "ready");
  assert.equal(summarize([{ name: "a", status: "warn" }]).verdict, "run-with-warnings");
  assert.equal(summarize([{ name: "a", status: "fail" }]).verdict, "do-not-run");
  assert.equal(summarize([{ name: "a", status: "fail" }]).ready, false);
});

// --- Z-M ---------------------------------------------------------------------

test("M-3: the default bind host is loopback (the pre-v1.5 default was 0.0.0.0)", () => {
  const previous = process.env.ZHUZHU_APP_RUN_HOST;
  delete process.env.ZHUZHU_APP_RUN_HOST;
  try {
    assert.equal(resolveBindHost(), "127.0.0.1");
    assert.equal(isNetworkExposed("127.0.0.1"), false);
    process.env.ZHUZHU_APP_RUN_HOST = "0.0.0.0";
    assert.equal(resolveBindHost(), "0.0.0.0");
    assert.equal(isNetworkExposed("0.0.0.0"), true, "opening to the LAN must be an explicit, visible act");
  } finally {
    if (previous === undefined) {
      delete process.env.ZHUZHU_APP_RUN_HOST;
    } else {
      process.env.ZHUZHU_APP_RUN_HOST = previous;
    }
  }
});

test("M-3: BOTH servers pass an explicit host to listen() — a missing host binds every interface", () => {
  // This is a source-level assertion on purpose. The defect it pins down was
  // real and shipped: the standalone bridge called `server.listen(port, cb)`
  // with no host, so it bound 0.0.0.0 while its own startup message printed
  // `127.0.0.1`. A message that contradicts the socket is worse than no message
  // — it is what made the exposure invisible for a whole version. Only a smoke
  // test against a live LAN address found it, so the guard belongs here.
  const bridge = fs.readFileSync(path.join(__dirname, "..", "..", "runtime", "server", "http.js"), "utf8");
  const desktop = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main", "main.js"), "utf8");

  for (const [name, source] of [["bridge", bridge], ["desktop", desktop]]) {
    const listenCalls = source.match(/\.listen\(([^)]*)\)/g) || [];
    assert.ok(listenCalls.length >= 1, `${name}: no listen() call found`);
    for (const call of listenCalls) {
      // `listen(port, cb)` — exactly two args where the second is a function —
      // is the shape that silently binds every interface.
      const isHostless = /\.listen\(\s*[A-Za-z0-9_.]+\s*,\s*(\(\)|function)/.test(call);
      assert.equal(isHostless, false, `${name}: ${call} omits the host argument, which binds all interfaces`);
    }
    assert.match(source, /resolveBindHost\(\)/, `${name}: must resolve its bind host from the shared guard`);
  }
});

test("route and tool classification puts every mutating surface in the write group", () => {
  assert.equal(classifyHttpRequest("GET", "/app-runs/status"), "read");
  assert.equal(classifyHttpRequest("GET", "/test-sessions/session-1"), "read");
  assert.equal(classifyHttpRequest("GET", "/preflight"), "read");
  assert.equal(classifyHttpRequest("POST", "/test-sessions"), "write");
  assert.equal(classifyHttpRequest("POST", "/test-files/save"), "write");
  assert.equal(classifyHttpRequest("DELETE", "/app-runs/run-1"), "write");
  assert.equal(classifyHttpRequest("POST", "/mcp"), "mcp");

  assert.equal(classifyTool("get_run_summary"), "read");
  assert.equal(classifyTool("verify_evidence"), "read");
  assert.equal(classifyTool("preflight"), "read");
  assert.equal(classifyTool("write_test_file"), "write");
  assert.equal(classifyTool("run_app"), "write");
  // Fail closed: a tool nobody classified must not default to public.
  assert.equal(classifyTool("some_future_tool"), "write");
});

test("M-2: reads stay open by default, so existing polling does not break", (t) => {
  const root = makeWorkspace(t);
  const decision = authorize({ scope: "read", headers: {}, remoteAddress: "192.168.5.20", workspaceRoot: root });
  assert.equal(decision.allowed, true);
});

test("M-1: a write from the LAN is refused while no token is configured", (t) => {
  const root = makeWorkspace(t);
  const decision = authorize({ scope: "write", headers: {}, remoteAddress: "192.168.5.20", workspaceRoot: root });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /Authorization: Bearer/);
});

test("a loopback write is allowed while no token exists, but says so out loud", (t) => {
  const root = makeWorkspace(t);
  const decision = authorize({ scope: "write", headers: {}, remoteAddress: "127.0.0.1", workspaceRoot: root });
  assert.equal(decision.allowed, true);
  assert.match(decision.securityAdvisory, /No API token is configured/);
});

test("once a token exists, writes require it — loopback included", (t) => {
  const root = makeWorkspace(t);
  const { token } = ensureApiToken({ workspaceRoot: root });
  assert.ok(token && token.length >= 32);

  const noToken = authorize({ scope: "write", headers: {}, remoteAddress: "127.0.0.1", workspaceRoot: root });
  assert.equal(noToken.allowed, false, "a configured token is not exempted by loopback");

  const wrongToken = authorize({
    scope: "write",
    headers: { authorization: "Bearer wrong-token-of-same-length-padding" },
    remoteAddress: "192.168.5.20",
    workspaceRoot: root,
  });
  assert.equal(wrongToken.allowed, false);
  assert.match(wrongToken.reason, /does not match/);

  const good = authorize({
    scope: "write",
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: "192.168.5.20",
    workspaceRoot: root,
  });
  assert.equal(good.allowed, true);

  // The alternate header works for callers that cannot set Authorization.
  const altHeader = authorize({
    scope: "write",
    headers: { "x-zhuzhu-token": token },
    remoteAddress: "192.168.5.20",
    workspaceRoot: root,
  });
  assert.equal(altHeader.allowed, true);
});

test("loopback exemption is opt-in via ZHUZHU_API_ALLOW_LOOPBACK", (t) => {
  const root = makeWorkspace(t);
  ensureApiToken({ workspaceRoot: root });
  process.env.ZHUZHU_API_ALLOW_LOOPBACK = "1";
  t.after(() => delete process.env.ZHUZHU_API_ALLOW_LOOPBACK);
  const decision = authorize({ scope: "write", headers: {}, remoteAddress: "::1", workspaceRoot: root });
  assert.equal(decision.allowed, true);
  assert.match(decision.securityAdvisory, /ZHUZHU_API_ALLOW_LOOPBACK/);
});

test("reads can be locked down too, for a deployment that wants it", (t) => {
  const root = makeWorkspace(t);
  ensureApiToken({ workspaceRoot: root });
  process.env.ZHUZHU_API_REQUIRE_TOKEN_FOR_READS = "1";
  t.after(() => delete process.env.ZHUZHU_API_REQUIRE_TOKEN_FOR_READS);
  assert.equal(authorize({ scope: "read", headers: {}, remoteAddress: "127.0.0.1", workspaceRoot: root }).allowed, false);
});

test("loopback detection covers the IPv4-mapped IPv6 form Node actually reports", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.5.20"), false);
  assert.equal(isLoopbackAddress(null), false);
});

test("M-4: the audit log answers who triggered what, with credentials redacted", async (t) => {
  const root = makeWorkspace(t);
  const outputRoot = path.join(root, "output");
  const at = new Date(2026, 7, 25, 3, 15, 0);
  await appendAuditRecord({
    outputRoot,
    at,
    record: {
      surface: "mcp",
      tool: "run_app",
      remoteAddress: "192.168.5.20",
      allowed: true,
      params: { testFilePath: "a.json", token: "super-secret" },
    },
  });
  await appendAuditRecord({
    outputRoot,
    at,
    record: { surface: "http", method: "POST", path: "/test-files/save", remoteAddress: "192.168.5.99", allowed: false, reason: "no token" },
  });
  const filePath = auditFilePath(outputRoot, at);
  assert.match(filePath, /api-20260825\.jsonl$/);
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, "run_app");
  assert.equal(lines[0].remoteAddress, "192.168.5.20");
  assert.equal(lines[1].allowed, false, "a refused attempt is exactly what you want recorded");
  // The local stamp must agree with the (local-dated) file name, so 3am entries
  // are not filed under the previous day east of Greenwich.
  assert.ok(lines[0].atLocal.startsWith("2026-08-25 03:15"), lines[0].atLocal);
  assert.ok(typeof lines[0].at === "string" && lines[0].at.endsWith("Z"));
  // Credentials never reach the audit file.
  assert.equal(lines[0].params.includes("super-secret"), false, lines[0].params);
  assert.match(lines[0].params, /\[redacted\]/);
  assert.match(lines[0].params, /a\.json/);
});

test("a failed audit write never throws (auditing must not break the platform)", async () => {
  const result = await appendAuditRecord({
    outputRoot: path.join("\0invalid", "audit"),
    record: { surface: "http" },
  });
  assert.equal(result, null);
  assert.equal(await appendAuditRecord({}), null);
});
