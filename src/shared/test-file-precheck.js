const fs = require("node:fs");
const path = require("node:path");
const { normalizeTestFile, testFileToRuntimeDraft } = require("./test-file");
const { resolveTestFileReferences } = require("./test-file-references");
const { getDraftWarnings, validateDraft } = require("../panel/lib/payload-draft");
const { createRegisteredIssue, getIssueDefinition } = require("./precheck-issue-registry");
const { collectDiscriminationIssues } = require("./assertion-discrimination");
const { CANONICAL_OPERATORS, isSupportedAssertionOperator } = require("./assertion-operators");
const { parseViewport } = require("./viewport");
const { parseRouteFaultSpec } = require("./route-fault");
const { parseLayoutSpec } = require("./layout-assertion");
const {
  hashObject,
  hasScopedExpectation,
  scoreGrade,
  scoreLocator,
  scoreProof,
} = require("./proof-policy");

const LONG_CASE_STEP_WARNING_THRESHOLD = 12;
const LONG_CASE_STEP_STRONG_WARNING_THRESHOLD = 20;

const EXPECTATION_SCOPE_SCHEMA = {
  field: "expectation.scope",
  aliases: ["expectation.within"],
  description: "Limit text-exists/text-absent checks to a specific visible container.",
  fields: {
    nearText: {
      type: "string",
      required: false,
      description: "Text expected near or inside the scoped container, such as a dialog title.",
    },
    role: {
      type: "string",
      required: false,
      description: "Container role. role=dialog also matches common AntD modal/drawer containers.",
    },
    locator: {
      type: "string",
      required: false,
      description: "CSS or XPath locator for the scoped container.",
    },
    testId: {
      type: "string",
      required: false,
      description: "Stable data-testid style identifier for the scoped container.",
    },
  },
  examples: [
    {
      kind: "text-absent",
      text: "请选择或搜索运营",
      scope: {
        role: "dialog",
        nearText: "创建任务任务",
      },
      timeoutMs: 5000,
    },
    {
      kind: "text-exists",
      text: "DEMO2026",
      scope: {
        testId: "demo-result-table",
      },
      timeoutMs: 8000,
    },
  ],
};

const TARGET_SCOPE_SCHEMA = {
  field: "target.scope",
  description: "Limit target resolution to a specific parent DOM container. When present, target search is a hard boundary and does not fall back to the full page.",
  fields: {
    nearText: {
      type: "string",
      required: false,
      description: "Text expected inside the parent container, such as a dialog title.",
    },
    role: {
      type: "string",
      required: false,
      description: "Parent container role, such as dialog.",
    },
    locator: {
      type: "string",
      required: false,
      description: "CSS or XPath locator for the parent container.",
    },
    testId: {
      type: "string",
      required: false,
      description: "Stable data-testid style identifier for the parent container.",
    },
  },
  examples: [
    {
      type: "fill",
      target: {
        placeholder: "请输入负责人姓名搜索",
        scope: {
          role: "dialog",
          nearText: "创建任务任务",
        },
      },
    },
  ],
};

const ASSERT_DOM_SCHEMA = {
  field: "expectation",
  kind: "assertDom",
  description: "Assert structured DOM state for a target. Supports use inside composite.assertions.",
  fields: {
    target: {
      type: "object",
      required: true,
      description: "Locator target. Prefer locator/testId/role/placeholder/ariaLabel/title; hasText/hasTexts can filter rows or list items; tagText/tagTexts can assert visible tags inside the matched row with tagMatch exact by default.",
    },
    property: {
      type: "string",
      required: true,
      enum: ["exists", "visible", "count", "text", "value", "checked", "disabled", "selected", "attribute", "class"],
    },
    operator: {
      type: "string",
      required: false,
      enum: ["equals", "contains", "matches", "exists", "notExists", "atLeast", "atMost", "greaterThan", "lessThan", "changed", "unchanged", "increased", "decreased"],
      description: "Comparison operator. changed/unchanged/increased/decreased are before/after diff operators: pair them with an earlier saveAs snapshot and set expected to that snapshot variable ({{savedVar}}) to assert a field was (or was not) mutated — e.g. verify 已录尺寸 survived changing 款式条件 via operator=unchanged, expected={{savedSizes}}. increased/decreased compare the numeric portion so labeled counts ('共 132 条') diff correctly.",
    },
    expected: {
      type: "any",
      required: false,
      description: "Expected value. Defaults to true for exists/visible. For diff operators (changed/unchanged/increased/decreased) this is the earlier snapshot, typically a {{savedVar}} captured via saveAs.",
    },
    attribute: {
      type: "string",
      required: false,
      description: "Required when property=attribute.",
    },
    saveAs: {
      type: "string",
      required: false,
      description: "Capture the asserted actual value into a runtime variable.",
    },
  },
};

const RESPONSE_ASSERTION_SCHEMA = {
  field: "expectation",
  kinds: ["assertResponse", "networkResponse"],
  description: "Assert API or page network response status and JSON body dot-path values.",
  fields: {
    status: { type: "number", required: false },
    method: { type: "string", required: false },
    urlIncludes: { type: "string", required: false },
    urlMatches: { type: "string", required: false },
    body: {
      type: "array",
      required: false,
      item: {
        path: "string",
        operator: "equals|contains|matches|exists|notExists|atLeast|atMost|greaterThan|lessThan|changed|unchanged|increased|decreased",
        expected: "any",
        saveAs: "string",
      },
    },
  },
};

const CALL_API_SCHEMA = {
  type: "callApi",
  description: "Call an API with the current browser context/session and assert the response with expectation.kind=assertResponse.",
  fields: {
    request: {
      type: "object",
      required: true,
      fields: {
        method: { type: "string", required: false },
        url: { type: "string", required: true },
        headers: { type: "object", required: false },
        autoAuth: {
          type: "boolean",
          required: false,
          description: "Defaults to true. When no auth header is provided, callApi reads localStorage token values such as _TOKEN_ and injects an auth header.",
        },
        authHeader: {
          type: "string",
          required: false,
          description: "Header name for auto-injected localStorage token. Defaults to token.",
        },
        authStorageKey: {
          type: "string",
          required: false,
          description: "Preferred localStorage key for auto auth token. Defaults to _TOKEN_.",
        },
        auth: {
          type: "object",
          required: false,
          description: "Optional auto auth config: { header, localStorageKey, scheme }.",
        },
        query: { type: "object", required: false },
        body: { type: "any", required: false },
      },
    },
    saveAs: { type: "string", required: false },
  },
};

const VARS_SCHEMA = {
  field: "vars",
  type: "object",
  required: false,
  description: "Named run-level variables. Values may reference built-in variables such as {{$timestamp}}, and steps may reference them with {{name}} or {{$name}}.",
  example: {
    caseToken: "自动化测试·复版历史·{{$timestamp}}",
  },
};

const SCAFFOLD_SCHEMA = {
  setup: {
    field: "setup.steps",
    type: "array",
    required: false,
    description: "Root setup steps that run before every selected case.",
  },
  teardown: {
    field: "teardown.steps",
    type: "array",
    required: false,
    description: "Root teardown steps that run after every selected case. Runs after failed case steps unless the run is stopped.",
  },
  fixtures: {
    field: "fixtures",
    type: "object",
    required: false,
    description: "Named setup/teardown step groups reusable by cases.",
  },
  macros: {
    field: "macros",
    type: "object",
    required: false,
    description: "Named reusable step groups expanded by useMacro steps. Macro bodies may reference invocation params with {{param.NAME}} (or {{params.NAME}}).",
  },
  useMacro: {
    type: "useMacro",
    fields: {
      macro: { type: "string", required: true },
      params: {
        type: "object",
        required: false,
        description: "Per-invocation params (aliases: with / args) substituted into the macro body's {{param.NAME}} tokens at expansion time, so one macro definition is reused with different inputs. A whole-string token preserves the value type ('{{param.qty}}' with qty:3 -> 3); a param value may itself carry a runtime {{var}} (e.g. a saveAs'd id) which is left for run-time interpolation, enabling teardown to clean up by the id created in this run.",
      },
    },
  },
};

function normalizeInput(raw) {
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("testFile must be a JSON object.");
  }
  return raw.testFile || raw.file || raw.payload || raw;
}

function normalizeEnvelope(raw) {
  const input = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!input || typeof input !== "object") {
    throw new Error("testFile must be a JSON object.");
  }
  return {
    input: input.testFile || input.file || input.payload || input,
    before: input.before || null,
    after: input.after || null,
    mode: input.mode === "gate" || input.mode === "patch-review" ? input.mode : "advisory",
    beforeHash: typeof input.beforeHash === "string" ? input.beforeHash : "",
    fileFingerprint: input.fileFingerprint && typeof input.fileFingerprint === "object" ? input.fileFingerprint : null,
    appContract: input.appContract && typeof input.appContract === "object" ? input.appContract : null,
    path: typeof input.path === "string" ? input.path : "",
    dryRun: input.dryRun && typeof input.dryRun === "object" ? input.dryRun : null,
    rootDir: typeof input.rootDir === "string" ? input.rootDir : path.join(process.cwd(), "test-workflows"),
  };
}

function decorateIssue(issue, caseItem, caseIndex) {
  return {
    ...issue,
    caseId: caseItem.id,
    caseName: caseItem.name,
    caseIndex,
  };
}

function createError(message, caseItem, caseIndex, index) {
  const stepMatch = /^Step\s+(\d+):/.exec(message);
  return {
    code: "draft-validation-error",
    severity: "error",
    message,
    caseId: caseItem.id,
    caseName: caseItem.name,
    caseIndex,
    stepIndex: stepMatch ? Number(stepMatch[1]) - 1 : null,
    path: stepMatch ? `cases[${caseIndex}].steps[${Number(stepMatch[1]) - 1}]` : `cases[${caseIndex}]`,
    index,
  };
}

function createScaffoldError(code, message, path) {
  return {
    code,
    severity: "error",
    message,
    path,
  };
}

function createWarning(code, message, warningPath, extras = {}) {
  return {
    code,
    severity: "warning",
    message,
    path: warningPath,
    ...extras,
  };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function getStepKind(step = {}) {
  return step.type || step.kind || step.action || "";
}

function getMacroName(step = {}) {
  return String(step.macro || step.macroName || step.name || step.ref || "").trim();
}

function visitDeep(value, visitor, currentPath = "$") {
  visitor(value, currentPath);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitDeep(item, visitor, `${currentPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => visitDeep(item, visitor, `${currentPath}.${key}`));
  }
}

function collectTemplateVariables(value) {
  const vars = new Set();
  visitDeep(value, (item) => {
    if (typeof item !== "string" || !item.includes("{{")) {
      return;
    }
    // v1.10 Z27: dotted names (`origin.app`, `credential.username`) are real
    // references now; they used to be invisible to this scan.
    for (const match of item.matchAll(/\{\{\s*\$?([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)?)\s*\}\}/g)) {
      vars.add(match[1]);
    }
  });
  return vars;
}

function extractTokenKeys(value) {
  const tokens = new Set();
  if (typeof value !== "string") {
    return tokens;
  }
  for (const match of value.matchAll(/\{\{\s*\$?([A-Za-z][A-Za-z0-9_-]*(?:Token|token)[A-Za-z0-9_-]*)\s*\}\}/g)) {
    tokens.add(`var:${match[1]}`);
  }
  if (value.includes("自动化测试") || value.includes("{{$timestamp}}") || value.includes("{{timestamp}}")) {
    tokens.add(`text:${value}`);
  }
  return tokens;
}

function collectTokenSemantics(testFile) {
  const written = new Set();
  const asserted = [];
  const collectWrite = (value) => extractTokenKeys(value).forEach((token) => written.add(token));
  const collectAssert = (value, tokenPath) => {
    extractTokenKeys(value).forEach((token) => asserted.push({ token, path: tokenPath, value }));
  };

  const inspectStep = (step, stepPath) => {
    if (!step || typeof step !== "object") {
      return;
    }
    if (step.type === "fill") {
      collectWrite(step.value);
      collectWrite(step.target?.value);
    }
    collectAssert(step.target?.text, `${stepPath}.target.text`);
    collectAssert(step.target?.hasText, `${stepPath}.target.hasText`);
    (Array.isArray(step.target?.hasTexts) ? step.target.hasTexts : []).forEach((item, index) =>
      collectAssert(item, `${stepPath}.target.hasTexts[${index}]`),
    );
    inspectExpectation(step.expectation, `${stepPath}.expectation`, collectAssert);
  };

  (testFile.setup?.steps || []).forEach((step, index) => inspectStep(step, `setup.steps[${index}]`));
  Object.entries(testFile.fixtures || {}).forEach(([name, fixture]) => {
    (fixture.setup || []).forEach((step, index) => inspectStep(step, `fixtures.${name}.setup[${index}]`));
    (fixture.teardown || []).forEach((step, index) => inspectStep(step, `fixtures.${name}.teardown[${index}]`));
  });
  Object.entries(testFile.macros || {}).forEach(([name, macro]) => {
    (macro.steps || []).forEach((step, index) => inspectStep(step, `macros.${name}.steps[${index}]`));
  });
  (testFile.cases || []).forEach((caseItem, caseIndex) => {
    (caseItem.steps || []).forEach((step, stepIndex) => inspectStep(step, `cases[${caseIndex}].steps[${stepIndex}]`));
  });
  return { written, asserted };
}

function inspectExpectation(expectation, expectationPath, collectAssert) {
  if (!expectation || typeof expectation !== "object") {
    return;
  }
  if (expectation.kind === "text-exists" || expectation.kind === "text-absent") {
    const texts = Array.isArray(expectation.text) ? expectation.text : [expectation.text];
    texts.forEach((item, index) => collectAssert(item, `${expectationPath}.text${Array.isArray(expectation.text) ? `[${index}]` : ""}`));
  }
  if (expectation.kind === "assertDom") {
    collectAssert(expectation.target?.hasText, `${expectationPath}.target.hasText`);
    (Array.isArray(expectation.target?.hasTexts) ? expectation.target.hasTexts : []).forEach((item, index) =>
      collectAssert(item, `${expectationPath}.target.hasTexts[${index}]`),
    );
  }
  (Array.isArray(expectation.body) ? expectation.body : []).forEach((item, index) =>
    collectAssert(item?.expected, `${expectationPath}.body[${index}].expected`),
  );
  (Array.isArray(expectation.assertions) ? expectation.assertions : []).forEach((item, index) =>
    inspectExpectation(item, `${expectationPath}.assertions[${index}]`, collectAssert),
  );
}

function expectationKind(expectation = {}) {
  return String(expectation.kind || expectation.mode || "").trim();
}

function expectationAssertions(expectation = {}) {
  return Array.isArray(expectation.assertions) ? expectation.assertions : [];
}

function hasWaitForChangeExpectation(expectation) {
  if (!expectation || typeof expectation !== "object") {
    return false;
  }
  if (expectationKind(expectation) === "waitForChange") {
    return true;
  }
  return expectationAssertions(expectation).some((item) => hasWaitForChangeExpectation(item));
}

function isCompositeWaitForChangeFirst(expectation) {
  if (!expectation || typeof expectation !== "object" || expectationKind(expectation) !== "composite") {
    return false;
  }
  const assertions = expectationAssertions(expectation);
  return assertions.length > 1 && expectationKind(assertions[0]) === "waitForChange";
}

function textValues(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => textValues(item));
  }
  if (typeof value === "string" || typeof value === "number") {
    return [String(value)];
  }
  return [];
}

function collectExpectationTextFields(expectation, basePath) {
  if (!expectation || typeof expectation !== "object") {
    return [];
  }
  const fields = [];
  textValues(expectation.text).forEach((value, index) => {
    fields.push({
      value,
      path: `${basePath}.text${Array.isArray(expectation.text) ? `[${index}]` : ""}`,
    });
  });
  textValues(expectation.expected).forEach((value) => {
    fields.push({ value, path: `${basePath}.expected` });
  });
  textValues(expectation.target?.text).forEach((value) => {
    fields.push({ value, path: `${basePath}.target.text` });
  });
  textValues(expectation.target?.hasText).forEach((value) => {
    fields.push({ value, path: `${basePath}.target.hasText` });
  });
  textValues(expectation.target?.hasTexts).forEach((value, index) => {
    fields.push({ value, path: `${basePath}.target.hasTexts[${index}]` });
  });
  expectationAssertions(expectation).forEach((item, index) => {
    fields.push(...collectExpectationTextFields(item, `${basePath}.assertions[${index}]`));
  });
  return fields;
}

function fixedResultCountMatch(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return (
    text.match(/(?:共|总计|合计|总数|数量)\s*[:：=为约大概]*\s*(\d{1,8})\s*(?:条|个|笔|项|页|records?|items?)/i) ||
    text.match(/\b(?:total|count)\s*[:：=]\s*(\d{1,8})\b/i)
  );
}

function isSearchClickStep(step = {}) {
  if (getStepKind(step) !== "click") {
    return false;
  }
  const text = [
    step.stepTitle,
    step.query,
    step.target?.text,
    step.target?.name,
    step.target?.ariaLabel,
    step.target?.title,
  ].flatMap((item) => textValues(item)).join(" ");
  return /搜索|查询|筛选|search|filter/i.test(text);
}

function isSearchInputFillStep(step = {}) {
  if (getStepKind(step) !== "fill") {
    return false;
  }
  const text = [
    step.stepTitle,
    step.query,
    step.value,
    step.target?.value,
    step.target?.placeholder,
    step.target?.text,
    step.target?.name,
    step.target?.ariaLabel,
    step.target?.title,
  ].flatMap((item) => textValues(item)).join(" ");
  return /搜索|查询|筛选|SPU|CJ\s*SPU|编号|关键字|keyword|search|filter/i.test(text);
}

function isTopLevelDomAssertionStep(step = {}) {
  const kind = getStepKind(step);
  return kind === "assertDom" || kind === "expectDom";
}

function hasNestedExpectation(step = {}) {
  return isPlainObject(step.expectation) && Object.keys(step.expectation).length > 0;
}

function collectShadowedNestedExpectationErrors(testFile) {
  const errors = [];
  allCaseSteps(testFile).forEach((entry) => {
    if (!isTopLevelDomAssertionStep(entry.step) || !hasNestedExpectation(entry.step)) {
      return;
    }
    errors.push({
      code: "top-level-assertdom-nested-expectation-shadowed",
      severity: "error",
      message: `Step ${entry.stepIndex + 1}: top-level ${getStepKind(entry.step)} carries a nested expectation that the panel runtime draft conversion will shadow; rewrite as type=capture with expectation.kind=composite so all assertions run.`,
      caseId: entry.caseItem.id,
      caseName: entry.caseItem.name,
      caseIndex: entry.caseIndex,
      stepId: entry.step.id || null,
      stepIndex: entry.stepIndex,
      path: `${entry.path}.expectation`,
      recommendation: "Use expectation.kind=composite with one assertDom assertion and one text-exists/assertion entry.",
    });
  });
  return errors;
}

function collectAuthoringQualityWarnings(testFile) {
  const warnings = [];
  (testFile.cases || []).forEach((caseItem, caseIndex) => {
    (caseItem.steps || []).forEach((step, stepIndex, steps) => {
      const stepPath = `cases[${caseIndex}].steps[${stepIndex}]`;
      const expectation = step?.expectation;
      collectExpectationTextFields(expectation, `${stepPath}.expectation`).forEach((field) => {
        const match = fixedResultCountMatch(field.value);
        if (!match) {
          return;
        }
        warnings.push(createWarning(
          "dynamic-count-literal-risk",
          `Step ${stepIndex + 1}: fixed result count "${match[0]}" may drift with environment data; prefer networkResponse/assertDom checks for stable business fields or capture the current total from the response.`,
          field.path,
          {
            caseId: caseItem.id,
            caseName: caseItem.name,
            caseIndex,
            stepId: step.id || null,
            stepIndex,
            literal: match[0],
          },
        ));
      });

      if (isCompositeWaitForChangeFirst(expectation)) {
        warnings.push(createWarning(
          "composite-waitforchange-first-risk",
          `Step ${stepIndex + 1}: composite assertion starts with waitForChange; if the page already refreshed before this action, later business assertions will be skipped.`,
          `${stepPath}.expectation.assertions[0]`,
          {
            caseId: caseItem.id,
            caseName: caseItem.name,
            caseIndex,
            stepId: step.id || null,
            stepIndex,
          },
        ));
      }

      const previousStep = steps[stepIndex - 1];
      if (
        previousStep &&
        isSearchInputFillStep(previousStep) &&
        isSearchClickStep(step) &&
        hasWaitForChangeExpectation(expectation)
      ) {
        warnings.push(createWarning(
          "search-waitforchange-after-fill-risk",
          `Step ${stepIndex + 1}: previous fill step may already trigger search/filter refresh, so clicking search and waiting only for page change can time out even when results are already updated.`,
          `${stepPath}.expectation`,
          {
            caseId: caseItem.id,
            caseName: caseItem.name,
            caseIndex,
            stepId: step.id || null,
            stepIndex,
            previousStepId: previousStep.id || null,
            previousStepIndex: stepIndex - 1,
          },
        ));
      }
    });
  });
  return warnings;
}

function readStepGroup(value, path, errors, { requiredArray = false } = {}) {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (isPlainObject(value)) {
    if (value.steps == null) {
      return [];
    }
    if (Array.isArray(value.steps)) {
      return value.steps;
    }
    errors.push(createScaffoldError(
      "scaffold-steps-array-required",
      `${path}.steps must be an array.`,
      `${path}.steps`,
    ));
    return [];
  }
  if (requiredArray) {
    errors.push(createScaffoldError(
      "scaffold-steps-array-required",
      `${path} must be an array.`,
      path,
    ));
  }
  return [];
}

function collectMacroReferenceErrors(steps, path, macros, errors, stack = [], maxDepth = 5) {
  (Array.isArray(steps) ? steps : []).forEach((step, index) => {
    if (!step || typeof step !== "object") {
      return;
    }
    if (getStepKind(step) !== "useMacro") {
      return;
    }
    const macroName = getMacroName(step);
    const stepPath = `${path}[${index}]`;
    if (!macroName) {
      errors.push(createScaffoldError(
        "macro-name-required",
        `${stepPath}: useMacro requires macro.`,
        `${stepPath}.macro`,
      ));
      return;
    }
    const macro = macros[macroName];
    if (!macro) {
      errors.push(createScaffoldError(
        "macro-not-found",
        `${stepPath}: macro "${macroName}" is not defined.`,
        `${stepPath}.macro`,
      ));
      return;
    }
    if (stack.includes(macroName)) {
      errors.push(createScaffoldError(
        "macro-cycle",
        `Macro cycle detected: ${[...stack, macroName].join(" -> ")}.`,
        `${stepPath}.macro`,
      ));
      return;
    }
    if (stack.length >= maxDepth) {
      errors.push(createScaffoldError(
        "macro-depth-exceeded",
        `Macro nesting exceeds ${maxDepth} levels.`,
        `${stepPath}.macro`,
      ));
      return;
    }
    collectMacroReferenceErrors(macro.steps, `macros.${macroName}.steps`, macros, errors, [...stack, macroName], maxDepth);
  });
}

function collectScaffoldErrors(source) {
  const errors = [];
  const input = source && typeof source === "object" ? source : {};
  const macros = {};

  const rootSetupSteps = readStepGroup(input.setup, "setup", errors);
  const rootTeardownSteps = readStepGroup(input.teardown, "teardown", errors);
  const fixtureStepGroups = [];

  if (input.fixtures != null && !isPlainObject(input.fixtures)) {
    errors.push(createScaffoldError("fixtures-object-required", "fixtures must be an object.", "fixtures"));
  }
  Object.entries(isPlainObject(input.fixtures) ? input.fixtures : {}).forEach(([fixtureName, fixture]) => {
    if (!isPlainObject(fixture)) {
      errors.push(createScaffoldError(
        "fixture-object-required",
        `fixtures.${fixtureName} must be an object.`,
        `fixtures.${fixtureName}`,
      ));
      return;
    }
    fixtureStepGroups.push({
      path: `fixtures.${fixtureName}.setup`,
      steps: readStepGroup(fixture.setup, `fixtures.${fixtureName}.setup`, errors, { requiredArray: true }),
    });
    fixtureStepGroups.push({
      path: `fixtures.${fixtureName}.teardown`,
      steps: readStepGroup(fixture.teardown, `fixtures.${fixtureName}.teardown`, errors, { requiredArray: true }),
    });
  });

  if (input.macros != null && !isPlainObject(input.macros)) {
    errors.push(createScaffoldError("macros-object-required", "macros must be an object.", "macros"));
  }
  Object.entries(isPlainObject(input.macros) ? input.macros : {}).forEach(([macroName, macro]) => {
    const steps = readStepGroup(macro, `macros.${macroName}`, errors);
    macros[macroName] = { steps };
  });

  Object.entries(macros).forEach(([macroName, macro]) => {
    collectMacroReferenceErrors(macro.steps, `macros.${macroName}.steps`, macros, errors, [macroName]);
  });
  collectMacroReferenceErrors(rootSetupSteps, "setup.steps", macros, errors);
  collectMacroReferenceErrors(rootTeardownSteps, "teardown.steps", macros, errors);
  fixtureStepGroups.forEach((group) => {
    collectMacroReferenceErrors(group.steps, group.path, macros, errors);
  });

  (Array.isArray(input.cases) ? input.cases : []).forEach((caseItem, caseIndex) => {
    const fixtures = Array.isArray(caseItem?.fixtures)
      ? caseItem.fixtures
      : typeof caseItem?.fixtures === "string"
        ? caseItem.fixtures.split(/[,;|\r?\n]/)
        : [];
    fixtures.map((item) => String(item || "").trim()).filter(Boolean).forEach((fixtureName) => {
      if (!isPlainObject(input.fixtures) || !input.fixtures[fixtureName]) {
        errors.push(createScaffoldError(
          "fixture-not-found",
          `cases[${caseIndex}]: fixture "${fixtureName}" is not defined.`,
          `cases[${caseIndex}].fixtures`,
        ));
      }
    });
    collectMacroReferenceErrors(
      Array.isArray(caseItem?.steps) ? caseItem.steps : [],
      `cases[${caseIndex}].steps`,
      macros,
      errors,
    );
  });

  return errors;
}

function createLongCaseWarning(caseItem, caseIndex) {
  const stepCount = Array.isArray(caseItem.steps) ? caseItem.steps.length : 0;
  if (stepCount <= LONG_CASE_STEP_WARNING_THRESHOLD) {
    return null;
  }
  const strong = stepCount > LONG_CASE_STEP_STRONG_WARNING_THRESHOLD;
  return {
    code: strong ? "case-excessive-steps" : "case-many-steps",
    severity: "warning",
    message: strong
      ? `Case "${caseItem.name}" has ${stepCount} steps. Very long cases are hard to debug; keep one happy-path case only when necessary and split modal/open, basic fields, SKU, upload, submit, and result checks into focused cases.`
      : `Case "${caseItem.name}" has ${stepCount} steps. Long cases are harder to debug; consider splitting it into smaller focused cases unless this is the main happy path.`,
    caseId: caseItem.id,
    caseName: caseItem.name,
    caseIndex,
    stepCount,
    threshold: LONG_CASE_STEP_WARNING_THRESHOLD,
    strongThreshold: LONG_CASE_STEP_STRONG_WARNING_THRESHOLD,
    path: `cases[${caseIndex}].steps`,
    recommendation: "Prefer one complete happy path plus smaller diagnostic cases for high-risk controls and business checkpoints.",
  };
}

// ---- v1.10 authoring checks ------------------------------------------------

const RUN_TARGET_NAMESPACES = ["origin", "credential"];

function isRunTargetVariableName(name) {
  const [namespace, key] = String(name || "").split(".");
  return Boolean(key) && RUN_TARGET_NAMESPACES.includes(namespace);
}

function collectCapturedVariableNames(source) {
  const names = new Set();
  visitDeep(source, (item) => {
    if (isPlainObject(item) && typeof item.saveAs === "string" && item.saveAs.trim()) {
      names.add(item.saveAs.trim());
    }
  });
  return names;
}

// Under a step's `request` lives the payload sent to the backend; an `operator`
// key there is business data (操作人), not an assertion operator.
function isInsideRequestPayload(nodePath) {
  return /\.request(\.|\[|$)/.test(nodePath);
}

const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/i;

function trimRootPath(nodePath) {
  return String(nodePath || "$").replace(/^\$\.?/, "") || "$";
}

function collectV110AuthoringChecks(source) {
  const errors = [];
  const warnings = [];
  const hardcodedOrigins = new Map();
  const targetOrigins = new Set();
  visitDeep(source, (item, nodePath) => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/\{\{\s*origin\.([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g)) {
        targetOrigins.add(match[1]);
      }
      const key = nodePath.split(".").pop();
      const origin = LOCAL_ORIGIN_PATTERN.exec(item);
      if (origin && (key === "baseUrl" || key === "url")) {
        const entry = hardcodedOrigins.get(origin[0]) || { origin: origin[0], count: 0, samplePath: trimRootPath(nodePath) };
        entry.count += 1;
        hardcodedOrigins.set(origin[0], entry);
      }
      return;
    }
    if (!isPlainObject(item) || isInsideRequestPayload(nodePath)) {
      return;
    }
    // Z28-2: an operator the runtime does not know used to act as `equals`.
    const isBodyAssertion = typeof item.path === "string";
    const rawOperator = item.operator ?? (isBodyAssertion ? item.op ?? item.comparison : undefined);
    if (typeof rawOperator === "string" && rawOperator.trim() && !isSupportedAssertionOperator(rawOperator)) {
      errors.push(createScaffoldError(
        "unsupported-assertion-operator",
        `Assertion operator "${rawOperator}" is not supported (it fails at run time). Supported: ${CANONICAL_OPERATORS.join(", ")}.`,
        trimRootPath(nodePath),
      ));
    }
    // Z28-4: a fan-out capture stores the whole list as JSON text.
    if (
      typeof item.saveAs === "string" && item.saveAs.trim() &&
      typeof item.path === "string" && item.path.includes("[]") &&
      item.first !== true && item.saveAsScalar !== true
    ) {
      warnings.push(createWarning(
        "capture-fanout-without-first",
        `saveAs "${item.saveAs}" reads the fan-out path "${item.path}" and captures the whole list as JSON text. If one id is meant, add first:true or index the path (e.g. [0]); an empty list fails the step.`,
        trimRootPath(nodePath),
        { variableName: item.saveAs.trim() },
      ));
    }
  });
  if (hardcodedOrigins.size) {
    const list = [...hardcodedOrigins.values()];
    warnings.push({
      ...createWarning(
        "hardcoded-origin",
        `${list.reduce((sum, item) => sum + item.count, 0)} URL(s) hard-code a local origin (${list.map((item) => item.origin).join(", ")}). Write {{origin.<name>}} and let the caller pass target.origins, so one file runs against any environment.`,
        list[0].samplePath,
        { origins: list },
      ),
      severity: "info",
    });
  }
  if (targetOrigins.size) {
    warnings.push({
      ...createWarning(
        "target-origins-required",
        `This file needs target.origins for: ${[...targetOrigins].join(", ")}. A session without them is rejected (target-origin-missing).`,
        "$",
        { origins: [...targetOrigins] },
      ),
      severity: "info",
    });
  }
  return { errors, warnings };
}

// ---- v1.11 authoring checks ------------------------------------------------
// Every rule here mirrors a runtime rejection: a spec the runtime would refuse
// must be refused before the run, not discovered as a red case at night.
function collectV111AuthoringChecks(source = {}) {
  const errors = [];
  const settingsViewport = source?.settings?.viewport;
  if (settingsViewport != null) {
    for (const reason of parseViewport(settingsViewport).errors) {
      errors.push(createScaffoldError("invalid-viewport", `settings.viewport: ${reason}`, "settings.viewport"));
    }
  }
  (Array.isArray(source?.cases) ? source.cases : []).forEach((caseItem, index) => {
    if (caseItem && caseItem.viewport != null) {
      for (const reason of parseViewport(caseItem.viewport).errors) {
        errors.push(createScaffoldError("invalid-viewport", `case "${caseItem.id || index + 1}" viewport: ${reason}`, `cases[${index}].viewport`));
      }
    }
  });
  visitDeep(source, (item, nodePath) => {
    if (!isPlainObject(item) || isInsideRequestPayload(nodePath)) {
      return;
    }
    const kind = item.type || item.kind || item.action;
    if (kind === "routeFault") {
      for (const reason of parseRouteFaultSpec(item).errors) {
        errors.push(createScaffoldError("invalid-route-fault", reason, trimRootPath(nodePath)));
      }
    }
    if (kind === "assertLayout") {
      for (const reason of parseLayoutSpec(item).errors) {
        errors.push(createScaffoldError("invalid-layout-assertion", reason, trimRootPath(nodePath)));
      }
    }
  });
  return { errors };
}

function collectSemanticWarnings(testFile, source = {}) {
  const warnings = [];
  const builtInVars = new Set(["timestamp", "timestampMs", "isoTimestamp", "runId", "tenantPrefix"]);
  const declaredVars = new Set(Object.keys(testFile.vars || {}));
  // v1.10: a variable some step captures (`saveAs`) is defined at run time —
  // flagging it as unknown was a standing false positive.
  const capturedVars = collectCapturedVariableNames(source);
  for (const variableName of collectTemplateVariables(source)) {
    // `origin.*` / `credential.*` come from the run target (v1.10 Z27) and are
    // checked against it when a session starts, not here.
    if (isRunTargetVariableName(variableName)) {
      continue;
    }
    if (!builtInVars.has(variableName) && !declaredVars.has(variableName) && !capturedVars.has(variableName)) {
      warnings.push(createWarning(
        "unknown-template-variable",
        `Template variable "${variableName}" is not defined in built-in runtime variables or file vars.`,
        "$",
        { variableName },
      ));
    }
  }

  const { written, asserted } = collectTokenSemantics(testFile);
  asserted.forEach((item) => {
    if (!written.has(item.token)) {
      warnings.push(createWarning(
        "orphan-assertion-token",
        `Assertion token "${item.value}" does not match any token written by fill steps in this file.`,
        item.path,
        { token: item.token },
      ));
    }
  });

  // v1.4 REQ-Z17: login expectations by model.
  // Old model (pre-v1.2.1): login lived in root `setup`, so a login `baseUrl`
  // without a setup login block meant the file could never authenticate.
  // Current model: login lives in `recovery.login` (usually inherited via
  // `extends`), and the runtime re-navigates to `baseUrl` before EVERY case — so
  // a login-page `baseUrl` puts every case on `/login`, which is exactly the
  // condition `recovery.login.detect` looks for. That used to buy a full re-login
  // per case; it is now gated by the live auth check, but the navigation is still
  // a wasted round-trip and the case no longer starts where it claims to. So the
  // advice inverts: point `baseUrl` at a business landing page and let recovery
  // fire only when the app really bounces you to `/login`.
  if (String(testFile.baseUrl || "").includes("/login") && hasBusinessSteps(testFile)) {
    const loginRecoveryKeys = findLoginRecoveryKeys(testFile.recovery);
    if (loginRecoveryKeys.length) {
      warnings.push(createWarning(
        "base-url-login-page",
        "baseUrl points at the login page while this file already declares login recovery " +
          `(recovery.${loginRecoveryKeys[0]}). Every case is re-navigated to baseUrl, so each one starts on ` +
          "/login and triggers the login detect for nothing. Point baseUrl at the business landing page the " +
          "cases actually need and let recovery fire only when the app really redirects to /login.",
        "baseUrl",
        { recoveryKeys: loginRecoveryKeys },
      ));
    } else if (!hasLoginBootstrap(testFile.setup?.steps || [])) {
      warnings.push(createWarning(
        "missing-login-bootstrap",
        "This file starts from a login URL and contains business steps, but it neither declares a login " +
          "recovery handler (recovery.login, normally inherited via extends) nor a root setup login bootstrap, " +
          "so it can never authenticate.",
        "setup.steps",
      ));
    }
  }
  return warnings;
}

// Recovery keys that handle "we are on the login page" — the conventional `login`
// key, plus any handler whose detect actually keys off a login URL/text (so a
// base file that names it `session` or `auth` is recognized too).
function findLoginRecoveryKeys(recovery) {
  const source = recovery && typeof recovery === "object" && !Array.isArray(recovery) ? recovery : {};
  return Object.entries(source)
    .filter(([key, handler]) => {
      if (!handler || typeof handler !== "object") {
        return false;
      }
      if (key === "login") {
        return true;
      }
      const detectText = JSON.stringify(handler.detect || {});
      return /login|signin|登录|登陆/i.test(detectText) && Array.isArray(handler.steps) && handler.steps.length > 0;
    })
    .map(([key]) => key);
}

function hasBusinessSteps(testFile) {
  let found = false;
  visitDeep({
    fixtures: testFile.fixtures,
    macros: testFile.macros,
    cases: testFile.cases,
  }, (value) => {
    if (found || typeof value !== "string") {
      return;
    }
    found = /创建任务|示例任务|看板|搜索|demo-|pageList|workflow/i.test(value);
  });
  return found;
}

function hasLoginBootstrap(steps) {
  const text = JSON.stringify(Array.isArray(steps) ? steps : []);
  return /账号登陆|账号|密码|登\s*录|loginName|password/i.test(text);
}

function stableWithoutUpdatedAt(value) {
  const normalized = normalizeTestFile(value);
  delete normalized.updatedAt;
  return JSON.stringify(normalized);
}

function collectUpdatedAtWarning(input, envelope, normalized) {
  if (!envelope.path) {
    return null;
  }
  try {
    const target = path.resolve(envelope.rootDir, envelope.path);
    const root = path.resolve(envelope.rootDir);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(target)) {
      return null;
    }
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    const existingNormalized = normalizeTestFile(existing);
    if (
      existingNormalized.updatedAt === normalized.updatedAt &&
      stableWithoutUpdatedAt(existing) !== stableWithoutUpdatedAt(input)
    ) {
      return createWarning(
        "updated-at-stale",
        "File content changed but updatedAt was not refreshed.",
        "updatedAt",
        { path: envelope.path },
      );
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function normalizeSnapshot(dryRun = {}) {
  if (!dryRun || typeof dryRun !== "object") {
    return null;
  }
  const snapshot = dryRun.snapshot && typeof dryRun.snapshot === "object" ? dryRun.snapshot : dryRun;
  const text = String(snapshot.text || "");
  const interactables = Array.isArray(snapshot.interactables) ? snapshot.interactables : [];
  if (!text && !interactables.length) {
    return null;
  }
  return {
    url: String(snapshot.url || ""),
    title: String(snapshot.title || ""),
    text,
    interactables,
  };
}

function matchSnapshotTarget(snapshot, target = {}) {
  if (!snapshot || !target || typeof target !== "object") {
    return null;
  }
  if (target.testId) {
    const needle = String(target.testId);
    const count = snapshot.text.includes(needle)
      ? 1
      : snapshot.interactables.filter((item) => JSON.stringify(item).includes(needle)).length;
    return { kind: "testId", value: needle, count };
  }
  const keys = ["role", "name", "text", "placeholder"];
  for (const key of keys) {
    if (!target[key]) {
      continue;
    }
    const needle = String(target[key]);
    const count = snapshot.interactables.filter((item) => {
      if (String(item[key] || "") === needle) {
        return true;
      }
      if (key === "name" || key === "text") {
        return String(item.text || "").includes(needle) || String(item.name || "").includes(needle);
      }
      return false;
    }).length || (key === "text" && snapshot.text.includes(needle) ? 1 : 0);
    return { kind: key, value: needle, count };
  }
  return null;
}

function collectDryRunWarnings(testFile, dryRun) {
  const snapshot = normalizeSnapshot(dryRun);
  if (!snapshot) {
    return { warnings: [], summary: null, candidates: [] };
  }
  const warnings = [];
  const candidates = [];
  let checkedCount = 0;
  const checkStep = (step, stepPath) => {
    if (!step || typeof step !== "object") {
      return;
    }
    const targetMatch = matchSnapshotTarget(snapshot, step.target);
    if (targetMatch) {
      checkedCount += 1;
      candidates.push({
        path: stepPath,
        stepId: step.id || null,
        target: targetMatch,
        samples: snapshot.interactables
          .filter((item) => JSON.stringify(item).includes(String(targetMatch.value)))
          .slice(0, 5),
      });
      if (targetMatch.count === 0) {
        warnings.push(createWarning(
          targetMatch.kind === "testId" ? "testid-never-rendered" : "dry-run-target-not-found",
          `${targetMatch.kind} "${targetMatch.value}" was not found in the dry-run snapshot.`,
          `${stepPath}.target.${targetMatch.kind}`,
          { target: targetMatch },
        ));
      } else if (targetMatch.count > 1) {
        warnings.push(createWarning(
          "dry-run-target-ambiguous",
          `${targetMatch.kind} "${targetMatch.value}" matched ${targetMatch.count} candidates in the dry-run snapshot.`,
          `${stepPath}.target.${targetMatch.kind}`,
          { target: targetMatch },
        ));
      }
    }
    const scopeTestId = step.expectation?.scope?.testId;
    if (scopeTestId) {
      checkedCount += 1;
      if (!snapshot.text.includes(String(scopeTestId)) && !snapshot.interactables.some((item) => JSON.stringify(item).includes(String(scopeTestId)))) {
        warnings.push(createWarning(
          "dry-run-target-not-found",
          `Expectation scope testId "${scopeTestId}" was not found in the dry-run snapshot.`,
          `${stepPath}.expectation.scope.testId`,
          { target: { kind: "testId", value: scopeTestId, count: 0 } },
        ));
      }
    }
  };
  (testFile.setup?.steps || []).forEach((step, index) => checkStep(step, `setup.steps[${index}]`));
  (testFile.cases || []).forEach((caseItem, caseIndex) => {
    (caseItem.steps || []).forEach((step, stepIndex) => checkStep(step, `cases[${caseIndex}].steps[${stepIndex}]`));
  });
  return {
    warnings,
    summary: {
      mode: dryRun.mode || "snapshot",
      source: dryRun.source || "",
      checkedCount,
      warningCount: warnings.length,
    },
    candidates,
  };
}

function parseCaseStepPath(issuePath = "") {
  const match = String(issuePath).match(/cases\[(\d+)\]\.steps\[(\d+)\]/);
  if (!match) {
    return null;
  }
  return { caseIndex: Number(match[1]), stepIndex: Number(match[2]) };
}

function allCaseSteps(testFile = {}) {
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

function enrichIssue(issue, testFile = {}, defaultSource = "static-analysis") {
  const parsed = parseCaseStepPath(issue.path);
  const caseIndex = Number.isInteger(issue.caseIndex) ? issue.caseIndex : parsed?.caseIndex;
  const stepIndex = Number.isInteger(issue.stepIndex) ? issue.stepIndex : parsed?.stepIndex;
  const caseItem = Number.isInteger(caseIndex) ? testFile.cases?.[caseIndex] : null;
  const step = caseItem && Number.isInteger(stepIndex) ? caseItem.steps?.[stepIndex] : null;
  return createRegisteredIssue(issue.code, {
    ...issue,
    severity: issue.severity,
    caseId: issue.caseId || caseItem?.id || null,
    caseName: issue.caseName || caseItem?.name || null,
    caseIndex,
    stepId: issue.stepId || step?.id || null,
    stepIndex,
    path: issue.path || "$",
    reason: issue.reason || issue.message,
    evidenceSource: issue.evidenceSource || defaultSource,
    evidenceConfidence: issue.evidenceConfidence,
  });
}

function createQualityIssue(code, entry, message, extras = {}) {
  return createRegisteredIssue(code, {
    severity: extras.severity,
    caseId: entry.caseItem.id,
    caseName: entry.caseItem.name,
    caseIndex: entry.caseIndex,
    stepId: entry.step.id || null,
    stepIndex: entry.stepIndex,
    path: extras.path || entry.path,
    message,
    reason: extras.reason || message,
    evidenceSource: extras.evidenceSource || "static-analysis",
    evidenceConfidence: extras.evidenceConfidence ?? 0.88,
    evidence: extras.evidence,
    suggestedPatch: extras.suggestedPatch,
  });
}

function hasTarget(step = {}) {
  const target = step.target || {};
  return Boolean(
    target.testId ||
      target.locator ||
      target.role ||
      target.name ||
      target.text ||
      target.placeholder ||
      target.ariaLabel ||
      target.title ||
      target.iconHint,
  );
}

function responseBodyPaths(expectation = {}) {
  if (!expectation || typeof expectation !== "object") {
    return [];
  }
  const own = Array.isArray(expectation.body) ? expectation.body.map((item) => item?.path).filter(Boolean) : [];
  const child = Array.isArray(expectation.assertions)
    ? expectation.assertions.flatMap(responseBodyPaths)
    : [];
  return [...own, ...child];
}

function collectAssertDomExpectations(expectation = {}, basePath = "expectation") {
  if (!expectation || typeof expectation !== "object") {
    return [];
  }
  const entries = [];
  if (expectationKind(expectation) === "assertDom") {
    entries.push({ expectation, path: basePath });
  }
  (Array.isArray(expectation.assertions) ? expectation.assertions : []).forEach((item, index) => {
    entries.push(...collectAssertDomExpectations(item, `${basePath}.assertions[${index}]`));
  });
  return entries;
}

function hasStableDomTarget(target = {}) {
  return Boolean(
    target?.testId ||
      target?.locator ||
      (target?.nearText && (target?.role || target?.name || target?.text)) ||
      target?.scope?.testId ||
      target?.scope?.locator ||
      target?.scope?.role ||
      target?.scope?.nearText,
  );
}

function collectRadioCheckedAssertionRisks(entry) {
  return collectAssertDomExpectations(entry.step.expectation || {}, `${entry.path}.expectation`)
    .filter(({ expectation }) =>
      expectation.property === "checked" &&
      String(expectation.target?.role || "").toLowerCase() === "radio" &&
      !hasStableDomTarget(expectation.target),
    )
    .map(({ expectation, path }) => createQualityIssue(
      "radio-checked-assertion-risk",
      entry,
      `Step ${entry.stepIndex + 1}: radio checked assertion uses role/name without a stable DOM target; RadioGroup-style controls often expose selection through the group value instead.`,
      {
        path: `${path}.target`,
        severity: "warning",
        evidence: {
          target: expectation.target,
          property: expectation.property,
          recommendation: "Prefer target.testId or locator on the radio group with property=value, or add a stable scope/locator for the concrete radio input.",
        },
      },
    ));
}

function expressionHasGlobalInputAssertion(step = {}) {
  const value = String(step.value || step.target?.value || step.query || "").trim();
  const expectation = step.expectation || {};
  const text = JSON.stringify(expectation);
  return value && text.includes(value) && !hasScopedExpectation(expectation);
}

// Kinds that never resolve a DOM/OCR locator. Kept in sync with the runtime's
// authoritative `needsTarget: false` actions (runtime/protocol/normalize.js
// ACTION_DEFINITIONS) plus schema-level aliases (navigate/useMacro/wait).
// Historically `openUrl` was missing here, which made precheck emit bogus
// `target-missing` / low-`locatorScore` blocking issues for every navigation
// step even though the runtime declares `openUrl:{needsTarget:false}`.
const NON_LOCATOR_STEP_KINDS = new Set([
  "assertUrl",
  "assertCount",
  "callApi",
  "capture",
  "navigate",
  "openUrl",
  "press",
  "reload",
  "goBack",
  "goForward",
  "scroll",
  "useMacro",
  "wait",
  "waitForText",
  "waitForNav",
  "waitForIdle",
  // v1.11: both take a plain CSS/testId (or a URL pattern), never a resolved locator.
  "routeFault",
  "assertLayout",
]);

function stepRequiresLocator(step = {}) {
  return !NON_LOCATOR_STEP_KINDS.has(getStepKind(step));
}

function proofWithFollowingEvidence(entry, testFile, proof) {
  if (!proof?.reasons?.includes("waitForChange only")) {
    return proof;
  }
  const steps = testFile.cases?.[entry.caseIndex]?.steps || [];
  for (let index = entry.stepIndex + 1; index < Math.min(steps.length, entry.stepIndex + 7); index += 1) {
    const nextStep = steps[index];
    if (getStepKind(nextStep) === "uploadFile") {
      continue;
    }
    const nextProof = scoreProof(nextStep);
    if (nextProof.score >= 55) {
      return {
        ...proof,
        score: nextProof.score,
        grade: nextProof.grade,
        reasons: [...proof.reasons, `follow-up evidence: ${nextStep.id || `step-${index + 1}`}`],
      };
    }
    break;
  }
  return proof;
}

function buildSuggestedTargetPatch(entry, target) {
  if (!target?.testId) {
    return null;
  }
  return {
    patchId: `patch-${entry.step.id || entry.stepIndex}-target-testid`,
    type: "safePatch",
    caseId: entry.caseItem.id,
    stepId: entry.step.id || null,
    confidence: 0.9,
    reason: "Use the verified testId as the stable target.",
    operations: [
      {
        op: "replace",
        path: `/${entry.path.replaceAll(".", "/")}/target`,
        selector: { caseId: entry.caseItem.id, stepId: entry.step.id || null, field: "target" },
        value: { testId: target.testId },
      },
    ],
    guards: [
      {
        path: `/${entry.path.replaceAll(".", "/")}/id`,
        equals: entry.step.id || null,
      },
    ],
    scoreImpact: { locatorScore: { from: "D", to: "A" } },
  };
}

function buildQuality(testFile, issues = []) {
  const steps = allCaseSteps(testFile).map((entry) => {
    const locator = stepRequiresLocator(entry.step)
      ? scoreLocator(entry.step)
      : { score: 100, grade: "A", reasons: ["action does not require a locator"] };
    const proof = proofWithFollowingEvidence(entry, testFile, scoreProof(entry.step));
    const isCritical = ["submit-create", "search-filter", "upload", "status-transition", "delete"].includes(proof.intent);
    return {
      caseId: entry.caseItem.id,
      caseName: entry.caseItem.name,
      stepId: entry.step.id || null,
      stepIndex: entry.stepIndex,
      path: entry.path,
      intent: proof.intent,
      intentSource: proof.intentSource,
      locatorScore: locator.score,
      locatorGrade: locator.grade,
      proofScore: proof.score,
      proofGrade: proof.grade,
      isCritical,
      locatorReasons: locator.reasons,
      proofReasons: proof.reasons,
    };
  });
  const average = (values) => values.length ? Math.round(values.reduce((sum, item) => sum + item, 0) / values.length) : 100;
  const locatorScore = average(steps.map((item) => item.locatorScore));
  const proofScore = average(steps.map((item) => item.proofScore));
  const blockingCount = issues.filter((item) => item.severity === "blocking").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const overall = blockingCount ? "blocked" : warningCount ? "warning" : "passed";
  return {
    summary: {
      overall,
      locatorScore,
      locatorGrade: scoreGrade(locatorScore),
      proofScore,
      proofGrade: scoreGrade(proofScore),
      recommendation: overall === "blocked" ? "do-not-run" : overall === "warning" ? "fix-before-run" : "run",
      blockingCount,
      warningCount,
      topRisks: issues.filter((item) => item.severity !== "info").slice(0, 5).map((item) => item.message),
    },
    steps,
  };
}

function collectQualityIssues(testFile) {
  const issues = [];
  allCaseSteps(testFile).forEach((entry) => {
    const { step } = entry;
    const requiresLocator = stepRequiresLocator(step);
    const locator = requiresLocator
      ? scoreLocator(step)
      : { score: 100, grade: "A", reasons: ["action does not require a locator"] };
    const proof = proofWithFollowingEvidence(entry, testFile, scoreProof(step));
    const isCritical = ["submit-create", "search-filter", "upload", "status-transition", "delete"].includes(proof.intent);
    if (requiresLocator && !hasTarget(step)) {
      issues.push(createQualityIssue("target-missing", entry, `Step ${entry.stepIndex + 1}: target is required for ${step.type || "this action"}.`, {
        severity: "blocking",
      }));
    }
    if (step.target?.iconHint && !step.target?.testId && !step.target?.ariaLabel && !step.target?.title && !step.target?.nearText && !step.target?.scope) {
      issues.push(createQualityIssue("icon-only-with-icon-hint-only", entry, `Step ${entry.stepIndex + 1}: icon-only target must include testId, ariaLabel, title, nearText, or scope.`, {
        path: `${entry.path}.target.iconHint`,
        severity: "blocking",
      }));
    }
    if (
      step.target?.text &&
      !step.target?.testId &&
      !step.target?.locator &&
      !step.target?.role &&
      !step.target?.scope &&
      proof.score < 55
    ) {
      issues.push(createQualityIssue("target-weak-text-only", entry, `Step ${entry.stepIndex + 1}: text-only target is weak; prefer testId, role+name, or target.scope.`, {
        path: `${entry.path}.target.text`,
        severity: locator.score < 40 ? "blocking" : "warning",
      }));
    }
    if ((step.target?.index != null || step.target?.selectorIndex != null) && !step.target?.testId) {
      issues.push(createQualityIssue("target-index-only", entry, `Step ${entry.stepIndex + 1}: index-based target should not be the primary locator.`, {
        path: `${entry.path}.target.index`,
        severity: "warning",
      }));
    }
    if (requiresLocator && isCritical && locator.score < 55) {
      issues.push(createQualityIssue("target-missing", entry, `Step ${entry.stepIndex + 1}: critical business step has locatorScore ${locator.score}, below C threshold.`, {
        severity: "blocking",
        evidence: { locator },
      }));
    } else if (requiresLocator && !isCritical && locator.score < 40) {
      issues.push(createQualityIssue("target-missing", entry, `Step ${entry.stepIndex + 1}: locatorScore ${locator.score} is too low.`, {
        severity: "blocking",
        evidence: { locator },
      }));
    }
    if (isCritical && proof.score < 55) {
      const code = proof.reasons.includes("waitForChange only") ? "wait-for-change-only-business-proof" : "search-global-assert-visible";
      issues.push(createQualityIssue(code, entry, `Step ${entry.stepIndex + 1}: critical business step has proofScore ${proof.score}, below C threshold.`, {
        path: `${entry.path}.expectation`,
        severity: proof.intentSource === "heuristic" ? "warning" : "blocking",
        evidenceSource: proof.intentSource === "heuristic" ? "heuristic" : "static-analysis",
        evidenceConfidence: proof.intentConfidence,
        evidence: { proof },
      }));
    }
    const kind = expectationKind(step.expectation || {});
    if ((kind === "networkResponse" || kind === "assertResponse") && !step.expectation?.urlIncludes && !step.expectation?.urlMatches && !step.expectation?.request?.url) {
      issues.push(createQualityIssue("network-response-url-missing", entry, `Step ${entry.stepIndex + 1}: ${kind} must include urlIncludes, urlMatches, or request.url.`, {
        path: `${entry.path}.expectation`,
        severity: "blocking",
      }));
    }
    responseBodyPaths(step.expectation).forEach((bodyPath, index) => {
      if (/^(id|data|result|body)$/i.test(String(bodyPath))) {
        issues.push(createQualityIssue("response-body-path-missing", entry, `Step ${entry.stepIndex + 1}: response body path "${bodyPath}" is too broad; use a concrete business field.`, {
          path: `${entry.path}.expectation.body[${index}].path`,
          severity: "warning",
        }));
      }
    });
    if (step.type === "assertDom" && step.target?.text && !step.target?.scope && !step.target?.testId && !step.target?.locator) {
      issues.push(createQualityIssue("assert-dom-table-row-scope-risk", entry, `Step ${entry.stepIndex + 1}: table/list DOM assertion should use scope plus hasText/hasTexts.`, {
        path: `${entry.path}.target.text`,
        severity: "warning",
      }));
    }
    issues.push(...collectRadioCheckedAssertionRisks(entry));
    if ((step.type === "fill" || step.type === "click") && expressionHasGlobalInputAssertion(step)) {
      issues.push(createQualityIssue("search-global-assert-visible", entry, `Step ${entry.stepIndex + 1}: assertion checks the input value globally; assert the result area instead.`, {
        path: `${entry.path}.expectation`,
        severity: "blocking",
      }));
    }
  });
  return issues;
}

// v1.5 Z-A: an allowlist entry without a `reason` is how the page-error gate
// gets muted permanently by accident. The rule is not "you may not mute" — it is
// "muting must say why", so that six months later somebody can tell a known AntD
// ResizeObserver warning apart from a real defect somebody wanted to stop seeing.
function collectGateSettingsIssues(testFile = {}) {
  const issues = [];
  const allowlist = testFile?.settings?.pageErrorAllowlist;
  const list = Array.isArray(allowlist) ? allowlist : allowlist ? [allowlist] : [];
  list.forEach((item, index) => {
    const match = typeof item === "string" ? item : String(item?.match ?? item?.pattern ?? item?.text ?? "");
    const reason = typeof item === "string" ? "" : String(item?.reason ?? "").trim();
    if (!match.trim() || reason) {
      return;
    }
    issues.push(
      createRegisteredIssue("page-error-allowlist-without-reason", {
        severity: "warning",
        path: `settings.pageErrorAllowlist[${index}]`,
        message:
          `settings.pageErrorAllowlist[${index}] 静音了页面报错 "${match.trim()}" 但没写 reason。` +
          "页面报错门是本版本唯一能抓到「输入即崩」这类缺陷的机制，静音必须留下依据（例如「AntD ResizeObserver 已知噪声」），" +
          "否则半年后没人分得清这是已知噪声还是有人不想看的真缺陷。",
        reason: "page-error allowlist entry has no reason",
        evidenceSource: "static-analysis",
        evidenceConfidence: 1,
      }),
    );
  });
  const policy = String(testFile?.settings?.pageErrorPolicy ?? "").trim().toLowerCase();
  if (policy === "off") {
    issues.push(
      createRegisteredIssue("page-error-allowlist-without-reason", {
        severity: "warning",
        path: "settings.pageErrorPolicy",
        message:
          'settings.pageErrorPolicy = "off" 关闭了页面报错门。报错仍会被记录（summary.pageErrors / diagnostics/page-errors.json），' +
          '但不再让用例变红——这意味着「页面在报错却绿灯」重新成为可能。过渡期请用 "warn"，并把公认噪声写进 allowlist（带 reason）。' +
          'v1.9 起还有更准的做法：pageErrorPolicy 支持按阶段设，例如 {"auth-bootstrap":"off","under-test":"fail"}——' +
          "只关掉登录过渡期，产品自身仍然被看着。",
        reason: "page-error gate disabled for this file",
        evidenceSource: "static-analysis",
        evidenceConfidence: 1,
      }),
    );
  }
  issues.push(...collectAllowlistBreadthIssues(testFile));
  return issues;
}

// v1.9 REQ-Z23-4/5: the "this entry is too broad" family.
//
// The failure mode this catches, verbatim from the 2026-08-26 round: to silence
// 40 login-page noise entries, the author had to write message substrings, and
// the only substrings that covered a whole family were generic words. Seven of
// them landed in the SHARED `common/demo-base.json`, in force for every 简易
// 打样 case:
//   "deprecated"                          — matches any message with the word
//   "Failed to fetch"                     — eats every product API fetch failure
//   "net::ERR_CONNECTION_CLOSED/REFUSED"  — eats the product backend going down
//   "portal.test.example.org"   — the product's OWN micro-frontend host
//   "Can't perform a React state update…" — eats a whole class of app bugs
// The author flagged the risk twice in her own session notes and shipped anyway,
// because the API shape gave her no alternative. It does now, so these warnings
// name what each entry will swallow and point at the field that fixes it.

// Words so common in framework noise that, alone, they also match product errors.
const GENERIC_ALLOWLIST_WORDS = [
  "deprecated",
  "warning",
  "error",
  "failed",
  "failure",
  "invalid",
  "unexpected",
  "cannot",
  "undefined",
  "null",
  "timeout",
  "network",
  "fetch",
  "react",
  "antd",
];
// Resource/transport-level messages: these never identify a *culprit*, only a
// symptom, so without a url+origin scope they mute the product and the CDN alike.
const RESOURCE_ALLOWLIST_PATTERNS = [
  "failed to fetch",
  "failed to load resource",
  "net::err_",
  "err_connection",
  "networkerror",
  "load failed",
  "xhr",
  "econnrefused",
];
const MIN_ALLOWLIST_MATCH_LENGTH = 18;

function isScopedAllowlistEntry(item) {
  return Boolean(item && typeof item === "object" && (item.url || item.origin || item.phase));
}

function readAllowlistMatch(item) {
  return typeof item === "string" ? item : String(item?.match ?? item?.pattern ?? item?.text ?? "");
}

// The host of the file's own baseUrl — an allowlist entry naming it is silencing
// the product under test, which is the single most dangerous shape in this family.
// Both `host` (with port) and `hostname` are returned: the round that produced
// this rule wrote the bare host (`portal.test.example.org`) with no port.
function readBaseUrlHosts(testFile = {}) {
  const raw = String(testFile?.baseUrl || "").trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = new URL(raw);
    return [parsed.host.toLowerCase(), parsed.hostname.toLowerCase()]
      .filter(Boolean)
      // `localhost` alone is too generic to accuse an entry over — a message
      // mentioning it is far more likely to be a dev-server URL in a stack trace.
      .filter((host) => host !== "localhost" && host !== "127.0.0.1")
      .filter((host, index, all) => all.indexOf(host) === index);
  } catch (_error) {
    return [];
  }
}

function collectAllowlistBreadthIssues(testFile = {}) {
  const issues = [];
  const allowlist = testFile?.settings?.pageErrorAllowlist;
  const list = Array.isArray(allowlist) ? allowlist : allowlist ? [allowlist] : [];
  const baseHosts = readBaseUrlHosts(testFile);
  list.forEach((item, index) => {
    const match = readAllowlistMatch(item).trim();
    const path = `settings.pageErrorAllowlist[${index}]`;
    const scoped = isScopedAllowlistEntry(item);
    const lower = match.toLowerCase();
    if (!match) {
      return; // a scope-only entry is the shape we WANT; nothing to warn about
    }

    // Z23-5: resource/transport matches must name where they come from.
    const resourceHit = RESOURCE_ALLOWLIST_PATTERNS.find((pattern) => lower.includes(pattern));
    if (resourceHit && !(item?.url && item?.origin)) {
      issues.push(
        createRegisteredIssue("page-error-allowlist-unscoped-resource", {
          severity: "warning",
          path,
          message:
            `${path} 用 "${match}" 静音资源/传输层报错，但没有同时给 url + origin 限定。` +
            "这类文案只描述症状、不指认来源：它会连带吞掉「被测产品自己的接口请求失败 / 后端挂了」——" +
            `正是最该变红的一类。请补上 {"url": "**/login", "origin": "third-party"} 这样的来源限定（命中 "${resourceHit}"）。`,
          reason: "resource-class allowlist entry has no url+origin scope",
          evidenceSource: "static-analysis",
          evidenceConfidence: 1,
          suggestedPatch: {
            op: "replace",
            path,
            value: { ...(typeof item === "object" ? item : { match }), url: "**/login", origin: "third-party" },
          },
        }),
      );
    }

    // Z23-4: a bare generic word, or a match so short it cannot be specific.
    const genericHit = GENERIC_ALLOWLIST_WORDS.find((word) => lower === word);
    if ((genericHit || match.length < MIN_ALLOWLIST_MATCH_LENGTH) && !scoped) {
      issues.push(
        createRegisteredIssue("page-error-allowlist-too-broad", {
          severity: "warning",
          path,
          message:
            `${path} 的 match "${match}" 过宽${genericHit ? "（是通用词表命中）" : `（不足 ${MIN_ALLOWLIST_MATCH_LENGTH} 字符）`}，` +
            "且没有任何 url/origin/phase 限定，会对本文件（以及引用了本共享库的所有用例）全局生效。" +
            `它会吞掉一切消息里含 "${match}" 的报错——包括被测产品自己抛的业务异常。` +
            '请改成带作用域的写法，例如 {"phase":"auth-bootstrap","origin":"third-party"}；' +
            "只想关掉登录过渡期噪声的话，直接用 settings.pageErrorPolicy 的 phase 形式，别写文本匹配。",
          reason: "allowlist match is too broad and unscoped",
          evidenceSource: "static-analysis",
          evidenceConfidence: genericHit ? 1 : 0.8,
          suggestedPatch: {
            op: "replace",
            path,
            value: {
              ...(typeof item === "object" ? item : { match }),
              phase: "auth-bootstrap",
              origin: "third-party",
            },
          },
        }),
      );
    }

    // Z23-4 (the worst shape): the entry names the product's own host.
    const sameOriginHit = baseHosts.find((host) => lower.includes(host));
    if (sameOriginHit) {
      issues.push(
        createRegisteredIssue("page-error-allowlist-same-origin", {
          severity: "warning",
          path,
          message:
            `${path} 的 match "${match}" 命中了被测产品自己的域 ${sameOriginHit}（本文件 baseUrl 同源）。` +
            "这等于宣布「被测产品自己报的错一律不算」——页面报错门对本文件基本失效。" +
            '如果真正想静音的是宿主页加载的第三方脚本，请改用 {"origin":"third-party"}（相对 baseUrl 判定），' +
            "而不是把产品域名写进 match。",
          reason: "allowlist entry matches the baseUrl host under test",
          evidenceSource: "static-analysis",
          evidenceConfidence: 1,
        }),
      );
    }
  });
  return issues;
}

function buildFingerprint(testFile) {
  const stepCount = (testFile.cases || []).reduce((sum, item) => sum + (item.steps?.length || 0), 0);
  return {
    schemaVersion: testFile.schemaVersion,
    testFileId: testFile.id || null,
    updatedAt: testFile.updatedAt || null,
    caseCount: (testFile.cases || []).length,
    stepCount,
    contentHash: hashObject(testFile),
  };
}

function collectPatchReviewIssues(envelope) {
  if (envelope.mode !== "patch-review") {
    return null;
  }
  const beforeRaw = envelope.before;
  const afterRaw = envelope.after || envelope.input;
  if (!beforeRaw || !afterRaw) {
    return {
      errors: [createRegisteredIssue("invalid-json", {
        severity: "blocking",
        message: "patch-review mode requires before and after JSON.",
        path: "$",
        evidenceSource: "schema",
      })],
      beforeResult: null,
      afterResult: null,
    };
  }
  const before = normalizeTestFile(beforeRaw);
  const after = normalizeTestFile(afterRaw);
  const beforeHash = hashObject(before);
  const beforeFingerprint = buildFingerprint(before);
  const errors = [];
  if (envelope.beforeHash && envelope.beforeHash !== beforeHash) {
    errors.push(createRegisteredIssue("patch-stale", {
      severity: "blocking",
      message: "beforeHash does not match the normalized before JSON.",
      path: "$.beforeHash",
      evidenceSource: "static-analysis",
      evidenceConfidence: 0.95,
      evidence: { expected: beforeHash, actual: envelope.beforeHash },
    }));
  }
  if (envelope.fileFingerprint?.contentHash && envelope.fileFingerprint.contentHash !== beforeFingerprint.contentHash) {
    errors.push(createRegisteredIssue("patch-stale", {
      severity: "blocking",
      message: "fileFingerprint.contentHash does not match the normalized before JSON.",
      path: "$.fileFingerprint.contentHash",
      evidenceSource: "static-analysis",
      evidenceConfidence: 0.95,
      evidence: { expected: beforeFingerprint.contentHash, actual: envelope.fileFingerprint.contentHash },
    }));
  }
  const beforeIssues = collectQualityIssues(before);
  const afterIssues = collectQualityIssues(after);
  const beforeQuality = buildQuality(before, beforeIssues);
  const afterQuality = buildQuality(after, afterIssues);
  if (afterQuality.summary.locatorScore < beforeQuality.summary.locatorScore) {
    errors.push(createRegisteredIssue("locator-regression", {
      severity: "blocking",
      message: "Patch lowers locatorScore.",
      path: "$.after",
      evidenceSource: "static-analysis",
      evidenceConfidence: 0.95,
      evidence: { before: beforeQuality.summary.locatorScore, after: afterQuality.summary.locatorScore },
    }));
  }
  if (afterQuality.summary.proofScore < beforeQuality.summary.proofScore) {
    errors.push(createRegisteredIssue("proof-regression", {
      severity: "blocking",
      message: "Patch lowers proofScore.",
      path: "$.after",
      evidenceSource: "static-analysis",
      evidenceConfidence: 0.95,
      evidence: { before: beforeQuality.summary.proofScore, after: afterQuality.summary.proofScore },
    }));
  }
  return {
    errors,
    beforeResult: { normalized: before, quality: beforeQuality, fingerprint: beforeFingerprint, beforeHash },
    afterResult: { normalized: after, quality: afterQuality, fingerprint: buildFingerprint(after), contentHash: hashObject(after) },
  };
}

function collectAppContractIssues(envelope, normalized) {
  const contract = envelope.appContract;
  if (!contract) {
    return [];
  }
  const issues = [];
  const now = Date.now();
  const confidence = Number(contract.confidence);
  if (Number.isFinite(confidence) && confidence < 0.7) {
    issues.push(createRegisteredIssue("app-contract-low-confidence", {
      severity: "warning",
      message: `App contract confidence ${confidence} is below 0.7.`,
      path: "$.appContract.confidence",
      evidenceSource: "app-contract",
      evidenceConfidence: Math.max(0, confidence),
    }));
  }
  if (contract.verifiedAt && contract.staleAfterDays) {
    const verifiedAt = Date.parse(contract.verifiedAt);
    if (Number.isFinite(verifiedAt) && now - verifiedAt > Number(contract.staleAfterDays) * 86400000) {
      issues.push(createRegisteredIssue("app-contract-stale", {
        severity: "warning",
        message: "App contract is older than staleAfterDays.",
        path: "$.appContract.verifiedAt",
        evidenceSource: "app-contract",
        evidenceConfidence: 0.9,
      }));
    }
  }
  const route = contract.route || contract.routes?.[0]?.path;
  const base = normalized.baseUrl || envelope.dryRun?.snapshot?.url || envelope.dryRun?.url || "";
  if (route && base && !String(base).includes(route)) {
    issues.push(createRegisteredIssue("app-contract-version-mismatch", {
      severity: "warning",
      message: `App contract route "${route}" does not match base URL "${base}".`,
      path: "$.appContract.route",
      evidenceSource: "app-contract",
      evidenceConfidence: 0.82,
    }));
  }
  const seenTestIds = new Map();
  const entries = [
    ...(contract.controls || []),
    ...(contract.scopes || []),
    ...(contract.tables || []),
    ...(contract.proofSignals || []),
  ];
  entries.forEach((item) => {
    const id = item?.testId;
    if (!id) return;
    const signature = item.action || item.type || item.description || item.name || "";
    if (seenTestIds.has(id) && seenTestIds.get(id) !== signature) {
      issues.push(createRegisteredIssue("app-contract-conflict", {
        severity: "blocking",
        message: `App contract testId "${id}" maps to multiple meanings.`,
        path: "$.appContract",
        evidenceSource: "app-contract",
        evidenceConfidence: 0.9,
      }));
    }
    seenTestIds.set(id, signature);
  });
  return issues;
}

function precheckTestFile(raw) {
  let normalized;
  let input;
  let envelope;
  let dryRunSummary = null;
  let dryRunCandidates = [];
  try {
    envelope = normalizeEnvelope(raw);
    const patchReview = collectPatchReviewIssues(envelope);
    if (patchReview) {
      const issues = patchReview.errors;
      const blocked = issues.some((item) => item.severity === "blocking");
      return {
        ok: !blocked,
        blocked,
        mode: "patch-review",
        summary: {
          errorCount: issues.length,
          warningCount: 0,
          caseCount: patchReview.afterResult?.normalized?.cases?.length || 0,
          stepCount: patchReview.afterResult?.quality?.steps?.length || 0,
        },
        errors: issues.map((item) => ({ ...item, severity: "error" })),
        warnings: [],
        issues,
        quality: patchReview.afterResult?.quality || null,
        patchReview: {
          beforeHash: patchReview.beforeResult?.beforeHash || null,
          fileFingerprint: patchReview.beforeResult?.fingerprint || null,
          beforeQuality: patchReview.beforeResult?.quality || null,
          afterQuality: patchReview.afterResult?.quality || null,
        },
        schema: buildSchema(),
      };
    }
    input = resolveTestFileReferences(envelope.input, {
      rootDir: envelope.rootDir,
      sourcePath: envelope.path,
    });
    normalized = normalizeTestFile(input);
  } catch (error) {
    const isReferenceError = typeof error?.code === "string" && error.code.includes("reference");
    return {
      ok: false,
      summary: {
        errorCount: 1,
        warningCount: 0,
        caseCount: 0,
        stepCount: 0,
      },
      errors: [
        {
          code: isReferenceError ? error.code : "invalid-json",
          severity: "error",
          message: error?.message || String(error),
          path: error?.refPath || "$",
        },
      ],
      warnings: [],
      issues: [createRegisteredIssue(isReferenceError ? error.code : "invalid-json", {
        severity: "blocking",
        message: error?.message || String(error),
        path: error?.refPath || "$",
        evidenceSource: "schema",
      })],
      blocked: true,
      mode: "advisory",
      schema: buildSchema(),
    };
  }

  const v110 = collectV110AuthoringChecks(input);
  const errors = [
    ...collectScaffoldErrors(input),
    ...collectShadowedNestedExpectationErrors(normalized),
    ...v110.errors,
    ...collectV111AuthoringChecks(input).errors,
  ];
  const warnings = [
    ...v110.warnings,
    ...collectSemanticWarnings(normalized, input),
    ...collectAuthoringQualityWarnings(normalized),
  ];
  const updatedAtWarning = collectUpdatedAtWarning(input, envelope, normalized);
  if (updatedAtWarning) {
    warnings.push(updatedAtWarning);
  }
  const dryRunResult = collectDryRunWarnings(normalized, envelope.dryRun);
  if (dryRunResult.summary) {
    dryRunSummary = dryRunResult.summary;
    dryRunCandidates = dryRunResult.candidates || [];
    warnings.push(...dryRunResult.warnings);
  }
  normalized.cases.forEach((caseItem, caseIndex) => {
    const longCaseWarning = createLongCaseWarning(caseItem, caseIndex);
    if (longCaseWarning) {
      warnings.push(longCaseWarning);
    }
    const draft = testFileToRuntimeDraft(normalized, caseItem.id);
    validateDraft(draft).forEach((message, index) => {
      errors.push(createError(message, caseItem, caseIndex, index));
    });
    getDraftWarnings(draft).forEach((warning) => {
      warnings.push(decorateIssue(warning, caseItem, caseIndex));
    });
  });

  const stepCount = normalized.cases.reduce((sum, caseItem) => sum + (caseItem.steps?.length || 0), 0);
  const qualityIssues = collectQualityIssues(normalized);
  const appContractIssues = collectAppContractIssues(envelope, normalized);
  // v1.5 Z-H: weak-oracle / discriminative-power checks. Kept in their own module
  // (and their own list) because they answer a different question from the rest of
  // the precheck: not "is this assertion missing or malformed" but "can it fail".
  const discriminationIssues = collectDiscriminationIssues(normalized);
  // v1.5 Z-A: settings-level gate hygiene.
  const gateSettingsIssues = collectGateSettingsIssues(normalized);
  const issues = [
    ...errors.map((item) => enrichIssue(item, normalized, "schema")),
    ...warnings.map((item) => enrichIssue(item, normalized, item.code?.startsWith("dry-run") || item.code === "testid-never-rendered" ? "dry-run-snapshot" : "static-analysis")),
    ...qualityIssues,
    ...appContractIssues,
    ...discriminationIssues,
    ...gateSettingsIssues,
  ];
  const quality = buildQuality(normalized, issues);
  const blocked = issues.some((item) => item.severity === "blocking");
  const suggestedPatches = issues.flatMap((issue) => issue.suggestedPatch ? [issue.suggestedPatch] : []);
  const fixHints = issues
    .filter((issue) => issue.severity !== "info")
    .slice(0, 8)
    .map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.reason,
      category: issue.category,
    }));
  return {
    ok: errors.length === 0,
    blocked,
    mode: envelope.mode,
    summary: {
      errorCount: errors.length,
      warningCount: warnings.length,
      blockingCount: issues.filter((item) => item.severity === "blocking").length,
      issueCount: issues.length,
      caseCount: normalized.cases.length,
      stepCount,
    },
    normalized: {
      schemaVersion: normalized.schemaVersion,
      id: normalized.id,
      name: normalized.name,
      group: normalized.group,
      caseCount: normalized.cases.length,
      stepCount,
      contentHash: hashObject(normalized),
      fileFingerprint: buildFingerprint(normalized),
    },
    errors,
    warnings,
    issues,
    quality,
    suggestedPatches,
    fixHints,
    schema: buildSchema(),
    ...(dryRunSummary ? { dryRun: { ...dryRunSummary, candidates: dryRunCandidates } } : {}),
  };
}

function buildSchema() {
  return {
    target: {
      scope: TARGET_SCOPE_SCHEMA,
    },
    expectation: {
      scope: EXPECTATION_SCOPE_SCHEMA,
      assertDom: ASSERT_DOM_SCHEMA,
      response: RESPONSE_ASSERTION_SCHEMA,
    },
    actions: {
      callApi: CALL_API_SCHEMA,
      useMacro: SCAFFOLD_SCHEMA.useMacro,
    },
    scaffold: SCAFFOLD_SCHEMA,
    vars: VARS_SCHEMA,
  };
}

module.exports = {
  EXPECTATION_SCOPE_SCHEMA,
  TARGET_SCOPE_SCHEMA,
  ASSERT_DOM_SCHEMA,
  RESPONSE_ASSERTION_SCHEMA,
  CALL_API_SCHEMA,
  VARS_SCHEMA,
  SCAFFOLD_SCHEMA,
  LONG_CASE_STEP_WARNING_THRESHOLD,
  LONG_CASE_STEP_STRONG_WARNING_THRESHOLD,
  buildFingerprint,
  buildQuality,
  buildSchema,
  collectQualityIssues,
  precheckTestFile,
};
