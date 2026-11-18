"use strict";


const { createRegisteredIssue } = require("./precheck-issue-registry");

const ABSENT_KINDS = new Set(["text-absent", "expectNoText", "no-text"]);
const EXISTS_KINDS = new Set(["text-exists", "expectTextExist", "assertVisible"]);

// AntD component families whose root element does NOT forward `data-testid` to
// the element you actually have to drive. Writing `target.testId` for these and
// then filling/clicking hits the wrapper `<div>` and fails with
// `target-not-found` (or, worse, silently drives the wrong node).
const NON_FORWARDING_TESTID_FAMILIES = [
  { pattern: /(input-?number|number-?input|qty|quantity)$/i, family: "AntD InputNumber", inner: "input" },
  { pattern: /(table|list|grid)$/i, family: "AntD Table", inner: "tbody tr" },
  { pattern: /(drawer|modal|dialog|popover|popconfirm)$/i, family: "AntD Drawer/Modal", inner: ".ant-drawer-body, .ant-modal-body" },
  { pattern: /(select|dropdown)$/i, family: "AntD Select", inner: ".ant-select-selector" },
  { pattern: /(picker|date|datepicker|daterange)$/i, family: "AntD DatePicker", inner: "input" },
  { pattern: /(upload|uploader)$/i, family: "AntD Upload", inner: "input[type=file]" },
];

// Actions that must reach the *inner* control, so a wrapper-only testid breaks.
const INNER_CONTROL_ACTIONS = new Set(["fill", "type", "press", "check", "uncheck", "selectOption", "uploadFile"]);

// Container classes AntD renders the same label into more than once.
const CONCATENATING_CONTAINERS = [
  { pattern: /ant-select-selection-item/i, hint: "AntD Select 的选中项容器会同时渲染可见文本、title 与隐藏测量 span" },
  { pattern: /ant-select(?!-dropdown)/i, hint: "AntD Select 根容器包含选中项 + 搜索 input + 测量 span" },
  { pattern: /ant-picker(?!-dropdown)/i, hint: "AntD DatePicker 容器包含 input 与占位文本" },
  { pattern: /ant-cascader(?!-menu)/i, hint: "AntD Cascader 容器包含多级标签拼接" },
  { pattern: /ant-input-number/i, hint: "AntD InputNumber 容器包含 input 与格式化显示节点" },
];

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stepKind(step = {}) {
  return trimText(step.type || step.kind || step.action || step.assertion);
}

function expectationKind(expectation = {}) {
  return trimText(expectation?.kind || expectation?.type || expectation?.mode);
}

// Flatten composite assertions so a rule never misses a weak oracle just because
// it was nested inside `composite.assertions[]`.
function flattenExpectations(expectation, basePath = "expectation", depth = 0) {
  if (!expectation || typeof expectation !== "object" || depth > 4) {
    return [];
  }
  const out = [{ expectation, path: basePath }];
  const nested = Array.isArray(expectation.assertions) ? expectation.assertions : [];
  nested.forEach((item, index) => {
    out.push(...flattenExpectations(item, `${basePath}.assertions[${index}]`, depth + 1));
  });
  return out;
}

// Every expectation a step declares, in BOTH authoring shapes:
//   nested   — `{"type":"assertDom","expectation":{...}}`
//   top-level— `{"type":"assertDom","property":"text","expected":"x"}`
// The runtime normalizer synthesizes the second into the first, but the precheck
// reads the *authored* file, so a rule that only looked at `step.expectation`
// silently skipped the top-level form — which is the form most real files use.
// (Found by the sc-weak-oracle self-check suite, whose second step is exactly
// that shape: it is the real v5.19 写法.)
function stepExpectations(step = {}) {
  const out = flattenExpectations(step.expectation);
  const kind = stepKind(step);
  const hasTopLevelAssertion =
    trimText(step.property) ||
    step.expected !== undefined ||
    trimText(step.attribute) ||
    trimText(step.operator);
  // Assertion-only step kinds carry their whole contract at the step level and
  // their nested `expectation` describes the SUBJECT (e.g. `{kind:"xlsx"}`), not
  // the assertion kind. Without this, an `assertFile` step contributed no signal
  // at all and a case built entirely from file assertions scored 0 — i.e. the
  // strongest evidence a case can produce was reported as the weakest.
  // (Found by the sc-file-artifact self-check suite.)
  if (["assertFile", "assertNoPageError", "assertPerf", "assertVisual", "assertLayout"].includes(kind)) {
    // `kind` comes AFTER the spread on purpose: the nested block's own `kind`
    // names the subject ("xlsx"/"image"), and letting it win would erase the
    // assertion kind we are here to record.
    out.push({ expectation: { ...(step.expectation || {}), kind, __topLevel: true }, path: "" });
  }
  if (["assertDom", "expectDom", "assertVisible", "assertCount", "assertUrl"].includes(kind) && hasTopLevelAssertion) {
    out.push({
      expectation: {
        kind: kind === "expectDom" ? "assertDom" : kind,
        property: step.property,
        operator: step.operator,
        expected: step.expected,
        attribute: step.attribute,
        target: step.target,
        scope: step.targetScope,
        count: step.count,
        // `__topLevel` marks the synthesized entry so a suggested patch points at
        // the step field, not at a non-existent `expectation.*` path.
        __topLevel: true,
      },
      path: "",
    });
  }
  return out;
}

function collectTargetText(step = {}, expectation = {}) {
  const target = expectation?.target || step.target || {};
  const scope = expectation?.scope || expectation?.within || target.scope || {};
  return [
    target.locator,
    target.testId,
    target.className,
    scope.locator,
    scope.testId,
    step.target?.locator,
    step.target?.testId,
  ]
    .map(trimText)
    .filter(Boolean)
    .join(" ");
}

function expectationTexts(expectation = {}) {
  const raw = expectation.texts ?? expectation.text ?? expectation.query ?? expectation.queries;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return list.map((item) => trimText(typeof item === "object" ? item?.text : item)).filter(Boolean);
}

function iterateCaseSteps(testFile = {}) {
  return (testFile.cases || []).flatMap((caseItem, caseIndex) =>
    (caseItem.steps || []).map((step, stepIndex) => ({
      caseItem,
      caseIndex,
      step,
      stepIndex,
      path: `cases[${caseIndex}].steps[${stepIndex}]`,
    })),
  );
}

function issueFor(code, entry, message, extras = {}) {
  return createRegisteredIssue(code, {
    severity: extras.severity || "warning",
    caseId: entry.caseItem?.id || null,
    caseName: entry.caseItem?.name || null,
    caseIndex: entry.caseIndex,
    stepId: entry.step?.id || null,
    stepIndex: entry.stepIndex,
    path: extras.path || entry.path,
    message,
    reason: extras.reason || message,
    // These are pattern matches on authored JSON, not observations of a real
    // run, so they are honestly labelled heuristics with a confidence below the
    // static-analysis default. A consumer weighting evidence sees the difference.
    evidenceSource: "heuristic",
    evidenceConfidence: extras.evidenceConfidence ?? 0.72,
    ...(extras.evidence ? { evidence: extras.evidence } : {}),
    ...(extras.suggestedPatch ? { suggestedPatch: extras.suggestedPatch } : {}),
  });
}

// --- rule 1: text-absent against a closed select -----------------------------
function checkClosedSelectAbsent(entry) {
  const issues = [];
  for (const { expectation, path } of stepExpectations(entry.step)) {
    if (!ABSENT_KINDS.has(expectationKind(expectation))) {
      continue;
    }
    const targetText = collectTargetText(entry.step, expectation);
    const looksLikeSelect = /ant-select|ant-cascader|ant-tree-select/i.test(targetText);
    const looksLikeDropdown = /ant-select-dropdown|ant-cascader-menu|ant-select-item/i.test(targetText);
    if (!looksLikeSelect || looksLikeDropdown) {
      continue;
    }
    issues.push(
      issueFor(
        "weak-oracle-closed-select",
        entry,
        `Step ${entry.stepIndex + 1}: text-absent 断在**闭合态**的 Select 容器上，只能证明"下拉已关/未选中"，不能证明该选项真的不存在——` +
          "闭合时选项本就不在 DOM 里，这条断言几乎不可能变红。改法：先打开下拉再断 option 缺失（scope 到 .ant-select-dropdown），" +
          "或断选项计数（count 变化），或断选中项的 title 属性单值。",
        { path },
      ),
    );
  }
  return issues;
}

// --- rule 2: property:text on a concatenating container -----------------------
function checkConcatenatedTextCapture(entry) {
  const issues = [];
  for (const { expectation, path } of stepExpectations(entry.step)) {
    const property = trimText(expectation.property);
    if (property !== "text" && property !== "innerText" && property !== "textContent") {
      continue;
    }
    const targetText = collectTargetText(entry.step, expectation);
    const container = CONCATENATING_CONTAINERS.find((item) => item.pattern.test(targetText));
    if (!container) {
      continue;
    }
    issues.push(
      issueFor(
        "capture-concatenated-text",
        entry,
        `Step ${entry.stepIndex + 1}: 对容器类元素取 property:"text" 会拿到**拼接值**（${container.hint}），` +
          '比对与 text-absent 都会因此永远命中或永远不命中。改法：取单值属性（property:"attribute" + attribute:"title"，或 aria-label），' +
          "或把 target 收窄到真正承载文本的叶子节点。",
        {
          path,
          suggestedPatch: {
            path: expectation.__topLevel ? `${entry.path}.property` : `${path}.property`,
            op: "replace",
            value: "attribute",
            note: '同时设置 attribute: "title"（AntD 选中项的单值来源）',
          },
        },
      ),
    );
  }
  return issues;
}

// --- rule 3: absent without a presence baseline in the same case -------------
function checkAbsentWithoutPresenceBaseline(entry, presenceIndex) {
  const issues = [];
  for (const { expectation, path } of stepExpectations(entry.step)) {
    if (!ABSENT_KINDS.has(expectationKind(expectation))) {
      continue;
    }
    const texts = expectationTexts(expectation);
    if (!texts.length) {
      continue;
    }
    const uncovered = texts.filter((text) => !presenceIndex.has(text));
    if (!uncovered.length) {
      continue;
    }
    issues.push(
      issueFor(
        "absent-without-presence-baseline",
        entry,
        `Step ${entry.stepIndex + 1}: 断言"${uncovered[0]}"不存在，但**同一个 case 里没有任何一步先证明它曾经存在**。` +
          "缺了这个对照，用例在'页面根本没渲染/定位错区域/文案改了'时同样会绿。改法：在删除/取消之前先断一次存在（或断计数 N → N-1）。",
        { path, evidence: { uncovered: uncovered.slice(0, 5) } },
      ),
    );
  }
  return issues;
}

// --- rule 4: existence-only assertion where a value was readable -------------
const VALUE_BEARING_HINTS = /input|textarea|ant-input|ant-select|ant-picker|ant-input-number/i;

function checkAssertionWithoutValue(entry) {
  const issues = [];
  const kind = stepKind(entry.step);
  for (const { expectation, path } of stepExpectations(entry.step)) {
    const expKind = expectationKind(expectation);
    const property = trimText(expectation.property);
    // `expected: true` on `property: "exists"` is NOT a value proof — it is the
    // existence check restated. Only a comparison against a business value counts.
    const existenceProperty = property === "exists" || property === "visible" || property === "hidden";
    const provesValue =
      property === "value" ||
      property === "attribute" ||
      (Array.isArray(expectation.body) && expectation.body.length > 0) ||
      (expectation.expected != null && !existenceProperty);
    if (provesValue) {
      continue;
    }
    const existenceOnly = EXISTS_KINDS.has(expKind) || existenceProperty || (expKind === "assertDom" && !property);
    if (!existenceOnly) {
      continue;
    }
    const targetText = collectTargetText(entry.step, expectation);
    const hasPlaceholder = Boolean(trimText(entry.step.target?.placeholder));
    const valueBearing = VALUE_BEARING_HINTS.test(targetText) || hasPlaceholder || kind === "fill";
    if (!valueBearing) {
      continue;
    }
    issues.push(
      issueFor(
        "assertion-without-value",
        entry,
        `Step ${entry.stepIndex + 1}: 目标是**可取值**的控件（输入框/选择器），但断言只证明它"存在/可见"。` +
          '存在性对"值写错了""值没保存"完全不敏感。改法：property:"value" + operator:"equals" + expected（或取 title/aria-label 属性）。',
        { path },
      ),
    );
  }
  return issues;
}

// --- rule 5: testid on a component family that does not forward it -----------
function checkTestIdNotForwarded(entry) {
  const kind = stepKind(entry.step);
  const testId = trimText(entry.step.target?.testId);
  if (!testId || !INNER_CONTROL_ACTIONS.has(kind)) {
    return [];
  }
  // An explicit locator/inner refinement means the author already knows.
  if (trimText(entry.step.target?.locator)) {
    return [];
  }
  const family = NON_FORWARDING_TESTID_FAMILIES.find((item) => item.pattern.test(testId));
  if (!family) {
    return [];
  }
  return [
    issueFor(
      "testid-not-forwarded",
      entry,
      `Step ${entry.stepIndex + 1}: "${testId}" 看起来是 ${family.family} 这类**不把 data-testid 透传到内层控件**的组件族，` +
        `而本步是 ${kind}（必须命中内层元素）。直接用 testId 会打在外层包裹 div 上，表现为 target-not-found 或驱动错节点。` +
        `改法：target.locator = '[data-testid="${testId}"] ${family.inner}'。`,
      {
        path: `${entry.path}.target.testId`,
        suggestedPatch: {
          path: `${entry.path}.target.locator`,
          op: "add",
          value: `[data-testid="${testId}"] ${family.inner}`,
        },
      },
    ),
  ];
}

// --- rule 6: exact-title option pick on a possibly virtualized list ----------
function checkVirtualizedListSelect(entry) {
  const kind = stepKind(entry.step);
  if (!["comboSearchSelect", "selectOption", "cascaderSelect"].includes(kind)) {
    return [];
  }
  const step = entry.step;
  const hasSearch = Boolean(
    trimText(step.query) || trimText(step.searchQuery) || trimText(step.searchText) || trimText(step.filterText),
  );
  const scrolls = Boolean(step.enableScroll || step.autoScroll);
  const wantsExactOption = Boolean(
    trimText(step.option?.text) || trimText(step.option?.value) || trimText(step.optionText) || trimText(step.optionValue),
  );
  if (hasSearch || scrolls || !wantsExactOption) {
    return [];
  }
  return [
    issueFor(
      "virtualized-list-select",
      entry,
      `Step ${entry.stepIndex + 1}: 精确选项选择既没有**先搜索**也没有**允许滚动**。AntD 下拉在选项较多时会虚拟化，` +
        "只渲染视口内的若干项——一旦造数残留把列表顶长，目标项就不在 DOM 里，表现为间歇性 target-not-found。" +
        "改法：先填搜索词（query/searchText）再选，或开 enableScroll。",
      { path: entry.path, evidenceConfidence: 0.6 },
    ),
  ];
}

// Text values a case proves *present* somewhere, used as the baseline for rule 3.
function buildPresenceIndex(caseItem = {}) {
  const index = new Set();
  for (const step of caseItem.steps || []) {
    for (const { expectation } of stepExpectations(step)) {
      const kind = expectationKind(expectation);
      if (ABSENT_KINDS.has(kind)) {
        continue;
      }
      if (EXISTS_KINDS.has(kind) || kind === "assertDom" || kind === "count" || kind === "assertCount") {
        expectationTexts(expectation).forEach((text) => index.add(text));
        const expected = expectation.expected;
        if (typeof expected === "string" && expected.trim()) {
          index.add(expected.trim());
        }
        [expectation.target?.hasText, expectation.target?.text, step.target?.hasText, step.target?.text]
          .map(trimText)
          .filter(Boolean)
          .forEach((text) => index.add(text));
      }
    }
    // A `fill` that types the value also establishes "this value was here".
    if (stepKind(step) === "fill") {
      const value = trimText(step.value ?? step.target?.value ?? step.text);
      if (value) {
        index.add(value);
      }
    }
  }
  return index;
}

function collectDiscriminationIssues(testFile = {}) {
  const presenceIndexByCase = new Map();
  for (const caseItem of testFile.cases || []) {
    presenceIndexByCase.set(caseItem.id || caseItem.name || "", buildPresenceIndex(caseItem));
  }
  const issues = [];
  for (const entry of iterateCaseSteps(testFile)) {
    const presenceIndex =
      presenceIndexByCase.get(entry.caseItem.id || entry.caseItem.name || "") || new Set();
    issues.push(
      ...checkClosedSelectAbsent(entry),
      ...checkConcatenatedTextCapture(entry),
      ...checkAbsentWithoutPresenceBaseline(entry, presenceIndex),
      ...checkAssertionWithoutValue(entry),
      ...checkTestIdNotForwarded(entry),
      ...checkVirtualizedListSelect(entry),
    );
  }
  return issues;
}

// Signal weights. "Strong" = the assertion compares a concrete value that the
// business logic determines, so a regression changes it. "Medium" = it observes
// a real state change but a broad one. Nothing here is a subjective judgement of
// the author — it is purely "what could this assertion detect".
const STRONG_SIGNALS = {
  equals: 22,
  "response-body-path": 22,
  "count-numeric": 18,
  "file-content": 24,
  "attribute-value": 18,
  "input-value": 18,
  "visual-baseline": 16,
  // v1.11 REQ-Z32: measured box geometry — fails on a broken layout, passes on a fixed one.
  "layout-geometry": 20,
};
const MEDIUM_SIGNALS = {
  "text-exists": 8,
  "url-match": 8,
  "response-status": 8,
  "no-page-error": 6,
  "wait-for-change": 4,
  "text-absent": 3,
};
const WEAK_CODES = new Set([
  "weak-oracle-closed-select",
  "capture-concatenated-text",
  "absent-without-presence-baseline",
  "assertion-without-value",
  "virtualized-list-select",
]);

function collectCaseSignals(caseItem = {}) {
  const signals = new Set();
  for (const step of caseItem.steps || []) {
    for (const { expectation } of stepExpectations(step)) {
      const kind = expectationKind(expectation);
      const property = trimText(expectation.property);
      const operator = trimText(expectation.operator);
      const existenceProperty = property === "exists" || property === "visible" || property === "hidden";
      // Same discipline as the rule above: `expected: true` on `exists` is not a
      // value comparison, so it must not earn the strongest signal weight.
      if (expectation.expected != null && !existenceProperty && (operator === "equals" || operator === "" || operator === "notEquals")) {
        signals.add("equals");
      }
      if (property === "value") {
        signals.add("input-value");
      }
      if (property === "attribute") {
        signals.add("attribute-value");
      }
      if (Array.isArray(expectation.body) && expectation.body.length) {
        signals.add("response-body-path");
      }
      if (expectation.status != null) {
        signals.add("response-status");
      }
      if (kind === "count" || kind === "assertCount" || kind === "expectCount") {
        signals.add(expectation.count != null ? "count-numeric" : "text-exists");
      }
      if (kind === "url-matches" || kind === "assertUrl" || kind === "expectUrl") {
        signals.add("url-match");
      }
      if (EXISTS_KINDS.has(kind)) {
        signals.add("text-exists");
      }
      if (ABSENT_KINDS.has(kind)) {
        signals.add("text-absent");
      }
      if (kind === "waitForChange") {
        signals.add("wait-for-change");
      }
      if (kind === "assertNoPageError" || kind === "expectNoPageError") {
        signals.add("no-page-error");
      }
      if (kind === "assertFile") {
        signals.add("file-content");
      }
      if (kind === "assertVisual") {
        signals.add("visual-baseline");
      }
      if (kind === "assertLayout") {
        signals.add("layout-geometry");
      }
      if (kind === "region-similar" || kind === "expectRegionSimilar") {
        signals.add("visual-baseline");
      }
    }
  }
  return signals;
}

// 0-100, deliberately coarse. It is a *risk indicator for the consumer*, not a
// grade for the author — which is why it never blocks and why the weak list is
// returned alongside it. A number without its reasons would be unactionable.
function scoreDiscriminativePower({ caseItem = {}, issues = [] } = {}) {
  const signals = collectCaseSignals(caseItem);
  const weak = issues
    .filter((issue) => WEAK_CODES.has(issue.code))
    .filter((issue) => !issue.caseId || !caseItem.id || issue.caseId === caseItem.id)
    .map((issue) => ({ code: issue.code, stepId: issue.stepId || null, path: issue.path || null }));

  if (!signals.size) {
    return { score: 0, signals: [], weak, note: "no assertion of any kind in this case" };
  }
  let strong = 0;
  let medium = 0;
  for (const signal of signals) {
    if (STRONG_SIGNALS[signal]) {
      strong += STRONG_SIGNALS[signal];
    } else if (MEDIUM_SIGNALS[signal]) {
      medium += MEDIUM_SIGNALS[signal];
    }
  }
  const base = 30;
  const penalty = Math.min(40, weak.length * 12);
  const score = Math.max(0, Math.min(100, base + Math.min(60, strong) + Math.min(24, medium) - penalty));
  return {
    score,
    signals: Array.from(signals).sort(),
    weak,
    ...(weak.length ? { note: `${weak.length} weak-oracle risk(s) lowered this score` } : {}),
  };
}

module.exports = {
  NON_FORWARDING_TESTID_FAMILIES,
  stepExpectations,
  WEAK_CODES,
  buildPresenceIndex,
  collectCaseSignals,
  collectDiscriminationIssues,
  flattenExpectations,
  scoreDiscriminativePower,
};
