const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildValidateInput,
  resolveValidateMode,
  resolveValidateStatus,
  runValidate,
  runHeadlessSession,
  readHeadlessSession,
} = require("../../src/main/desktop-runtime-routes");

test("buildValidateInput wraps a raw test file and injects rootDir (Z03)", () => {
  const raw = { schemaVersion: 2, name: "Raw", cases: [] };
  const input = buildValidateInput(raw, { rootDir: "/ws/test-workflows" });
  assert.deepEqual(input, { testFile: raw, rootDir: "/ws/test-workflows" });
});

test("buildValidateInput preserves an envelope and defaults rootDir (Z03)", () => {
  const body = { testFile: { name: "X" }, path: "a.json", mode: "gate" };
  const input = buildValidateInput(body, { rootDir: "/ws/test-workflows" });
  assert.equal(input.path, "a.json");
  assert.equal(input.mode, "gate");
  assert.equal(input.rootDir, "/ws/test-workflows");

  const explicit = buildValidateInput({ path: "b.json", rootDir: "/custom" }, { rootDir: "/ws" });
  assert.equal(explicit.rootDir, "/custom");
});

test("resolveValidateMode honors gate and strict flag (Z03)", () => {
  assert.equal(resolveValidateMode({ mode: "gate" }), "gate");
  assert.equal(resolveValidateMode({}, { strict: true }), "gate");
  assert.equal(resolveValidateMode({}), "advisory");
  assert.equal(resolveValidateMode({ mode: "advisory" }), "advisory");
});

test("resolveValidateStatus is 422 on errors or gate-blocked, else 200 (Z03)", () => {
  assert.equal(resolveValidateStatus({ summary: { errorCount: 1 } }, "advisory"), 422);
  assert.equal(resolveValidateStatus({ summary: { errorCount: 0 }, blocked: true }, "gate"), 422);
  assert.equal(resolveValidateStatus({ summary: { errorCount: 0 }, blocked: true }, "advisory"), 200);
  assert.equal(resolveValidateStatus({ summary: { errorCount: 0 } }, "advisory"), 200);
});

test("runValidate delegates to injected precheck and shapes the response (Z03)", () => {
  const calls = [];
  const fakePrecheck = (input) => {
    calls.push(input);
    return { ok: true, blocked: false, summary: { errorCount: 0, warningCount: 2 }, warnings: [] };
  };
  const { statusCode, payload } = runValidate(
    { schemaVersion: 2, name: "F", cases: [] },
    { rootDir: "/ws/test-workflows", precheck: fakePrecheck },
  );
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.summary.warningCount, 2);
  assert.equal(calls[0].rootDir, "/ws/test-workflows");
});

test("runHeadlessSession delegates to injected createTestSession (Z03/Z01 headless)", async () => {
  const seen = [];
  const fakeCreate = async (body, options) => {
    seen.push({ body, options });
    return { response: { ok: true, sessionId: "sess-1", status: "passed" } };
  };
  const { statusCode, payload } = await runHeadlessSession(
    { testFilePath: "x.json", scope: "all" },
    {
      createTestSession: fakeCreate,
      store: {},
      outputRoot: "/ws/output",
      testWorkflowsRoot: "/ws/test-workflows",
      outputRunsRoot: "/ws/output/runs",
    },
  );
  assert.equal(statusCode, 200);
  assert.equal(payload.sessionId, "sess-1");
  assert.equal(seen[0].options.testWorkflowsRoot, "/ws/test-workflows");
});

test("runHeadlessSession maps thrown statusCode/code (Z03)", async () => {
  const boom = async () => {
    const error = new Error("bad path");
    error.statusCode = 400;
    error.code = "invalid-test-file-path";
    throw error;
  };
  const { statusCode, payload } = await runHeadlessSession({}, { createTestSession: boom });
  assert.equal(statusCode, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "invalid-test-file-path");

  const plain = async () => {
    throw new Error("kaboom");
  };
  const fallback = await runHeadlessSession({}, { createTestSession: plain });
  assert.equal(fallback.statusCode, 500);
  assert.equal(fallback.payload.error.code, "test-session-failed");
});

test("readHeadlessSession reads session and report, else null (Z03)", async () => {
  const store = {
    readSession: async (id) => (id === "sess-1" ? { id, status: "passed" } : null),
    readLatestReport: async (id) => (id === "sess-1" ? { runId: "r1" } : null),
  };
  const session = await readHeadlessSession("/test-sessions/sess-1", { store });
  assert.equal(session.statusCode, 200);
  assert.equal(session.payload.data.status, "passed");

  const report = await readHeadlessSession("/test-sessions/sess-1/report", { store });
  assert.equal(report.statusCode, 200);
  assert.equal(report.payload.data.runId, "r1");

  const missing = await readHeadlessSession("/test-sessions/nope", { store });
  assert.equal(missing.statusCode, 404);

  const notMine = await readHeadlessSession("/app-runs/status", { store });
  assert.equal(notMine, null);
});
