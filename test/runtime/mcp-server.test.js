"use strict";


const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  buildMcpServer,
  handleMcpHttpRequest,
  TOOL_CATALOG,
  toToolResult,
  normalizeError,
} = require("../../src/main/mcp-server");

function makeFakeDeps(overrides = {}) {
  return {
    serverVersion: "9.9.9",
    getIntegrationDoc: async () => ({ ok: true, workspace: { workspaceRoot: "/ws" }, protocolVersion: "9.9.9" }),
    validateTestFile: async (args) => ({ ok: true, data: { echo: args, summary: { errorCount: 0, warningCount: 0 } } }),
    runHeadless: async (args) => ({ ok: true, sessionId: "sess-1", echo: args }),
    runApp: async (args) => ({ ok: true, externalRunId: "run-1", status: "queued", echo: args }),
    getRunSummary: async ({ runId }) => (runId === "run-1" ? { ok: true, kind: "app-run", runId } : { ok: false, error: { code: "not-found", message: "nope", retriable: false } }),
    listTestFiles: async () => ({ success: true, files: [{ path: "a.json", name: "A" }] }),
    readTestFile: async (testFilePath) => ({ success: true, path: testFilePath, testFile: { schemaVersion: 2 } }),
    writeTestFile: async (args) => ({ success: true, path: args.testFilePath, mode: args.mode || "save" }),
    getAuthStatus: async (args) => ({ ok: true, surface: args.surface || "profile" }),
    // v1.3 (需求单v3)
    cancelRun: async ({ runId, reason }) =>
      runId === "run-1"
        ? { ok: true, externalRunId: runId, status: "cancelled", cancelled: true, wasRunning: true, activeCount: 0, reason }
        : { ok: false, externalRunId: runId, status: "not-found", error: { code: "not-found", message: "nope", retriable: false } },
    runAppBatch: async (args) => ({ ok: true, data: { sessions: (args.items || []).map((_, i) => ({ ok: true, sessionId: `s-${i}` })), headed: true, concurrency: args.concurrency || 2 } }),
    // v1.4 (需求单v4)
    listSessions: async (args) => ({
      ok: true,
      data: {
        sessions: [{ sessionId: "session-1", status: "passed", terminal: true, testFileId: args.testFileId || null, createdAt: 1 }],
        count: 1,
        filters: { testFileId: args.testFileId || null },
      },
    }),
    ...overrides,
  };
}

// Spin up a live server that routes every request through handleMcpHttpRequest.
async function withServer(deps, run) {
  const server = http.createServer((req, res) => {
    let body;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST") {
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          res.statusCode = 400;
          res.end("bad json");
          return;
        }
      }
      await handleMcpHttpRequest({ req, res, body, deps });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Minimal JSON-RPC-over-HTTP client (no session; stateless mode).
function rpc(port, message, { method = "POST", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = message ? JSON.stringify(message) : "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function callTool(port, name, args) {
  return rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args || {} } });
}

test("buildMcpServer registers exactly the documented tool catalog", () => {
  const server = buildMcpServer(makeFakeDeps());
  // McpServer stores registered tools internally; assert via the public catalog
  // this module promises to keep in lock-step.
  const names = TOOL_CATALOG.map((t) => t.name).sort();
  assert.deepEqual(names, [
    // v1.6 (人工债清零 Z-F): login-as, so a permission matrix needs no human.
    "bootstrap_auth_profile",
    // v1.3 (需求单v3): cancel_run (Z13) + run_app_batch (Z10) joined the catalog.
    "cancel_run",
    "get_auth_status",
    // v1.9 (需求单v5 REQ-Z25): the machine-verifiable capability catalog, so a
    // consumer stops guessing paths and inferring "未上线" from its own 404.
    "get_capabilities",
    // v1.5 (守航支撑 Z-B/Z-D/Z-K/Z-L): four read-only guarded-run tools joined.
    "get_env_fingerprint",
    "get_integration_doc",
    "get_report_card",
    "get_run_summary",
    // v1.6 (Z-P): the UI contract graph / coverage blind-spot map.
    "get_ui_contract",
    // v1.4 (需求单v4 Z15-5): list_sessions joined the catalog.
    "list_sessions",
    "list_test_files",
    "preflight",
    "read_test_file",
    "run_app",
    "run_app_batch",
    "run_headless",
    "validate_test_file",
    "verify_evidence",
    "write_test_file",
  ]);
  assert.ok(server && typeof server.connect === "function");
});

test("tools/list returns the whole documented catalog with schemas", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const res = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    const tools = res.json.result.tools;
    assert.equal(tools.length, TOOL_CATALOG.length);
    const names = tools.map((t) => t.name).sort();
    assert.ok(names.includes("validate_test_file"));
    assert.ok(names.includes("get_integration_doc"));
    // input schemas are surfaced as JSON Schema
    const validate = tools.find((t) => t.name === "validate_test_file");
    assert.equal(validate.inputSchema.type, "object");
  });
});

test("tools/call get_integration_doc returns structured content", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const res = await callTool(port, "get_integration_doc", {});
    assert.equal(res.status, 200);
    const result = res.json.result;
    assert.equal(result.isError ?? false, false);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.workspace.workspaceRoot, "/ws");
    // text content mirrors the structured payload
    assert.match(result.content[0].text, /workspaceRoot/);
  });
});

test("tools/call forwards arguments to the dep", async () => {
  const seen = [];
  const deps = makeFakeDeps({
    validateTestFile: async (args) => {
      seen.push(args);
      return { ok: true, data: { summary: { errorCount: 0 } } };
    },
  });
  await withServer(deps, async (port) => {
    const res = await callTool(port, "validate_test_file", { testFilePath: "foo/bar.json", mode: "gate" });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.structuredContent.ok, true);
    assert.deepEqual(seen[0], { testFilePath: "foo/bar.json", mode: "gate" });
  });
});

test("run_app + get_run_summary round-trip", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const runRes = await callTool(port, "run_app", { testFilePath: "x.json" });
    assert.equal(runRes.json.result.structuredContent.externalRunId, "run-1");
    const summaryRes = await callTool(port, "get_run_summary", { runId: "run-1" });
    assert.equal(summaryRes.json.result.structuredContent.kind, "app-run");
  });
});

test("run_headless accepts the async/bounded-wait params and returns a handle (v1.4 Z15-1/Z15-2)", async () => {
  const seen = [];
  const deps = makeFakeDeps({
    runHeadless: async (args) => {
      seen.push(args);
      return args.wait === false
        ? {
            ok: true,
            sessionId: "session-1",
            roundId: "round-1",
            status: "running",
            terminal: false,
            partial: { sessionId: "session-1", roundId: "round-1" },
          }
        : { ok: true, sessionId: "session-1", status: "passed", terminal: true };
    },
  });
  await withServer(deps, async (port) => {
    const res = await callTool(port, "run_headless", {
      testFilePath: "x.json",
      wait: false,
      waitTimeoutMs: 1000,
      sessionTimeoutMs: 60000,
    });
    const data = res.json.result.structuredContent;
    assert.equal(data.status, "running");
    assert.equal(data.terminal, false);
    assert.equal(data.partial.sessionId, "session-1");
    assert.notEqual(res.json.result.isError, true, "an async submit is not an error result");
    // The new params must reach the dep, not be dropped by the schema.
    assert.deepEqual(seen[0], { testFilePath: "x.json", wait: false, waitTimeoutMs: 1000, sessionTimeoutMs: 60000 });
  });
});

test("list_sessions recovers a session handle by testFileId (v1.4 Z15-5)", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const res = await callTool(port, "list_sessions", { testFileId: "demo-5-19", limit: 5 });
    const data = res.json.result.structuredContent;
    assert.equal(data.ok, true);
    assert.equal(data.data.sessions[0].sessionId, "session-1");
    assert.equal(data.data.filters.testFileId, "demo-5-19");
  });
});

test("cancel_run also addresses headless session ids (v1.4 Z16-2)", async () => {
  const deps = makeFakeDeps({
    cancelRun: async ({ runId, graceMs }) =>
      runId.startsWith("session-")
        ? { ok: true, kind: "headless", sessionId: runId, status: "cancelled", cancelled: true, terminal: true, graceMs }
        : { ok: true, kind: "app-run", externalRunId: runId, status: "cancelled", cancelled: true },
  });
  await withServer(deps, async (port) => {
    const res = await callTool(port, "cancel_run", { runId: "session-20260821-041830-47a036", graceMs: 5000 });
    const data = res.json.result.structuredContent;
    assert.equal(data.kind, "headless", "the id picks the channel");
    assert.equal(data.status, "cancelled");
    assert.equal(data.terminal, true);
    assert.equal(data.graceMs, 5000);
  });
});

test("cancel_run aborts a run and reports the freed slot (v1.3 Z13)", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const res = await callTool(port, "cancel_run", { runId: "run-1", reason: "wedged" });
    const data = res.json.result.structuredContent;
    assert.equal(data.ok, true);
    assert.equal(data.status, "cancelled");
    assert.equal(data.cancelled, true);
    assert.equal(data.activeCount, 0);
    assert.equal(data.reason, "wedged");
    assert.notEqual(res.json.result.isError, true, "a successful cancel is not an error result");

    // Unknown run -> structured not-found, flagged as an error result.
    const missing = await callTool(port, "cancel_run", { runId: "ghost" });
    assert.equal(missing.json.result.structuredContent.status, "not-found");
    assert.equal(missing.json.result.isError, true);
  });
});

test("run_app_batch fans out N files to N visible instances (v1.3 Z10)", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const res = await callTool(port, "run_app_batch", {
      items: [{ testFilePath: "a.json" }, { testFilePath: "b.json" }, { testFilePath: "c.json" }],
      concurrency: 3,
    });
    const data = res.json.result.structuredContent;
    assert.equal(data.ok, true);
    assert.equal(data.data.sessions.length, 3);
    assert.equal(data.data.headed, true);
    assert.equal(data.data.concurrency, 3);
  });
});

test("a thrown dep is shaped into a retriable-flagged structured error", async () => {
  const deps = makeFakeDeps({
    runHeadless: async () => {
      const err = new Error("engine timeout while launching");
      throw err;
    },
  });
  await withServer(deps, async (port) => {
    const res = await callTool(port, "run_headless", { testFilePath: "x.json" });
    assert.equal(res.status, 200); // JSON-RPC success envelope; tool-level error
    const result = res.json.result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, "mcp-tool-error");
    assert.equal(result.structuredContent.error.retriable, true); // "timeout" => retriable
    assert.match(result.structuredContent.error.message, /timeout/);
  });
});

test("a missing capability degrades to a structured error, not a crash", async () => {
  const deps = makeFakeDeps({ getAuthStatus: undefined });
  await withServer(deps, async (port) => {
    const res = await callTool(port, "get_auth_status", {});
    assert.equal(res.status, 200);
    assert.equal(res.json.result.isError, true);
    assert.equal(res.json.result.structuredContent.error.code, "capability-unavailable");
  });
});

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const res = await rpc(port, null, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.match(res.headers["access-control-allow-methods"], /POST/);
  });
});

test("GET on the stateless endpoint is 405 with an Allow header", async () => {
  await withServer(makeFakeDeps(), async (port) => {
    const res = await rpc(port, null, { method: "GET" });
    assert.equal(res.status, 405);
    assert.match(res.headers["allow"], /POST/);
    assert.equal(res.json.error.code, -32000);
  });
});

test("normalizeError marks network-ish failures retriable and others not", () => {
  assert.equal(normalizeError(new Error("ECONNREFUSED")).error.retriable, true);
  assert.equal(normalizeError(new Error("plain validation failure")).error.retriable, false);
  const withCode = Object.assign(new Error("boom"), { code: "custom-code", retriable: true });
  assert.equal(normalizeError(withCode).error.code, "custom-code");
  assert.equal(normalizeError(withCode).error.retriable, true);
});

test("toToolResult flags failure payloads via ok/success/error", () => {
  assert.equal(toToolResult({ ok: true }).isError, false);
  assert.equal(toToolResult({ ok: false }).isError, true);
  assert.equal(toToolResult({ success: false }).isError, true);
  assert.equal(toToolResult({ error: { code: "x" } }).isError, true);
});
