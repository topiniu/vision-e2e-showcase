"use strict";


const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const { collectEnvironmentFingerprint } = require("../../runtime/perception/environment-fingerprint");
const { verifyEvidenceBundle } = require("../../runtime/reporting/evidence-bundle");
const { buildReportCard } = require("../../runtime/server/report-card");
const { runPreflight } = require("../../runtime/server/preflight");
const { bootstrapAuthProfile } = require("../../runtime/server/auth-bootstrap");
const { applyRunTarget, normalizeRunTarget } = require("../shared/run-target");
const { resolveTestFileReferences } = require("../shared/test-file-references");
const { buildUiContract, findComponentEntries } = require("../../runtime/server/ui-contract");

function readQuery(query, key) {
  if (!query) {
    return "";
  }
  return (typeof query.get === "function" ? query.get(key) : query[key]) || "";
}

function parseJsonParam(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === "object") {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Z-B: GET /env-fingerprint?baseUrl=...
// ---------------------------------------------------------------------------

// Deliberately uses its OWN short-lived headless browser rather than the visible
// panel's page: probing must never navigate the browser a human (or a running
// case) is using. ~1s, and it is the same collector a real run uses, so the
// answer here and the answer in the evidence cannot disagree.
async function probeEnvironmentFingerprint(args = {}, deps = {}) {
  const { launchBrowser, browserContext = null } = deps;
  const baseUrl = String(args.baseUrl || "").trim();
  if (!baseUrl) {
    return {
      statusCode: 400,
      payload: { ok: false, error: { code: "invalid-request", message: "baseUrl is required." } },
    };
  }
  if (typeof launchBrowser !== "function") {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        error: { code: "capability-unavailable", message: "No browser launcher is available on this host." },
      },
    };
  }
  let browser = null;
  let context = null;
  try {
    browser = await launchBrowser({ headless: true, launchOptions: browserContext?.launchOptions || null });
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(browserContext?.contextOptions || {}),
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const fingerprint = await collectEnvironmentFingerprint(page, {
      baseUrl,
      backendProbes: Array.isArray(args.backendProbes) ? args.backendProbes : [],
      frontendProbe: args.frontendProbe || null,
    });
    return { statusCode: 200, payload: { ok: true, data: fingerprint } };
  } catch (error) {
    return {
      statusCode: 502,
      payload: {
        ok: false,
        error: {
          code: "fingerprint-probe-failed",
          message: `Could not fingerprint ${baseUrl}: ${error?.message || String(error)}`,
          retriable: true,
        },
      },
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Z-D: GET/POST /evidence/verify
// ---------------------------------------------------------------------------

// Locate a bundle from a session handle. Kept here (not in the bundle module)
// because it depends on the session store layout, which the runtime reporting
// layer should not know about.
async function resolveBundlePath({ sessionId, caseId, store }) {
  if (!sessionId || !store) {
    return null;
  }
  const session = await store.readSession(sessionId);
  if (!session) {
    return null;
  }
  const rounds = Array.isArray(session.rounds) ? session.rounds : [];
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const bundles = rounds[index]?.evidenceBundles || [];
    const match = caseId ? bundles.find((item) => item.caseId === caseId) : bundles[0];
    if (match?.bundlePath) {
      return match.bundlePath;
    }
  }
  return null;
}

async function verifyEvidence(args = {}, deps = {}) {
  const { store, workspaceRoot = null } = deps;
  let bundlePath = String(args.bundlePath || "").trim() || null;
  if (!bundlePath && args.sessionId) {
    bundlePath = await resolveBundlePath({
      sessionId: String(args.sessionId).trim(),
      caseId: args.caseId ? String(args.caseId).trim() : null,
      store,
    });
  }
  if (!bundlePath) {
    return {
      statusCode: 400,
      payload: {
        ok: false,
        error: {
          code: "bundle-not-found",
          message:
            "Provide `bundlePath`, or a `sessionId` (+ optional `caseId`) whose round carries an evidence bundle. " +
            "Sessions produced before v1.5 have no bundles.",
        },
      },
    };
  }
  if (!fsSync.existsSync(bundlePath)) {
    return {
      statusCode: 404,
      payload: { ok: false, error: { code: "bundle-not-found", message: `No evidence bundle at ${bundlePath}` } },
    };
  }
  const result = verifyEvidenceBundle({ bundlePath, workspaceRoot });
  return {
    // A bundle that fails verification is a successful *answer*, not a failed
    // request — the caller asked "is this trustworthy" and got a clear no.
    statusCode: 200,
    payload: { ok: true, data: { bundlePath, ...result } },
  };
}

// ---------------------------------------------------------------------------
// Z-K: GET /test-sessions/{id}/report-card
// ---------------------------------------------------------------------------

async function readTestFileForSession(session, { testWorkflowsRoot }) {
  const relative = session?.testFile?.path;
  if (!relative || !testWorkflowsRoot) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(path.join(testWorkflowsRoot, relative), "utf8"));
  } catch (_error) {
    return null;
  }
}

async function getReportCard(args = {}, deps = {}) {
  const { store, testWorkflowsRoot = null, precheck = null } = deps;
  const sessionId = String(args.sessionId || "").trim();
  if (!sessionId) {
    return { statusCode: 400, payload: { ok: false, error: { code: "invalid-request", message: "sessionId is required." } } };
  }
  const session = await store.readSession(sessionId);
  if (!session) {
    return { statusCode: 404, payload: { ok: false, error: { code: "not-found", message: "Test session not found." } } };
  }
  const testFile = await readTestFileForSession(session, { testWorkflowsRoot });
  // The precheck is re-run (cheap, pure) rather than persisted, so the card's
  // weak-oracle risks reflect the file as it is *now* — which is what a reader
  // acting on the card will look at.
  let precheckResult = null;
  if (typeof precheck === "function" && testFile) {
    try {
      precheckResult = precheck({ testFile, rootDir: testWorkflowsRoot });
    } catch (_error) {
      precheckResult = null;
    }
  }
  const card = await buildReportCard({ session, testFile, precheck: precheckResult });
  return { statusCode: 200, payload: { ok: true, data: card } };
}

// ---------------------------------------------------------------------------
// Z-L: GET /preflight
// ---------------------------------------------------------------------------

async function preflight(args = {}, deps = {}) {
  const {
    workspaceRoot,
    launchBrowser = null,
    browserContext = null,
    getAuthStatus = null,
    listSessions = null,
    appRunStatus = null,
    ocrAvailable = null,
  } = deps;
  const report = await runPreflight({
    workspaceRoot,
    baseUrl: args.baseUrl ? String(args.baseUrl).trim() : null,
    profile: args.profile ? String(args.profile).trim() : null,
    backendProbes: Array.isArray(args.backendProbes) ? args.backendProbes : [],
    freshness: args.freshness || null,
    getAuthStatus,
    listSessions,
    appRunStatus,
    ocrAvailable,
    headlessAvailable: typeof launchBrowser === "function",
    collectFingerprint: typeof launchBrowser === "function"
      ? async ({ baseUrl }) => {
          const { payload } = await probeEnvironmentFingerprint(
            { baseUrl, backendProbes: [] },
            { launchBrowser, browserContext },
          );
          if (!payload?.ok) {
            throw new Error(payload?.error?.message || "fingerprint probe failed");
          }
          return payload.data;
        }
      : null,
  });
  // `ready:false` is a valid answer to a well-formed question, so the HTTP status
  // stays 200 — a 5xx here would make dispatchers retry instead of read.
  return { statusCode: 200, payload: { ok: true, data: report } };
}

// ---------------------------------------------------------------------------
// Z-F: POST /auth-profiles/{name}/bootstrap
// ---------------------------------------------------------------------------

async function bootstrapProfile(args = {}, deps = {}) {
  const {
    store,
    outputRoot,
    outputRunsRoot,
    workspaceRoot,
    testWorkflowsRoot,
    launchBrowser,
    browserContext = null,
    runImpl,
  } = deps;
  if (typeof launchBrowser !== "function" || typeof runImpl !== "function") {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        error: { code: "capability-unavailable", message: "No browser/runner is available on this host." },
      },
    };
  }
  // Allow bootstrapping from a test file's own `recovery.login`, so there is one
  // definition of "how to log in" rather than a second one that drifts.
  let testFile = args.testFile || null;
  if (!testFile && args.testFilePath && testWorkflowsRoot) {
    try {
      testFile = JSON.parse(await fs.readFile(path.join(testWorkflowsRoot, args.testFilePath), "utf8"));
    } catch (_error) {
      testFile = null;
    }
  }
  // v1.10: `recovery.login` usually lives in a shared base file pulled in by
  // `extends`; reading the raw file alone found no login steps for those.
  if (testFile && testWorkflowsRoot) {
    try {
      testFile = resolveTestFileReferences(testFile, { rootDir: testWorkflowsRoot });
    } catch (_error) {
      // Fall back to the raw file; bootstrap reports "no login steps" itself.
    }
  }
  // v1.10 Z27: a file written against `{{origin.*}}` needs the same target the
  // run will use, or the login would navigate to the literal template.
  let target = null;
  if (testFile) {
    try {
      target = normalizeRunTarget(args.target ?? null);
      testFile = applyRunTarget(testFile, target).testFile;
    } catch (error) {
      return {
        statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 400,
        payload: {
          ok: false,
          error: { code: error?.code || "invalid-target", message: error?.message || String(error), ...(error?.details ? { details: error.details } : {}) },
        },
      };
    }
  }
  const result = await bootstrapAuthProfile(
    {
      profile: args.profile,
      credentialRef: args.credentialRef || target?.credentialRef || null,
      loginSteps: args.loginSteps || null,
      testFile,
      baseUrl: args.baseUrl || null,
      force: args.force === true,
    },
    { runImpl, launchBrowser, outputRoot, outputRunsRoot, workspaceRoot, browserContext, store },
  );
  return { statusCode: result.ok ? 200 : result.error?.code === "profile-exists" ? 409 : 400, payload: result };
}

// ---------------------------------------------------------------------------
// Z-P: GET /ui-contract
// ---------------------------------------------------------------------------

async function getUiContract(args = {}, deps = {}) {
  const { testWorkflowsRoot, outputRunsRoot, workspaceRoot } = deps;
  const contract = await buildUiContract({
    testWorkflowsRoot,
    outputRunsRoot,
    frontendInventoryPath:
      args.frontendInventoryPath ||
      (workspaceRoot ? path.join(workspaceRoot, "ui-contract.json") : null),
    maxRuns: Number(args.maxRuns) > 0 ? Number(args.maxRuns) : 200,
  });
  if (args.component) {
    return {
      statusCode: 200,
      payload: { ok: true, data: { ...findComponentEntries(contract, args.component), sources: contract.sources } },
    };
  }
  return { statusCode: 200, payload: { ok: true, data: contract } };
}

// ---------------------------------------------------------------------------
// route matcher
// ---------------------------------------------------------------------------

// Returns null when `pathname` is not one of these routes, so the caller falls
// through to its existing dispatch chain.
async function handleGuardedRunRoute({ method, pathname, query, body }, deps = {}) {
  const verb = String(method || "GET").toUpperCase();
  const route = String(pathname || "");

  if (route === "/preflight" && (verb === "GET" || verb === "POST")) {
    const args = verb === "POST" && body && typeof body === "object"
      ? body
      : {
          baseUrl: readQuery(query, "baseUrl"),
          profile: readQuery(query, "profile"),
          backendProbes: parseJsonParam(readQuery(query, "backendProbes")) || [],
          freshness: parseJsonParam(readQuery(query, "freshness")),
        };
    return preflight(args, deps);
  }

  if (route === "/env-fingerprint" && (verb === "GET" || verb === "POST")) {
    const args = verb === "POST" && body && typeof body === "object"
      ? body
      : {
          baseUrl: readQuery(query, "baseUrl"),
          backendProbes: parseJsonParam(readQuery(query, "backendProbes")) || [],
        };
    return probeEnvironmentFingerprint(args, deps);
  }

  if (route === "/evidence/verify" && (verb === "GET" || verb === "POST")) {
    const args = verb === "POST" && body && typeof body === "object"
      ? body
      : {
          bundlePath: readQuery(query, "bundlePath"),
          sessionId: readQuery(query, "sessionId"),
          caseId: readQuery(query, "caseId"),
        };
    return verifyEvidence(args, deps);
  }

  const reportCardMatch = /^\/test-sessions\/([^/]+)\/report-card$/.exec(route);
  if (reportCardMatch && verb === "GET") {
    return getReportCard({ sessionId: decodeURIComponent(reportCardMatch[1]) }, deps);
  }

  if (route === "/ui-contract" && verb === "GET") {
    return getUiContract(
      { component: readQuery(query, "component"), maxRuns: readQuery(query, "maxRuns") },
      deps,
    );
  }

  const bootstrapMatch = /^\/auth-profiles\/([^/]+)\/bootstrap$/.exec(route);
  if (bootstrapMatch && verb === "POST") {
    return bootstrapProfile(
      { ...(body && typeof body === "object" ? body : {}), profile: decodeURIComponent(bootstrapMatch[1]) },
      deps,
    );
  }

  return null;
}

module.exports = {
  bootstrapProfile,
  getReportCard,
  getUiContract,
  handleGuardedRunRoute,
  preflight,
  probeEnvironmentFingerprint,
  resolveBundlePath,
  verifyEvidence,
};
