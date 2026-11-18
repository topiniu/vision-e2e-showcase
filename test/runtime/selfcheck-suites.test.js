
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { startSelfcheckApp } = require("../fixtures/selfcheck-app");
const { createTestSession } = require("../../runtime/server/test-session-runner");
const { TestSessionStore } = require("../../runtime/server/session-store");
const { launchSharedBrowser } = require("../../runtime/executor/run-session");
const { precheckTestFile } = require("../../src/shared/test-file-precheck");
const { verifyEvidenceBundle } = require("../../runtime/reporting/evidence-bundle");
const { buildReportCard } = require("../../runtime/server/report-card");

const SELFCHECK_DIR = path.resolve(__dirname, "..", "fixtures", "selfcheck");

function loadSuite(name, replacements = {}) {
  const raw = fs.readFileSync(path.join(SELFCHECK_DIR, `${name}.json`), "utf8");
  let text = raw;
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  return JSON.parse(text);
}

const AUTH_PROFILE = "selfcheck";

async function makeWorkspace(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "zhuzhu-selfcheck-"));
  await fsp.mkdir(path.join(root, "test-workflows"), { recursive: true });
  const outputRoot = path.join(root, "output");
  // A session always requires a resolvable auth profile. The fixture app needs no
  // login, so an empty-but-valid storageState is the honest stand-in: it proves
  // the profile plumbing works without pretending a credential exists.
  const profileDir = path.join(outputRoot, "auth-profiles", AUTH_PROFILE);
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.writeFile(path.join(profileDir, "storageState.json"), JSON.stringify({ cookies: [], origins: [] }));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return {
    root,
    outputRoot,
    store: new TestSessionStore({ outputRoot }),
    outputRunsRoot: path.join(outputRoot, "runs"),
    testWorkflowsRoot: path.join(root, "test-workflows"),
  };
}

async function runSuite(workspace, testFile, extraRequest = {}) {
  const outcome = await createTestSession(
    { testFile, authProfile: AUTH_PROFILE, wait: true, waitTimeoutMs: 0, ...extraRequest },
    {
      store: workspace.store,
      outputRoot: workspace.outputRoot,
      outputRunsRoot: workspace.outputRunsRoot,
      testWorkflowsRoot: workspace.testWorkflowsRoot,
      launchBrowser: launchSharedBrowser,
    },
  );
  const session = await workspace.store.readSession(outcome.response.sessionId);
  const round = (session.rounds || []).at(-1) || null;
  const aggregate = round?.aggregatePath ? JSON.parse(await fsp.readFile(round.aggregatePath, "utf8")) : null;
  const diagnosis = round?.diagnosisPath ? JSON.parse(await fsp.readFile(round.diagnosisPath, "utf8")) : null;
  return { response: outcome.response, session, round, aggregate, diagnosis };
}

// ---------------------------------------------------------------------------
// sc-page-error — DEMO-1239 新建品类输入即崩
// ---------------------------------------------------------------------------

test("sc-page-error: on the BROKEN build the case goes red with failureClass=page-error", async (t) => {
  const app = await startSelfcheckApp({ crash: true });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-page-error", { __SELFCHECK_BASE__: app.baseUrl });

  // First, REPRODUCE THE ESCAPE. With the gate off (the pre-v1.5 world) this
  // exact suite on this exact broken build goes GREEN: every assertion the
  // author wrote passes on its own terms, because the defect has no visible
  // symptom. This is the 17/17-facets-green moment, reproduced on demand — and
  // it is what makes the red below meaningful rather than decorative.
  const escaped = await runSuite(workspace, {
    ...suite,
    settings: { ...suite.settings, pageErrorPolicy: "off" },
  });
  assert.equal(escaped.response.status, "passed", "the escape must still reproduce with the gate off");
  const escapedSummary = JSON.parse(
    await fsp.readFile(escaped.aggregate.caseResults[0].result.evidence.summaryPath, "utf8"),
  );
  const escapedAssertions = escapedSummary.steps.filter((step) => step.expectation);
  assert.ok(escapedAssertions.length >= 2, "the suite must contain real assertions");
  for (const step of escapedAssertions) {
    assert.notEqual(step.expectation.ok, false, `assertion "${step.title}" passes on its own terms`);
  }
  // ...and even with the gate off the exception was still RECORDED (A-2): the
  // evidence exists, nobody was reading it.
  assert.ok(escapedSummary.pageErrors.total >= 1);

  // Now with the gate at its default: the same suite, same build, red.
  const { response, round, aggregate, diagnosis } = await runSuite(workspace, suite);

  assert.equal(response.status, "failed", JSON.stringify(response.firstFailure || response));
  const caseResult = aggregate.caseResults[0].result;
  const summary = JSON.parse(await fsp.readFile(caseResult.evidence.summaryPath, "utf8"));
  // Red at the step that was running when the page threw, with the app's own
  // exception quoted.
  assert.equal(diagnosis.failureType, "page-error");
  assert.equal(summary.firstFailure.code, "page-error");
  assert.equal(summary.firstFailure.stepId, "type-name");
  assert.match(summary.firstFailure.message, /Cannot read propert|of null|undefined/i);
  // And the structural verdict the consumer reads.
  const bundle = round.evidenceBundles[0];
  assert.equal(bundle.verdict, "red");
  assert.equal(bundle.failureClass, "page-error");
  const verified = verifyEvidenceBundle({ bundlePath: bundle.bundlePath, workspaceRoot: workspace.root });
  assert.equal(verified.valid, true, JSON.stringify(verified.reasons));
  assert.equal(
    verified.redCalibrated,
    false,
    "a page-error red is a real defect but NOT a value-assertion RED calibration — the classes must not be conflated",
  );
  // The repair context must hand the front-end owner the raw exception.
  const repair = JSON.parse(await fsp.readFile(round.repairContextPath, "utf8"));
  assert.ok(repair.pageErrors.length >= 1);
  assert.match(repair.pageErrors[0].message, /Cannot read propert|of null|undefined/i);
});

test("sc-page-error: on the FIXED build the very same suite goes green", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-page-error", { __SELFCHECK_BASE__: app.baseUrl });

  const { response, round, aggregate } = await runSuite(workspace, suite);

  assert.equal(response.status, "passed", JSON.stringify(response.firstFailure || response));
  const caseResult = aggregate.caseResults[0].result;
  const summary = JSON.parse(await fsp.readFile(caseResult.evidence.summaryPath, "utf8"));
  // The gate ran and saw a clean page — distinguishable from "never collected".
  assert.equal(summary.pageErrors.policy, "fail");
  assert.equal(summary.pageErrors.failing, 0);
  assert.equal(round.evidenceBundles[0].verdict, "green");
  assert.equal(round.evidenceBundles[0].failureClass, null);
});

// ---------------------------------------------------------------------------
// sc-stale-artifact — the umi watcher death
// ---------------------------------------------------------------------------

test("sc-stale-artifact: an unchanged artifact blocks the session (not green, not red)", async (t) => {
  const app = await startSelfcheckApp({ crash: false, buildId: "selfcheck-build-STALE" });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);

  // Round 1: baseline, no freshness rule -> record the fingerprint.
  const baseline = loadSuite("sc-stale-artifact", {
    __SELFCHECK_BASE__: app.baseUrl,
    '"freshness": {\n      "requireChangedSince": "__SELFCHECK_PREVIOUS_FINGERPRINT__"\n    }': '"freshnessDisabled": true',
  });
  delete baseline.settings.freshness;
  const first = await runSuite(workspace, baseline);
  assert.equal(first.response.status, "passed");
  const fingerprint = first.aggregate.caseResults[0].result.telemetry.environmentFingerprint;
  assert.equal(fingerprint.frontend.buildId, "selfcheck-build-STALE");

  // Round 2: the caller declares the code changed. The page is serving the same
  // bundle, so the run cannot prove anything about the new code.
  const guarded = loadSuite("sc-stale-artifact", {
    __SELFCHECK_BASE__: app.baseUrl,
    __SELFCHECK_PREVIOUS_FINGERPRINT__: fingerprint.compositeId,
  });
  const second = await runSuite(workspace, guarded);

  assert.equal(second.response.status, "blocked", JSON.stringify(second.response));
  assert.equal(second.diagnosis.failureType, "stale-artifact");
  assert.equal(second.aggregate.blockedReason, "stale-artifact");
  // Nothing was executed — an important part of the value: no minutes were spent
  // producing a verdict that could not mean anything.
  const blockedRun = second.aggregate.caseResults[0]?.result || second.aggregate.rootSetupResult;
  assert.equal(blockedRun.blocked, true);
  assert.deepEqual(blockedRun.data.results, []);
  assert.match(blockedRun.error.message, /did not reach the browser/);
  // The bundle says blocked, and blocked is neither ok nor a test failure.
  const bundle = second.round.evidenceBundles?.[0];
  if (bundle) {
    assert.equal(bundle.verdict, "blocked");
    assert.equal(bundle.failureClass, "env");
  }
});

test("sc-stale-artifact: a genuinely new build passes the same gate", async (t) => {
  const app = await startSelfcheckApp({ crash: false, buildId: "selfcheck-build-NEW" });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-stale-artifact", {
    __SELFCHECK_BASE__: app.baseUrl,
    // A fingerprint from a *different* build.
    __SELFCHECK_PREVIOUS_FINGERPRINT__: "fe:selfcheck-build-OLD",
  });
  const { response } = await runSuite(workspace, suite);
  assert.equal(response.status, "passed", JSON.stringify(response.firstFailure || response));
});

// ---------------------------------------------------------------------------
// sc-file-artifact — DEMO-1310-F3 / DEMO-1296-F4
// ---------------------------------------------------------------------------

test("sc-file-artifact: xlsx cell text and PNG completeness are machine-verdictable", async (t) => {
  const app = await startSelfcheckApp({ crash: false, staleExport: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-file-artifact", { __SELFCHECK_BASE__: app.baseUrl.replace(/\/$/, "") });

  const { response, aggregate, round } = await runSuite(workspace, suite);
  assert.equal(response.status, "passed", JSON.stringify(response.firstFailure || response));

  // Both downloads are captured as evidence with size + digest.
  for (const entry of aggregate.caseResults) {
    const summary = JSON.parse(await fsp.readFile(entry.result.evidence.summaryPath, "utf8"));
    assert.equal(summary.downloads.count, 1, `case ${entry.caseId}`);
    const [file] = summary.downloads.files;
    assert.ok(file.size > 0);
    assert.match(file.sha256, /^sha256:/);
    assert.ok(fs.existsSync(file.path));
  }
  // Both cases are green with real value signals in the bundle.
  for (const bundle of round.evidenceBundles) {
    assert.equal(bundle.verdict, "green", bundle.caseId);
    assert.ok(bundle.discriminativePower >= 50, `${bundle.caseId} scored ${bundle.discriminativePower}`);
  }
});

test("sc-file-artifact: a stale xlsx export goes red AND reports the actual cell value", async (t) => {
  const app = await startSelfcheckApp({ crash: false, staleExport: true });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-file-artifact", { __SELFCHECK_BASE__: app.baseUrl.replace(/\/$/, "") });
  // Only the xlsx case; the PNG case is unaffected by staleExport.
  suite.cases = suite.cases.filter((item) => item.id === "sc-file-xlsx-cell");

  const { response, aggregate, round, diagnosis } = await runSuite(workspace, suite);
  assert.equal(response.status, "failed");
  assert.equal(round.evidenceBundles[0].failureClass, "value-assertion");
  assert.equal(
    verifyEvidenceBundle({ bundlePath: round.evidenceBundles[0].bundlePath, workspaceRoot: workspace.root }).redCalibrated,
    true,
    "a wrong exported value IS a value-assertion red — this is what RED calibration means",
  );
  // The actual extracted value must travel with the failure (facet C-4), or the
  // human still has to open the file and nothing was actually automated.
  const report = JSON.parse(await fsp.readFile(aggregate.caseResults[0].result.evidence.reportPath, "utf8"));
  const step = report.summary.data.results.at(-1);
  assert.match(step.data.expectation.details.cell.value, /旧文案/);
  assert.ok(step.data.expectation.file.path);
  assert.equal(diagnosis.failureType, "assertion-false");
});

test("sc-file-artifact: a truncated PNG export goes red naming the metric it tripped", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-file-artifact", { __SELFCHECK_BASE__: app.baseUrl.replace(/\/$/, "") });
  suite.cases = suite.cases.filter((item) => item.id === "sc-file-png-complete");
  // Point at the deliberately cut-off export.
  suite.cases[0].steps[0].target.testId = "demo-board-export-cut-btn";

  const { response, aggregate } = await runSuite(workspace, suite);
  assert.equal(response.status, "failed");
  const report = JSON.parse(await fsp.readFile(aggregate.caseResults[0].result.evidence.reportPath, "utf8"));
  const step = report.summary.data.results.at(-1);
  assert.match(step.data.expectation.error, /bottomEdgeInkRatio|bottomMarginPx|rightEdgeInkRatio/);
  assert.equal(step.data.expectation.details.bottomMarginPx, 0, "content runs into the last pixel row");
});

// ---------------------------------------------------------------------------
// sc-weak-oracle — precheck only, no browser needed
// ---------------------------------------------------------------------------

test("sc-weak-oracle: the precheck names every weak oracle and suggests the correct writing", () => {
  const suite = loadSuite("sc-weak-oracle", { __SELFCHECK_BASE__: "http://127.0.0.1:1/" });
  const result = precheckTestFile({ testFile: suite });
  const codes = new Set(result.issues.map((item) => item.code));

  // The two REAL v5.19 weak oracles.
  assert.ok(codes.has("weak-oracle-closed-select"), "closed-dropdown text-absent");
  assert.ok(codes.has("capture-concatenated-text"), "property:text on a concatenating container");
  // Plus the rest of the family this suite pins.
  assert.ok(codes.has("absent-without-presence-baseline"));
  assert.ok(codes.has("assertion-without-value"));
  assert.ok(codes.has("testid-not-forwarded"));
  assert.ok(codes.has("virtualized-list-select"));

  // Advisory, never blocking: a heuristic that blocks gets switched off, and then
  // the weak oracles go back to being invisible.
  for (const issue of result.issues.filter((item) => codes.has(item.code) && item.code.startsWith("weak-oracle"))) {
    assert.equal(issue.severity, "warning");
  }
  // Each one has to be actionable: a code with no suggested writing is a
  // complaint, not a rule.
  const concatenated = result.issues.find((item) => item.code === "capture-concatenated-text");
  assert.equal(concatenated.suggestedPatch.value, "attribute");
  const wrapper = result.issues.find((item) => item.code === "testid-not-forwarded");
  assert.match(wrapper.suggestedPatch.value, /\[data-testid=.*\] input/);
});

test("sc-weak-oracle: the discriminative power of this case is visibly low", () => {
  const suite = loadSuite("sc-weak-oracle", { __SELFCHECK_BASE__: "http://127.0.0.1:1/" });
  const result = precheckTestFile({ testFile: suite });
  const { scoreDiscriminativePower } = require("../../src/shared/assertion-discrimination");
  const score = scoreDiscriminativePower({ caseItem: suite.cases[0], issues: result.issues });
  assert.ok(score.score <= 45, `a case built entirely from weak oracles must score low, got ${score.score}`);
  assert.ok(score.weak.length >= 4);
});

// ---------------------------------------------------------------------------
// sc-cross-entry — DEMO-1243 字段顺序四入口三套序 (Z-J)
// ---------------------------------------------------------------------------

test("sc-cross-entry: four entries with three orderings go red with a matrix naming the conflict", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-cross-entry", { __SELFCHECK_BASE__: app.baseUrl });

  const { response, aggregate, round } = await runSuite(workspace, suite);

  assert.equal(response.status, "failed", JSON.stringify(response.firstFailure || response));
  const report = JSON.parse(await fsp.readFile(aggregate.caseResults[0].result.evidence.reportPath, "utf8"));
  const check = report.summary.data.results.at(-1).data.expectation;
  assert.equal(check.type, "assertConsistency");
  assert.equal(check.subject, "字段顺序");

  // Every entry point must appear in the matrix with what IT reported — the
  // useful half of this finding is *which* entries disagree.
  assert.deepEqual(
    check.matrix.map((item) => item.entry),
    ["规则维护弹窗", "编辑字段表", "查看字段表popover", "导出文件"],
  );
  for (const row of check.matrix) {
    assert.equal(row.reached, true, `${row.entry} produced no value`);
  }
  // The fixture serves three distinct orders across the four entries.
  assert.equal(check.distinctValues, 3);
  assert.ok(check.conflicts.length >= 2);
  assert.match(check.error, /规则维护弹窗|编辑字段表|导出文件/);
  // 规则维护弹窗 and 查看字段表popover agree; the other two each differ.
  const byEntry = Object.fromEntries(check.matrix.map((item) => [item.entry, item.value]));
  assert.equal(byEntry["规则维护弹窗"], byEntry["查看字段表popover"]);
  assert.notEqual(byEntry["编辑字段表"], byEntry["规则维护弹窗"]);
  assert.notEqual(byEntry["导出文件"], byEntry["规则维护弹窗"]);

  // A cross-entry disagreement is a product defect found by a value comparison.
  assert.equal(round.evidenceBundles[0].failureClass, "value-assertion");
});

test("sc-cross-entry: when all entries agree the same suite goes green", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-cross-entry", { __SELFCHECK_BASE__: app.baseUrl });
  // Point every probe at the one entry that is the reference ordering.
  for (const probe of suite.cases[0].consistencyGroup.probes) {
    probe.steps[0].url = `${app.baseUrl}parts/rule`;
  }
  const { response } = await runSuite(workspace, suite);
  assert.equal(response.status, "passed", JSON.stringify(response.firstFailure || response));
});

test("J-2: an unreachable entry is blocked, not 'the rest agreed so it passes'", async (t) => {
  const app = await startSelfcheckApp({ crash: false });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-cross-entry", { __SELFCHECK_BASE__: app.baseUrl });
  const probes = suite.cases[0].consistencyGroup.probes;
  // Two identical reachable entries + one that reads an element that does not
  // exist. Without the J-2 rule this would "pass" (the two that answered agree).
  suite.cases[0].consistencyGroup.probes = [probes[0], { ...probes[2], steps: [
    { ...probes[2].steps[0], url: `${app.baseUrl}parts/rule` },
    { ...probes[2].steps[1], target: { testId: "does-not-exist-anywhere" }, timeoutMs: 1500, retries: 0 },
  ] }];

  const { response, aggregate } = await runSuite(workspace, suite);
  assert.equal(response.status, "failed");
  const report = JSON.parse(await fsp.readFile(aggregate.caseResults[0].result.evidence.reportPath, "utf8"));
  const consistencyStep = report.summary.data.results.find(
    (item) => item?.data?.expectation?.type === "assertConsistency",
  );
  if (consistencyStep) {
    // If the comparison ran at all, it must refuse rather than agree.
    assert.equal(consistencyStep.data.expectation.ok, false);
    assert.equal(consistencyStep.data.expectation.blocked, true);
    assert.match(consistencyStep.data.expectation.error, /consistency-probe-unreached/);
  } else {
    // Or the unreachable probe step itself failed first and stopped the case —
    // also acceptable, and also not a false green.
    const summary = JSON.parse(await fsp.readFile(aggregate.caseResults[0].result.evidence.summaryPath, "utf8"));
    assert.equal(summary.status, "failed");
  }
});

// ---------------------------------------------------------------------------
// the report card ties it together
// ---------------------------------------------------------------------------

test("the report card of a self-check session states the facts a QA report needs", async (t) => {
  const app = await startSelfcheckApp({ crash: true });
  t.after(() => app.close());
  const workspace = await makeWorkspace(t);
  const suite = loadSuite("sc-page-error", { __SELFCHECK_BASE__: app.baseUrl });
  const { session } = await runSuite(workspace, suite);

  const card = await buildReportCard({
    session,
    testFile: suite,
    precheck: precheckTestFile({ testFile: suite }),
  });
  assert.deepEqual(card.verdictSummary, { green: 0, red: 1, blocked: 0, residue: 0 });
  const [caseCard] = card.byCase;
  assert.deepEqual(caseCard.facets, ["DEMO-1239-F1"]);
  assert.equal(caseCard.failureClass, "page-error");
  // "What was done" is the author's own Chinese, in execution order — and it
  // stops where execution stopped. The save step never ran (the gate failed the
  // case at the input step), so the card must not claim it did.
  assert.deepEqual(
    caseCard.whatWasDone.map((item) => item.step),
    ["点击复制，进入新建品类", "输入新品类名称"],
  );
  assert.equal(caseCard.whatWasDone.at(-1).status, "failed");
  // The page error appears as a risk, and RED calibration is honestly refused.
  assert.ok(card.risks.some((item) => item.kind === "page-error"));
  assert.equal(caseCard.redCalibration.present, false);
  assert.equal(caseCard.redCalibration.failureClass, "page-error");
});
