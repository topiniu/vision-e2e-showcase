const EVIDENCE_SOURCES = [
  "schema",
  "static-analysis",
  "dry-run-snapshot",
  "last-run-trace",
  "app-contract",
  "runtime-report",
  "heuristic",
];

const ISSUE_REGISTRY = {
  "draft-validation-error": {
    category: "schema",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  "invalid-json": {
    category: "schema",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  "target-missing": {
    category: "locator",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: { locatorScore: -60 },
  },
  "target-weak-text-only": {
    category: "locator",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: { locatorScore: -24 },
  },
  "target-index-only": {
    category: "locator",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: { locatorScore: -30 },
  },
  "icon-only-with-icon-hint-only": {
    category: "locator",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: { locatorScore: -45 },
  },
  "dry-run-target-not-found": {
    category: "locator",
    defaultSeverity: "blocking",
    patchable: true,
    scoreImpact: { locatorScore: -55 },
  },
  "testid-never-rendered": {
    category: "locator",
    defaultSeverity: "blocking",
    patchable: true,
    scoreImpact: { locatorScore: -60 },
  },
  "dry-run-target-ambiguous": {
    category: "locator",
    defaultSeverity: "blocking",
    patchable: true,
    scoreImpact: { locatorScore: -35 },
  },
  "assert-dom-table-row-scope-risk": {
    category: "proof",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: { proofScore: -22 },
  },
  "assert-dom-target-risk": {
    category: "locator",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: { locatorScore: -20 },
  },
  "radio-checked-assertion-risk": {
    category: "proof",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: { proofScore: -20 },
  },
  "network-response-url-missing": {
    category: "proof",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: { proofScore: -42 },
  },
  "response-body-path-missing": {
    category: "proof",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: { proofScore: -18 },
  },
  "wait-for-change-only-business-proof": {
    category: "proof",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: { proofScore: -55 },
  },
  "top-level-assertdom-nested-expectation-shadowed": {
    category: "proof",
    defaultSeverity: "blocking",
    patchable: true,
    scoreImpact: { proofScore: -70 },
  },
  "search-global-assert-visible": {
    category: "proof",
    defaultSeverity: "blocking",
    patchable: true,
    scoreImpact: { proofScore: -38 },
  },
  "unknown-template-variable": {
    category: "data",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  // v1.10 Z28-2: an operator the runtime does not know. Pre-v1.10 it silently
  // evaluated as `equals` (so `notEquals` asserted equality); now it is an error.
  "unsupported-assertion-operator": {
    category: "schema",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  // v1.11 REQ-Z30: a viewport the runtime would refuse (misspelt key, out of range).
  "invalid-viewport": {
    category: "schema",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  // v1.11 REQ-Z31: a routeFault the runtime would refuse (no pattern, bad mode/status).
  "invalid-route-fault": {
    category: "schema",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  // v1.11 REQ-Z32: an assertLayout that checks nothing or has no items.
  "invalid-layout-assertion": {
    category: "schema",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  // v1.10 Z28-4: `saveAs` on a `[]` fan-out path captures the list as JSON text.
  "capture-fanout-without-first": {
    category: "data",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  // v1.10 Z27: a URL that pins the file to one machine's environment.
  "hardcoded-origin": {
    category: "data",
    defaultSeverity: "info",
    patchable: false,
    scoreImpact: {},
  },
  // v1.10 Z27: the `target.origins` names this file references.
  "target-origins-required": {
    category: "data",
    defaultSeverity: "info",
    patchable: false,
    scoreImpact: {},
  },
  // v1.10 Z27: session-time target errors (raised by POST /test-sessions, listed
  // here so `GET /schema/precheck-rules` documents them).
  "target-origin-missing": {
    category: "schema",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  "target-origin-denied": {
    category: "security",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  "target-unreachable": {
    category: "environment",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  // v1.4 REQ-Z17: baseUrl / login-model advice. `base-url-login-page` is the
  // efficiency direction (every case is re-navigated to baseUrl, so a login-page
  // baseUrl means every case starts on /login for nothing); the legacy
  // `missing-login-bootstrap` only stands for files with no login recovery at all.
  "base-url-login-page": {
    category: "general",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: {},
  },
  "missing-login-bootstrap": {
    category: "general",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  // v1.5 Z-A: muting the page-error gate must stay auditable. An allowlist entry
  // without a `reason` is how "one keystroke silences the gate forever" happens.
  "page-error-allowlist-without-reason": {
    category: "general",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  // v1.9 REQ-Z23-4/5: an allowlist entry that is *too broad* silently eats real
  // product defects. The 2026-08-26 round shipped seven of these into a SHARED
  // base file — `"deprecated"`, `"Failed to fetch"`, and the product's own
  // micro-frontend host among them — because no narrower expression existed at
  // the time. Now one does (url/origin/phase), so the over-broad shapes get named
  // and the fix is one field away. Advisory, never blocking: a false-blocking
  // heuristic on allowlists would simply get switched off.
  "page-error-allowlist-too-broad": {
    category: "general",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: {},
  },
  "page-error-allowlist-unscoped-resource": {
    category: "general",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: {},
  },
  "page-error-allowlist-same-origin": {
    category: "general",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  // v1.5 Z-H: assertion *discriminative power*. Every code here describes an
  // assertion that looks like it proves something but cannot fail for the reason
  // the author believes — the "weak oracle" family from the v5.19 post-mortem.
  // All advisory (never blocking): they lower the proof score and are surfaced in
  // the report / evidence bundle so a consumer can see the risk, because a
  // false-blocking rule on a heuristic would just get switched off.
  "weak-oracle-closed-select": {
    category: "proof",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: { proofScore: -30 },
  },
  "capture-concatenated-text": {
    category: "proof",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: { proofScore: -26 },
  },
  "absent-without-presence-baseline": {
    category: "proof",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: { proofScore: -22 },
  },
  "assertion-without-value": {
    category: "proof",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: { proofScore: -18 },
  },
  "testid-not-forwarded": {
    category: "locator",
    defaultSeverity: "warning",
    patchable: true,
    scoreImpact: { locatorScore: -28 },
  },
  "virtualized-list-select": {
    category: "locator",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: { locatorScore: -18 },
  },
  "app-contract-stale": {
    category: "contract",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  "app-contract-version-mismatch": {
    category: "contract",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  "app-contract-low-confidence": {
    category: "contract",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  },
  "app-contract-conflict": {
    category: "contract",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
  "proof-regression": {
    category: "patch-review",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: { proofScore: -100 },
  },
  "locator-regression": {
    category: "patch-review",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: { locatorScore: -100 },
  },
  "patch-stale": {
    category: "patch-review",
    defaultSeverity: "blocking",
    patchable: false,
    scoreImpact: {},
  },
};

function getIssueDefinition(code) {
  return ISSUE_REGISTRY[code] || {
    category: "general",
    defaultSeverity: "warning",
    patchable: false,
    scoreImpact: {},
  };
}

function normalizeSeverity(severity) {
  if (severity === "error" || severity === "blocking") {
    return "blocking";
  }
  if (severity === "info") {
    return "info";
  }
  return "warning";
}

function createRegisteredIssue(code, input = {}) {
  const definition = getIssueDefinition(code);
  const severity = normalizeSeverity(input.severity || definition.defaultSeverity);
  const evidenceSource = EVIDENCE_SOURCES.includes(input.evidenceSource)
    ? input.evidenceSource
    : "static-analysis";
  const evidenceConfidence = Number.isFinite(Number(input.evidenceConfidence))
    ? Math.max(0, Math.min(1, Number(input.evidenceConfidence)))
    : evidenceSource === "heuristic"
      ? 0.62
      : 0.9;
  return {
    code,
    severity,
    category: input.category || definition.category,
    caseId: input.caseId || null,
    stepId: input.stepId || null,
    path: input.path || "$",
    message: input.message || code,
    reason: input.reason || input.message || code,
    evidenceSource,
    evidenceConfidence,
    ...(input.caseName ? { caseName: input.caseName } : {}),
    ...(Number.isInteger(input.caseIndex) ? { caseIndex: input.caseIndex } : {}),
    ...(Number.isInteger(input.stepIndex) ? { stepIndex: input.stepIndex } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.suggestedPatch ? { suggestedPatch: input.suggestedPatch } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.scoreImpact ? { scoreImpact: input.scoreImpact } : definition.scoreImpact && Object.keys(definition.scoreImpact).length ? { scoreImpact: definition.scoreImpact } : {}),
  };
}

module.exports = {
  EVIDENCE_SOURCES,
  ISSUE_REGISTRY,
  createRegisteredIssue,
  getIssueDefinition,
  normalizeSeverity,
};
