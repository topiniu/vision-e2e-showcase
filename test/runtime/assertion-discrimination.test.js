
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectDiscriminationIssues,
  scoreDiscriminativePower,
} = require("../../src/shared/assertion-discrimination");

function fileWith(steps, extra = {}) {
  return {
    id: "f",
    cases: [{ id: "case-1", name: "case one", steps, ...extra }],
  };
}

function codes(issues) {
  return issues.map((item) => item.code);
}

test("H-1 positive: text-absent on a closed AntD Select is flagged", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: ".ant-select-selection-item" },
        expectation: { kind: "text-absent", texts: ["文档"] },
      },
    ]),
  );
  assert.ok(codes(issues).includes("weak-oracle-closed-select"));
  const flagged = issues.find((item) => item.code === "weak-oracle-closed-select");
  assert.match(flagged.message, /闭合态/);
  assert.equal(flagged.severity, "warning", "advisory only — a blocking heuristic would just get disabled");
});

test("H-1 negative: the same assertion scoped INTO the open dropdown is not flagged", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: ".ant-select-dropdown .ant-select-item-option" },
        expectation: { kind: "text-absent", texts: ["文档"] },
      },
    ]),
  );
  assert.ok(!codes(issues).includes("weak-oracle-closed-select"));
});

test("H-2 positive: property:text on .ant-select-selection-item is flagged with a patch", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: ".ant-select-selection-item" },
        expectation: { kind: "assertDom", property: "text", operator: "equals", expected: "文档" },
      },
    ]),
  );
  const flagged = issues.find((item) => item.code === "capture-concatenated-text");
  assert.ok(flagged, "the triple-concatenation container must be caught");
  assert.equal(flagged.suggestedPatch.value, "attribute");
  assert.match(flagged.message, /拼接值/);
});

test("H-2 negative: reading the title attribute of the same element is fine", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: ".ant-select-selection-item" },
        expectation: { kind: "assertDom", property: "attribute", attribute: "title", operator: "equals", expected: "文档" },
      },
    ]),
  );
  assert.ok(!codes(issues).includes("capture-concatenated-text"));
});

test("H-3 positive: asserting absence with no presence baseline in the same case", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      { id: "s1", type: "click", target: { text: "删除" } },
      { id: "s2", type: "assertDom", target: { testId: "list" }, expectation: { kind: "text-absent", texts: ["示例文档QA-9"] } },
    ]),
  );
  const flagged = issues.find((item) => item.code === "absent-without-presence-baseline");
  assert.ok(flagged);
  assert.deepEqual(flagged.evidence.uncovered, ["示例文档QA-9"]);
});

test("H-3 negative: a presence assertion earlier in the case satisfies the baseline", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      { id: "s1", type: "assertDom", target: { testId: "list" }, expectation: { kind: "text-exists", texts: ["示例文档QA-9"] } },
      { id: "s2", type: "click", target: { text: "删除" } },
      { id: "s3", type: "assertDom", target: { testId: "list" }, expectation: { kind: "text-absent", texts: ["示例文档QA-9"] } },
    ]),
  );
  assert.ok(!codes(issues).includes("absent-without-presence-baseline"));
});

test("H-3 negative: a fill that typed the value also counts as a baseline", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      { id: "s1", type: "fill", target: { placeholder: "名称" }, value: "示例文档QA-9" },
      { id: "s2", type: "assertDom", target: { testId: "list" }, expectation: { kind: "text-absent", texts: ["示例文档QA-9"] } },
    ]),
  );
  assert.ok(!codes(issues).includes("absent-without-presence-baseline"));
});

test("H-4 positive: existence-only assertion on a value-bearing control", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: "input.ant-input" },
        expectation: { kind: "assertDom", property: "exists", expected: true },
      },
    ]),
  );
  assert.ok(codes(issues).includes("assertion-without-value"));
});

test("H-4 negative: the same control asserted by value is not flagged", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: "input.ant-input" },
        expectation: { kind: "assertDom", property: "value", operator: "equals", expected: "示例文档QA-9" },
      },
    ]),
  );
  assert.ok(!codes(issues).includes("assertion-without-value"));
});

test("H-4 negative: existence of a non-value element (a table row) is legitimate", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: ".result-row" },
        expectation: { kind: "assertDom", property: "exists", expected: true },
      },
    ]),
  );
  assert.ok(!codes(issues).includes("assertion-without-value"));
});

test("H-5 positive: filling via a wrapper-only testid gets the correct locator suggested", () => {
  const issues = collectDiscriminationIssues(
    fileWith([{ id: "s1", type: "fill", target: { testId: "demo-size-rule-tolerance-input-number" }, value: "3" }]),
  );
  const flagged = issues.find((item) => item.code === "testid-not-forwarded");
  assert.ok(flagged);
  assert.equal(
    flagged.suggestedPatch.value,
    '[data-testid="demo-size-rule-tolerance-input-number"] input',
  );
});

test("H-5 negative: an explicit locator refinement means the author already knows", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "fill",
        target: { testId: "demo-qty-input-number", locator: '[data-testid="demo-qty-input-number"] input' },
        value: "3",
      },
    ]),
  );
  assert.ok(!codes(issues).includes("testid-not-forwarded"));
});

test("H-5 negative: clicking a wrapper testid is fine (no inner control needed)", () => {
  const issues = collectDiscriminationIssues(
    fileWith([{ id: "s1", type: "click", target: { testId: "demo-workflow-table" } }]),
  );
  assert.ok(!codes(issues).includes("testid-not-forwarded"));
});

test("H-6 positive: exact option pick with neither search nor scroll", () => {
  const issues = collectDiscriminationIssues(
    fileWith([{ id: "s1", type: "comboSearchSelect", target: { testId: "category-select" }, option: { text: "文档" } }]),
  );
  assert.ok(codes(issues).includes("virtualized-list-select"));
});

test("H-6 negative: searching first removes the virtualization risk", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "comboSearchSelect",
        target: { testId: "category-select" },
        query: "文档",
        option: { text: "文档" },
      },
    ]),
  );
  assert.ok(!codes(issues).includes("virtualized-list-select"));
});

test("H-7: both real v5.19 weak oracles are caught by the shipped rules", () => {
  // (1) DEMO-1310-F3 style: closing the dropdown then asserting the option is gone.
  // (2) The Select selection-item triple concatenation.
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "f3-close-then-absent",
        type: "assertDom",
        stepTitle: "assert 闭合下拉后不含旧品类",
        target: { locator: ".ant-select .ant-select-selection-item" },
        expectation: { kind: "text-absent", texts: ["旧品类"] },
      },
      {
        id: "select-text-triple",
        type: "assertDom",
        stepTitle: "assert 选中项文案",
        target: { locator: ".ant-select-selection-item" },
        expectation: { kind: "assertDom", property: "text", operator: "equals", expected: "示例文档" },
      },
    ]),
  );
  const found = new Set(codes(issues));
  assert.ok(found.has("weak-oracle-closed-select"), "closed-dropdown text-absent");
  assert.ok(found.has("capture-concatenated-text"), "selection-item property:text");
});

test("composite assertions are inspected too (a weak oracle must not hide inside one)", () => {
  const issues = collectDiscriminationIssues(
    fileWith([
      {
        id: "s1",
        type: "assertDom",
        target: { locator: ".ant-select-selection-item" },
        expectation: {
          kind: "composite",
          assertions: [
            { kind: "waitForChange", timeoutMs: 1000 },
            { kind: "text-absent", texts: ["文档"] },
          ],
        },
      },
    ]),
  );
  assert.ok(codes(issues).includes("weak-oracle-closed-select"));
});

test("discriminativePower rewards value comparison and punishes weak oracles", () => {
  const strongCase = {
    id: "case-strong",
    steps: [
      {
        id: "s1",
        type: "assertDom",
        target: { testId: "detail-name" },
        expectation: { kind: "assertDom", property: "text", operator: "equals", expected: "示例文档QA-9" },
      },
      { id: "s2", type: "capture", expectation: { kind: "networkResponse", urlIncludes: "/save", status: 200, body: [{ path: "data.id", operator: "exists" }] } },
    ],
  };
  const strong = scoreDiscriminativePower({ caseItem: strongCase, issues: [] });
  assert.ok(strong.score >= 70, `expected a strong score, got ${strong.score}`);
  assert.ok(strong.signals.includes("equals"));
  assert.ok(strong.signals.includes("response-body-path"));
  assert.deepEqual(strong.weak, []);

  const weakCase = {
    id: "case-weak",
    steps: [
      {
        id: "s1",
        type: "assertDom",
        target: { locator: ".ant-select-selection-item" },
        expectation: { kind: "text-absent", texts: ["文档"] },
      },
    ],
  };
  const weakIssues = collectDiscriminationIssues({ cases: [weakCase] });
  const weak = scoreDiscriminativePower({ caseItem: weakCase, issues: weakIssues });
  assert.ok(weak.score < strong.score);
  assert.ok(weak.weak.length >= 1);
  assert.match(weak.note, /weak-oracle/);
});

test("a case with no assertion at all scores 0 and says why", () => {
  const result = scoreDiscriminativePower({
    caseItem: { id: "c", steps: [{ id: "s1", type: "click", target: { text: "保存" } }] },
    issues: [],
  });
  assert.equal(result.score, 0);
  assert.match(result.note, /no assertion/);
});

test("weak issues from OTHER cases do not drag this case's score down", () => {
  const caseItem = {
    id: "case-a",
    steps: [
      {
        id: "s1",
        type: "assertDom",
        target: { testId: "x" },
        expectation: { kind: "assertDom", property: "text", operator: "equals", expected: "v" },
      },
    ],
  };
  const foreignIssue = { code: "weak-oracle-closed-select", caseId: "case-b", stepId: "s9" };
  const result = scoreDiscriminativePower({ caseItem, issues: [foreignIssue] });
  assert.deepEqual(result.weak, []);
});
