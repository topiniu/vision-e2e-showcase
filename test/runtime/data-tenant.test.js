
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DataTenantRegistry,
  diffBaseline,
  evaluateResidueAssertion,
  normalizeDataTenant,
  resolveTenantPrefix,
  shortRunId,
} = require("../../src/shared/data-tenant");

test("I-3: the prefix is per-run, so two concurrent rounds cannot collide", () => {
  const a = resolveTenantPrefix({ prefix: "QA-{{runId8}}-" }, "session-aaaaaaaa-round-1");
  const b = resolveTenantPrefix({ prefix: "QA-{{runId8}}-" }, "session-bbbbbbbb-round-1");
  assert.notEqual(a, b);
  assert.match(a, /^QA-[A-Za-z0-9]{8}-$/);
  // Which is what makes automated cleanup safe: "delete everything starting with
  // QA-" would be a footgun aimed at the other run.
  assert.equal(a.startsWith("QA-"), true);
  assert.equal(shortRunId("x").length, 8);
  // A literal prefix is honoured verbatim.
  assert.equal(resolveTenantPrefix({ prefix: "FIXED-" }, "r"), "FIXED-");
  // And there is a sane default, so declaring `dataTenant: {}` still works.
  assert.match(resolveTenantPrefix({}, "abcdefghdemo-password-not-valid8"), /^QA-\w{8}-$/);
});

test("normalizeDataTenant returns null when the file declared nothing", () => {
  assert.equal(normalizeDataTenant(null, "r"), null);
  assert.equal(normalizeDataTenant(undefined, "r"), null);
  const config = normalizeDataTenant({ prefix: "T-" }, "r");
  assert.equal(config.prefix, "T-");
  assert.equal(config.registerCreated, true);
});

test("I-1: created 3, cleaned 2 -> the residue list names exactly the third", () => {
  const registry = new DataTenantRegistry({ prefix: "QA-abc12345-", runId: "r" });
  registry.register({ kind: "category", identifier: "QA-abc12345-文档", stepId: "s1" });
  registry.register({ kind: "category", identifier: "QA-abc12345-裤子", stepId: "s2" });
  registry.register({ kind: "category", identifier: "QA-abc12345-示例文档", stepId: "s3" });
  registry.markCleaned("QA-abc12345-文档");
  registry.markCleaned("QA-abc12345-裤子");

  const report = registry.getReport();
  assert.equal(report.createdCount, 3);
  assert.equal(report.cleanedCount, 2);
  assert.equal(report.residueCount, 1);
  assert.deepEqual(
    report.residue.map((item) => item.identifier),
    ["QA-abc12345-示例文档"],
  );
  // The per-entity ledger says which step created it — that is what makes a
  // leftover row fixable rather than merely reported.
  assert.equal(report.created.find((item) => item.identifier.endsWith("示例文档")).stepId, "s3");
});

test("a value carrying this run's prefix is registered even without a declaration", () => {
  const registry = new DataTenantRegistry({ prefix: "QA-run1-", runId: "r" });
  const registered = registry.registerFromCapture({ name: "categoryName", value: "QA-run1-示例文档", stepId: "s1" });
  assert.ok(registered);
  assert.equal(registered.source, "capture");
  // Someone else's data (or a pre-existing record) is NOT claimed.
  assert.equal(registry.registerFromCapture({ name: "x", value: "QA-run2-示例文档" }), null);
  assert.equal(registry.registerFromCapture({ name: "x", value: "文档" }), null);
  assert.equal(registry.getReport().createdCount, 1);
});

test("registering the same entity twice does not double-count it", () => {
  const registry = new DataTenantRegistry({ prefix: "P-", runId: "r" });
  registry.register({ kind: "category", identifier: "P-a" });
  registry.register({ kind: "category", identifier: "P-a" });
  assert.equal(registry.getReport().createdCount, 1);
});

test("a registry with nothing recorded reports null (no empty block in the report)", () => {
  assert.equal(new DataTenantRegistry({ prefix: "P-" }).getReport(), null);
});

// --- baselineGuard -----------------------------------------------------------

test("I-2: baselineGuard catches a preset record changed under us, with before/after", () => {
  const drift = diffBaseline(
    { "category:文档": "enabled", "category:裤子": "enabled" },
    { "category:文档": "disabled", "category:裤子": "enabled" },
  );
  assert.equal(drift.checked, true);
  assert.equal(drift.drifted, true);
  assert.deepEqual(drift.changes, [{ key: "category:文档", before: "enabled", after: "disabled" }]);
  // The sentence that was missing when "谁把预置『文档』停用了" was unanswerable.
  assert.match(drift.detail, /文档/);
  assert.match(drift.detail, /enabled.*disabled/);
});

test("no drift is reported when nothing the round must not touch changed", () => {
  const drift = diffBaseline({ a: 1, b: "x" }, { a: 1, b: "x" });
  assert.equal(drift.drifted, false);
  assert.deepEqual(drift.changes, []);
});

test("a missing AFTER snapshot is 'not measured', not 'no change'", () => {
  const drift = diffBaseline({ a: 1 }, null);
  assert.equal(drift.checked, false);
  assert.match(drift.reason, /没测到/);
});

test("a key that only appears afterwards counts as drift", () => {
  const drift = diffBaseline({ a: 1 }, { a: 1, b: 2 });
  assert.equal(drift.drifted, true);
  assert.deepEqual(drift.changes, [{ key: "b", before: null, after: 2 }]);
});

// --- assertResidue -----------------------------------------------------------

test("assertResidue passes when everything created was cleaned", async () => {
  const registry = new DataTenantRegistry({ prefix: "P-" });
  registry.register({ kind: "category", identifier: "P-a" });
  registry.markCleaned("P-a");
  const result = await evaluateResidueAssertion({}, { dataTenant: registry });
  assert.equal(result.ok, true);
  assert.equal(result.actual, "residue = 0");
});

test("assertResidue fails with an actionable message when something is left behind", async () => {
  const registry = new DataTenantRegistry({ prefix: "P-" });
  registry.register({ kind: "category", identifier: "P-leftover", stepId: "s9" });
  const result = await evaluateResidueAssertion({}, { dataTenant: registry });
  assert.equal(result.ok, false);
  assert.match(result.error, /assertResidue:residue 1 > 0/);
  assert.match(result.detail, /P-leftover/);
  // Says WHY it matters, so it is not just bookkeeping noise.
  assert.match(result.detail, /顶穿|虚拟化|计数/);
});

test("assertResidue tolerates a declared allowance", async () => {
  const registry = new DataTenantRegistry({ prefix: "P-" });
  registry.register({ kind: "category", identifier: "P-a" });
  assert.equal((await evaluateResidueAssertion({ atMost: 1 }, { dataTenant: registry })).ok, true);
});

test("assertResidue fails on baseline drift even when nothing was left behind", async () => {
  const registry = new DataTenantRegistry({ prefix: "P-" });
  registry.snapshotBaseline("before", { "category:文档": "enabled" });
  registry.snapshotBaseline("after", { "category:文档": "disabled" });
  const result = await evaluateResidueAssertion({}, { dataTenant: registry });
  assert.equal(result.ok, false);
  assert.equal(result.error, "assertResidue:baseline-drift");
  assert.equal(result.baselineDrift.changes.length, 1);

  // ...and the guard can be waived explicitly when a round legitimately edits them.
  const waived = await evaluateResidueAssertion({ baselineGuard: false }, { dataTenant: registry });
  assert.equal(waived.ok, true);
});

test("assertResidue fails closed when the file declared no dataTenant", async () => {
  const result = await evaluateResidueAssertion({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "data-tenant-unavailable");
  assert.match(result.detail, /无法核实/);
});

// --- end-to-end through the engine ------------------------------------------

test("a run with settings.dataTenant exposes {{tenantPrefix}} and reports residue", async (t) => {
  const http = require("node:http");
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const { run } = require("../../runtime");

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<html><body><input data-testid="name" /><div data-testid="list">列表</div></body></html>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const result = await run(
    [
      {
        id: "create",
        type: "fill",
        stepTitle: "输入品类名（带租户前缀）",
        target: { testId: "name" },
        value: "{{tenantPrefix}}示例文档",
        // The author declares what this step created.
        registerCreated: [{ kind: "category", identifier: "{{tenantPrefix}}示例文档" }],
      },
      {
        id: "assert-residue",
        type: "assertResidue",
        stepTitle: "assert 本轮造数已清理",
      },
    ],
    {
      url,
      headless: true,
      outputDir: path.join(os.tmpdir(), "zhuzhu-data-tenant"),
      runId: "tenant-e2e",
      evidenceProfile: "fast",
      dataTenant: { prefix: "QA-{{runId8}}-" },
    },
  );

  // The residue assertion fails because nothing cleaned it up — which is the
  // correct verdict for this file.
  assert.equal(result.ok, false);
  const summary = JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
  assert.match(summary.runtimeVariables.tenantPrefix, /^QA-\w{8}-$/);
  assert.equal(summary.dataResidue.createdCount, 1);
  assert.equal(summary.dataResidue.residueCount, 1);
  assert.match(summary.dataResidue.residue[0].identifier, /^QA-\w{8}-示例文档$/);
  assert.ok(fs.existsSync(summary.dataResidue.artifactPath));
  assert.equal(summary.firstFailure.stepId, "assert-residue");
});
