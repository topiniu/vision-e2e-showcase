"use strict";


const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLAIMS_DIRNAME = "active";

function claimsDir(outputRoot) {
  return path.join(outputRoot, "sessions", CLAIMS_DIRNAME);
}

function claimPath(outputRoot, sessionId) {
  const safe = String(sessionId || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(claimsDir(outputRoot), `${safe}.json`);
}

// `pid` alone is not enough: after a reboot the same pid may belong to something
// else entirely. `bootTime`+`hostname` make the claim identifiable, and the
// process's own start time distinguishes "pid 4321 is my worker" from "pid 4321
// is now a text editor".
function processFingerprint() {
  return {
    pid: process.pid,
    ppid: process.ppid ?? null,
    hostname: os.hostname(),
    // Seconds of uptime at claim time; combined with `claimedAt` this pins the
    // process instance without needing platform-specific process APIs.
    processStartedAt: Math.round(Date.now() - process.uptime() * 1000),
  };
}

function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    // Signal 0 performs the permission/existence check without delivering a
    // signal. EPERM means it exists but belongs to another user — still alive.
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function claimSession({ outputRoot, sessionId, roundId = null, testFileId = null, testFilePath = null, extra = null }) {
  if (!outputRoot || !sessionId) {
    return null;
  }
  const file = claimPath(outputRoot, sessionId);
  const claim = {
    sessionId,
    roundId,
    testFileId,
    testFilePath,
    claimedAt: Date.now(),
    ...processFingerprint(),
    ...(extra && typeof extra === "object" ? { extra } : {}),
  };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(claim, null, 2)}\n`, "utf8");
    return claim;
  } catch (_error) {
    // A claim is a diagnostic aid, not a lock. Failing to write it must never
    // prevent the session from running.
    return null;
  }
}

async function releaseSession({ outputRoot, sessionId }) {
  if (!outputRoot || !sessionId) {
    return false;
  }
  try {
    await fs.rm(claimPath(outputRoot, sessionId), { force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

async function readClaim({ outputRoot, sessionId }) {
  const file = claimPath(outputRoot, sessionId);
  if (!fsSync.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

// The question `cancelTestSession` actually needs answered.
async function inspectClaim({ outputRoot, sessionId }) {
  const claim = await readClaim({ outputRoot, sessionId });
  if (!claim) {
    return { claimed: false, ownedByThisProcess: false, alive: false, claim: null };
  }
  const sameHost = claim.hostname === os.hostname();
  const ownedByThisProcess = sameHost && claim.pid === process.pid;
  const alive = ownedByThisProcess || (sameHost && isProcessAlive(claim.pid));
  return {
    claimed: true,
    claim,
    sameHost,
    ownedByThisProcess,
    // A claim from ANOTHER host cannot be checked from here; treated as alive so
    // we never force-finalize a session another machine is executing.
    alive: sameHost ? alive : true,
    reason: !sameHost
      ? `claimed by ${claim.hostname} (another host) — liveness cannot be checked from here, so it is assumed running`
      : ownedByThisProcess
        ? "claimed by this process"
        : alive
          ? `claimed by live pid ${claim.pid} on this host`
          : `claimed by pid ${claim.pid}, which is no longer running (host restarted or process crashed)`,
  };
}

async function listClaims({ outputRoot, pruneDead = false }) {
  const dir = claimsDir(outputRoot);
  if (!fsSync.existsSync(dir)) {
    return [];
  }
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (_error) {
    return [];
  }
  const claims = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    let claim;
    try {
      claim = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    } catch (_error) {
      continue;
    }
    const sameHost = claim.hostname === os.hostname();
    const alive = sameHost ? isProcessAlive(claim.pid) : true;
    claims.push({ ...claim, sameHost, alive });
    if (pruneDead && sameHost && !alive) {
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }
  return claims.sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0));
}

module.exports = {
  CLAIMS_DIRNAME,
  claimPath,
  claimSession,
  claimsDir,
  inspectClaim,
  isProcessAlive,
  listClaims,
  processFingerprint,
  readClaim,
  releaseSession,
};
