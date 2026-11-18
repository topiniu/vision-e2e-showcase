
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildEvidenceBundle,
  canonicalize,
  classifyFailureClass,
  deriveVerdict,
  resolveEvidenceKey,
  verifyEvidenceBundle,
  writeEvidenceBundle,
} = require("../../runtime/reporting/evidence-bundle");

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSummary(root, summary) {
  const runDir = path.join(root, "output", "runs", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  const summaryPath = path.join(runDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return summaryPath;
}

const CASE_ITEM = {
  id: "case-f1",
  name: "复制文档新建品类",
  steps: [
    { id: "s1", type: "click", stepTitle: "点击复制", target: { testId: "copy-btn" } },
    {
      id: "s2",
      type: "assertDom",
      stepTitle: "assert 品类下拉含任务QA-x",
      target: { testId: "category-select" },
      expectation: { kind: "assertDom", property: "text", operator: "equals", expected: "任务QA-x" },
    },
  ],
};

test("a green case yields a signed bundle with no failureClass", (t) => {
  const root = makeWorkspace(t);
  const summaryPath = writeSummary(root, { status: "passed", stepCounts: { total: 2, passed: 2 }, steps: [] });
  const bundle = buildEvidenceBundle({
    sessionId: "session-1",
    roundId: "round-1",
    caseId: "case-f1",
    caseItem: CASE_ITEM,
    result: { ok: true, telemetry: { durationMs: 1200 }, evidence: { summaryPath, runDir: path.dirname(summaryPath) } },
    summary: { status: "passed", stepCounts: { total: 2, passed: 2 }, artifacts: { summaryPath } },
    workspaceRoot: root,
  });
  assert.equal(bundle.verdict, "green");
  assert.equal(bundle.failureClass, null);
  assert.match(bundle.signature, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.match(bundle.testHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(bundle.summaryHash, /^sha256:[0-9a-f]{64}$/);
  // A green case should score well: it compares a concrete value.
  assert.ok(bundle.discriminativePower.score >= 50, `score was ${bundle.discriminativePower.score}`);

  const verified = verifyEvidenceBundle({ bundle, workspaceRoot: root });
  assert.equal(verified.valid, true, JSON.stringify(verified.reasons));
  assert.equal(verified.redCalibrated, false);
});

test("D-1: editing summary.json after issuance makes verify fail and names the field", (t) => {
  const root = makeWorkspace(t);
  const summaryPath = writeSummary(root, { status: "failed", firstFailure: { code: "expectation-not-met" } });
  const bundle = buildEvidenceBundle({
    caseId: "case-f1",
    caseItem: CASE_ITEM,
    result: { ok: false, evidence: { summaryPath } },
    summary: { status: "failed", artifacts: { summaryPath }, firstFailure: { code: "expectation-not-met" } },
    workspaceRoot: root,
  });
  assert.equal(verifyEvidenceBundle({ bundle, workspaceRoot: root }).valid, true);

  // Somebody "fixes" the result on disk.
  fs.writeFileSync(summaryPath, JSON.stringify({ status: "passed" }, null, 2));
  const verified = verifyEvidenceBundle({ bundle, workspaceRoot: root });
  assert.equal(verified.valid, false);
  assert.deepEqual(
    verified.reasons.map((item) => item.field),
    ["summaryHash"],
    "the reason must name summaryHash, not just report 'invalid'",
  );
  assert.match(verified.reasons[0].detail, /modified after the bundle was issued/);
});

test("D-1: editing a field of the bundle itself breaks the signature", (t) => {
  const root = makeWorkspace(t);
  const summaryPath = writeSummary(root, { status: "failed" });
  const bundle = buildEvidenceBundle({
    caseId: "case-f1",
    caseItem: CASE_ITEM,
    result: { ok: false, evidence: { summaryPath } },
    summary: { status: "failed", artifacts: { summaryPath } },
    workspaceRoot: root,
  });
  const forged = { ...bundle, verdict: "green", failureClass: null };
  const verified = verifyEvidenceBundle({ bundle: forged, workspaceRoot: root });
  assert.equal(verified.valid, false);
  assert.ok(verified.reasons.some((item) => item.field === "signature"));
});

test("a bundle copied from another workspace fails verification here", (t) => {
  const rootA = makeWorkspace(t);
  const rootB = makeWorkspace(t);
  const summaryPath = writeSummary(rootA, { status: "passed" });
  const bundle = buildEvidenceBundle({
    caseId: "case-f1",
    caseItem: CASE_ITEM,
    result: { ok: true, evidence: { summaryPath } },
    summary: { status: "passed", artifacts: { summaryPath } },
    workspaceRoot: rootA,
  });
  // rootB has its own generated key, so the same bytes do not verify there.
  resolveEvidenceKey({ workspaceRoot: rootB });
  const verified = verifyEvidenceBundle({ bundle, workspaceRoot: rootB });
  assert.equal(verified.valid, false);
  assert.ok(verified.reasons.some((item) => item.field === "signature"));
});

test("an unsigned bundle is reported as unattributable, not as valid", () => {
  const verified = verifyEvidenceBundle({
    bundle: { bundleVersion: 1, verdict: "green", caseId: "c", artifacts: {} },
  });
  assert.equal(verified.valid, false);
  assert.ok(verified.reasons.some((item) => /unsigned/.test(item.detail)));
});

// --- failureClass ------------------------------------------------------------

test("D-3: a failing value assertion classifies as value-assertion (= RED calibrated)", () => {
  const failureClass = classifyFailureClass({
    result: { ok: false, error: { code: "expectation-not-met" } },
    summary: {
      firstFailure: {
        code: "expectation-not-met",
        actionType: "assertDom",
        expectation: { type: "assertDom", ok: false, expected: "任务QA-x", actual: "文档" },
      },
    },
  });
  assert.equal(failureClass, "value-assertion");
});

test("D-2: an action step that could not be performed classifies as action, NOT value-assertion", () => {
  const failureClass = classifyFailureClass({
    result: { ok: false, error: { code: "click-failed" } },
    summary: { firstFailure: { code: "click-failed", actionType: "click", expectation: null } },
  });
  assert.equal(failureClass, "action");
  // Which is exactly what makes the consumer refuse it as RED calibration.
  const verified = verifyEvidenceBundle({
    bundle: {
      bundleVersion: 1,
      verdict: "red",
      failureClass: "action",
      caseId: "c",
      artifacts: {},
      signature: null,
    },
  });
  assert.equal(verified.redCalibrated, false);
});

test("failureClass precedence: env > timeout > page-error > reach > value-assertion", () => {
  const cases = [
    [{ result: { blocked: true }, summary: {} }, "env"],
    [{ result: { ok: false, error: { code: "stale-artifact" } }, summary: {} }, "env"],
    [{ result: { ok: false, error: { code: "browser-oom" } }, summary: {} }, "env"],
    [{ result: { ok: false, error: { code: "step-hard-timeout" } }, summary: {} }, "timeout"],
    [{ result: { ok: false, error: { code: "page-error" } }, summary: {} }, "page-error"],
    [{ result: { ok: false, error: { code: "target-not-found" } }, summary: {} }, "reach"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifyFailureClass(input), expected, JSON.stringify(input));
  }
});

test("a page error outranks the assertion that happened to be running", () => {
  // The gate rewrote a passing step into a page-error failure; the expectation on
  // that step still says ok. Classifying it as value-assertion would tell the lab
  // "the product produced a wrong value", which is not what happened.
  const failureClass = classifyFailureClass({
    result: { ok: false, error: { code: "page-error" } },
    summary: {
      firstFailure: { code: "page-error", actionType: "fill", expectation: { type: "text-exists", ok: true } },
    },
  });
  assert.equal(failureClass, "page-error");
});

test("D-4: the step title has no influence on the verdict or the class", (t) => {
  const root = makeWorkspace(t);
  const summaryPath = writeSummary(root, { status: "failed" });
  const build = (title) =>
    buildEvidenceBundle({
      caseId: "case-f1",
      caseItem: {
        id: "case-f1",
        steps: [
          {
            id: "s1",
            type: "assertDom",
            stepTitle: title,
            expectation: { kind: "assertDom", property: "text", operator: "equals", expected: "x" },
          },
        ],
      },
      result: { ok: false, error: { code: "expectation-not-met" }, evidence: { summaryPath } },
      summary: {
        status: "failed",
        artifacts: { summaryPath },
        firstFailure: {
          code: "expectation-not-met",
          actionType: "assertDom",
          expectation: { type: "assertDom", ok: false, expected: "x", actual: "y" },
        },
      },
      workspaceRoot: root,
    });
  // One title contains the magic word the old regex looked for; one does not.
  const withKeyword = build("assert 品类下拉含示例文档");
  const withoutKeyword = build("检查品类下拉是不是含示例文档");
  assert.equal(withKeyword.verdict, withoutKeyword.verdict);
  assert.equal(withKeyword.failureClass, withoutKeyword.failureClass);
  assert.equal(withoutKeyword.failureClass, "value-assertion");
  assert.equal(verifyEvidenceBundle({ bundle: withoutKeyword, workspaceRoot: root }).redCalibrated, true);
  // And the bundle carries no step title at all, so nothing downstream can regress
  // into reading one.
  assert.equal(JSON.stringify(withoutKeyword).includes("品类下拉"), false);
});

test("an unknown status resolves to blocked, never to green", () => {
  assert.equal(deriveVerdict({ result: {}, summary: {} }), "blocked");
  assert.equal(deriveVerdict({ result: { ok: true }, summary: {} }), "green");
  assert.equal(deriveVerdict({ result: { blocked: true, ok: false }, summary: {} }), "blocked");
});

test("verify rejects an internally inconsistent verdict/failureClass pairing", () => {
  const greenWithClass = verifyEvidenceBundle({
    bundle: { bundleVersion: 1, verdict: "green", failureClass: "action", caseId: "c", artifacts: {}, signature: null },
  });
  assert.ok(greenWithClass.reasons.some((item) => item.field === "failureClass"));
  const redWithoutClass = verifyEvidenceBundle({
    bundle: { bundleVersion: 1, verdict: "red", caseId: "c", artifacts: {}, signature: null },
  });
  assert.ok(redWithoutClass.reasons.some((item) => item.field === "failureClass"));
  const nonsense = verifyEvidenceBundle({
    bundle: { bundleVersion: 1, verdict: "yellow", caseId: "c", artifacts: {}, signature: null },
  });
  assert.ok(nonsense.reasons.some((item) => item.field === "verdict"));
});

test("canonicalization is key-order independent (so signatures are stable)", () => {
  assert.equal(canonicalize({ a: 1, b: [2, { d: 4, c: 3 }] }), canonicalize({ b: [2, { c: 3, d: 4 }], a: 1 }));
});

test("verify reports a readable error for a missing/corrupt bundle file", (t) => {
  const root = makeWorkspace(t);
  const missing = verifyEvidenceBundle({ bundlePath: path.join(root, "nope.json") });
  assert.equal(missing.valid, false);
  assert.equal(missing.reasons[0].field, "bundlePath");
});

test("the bundle can be written and re-read from disk unchanged", async (t) => {
  const root = makeWorkspace(t);
  const summaryPath = writeSummary(root, { status: "passed" });
  const bundle = buildEvidenceBundle({
    caseId: "case-f1",
    caseItem: CASE_ITEM,
    result: { ok: true, evidence: { summaryPath } },
    summary: { status: "passed", artifacts: { summaryPath } },
    workspaceRoot: root,
  });
  const bundlePath = await writeEvidenceBundle(path.join(path.dirname(summaryPath), "evidence-bundle.json"), bundle);
  const verified = verifyEvidenceBundle({ bundlePath, workspaceRoot: root });
  assert.equal(verified.valid, true, JSON.stringify(verified.reasons));
  assert.equal(verified.caseId, "case-f1");
});
