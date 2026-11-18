const http = require("node:http");
const { handleRunBoardRoute } = require("./run-board-http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run } = require("..");
const { observedRun } = require("./observed-run");
const { precheckTestFile } = require("../../src/shared/test-file-precheck");
const { captureAuthProfile, getAuthProfileStatus, resetAuthProfile } = require("./auth-profile");
const { TestSessionStore, summarizeSessionDoc } = require("./session-store");
const {
  cancelTestSession,
  createTestSession,
  listActiveTestSessions,
  rerunTestSession,
} = require("./test-session-runner");
const {
  getActionsSchema,
  getCapabilityData,
  getExpectationsSchema,
  getPrecheckRulesSchema,
  getTestFileSchema,
} = require("./capabilities");
const {
  createExternalActivity,
  createExternalActivityReporter,
} = require("./external-activity");
// v1.5 Z-M / 守航支撑：the standalone bridge gets the same privilege gate, audit
// trail and guarded-run endpoints as the desktop surface. Two servers with
// different security postures on the same machine is not a posture at all.
const {
  appendAuditRecord,
  authorize: authorizeApiRequest,
  classifyHttpRequest,
  isNetworkExposed,
  resolveBindHost,
} = require("../../src/shared/api-guard");
const { handleGuardedRunRoute } = require("../../src/main/guarded-run-routes");
const {
  readHeadlessSessionBudget,
  streamHeadlessSessionEvents,
} = require("../../src/main/desktop-runtime-routes");
const { launchSharedBrowser } = require("../executor/run-session");
// v1.9 REQ-Z25: so a 404 on a guessed path can name the real one. Shared with
// the App Run server so neither surface can drift back to a bare not-found.
const { buildNotFoundError } = require("../../src/shared/capability-catalog");
// v1.9 REQ-Z26: publish a discovery record so consumers never record a port.
const { markEndpointFileStaleSync, writeEndpointFile } = require("../../src/shared/service-discovery");

let externalActivitySequence = 0;

function send(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getPathParts(url) {
  return url.pathname.split("/").filter(Boolean).map((item) => decodeURIComponent(item));
}

function listReportFiles(rootDir) {
  const output = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "steps") {
          walk(target);
        }
      } else if (entry.isFile() && entry.name === "report.json") {
        output.push(target);
      }
    }
  };
  walk(rootDir);
  return output;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function createSnapshotFromReport(report) {
  const tracePaths = (report?.evidence?.steps || [])
    .map((step) => step.tracePath)
    .filter(Boolean);
  const textParts = [];
  const interactables = [];
  let url = report?.testContext?.url || "";
  let title = "";
  tracePaths.slice(-20).forEach((tracePath) => {
    const trace = readJsonFile(tracePath);
    if (!trace) {
      return;
    }
    title = trace.domSummary?.after?.title || trace.domSummary?.before?.title || title;
    url = trace.domSummary?.after?.url || trace.domSummary?.before?.url || url;
    [trace.selectedCandidate, ...(Array.isArray(trace.candidateListTopN) ? trace.candidateListTopN : [])]
      .filter(Boolean)
      .forEach((candidate) => {
        textParts.push(candidate.text, candidate.name, candidate.placeholder, candidate.testId, candidate.role);
        interactables.push(candidate);
      });
    const expectation = trace.expectation || {};
    textParts.push(expectation.textSample, ...(Array.isArray(expectation.matched) ? expectation.matched : []));
  });
  return {
    url,
    title,
    text: textParts.filter(Boolean).join("\n"),
    interactables,
  };
}

function enrichDryRunLastRun(body, { outputRunsRoot }) {
  if (body?.dryRun?.mode !== "last-run" || body.dryRun.snapshot) {
    return body;
  }
  const testFilePath = body.path || body.testFilePath || body.testFile?.path || "";
  if (!testFilePath) {
    return body;
  }
  const reportsRoot = path.resolve(outputRunsRoot || path.join(process.cwd(), "output", "runs"));
  const reportPath = listReportFiles(reportsRoot)
    .map((filePath) => ({ filePath, report: readJsonFile(filePath) }))
    .filter((item) => item.report?.testContext?.testFilePath === testFilePath)
    .sort((a, b) => (b.report.finishedAt || b.report.startedAt || 0) - (a.report.finishedAt || a.report.startedAt || 0))[0];
  if (!reportPath) {
    return body;
  }
  return {
    ...body,
    dryRun: {
      ...body.dryRun,
      source: reportPath.filePath,
      snapshot: createSnapshotFromReport(reportPath.report),
    },
  };
}

function createServer({
  outputRoot = undefined,
  testWorkflowsRoot = undefined,
  outputRunsRoot = undefined,
  runImpl = undefined,
  authContextProvider = undefined,
  externalActivityReporter = createExternalActivityReporter(),
} = {}) {
  const sessionStore = new TestSessionStore({ outputRoot });
  return http.createServer(async (req, res) => {
  let externalActivity = null;
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const parts = getPathParts(url);
    externalActivity = createExternalActivity(req, url, ++externalActivitySequence);
    if (externalActivity) {
      externalActivityReporter({ ...externalActivity, phase: "started" });
    }

    // v1.5 Z-M: privilege gate. Reads stay open (so existing polling is
    // untouched); writes/executions need a bearer token unless they come from
    // loopback while no token is configured. Every write attempt is audited.
    {
      const scope = classifyHttpRequest(req.method, url.pathname);
      const decision = authorizeApiRequest({
        scope,
        headers: req.headers || {},
        remoteAddress: req.socket?.remoteAddress || null,
        workspaceRoot: path.dirname(sessionStore.outputRoot),
      });
      if (scope === "write") {
        void appendAuditRecord({
          outputRoot: sessionStore.outputRoot,
          record: {
            surface: "bridge",
            method: req.method,
            path: url.pathname,
            remoteAddress: req.socket?.remoteAddress || null,
            allowed: decision.allowed,
            reason: decision.reason || null,
            tokenPresented: decision.tokenPresented,
            loopback: decision.loopback,
          },
        });
      }
      if (!decision.allowed) {
        send(res, 401, { ok: false, error: { code: "unauthorized", message: decision.reason, retriable: false } });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/status") {
      send(res, 200, { ok: true, service: "zhuzhu-runtime-v2" });
      return;
    }

    // v1.11 REQ-Z33: the run board (page + JSON + SSE), same as on :32147.
    if (await handleRunBoardRoute(req, res, url, { outputRoot: sessionStore.outputRoot, label: "bridge" })) {
      return;
    }

    // v1.7 Z-N: step-level SSE + budget, same contract as the desktop surface.
    if (req.method === "GET" && /^\/test-sessions\/[^/]+\/events$/.test(url.pathname)) {
      const streamed = streamHeadlessSessionEvents(url.pathname, {
        res,
        req,
        cursor: Number(url.searchParams.get("cursor")) || 0,
      });
      if (streamed && streamed.statusCode) {
        send(res, streamed.statusCode, streamed.payload);
      }
      return;
    }
    if (req.method === "GET" && /^\/test-sessions\/[^/]+\/budget$/.test(url.pathname)) {
      const budget = readHeadlessSessionBudget(url.pathname);
      send(res, budget.statusCode, budget.payload);
      return;
    }

    // v1.5 守航支撑路由。The path test precedes the body read because
    // `readJson` consumes the stream (see the desktop surface for the same note).
    if (
      url.pathname === "/preflight" ||
      url.pathname === "/env-fingerprint" ||
      url.pathname === "/evidence/verify" ||
      url.pathname === "/ui-contract" ||
      /^\/test-sessions\/[^/]+\/report-card$/.test(url.pathname) ||
      /^\/auth-profiles\/[^/]+\/bootstrap$/.test(url.pathname)
    ) {
      let guardedRunBody = null;
      if (req.method === "POST") {
        try {
          guardedRunBody = await readJson(req);
        } catch (_error) {
          guardedRunBody = null;
        }
      }
      const guardedRun = await handleGuardedRunRoute(
        { method: req.method, pathname: url.pathname, query: url.searchParams, body: guardedRunBody },
        {
          store: sessionStore,
          outputRoot: sessionStore.outputRoot,
          workspaceRoot: path.dirname(sessionStore.outputRoot),
          testWorkflowsRoot,
          precheck: precheckTestFile,
          launchBrowser: launchSharedBrowser,
          // Z-F bootstrap drives a real login, so it needs the runner too.
          runImpl: runImpl || run,
          outputRunsRoot,
          getAuthStatus: (args) =>
            getAuthProfileStatus(args?.profile || null, { outputRoot: sessionStore.outputRoot }),
          listSessions: async (args) => sessionStore.listSessions({ status: args?.status || "", limit: args?.limit || 20 }),
          // The standalone bridge has no visible channel by definition.
          appRunStatus: {
            available: false,
            // `optional` marks "absent by design on this surface", so preflight
            // reports a warning instead of telling a headless-only dispatcher
            // not to run tonight.
            optional: true,
            reason: "this is the standalone runtime bridge; the visible App-run channel lives in the desktop app (:32147)",
          },
        },
      );
      if (guardedRun) {
        send(res, guardedRun.statusCode, guardedRun.payload);
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/capabilities") {
      send(res, 200, { ok: true, data: getCapabilityData() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/schema/test-file") {
      send(res, 200, { ok: true, data: getTestFileSchema() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/schema/actions") {
      send(res, 200, { ok: true, data: getActionsSchema() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/schema/expectations") {
      send(res, 200, { ok: true, data: getExpectationsSchema() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/schema/precheck-rules") {
      send(res, 200, { ok: true, data: getPrecheckRulesSchema() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/status") {
      // REQ-Z25-3: `profile` is required. Returning a bare 404 here (the old
      // behaviour) is indistinguishable from "this endpoint does not exist",
      // which is exactly the confusion that produced a two-week "Z-D 未上线"
      // false positive elsewhere. A 400 names the real problem.
      const profile = url.searchParams.get("profile");
      if (!profile || !String(profile).trim()) {
        send(res, 400, {
          ok: false,
          error: {
            code: "auth-missing",
            message: "auth/status requires a `profile` query parameter (a stored headless auth profile name).",
          },
        });
        return;
      }
      const result = await getAuthProfileStatus(profile, { outputRoot });
      send(res, result.ok ? 200 : 404, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/reset") {
      const body = await readJson(req);
      const result = await resetAuthProfile(body.profile || body.authProfile, { outputRoot });
      send(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/capture") {
      const body = await readJson(req);
      const result = await captureAuthProfile(body.profile || body.authProfile, {
        outputRoot,
        storageState: body.storageState || body.state,
        contextProvider: authContextProvider,
      });
      send(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/test-sessions") {
      const body = await readJson(req);
      const result = await createTestSession(body, {
        store: sessionStore,
        outputRoot,
        testWorkflowsRoot,
        outputRunsRoot,
        runImpl,
      });
      send(res, 200, result.response);
      return;
    }

    // v1.4 REQ-Z15-5: reverse-lookup recent sessions (newest first) instead of
    // guessing the newest `session-*` directory by mtime.
    if (req.method === "GET" && url.pathname === "/test-sessions") {
      const limit = Number(url.searchParams.get("limit")) || 10;
      const listed = await sessionStore.listSessions({
        testFileId: url.searchParams.get("testFileId") || "",
        testFilePath: url.searchParams.get("testFilePath") || "",
        status: url.searchParams.get("status") || "",
        limit,
      });
      send(res, 200, {
        ok: true,
        data: {
          sessions: listed.sessions,
          count: listed.sessions.length,
          limit: Math.min(Math.max(1, limit), 100),
          scanned: listed.scanned,
          truncated: listed.truncated,
          active: listActiveTestSessions(),
        },
      });
      return;
    }

    if (parts[0] === "test-sessions" && parts[1]) {
      const sessionId = parts[1];
      if (req.method === "GET" && parts.length === 2) {
        const session = await sessionStore.readSession(sessionId);
        send(res, session ? 200 : 404, session ? { ok: true, summary: summarizeSessionDoc(session), data: session } : {
          ok: false,
          error: { code: "not-found", message: "Test session not found." },
        });
        return;
      }
      // v1.4 REQ-Z16-2: cancel a running headless session (bounded: it either
      // unwinds on its own or the session document is force-finalized).
      if (
        (req.method === "POST" && ["cancel", "stop", "abort"].includes(parts[2] || "")) ||
        (req.method === "DELETE" && parts.length === 2)
      ) {
        const body = req.method === "POST" ? await readJson(req) : {};
        const outcome = await cancelTestSession(
          sessionId,
          { reason: body?.reason || "Cancelled via the test-session cancel endpoint.", graceMs: body?.graceMs },
          { store: sessionStore, outputRoot },
        );
        send(res, outcome.ok ? 200 : 404, outcome);
        return;
      }
      if (req.method === "POST" && parts[2] === "run") {
        const body = await readJson(req);
        const result = await rerunTestSession(sessionId, body, {
          store: sessionStore,
          outputRoot,
          testWorkflowsRoot,
          outputRunsRoot,
          runImpl,
        });
        send(res, result ? 200 : 404, result ? result.response : {
          ok: false,
          error: { code: "not-found", message: "Test session not found." },
        });
        return;
      }
      if (req.method === "POST" && parts[2] === "feedback") {
        const body = await readJson(req);
        const session = await sessionStore.appendFeedback(sessionId, body);
        send(res, session ? 200 : 404, session ? { ok: true, data: session } : {
          ok: false,
          error: { code: "not-found", message: "Test session not found." },
        });
        return;
      }
      if (req.method === "GET" && parts[2] === "report") {
        const report = await sessionStore.readLatestReport(sessionId);
        send(res, report ? 200 : 404, report ? { ok: true, data: report } : {
          ok: false,
          error: { code: "not-found", message: "Test session not found." },
        });
        return;
      }
      if (req.method === "GET" && parts[2] === "repair-context") {
        const context = await sessionStore.readLatestRoundArtifact(sessionId, "repair-context.json");
        send(res, context ? 200 : 404, context ? { ok: true, data: context } : {
          ok: false,
          error: { code: "not-found", message: "Repair context not found." },
        });
        return;
      }
      if (req.method === "GET" && parts[2] === "rounds" && parts[3] && parts[4] === "repair-context") {
        const context = await sessionStore.readRoundArtifact(sessionId, parts[3], "repair-context.json");
        send(res, context ? 200 : 404, context ? { ok: true, data: context } : {
          ok: false,
          error: { code: "not-found", message: "Repair context not found." },
        });
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/run") {
      const body = await readJson(req);
      const result = await observedRun(body.payload, body.options || {}, { outputRoot: sessionStore.outputRoot, trigger: "http/run" });
      send(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/validate-test-file") {
      const body = enrichDryRunLastRun(await readJson(req), { outputRunsRoot });
      const result = precheckTestFile(body);
      const requestedMode = body.mode === "gate" || url.searchParams.get("strict") === "1" ? "gate" : body.mode || "advisory";
      const status = result.summary?.errorCount > 0 || (requestedMode === "gate" && result.blocked) ? 422 : 200;
      send(res, status, {
        ok: result.ok,
        data: result,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/invoke") {
      const body = await readJson(req);
      const capability = body.capability || body.name;
      if (!capability) {
        send(res, 400, {
          ok: false,
          error: {
            code: "invalid-input",
            message: "capability is required.",
          },
        });
        return;
      }
      const payload =
        capability === "testFile.validate"
          ? null
          : capability === "run"
          ? body.payload
          : {
              type: capability,
              ...(body.input && typeof body.input === "object" ? body.input : {}),
            };
      if (capability === "testFile.validate") {
        const validateInput = enrichDryRunLastRun({
          testFile: body.testFile || body.file || body.payload || body.input || {},
          path: body.path || body.testFilePath || "",
          dryRun: body.dryRun,
          mode: body.mode,
          before: body.before,
          after: body.after,
          beforeHash: body.beforeHash,
          fileFingerprint: body.fileFingerprint,
          appContract: body.appContract,
        }, { outputRunsRoot });
        const result = precheckTestFile(validateInput);
        const requestedMode = validateInput.mode === "gate" ? "gate" : "advisory";
        const status = result.summary?.errorCount > 0 || (requestedMode === "gate" && result.blocked) ? 422 : 200;
        send(res, status, {
          ok: result.ok,
          data: result,
        });
        return;
      }
      const result = await observedRun(payload, body.options || {}, { outputRoot: sessionStore.outputRoot, trigger: "http/invoke" });
      send(res, 200, result);
      return;
    }

    // v1.9 REQ-Z25: a guessed-path 404 is indistinguishable from "not built",
    // and that single ambiguity caused a two-week false "Z-D 未上线". When the
    // path looks like a known wrong guess, say what the real one is instead of
    // leaving the caller to infer.
    send(res, 404, { ok: false, error: buildNotFoundError(url.pathname) });
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    send(res, statusCode, {
      ok: false,
      error: {
        code: error.code || "internal-error",
        message: error.message || "Internal server error.",
        // v1.10 Z27: e.g. target-origin-missing carries { missing, referenced,
        // supplied } so a caller can fix the request without guessing.
        ...(error.details && typeof error.details === "object" ? { details: error.details } : {}),
      },
    });
  } finally {
    if (externalActivity) {
      externalActivityReporter({
        ...externalActivity,
        phase: "completed",
        finishedAt: new Date().toISOString(),
        statusCode: res.statusCode,
        status: res.statusCode >= 400 ? "failed" : "completed",
      });
    }
  }
  });
}

if (require.main === module) {
  const port = Number(process.env.ZHUZHU_RUNTIME_PORT) || 32146;
  const projectRoot = path.resolve(__dirname, "..", "..");
  const workspaceRoot = path.resolve(process.env.ZHUZHU_WORKSPACE_DIR || projectRoot);
  const outputRoot = path.join(workspaceRoot, "output");
  const server = createServer({
    outputRoot,
    outputRunsRoot: path.join(outputRoot, "runs"),
    testWorkflowsRoot: path.join(workspaceRoot, "test-workflows"),
  });
  // v1.5 Z-M: bind LOOPBACK by default. `listen(port, cb)` without a host binds
  // every interface — which is what this line used to do while its own log
  // message claimed `127.0.0.1`. A message that contradicts the socket is worse
  // than no message: it is what made the exposure invisible.
  // Opening to the LAN is an explicit act: ZHUZHU_APP_RUN_HOST=0.0.0.0.
  const host = resolveBindHost();
  server.listen(port, host, () => {
    process.stdout.write(
      `Zhuzhu runtime server listening on http://${host}:${port} (workspace: ${workspaceRoot})` +
        `${isNetworkExposed(host) ? " [WARNING: bound to all interfaces — this port can drive this machine]" : ""}\n`,
    );
    // v1.9 REQ-Z26: the bridge publishes a discovery record too, under its own
    // file name, so a headless-only host is discoverable by the same mechanism.
    // Deliberately NOT the same file as the desktop App's: the two are different
    // services with different capabilities (the bridge has no visible channel),
    // and having them overwrite each other would hand a consumer the wrong one.
    void writeEndpointFile({
      filePath: process.env.ZHUZHU_ENDPOINT_FILE || path.join(os.homedir(), ".zhuzhu", "bridge-endpoint.json"),
      host,
      port: server.address()?.port || port,
      mcpRoute: "/mcp",
      docPath: "/capabilities",
      workspaceRoot,
      extra: { service: "zhuzhu-runtime-bridge", visibleChannel: false },
    });
  });
  const markStale = () =>
    markEndpointFileStaleSync({
      filePath: process.env.ZHUZHU_ENDPOINT_FILE || path.join(os.homedir(), ".zhuzhu", "bridge-endpoint.json"),
    });
  process.on("exit", markStale);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      markStale();
      process.exit(0);
    });
  }
}

module.exports = {
  createServer,
};
