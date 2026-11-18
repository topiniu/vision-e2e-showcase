
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CARD_FIELDS,
  CASE_CARD_FIELDS,
  buildReportCard,
  collectWhatWasChecked,
  collectWhatWasDone,
  describeRedCalibration,
  suggestCapability,
} = require("../../runtime/server/report-card");
const { buildEvidenceBundle, writeEvidenceBundle } = require("../../runtime/reporting/evidence-bundle");

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-report-card-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const SUMMARY = {
  status: "passed",
  stepCounts: { total: 4, passed: 4, failed: 0 },
  durationMs: 8200,
  steps: [
    {
      displayIndex: 0,
      stepId: "s1",
      title: "以 demo-user 登录",
      actionType: "fill",
      status: "passed",
      afterScreenshotPath: "/runs/r1/steps/01-after.png",
    },
    {
      displayIndex: 1,
      stepId: "s2",
      title: "打开分类规则维护",
      actionType: "click",
      status: "passed",
      afterScreenshotPath: "/runs/r1/steps/02-after.png",
    },
    {
      displayIndex: 2,
      stepId: "s3",
      title: "复制『文档』新建品类『任务QA-x』",
      actionType: "click",
      status: "passed",
    },
    {
      displayIndex: 3,
      stepId: "s4",
      title: "assert 品类下拉含任务QA-x",
      actionType: "assertDom",
      status: "passed",
      expectation: { type: "assertDom", ok: true, expected: "含任务QA-x", actual: "含任务QA-x" },
      afterScreenshotPath: "/runs/r1/steps/04-after.png",
    },
    {
      displayIndex: 4,
      stepId: "s5",
      title: "这一步没跑",
      actionType: "click",
      status: "skipped",
    },
  ],
  artifacts: { runDir: "/runs/r1", summaryPath: "/runs/r1/summary.json", reportPath: "/runs/r1/report.json" },
};

test("whatWasDone lists only executed ACTION steps, in the author's own words", () => {
  const done = collectWhatWasDone(SUMMARY);
  assert.deepEqual(
    done.map((item) => item.step),
    ["以 demo-user 登录", "打开分类规则维护", "复制『文档』新建品类『任务QA-x』"],
  );
  // The assertion step is not "something that was done"...
  assert.equal(done.some((item) => item.step.startsWith("assert")), false);
  // ...and a step that never ran must not be claimed as done.
  assert.equal(done.some((item) => item.step === "这一步没跑"), false);
});

test("whatWasChecked carries kind + expected + actual for each assertion", () => {
  const checked = collectWhatWasChecked(SUMMARY);
  assert.equal(checked.length, 1);
  assert.deepEqual(checked[0], {
    kind: "value",
    subject: "assert 品类下拉含任务QA-x",
    expected: "含任务QA-x",
    actual: "含任务QA-x",
    ok: true,
  });
});

test("assertion kinds are named by what they prove, not by their internal type", () => {
  const kindOf = (type) => collectWhatWasChecked({ steps: [{ status: "passed", expectation: { type, ok: true } }] })[0].kind;
  assert.equal(kindOf("text-exists"), "presence");
  assert.equal(kindOf("text-absent"), "absence");
  assert.equal(kindOf("assertCount"), "count");
  assert.equal(kindOf("networkResponse"), "api");
  assert.equal(kindOf("assertFile"), "file");
  assert.equal(kindOf("assertNoPageError"), "no-page-error");
  assert.equal(kindOf("assertDom"), "value");
});

test("redCalibration is structural: only a value-assertion red counts", () => {
  assert.deepEqual(describeRedCalibration({ verdict: "green", failureClass: null }, null), {
    present: false,
    failureClass: null,
    reason: "verdict is green",
  });
  const good = describeRedCalibration({ verdict: "red", failureClass: "value-assertion" }, { qaTrace: { injection: "copy off" } });
  assert.equal(good.present, true);
  assert.equal(good.injection, "copy off");
  const bad = describeRedCalibration({ verdict: "red", failureClass: "action" }, null);
  assert.equal(bad.present, false);
  assert.match(bad.reason, /not that the product produced a wrong value/);
  const none = describeRedCalibration(null, null);
  assert.equal(none.present, false);
});

test("K-2: capability suggestions map a human-inherent reason to a roadmap item", () => {
  assert.equal(suggestCapability("导出 xlsx 发布说明需人工核对").capability, "Z-C");
  // A measurable property of the file -> the file-artifact capability, NOT the
  // visual-review one (which is reserved for judgements a human still makes).
  assert.equal(suggestCapability("导出 PNG 底部是否截断").capability, "Z-C");
  assert.equal(suggestCapability("导出排版观感需人工核对").capability, "Z-E");
  assert.equal(suggestCapability("需受限权限账号").capability, "Z-F");
  assert.equal(suggestCapability("多品类多档位无卡顿").capability, "Z-G");
  assert.equal(suggestCapability("四个入口顺序是否一致").capability, "Z-J");
  assert.equal(suggestCapability("完全无关的原因"), null);
});

test("the full card is built from real artifacts and every claim points at a file", async (t) => {
  const root = makeWorkspace(t);
  const runDir = path.join(root, "output", "runs", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  const summaryPath = path.join(runDir, "summary.json");
  const summary = {
    ...SUMMARY,
    artifacts: { runDir, summaryPath, reportPath: path.join(runDir, "report.json") },
    pageErrors: { policy: "fail", total: 1, failing: 1, suppressed: 0, entries: [{ kind: "console-error", message: "React warning", suppressed: false, stepId: "s3" }] },
    environmentFingerprint: { frontend: { buildId: "b-9" }, backends: [], unknowns: [{ what: "backend.svc.commit", reason: "probe 404" }], compositeId: "fe:b-9" },
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary));

  const result = { ok: true, telemetry: { durationMs: 8200 }, evidence: { runDir, summaryPath } };
  const bundle = buildEvidenceBundle({
    sessionId: "session-1",
    roundId: "round-1",
    caseId: "case-f1",
    caseName: "复制新建品类",
    caseItem: {
      id: "case-f1",
      qaTrace: { facets: ["DEMO-1239-F1"] },
      steps: [{ id: "s4", type: "assertDom", expectation: { kind: "assertDom", property: "text", operator: "equals", expected: "含任务QA-x" } }],
    },
    result,
    summary,
    workspaceRoot: root,
  });
  const bundlePath = await writeEvidenceBundle(path.join(runDir, "evidence-bundle.json"), bundle);

  const aggregatePath = path.join(runDir, "aggregate.json");
  const aggregate = { sessionId: "session-1", roundId: "round-1", caseResults: [{ caseId: "case-f1", caseName: "复制新建品类", result }] };
  fs.writeFileSync(aggregatePath, JSON.stringify(aggregate));

  const session = {
    id: "session-1",
    testFile: { id: "demo-5-19", name: "示例任务 v5.19", path: "demo-5-19.json" },
    rounds: [
      {
        id: "round-1",
        aggregatePath,
        evidenceBundles: [{ caseId: "case-f1", bundlePath, verdict: "green", failureClass: null, facets: ["DEMO-1239-F1"] }],
      },
    ],
  };
  const testFile = {
    id: "demo-5-19",
    name: "示例任务 v5.19",
    cases: [{ id: "case-f1", qaTrace: { facets: ["DEMO-1239-F1"] } }],
    requirement: { facets: [{ id: "DEMO-1303-F1", reason: "导出排版观感需人工核对" }] },
    settings: { qaTrace: { notCovered: [{ facet: "DEMO-1296-F7", reason: "需受限权限账号" }] } },
  };
  const precheck = {
    issues: [
      { code: "weak-oracle-closed-select", caseId: "case-f1", stepId: "s4", reason: "闭合下拉 text-absent" },
      { code: "target-weak-text-only", caseId: "case-f1", stepId: "s2", reason: "不相关的码，不该进 risks" },
    ],
  };

  const card = await buildReportCard({ session, testFile, precheck });

  assert.equal(card.cardVersion, 1);
  assert.equal(card.sessionId, "session-1");
  assert.deepEqual(card.verdictSummary, { green: 1, red: 0, blocked: 0, residue: 0 });

  // K-1: every assertion is traceable to evidence on disk.
  const [caseCard] = card.byCase;
  assert.deepEqual(caseCard.facets, ["DEMO-1239-F1"]);
  assert.equal(caseCard.whatWasChecked.length, 1);
  assert.equal(caseCard.evidence.summaryPath, summaryPath);
  assert.equal(caseCard.evidence.bundle, bundlePath);
  assert.ok(fs.existsSync(caseCard.evidence.bundle));
  assert.ok(caseCard.evidence.screenshots.length >= 3);

  // Risks: only the weak-oracle family, plus the page error and the unknown env field.
  const riskCodes = card.risks.map((item) => item.code).sort();
  assert.ok(riskCodes.includes("weak-oracle-closed-select"));
  assert.ok(riskCodes.includes("page-error"));
  assert.ok(riskCodes.includes("fingerprint-unknown"));
  assert.equal(riskCodes.includes("target-weak-text-only"), false, "unrelated precheck codes must not flood the risk list");

  // K-2: uncovered items carry a reason AND a capability pointer.
  const uncovered = card.notCovered;
  assert.ok(uncovered.length >= 2);
  for (const item of uncovered) {
    assert.ok(item.reason, JSON.stringify(item));
    assert.ok(item.suggestedCapability, `no capability pointer for ${JSON.stringify(item)}`);
  }
  assert.equal(uncovered.find((item) => item.facet === "DEMO-1296-F7").suggestedCapability, "Z-F");
  assert.equal(uncovered.find((item) => item.facet === "DEMO-1303-F1").suggestedCapability, "Z-E");
  assert.equal(uncovered.find((item) => item.facet === "DEMO-1303-F1").suggestedCapabilityLabel, "视觉验收（基线 + 同族对比）");

  // byFacet gives the consumer a facet-keyed view without re-deriving the mapping.
  assert.equal(card.byFacet[0].facet, "DEMO-1239-F1");
  assert.equal(card.byFacet[0].verdict, "green");

  // K-3: strictly whitelisted fields — no place to smuggle a narrative.
  assert.deepEqual(
    Object.keys(card).filter((key) => !CARD_FIELDS.includes(key)),
    [],
  );
  assert.deepEqual(
    Object.keys(caseCard).filter((key) => !CASE_CARD_FIELDS.includes(key)),
    [],
  );
  for (const forbidden of ["summary", "notes", "narrative", "comment", "conclusion", "analysis"]) {
    assert.equal(CARD_FIELDS.includes(forbidden), false, `${forbidden} must never become a card field`);
    assert.equal(CASE_CARD_FIELDS.includes(forbidden), false, `${forbidden} must never become a case-card field`);
  }
});

test("a blocked case becomes a notCovered entry (it proved nothing)", async (t) => {
  const root = makeWorkspace(t);
  const runDir = path.join(root, "output", "runs", "run-2");
  fs.mkdirSync(runDir, { recursive: true });
  const aggregatePath = path.join(runDir, "aggregate.json");
  fs.writeFileSync(
    aggregatePath,
    JSON.stringify({
      caseResults: [
        {
          caseId: "case-b",
          caseName: "陈旧产物",
          result: { ok: false, blocked: true, blockedReason: "stale-artifact", evidence: {} },
        },
      ],
    }),
  );
  const card = await buildReportCard({
    session: { id: "session-2", rounds: [{ id: "round-1", aggregatePath, evidenceBundles: [] }] },
    testFile: { id: "f", cases: [{ id: "case-b" }] },
  });
  assert.deepEqual(card.verdictSummary, { green: 0, red: 0, blocked: 1, residue: 0 });
  assert.equal(card.notCovered.length, 1);
  assert.equal(card.notCovered[0].reason, "stale-artifact");
  assert.equal(card.notCovered[0].suggestedCapability, null, "stale-artifact is not a missing capability, it is a broken environment");
});

test("building a card for a session with no rounds does not throw", async () => {
  const card = await buildReportCard({ session: { id: "s", rounds: [] } });
  assert.equal(card.sessionId, "s");
  assert.deepEqual(card.byCase, []);
  assert.deepEqual(card.verdictSummary, { green: 0, red: 0, blocked: 0, residue: 0 });
});
