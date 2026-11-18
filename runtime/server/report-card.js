"use strict";


const fs = require("node:fs/promises");
const path = require("node:path");

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
  "callApi",
]);

// Capability pointers for the "this still needs a human" ledger. Every uncovered
// item must name the capability that would remove the manual work, so the debt is
// booked against the roadmap instead of quietly accruing forever.
// Order matters: the more specific reason wins. In particular "导出**排版观感**"
// is an aesthetics question (Z-E, where a human still makes the final call),
// whereas "导出 PNG 是否**截断**" is a measurable property of the file itself and
// therefore belongs to Z-C — that is exactly the distinction the roadmap draws
// when it books DEMO-1296-F4 as a Z-C收益 rather than a visual-review item.
const CAPABILITY_BY_REASON = [
  { pattern: /观感|美观|排版|样式|视觉|好看|难看/i, capability: "Z-E", label: "视觉验收（基线 + 同族对比）" },
  { pattern: /导出|下载|xlsx|excel|csv|pdf|文件|截断|像素/i, capability: "Z-C", label: "产物断言（下载文件/导出物）" },
  { pattern: /权限|受限|账号|角色/i, capability: "Z-F", label: "权限矩阵（login-as）" },
  { pattern: /卡顿|性能|响应速度|慢/i, capability: "Z-G", label: "性能指标断言" },
  { pattern: /一致|多入口|入口|顺序/i, capability: "Z-J", label: "跨入口一致性原语" },
  { pattern: /报错|异常|崩/i, capability: "Z-A", label: "全局页面报错门" },
  { pattern: /陈旧|缓存|指纹|构建/i, capability: "Z-B", label: "环境指纹与新鲜度门" },
];

function suggestCapability(reason) {
  const text = String(reason || "");
  const hit = CAPABILITY_BY_REASON.find((item) => item.pattern.test(text));
  return hit ? { capability: hit.capability, label: hit.label } : null;
}

function stepTitleOf(step = {}) {
  return (
    step.title ||
    step.stepTitle ||
    step.stepId ||
    step.id ||
    `${step.actionType || "step"} #${(step.displayIndex ?? 0) + 1}`
  );
}

// The action steps that actually ran, in order. Skipped/stopped steps are
// excluded on purpose: "以 demo-user 登录" must not appear in "what was done" when
// the login step never executed.
function collectWhatWasDone(summary = {}) {
  return (summary.steps || [])
    .filter((step) => ACTION_KINDS.has(String(step.actionType || "")))
    .filter((step) => step.status === "passed" || step.status === "failed")
    .map((step) => ({
      step: stepTitleOf(step),
      actionType: step.actionType || null,
      status: step.status,
    }));
}

function describeAssertionKind(expectation = {}) {
  const kind = String(expectation.type || "").trim();
  if (!kind) {
    return "value";
  }
  if (["text-exists", "expectTextExist", "assertVisible"].includes(kind)) {
    return "presence";
  }
  if (["text-absent", "expectNoText"].includes(kind)) {
    return "absence";
  }
  if (["count", "assertCount", "expectCount"].includes(kind)) {
    return "count";
  }
  if (["networkResponse", "expectNetworkResponse", "assertResponse", "response", "expectResponse"].includes(kind)) {
    return "api";
  }
  if (["assertFile", "expectFile"].includes(kind)) {
    return "file";
  }
  if (["assertNoPageError", "expectNoPageError"].includes(kind)) {
    return "no-page-error";
  }
  if (["url-matches", "assertUrl", "expectUrl"].includes(kind)) {
    return "url";
  }
  return "value";
}

function collectWhatWasChecked(summary = {}) {
  const checked = [];
  for (const step of summary.steps || []) {
    const expectation = step.expectation;
    if (!expectation || step.status === "skipped" || step.status === "stopped") {
      continue;
    }
    checked.push({
      kind: describeAssertionKind(expectation),
      subject: stepTitleOf(step),
      expected: expectation.expected ?? expectation.urlIncludes ?? expectation.status ?? null,
      actual: expectation.actual ?? null,
      ok: expectation.ok ?? (step.status === "passed" ? true : step.status === "failed" ? false : null),
    });
  }
  return checked;
}

function collectEvidence(summary = {}) {
  const screenshots = [];
  for (const step of summary.steps || []) {
    if (step.afterScreenshotPath) {
      screenshots.push(step.afterScreenshotPath);
    } else if (step.beforeScreenshotPath) {
      screenshots.push(step.beforeScreenshotPath);
    }
  }
  return {
    screenshots: screenshots.slice(0, 20),
    runDir: summary.artifacts?.runDir || null,
    summaryPath: summary.artifacts?.summaryPath || null,
    reportPath: summary.artifacts?.reportPath || null,
    trace: summary.firstFailure?.tracePath || null,
  };
}

// RED calibration, answered structurally (Z-D). The consumer previously inferred
// this from step titles; here it is `verdict === "red" && failureClass ===
// "value-assertion"`, which no wording can fake and no wording can break.
function describeRedCalibration(bundle, caseItem) {
  if (!bundle) {
    return { present: false, failureClass: null, reason: "no evidence bundle for this case" };
  }
  if (bundle.verdict !== "red") {
    return { present: false, failureClass: bundle.failureClass || null, reason: `verdict is ${bundle.verdict}` };
  }
  const calibrated = bundle.failureClass === "value-assertion";
  return {
    present: calibrated,
    failureClass: bundle.failureClass || null,
    // Where the injection came from, when the author declared it.
    injection: caseItem?.qaTrace?.injection || caseItem?.redInjection || null,
    ...(calibrated
      ? {}
      : {
          reason:
            `the case is red but its failureClass is "${bundle.failureClass}" — that proves the flow could not be ` +
            "completed, not that the product produced a wrong value, so it does not count as RED calibration",
        }),
  };
}

function collectRisks({ summary, bundle, precheck, caseId }) {
  const risks = [];
  for (const issue of precheck?.issues || []) {
    if (issue.caseId && caseId && issue.caseId !== caseId) {
      continue;
    }
    if (!/^(weak-oracle|capture-concatenated|absent-without|assertion-without|testid-not-forwarded|virtualized-list)/.test(issue.code || "")) {
      continue;
    }
    risks.push({ kind: "weak-oracle", code: issue.code, stepId: issue.stepId || null, detail: issue.reason || issue.message || null });
  }
  const pageErrors = summary?.pageErrors;
  for (const entry of pageErrors?.entries || []) {
    if (entry.suppressed) {
      continue;
    }
    risks.push({ kind: "page-error", code: "page-error", stepId: entry.stepId || null, detail: entry.message });
  }
  const score = bundle?.discriminativePower?.score;
  if (Number.isFinite(score) && score < 50) {
    risks.push({
      kind: "low-discriminative-power",
      code: "discriminative-power",
      stepId: null,
      detail: `discriminativePower=${score}: this verdict is weakly falsifiable (signals: ${(bundle.discriminativePower.signals || []).join(", ") || "none"})`,
    });
  }
  const drift = summary?.dataResidue?.baselineDrift;
  if (drift?.drifted) {
    risks.push({
      kind: "baseline-drift",
      code: "baseline-drift",
      stepId: null,
      detail: drift.detail || "本轮改动了声明为「绝不该被改动」的预置数据。",
    });
  }
  if (drift && drift.checked === false) {
    risks.push({ kind: "baseline-drift", code: "baseline-unverified", stepId: null, detail: drift.reason });
  }
  for (const unknown of summary?.environmentFingerprint?.unknowns || []) {
    risks.push({
      kind: "environment-unknown",
      code: "fingerprint-unknown",
      stepId: null,
      detail: `${unknown.what}: ${unknown.reason}`,
    });
  }
  return risks;
}

function collectNotCovered({ testFile, caseCards }) {
  const notCovered = [];
  const coveredFacets = new Set(caseCards.flatMap((card) => card.facets || []));
  // 1. Facets the file declares but no case produced a verdict for.
  const declared = Array.isArray(testFile?.requirement?.facets) ? testFile.requirement.facets : [];
  for (const facet of declared) {
    const name = String(facet?.id || facet || "").trim();
    if (!name || coveredFacets.has(name)) {
      continue;
    }
    const reason = String(facet?.reason || facet?.notCoveredReason || "declared in the requirement but no case covers it");
    const suggestion = suggestCapability(reason);
    notCovered.push({
      facet: name,
      reason,
      suggestedCapability: suggestion?.capability || null,
      suggestedCapabilityLabel: suggestion?.label || null,
    });
  }
  // 2. Explicit author declarations ("this one needs human eyes, because ...").
  const declaredGaps = Array.isArray(testFile?.settings?.qaTrace?.notCovered)
    ? testFile.settings.qaTrace.notCovered
    : [];
  for (const gap of declaredGaps) {
    const reason = String(gap?.reason || "human-inherent");
    const suggestion = suggestCapability(reason);
    notCovered.push({
      facet: String(gap?.facet || "").trim() || null,
      reason,
      suggestedCapability: gap?.suggestedCapability || suggestion?.capability || null,
      suggestedCapabilityLabel: suggestion?.label || null,
    });
  }
  // 3. Blocked cases: the run happened but proved nothing.
  for (const card of caseCards) {
    if (card.verdict !== "blocked") {
      continue;
    }
    const reason = card.blockedReason || "the case was blocked before it could prove anything";
    const suggestion = suggestCapability(reason);
    notCovered.push({
      facet: (card.facets || [])[0] || card.caseId,
      reason,
      suggestedCapability: suggestion?.capability || null,
      suggestedCapabilityLabel: suggestion?.label || null,
    });
  }
  return notCovered;
}

// ---------------------------------------------------------------------------
// field whitelist (facet K-3)
// ---------------------------------------------------------------------------

const CASE_CARD_FIELDS = [
  "caseId",
  "caseName",
  "facets",
  "verdict",
  "failureClass",
  "discriminativePower",
  "whatWasDone",
  "whatWasChecked",
  "evidence",
  "redCalibration",
  "risks",
  "blockedReason",
  "durationMs",
  "stepCounts",
];
const CARD_FIELDS = [
  "cardVersion",
  "sessionId",
  "roundId",
  "generatedAt",
  "testFile",
  "verdictSummary",
  "byFacet",
  "byCase",
  "risks",
  "notCovered",
  "environment",
  "dataResidue",
  "authMatrix",
  "visualReview",
  "artifacts",
];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      out[field] = source[field];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

async function readJson(filePath) {
  if (!filePath) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

async function buildReportCard({ session = null, round = null, aggregate = null, testFile = null, precheck = null } = {}) {
  const latestRound = round || (session?.rounds || []).at(-1) || null;
  const roundAggregate = aggregate || (await readJson(latestRound?.aggregatePath));
  const bundleByCaseId = new Map((latestRound?.evidenceBundles || []).map((item) => [item.caseId, item]));

  const caseCards = [];
  for (const entry of roundAggregate?.caseResults || []) {
    const result = entry?.result || {};
    const summary = (await readJson(result.evidence?.summaryPath)) || {};
    const bundleRef = bundleByCaseId.get(entry.caseId) || null;
    const bundle = (await readJson(bundleRef?.bundlePath)) || bundleRef;
    const caseItem = (testFile?.cases || []).find((item) => item.id === entry.caseId) || null;
    const verdict = bundle?.verdict || (result.blocked ? "blocked" : result.ok ? "green" : "red");
    caseCards.push(
      pick(
        {
          caseId: entry.caseId,
          caseName: entry.caseName,
          facets: bundle?.facets || [],
          verdict,
          failureClass: bundle?.failureClass ?? null,
          discriminativePower: bundle?.discriminativePower ?? null,
          whatWasDone: collectWhatWasDone(summary),
          whatWasChecked: collectWhatWasChecked(summary),
          evidence: { ...collectEvidence(summary), bundle: bundleRef?.bundlePath || null },
          redCalibration: describeRedCalibration(bundle, caseItem),
          risks: collectRisks({ summary, bundle, precheck, caseId: entry.caseId }),
          blockedReason: result.blockedReason || null,
          durationMs: result.telemetry?.durationMs ?? summary.durationMs ?? null,
          stepCounts: summary.stepCounts || null,
        },
        CASE_CARD_FIELDS,
      ),
    );
  }

  // v1.6 Z-I: residue is per-run telemetry, not an aggregate field — collect it
  // across the round's runs so the batch verdict can carry `residue: n`.
  const residueEntries = [];
  for (const entry of roundAggregate?.caseResults || []) {
    for (const item of entry?.result?.telemetry?.dataResidue?.residue || []) {
      residueEntries.push({ ...item, caseId: entry.caseId });
    }
  }
  const verdictSummary = {
    green: caseCards.filter((card) => card.verdict === "green").length,
    red: caseCards.filter((card) => card.verdict === "red").length,
    blocked: caseCards.filter((card) => card.verdict === "blocked").length,
    residue: residueEntries.length,
  };

  // One entry per declared facet, so the consumer can aggregate coverage without
  // re-deriving the facet ↔ case mapping.
  const byFacet = [];
  for (const card of caseCards) {
    for (const facet of card.facets.length ? card.facets : [null]) {
      byFacet.push({
        facet,
        caseId: card.caseId,
        verdict: card.verdict,
        failureClass: card.failureClass,
        discriminativePower: card.discriminativePower?.score ?? null,
        whatWasDone: card.whatWasDone,
        whatWasChecked: card.whatWasChecked,
        evidence: card.evidence,
        redCalibration: card.redCalibration,
      });
    }
  }

  const environment =
    (roundAggregate?.caseResults || [])
      .map((entry) => entry?.result?.telemetry?.environmentFingerprint)
      .find(Boolean) ||
    roundAggregate?.rootSetupResult?.telemetry?.environmentFingerprint ||
    null;

  return pick(
    {
      cardVersion: 1,
      sessionId: session?.id || roundAggregate?.sessionId || null,
      roundId: latestRound?.id || roundAggregate?.roundId || null,
      generatedAt: Date.now(),
      testFile: {
        id: session?.testFile?.id || testFile?.id || null,
        name: session?.testFile?.name || testFile?.name || null,
        path: session?.testFile?.path || null,
      },
      verdictSummary,
      byFacet,
      byCase: caseCards,
      risks: caseCards.flatMap((card) => card.risks.map((risk) => ({ ...risk, caseId: card.caseId }))),
      notCovered: collectNotCovered({ testFile, caseCards }),
      environment,
      dataResidue: residueEntries,
      // v1.6 Z-F: the "who sees what" table when the file declared an authMatrix.
      // Present only then, so its absence is not mistaken for "identities agree".
      authMatrix: roundAggregate?.authMatrix || null,
      // v1.6 Z-E: pointer to the appearance-review material. The card itself
      // stays free of aesthetic claims — it only says where the material is.
      visualReview: (roundAggregate?.caseResults || [])
        .map((entry) => entry?.result?.telemetry?.visualReview)
        .filter(Boolean),
      artifacts: {
        aggregatePath: latestRound?.aggregatePath || null,
        diagnosisPath: latestRound?.diagnosisPath || null,
        reportPath: latestRound?.reportPath || null,
        repairContextPath: latestRound?.repairContextPath || null,
      },
    },
    CARD_FIELDS,
  );
}

module.exports = {
  CARD_FIELDS,
  CASE_CARD_FIELDS,
  buildReportCard,
  collectWhatWasChecked,
  collectWhatWasDone,
  describeRedCalibration,
  suggestCapability,
};
