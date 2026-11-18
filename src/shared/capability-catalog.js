"use strict";


const CATALOG_VERSION = 1;
const { resolveEndpointFilePath } = require("./service-discovery");

// `surface` says which server answers: `app` = the desktop App-run server
// (:32147, has the visible browser), `bridge` = the standalone runtime bridge
// (:32146, headless only), `both` = routed identically on each.
const CAPABILITIES = [
  // --- discovery ------------------------------------------------------------
  {
    id: "get_capabilities",
    z: "Z25",
    status: "ga",
    since: "1.9.0",
    readOnly: true,
    mcpTool: null,
    surface: "both",
    http: { method: "GET", path: "/capabilities" },
    summary: "This catalog. Every capability's id, status, MCP tool name and real HTTP path.",
  },
  {
    id: "get_integration_doc",
    z: null,
    status: "ga",
    since: "1.2.1",
    readOnly: true,
    mcpTool: "get_integration_doc",
    surface: "app",
    http: { method: "GET", path: "/external-integration-documents" },
    summary: "Protocol version + absolute workspace paths + the raw integration documents.",
  },
  {
    id: "get_service_endpoint",
    z: "Z26",
    status: "ga",
    since: "1.9.0",
    readOnly: true,
    mcpTool: null,
    surface: "app",
    // Not an HTTP route by design: the whole point of Z26 is a file you can read
    // WITHOUT already knowing the base URL. Stated explicitly so a consumer does
    // not go looking for an endpoint that must not exist.
    http: null,
    discoveryFile: resolveEndpointFilePath(),
    summary:
      "The service-discovery file the App writes at startup (base URL, MCP URL, pid, version). Read the file; never hardcode a port.",
  },

  // --- authoring / validation ----------------------------------------------
  {
    id: "validate_test_file",
    z: null,
    status: "ga",
    since: "1.0.0",
    readOnly: true,
    mcpTool: "validate_test_file",
    surface: "both",
    http: { method: "POST", path: "/validate-test-file" },
    summary: "Precheck a test file. Must pass before submit. Returns separated errors[]/warnings[].",
  },
  {
    id: "list_test_files",
    z: null,
    status: "ga",
    since: "1.0.0",
    readOnly: true,
    mcpTool: "list_test_files",
    surface: "app",
    http: { method: "GET", path: "/test-files" },
    summary: "List test files under test-workflows/.",
  },
  {
    id: "read_test_file",
    z: null,
    status: "ga",
    since: "1.0.0",
    readOnly: true,
    mcpTool: "read_test_file",
    surface: "app",
    http: { method: "GET", path: "/test-files/read", query: ["path"] },
    summary: "Read one test file (path relative to test-workflows/).",
  },
  {
    id: "write_test_file",
    z: null,
    status: "ga",
    since: "1.0.0",
    readOnly: false,
    mcpTool: "write_test_file",
    surface: "app",
    http: { method: "POST", path: "/test-files/save" },
    summary: "Write/create a test file under test-workflows/ (also /test-files/create).",
  },
  {
    id: "get_test_file_schema",
    z: null,
    status: "ga",
    since: "1.0.0",
    readOnly: true,
    mcpTool: null,
    surface: "bridge",
    http: { method: "GET", path: "/schema/test-file" },
    summary: "The test-file JSON schema (targets, expectations, actions, scaffold, vars).",
  },

  // --- execution ------------------------------------------------------------
  {
    id: "run_headless",
    z: "Z15",
    status: "ga",
    since: "1.1.0",
    readOnly: false,
    mcpTool: "run_headless",
    surface: "both",
    http: { method: "POST", path: "/test-sessions" },
    summary: "Headless run. `wait:false` returns a {sessionId, roundId} handle in ~1s.",
  },
  {
    id: "run_app",
    z: "Z01",
    status: "ga",
    since: "1.2.0",
    readOnly: false,
    mcpTool: "run_app",
    surface: "app",
    http: { method: "POST", path: "/app-runs" },
    summary: "Visible App-run. Async by default; returns an externalRunId to poll.",
  },
  {
    id: "run_app_batch",
    z: "Z14",
    status: "ga",
    since: "1.3.0",
    readOnly: false,
    mcpTool: "run_app_batch",
    surface: "app",
    http: { method: "POST", path: "/app-runs/batch" },
    summary: "N files in parallel, each in its own visible browser, at a set concurrency.",
  },
  {
    id: "get_run_summary",
    z: "Z15",
    status: "ga",
    since: "1.2.0",
    readOnly: true,
    mcpTool: "get_run_summary",
    surface: "both",
    // One tool, two id spaces: an App-run id and a headless session id. Both
    // listed because a consumer wiring HTTP directly must pick the right one.
    http: { method: "GET", path: "/test-sessions/{sessionId}" },
    alternateHttp: [{ method: "GET", path: "/app-runs/{externalRunId}", surface: "app" }],
    summary: "Read a run's result. Poll until `terminal` is true.",
  },
  {
    id: "list_sessions",
    z: "Z15-5",
    status: "ga",
    since: "1.4.0",
    readOnly: true,
    mcpTool: "list_sessions",
    surface: "both",
    http: { method: "GET", path: "/test-sessions", query: ["testFileId", "status", "limit"] },
    summary: "Reverse-lookup recent headless sessions instead of guessing a directory by mtime.",
  },
  {
    id: "cancel_run",
    z: "Z13",
    status: "ga",
    since: "1.3.0",
    readOnly: false,
    mcpTool: "cancel_run",
    surface: "both",
    http: { method: "POST", path: "/test-sessions/{sessionId}/cancel" },
    alternateHttp: [{ method: "POST", path: "/app-runs/{externalRunId}/cancel", surface: "app" }],
    summary: "Force-abort a run/session and release its slot. Idempotent.",
  },
  {
    id: "stream_session_events",
    z: "Z-N",
    status: "ga",
    since: "1.7.0",
    readOnly: true,
    mcpTool: null,
    surface: "both",
    http: { method: "GET", path: "/test-sessions/{sessionId}/events", query: ["cursor"] },
    summary: "Step-level SSE progress for a headless session (supports ?cursor= backfill).",
  },
  {
    id: "get_session_budget",
    z: "Z-N",
    status: "ga",
    since: "1.7.0",
    readOnly: true,
    mcpTool: null,
    surface: "both",
    http: { method: "GET", path: "/test-sessions/{sessionId}/budget" },
    summary: "Time/step budget consumed vs remaining for a running session.",
  },

  // --- results / diagnosis --------------------------------------------------
  {
    id: "get_repair_context",
    z: null,
    status: "ga",
    since: "1.1.0",
    readOnly: true,
    mcpTool: null,
    surface: "both",
    http: { method: "GET", path: "/test-sessions/{sessionId}/repair-context" },
    summary:
      "The round's repair context: first failure, resolution trace, page errors, " +
      "authTrace + authNote (Z22), suggestedAllowlist (Z23), reachDiagnosis (Z24).",
  },
  {
    id: "get_report_card",
    z: "Z-K",
    status: "ga",
    since: "1.5.0",
    readOnly: true,
    mcpTool: "get_report_card",
    surface: "both",
    http: { method: "GET", path: "/test-sessions/{sessionId}/report-card" },
    summary: "Raw material for a plain-language QA report. Facts only; the prose is yours.",
  },
  {
    id: "verify_evidence",
    // THE capability this whole endpoint exists for. Two weeks of a false
    // "未上线" claim came from guessing `/verify-evidence` instead of this path.
    z: "Z-D",
    status: "ga",
    since: "1.5.0",
    readOnly: true,
    mcpTool: "verify_evidence",
    surface: "both",
    http: { method: "POST", path: "/evidence/verify" },
    alternateHttp: [{ method: "GET", path: "/evidence/verify", query: ["bundlePath", "sessionId", "caseId"] }],
    commonMistakes: ["/verify-evidence", "/evidence-verify", "/verify_evidence"],
    summary:
      "Recompute a case bundle's hashes + signature and return {verdict, failureClass, discriminativePower, redCalibrated}.",
  },

  // --- environment / trust --------------------------------------------------
  {
    id: "preflight",
    z: "Z-L",
    status: "ga",
    since: "1.5.0",
    readOnly: true,
    mcpTool: "preflight",
    surface: "both",
    http: { method: "GET", path: "/preflight", query: ["baseUrl", "profile"] },
    // The route has accepted POST since v1.5; the catalog only ever said GET,
    // which left the guard classifying the POST form as a write. Declared here
    // so the two can no longer disagree.
    alternateHttp: [{ method: "POST", path: "/preflight" }],
    summary: "Can this machine run unattended tonight? Any `fail` means do not start.",
  },
  {
    id: "get_env_fingerprint",
    z: "Z-B",
    status: "ga",
    since: "1.5.0",
    readOnly: true,
    mcpTool: "get_env_fingerprint",
    surface: "both",
    http: { method: "GET", path: "/env-fingerprint", query: ["baseUrl"] },
    alternateHttp: [{ method: "POST", path: "/env-fingerprint" }],
    summary: "The build identity actually being served, without running a test.",
  },
  {
    id: "get_ui_contract",
    z: "Z-P",
    status: "ga",
    since: "1.6.0",
    readOnly: true,
    mcpTool: "get_ui_contract",
    surface: "both",
    http: { method: "GET", path: "/ui-contract", query: ["component", "maxRuns"] },
    summary: "testid → cases / routes / stability graph + the coverage blind-spot map.",
  },

  // --- auth -----------------------------------------------------------------
  {
    id: "get_auth_status",
    z: "Z05",
    status: "ga",
    since: "1.2.0",
    readOnly: true,
    mcpTool: "get_auth_status",
    surface: "both",
    // REQ-Z25-3: `profile` is REQUIRED, and omitting it now returns 400, not 404 —
    // a 404 made probers conclude the endpoint did not exist.
    http: { method: "GET", path: "/auth/status", query: ["profile"], requiredQuery: ["profile"] },
    alternateHttp: [{ method: "GET", path: "/auth/panel-status", surface: "app" }],
    summary: "Stored headless auth profile status (staleness, expiry, covered hosts).",
  },
  {
    id: "bootstrap_auth_profile",
    z: "Z-F",
    status: "ga",
    since: "1.6.0",
    readOnly: false,
    mcpTool: "bootstrap_auth_profile",
    surface: "both",
    http: { method: "POST", path: "/auth-profiles/{profile}/bootstrap" },
    summary: "Create a named auth profile by driving a real login headlessly.",
  },
  {
    id: "capture_auth_profile",
    z: null,
    status: "ga",
    since: "1.0.0",
    readOnly: false,
    mcpTool: null,
    surface: "both",
    http: { method: "POST", path: "/auth/capture" },
    summary: "Persist a storageState into a named profile.",
  },
  // --- v1.11 REQ-Z33: run board ---------------------------------------------
  {
    id: "run_board",
    z: "Z33",
    status: "ga",
    since: "1.11.0",
    readOnly: true,
    mcpTool: null,
    surface: "both",
    http: { method: "GET", path: "/run-board" },
    alternateHttp: [
      { method: "GET", path: "/run-board/data" },
      { method: "GET", path: "/run-board/events" },
    ],
    summary:
      "Dashboard of every run on this workspace — running (with current case/step), queued (App-run queue, batch pool) and history. " +
      "/run-board is the page, /run-board/data the JSON snapshot (?history=N), /run-board/events an SSE stream of live+queued.",
  },
  {
    id: "reset_auth_profile",
    z: null,
    status: "ga",
    since: "1.0.0",
    readOnly: false,
    mcpTool: null,
    surface: "both",
    http: { method: "POST", path: "/auth/reset" },
    summary: "Delete a named profile's storageState.",
  },
];

// Routes that exist but are not "capabilities" a consumer wires against. Listed
// so the Z25-2 consistency test can tell "undocumented capability" from
// "deliberately internal route".
const INTERNAL_ROUTES = [
  { method: "GET", path: "/status" },
  { method: "GET", path: "/app-runs/status" },
  { method: "GET", path: "/app-runs/queue" },
  { method: "GET", path: "/app-runs/{externalRunId}/events" },
  { method: "POST", path: "/external-activity/events" },
  { method: "POST", path: "/mcp" },
  { method: "POST", path: "/invoke" },
  { method: "POST", path: "/run" },
  { method: "GET", path: "/schema/actions" },
  { method: "GET", path: "/schema/expectations" },
  { method: "GET", path: "/schema/precheck-rules" },
];

function listCapabilities({ surface = null, status = null } = {}) {
  return CAPABILITIES.filter((item) => {
    if (surface && item.surface !== "both" && item.surface !== surface) {
      return false;
    }
    if (status && item.status !== status) {
      return false;
    }
    return true;
  }).map((item) => ({ ...item }));
}

function findCapability(id) {
  return CAPABILITIES.find((item) => item.id === id || item.mcpTool === id) || null;
}

// Was this path a known wrong guess? Lets a 404 handler say "you meant X"
// instead of leaving the caller to conclude "not implemented" — the exact
// inference this requirement exists to break.
function findCapabilityByMistakenPath(pathname) {
  const wanted = String(pathname || "").trim().toLowerCase();
  if (!wanted) {
    return null;
  }
  return (
    CAPABILITIES.find((item) =>
      (item.commonMistakes || []).some((mistake) => mistake.toLowerCase() === wanted),
    ) || null
  );
}

// The 404 body every surface must send. Lives here, not in each HTTP server,
// because the first version of this fix was written twice and only landed once:
// the bridge got the helpful message, the App Run server kept a bare
// "Route not found." — and the App Run server is the one bound to all
// interfaces, so it is the only 404 a remote consumer ever sees. That asymmetry
// let the false "verify_evidence 未上线" come back a second time. One builder,
// both callers: a surface can no longer drift into being unhelpful on its own.
function buildNotFoundError(pathname) {
  const mistaken = findCapabilityByMistakenPath(pathname);
  if (!mistaken) {
    return { code: "not-found", message: "Route not found." };
  }
  return {
    code: "not-found",
    statusHint: mistaken.status,
    capabilityId: mistaken.id,
    message:
      `Route not found: ${pathname}. This is not a Zhuzhu capability path; the closest real one is ` +
      `${mistaken.http.method} ${mistaken.http.path} (capability ${mistaken.id}, status ${mistaken.status}).` +
      (mistaken.mcpTool ? ` MCP tool: ${mistaken.mcpTool}.` : "") +
      " Read GET /capabilities before wiring any endpoint — never guess a path.",
  };
}

// Every HTTP path a capability claims, flattened — what the Z25-1/Z25-2 tests
// walk to prove no `ga` entry points at a route that does not exist.
function listCapabilityRoutes({ surface = null } = {}) {
  const routes = [];
  for (const item of listCapabilities({ surface })) {
    if (item.http) {
      routes.push({
        ...item.http,
        capabilityId: item.id,
        status: item.status,
        surface: item.surface,
        // Carried through so the API guard can classify a POST by what the
        // capability DOES rather than by its verb (see api-guard.js).
        readOnly: item.readOnly === true,
      });
    }
    for (const alternate of item.alternateHttp || []) {
      routes.push({
        ...alternate,
        capabilityId: item.id,
        status: item.status,
        surface: alternate.surface || item.surface,
        readOnly: item.readOnly === true,
      });
    }
  }
  return routes;
}

module.exports = {
  CAPABILITIES,
  CATALOG_VERSION,
  INTERNAL_ROUTES,
  buildNotFoundError,
  findCapability,
  findCapabilityByMistakenPath,
  listCapabilities,
  listCapabilityRoutes,
};
