const {
  ASSERT_DOM_SCHEMA,
  CALL_API_SCHEMA,
  EXPECTATION_SCOPE_SCHEMA,
  RESPONSE_ASSERTION_SCHEMA,
  SCAFFOLD_SCHEMA,
  TARGET_SCOPE_SCHEMA,
  VARS_SCHEMA,
} = require("../../src/shared/test-file-precheck");
// v1.9 REQ-Z25: the machine-verifiable capability catalog, and the single source
// the integration doc's endpoint table gets generated from.
const { CAPABILITIES, CATALOG_VERSION } = require("../../src/shared/capability-catalog");
const { ISSUE_REGISTRY } = require("../../src/shared/precheck-issue-registry");
const { INTENTS } = require("../../src/shared/proof-policy");
const { CANONICAL_OPERATORS } = require("../../src/shared/assertion-operators");
const { DEFAULT_DENY_HOSTS } = require("../../src/shared/run-target");
const { STEP_OCR_SETTINGS } = require("../../src/shared/run-gate-options");
const { VIEWPORT_LIMITS } = require("../../src/shared/viewport");
const { ABORT_ERROR_CODES, ROUTE_FAULT_MODES } = require("../../src/shared/route-fault");

const ACTIONS_SCHEMA = {
  click: {
    requires: ["target"],
    supportsExpectation: true,
    preferredExpectations: ["networkResponse", "assertDom", "text-exists"],
  },
  fill: {
    requires: ["target", "value"],
    supportsExpectation: true,
    preferredExpectations: ["assertDom"],
  },
  comboSearchSelect: {
    requires: ["target", "option"],
    supportsExpectation: true,
    targetRecommendations: ["testId", "role=combobox", "placeholder", "target.scope"],
  },
  cascaderSelect: {
    requires: ["target", "option.path"],
    supportsExpectation: true,
    targetRecommendations: ["testId", "placeholder", "target.scope"],
  },
  uploadFile: {
    requires: ["target", "files"],
    supportsExpectation: true,
    preferredExpectations: ["assertDom"],
  },
  assertDom: ASSERT_DOM_SCHEMA,
  callApi: CALL_API_SCHEMA,
  useMacro: SCAFFOLD_SCHEMA.useMacro,
  // v1.11 REQ-Z31
  routeFault: {
    since: "1.11.0",
    requires: ["urlIncludes | urlMatches"],
    fields: {
      urlIncludes: "substring of the request URL",
      urlMatches: "JavaScript regular expression source tested against the request URL",
      method: "optional HTTP method filter (GET/POST/...)",
      mode: `${ROUTE_FAULT_MODES.join(" | ")} (default abort; respond when status/body given)`,
      errorCode: `abort reason, one of ${ABORT_ERROR_CODES.join(", ")} (default failed)`,
      status: "respond: HTTP status (default 500)",
      body: "respond: string, or JSON value (sent as application/json)",
      contentType: "respond: overrides the content type",
      headers: "respond: extra response headers",
      delayMs: "wait before answering/continuing; mode delay requires it",
      times: "fault only the first N matches, later ones pass through",
      minHits: "default 1 — the case fails (route-fault-not-hit) if fewer requests were faulted",
    },
    scope: "the run (= one case); removed when the run ends, also on the shared visible page",
    evidence: "telemetry.routeFaults / summary.routeFaults (hits, hitUrls) + network/route-faults.json",
  },
  // v1.11 REQ-Z32
  assertLayout: {
    since: "1.11.0",
    requires: ["items"],
    fields: {
      target: "{ testId } | { locator } — the container (default document.body)",
      items: "CSS selector inside target, or a list of CSS strings / { testId } / { locator }",
      noOverlap: "default true — visible items must not intersect pairwise (nested pairs excluded)",
      noTruncation: "default true — scrollWidth/Height must not exceed clientWidth/Height; a CSS string narrows which elements are checked",
      withinTarget: "items must lie inside the target box",
      minItems: "default 2 (1 without noOverlap) — fewer visible items fails with layout-items-missing",
      expectCount: "exact visible item count",
      tolerancePx: "default 1",
      timeoutMs: "default 5000 — measured until two samples agree, then judged once",
    },
    failureClass: "value-assertion",
  },
};

function getCapabilityData() {
  return {
    schemaVersion: 2,
    service: "zhuzhu-runtime-v2",
    // v1.9 REQ-Z25: `/capabilities` is now machine-verifiable. Every entry carries
    // `id`, `status` (ga | beta | planned), `mcpTool`, and its real `http.path`.
    // The point: "还没做" (status planned / not listed) and "做了但你打错门"
    // (the path is listed, you 404'd on a guess) are now distinguishable from the
    // response itself, so a consumer never has to guess a path and then infer
    // "not implemented" from the 404. See src/shared/capability-catalog.js.
    catalogVersion: CATALOG_VERSION,
    z: "REQ-Z25",
    capabilities: CAPABILITIES,
    // The legacy flat id list is kept for backward compatibility; consumers that
    // reached it before can keep working, but the rich `capabilities` array is
    // the thing that answers "is this actually built, and where".
    capabilityIds: CAPABILITIES.map((item) => item.id),
    validationModes: ["advisory", "gate", "patch-review"],
    testSession: {
      qualityGate: ["advisory", "gate", "off"],
      authBootstrap: {
        default: "auto",
        modes: ["auto", "run"],
        description: "auto skips manual login bootstrap setup/fixture steps when authProfile storageState contains auth evidence; run forces the file's login steps to execute.",
      },
      // v1.10 Z27: the caller decides where/as whom a file runs.
      target: {
        since: "1.10.0",
        accepts: ["POST /test-sessions", "POST /test-sessions/batch", "POST /app-runs", "run_headless", "run_app", "run_app_batch"],
        fields: {
          origins: "{ name: absoluteHttpUrl } — files reference them as {{origin.<name>}}; every referenced name is required, there is no fallback address.",
          authProfile: "headless storageState profile; must agree with the top-level authProfile if both are given.",
          credentialRef: "key in <workspace>/.zhuzhu-credentials.json; steps read {{credential.<field>}}; secret fields (pass/secret/token/otp/pin) are masked as *** in every artifact, event and result.",
          vars: "{ name: value } overriding the file's vars for this run (source \"target\").",
          preflight: "default true — probe every used origin first; unreachable => session blocked with failureType target-unavailable.",
        },
        errors: {
          "invalid-target": 400,
          "target-origin-missing": 400,
          "target-origin-denied": 400,
          "target-auth-profile-conflict": 400,
          "target-unreachable": "session blocked (failureType target-unavailable)",
          "target-credential-missing": "session blocked (failureType target-unavailable)",
        },
        hostPolicy: {
          defaultDeny: DEFAULT_DENY_HOSTS,
          env: ["ZHUZHU_TARGET_DENY_HOSTS", "ZHUZHU_TARGET_ALLOW_HOSTS"],
        },
      },
      // v1.11 REQ-Z30: viewport per file / case; the measured size is in summary.runContext.viewport.
      viewport: {
        since: "1.11.0",
        fields: ["settings.viewport", "cases[].viewport"],
        shape: "{ width, height } CSS pixels",
        limits: VIEWPORT_LIMITS,
        precedence: "case > settings > channel default (headless 1440x900, visible = window size)",
        evidence: "summary.runContext.viewport { requested, source, effective, mechanism, matches }",
        errors: { "invalid-viewport": "precheck error", "viewport-not-applied": "run failed: measured size differs", "viewport-unsupported": "run failed: page cannot emulate" },
      },
      // v1.10 Z29-1: after-step OCR is evidence only; default it to failed steps.
      stepOcr: { since: "1.10.0", default: "onFailure", modes: STEP_OCR_SETTINGS, setting: "settings.stepOcr", env: "ZHUZHU_STEP_OCR" },
    },
    // v1.10 Z28-2: the closed operator vocabulary; anything else is a precheck
    // error (unsupported-assertion-operator) and a failed assertion at run time.
    assertionOperators: CANONICAL_OPERATORS,
    quality: {
      scoreScale: "0-100",
      grades: { A: "85-100", B: "70-84", C: "55-69", D: "40-54", E: "0-39" },
      intents: INTENTS,
    },
  };
}

function getTestFileSchema() {
  return {
    schemaVersion: 2,
    target: { scope: TARGET_SCOPE_SCHEMA },
    expectation: {
      scope: EXPECTATION_SCOPE_SCHEMA,
      assertDom: ASSERT_DOM_SCHEMA,
      response: RESPONSE_ASSERTION_SCHEMA,
    },
    actions: ACTIONS_SCHEMA,
    scaffold: SCAFFOLD_SCHEMA,
    vars: VARS_SCHEMA,
  };
}

function getActionsSchema() {
  return ACTIONS_SCHEMA;
}

function getExpectationsSchema() {
  return {
    assertDom: ASSERT_DOM_SCHEMA,
    assertResponse: RESPONSE_ASSERTION_SCHEMA,
    networkResponse: RESPONSE_ASSERTION_SCHEMA,
    composite: {
      kind: "composite",
      fields: {
        assertions: { type: "array", required: true },
      },
    },
  };
}

function getPrecheckRulesSchema() {
  return ISSUE_REGISTRY;
}

module.exports = {
  getActionsSchema,
  getCapabilityData,
  getExpectationsSchema,
  getPrecheckRulesSchema,
  getTestFileSchema,
};
