"use strict";


const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { getDefaultZhuzhuUserDataRoot } = require("./workspace-preferences");

const ENDPOINT_DIR_NAME = "Vision E2E Showcase";
const ENDPOINT_FILE_NAME = "endpoint.json";
const ENDPOINT_SCHEMA_VERSION = 1;

function resolveEndpointFilePath() {
  const override = String(process.env.ZHUZHU_ENDPOINT_FILE || "").trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(process.env.ZHUZHU_USER_DATA_DIR || getDefaultZhuzhuUserDataRoot(), ENDPOINT_FILE_NAME);
}

function buildEndpointDocument({
  host = "127.0.0.1",
  port,
  mcpRoute = "/mcp",
  docPath = "/external-integration-documents",
  version = null,
  workspaceRoot = null,
  pid = process.pid,
  startedAt = Date.now(),
  extra = null,
} = {}) {
  // A loopback bind is advertised as 127.0.0.1 rather than 0.0.0.0: a consumer
  // cannot connect to 0.0.0.0, and printing an address that does not work is the
  // v1.7.1 bridge-binding bug all over again.
  const advertisedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const base = `http://${advertisedHost}:${port}`;
  return {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    appRunBaseUrl: base,
    mcpUrl: `${base}${mcpRoute}`,
    docPath,
    docUrl: `${base}${docPath}`,
    capabilitiesUrl: `${base}/capabilities`,
    bindHost: host,
    port,
    version,
    workspaceRoot,
    pid,
    startedAt,
    // `stale` is written on a clean exit instead of deleting the file, so a
    // consumer can tell "Zhuzhu is not running right now" (actionable: start it)
    // from "I have never seen Zhuzhu on this machine" (actionable: install it).
    stale: false,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

// Write the discovery file. Best-effort by design: a read-only or unusual HOME
// must never stop the App from starting — the file is a convenience for
// consumers, not a dependency of the product.
async function writeEndpointFile(options = {}) {
  const filePath = options.filePath || resolveEndpointFilePath();
  const document = buildEndpointDocument(options);
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return { ok: true, filePath, document };
  } catch (error) {
    return { ok: false, filePath, error: error?.message || String(error) };
  }
}

// Mark the file stale on exit. Synchronous because it runs from `will-quit` /
// `exit` handlers, where an await is not guaranteed to complete.
function markEndpointFileStaleSync(options = {}) {
  const filePath = options.filePath || resolveEndpointFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, filePath, skipped: "absent" };
    }
    const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Only OUR record may be invalidated. A second Zhuzhu instance that started
    // later owns the file now; marking it stale on our exit would break a
    // perfectly healthy consumer.
    if (current?.pid && current.pid !== process.pid) {
      return { ok: true, filePath, skipped: "owned-by-another-pid" };
    }
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ ...current, stale: true, stoppedAt: Date.now() }, null, 2)}\n`,
      "utf8",
    );
    return { ok: true, filePath, stale: true };
  } catch (error) {
    return { ok: false, filePath, error: error?.message || String(error) };
  }
}

// The consumer side, shipped here so office-lab (and our own tests) share one
// implementation of "is this record usable". A record whose process is gone is
// reported as stale even if the App died without running its exit handler —
// a crash must not leave a consumer confidently pointing at a dead port.
function readEndpointFile(options = {}) {
  const filePath = options.filePath || resolveEndpointFilePath();
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      filePath,
      reason: "absent",
      message:
        `No Zhuzhu discovery file at ${filePath}. The desktop App is not running (or predates v1.9). ` +
        "Start it; do not fall back to a hardcoded port.",
    };
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ok: false, filePath, reason: "unreadable", message: error?.message || String(error) };
  }
  const alive = isProcessAlive(document?.pid);
  if (document?.stale === true || !alive) {
    return {
      ok: false,
      filePath,
      reason: "stale",
      document,
      message:
        `The Zhuzhu discovery record at ${filePath} is stale (${document?.stale ? "clean exit" : `pid ${document?.pid} is gone`}). ` +
        `Its last known base was ${document?.appRunBaseUrl}. Start the App rather than using that URL.`,
    };
  }
  return { ok: true, filePath, document };
}

function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    // Signal 0 does not deliver anything; it only performs the existence and
    // permission check.
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — alive for our purposes.
    return error?.code === "EPERM";
  }
}

module.exports = {
  ENDPOINT_DIR_NAME,
  ENDPOINT_FILE_NAME,
  ENDPOINT_SCHEMA_VERSION,
  buildEndpointDocument,
  isProcessAlive,
  markEndpointFileStaleSync,
  readEndpointFile,
  resolveEndpointFilePath,
  writeEndpointFile,
};
