"use strict";


const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const API_TOKEN_FILE = ".zhuzhu-api-token";

// Read-only surface: everything that only observes. These stay open by default so
// the existing consumer's polling does not break on upgrade (facet M-2).
const READ_ONLY_TOOLS = new Set([
  "get_integration_doc",
  "validate_test_file",
  "get_run_summary",
  "list_sessions",
  "list_test_files",
  "read_test_file",
  "get_auth_status",
  "get_env_fingerprint",
  "get_report_card",
  "verify_evidence",
  "preflight",
  // v1.6
  "get_ui_contract",
]);

// Anything that changes the workspace, drives a browser, or spends machine
// resources. Token-gated.
const WRITE_TOOLS = new Set([
  "run_headless",
  "run_app",
  "run_app_batch",
  "cancel_run",
  "write_test_file",
  "bootstrap_auth_profile",
]);

// HTTP route classification. Method-aware: `GET /test-sessions/{id}` is a read,
// `POST /test-sessions` starts a browser.
const READ_ROUTE_PATTERNS = [
  /^\/external-integration-documents$/,
  /^\/test-files$/,
  /^\/test-files\/read$/,
  /^\/app-runs\/status$/,
  /^\/app-runs\/[^/]+$/,
  /^\/app-runs\/[^/]+\/events$/,
  /^\/test-sessions$/,
  /^\/test-sessions\/[^/]+$/,
  /^\/test-sessions\/[^/]+\/report$/,
  /^\/test-sessions\/[^/]+\/report-card$/,
  /^\/test-sessions\/[^/]+\/events$/,
  /^\/test-sessions\/[^/]+\/budget$/,
  /^\/checkpoints$/,
  /^\/preflight$/,
  /^\/env-fingerprint$/,
  /^\/evidence\/verify$/,
  /^\/ui-contract$/,
  /^\/auth\/status$/,
  /^\/health$/,
  /^\/capabilities$/,
  // v1.11 REQ-Z33: the run board is observation only.
  /^\/run-board$/,
  /^\/run-board\/data$/,
  /^\/run-board\/events$/,
];

// The POST routes that only observe, DERIVED from the capability catalog rather
// than hand-listed here. A second hand-maintained list is exactly how the two
// 404 surfaces drifted apart; `readOnly` already exists as the single source of
// truth, so the guard reads it instead of restating it. Required lazily: the
// catalog is a leaf module, but a top-level require would still make the import
// order of two shared modules load-bearing for no benefit.
let readOnlyPostRoutesCache = null;
function readOnlyPostRoutes() {
  if (readOnlyPostRoutesCache) {
    return readOnlyPostRoutesCache;
  }
  const { listCapabilityRoutes } = require("./capability-catalog");
  const patterns = [];
  for (const route of listCapabilityRoutes()) {
    if (String(route.method || "").toUpperCase() !== "POST" || !route.readOnly) {
      continue;
    }
    // `{sessionId}`-style segments become a single non-slash run.
    const source = String(route.path)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\{[^}]*\\\}/g, "[^/]+");
    patterns.push(new RegExp(`^${source}$`));
  }
  readOnlyPostRoutesCache = patterns;
  return patterns;
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

// A token is looked up, never invented on the fly for the API: unlike the
// evidence key (whose absence would silently disable signing), an auto-generated
// API token nobody knows would lock out the very caller it is meant to
// authenticate. Provisioning is an explicit action (`ensureApiToken`).
function resolveApiToken({ workspaceRoot = null } = {}) {
  const fromEnv = String(process.env.ZHUZHU_API_TOKEN || "").trim();
  if (fromEnv) {
    return { token: fromEnv, source: "env:ZHUZHU_API_TOKEN" };
  }
  const root = workspaceRoot || process.cwd();
  const tokenPath = path.join(root, API_TOKEN_FILE);
  try {
    if (fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, "utf8").trim();
      if (token) {
        return { token, source: `file:${API_TOKEN_FILE}` };
      }
    }
  } catch (_error) {
    // treated as "no token configured"
  }
  return { token: null, source: "none" };
}

// Explicit provisioning, for the operator who wants writes locked down.
function ensureApiToken({ workspaceRoot = null } = {}) {
  const existing = resolveApiToken({ workspaceRoot });
  if (existing.token) {
    return existing;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const tokenPath = path.join(workspaceRoot || process.cwd(), API_TOKEN_FILE);
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, source: `file:${API_TOKEN_FILE}(generated)` };
}

function readBearerToken(headers = {}) {
  const authorization = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization).trim());
  if (match) {
    return match[1].trim();
  }
  // A header alternative, because some callers cannot set Authorization.
  const alt = headers["x-zhuzhu-token"] || headers["X-Zhuzhu-Token"];
  return alt ? String(alt).trim() : null;
}

function isLoopbackAddress(address) {
  const value = String(address || "").replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost" || value.startsWith("127.");
}

function classifyHttpRequest(method, pathname) {
  const verb = String(method || "GET").toUpperCase();
  const route = String(pathname || "");
  if (route === "/mcp" || route.startsWith("/mcp/")) {
    // Classified per tool inside the MCP layer; the transport itself is neutral.
    return "mcp";
  }
  if (verb === "OPTIONS") {
    return "read";
  }
  if (verb === "GET" || verb === "HEAD") {
    // Every GET is a read. READ_ROUTE_PATTERNS is kept as the explicit inventory
    // that `readOnlyPostRoutes()` is cross-checked against, not as a gate here —
    // the previous `? "read" : "read"` made that look like a decision when it
    // never was.
    return "read";
  }
  // Some capabilities are read-only but take POST, because their input does not
  // fit in a query string. Classifying by verb alone made `POST /evidence/verify`
  // — a pure verification call — answer a REMOTE caller with "Write/execute
  // requests from outside the loopback interface are refused". That message
  // reads as "this capability is not available to you", which is how a second
  // false "verify_evidence 未上线" got written down. The verb was never the
  // question; `readOnly` in the capability catalog is.
  if (verb === "POST" && readOnlyPostRoutes().some((pattern) => pattern.test(route))) {
    return "read";
  }
  // A known wrong guess at a read-only capability is not a write either — it is
  // not an endpoint at all. Classifying it as a write means a REMOTE caller hits
  // 401 "Write/execute requests are refused" before ever reaching the 404 that
  // would have named the real path, so the one message built to stop the false
  // "未上线" never reaches the only people who need it. Treating it as a read
  // lets the request fall through to that 404. Nothing is exposed: these are
  // fixed strings from `commonMistakes`, they route nowhere, and the catalog
  // that names the real path is already an open read.
  const mistaken = findMistakenReadOnlyPath(route);
  if (mistaken) {
    return "read";
  }
  return "write";
}

function findMistakenReadOnlyPath(route) {
  const { findCapabilityByMistakenPath } = require("./capability-catalog");
  const capability = findCapabilityByMistakenPath(route);
  return capability && capability.readOnly === true ? capability : null;
}

function classifyTool(name) {
  if (READ_ONLY_TOOLS.has(name)) {
    return "read";
  }
  if (WRITE_TOOLS.has(name)) {
    return "write";
  }
  // Unknown tools are treated as writes. Fail closed: a new tool added without
  // updating this table must not default to "anyone may call it".
  return "write";
}

// The single decision function. `scope` is "read" | "write".
function authorize({ scope, headers = {}, remoteAddress = null, workspaceRoot = null, token = undefined } = {}) {
  const configured = token === undefined ? resolveApiToken({ workspaceRoot }) : { token, source: "provided" };
  const presented = readBearerToken(headers);
  const loopback = isLoopbackAddress(remoteAddress);
  const tokenMatches = Boolean(configured.token && presented && safeEqual(presented, configured.token));

  if (scope === "read") {
    if (envFlag("ZHUZHU_API_REQUIRE_TOKEN_FOR_READS", false) && !tokenMatches) {
      return {
        allowed: false,
        scope,
        reason: "This deployment requires a bearer token for read requests as well (ZHUZHU_API_REQUIRE_TOKEN_FOR_READS=1).",
        loopback,
        tokenPresented: Boolean(presented),
      };
    }
    return { allowed: true, scope, loopback, tokenPresented: Boolean(presented), tokenMatches };
  }

  if (!configured.token) {
    if (loopback) {
      return {
        allowed: true,
        scope,
        loopback,
        tokenPresented: Boolean(presented),
        tokenMatches: false,
        securityAdvisory:
          "No API token is configured, so this write was allowed because it came from the loopback interface. " +
          "Configure ZHUZHU_API_TOKEN (or place .zhuzhu-api-token in the workspace root) before exposing this port.",
      };
    }
    return {
      allowed: false,
      scope,
      loopback,
      tokenPresented: Boolean(presented),
      reason:
        "Write/execute requests from outside the loopback interface are refused while no API token is configured. " +
        "Set ZHUZHU_API_TOKEN (or .zhuzhu-api-token in the workspace root) and send it as `Authorization: Bearer <token>`.",
    };
  }

  if (tokenMatches) {
    return { allowed: true, scope, loopback, tokenPresented: true, tokenMatches: true };
  }
  if (loopback && envFlag("ZHUZHU_API_ALLOW_LOOPBACK", false)) {
    return {
      allowed: true,
      scope,
      loopback,
      tokenPresented: Boolean(presented),
      tokenMatches: false,
      securityAdvisory: "Loopback write allowed without a token because ZHUZHU_API_ALLOW_LOOPBACK=1.",
    };
  }
  return {
    allowed: false,
    scope,
    loopback,
    tokenPresented: Boolean(presented),
    reason: presented
      ? "The supplied bearer token does not match this workspace's API token."
      : "This write/execute request requires `Authorization: Bearer <token>` (see the workspace .zhuzhu-api-token).",
  };
}

// Constant-time-ish comparison. Not because a timing attack on a LAN QA box is
// realistic, but because `===` on secrets is the kind of thing that gets copied.
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function summarizeParams(value, maxLength = 400) {
  if (value == null) {
    return null;
  }
  try {
    // Redact anything credential-shaped before it reaches an audit file that is
    // meant to be readable by whoever investigates the night.
    const redacted = JSON.parse(
      JSON.stringify(value, (key, item) =>
        /token|password|secret|cookie|authorization/i.test(key) ? "[redacted]" : item,
      ),
    );
    const text = JSON.stringify(redacted);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch (_error) {
    return null;
  }
}

function auditFilePath(outputRoot, at = new Date()) {
  const stamp = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
  ].join("");
  return path.join(outputRoot, "audit", `api-${stamp}.jsonl`);
}

// Append-only, one JSON object per line. Never throws: an audit write failure
// must not become a reason the platform stops working (it is recorded as a
// console warning by the caller if it cares).
async function appendAuditRecord({ outputRoot, record, at = new Date() } = {}) {
  if (!outputRoot || !record) {
    return null;
  }
  const filePath = auditFilePath(outputRoot, at);
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // Two timestamps on purpose. `at` is the unambiguous instant (UTC); `atLocal`
    // matches the file name, which is a LOCAL date — an investigator opening
    // `api-20260825.jsonl` to find what happened at 3am must not be greeted by
    // entries stamped the 24th because the machine sits east of Greenwich.
    const line = {
      at: at.toISOString(),
      atLocal: formatLocalTimestamp(at),
      ...record,
      // Defence in depth: even if a caller passes raw params, nothing
      // credential-shaped reaches a file meant to be read by whoever
      // investigates the night.
      ...(record.params !== undefined ? { params: summarizeParams(record.params) } : {}),
    };
    await fsp.appendFile(filePath, `${JSON.stringify(line)}\n`);
    return filePath;
  } catch (_error) {
    return null;
  }
}

function formatLocalTimestamp(at) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

// The default bind host: loopback unless explicitly opened. This inverts the
// pre-v1.5 default (`0.0.0.0`).
function resolveBindHost() {
  const declared = String(process.env.ZHUZHU_APP_RUN_HOST || "").trim();
  return declared || "127.0.0.1";
}

function isNetworkExposed(host = resolveBindHost()) {
  return host !== "127.0.0.1" && host !== "::1" && host !== "localhost";
}

module.exports = {
  API_TOKEN_FILE,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  appendAuditRecord,
  auditFilePath,
  authorize,
  classifyHttpRequest,
  classifyTool,
  ensureApiToken,
  isLoopbackAddress,
  isNetworkExposed,
  readBearerToken,
  resolveApiToken,
  resolveBindHost,
  summarizeParams,
};
