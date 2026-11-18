
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { run } = require("../../runtime");
const { createPageDiagnostics } = require("../../runtime/perception/page-diagnostics");
const { createDiagnosis, createRepairContext } = require("../../runtime/server/diagnosis");

function createHtmlServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

// The v5.19 defect, reduced: typing into the field throws because the handler
// reads a recycled synthetic-event target (React 16 event pooling).
const CRASHING_INPUT_HTML = `<!doctype html>
  <html><body>
    <input id="category-name" placeholder="品类名称" />
    <div data-testid="category-list">文档</div>
    <script>
      document.querySelector("#category-name").addEventListener("input", () => {
        // Mirrors "Cannot read properties of null (reading 'value')" — the
        // pooled-event TypeError that stayed invisible for a whole round.
        const recycled = null;
        recycled.value.trim();
      });
    </script>
  </body></html>`;

const outputRoot = path.join(os.tmpdir(), "zhuzhu-page-error-gate");

function readSummary(result) {
  return JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
}

test("A-1: an uncaught TypeError during a step fails the case with code page-error", async () => {
  const { server, url } = await createHtmlServer(CRASHING_INPUT_HTML);
  try {
    const result = await run(
      [
        {
          id: "fill-name",
          type: "fill",
          stepTitle: "填写品类名称",
          target: { placeholder: "品类名称" },
          value: "示例文档QA-1",
        },
        {
          id: "assert-list",
          type: "assertDom",
          stepTitle: "assert 列表仍在",
          target: { testId: "category-list" },
          property: "exists",
          expected: true,
        },
      ],
      {
        url,
        headless: true,
        outputDir: outputRoot,
        runId: "page-error-a1",
        evidenceProfile: "fast",
        testContext: { caseId: "case-a1", caseName: "新建品类" },
      },
    );

    assert.equal(result.ok, false, "the case must be red even though every assertion passed");
    const summary = readSummary(result);
    assert.equal(summary.status, "failed");
    // The failing step is the one that was running when the page threw.
    assert.equal(summary.firstFailure.stepId, "fill-name");
    assert.equal(summary.firstFailure.code, "page-error");
    // The app's own message must be quoted verbatim — that is the whole point.
    assert.match(summary.firstFailure.message, /Cannot read propert|of null/i);
    // A-1 also demands the evidence be persisted, not just reported.
    assert.equal(summary.pageErrors.policy, "fail");
    assert.ok(summary.pageErrors.failing >= 1);
    const persisted = JSON.parse(fs.readFileSync(summary.pageErrors.artifactPath, "utf8"));
    assert.ok(persisted.entries.length >= 1);
    assert.equal(persisted.entries[0].kind, "pageerror");
    assert.equal(persisted.entries[0].stepId, "fill-name");

    // And the repair context (what an AI/human actually reads) must carry the
    // original message + stack, classified as an app defect rather than a test bug.
    const aggregate = {
      ok: false,
      sessionId: "s1",
      roundId: "round-1",
      caseResults: [{ caseId: "case-a1", caseName: "新建品类", result }],
    };
    const diagnosis = createDiagnosis(aggregate);
    assert.equal(diagnosis.failureType, "page-error");
    assert.ok(diagnosis.fixHints.some((hint) => /APP defect/i.test(hint)));
    const repair = createRepairContext({ aggregate, diagnosis });
    assert.ok(repair.pageErrors.length >= 1);
    assert.match(repair.pageErrors[0].message, /Cannot read propert|of null/i);
  } finally {
    server.close();
  }
});

test('A-2: pageErrorPolicy "off" keeps the case green but still records the error', async () => {
  const { server, url } = await createHtmlServer(CRASHING_INPUT_HTML);
  try {
    const result = await run(
      [
        {
          id: "fill-name",
          type: "fill",
          stepTitle: "填写品类名称",
          target: { placeholder: "品类名称" },
          value: "示例文档QA-2",
        },
      ],
      {
        url,
        headless: true,
        outputDir: outputRoot,
        runId: "page-error-a2",
        evidenceProfile: "fast",
        pageErrorPolicy: "off",
      },
    );

    assert.equal(result.ok, true, "with the gate off the verdict is untouched");
    const summary = readSummary(result);
    assert.equal(summary.pageErrors.policy, "off");
    assert.ok(
      summary.pageErrors.total >= 1,
      "turning the gate off must NOT stop the collection — otherwise the evidence disappears with the gate",
    );
    assert.ok(fs.existsSync(summary.pageErrors.artifactPath));
  } finally {
    server.close();
  }
});

test('A-2b: pageErrorPolicy "warn" records + reports without changing the verdict', async () => {
  const { server, url } = await createHtmlServer(CRASHING_INPUT_HTML);
  try {
    const result = await run(
      [
        {
          id: "fill-name",
          type: "fill",
          target: { placeholder: "品类名称" },
          value: "示例文档QA-2b",
        },
      ],
      {
        url,
        headless: true,
        outputDir: outputRoot,
        runId: "page-error-a2b",
        evidenceProfile: "fast",
        pageErrorPolicy: "warn",
      },
    );
    assert.equal(result.ok, true);
    const summary = readSummary(result);
    assert.equal(summary.pageErrors.policy, "warn");
    assert.ok(summary.pageErrors.failing >= 1, "warn still counts it as a failing-class entry for reporting");
  } finally {
    server.close();
  }
});

test("A-3: an allowlisted message does not fail the case and is marked suppressed with its reason", async () => {
  const { server, url } = await createHtmlServer(CRASHING_INPUT_HTML);
  try {
    const result = await run(
      [
        {
          id: "fill-name",
          type: "fill",
          target: { placeholder: "品类名称" },
          value: "示例文档QA-3",
        },
      ],
      {
        url,
        headless: true,
        outputDir: outputRoot,
        runId: "page-error-a3",
        evidenceProfile: "fast",
        pageErrorAllowlist: [{ match: "Cannot read propert", reason: "本例故意注入，用于验证 allowlist" }],
      },
    );

    assert.equal(result.ok, true);
    const summary = readSummary(result);
    assert.equal(summary.pageErrors.failing, 0);
    assert.equal(summary.pageErrors.suppressed, 1);
    assert.equal(summary.pageErrors.entries[0].suppressed, true);
    assert.equal(summary.pageErrors.entries[0].suppressedReason, "本例故意注入，用于验证 allowlist");
  } finally {
    server.close();
  }
});

test("a clean page yields an empty-but-present pageErrors report (watched vs. not watched)", async () => {
  const { server, url } = await createHtmlServer(
    `<!doctype html><html><body><div data-testid="ok">正常</div></body></html>`,
  );
  try {
    const result = await run(
      [{ id: "assert-ok", type: "assertDom", target: { testId: "ok" }, property: "text", operator: "equals", expected: "正常" }],
      { url, headless: true, outputDir: outputRoot, runId: "page-error-clean", evidenceProfile: "fast" },
    );
    assert.equal(result.ok, true);
    const summary = readSummary(result);
    assert.notEqual(summary.pageErrors, null, "the field must exist so 'clean' is distinguishable from 'not collected'");
    assert.equal(summary.pageErrors.total, 0);
    assert.equal(summary.pageErrors.policy, "fail");
  } finally {
    server.close();
  }
});

test("assertNoPageError fails closed when no collector is attached", async () => {
  const { expectNoPageError } = require("../../runtime/assertions");
  const result = await expectNoPageError(null, { kind: "assertNoPageError" }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "page-diagnostics-unavailable");
});

test("assertNoPageError is scoped to the stretch since the previous assertion", async () => {
  const diagnostics = createPageDiagnostics({ page: null, policy: "warn" });
  const { expectNoPageError } = require("../../runtime/assertions");

  diagnostics.record({ kind: "pageerror", message: "boom-1" });
  const first = await expectNoPageError(null, { kind: "assertNoPageError" }, { diagnostics });
  assert.equal(first.ok, false);
  assert.equal(first.pageErrors.length, 1);

  // Nothing new happened since -> the second assertion passes, because it is
  // asserting about a *different stretch of the flow*, not re-judging the old error.
  const second = await expectNoPageError(null, { kind: "assertNoPageError" }, { diagnostics });
  assert.equal(second.ok, true);

  // ...while `since: "run-start"` deliberately re-judges everything.
  const wholeRun = await expectNoPageError(
    null,
    { kind: "assertNoPageError", raw: { since: "run-start" } },
    { diagnostics },
  );
  assert.equal(wholeRun.ok, false);
  assert.equal(wholeRun.scope, "run-start");
});

test("the assertion still fails under a warn/off policy (that is why it exists)", async () => {
  const { expectNoPageError } = require("../../runtime/assertions");
  for (const policy of ["warn", "off"]) {
    const diagnostics = createPageDiagnostics({ page: null, policy });
    diagnostics.record({ kind: "console-error", message: "React error boundary caught" });
    const result = await expectNoPageError(null, { kind: "assertNoPageError" }, { diagnostics });
    assert.equal(result.ok, false, `policy ${policy}: an explicit assertion outranks the file-level policy`);
    assert.equal(result.policy, policy);
  }
});

test("regex allowlist entries work, and a malformed one degrades to substring", () => {
  const withRegex = createPageDiagnostics({ page: null, allowlist: [{ match: "/^ResizeObserver/", reason: "noise" }] });
  assert.equal(withRegex.record({ kind: "pageerror", message: "ResizeObserver loop limit exceeded" }).suppressed, true);
  assert.equal(withRegex.record({ kind: "pageerror", message: "later ResizeObserver mention" }).suppressed, false);

  const malformed = createPageDiagnostics({ page: null, allowlist: [{ match: "/[unclosed/", reason: "typo" }] });
  // Degrades to substring rather than throwing: an allowlist typo must not break
  // the run it was meant to quiet.
  assert.equal(malformed.record({ kind: "pageerror", message: "prefix [unclosed suffix" }).suppressed, true);
});

test("the entry cap keeps a pathological render loop from ballooning the report", () => {
  const diagnostics = createPageDiagnostics({ page: null, maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) {
    diagnostics.record({ kind: "pageerror", message: `boom-${i}` });
  }
  const report = diagnostics.getReport();
  assert.equal(report.total, 3);
  assert.equal(report.dropped, 7);
});

test("the gate consumes its cursor so one page error fails exactly one step", () => {
  const diagnostics = createPageDiagnostics({ page: null, policy: "fail" });
  diagnostics.record({ kind: "pageerror", message: "boom" });
  assert.equal(diagnostics.takeNewGateFailures().length, 1);
  assert.equal(diagnostics.takeNewGateFailures().length, 0, "the next step must not inherit the same error");
});
