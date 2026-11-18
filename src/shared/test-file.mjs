import { draftToRuntimePayload, runtimePayloadToDraft } from "../panel/lib/payload-draft.mjs";

export const DEFAULT_CASE = {
  id: "case-login",
  name: "登录进入工作台",
  description: "",
  tags: [],
  priority: "P0",
  fixtures: [],
  steps: [],
};

export const DEFAULT_TEST_FILE = {
  schemaVersion: 2,
  id: "login-workbench",
  name: "登录工作台",
  group: "",
  baseUrl: "http://127.0.0.1:32148/",
  description: "",
  tags: [],
  requirement: {
    name: "",
    version: "",
    owner: "",
    module: "",
    description: "",
  },
  setup: {
    steps: [],
  },
  teardown: {
    steps: [],
    alwaysRun: true,
  },
  fixtures: {},
  macros: {},
  recovery: {},
  cases: [DEFAULT_CASE],
  settings: {
    evidence: true,
    evidenceProfile: "debug",
  },
};

export function slugify(value, fallback = "test-file") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;|\r?\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeTimestamp(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeEvidenceProfile(value, fallback = "debug") {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["debug", "fast", "turbo"].includes(text)) {
    return text;
  }
  return fallback;
}

function normalizeRequirement(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    name: String(source.name || ""),
    version: String(source.version || ""),
    owner: String(source.owner || ""),
    module: String(source.module || ""),
    description: String(source.description || ""),
  };
}

export function normalizeVars(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, item]) => [String(key || "").trim(), item == null ? "" : String(item)])
      .filter(([key]) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(key)),
  );
}

function normalizeStepGroup(value = {}) {
  if (Array.isArray(value)) {
    return {
      steps: clone(value),
    };
  }
  const source = value && typeof value === "object" ? value : {};
  return {
    ...clone(source),
    steps: Array.isArray(source.steps) ? clone(source.steps) : [],
  };
}

function normalizeFixtureMap(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([name, fixture]) => {
        const normalized = fixture && typeof fixture === "object" && !Array.isArray(fixture) ? fixture : {};
        return [
          String(name).trim(),
          {
            ...clone(normalized),
            setup: Array.isArray(normalized.setup)
              ? clone(normalized.setup)
              : Array.isArray(normalized.setup?.steps)
                ? clone(normalized.setup.steps)
                : [],
            teardown: Array.isArray(normalized.teardown)
              ? clone(normalized.teardown)
              : Array.isArray(normalized.teardown?.steps)
                ? clone(normalized.teardown.steps)
                : [],
          },
        ];
      })
      .filter(([name]) => name),
  );
}

function normalizeMacroMap(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([name, macro]) => [
        String(name).trim(),
        normalizeStepGroup(macro),
      ])
      .filter(([name]) => name),
  );
}

// Recovery handlers ("problem -> fix steps" map). Mirror of test-file.js so the
// panel preserves `recovery` on save/normalize. See test-file.js for the model.
function normalizeRecoveryMap(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([name, handler]) => {
        const normalized = handler && typeof handler === "object" && !Array.isArray(handler) ? handler : {};
        const steps = Array.isArray(normalized.steps)
          ? clone(normalized.steps)
          : Array.isArray(normalized.steps?.steps)
            ? clone(normalized.steps.steps)
            : [];
        const maxAttempts = Number.isFinite(Number(normalized.maxAttempts)) && Number(normalized.maxAttempts) > 0
          ? Math.min(5, Math.floor(Number(normalized.maxAttempts)))
          : 1;
        return [
          String(name).trim(),
          {
            ...clone(normalized),
            detect: normalized.detect && typeof normalized.detect === "object" && !Array.isArray(normalized.detect)
              ? clone(normalized.detect)
              : null,
            steps,
            resume: normalized.resume === "restartCase" ? "restartCase" : "continue",
            reactive: normalized.reactive == null ? true : Boolean(normalized.reactive),
            maxAttempts,
          },
        ];
      })
      .filter(([name]) => name),
  );
}

export function normalizeCase(raw = {}, index = 0) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fallbackName = index === 0 ? "默认用例" : `用例 ${index + 1}`;
  const name = String(source.name || fallbackName).trim() || fallbackName;
  return {
    id: slugify(source.id || name, `case-${index + 1}`),
    name,
    description: String(source.description || ""),
    tags: normalizeStringArray(source.tags),
    priority: String(source.priority || "P1").trim() || "P1",
    fixtures: normalizeStringArray(source.fixtures),
    // v1.5 Z-D/Z-K: keep the case's QA lineage (facets / RED injection). Mirrors
    // `test-file.js`; dropping it here would make the panel silently strip the
    // declaration a headless run then cannot report.
    ...(source.qaTrace && typeof source.qaTrace === "object" && !Array.isArray(source.qaTrace)
      ? { qaTrace: clone(source.qaTrace) }
      : {}),
    // v1.6 Z-J: the cross-entry consistency declaration. Same reasoning as
    // `qaTrace` above — it is a case-level contract the executor expands, so
    // normalization must not eat it.
    ...(source.consistencyGroup && typeof source.consistencyGroup === "object" && !Array.isArray(source.consistencyGroup)
      ? { consistencyGroup: clone(source.consistencyGroup) }
      : {}),
    // v1.6 Z-F: run this case as a specific identity. Preserved for the same
    // reason as the two above — the session layer reads it, and a normalization
    // that ate it would silently run the "restricted account" case as an admin.
    ...(source.authProfile ? { authProfile: String(source.authProfile).trim() } : {}),
    steps: Array.isArray(source.steps) ? clone(source.steps) : [],
  };
}

function normalizeCases(source) {
  if (Array.isArray(source.cases) && source.cases.length) {
    return source.cases.map((item, index) => normalizeCase(item, index));
  }
  if (Array.isArray(source.steps)) {
    return [normalizeCase({ id: "default-case", name: "默认用例", steps: source.steps }, 0)];
  }
  return [normalizeCase(DEFAULT_CASE, 0)];
}

export function normalizeTestFile(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const name = String(source.name || DEFAULT_TEST_FILE.name).trim() || DEFAULT_TEST_FILE.name;
  const id = slugify(source.id || name, DEFAULT_TEST_FILE.id);
  const createdAt = normalizeTimestamp(source.createdAt);
  const updatedAt = normalizeTimestamp(source.updatedAt);
  return {
    schemaVersion: 2,
    id,
    name,
    ...(source.extends ? { extends: String(source.extends).trim() } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    group: String(source.group || "").trim(),
    baseUrl: String(source.baseUrl || "").trim(),
    description: String(source.description || ""),
    tags: normalizeStringArray(source.tags),
    vars: normalizeVars(source.vars),
    requirement: normalizeRequirement(source.requirement),
    setup: normalizeStepGroup(source.setup),
    teardown: {
      ...normalizeStepGroup(source.teardown),
      alwaysRun: source.teardown?.alwaysRun == null ? true : Boolean(source.teardown.alwaysRun),
    },
    fixtures: normalizeFixtureMap(source.fixtures),
    macros: normalizeMacroMap(source.macros),
    recovery: normalizeRecoveryMap(source.recovery),
    cases: normalizeCases(source),
    settings: {
      evidence: source.settings?.evidence == null ? true : Boolean(source.settings.evidence),
      evidenceProfile: normalizeEvidenceProfile(source.settings?.evidenceProfile),
      ...Object.fromEntries(
        Object.entries(source.settings || {}).filter(([key]) => key !== "evidence" && key !== "evidenceProfile"),
      ),
    },
  };
}

function getStepKind(step = {}) {
  return step.type || step.kind || step.action || "";
}

function getMacroName(step = {}) {
  return String(step.macro || step.macroName || step.name || step.ref || "").trim();
}

function tagExecutableStep(step, meta, fallbackId) {
  const tagged = {
    ...clone(step),
    phase: meta.phase,
  };
  if (meta.sourceFixture) {
    tagged.sourceFixture = meta.sourceFixture;
  }
  if (meta.sourceMacro) {
    tagged.sourceMacro = meta.sourceMacro;
  }
  if (!tagged.id) {
    tagged.id = fallbackId;
  }
  return tagged;
}

function createMacroStepId(macroName, step, localIndex, invocation) {
  const base = step.id || `step-${localIndex + 1}`;
  return `${macroName}::${base}::${invocation}`;
}

function expandSteps(steps, context) {
  const output = [];
  const sourceSteps = Array.isArray(steps) ? steps : [];
  sourceSteps.forEach((step, index) => {
    const kind = getStepKind(step);
    if (kind === "useMacro") {
      const macroName = getMacroName(step);
      const macro = context.macros[macroName];
      if (!macro) {
        throw new Error(`Macro "${macroName || "(missing)"}" is not defined.`);
      }
      if (context.stack.includes(macroName)) {
        throw new Error(`Macro cycle detected: ${[...context.stack, macroName].join(" -> ")}.`);
      }
      if (context.stack.length >= context.maxDepth) {
        throw new Error(`Macro nesting exceeds ${context.maxDepth} levels.`);
      }
      const invocation = (context.macroInvocations[macroName] || 0) + 1;
      context.macroInvocations[macroName] = invocation;
      const expanded = expandSteps(macro.steps, {
        ...context,
        stack: [...context.stack, macroName],
      });
      expanded.forEach((macroStep, macroStepIndex) => {
        output.push({
          ...macroStep,
          id: createMacroStepId(macroName, macroStep, macroStepIndex, invocation),
          sourceMacro: macroStep.sourceMacro || macroName,
        });
      });
      return;
    }
    output.push(tagExecutableStep(step, context.meta, step.id || `${context.meta.phase}-${index + 1}`));
  });
  return output;
}

function getCaseStepRange(steps = [], options = {}) {
  const total = Array.isArray(steps) ? steps.length : 0;
  const startNumber = Number.parseInt(options.caseStepStartIndex, 10);
  const endNumber = Number.parseInt(options.caseStepEndIndex, 10);
  const startIndex = Number.isFinite(startNumber) ? Math.max(0, startNumber - 1) : 0;
  const endIndex = Number.isFinite(endNumber) ? Math.min(total, Math.max(startIndex + 1, endNumber)) : total;
  return {
    startIndex: Math.min(startIndex, total),
    endIndex,
  };
}

export function buildExecutableCaseSteps(testFile, selectedCaseId = null, options = {}) {
  const normalized = normalizeTestFile(testFile);
  const selectedCase = getSelectedCase(normalized, selectedCaseId);
  const macros = normalized.macros || {};
  const macroInvocations = {};
  const expand = (steps, meta) => expandSteps(steps, {
    macros,
    macroInvocations,
    stack: [],
    maxDepth: options.maxMacroDepth || 5,
    meta,
  });

  if (options.stepId) {
    const targetPhase = options.stepPhase || options.phase || "case";
    const targetFixture = options.sourceFixture || "";
    if (targetPhase === "fixtureSetup" || targetPhase === "fixtureTeardown") {
      const groupKey = targetPhase === "fixtureTeardown" ? "teardown" : "setup";
      const fixtureNames = targetFixture ? [targetFixture] : selectedCase.fixtures;
      for (const fixtureName of fixtureNames) {
        const fixture = normalized.fixtures[fixtureName];
        if (!fixture) {
          continue;
        }
        const targetIndex = (fixture[groupKey] || []).findIndex((step) => step.id === options.stepId);
        if (targetIndex >= 0) {
          return expand([fixture[groupKey][targetIndex]], { phase: targetPhase, sourceFixture: fixtureName });
        }
      }
      return [];
    }
    const targetIndex = (selectedCase.steps || []).findIndex((step) => step.id === options.stepId);
    if (targetIndex < 0) {
      return [];
    }
    return expand([selectedCase.steps[targetIndex]], { phase: "case" });
  }

  const steps = [];
  if (options.includeRootSetup !== false) {
    steps.push(...expand(normalized.setup.steps, { phase: "setup" }));
  }
  if (options.includeFixtureSetup !== false) {
    selectedCase.fixtures.forEach((fixtureName) => {
      const fixture = normalized.fixtures[fixtureName];
      if (!fixture) {
        throw new Error(`Fixture "${fixtureName}" is not defined.`);
      }
      steps.push(...expand(fixture.setup, { phase: "fixtureSetup", sourceFixture: fixtureName }));
    });
  }
  if (options.includeCaseSteps !== false) {
    const caseStepRange = getCaseStepRange(selectedCase.steps, options);
    steps.push(...expand((selectedCase.steps || []).slice(caseStepRange.startIndex, caseStepRange.endIndex), { phase: "case" }));
  }
  if (options.includeFixtureTeardown !== false) {
    selectedCase.fixtures.forEach((fixtureName) => {
      const fixture = normalized.fixtures[fixtureName];
      if (!fixture) {
        throw new Error(`Fixture "${fixtureName}" is not defined.`);
      }
      steps.push(...expand(fixture.teardown, { phase: "fixtureTeardown", sourceFixture: fixtureName }));
    });
  }
  if (options.includeRootTeardown !== false) {
    steps.push(...expand(normalized.teardown.steps, { phase: "teardown" }));
  }
  return steps;
}

export function createCaseDraft(overrides = {}) {
  return normalizeCase({
    ...DEFAULT_CASE,
    ...overrides,
  });
}

export function createTestFileDraft(overrides = {}) {
  return normalizeTestFile({
    ...DEFAULT_TEST_FILE,
    ...overrides,
    requirement: {
      ...DEFAULT_TEST_FILE.requirement,
      ...(overrides.requirement || {}),
    },
    settings: {
      ...DEFAULT_TEST_FILE.settings,
      ...(overrides.settings || {}),
    },
  });
}

export function getSelectedCaseId(testFile, selectedCaseId = null) {
  const normalized = normalizeTestFile(testFile);
  if (selectedCaseId && normalized.cases.some((item) => item.id === selectedCaseId)) {
    return selectedCaseId;
  }
  return normalized.cases[0]?.id || null;
}

export function getSelectedCase(testFile, selectedCaseId = null) {
  const normalized = normalizeTestFile(testFile);
  const nextCaseId = getSelectedCaseId(normalized, selectedCaseId);
  return normalized.cases.find((item) => item.id === nextCaseId) || normalized.cases[0] || normalizeCase(DEFAULT_CASE, 0);
}

export function testFileToRuntimeDraft(testFile, selectedCaseId = null) {
  const selectedCase = getSelectedCase(testFile, selectedCaseId);
  return runtimePayloadToDraft(clone(selectedCase.steps || []));
}

export function runtimeDraftToTestFile(draft, current = {}, selectedCaseId = null) {
  const normalized = normalizeTestFile(current);
  const targetCaseId = getSelectedCaseId(normalized, selectedCaseId);
  const payload = draftToRuntimePayload(draft);
  const steps = Array.isArray(payload) ? payload : payload && Object.keys(payload).length ? [payload] : [];
  return normalizeTestFile({
    ...normalized,
    cases: normalized.cases.map((item) =>
      item.id === targetCaseId
        ? {
            ...item,
            steps: clone(steps),
          }
        : item,
    ),
  });
}

export function buildTestFileName(name) {
  return `${slugify(name)}.json`;
}

export function isSafeRelativeTestFilePath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  if (value.includes("\0") || value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => part !== "." && part !== "..") && value.toLowerCase().endsWith(".json");
}
