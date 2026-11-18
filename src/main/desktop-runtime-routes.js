"use strict";


const { summarizeSessionDoc } = require("../../runtime/server/session-store");
// v1.7 Z-N: step-level progress + budget for headless sessions.
const { getSessionEventBus } = require("../../runtime/server/session-events");
const { formatSseEvent } = require("./app-run-http");
// v1.11 REQ-Z33: batch items waiting in the pool are visible as "queued".
const { getRunBoard, registerBatchPlaceholders } = require("../../runtime/server/run-board");

function buildValidateInput(body, { rootDir } = {}) {
  const hasEnvelope =
    body &&
    typeof body === "object" &&
    (body.testFile || body.file || body.payload || body.path || body.before || body.after);
  if (hasEnvelope) {
    return { ...body, rootDir: body.rootDir || rootDir };
  }
  return { testFile: body, rootDir };
}

function resolveValidateMode(validateInput, { strict = false } = {}) {
  if (validateInput.mode === "gate" || strict) {
    return "gate";
  }
  return validateInput.mode || "advisory";
}

function resolveValidateStatus(result, mode) {
  if ((result?.summary?.errorCount || 0) > 0) {
    return 422;
  }
  if (mode === "gate" && result?.blocked) {
    return 422;
  }
  return 200;
}

// Runs precheck against a request body. `precheck` is injected (precheckTestFile).
function runValidate(body, { rootDir, precheck, strict = false } = {}) {
  const validateInput = buildValidateInput(body, { rootDir });
  const result = precheck(validateInput);
  const mode = resolveValidateMode(validateInput, { strict });
  return { statusCode: resolveValidateStatus(result, mode), payload: { ok: result.ok, data: result } };
}

// Runs a headless test session. `createTestSession` + `store` + roots injected.
async function runHeadlessSession(body, deps = {}) {
  const { createTestSession, store, outputRoot, testWorkflowsRoot, outputRunsRoot, browserContext, checkpointsRoot, launchBrowser } = deps;
  try {
    const result = await createTestSession(body, {
      store,
      outputRoot,
      testWorkflowsRoot,
      outputRunsRoot,
      // Z09: forward the panel-aligned browser context so the qiankun micro-app
      // loads in headless the same way it does in the visible panel.
      browserContext: browserContext || null,
      // Z11: root for per-session checkpoint save/resume (body.checkpoint/body.resume).
      checkpointsRoot: checkpointsRoot || null,
      // v1.2.1: shared-browser launcher enabling browser-process reuse across cases.
      launchBrowser: launchBrowser || null,
    });
    return { statusCode: 200, payload: result.response };
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return {
      statusCode,
      payload: {
        ok: false,
        error: {
          code: error?.code || "test-session-failed",
          message: error?.message || String(error),
          // v1.10 Z27: e.g. which origins a target-origin-missing lacked.
          ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
        },
      },
    };
  }
}

// Z10: run a batch of headless sessions in parallel at a configurable
// concurrency. `runBatch` (bounded worker pool) + `createTestSession` +
// `browserContext` are injected. Each item is an independent headless session
// (own runId / Chromium), so N files finish in ~ sum/K wall-clock instead of the
// serial sum, and overflow beyond K waits in the pool — nothing is dropped.
async function runHeadlessBatch(body, deps = {}) {
  const { runBatch, createTestSession, store, outputRoot, testWorkflowsRoot, outputRunsRoot, browserContext, launchBrowser, defaultConcurrency = 2, forceHeaded = false } = deps;
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    return {
      statusCode: 400,
      payload: { ok: false, error: { code: "empty-batch", message: "Batch requires a non-empty `items` array." } },
    };
  }
  // Shared request defaults every item inherits unless it overrides them.
  const shared = {
    authProfile: body.authProfile,
    qualityGate: body.qualityGate,
    allowBlocked: body.allowBlocked,
    authBootstrap: body.authBootstrap,
    feedback: body.feedback,
    // v1.3 Z10: `headed` makes each worker drive its own *visible* browser, so
    // this same pool serves the parallel multi-instance App-run channel.
    // `forceHeaded` is set by the /app-runs/batch route and wins over the body.
    headed: forceHeaded ? true : body.headed === true ? true : undefined,
    // v1.3 REQ-Z12-3: per-session wall-clock ceiling shared by every item.
    sessionTimeoutMs: body.sessionTimeoutMs,
    // v1.10 Z27 / Z29-1: one environment / OCR mode for the whole batch,
    // overridable per item.
    target: body.target,
    stepOcr: body.stepOcr,
  };
  const concurrency = Number.isFinite(Number(body?.concurrency)) && Number(body.concurrency) >= 1
    ? Math.floor(Number(body.concurrency))
    : defaultConcurrency;

  // v1.11 REQ-Z33: until a worker picks an item up it is not a session yet, so
  // nothing else knows it exists. Each item gets a queued placeholder; when it
  // starts, the placeholder is dropped and the session registers under its own id.
  const placeholders = registerBatchPlaceholders(outputRoot ? getRunBoard({ outputRoot }) : null, {
    items,
    trigger: forceHeaded ? "app-runs/batch" : "test-sessions/batch",
    headed: Boolean(forceHeaded || body.headed === true),
  });
  const { batchId } = placeholders;

  const { results, stats } = await runBatch({
    items,
    concurrency,
    runItem: async (item, index) => {
      placeholders.start(index);
      const request = {};
      for (const [key, value] of Object.entries(shared)) {
        if (value !== undefined) {
          request[key] = value;
        }
      }
      Object.assign(request, item && typeof item === "object" ? item : {});
      if (forceHeaded) {
        // The visible-parallel route is not overridable per item.
        request.headed = true;
      }
      // v1.4 REQ-Z15: the batch contract is "blocks until every item finishes",
      // so each item must ignore the per-submit bounded wait introduced for
      // `run_headless` — otherwise a long item would hand the pool a handle at
      // the wait ceiling and the batch would report a `running` session as done.
      // Parallelism here comes from the worker pool, not from async submits.
      request.wait = true;
      request.waitTimeoutMs = 0;
      request.batchId = batchId;
      const result = await createTestSession(request, {
        trigger: forceHeaded ? "app-runs/batch" : "test-sessions/batch",
        store,
        outputRoot,
        testWorkflowsRoot,
        outputRunsRoot,
        browserContext: browserContext || null,
        launchBrowser: launchBrowser || null,
      });
      return result.response;
    },
  });

  const sessions = results.map((entry) => (entry?.ok
    ? { ok: true, ...entry.value }
    : { ok: false, error: entry?.error || { code: "batch-item-failed", message: "Unknown batch item failure." } }));
  return {
    statusCode: 200,
    payload: {
      ok: stats.errorCount === 0,
      data: { sessions, stats, concurrency, headed: Boolean(forceHeaded || body.headed === true) },
    },
  };
}

// Reads a headless session (or its latest report). Returns null if `pathname`
// does not match a session read route, so the caller can fall through.
async function readHeadlessSession(pathname, { store } = {}) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "test-sessions" || !parts[1]) {
    return null;
  }
  const sessionId = parts[1];
  if (parts.length === 2) {
    const session = await store.readSession(sessionId);
    // v1.4 REQ-Z15-3: alongside the raw document, return the same projection the
    // synchronous submit response uses (`status`/`terminal`/`firstFailure`/
    // `reportPath`), so polling a handle and blocking on a submit agree literally
    // field-for-field instead of "by convention".
    return session
      ? { statusCode: 200, payload: { ok: true, summary: summarizeSessionDoc(session), data: session } }
      : { statusCode: 404, payload: { ok: false, error: { code: "not-found", message: "Test session not found." } } };
  }
  if (parts[2] === "report") {
    const report = await store.readLatestReport(sessionId);
    return report
      ? { statusCode: 200, payload: { ok: true, data: report } }
      : { statusCode: 404, payload: { ok: false, error: { code: "not-found", message: "Report not found." } } };
  }
  // 2026-10-27: the documented repair-context reads existed only on the standalone
  // CLI server (runtime/server/http.js) — the desktop App (:32147), which every
  // agent actually talks to, answered 404, so office-lab's batch digests were empty.
  if (parts[2] === "repair-context" || (parts[2] === "rounds" && parts[3] && parts[4] === "repair-context")) {
    const context = parts[2] === "rounds"
      ? await store.readRoundArtifact(sessionId, decodeURIComponent(parts[3]), "repair-context.json")
      : await store.readLatestRoundArtifact(sessionId, "repair-context.json");
    return context
      ? { statusCode: 200, payload: { ok: true, data: context } }
      : { statusCode: 404, payload: { ok: false, error: { code: "not-found", message: "Repair context not found." } } };
  }
  return null;
}

// v1.4 REQ-Z15-5: `GET /test-sessions?testFileId=&limit=` — find a session handle
// again without reading the filesystem. `query` is a URLSearchParams (or any
// object with `get`). This is the protocol-level replacement for
// `ls -1dt session-* | head -1`, which is not just slow but evidence-unsafe:
// mtime order picks up whichever session finished last, including someone else's.
async function listHeadlessSessions(query, { store } = {}) {
  const read = (key) => (typeof query?.get === "function" ? query.get(key) : query?.[key]) || "";
  const limit = Number(read("limit")) || 10;
  const { sessions, scanned, truncated } = await store.listSessions({
    testFileId: read("testFileId"),
    testFilePath: read("testFilePath"),
    status: read("status"),
    limit,
  });
  return {
    statusCode: 200,
    payload: {
      ok: true,
      data: {
        sessions,
        count: sessions.length,
        limit: Math.min(Math.max(1, limit), 100),
        scanned,
        truncated,
        filters: {
          testFileId: read("testFileId") || null,
          testFilePath: read("testFilePath") || null,
          status: read("status") || null,
        },
      },
    },
  };
}

// v1.7 Z-N: `GET /test-sessions/{id}/events?cursor=N` — step-level SSE for a
// headless session. v1.4 left this as a known limitation: a poller could only see
// `running` -> terminal, so a long data-gen chain was indistinguishable from a
// wedged one until its deadline fired.
//
// Replay-then-subscribe happens SYNCHRONOUSLY (no await between the two), the
// same discipline `streamRunEvents` uses: an event arriving in that window would
// otherwise be lost by exactly the clients that most need it — reconnecting ones.
function streamHeadlessSessionEvents(pathname, { res, req, cursor = 0 } = {}) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "test-sessions" || !parts[1] || parts[2] !== "events") {
    return null;
  }
  const sessionId = decodeURIComponent(parts[1]);
  const bus = getSessionEventBus(sessionId);
  if (!bus) {
    return {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: "not-found",
          message:
            `No live event stream for session "${sessionId}". Streams exist while a session runs and for a short ` +
            "retention window afterwards; for a finished session read GET /test-sessions/{id} instead.",
        },
      },
    };
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  let ended = false;
  let unsubscribe = () => {};
  const cleanup = () => {
    if (ended) {
      return;
    }
    ended = true;
    unsubscribe();
  };
  const emit = (event) => {
    if (ended) {
      return;
    }
    res.write(formatSseEvent(event));
    if (event.type === "session-complete") {
      cleanup();
      res.end();
    }
  };
  const backlog = bus.getEventsSince(Number(cursor) || 0);
  for (const event of backlog) {
    emit(event);
    if (ended) {
      return { streamed: true, replayed: backlog.length, live: false };
    }
  }
  unsubscribe = bus.subscribe(emit);
  if (req && typeof req.on === "function") {
    req.on("close", cleanup);
  }
  return { streamed: true, replayed: backlog.length, live: true };
}

// v1.7 Z-N: `GET /test-sessions/{id}/budget` — what this session actually spent.
// Exists so a dispatch contract that talks about `max_runtime_minutes` has real
// data to settle against instead of a number in a document.
function readHeadlessSessionBudget(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "test-sessions" || !parts[1] || parts[2] !== "budget") {
    return null;
  }
  const sessionId = decodeURIComponent(parts[1]);
  const bus = getSessionEventBus(sessionId);
  if (!bus) {
    return {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: "not-found",
          message:
            `No budget record for session "${sessionId}" in this process. Budgets are accumulated live and kept for ` +
            "a short retention window; the terminal `session-complete` event also carries the final budget.",
        },
      },
    };
  }
  return { statusCode: 200, payload: { ok: true, data: { sessionId, budget: bus.getBudget() } } };
}

// v1.4 REQ-Z16-2: `POST /test-sessions/{id}/cancel` — stop a running headless
// session (aliases `/stop`, `/abort`), mirroring the App-run cancel contract.
// Returns null when `pathname` is not a cancel route so the caller can fall through.
async function cancelHeadlessSession(method, pathname, body = {}, deps = {}) {
  const { cancelSession, store, outputRoot } = deps;
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "test-sessions" || !parts[1]) {
    return null;
  }
  const isCancelVerb = ["cancel", "stop", "abort"].includes(parts[2] || "");
  const isDelete = method === "DELETE" && parts.length === 2;
  if (!isDelete && !(method === "POST" && isCancelVerb && parts.length === 3)) {
    return null;
  }
  const outcome = await cancelSession(
    decodeURIComponent(parts[1]),
    { reason: body?.reason || "Cancelled via the test-session cancel endpoint.", graceMs: body?.graceMs },
    { store, outputRoot },
  );
  return { statusCode: outcome.ok ? 200 : 404, payload: outcome };
}

// Z11: checkpoint management routes. `GET /checkpoints` lists saved checkpoints;
// `DELETE /checkpoints/{id}` invalidates one (Z11-3). `listCheckpoints`,
// `clearCheckpoint`, `resolveCheckpointDir` and `checkpointsRoot` are injected.
// Returns null when `pathname` is not a checkpoint route so the caller can fall through.
async function handleCheckpointRoute(method, pathname, deps = {}) {
  const { listCheckpoints, clearCheckpoint, resolveCheckpointDir, checkpointsRoot } = deps;
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "checkpoints") {
    return null;
  }
  if (!checkpointsRoot) {
    return { statusCode: 503, payload: { ok: false, error: { code: "checkpoints-unavailable", message: "Checkpoints root is not configured." } } };
  }
  if (method === "GET" && parts.length === 1) {
    const items = await listCheckpoints(checkpointsRoot);
    return { statusCode: 200, payload: { ok: true, data: { checkpoints: items } } };
  }
  if (method === "DELETE" && parts.length === 2) {
    const dir = resolveCheckpointDir(checkpointsRoot, decodeURIComponent(parts[1]));
    if (!dir) {
      return { statusCode: 400, payload: { ok: false, error: { code: "invalid-checkpoint-id", message: "Invalid checkpoint id." } } };
    }
    await clearCheckpoint(dir);
    return { statusCode: 200, payload: { ok: true, data: { id: decodeURIComponent(parts[1]), cleared: true } } };
  }
  return { statusCode: 405, payload: { ok: false, error: { code: "method-not-allowed", message: "Unsupported checkpoint route." } } };
}

module.exports = {
  buildValidateInput,
  readHeadlessSessionBudget,
  streamHeadlessSessionEvents,
  cancelHeadlessSession,
  resolveValidateMode,
  resolveValidateStatus,
  runValidate,
  runHeadlessSession,
  runHeadlessBatch,
  listHeadlessSessions,
  readHeadlessSession,
  handleCheckpointRoute,
};
