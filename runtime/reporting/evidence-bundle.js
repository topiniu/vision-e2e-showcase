"use strict";


const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { scoreDiscriminativePower } = require("../../src/shared/assertion-discrimination");

const BUNDLE_VERSION = 1;
const EVIDENCE_KEY_FILE = ".zhuzhu-evidence-key";

// ---------------------------------------------------------------------------
// failure classification
// ---------------------------------------------------------------------------

const ENV_CODES = new Set([
  "stale-artifact",
  "fingerprint-unavailable",
  "auth-missing",
  "auth-expired",
  "browser-unavailable",
  "browser-oom",
  "session-cancelled",
  "download-capture-unavailable",
  "page-diagnostics-unavailable",
]);
const TIMEOUT_CODES = new Set([
  "step-hard-timeout",
  "page-probe-timeout",
  "session-hard-timeout",
  "run-wedged",
  "run-hard-timeout",
]);
const REACH_CODES = new Set([
  "target-not-found",
  "low-confidence-target",
  "target-ambiguous",
  "testid-never-rendered",
  "navigation-timeout",
  "scope-not-found",
]);
// Actions (as opposed to assertions). A failure here means "the flow could not be
// performed", which is NOT the same claim as "the product produced a wrong value"
// — and conflating them is how a broken test gets reported as a product defect.
const ACTION_KINDS = new Set([
  "click",
  "fill",
  "type",
  "press",
  "check",
  "uncheck",
  "selectOption",
  "comboSearchSelect",
  "cascaderSelect",
  "uploadFile",
  "openUrl",
  "reload",
  "goBack",
  "goForward",
  "scroll",
  "hover",
]);
const VALUE_ASSERTION_KINDS = new Set([
  "assertDom",
  "dom",
  "expectDom",
  "count",
  "assertCount",
  "expectCount",
  "assertResponse",
  "response",
  "expectResponse",
  "networkResponse",
  "expectNetworkResponse",
  "assertFile",
  "expectFile",
  "url-matches",
  "assertUrl",
  "expectUrl",
  "region-similar",
  "assertVisual",
  // v1.11 REQ-Z32: a measured layout verdict is a value comparison.
  "assertLayout",
  "text-exists",
  "text-absent",
  "expectTextExist",
  "expectNoText",
  "assertVisible",
  "composite",
]);

// The precedence order matters and is deliberate:
//   env > auth > timeout > page-error > reach > value-assertion > action
// An environment problem explains everything downstream of it, so it must win;
// "auth" comes next because a failed login explains every downstream red — and
// the inverse is the important part: `recovery.succeeded === true` means the red,
// whatever it is, is NOT about login (facet Z22-2). "reach" outranks
// "value-assertion" because a value comparison that never found its element did
// not actually compare anything (this is the roadmap §4 line
// "reach 漂移导致『红了但其实没测到』").
// The auth verdict is read from `summary.authTrace` (v1.9 REQ-Z22), not from a
// failure code, so that "we tried to log in and it worked" is a positive machine
// fact instead of a default suspicion a reader has to disprove.
function classifyFailureClass({ result = null, summary = null } = {}) {
  const verdictSource = summary?.firstFailure || null;
  const runCode = String(result?.error?.code || summary?.firstFailure?.code || "").trim();
  const stepCode = String(verdictSource?.code || "").trim();
  const codes = [runCode, stepCode].filter(Boolean);

  if (result?.blocked === true || codes.some((code) => ENV_CODES.has(code))) {
    return "env";
  }
  const recovery = summary?.authTrace?.recovery;
  if (recovery && recovery.succeeded === false) {
    // We tried to log in and it did not work. Whatever else went wrong, the
    // identity is the problem — that is the actionable fact.
    return "auth";
  }
  if (codes.some((code) => TIMEOUT_CODES.has(code))) {
    return "timeout";
  }
  if (codes.includes("page-error")) {
    return "page-error";
  }
  if (codes.some((code) => REACH_CODES.has(code)) || codes.some((code) => code.includes("target-not-found"))) {
    return "reach";
  }
  const expectation = verdictSource?.expectation || null;
  const expectationKind = String(expectation?.type || "").trim();
  if (expectation && expectation.ok === false) {
    // A failing assertion whose element was never resolved is reach, not value.
    if (String(expectation.actual ?? "") === "" && String(expectation.expected ?? "") !== "" && codes.includes("expectation-not-met") === false) {
      return VALUE_ASSERTION_KINDS.has(expectationKind) ? "value-assertion" : "action";
    }
    return VALUE_ASSERTION_KINDS.has(expectationKind) || expectation.expected != null ? "value-assertion" : "action";
  }
  if (codes.includes("expectation-not-met")) {
    return "value-assertion";
  }
  const actionType = String(verdictSource?.actionType || "").trim();
  if (ACTION_KINDS.has(actionType)) {
    return "action";
  }
  if (VALUE_ASSERTION_KINDS.has(actionType)) {
    return "value-assertion";
  }
  return codes.length ? "action" : null;
}

// v1.9 REQ-Z24: the same value domain, answered for ONE step.
//
// The case-level `failureClass` above has existed since v1.5, but a consumer
// reading `firstFailure` could not see it — so office-lab's 254 locator-class
// reds were all triaged by opening screenshots. §3.96 measured the split: 92% of
// them were "the element was not on the page yet (state/tab not reached)" and
// only 8% were genuine testid drift. Those two need OPPOSITE fixes ("造数/切 tab"
// vs "改用例"), and the platform emitted one undifferentiated `target-not-found`
// for both. This is the step-level half of closing that.
function classifyStepFailureClass(step = {}) {
  const code = String(step?.code || step?.error?.code || "").trim();
  if (!code && step?.expectation?.ok !== false) {
    return null;
  }
  if (ENV_CODES.has(code)) {
    return "env";
  }
  if (TIMEOUT_CODES.has(code)) {
    return "timeout";
  }
  if (code === "page-error") {
    return "page-error";
  }
  if (REACH_CODES.has(code) || code.includes("target-not-found") || code.includes("scope-not-found")) {
    return "reach";
  }
  const expectation = step?.expectation || null;
  const expectationKind = String(expectation?.type || expectation?.kind || "").trim();
  if (expectation && expectation.ok === false) {
    return VALUE_ASSERTION_KINDS.has(expectationKind) || expectation.expected != null
      ? "value-assertion"
      : "action";
  }
  if (code === "expectation-not-met") {
    return "value-assertion";
  }
  const actionType = String(step?.actionType || "").trim();
  if (VALUE_ASSERTION_KINDS.has(actionType)) {
    return "value-assertion";
  }
  if (ACTION_KINDS.has(actionType)) {
    return "action";
  }
  return code ? "action" : null;
}

// ---------------------------------------------------------------------------
// hashing / signing
// ---------------------------------------------------------------------------

// Deterministic JSON: keys sorted at every level, so two structurally identical
// objects hash identically regardless of insertion order.
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function hashValue(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function hashFileSync(filePath) {
  try {
    return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
  } catch (_error) {
    return null;
  }
}

// Key resolution: env var wins (CI / a shared lab key), then a workspace file,
// then one is generated and persisted. Auto-generation is deliberate: a signing
// feature that requires setup is a feature nobody turns on, and an unsigned
// bundle is indistinguishable from a forged one.
function resolveEvidenceKey({ workspaceRoot = null, create = true } = {}) {
  const fromEnv = String(process.env.ZHUZHU_EVIDENCE_KEY || "").trim();
  if (fromEnv) {
    return { key: fromEnv, source: "env:ZHUZHU_EVIDENCE_KEY" };
  }
  const root = workspaceRoot || process.cwd();
  const keyPath = path.join(root, EVIDENCE_KEY_FILE);
  try {
    if (fs.existsSync(keyPath)) {
      const key = fs.readFileSync(keyPath, "utf8").trim();
      if (key) {
        return { key, source: `file:${EVIDENCE_KEY_FILE}` };
      }
    }
  } catch (_error) {
    // fall through to generation
  }
  if (!create) {
    return { key: null, source: "none" };
  }
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(keyPath, `${generated}\n`, { mode: 0o600 });
    return { key: generated, source: `file:${EVIDENCE_KEY_FILE}(generated)` };
  } catch (_error) {
    // A read-only workspace still gets signing, just not persistence — the
    // signature is then only verifiable within this process lifetime, which the
    // bundle records honestly via `signature.keySource`.
    return { key: generated, source: "ephemeral(generated, not persisted)" };
  }
}

function signBundle(bundle, key) {
  const { signature: _ignored, ...unsigned } = bundle;
  return `hmac-sha256:${crypto.createHmac("sha256", key).update(canonicalize(unsigned)).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// bundle construction
// ---------------------------------------------------------------------------

function readFacets({ caseItem = null, testFile = null } = {}) {
  const candidates = [
    caseItem?.qaTrace?.facets,
    caseItem?.facets,
    caseItem?.tags,
    testFile?.settings?.qaTrace?.facets,
    testFile?.requirement?.facets,
  ];
  for (const candidate of candidates) {
    const list = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
    const facets = list.map((item) => String(item || "").trim()).filter((item) => /REQ[-_]?\d|F\d/i.test(item));
    if (facets.length) {
      return facets;
    }
  }
  return [];
}

function deriveVerdict({ result = null, summary = null } = {}) {
  if (result?.blocked === true) {
    return "blocked";
  }
  const status = summary?.status || (result?.ok === true ? "passed" : result?.ok === false ? "failed" : null);
  if (status === "passed") {
    return "green";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "failed") {
    return "red";
  }
  // An unknown status must never resolve to green.
  return "blocked";
}

function buildEvidenceBundle({
  sessionId = null,
  roundId = null,
  caseId = null,
  caseName = null,
  testFile = null,
  caseItem = null,
  result = null,
  summary = null,
  precheckIssues = [],
  codeRefs = null,
  workspaceRoot = null,
  sign = true,
} = {}) {
  const verdict = deriveVerdict({ result, summary });
  const failureClass = verdict === "green" ? null : classifyFailureClass({ result, summary });
  const discriminativePower = scoreDiscriminativePower({
    caseItem: caseItem || { id: caseId, steps: [] },
    issues: precheckIssues,
  });
  const telemetry = result?.telemetry || {};
  const artifacts = result?.evidence || summary?.artifacts || {};
  const summaryPath = artifacts.summaryPath || summary?.artifacts?.summaryPath || null;

  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    generatedAt: Date.now(),
    sessionId,
    roundId,
    caseId: caseId || summary?.testContext?.caseId || null,
    caseName: caseName || summary?.testContext?.caseName || null,
    testFileId: testFile?.id || summary?.testContext?.testFileId || null,
    testFilePath: summary?.testContext?.testFilePath || null,
    facets: readFacets({ caseItem, testFile }),
    verdict,
    failureClass,
    // Present on any non-green verdict so the consumer never has to read prose.
    firstFailure: summary?.firstFailure
      ? {
          stepId: summary.firstFailure.stepId || null,
          stepIndex: summary.firstFailure.stepIndex ?? null,
          code: summary.firstFailure.code || null,
          actionType: summary.firstFailure.actionType || null,
          // Deliberately NOT the message: the whole point of `failureClass` is
          // that judgements stop depending on human-authored text (facet D-4).
          expected: summary.firstFailure.expectation?.expected ?? null,
          actual: summary.firstFailure.expectation?.actual ?? null,
        }
      : null,
    discriminativePower,
    stepCounts: summary?.stepCounts || null,
    durationMs: telemetry.durationMs ?? summary?.durationMs ?? null,
    // What this verdict is *about* (Z-B) and what the page did while producing it
    // (Z-A) are part of the evidence, not a separate report.
    environmentFingerprint: telemetry.environmentFingerprint ?? summary?.environmentFingerprint ?? null,
    pageErrors: (telemetry.pageErrors ?? summary?.pageErrors) || null,
    dataResidue: telemetry.dataResidue ?? null,
    // v1.9 REQ-Z22: did auth run and did it succeed? Part of the bundle (and so
    // part of the signature) precisely so the Z22-4 verify facet can prove it was
    // not tampered with — the whole point of this field is that it settles a
    // dispute, and an unsigned "settles a dispute" field settles nothing.
    authTrace: telemetry.authTrace ?? summary?.authTrace ?? null,
    codeRefs: codeRefs || null,
    artifacts: {
      runDir: artifacts.runDir || null,
      reportPath: artifacts.reportPath || null,
      summaryPath,
      screenshots: Array.isArray(summary?.steps)
        ? summary.steps.filter((step) => step.beforeScreenshotPath || step.afterScreenshotPath).length
        : null,
      trace: summary?.firstFailure?.tracePath || null,
      downloads: (telemetry.downloads?.files || []).map((file) => ({
        fileName: file.fileName,
        size: file.size,
        sha256: file.sha256,
        path: file.path,
      })),
    },
    // The two hashes a verifier recomputes. `testHash` pins WHAT was run (so a
    // bundle cannot be reattached to a different, weaker case), `summaryHash`
    // pins the raw result file on disk.
    testHash: hashValue({
      caseId: caseItem?.id ?? caseId,
      steps: (caseItem?.steps || []).map((step) => ({
        id: step.id ?? null,
        type: step.type ?? step.kind ?? null,
        target: step.target ?? null,
        expectation: step.expectation ?? null,
        value: step.value ?? null,
      })),
    }),
    summaryHash: summaryPath ? hashFileSync(summaryPath) : null,
  };

  if (!sign) {
    return bundle;
  }
  const { key, source } = resolveEvidenceKey({ workspaceRoot });
  bundle.signature = key ? signBundle(bundle, key) : null;
  bundle.signatureKeySource = source;
  return bundle;
}

async function writeEvidenceBundle(bundlePath, bundle) {
  await fsp.mkdir(path.dirname(bundlePath), { recursive: true });
  await fsp.writeFile(bundlePath, JSON.stringify(bundle, null, 2));
  return bundlePath;
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

// Returns `{valid, reasons[], recomputedHashes, verdict, failureClass, discriminativePower}`.
// Every failed check appends a reason naming exactly which field disagreed
// (facet D-1) — "invalid" without the field is not actionable.
function verifyEvidenceBundle({ bundle = null, bundlePath = null, workspaceRoot = null } = {}) {
  let loaded = bundle;
  if (!loaded && bundlePath) {
    try {
      loaded = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
    } catch (error) {
      return {
        valid: false,
        reasons: [{ field: "bundlePath", detail: `could not read/parse the bundle: ${error?.message || error}` }],
        recomputedHashes: {},
      };
    }
  }
  if (!loaded || typeof loaded !== "object") {
    return { valid: false, reasons: [{ field: "bundle", detail: "no bundle supplied" }], recomputedHashes: {} };
  }
  const reasons = [];
  if (loaded.bundleVersion !== BUNDLE_VERSION) {
    reasons.push({
      field: "bundleVersion",
      detail: `unsupported bundle version ${loaded.bundleVersion} (this build understands ${BUNDLE_VERSION})`,
    });
  }
  const recomputedHashes = {};

  // summaryHash: recompute from the file the bundle points at.
  if (loaded.summaryHash) {
    const summaryPath = loaded.artifacts?.summaryPath || null;
    if (!summaryPath) {
      reasons.push({ field: "artifacts.summaryPath", detail: "the bundle claims a summaryHash but names no summary file" });
    } else if (!fs.existsSync(summaryPath)) {
      reasons.push({ field: "artifacts.summaryPath", detail: `the referenced summary file is gone: ${summaryPath}` });
    } else {
      const actual = hashFileSync(summaryPath);
      recomputedHashes.summaryHash = actual;
      if (actual !== loaded.summaryHash) {
        reasons.push({
          field: "summaryHash",
          detail: `summary.json does not match the signed hash (recorded ${loaded.summaryHash}, actual ${actual}) — the result file was modified after the bundle was issued`,
        });
      }
    }
  }

  // signature: recompute over everything except the signature fields.
  if (loaded.signature) {
    const { key, source } = resolveEvidenceKey({ workspaceRoot, create: false });
    if (!key) {
      reasons.push({
        field: "signature",
        detail:
          "no evidence key is available in this workspace, so the signature cannot be checked. " +
          "Set ZHUZHU_EVIDENCE_KEY or place .zhuzhu-evidence-key in the workspace root.",
      });
    } else {
      const { signature, signatureKeySource, ...unsigned } = loaded;
      const expected = `hmac-sha256:${crypto.createHmac("sha256", key).update(canonicalize(unsigned)).digest("hex")}`;
      recomputedHashes.signature = expected;
      if (expected !== signature) {
        reasons.push({
          field: "signature",
          detail:
            `the signature does not match this workspace's key (${source}). Either a field of the bundle was edited ` +
            "after issuance, or the bundle was produced elsewhere and copied in.",
        });
      }
    }
  } else {
    reasons.push({
      field: "signature",
      detail: "the bundle is unsigned, so nothing about it can be attributed to this engine",
    });
  }

  // Internal consistency: the verdict/failureClass pairing must make sense.
  if (loaded.verdict === "green" && loaded.failureClass) {
    reasons.push({ field: "failureClass", detail: "a green verdict must not carry a failureClass" });
  }
  if (loaded.verdict === "red" && !loaded.failureClass) {
    reasons.push({ field: "failureClass", detail: "a red verdict must state its failureClass" });
  }
  if (!["green", "red", "blocked"].includes(loaded.verdict)) {
    reasons.push({ field: "verdict", detail: `"${loaded.verdict}" is not one of green|red|blocked` });
  }

  return {
    valid: reasons.length === 0,
    reasons,
    recomputedHashes,
    verdict: loaded.verdict ?? null,
    failureClass: loaded.failureClass ?? null,
    discriminativePower: loaded.discriminativePower ?? null,
    caseId: loaded.caseId ?? null,
    facets: loaded.facets || [],
    // The single question the consumer actually asks: "is this red good enough to
    // count as RED calibration?" Answered structurally, with no reference to any
    // human-authored text.
    redCalibrated: loaded.verdict === "red" && loaded.failureClass === "value-assertion",
  };
}

module.exports = {
  BUNDLE_VERSION,
  EVIDENCE_KEY_FILE,
  buildEvidenceBundle,
  canonicalize,
  classifyFailureClass,
  classifyStepFailureClass,
  deriveVerdict,
  hashValue,
  resolveEvidenceKey,
  signBundle,
  verifyEvidenceBundle,
  writeEvidenceBundle,
};
