const { computeImageDiff } = require("../perception/image-diff");
const { readDomStateWithAdapters } = require("../executor/adapters");
const {
  CANONICAL_OPERATORS,
  normalizeAssertionOperator,
} = require("../../src/shared/assertion-operators");

function normalizeTexts(value) {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => (typeof item === "string" ? item.trim() : String(item ?? "").trim()))
    .filter(Boolean);
}

function normalizeExpectationTexts(expectation = {}) {
  return normalizeTexts(
    expectation.texts ??
      expectation.text ??
      expectation.query ??
      expectation.queries,
  );
}

function normalizeScope(scope = {}) {
  const source = scope && typeof scope === "object" ? scope : {};
  const normalized = {
    nearText: typeof source.nearText === "string" ? source.nearText.trim() : "",
    role: typeof source.role === "string" ? source.role.trim() : "",
    locator: typeof source.locator === "string" ? source.locator.trim() : "",
    testId: typeof source.testId === "string" ? source.testId.trim() : "",
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function escapeCssString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isXPathLocator(locator) {
  return locator.startsWith("//") || locator.startsWith("(//") || locator.startsWith("xpath=");
}

function buildRawLocator(root, locator) {
  if (isXPathLocator(locator)) {
    return root.locator(locator.startsWith("xpath=") ? locator : `xpath=${locator}`);
  }
  return root.locator(locator);
}

function buildTestIdSelector(testId) {
  const value = escapeCssString(testId);
  return `[data-testid="${value}"], [data-test-id="${value}"], [data-cy="${value}"]`;
}

function buildScopeBaseLocator(page, scope = {}) {
  const source = scope && typeof scope === "object" ? scope : {};
  let base = null;
  if (source.locator) {
    base = buildRawLocator(page, source.locator);
  } else if (source.testId) {
    base = page.locator(buildTestIdSelector(source.testId));
  } else if (source.role) {
    base = page.getByRole(source.role);
  } else if (source.nearText) {
    base = page.locator("main, section, article, form, [role], .ant-modal, .ant-modal-content, .ant-drawer, .ant-drawer-content, .modal, .dialog, div");
  }
  if (base && source.nearText) {
    return base.filter({ hasText: source.nearText });
  }
  return base;
}

// v1.10 Z28-2: one operator vocabulary for every assertion kind (see
// src/shared/assertion-operators.js). `null` means "no such operator": the
// comparison fails and callers report it as `unsupported-operator` instead of
// the pre-v1.10 silent fallback to equals.
function normalizeCountOperator(value) {
  return normalizeAssertionOperator(value);
}

// A JS number on one side and a numeric string on the other compare as numbers
// (an interpolated `{{expected}}` is always a string; a JSON body field is
// often a number — `"0"` vs `0` used to be unequal). Two strings are never
// coerced: `"0012"` and `"12"` are different identifiers.
function toNumberIfMixed(actual, expected) {
  const isNumericString = (value) => typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.trim()));
  const asNumber = (value) => (typeof value === "number" ? value : Number(String(value).trim()));
  const actualIsNumber = typeof actual === "number" && Number.isFinite(actual);
  const expectedIsNumber = typeof expected === "number" && Number.isFinite(expected);
  if ((actualIsNumber || isNumericString(actual)) && (expectedIsNumber || isNumericString(expected)) && (actualIsNumber || expectedIsNumber)) {
    return { actual: asNumber(actual), expected: asNumber(expected) };
  }
  return null;
}

function valuesEqual(actual, expected) {
  if (actual === expected) {
    return true;
  }
  const numeric = toNumberIfMixed(actual, expected);
  if (numeric) {
    return numeric.actual === numeric.expected;
  }
  // A boolean field asserted with an interpolated "true"/"false".
  if (typeof actual === "boolean" && typeof expected === "string") {
    return String(actual) === expected.trim();
  }
  if (typeof expected === "boolean" && typeof actual === "string") {
    return String(expected) === actual.trim();
  }
  return false;
}

function compareOrdered(actual, expected, compare) {
  const numeric = toNumberIfMixed(actual, expected);
  if (numeric) {
    return compare(numeric.actual, numeric.expected);
  }
  return compare(actual, expected);
}

function compareValues(actual, expected, operator) {
  return compareTextValue(actual, expected, operator);
}

function compareTextValue(actual, expected, operator) {
  switch (normalizeAssertionOperator(operator)) {
    case "equals":
      return valuesEqual(actual, expected);
    case "notEquals":
      return !valuesEqual(actual, expected);
    case "greaterThan":
      return compareOrdered(actual, expected, (a, b) => a > b);
    case "atLeast":
      return compareOrdered(actual, expected, (a, b) => a >= b);
    case "lessThan":
      return compareOrdered(actual, expected, (a, b) => a < b);
    case "atMost":
      return compareOrdered(actual, expected, (a, b) => a <= b);
    case "contains":
      return String(actual ?? "").includes(String(expected ?? ""));
    case "notContains":
      return !String(actual ?? "").includes(String(expected ?? ""));
    case "matches":
      try {
        return new RegExp(String(expected ?? "")).test(String(actual ?? ""));
      } catch (_error) {
        return false;
      }
    case "exists":
      return actual != null && actual !== "";
    case "notExists":
      return actual == null || actual === "";
    // Z08: before/after diff operators. Combined with saveAs (which snapshots a
    // field/region value into a runtime variable), these let a case read a value
    // back and assert it against the earlier snapshot — e.g. "after changing 款式
    // 条件, verify 已录尺寸 was NOT silently cleared" via operator=unchanged,
    // expected={{savedSizes}}. `changed`/`unchanged` compare trimmed text;
    // `increased`/`decreased` compare the numeric portion (so labeled counts like
    // "共 132 条" diff correctly).
    case "changed":
      return String(actual ?? "").trim() !== String(expected ?? "").trim();
    case "unchanged":
      return String(actual ?? "").trim() === String(expected ?? "").trim();
    case "increased":
    case "decreased": {
      const actualNumber = Number(String(actual ?? "").replace(/[^0-9.-]/g, ""));
      const expectedNumber = Number(String(expected ?? "").replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) {
        return false;
      }
      return normalizeAssertionOperator(operator) === "increased"
        ? actualNumber > expectedNumber
        : actualNumber < expectedNumber;
    }
    default:
      // Unsupported operator: never true. Callers attach `unsupported-operator`.
      return false;
  }
}

function unsupportedOperatorFailure(operator, extra = {}) {
  return {
    ...extra,
    operator,
    reason: "unsupported-operator",
    message: `Assertion operator "${operator}" is not supported. Supported: ${CANONICAL_OPERATORS.join(", ")}.`,
  };
}

function getExpectationScope(expectation = {}) {
  return normalizeScope(expectation.scope ?? expectation.within);
}

async function readGlobalPageText(page) {
  return page.evaluate(() => {
    const collectGlobalText = () => {
      const parts = [document.body?.innerText || ""];
      const controls = document.querySelectorAll?.("input, textarea, select, [contenteditable='true']") || [];
      for (const control of controls) {
        const isContentEditable = control.getAttribute?.("contenteditable") === "true";
        parts.push(
          control.value || "",
          isContentEditable ? control.textContent || "" : "",
        );
      }
      return parts
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .join("\n");
    };
    return collectGlobalText();
  });
}

async function readScopedPageText(page, scope) {
  return page.evaluate((scopeInput) => {
    const scope = scopeInput || {};
    const attrValue = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const isVisible = (element) => {
      if (!element || typeof element.getBoundingClientRect !== "function") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
      return rect.width > 0 && rect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none";
    };
    const hasVisibleDescendant = (element) => {
      const descendants = element?.querySelectorAll?.("*") || [];
      for (const descendant of descendants) {
        if (isVisible(descendant)) {
          return true;
        }
      }
      return false;
    };
    const collectScopedText = (element) => {
      if (!element) {
        return "";
      }
      const parts = [element.innerText || element.textContent || ""];
      const controls = element.querySelectorAll?.("input, textarea, select, [contenteditable='true']") || [];
      for (const control of controls) {
        const isContentEditable = control.getAttribute?.("contenteditable") === "true";
        parts.push(
          control.value || "",
          isContentEditable ? control.textContent || "" : "",
        );
      }
      return parts
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .join("\n");
    };
    const byLocator = (locator) => {
      if (!locator) {
        return [];
      }
      try {
        if (locator.startsWith("//") || locator.startsWith("(//")) {
          const result = document.evaluate(locator, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          return Array.from({ length: result.snapshotLength }, (_item, index) => result.snapshotItem(index)).filter(Boolean);
        }
        return Array.from(document.querySelectorAll(locator));
      } catch (_error) {
        return [];
      }
    };
    const candidates = [];
    const push = (items) => {
      for (const item of items || []) {
        if (item && !candidates.includes(item)) {
          candidates.push(item);
        }
      }
    };

    push(byLocator(scope.locator));
    if (scope.testId) {
      const value = attrValue(scope.testId);
      push(document.querySelectorAll(`[data-testid="${value}"], [data-test-id="${value}"], [data-test="${value}"]`));
    }
    if (scope.role) {
      const value = attrValue(scope.role);
      push(document.querySelectorAll(`[role="${value}"]`));
      if (scope.role === "dialog") {
        push(document.querySelectorAll(".ant-modal, .ant-modal-content, .ant-drawer, .ant-drawer-content, .modal, .dialog"));
      }
    }
    if (!candidates.length && scope.nearText) {
      push(document.querySelectorAll("body, main, section, article, form, [role], .ant-modal, .ant-drawer, div"));
    }
    const visibleCandidates = candidates.filter(
      (item) => item === document.body || isVisible(item) || hasVisibleDescendant(item),
    );
    const filtered = scope.nearText
      ? visibleCandidates.filter((item) => collectScopedText(item).includes(scope.nearText))
      : visibleCandidates;
    const sorted = (filtered.length ? filtered : visibleCandidates)
      .map((element) => ({
        element,
        text: collectScopedText(element),
        rect: element.getBoundingClientRect?.() || { width: 0, height: 0 },
      }))
      .filter((item) => item.text)
      .sort((a, b) => {
        const aArea = a.rect.width * a.rect.height;
        const bArea = b.rect.width * b.rect.height;
        if (aArea && bArea && aArea !== bArea) {
          return aArea - bArea;
        }
        return a.text.length - b.text.length;
      });
    return {
      text: sorted[0]?.text || "",
      matched: Boolean(sorted[0]),
      scope,
    };
  }, scope);
}

async function readExpectationText(page, expectation) {
  const scope = getExpectationScope(expectation);
  if (!scope) {
    return {
      text: await readGlobalPageText(page),
      scope: null,
      scopeMatched: false,
    };
  }
  const scoped = await readScopedPageText(page, scope);
  return {
    text: scoped.text || "",
    scope,
    scopeMatched: Boolean(scoped.matched),
  };
}

function toDataBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string" && value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma >= 0) {
      return Buffer.from(value.slice(comma + 1), "base64");
    }
  }
  return null;
}

async function expectTextExist(page, expectation, options = {}) {
  const timeoutMs = expectation.timeoutMs ?? 4000;
  const intervalMs = expectation.intervalMs ?? 400;
  const texts = normalizeExpectationTexts(expectation);
  const startedAt = Date.now();
  let lastTextState = {
    text: "",
    scope: getExpectationScope(expectation),
    scopeMatched: false,
  };

  if (!texts.length) {
    return {
      ok: false,
      type: "expectTextExist",
      error: "expected-text-required",
      matched: [],
      missing: [],
      textSample: "",
    };
  }

  while (Date.now() - startedAt <= timeoutMs) {
    const textState = await readExpectationText(page, expectation);
    lastTextState = textState;
    const matched = texts.filter((text) => textState.text.includes(text));
    if (matched.length === texts.length) {
      return {
        ok: true,
        type: "expectTextExist",
        matched,
        missing: [],
        scope: textState.scope,
        scopeMatched: textState.scopeMatched,
        textSample: textState.text.slice(0, 1000),
      };
    }
    await page.waitForTimeout(intervalMs);
  }

  const missing = texts.filter((text) => !lastTextState.text.includes(text));
  return {
    ok: false,
    type: "expectTextExist",
    matched: texts.filter((text) => lastTextState.text.includes(text)),
    missing,
    scope: lastTextState.scope,
    scopeMatched: lastTextState.scopeMatched,
    textSample: lastTextState.text.slice(0, 1000),
  };
}

async function expectNoText(page, expectation) {
  const timeoutMs = expectation.timeoutMs ?? 4000;
  const intervalMs = expectation.intervalMs ?? 400;
  const texts = normalizeExpectationTexts(expectation);
  const startedAt = Date.now();
  let lastTextState = {
    text: "",
    scope: getExpectationScope(expectation),
    scopeMatched: false,
  };

  while (Date.now() - startedAt <= timeoutMs) {
    const textState = await readExpectationText(page, expectation);
    lastTextState = textState;
    const present = texts.filter((text) => textState.text.includes(text));
    if (present.length === 0) {
      return {
        ok: true,
        type: "expectNoText",
        present: [],
        scope: textState.scope,
        scopeMatched: textState.scopeMatched,
        textSample: textState.text.slice(0, 1000),
      };
    }
    await page.waitForTimeout(intervalMs);
  }

  const present = texts.filter((text) => lastTextState.text.includes(text));
  return {
    ok: false,
    type: "expectNoText",
    present,
    scope: lastTextState.scope,
    scopeMatched: lastTextState.scopeMatched,
    textSample: lastTextState.text.slice(0, 1000),
  };
}

async function expectRegionSimilar(page, expectation) {
  const region = expectation.region;
  const reference = toDataBuffer(expectation.reference);
  if (!region || !reference) {
    return {
      ok: false,
      type: "expectRegionSimilar",
      error: "region-and-reference-required",
    };
  }
  const capture = await page.screenshot({
    clip: {
      x: Math.floor(region.x),
      y: Math.floor(region.y),
      width: Math.floor(region.width),
      height: Math.floor(region.height),
    },
    type: "png",
  });
  const diff = computeImageDiff(reference, capture, {
    threshold: expectation.threshold ?? 0.08,
  });
  return {
    ok: !diff.changed,
    type: "expectRegionSimilar",
    diff,
  };
}

async function expectUrl(page, expectation) {
  const meta = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    path: location.pathname,
  }));
  const urlIncludes = expectation.urlIncludes || expectation.raw?.urlIncludes || "";
  const urlMatches = expectation.urlMatches || expectation.raw?.urlMatches || "";
  const pathEquals = expectation.pathEquals || expectation.raw?.pathEquals || "";
  const titleIncludes = expectation.titleIncludes || expectation.raw?.titleIncludes || "";
  const failures = [];

  if (urlIncludes && !meta.url.includes(urlIncludes)) {
    failures.push({ field: "urlIncludes", expected: urlIncludes, actual: meta.url });
  }
  if (pathEquals && meta.path !== pathEquals) {
    failures.push({ field: "pathEquals", expected: pathEquals, actual: meta.path });
  }
  if (titleIncludes && !meta.title.includes(titleIncludes)) {
    failures.push({ field: "titleIncludes", expected: titleIncludes, actual: meta.title });
  }
  if (urlMatches) {
    try {
      const pattern = new RegExp(urlMatches);
      if (!pattern.test(meta.url)) {
        failures.push({ field: "urlMatches", expected: urlMatches, actual: meta.url });
      }
    } catch (_error) {
      failures.push({ field: "urlMatches", expected: urlMatches, actual: "invalid-regexp" });
    }
  }
  if (!urlIncludes && !urlMatches && !pathEquals && !titleIncludes) {
    return {
      ok: false,
      type: "expectUrl",
      error: "url-expectation-required",
      meta,
    };
  }
  return {
    ok: failures.length === 0,
    type: "expectUrl",
    meta,
    failures,
  };
}

function buildCountLocator(page, target = {}) {
  const source = target && typeof target === "object" ? target : {};
  const root = buildScopeBaseLocator(page, source.scope) || page;
  if (source.locator) {
    return buildRawLocator(root, source.locator);
  }
  if (source.testId) {
    return root.locator(buildTestIdSelector(source.testId));
  }
  if (source.role) {
    const options = source.name || source.text ? { name: source.name || source.text, exact: Boolean(source.exact) } : {};
    return root.getByRole(source.role, options);
  }
  if (source.placeholder) {
    return root.getByPlaceholder(source.placeholder, { exact: Boolean(source.exact) });
  }
  if (source.ariaLabel) {
    return root.locator(`[aria-label="${escapeCssString(source.ariaLabel)}"]`);
  }
  if (source.title) {
    return root.locator(`[title="${escapeCssString(source.title)}"]`);
  }
  if (source.text || source.name || source.query) {
    return root.getByText(source.text || source.name || source.query, { exact: Boolean(source.exact) });
  }
  return null;
}

function buildDomLocator(page, target = {}) {
  return buildCountLocator(page, target);
}

function normalizeDomProperty(value) {
  const property = String(value || "exists").trim();
  return [
    "exists",
    "visible",
    "count",
    "text",
    "value",
    "checked",
    "disabled",
    "selected",
    "attribute",
    "class",
  ].includes(property)
    ? property
    : "exists";
}

function normalizeExpectedBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "checked", "disabled", "selected"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function normalizeTagMatch(value) {
  const match = String(value || "exact").trim();
  return ["exact", "contains", "startsWith"].includes(match) ? match : "exact";
}

async function readDomState(locator, expectation) {
  const target = expectation.target || expectation.raw?.target || {};
  const hasTexts = normalizeTexts(target.hasTexts ?? target.hasText);
  const tagTexts = normalizeTexts(target.tagTexts ?? target.tagText);
  const tagMatch = normalizeTagMatch(target.tagMatch ?? expectation.tagMatch ?? expectation.raw?.tagMatch);
  const property = normalizeDomProperty(expectation.property || expectation.raw?.property);
  const visibleOnly = expectation.visibleOnly !== false && expectation.raw?.visibleOnly !== false;
  return locator.evaluateAll((elements, input) => {
    const tagSelector = ".ant-tag, .task-tag, [data-tag], [data-role='tag'], [class~='tag'], [role='status'], [role='note']";
    const isVisible = (element) => {
      if (!element || typeof element.getBoundingClientRect !== "function") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const hasVisibleOverlayDescendant = (element) => {
      const overlays = element?.querySelectorAll?.(".ant-modal, .ant-modal-wrap, .ant-drawer, .ant-drawer-content, [role='dialog'], [aria-modal='true']") || [];
      return Array.from(overlays).some(isVisible);
    };
    const isEffectivelyVisible = (element) => isVisible(element) || hasVisibleOverlayDescendant(element);
    const readText = (element) => {
      const controlSelector = "input, textarea, select, [contenteditable='true']";
      const textParts = [];
      const visibleText = typeof element.innerText === "string" ? element.innerText : "";
      const fallbackText =
        !visibleText && typeof element.textContent === "string"
          ? element.textContent
          : "";
      if (visibleText || fallbackText) {
        textParts.push(visibleText || fallbackText);
      }
      const controls = [
        ...(element.matches?.(controlSelector) ? [element] : []),
        ...Array.from(element.querySelectorAll?.(controlSelector) || []),
      ];
      for (const control of controls) {
        if (!isVisible(control)) {
          continue;
        }
        const isContentEditable = control.getAttribute?.("contenteditable") === "true";
        textParts.push(control.value || "");
        if (isContentEditable) {
          textParts.push(control.innerText || control.textContent || "");
        }
      }
      return textParts.join("\n");
    };
    const tagMatches = (tagText, expectedText) => {
      const actual = String(tagText || "").trim();
      const expected = String(expectedText || "").trim();
      if (input.tagMatch === "contains") {
        return actual.includes(expected);
      }
      if (input.tagMatch === "startsWith") {
        return actual.startsWith(expected);
      }
      return actual === expected;
    };
    const collectMatchingTags = (element) => {
      if (!input.tagTexts.length) {
        return [];
      }
      const candidates = Array.from(element.querySelectorAll?.(tagSelector) || []);
      if (element.matches?.(tagSelector)) {
        candidates.unshift(element);
      }
      return candidates.filter((candidate) => {
        if (input.visibleOnly && !isVisible(candidate)) {
          return false;
        }
        const text = readText(candidate);
        return input.tagTexts.some((item) => tagMatches(text, item));
      });
    };
    const filtered = elements.filter((element) => {
      if (input.visibleOnly && !isEffectivelyVisible(element)) {
        return false;
      }
      if (input.hasTexts.length) {
        const text = readText(element);
        if (!input.hasTexts.every((item) => text.includes(item))) {
          return false;
        }
      }
      if (!input.tagTexts.length) {
        return true;
      }
      const matchedTags = collectMatchingTags(element);
      return input.tagTexts.every((item) => matchedTags.some((tag) => tagMatches(readText(tag), item)));
    });
    const first = filtered[0] || null;
    const firstMatchedTag = first ? collectMatchingTags(first)[0] || null : null;
    const attributeElement = firstMatchedTag || first;
    const state = {
      count: filtered.length,
      exists: filtered.length > 0,
      visible: first ? isEffectivelyVisible(first) : false,
      text: first ? readText(first).trim() : "",
      value: first ? first.value ?? first.getAttribute?.("value") ?? "" : "",
      checked: first ? Boolean(first.checked || first.getAttribute?.("aria-checked") === "true") : false,
      disabled: first ? Boolean(first.disabled || first.getAttribute?.("disabled") != null || first.getAttribute?.("aria-disabled") === "true") : false,
      selected: first ? Boolean(first.selected || first.getAttribute?.("aria-selected") === "true") : false,
      attribute: attributeElement && input.attribute ? attributeElement.getAttribute?.(input.attribute) : null,
      class: first ? first.className || first.getAttribute?.("class") || "" : "",
      samples: filtered.slice(0, 5).map((element) => ({
        text: readText(element).trim().slice(0, 300),
        tags: collectMatchingTags(element).map((tag) => readText(tag).trim()).filter(Boolean).slice(0, 10),
        value: element.value ?? element.getAttribute?.("value") ?? "",
        className: element.className || element.getAttribute?.("class") || "",
      })),
    };
    state.actual = state[input.property];
    return state;
  }, {
    attribute: expectation.attribute || expectation.raw?.attribute || expectation.raw?.attributeName || "",
    hasTexts,
    property,
    tagMatch,
    tagTexts,
    visibleOnly,
  });
}

function evaluateDomExpectation(state, property, operator, expected) {
  const actual = property === "count" ? state.count : state.actual;
  const comparableExpected = ["checked", "disabled", "selected", "exists", "visible"].includes(property)
    ? normalizeExpectedBoolean(expected)
    : expected;
  const ok = property === "count"
    ? compareValues(state.count, Number(comparableExpected), operator)
    : compareTextValue(actual, comparableExpected, operator);
  return {
    ok,
    actual,
    comparableExpected,
  };
}

function shouldUseAdapterDomState(property, nativeState, nativeCheck, adapterState, adapterCheck) {
  if (!adapterState || !adapterCheck) {
    return false;
  }
  if (adapterCheck.ok) {
    return true;
  }
  if (!nativeState || nativeState.count === 0) {
    return true;
  }
  if (nativeCheck?.ok) {
    return false;
  }
  if (["checked", "disabled", "selected", "value"].includes(property)) {
    return true;
  }
  if (property === "text") {
    const nativeActual = String(nativeState.actual ?? nativeState.text ?? "").trim();
    const adapterActual = String(adapterState.actual ?? adapterState.text ?? "").trim();
    return !nativeActual && Boolean(adapterActual);
  }
  return false;
}

async function expectDom(page, expectation, context = {}) {
  const timeoutMs = expectation.timeoutMs ?? 4000;
  const intervalMs = expectation.intervalMs ?? 400;
  const target = expectation.target || expectation.raw?.target || null;
  const property = normalizeDomProperty(expectation.property || expectation.raw?.property);
  const operator = expectation.operator || expectation.raw?.operator || (["exists", "visible"].includes(property) ? "equals" : "equals");
  const expected = expectation.expected ?? expectation.raw?.expected ?? (property === "exists" || property === "visible" ? true : undefined);
  const startedAt = Date.now();
  let lastState = null;

  // v1.10 Z28-2: fail fast and say why, instead of polling a comparison that
  // can never be true for the whole timeout.
  if (normalizeAssertionOperator(operator) === null) {
    return {
      ok: false,
      type: "expectDom",
      error: "unsupported-operator",
      property,
      expected,
      target,
      ...unsupportedOperatorFailure(operator),
    };
  }

  if (!target) {
    return {
      ok: false,
      type: "expectDom",
      error: "dom-target-required",
    };
  }
  if (property === "attribute" && !(expectation.attribute || expectation.raw?.attribute || expectation.raw?.attributeName)) {
    return {
      ok: false,
      type: "expectDom",
      error: "attribute-name-required",
      target,
    };
  }
  const locator = buildDomLocator(page, target);
  if (!locator) {
    const adapterOnly = await readDomStateWithAdapters(page, expectation, context);
    if (adapterOnly?.state) {
      const adapterCheck = evaluateDomExpectation(adapterOnly.state, property, operator, expected);
      return finishExpectation(attachDomCaptures({
        ok: adapterCheck.ok,
        type: "expectDom",
        property,
        operator,
        expected: adapterCheck.comparableExpected,
        actual: adapterCheck.actual,
        state: adapterOnly.state,
        target,
        locatorDiagnostics: {
          native: { strategy: "none", count: 0 },
          adapter: adapterOnly.diagnostics,
        },
      }, expectation), context);
    }
    return {
      ok: false,
      type: "expectDom",
      error: "dom-target-required",
      target,
    };
  }

  while (Date.now() - startedAt <= timeoutMs) {
    const nativeState = await readDomState(locator, expectation);
    const adapterResult = await readDomStateWithAdapters(page, expectation, context);
    const nativeCheck = evaluateDomExpectation(nativeState, property, operator, expected);
    const adapterCheck = adapterResult?.state
      ? evaluateDomExpectation(adapterResult.state, property, operator, expected)
      : null;
    const useAdapter = shouldUseAdapterDomState(
      property,
      nativeState,
      nativeCheck,
      adapterResult?.state,
      adapterCheck,
    );
    lastState = useAdapter ? adapterResult.state : nativeState;
    const check = useAdapter && adapterCheck ? adapterCheck : nativeCheck;
    const locatorDiagnostics = {
      native: {
        strategy: "buildDomLocator",
        count: nativeState.count,
        samples: nativeState.samples,
      },
      adapter: adapterResult?.diagnostics || null,
      selected: useAdapter ? "adapter" : "native",
    };
    if (check.ok) {
      return finishExpectation(attachDomCaptures({
        ok: true,
        type: "expectDom",
        property,
        operator,
        expected: check.comparableExpected,
        actual: check.actual,
        state: lastState,
        target,
        locatorDiagnostics,
      }, expectation), context);
    }
    lastState.locatorDiagnostics = locatorDiagnostics;
    await page.waitForTimeout(intervalMs);
  }

  return finishExpectation(attachDomCaptures({
    ok: false,
    type: "expectDom",
    property,
    operator,
    expected,
    actual: lastState?.actual,
    state: lastState,
    target,
    locatorDiagnostics: lastState?.locatorDiagnostics || null,
  }, expectation), context);
}

async function expectCount(page, expectation) {
  const target = expectation.target || expectation.raw?.target || null;
  const expected = Number.isInteger(expectation.count)
    ? expectation.count
    : Number(expectation.raw?.count);
  if (!target || !Number.isFinite(expected)) {
    return {
      ok: false,
      type: "expectCount",
      error: "count-target-and-expected-required",
    };
  }
  const locator = buildCountLocator(page, target);
  if (!locator) {
    return {
      ok: false,
      type: "expectCount",
      error: "count-target-required",
      target,
    };
  }
  const visibleOnly = expectation.visibleOnly !== false && expectation.raw?.visibleOnly !== false;
  const actual = visibleOnly
    ? await locator.evaluateAll((elements) => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
        };
        return elements.filter(isVisible).length;
      })
    : await locator.count();
  const rawOperator = expectation.operator || expectation.raw?.operator;
  const operator = normalizeCountOperator(rawOperator);
  if (operator === null) {
    return {
      ok: false,
      type: "expectCount",
      error: "unsupported-operator",
      ...unsupportedOperatorFailure(rawOperator, { actual, expected }),
      visibleOnly,
      target,
    };
  }
  return {
    ok: compareValues(actual, expected, operator),
    type: "expectCount",
    actual,
    expected,
    operator,
    visibleOnly,
    target,
  };
}

function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      /authorization|cookie|token|secret|password/i.test(key) ? "[redacted]" : value,
    ]),
  );
}

// REQ-Z14 (需求单v3): a path segment is `key`, followed by any number of
// accessors — `[]` (fan out to an array) or `[N]` (pick one element, staying a
// scalar). Before v1.3 only `[]` was understood, so `data.content[0].workflowId`
// was read as the *literal key* `content[0]` (-> null) and `data.content[]
// .workflowId` produced `[1152]`, which downstream `callApi` bodies then sent as
// a malformed array (-> HTTP 400). Both were reported from a real QA run.
const PATH_SEGMENT_PATTERN = /^([^[\]]*)((?:\[\d*\])*)$/;

function parsePathSegment(segment) {
  const match = PATH_SEGMENT_PATTERN.exec(segment);
  if (!match) {
    // Not a shape we understand — treat the whole thing as a literal key so
    // behaviour stays predictable instead of silently dropping the segment.
    return { key: segment, accessors: [] };
  }
  const [, key, accessorText] = match;
  const accessors = (accessorText.match(/\[\d*\]/g) || []).map((token) => {
    const inner = token.slice(1, -1);
    return inner === "" ? { kind: "all" } : { kind: "index", index: Number(inner) };
  });
  return { key, accessors };
}

function readKeyFrom(current, key) {
  if (!key) {
    return current;
  }
  if (Array.isArray(current)) {
    return current.map((item) => item?.[key]);
  }
  return current?.[key];
}

function readPath(source, path) {
  const normalized = String(path || "").replace(/^body\./, "").replace(/^json\./, "");
  if (!normalized) {
    return source;
  }
  const segments = normalized.split(".").filter(Boolean);
  let current = source;
  for (const segment of segments) {
    const { key, accessors } = parsePathSegment(segment);
    current = readKeyFrom(current, key);
    for (const accessor of accessors) {
      if (accessor.kind === "all") {
        // `key[]` — fan out; the result is always an array, and null/undefined
        // members are dropped (unchanged from the pre-v1.3 `[]` semantics).
        const values = Array.isArray(current)
          ? current.flatMap((item) => (item == null ? [] : Array.isArray(item) ? item : [item]))
          : current;
        current = Array.isArray(values) ? values : values == null ? [] : [values];
        continue;
      }
      // `key[N]` — pick one element and stay a scalar.
      current = Array.isArray(current) ? current[accessor.index] : undefined;
    }
  }
  return current;
}

function normalizeResponseAssertions(expectation = {}) {
  const raw = expectation.raw || {};
  const items = expectation.body ?? raw.body ?? raw.json ?? raw.bodyAssertions ?? [];
  return (Array.isArray(items) ? items : [items])
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      return {
        path: String(item.path || "").trim(),
        operator: String(item.operator || item.op || item.comparison || "equals").trim() || "equals",
        expected: item.expected,
        hasExpected: item.expected !== undefined,
        saveAs: String(item.saveAs || "").trim(),
        // REQ-Z14: equivalent "take the first match as a scalar" switch, for
        // paths that must stay a fan-out (`[]`) for the assertion but need to
        // capture a single value for a downstream callApi body.
        first: item.first === true || item.saveAsScalar === true,
      };
    })
    .filter((item) => item && item.path);
}

// REQ-Z14: collapse a fan-out result to its first defined member.
function firstScalar(value) {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.find((item) => item !== undefined && item !== null) ?? null;
}

function assertResponseShape(response, expectation = {}) {
  if (!response) {
    return {
      ok: false,
      failures: [{ field: "response", expected: "present", actual: "missing" }],
    };
  }
  const raw = expectation.raw || {};
  const failures = [];
  const status = expectation.status ?? raw.status;
  const urlIncludes = expectation.urlIncludes || raw.urlIncludes || "";
  const urlMatches = expectation.urlMatches || raw.urlMatches || "";
  const method = expectation.method || raw.method || "";

  if (Number.isFinite(status) && response.status !== status) {
    failures.push({ field: "status", expected: status, actual: response.status });
  }
  if (method && String(response.method || "").toUpperCase() !== String(method).toUpperCase()) {
    failures.push({ field: "method", expected: method, actual: response.method });
  }
  if (urlIncludes && !String(response.url || "").includes(urlIncludes)) {
    failures.push({ field: "urlIncludes", expected: urlIncludes, actual: response.url });
  }
  if (urlMatches) {
    try {
      if (!new RegExp(urlMatches).test(String(response.url || ""))) {
        failures.push({ field: "urlMatches", expected: urlMatches, actual: response.url });
      }
    } catch (_error) {
      failures.push({ field: "urlMatches", expected: urlMatches, actual: "invalid-regexp" });
    }
  }
  const captures = [];
  for (const assertion of normalizeResponseAssertions(expectation)) {
    const raw = readPath(response.body, assertion.path);
    const actual = assertion.first ? firstScalar(raw) : raw;
    // v1.10 Z28-4: an empty fan-out (`list[].id` over zero rows) used to be
    // "captured" as `[]` — stored as the text "[]", which a downstream
    // `{"workflowId":"{{id}}"}` then sent while the capture step itself was
    // green. Nothing was captured, so it now fails like a missing value does.
    // (A non-empty fan-out still captures the array — that is deliberate since
    // v1.3; precheck nudges authors toward `first: true` for scalar use.)
    if (assertion.saveAs && Array.isArray(actual) && actual.length === 0) {
      failures.push({
        field: `body.${assertion.path}`,
        expected: "present",
        actual,
        operator: "exists",
        reason: "capture-empty-array",
        message: `saveAs "${assertion.saveAs}" matched an empty list at "${assertion.path}"; nothing to capture.`,
      });
      continue;
    }
    if (assertion.saveAs && actual == null) {
      failures.push({
        field: `body.${assertion.path}`,
        expected: "present",
        actual,
        operator: "exists",
      });
      continue;
    }
    // v1.10 Z28-2: an unknown operator is a broken assertion, reported as such.
    if (normalizeAssertionOperator(assertion.operator) === null) {
      failures.push(unsupportedOperatorFailure(assertion.operator, {
        field: `body.${assertion.path}`,
        expected: assertion.expected,
        actual,
      }));
      continue;
    }
    // `exists` / `notExists` need no expected value; before v1.10 they were
    // skipped entirely when `expected` was omitted, i.e. never evaluated.
    const operatorNeedsNoExpected = ["exists", "notExists"].includes(normalizeAssertionOperator(assertion.operator));
    if (assertion.hasExpected || operatorNeedsNoExpected) {
      // A fan-out path (`list[].status`) passes a positive operator when ANY
      // member satisfies it; a negative operator must hold for EVERY member —
      // "no row notEquals X" is not what `some` would check.
      const negative = ["notEquals", "notContains", "notExists"].includes(normalizeAssertionOperator(assertion.operator));
      const pass = Array.isArray(actual)
        ? negative
          ? actual.every((item) => compareTextValue(item, assertion.expected, assertion.operator))
          : actual.some((item) => compareTextValue(item, assertion.expected, assertion.operator))
        : compareTextValue(actual, assertion.expected, assertion.operator);
      if (!pass) {
        failures.push({
          field: `body.${assertion.path}`,
          expected: assertion.expected,
          actual,
          operator: assertion.operator,
        });
      }
    }
    if (assertion.saveAs) {
      captures.push({
        name: assertion.saveAs,
        value: actual,
        source: "response",
        path: assertion.path,
      });
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    captures: failures.length === 0 ? captures : [],
  };
}

function getDomExpectationSaveAs(expectation = {}) {
  return String(expectation.saveAs || expectation.raw?.saveAs || "").trim();
}

function attachDomCaptures(result, expectation = {}) {
  const saveAs = getDomExpectationSaveAs(expectation);
  if (!saveAs || !result || !result.ok) {
    return result;
  }
  return {
    ...result,
    captures: [
      {
        name: saveAs,
        value: result.actual,
        source: "dom",
        property: result.property,
      },
    ],
  };
}

function buildExpectationCaptureError(error) {
  return {
    ok: false,
    type: "runtimeVariableCapture",
    error: error?.code || "runtime-variable-capture-failed",
    message: error?.message || "Runtime variable capture failed.",
    variableName: error?.variableName || "",
  };
}

function collectExpectationCaptures(expectationResult) {
  if (!expectationResult || typeof expectationResult !== "object") {
    return [];
  }
  const ownCaptures = Array.isArray(expectationResult.captures)
    ? expectationResult.captures
    : [];
  const childCaptures = Array.isArray(expectationResult.results)
    ? expectationResult.results.flatMap((item) => collectExpectationCaptures(item))
    : [];
  return [...ownCaptures, ...childCaptures];
}

function applyExpectationCaptures(expectationResult, context = {}) {
  if (!expectationResult?.ok || typeof context.setRuntimeVariable !== "function") {
    return expectationResult;
  }
  const captures = collectExpectationCaptures(expectationResult);
  if (!captures.length) {
    return expectationResult;
  }
  try {
    const appliedCaptures = captures.map((capture) => ({
      ...capture,
      value: context.setRuntimeVariable(capture.name, capture.value, "capture"),
    }));
    return {
      ...expectationResult,
      captures: appliedCaptures,
    };
  } catch (error) {
    return buildExpectationCaptureError(error);
  }
}

function finishExpectation(result, context = {}) {
  return applyExpectationCaptures(result, context);
}

async function expectResponse(_page, expectation, context = {}) {
  const response = context.response || context.apiResponse || null;
  const result = assertResponseShape(response, expectation);
  return finishExpectation({
    ok: result.ok,
    type: "expectResponse",
    response: response
      ? {
          url: response.url,
          method: response.method,
          status: response.status,
          headers: redactHeaders(response.headers),
          body: response.body,
        }
      : null,
    failures: result.failures,
    captures: result.captures,
  }, context);
}

async function expectNetworkResponse(_page, expectation, context = {}) {
  if (typeof context.waitForNetworkResponse !== "function") {
    return {
      ok: false,
      type: "expectNetworkResponse",
      error: "network-listener-unavailable",
    };
  }
  const result = await context.waitForNetworkResponse(expectation);
  return finishExpectation(result, context);
}

// v1.5 Z-A ("断言型用法"): the explicit declaration that a stretch of the flow
// must be clean. Complements — never replaces — the default gate:
//  - it fails even when `settings.pageErrorPolicy` is "warn"/"off", because an
//    author who wrote this assertion is asking for the strict answer;
//  - it is scoped: by default it covers everything since the previous
//    `assertNoPageError` in this run, so a case can say "the *save* flow must be
//    clean" without inheriting noise from an earlier navigation. Pass
//    `since: "run-start"` to assert over the whole run instead.
async function expectNoPageError(_page, expectation, context = {}) {
  const diagnostics = context.diagnostics || null;
  const raw = expectation?.raw || expectation || {};
  const sinceRunStart = String(raw.since ?? "").trim() === "run-start";
  if (!diagnostics || typeof diagnostics.takeAssertionFailures !== "function") {
    // Fail closed. A silently-passing "no page errors" assertion on a channel
    // that never collected them would be the exact false-green this whole
    // capability exists to remove.
    return {
      ok: false,
      type: "assertNoPageError",
      error: "page-diagnostics-unavailable",
      detail:
        "This run has no page-error collector attached, so 'no page errors' could not be verified. " +
        "Treated as a failure rather than a pass so it cannot become a false green.",
      scope: sinceRunStart ? "run-start" : "since-previous-assertion",
    };
  }
  const failures = diagnostics.takeAssertionFailures({ sinceRunStart });
  const entries = failures.map((item) => ({
    kind: item.kind,
    message: item.message,
    stack: item.stack,
    at: item.at,
    url: item.url,
    stepId: item.stepId,
    stepIndex: item.stepIndex,
  }));
  return {
    ok: failures.length === 0,
    type: "assertNoPageError",
    scope: sinceRunStart ? "run-start" : "since-previous-assertion",
    expected: "no uncaught page errors",
    actual: failures.length ? `${failures.length} page error(s)` : "none",
    pageErrors: entries,
    policy: typeof diagnostics.policy === "string" ? diagnostics.policy : null,
    ...(failures.length
      ? { error: `page-error: ${entries[0].message}` }
      : {}),
  };
}

// v1.5 Z-C: `assertFile` — the contents of an exported/downloaded artifact.
// Thin wrapper: the resolution + inspection logic lives in
// `runtime/perception/file-artifacts.js`; this is only the dispatch seam so a
// file assertion goes through the same evaluation path (and the same
// captures/telemetry plumbing) as every other assertion kind.
async function expectFile(page, expectation, context = {}) {
  const { evaluateFileAssertion } = require("../perception/file-artifacts");
  const raw = expectation?.raw || expectation || {};
  return evaluateFileAssertion(
    {
      source: raw.source || expectation.source || null,
      // The step writes `expectation: {kind: "xlsx", ...}` at the top level, which
      // the normalizer preserves under `raw.expectation`.
      expectation: raw.expectation || expectation.expectation || {},
    },
    { ...context, page },
  );
}

// v1.6 Z-J: compare what each entry point reported for the same subject.
//
// The output is an **entry × value matrix**, not a boolean, because the useful
// half of this finding is *which two entries disagree* — "字段顺序不一致" is not
// actionable, "规则维护弹窗 和 编辑字段表 给出的顺序不同" is.
//
// Facet J-2: a probe that produced no value at all is `blocked`, NOT "the rest
// agreed so it passes". An unreachable entry point means the check did not run,
// and reporting that as agreement is exactly the "没测到被表达成绿" failure the
// whole trust programme exists to remove.
async function expectConsistency(_page, expectation, context = {}) {
  const raw = expectation?.raw || expectation || {};
  const probes = Array.isArray(raw.probes) ? raw.probes : Array.isArray(expectation.probes) ? expectation.probes : [];
  const subject = raw.subject || expectation.subject || "同一份数据";
  const normalizeMode = raw.normalize ?? "trim";
  const variables = context.runtimeVariables || {};

  const normalizeValue = (value) => {
    if (value == null) {
      return null;
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (normalizeMode === "none") {
      return text;
    }
    // `trim` (default) collapses only the whitespace an entry point may render
    // differently (padding, line breaks between list items). It deliberately does
    // NOT sort or reorder — ORDER is the very thing this primitive checks.
    return text.replace(/\s+/g, " ").trim();
  };

  const matrix = probes.map((probe) => {
    const rawValue = variables[probe.slot];
    return {
      entry: probe.name,
      slot: probe.slot,
      raw: rawValue ?? null,
      value: normalizeValue(rawValue),
      reached: rawValue != null && String(rawValue).trim() !== "",
      optional: Boolean(probe.optional),
    };
  });

  const unreached = matrix.filter((item) => !item.reached && !item.optional);
  if (unreached.length) {
    return {
      ok: false,
      type: "assertConsistency",
      blocked: true,
      subject,
      matrix,
      error: `consistency-probe-unreached: ${unreached.map((item) => item.entry).join("、")}`,
      detail:
        `这些入口没有产出取值：${unreached.map((item) => item.entry).join("、")}。` +
        "一致性检查因此没有真正执行——其余入口彼此相等**不能**被当成通过（那就是把「没测到」说成绿）。" +
        "若某个入口在当前状态下本就不可达，请把该 probe 标为 optional。",
    };
  }

  const compared = matrix.filter((item) => item.reached);
  const distinct = [...new Set(compared.map((item) => item.value))];
  if (distinct.length <= 1) {
    return {
      ok: true,
      type: "assertConsistency",
      subject,
      matrix,
      expected: "all entry points agree",
      actual: distinct[0] ?? null,
      entryCount: compared.length,
    };
  }

  // Name the disagreeing pairs explicitly. With three orders across four entries,
  // "they differ" is useless; "编辑字段表 vs 规则维护弹窗" is where to look.
  const groups = distinct.map((value) => ({
    value,
    entries: compared.filter((item) => item.value === value).map((item) => item.entry),
  }));
  const conflicts = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      conflicts.push({
        entries: [groups[i].entries[0], groups[j].entries[0]],
        values: [groups[i].value, groups[j].value],
      });
    }
  }
  return {
    ok: false,
    type: "assertConsistency",
    subject,
    matrix,
    groups,
    conflicts,
    distinctValues: distinct.length,
    expected: "all entry points agree",
    actual: `${distinct.length} different values across ${compared.length} entry points`,
    error:
      `consistency-mismatch: ${subject} 在 ${compared.length} 个入口给出了 ${distinct.length} 种取值。` +
      conflicts
        .slice(0, 3)
        .map((item) => ` 「${item.entries[0]}」= ${item.values[0]} ／ 「${item.entries[1]}」= ${item.values[1]}`)
        .join("；"),
  };
}

// v1.6 Z-G: performance metric assertion. Thin dispatch seam; the collection and
// comparison live in `runtime/perception/performance-metrics.js`.
async function expectPerf(page, expectation, context = {}) {
  const { evaluatePerfAssertion } = require("../perception/performance-metrics");
  const raw = expectation?.raw || expectation || {};
  return evaluatePerfAssertion(
    {
      metric: raw.metric ?? expectation.metric,
      atMost: raw.atMost,
      atLeast: raw.atLeast,
      equals: raw.equals,
      baseline: raw.baseline,
      toleranceRatio: raw.toleranceRatio,
      saveAs: raw.saveAs ?? expectation.saveAs,
    },
    { ...context, page },
  );
}

// v1.6 Z-E: baseline pixel diff and peer (同族) token comparison. Both are thin
// dispatch seams; the substance lives in `runtime/perception/visual-baseline.js`.
// v1.11 REQ-Z32: pairwise non-overlap / no-truncation of rendered boxes.
async function expectLayout(page, expectation, context = {}) {
  const { evaluateLayoutAssertion } = require("../perception/layout-assert");
  const raw = expectation?.raw || expectation || {};
  return evaluateLayoutAssertion(raw, { ...context, page });
}

async function expectVisual(page, expectation, context = {}) {
  const { evaluateVisualAssertion } = require("../perception/visual-baseline");
  const raw = expectation?.raw || expectation || {};
  return evaluateVisualAssertion(
    {
      target: raw.target ?? expectation.target,
      baseline: raw.baseline,
      profile: raw.profile,
      mask: raw.mask,
      expectation: raw.expectation ?? null,
      maxDiffRatio: raw.maxDiffRatio,
      onMissingBaseline: raw.onMissingBaseline,
    },
    { ...context, page },
  );
}

async function expectVisualPeers(page, expectation, context = {}) {
  const { evaluatePeerAssertion } = require("../perception/visual-baseline");
  const raw = expectation?.raw || expectation || {};
  return evaluatePeerAssertion(
    {
      target: raw.target ?? expectation.target,
      peers: raw.peers ?? raw.visualPeers,
      mustMatch: raw.mustMatch,
    },
    { ...context, page },
  );
}

// v1.6 Z-I: "everything this round created is gone, and nothing it must not have
// touched changed". Dispatch seam only; the registry lives in
// `src/shared/data-tenant.js` because both the runtime and the session layer read it.
async function expectResidue(_page, expectation, context = {}) {
  const { evaluateResidueAssertion } = require("../../src/shared/data-tenant");
  const raw = expectation?.raw || expectation || {};
  return evaluateResidueAssertion(
    { atMost: raw.atMost, baselineGuard: raw.baselineGuard },
    context,
  );
}

async function expectComposite(page, expectation, context) {
  const assertions = Array.isArray(expectation.assertions)
    ? expectation.assertions
    : [];
  const results = [];
  for (const item of assertions) {
    const result = await runExpectation(page, item, context);
    results.push(result);
    if (!result.ok) {
      return {
        ok: false,
        type: "composite",
        results,
      };
    }
  }
  return {
    ok: true,
    type: "composite",
    results,
  };
}

async function waitForChange(_page, expectation, context) {
  const timeoutMs = expectation?.timeoutMs ?? 4000;
  const intervalMs = expectation?.intervalMs ?? 250;
  const startedAt = Date.now();
  let latest = context?.resolveChange ? await context.resolveChange() : context?.change ?? null;

  while (!latest?.changed && Date.now() - startedAt < timeoutMs) {
    if (!context?.waitForTimeout || !context?.resolveChange) {
      break;
    }
    await context.waitForTimeout(intervalMs);
    latest = await context.resolveChange();
  }

  return {
    ok: Boolean(latest?.changed),
    type: "waitForChange",
    diff: latest ?? null,
  };
}

function hasAssertVisibleTarget(expectation = {}) {
  const target = expectation.target || expectation.raw?.target || null;
  return Boolean(target && typeof target === "object" && Object.values(target).some(Boolean));
}

function toAssertDomVisibleExpectation(expectation = {}) {
  return {
    ...expectation,
    kind: "assertDom",
    property: expectation.property || expectation.raw?.property || "visible",
    operator: expectation.operator || expectation.raw?.operator || "equals",
    expected: expectation.expected ?? expectation.raw?.expected ?? true,
  };
}

function toTextExistsExpectation(expectation = {}) {
  return {
    ...expectation,
    kind: "text-exists",
    texts:
      expectation.texts ??
      expectation.text ??
      expectation.query ??
      expectation.queries ??
      expectation.raw?.texts ??
      expectation.raw?.text ??
      expectation.raw?.query ??
      expectation.raw?.queries,
  };
}

async function runExpectation(page, expectation, context = {}) {
  if (!expectation) {
    return null;
  }

  const kind = expectation.kind || expectation.type || "text-exists";
  switch (kind) {
    case "assertVisible":
      return hasAssertVisibleTarget(expectation)
        ? expectDom(page, toAssertDomVisibleExpectation(expectation), context)
        : expectTextExist(page, toTextExistsExpectation(expectation), context);
    case "text-exists":
    case "expectTextExist":
      return expectTextExist(page, expectation, context);
    case "text-absent":
    case "expectNoText":
      return expectNoText(page, expectation, context);
    case "region-similar":
    case "expectRegionSimilar":
      return expectRegionSimilar(page, expectation, context);
    case "url-matches":
    case "assertUrl":
    case "expectUrl":
      return expectUrl(page, expectation, context);
    case "count":
    case "assertCount":
    case "expectCount":
      return expectCount(page, expectation, context);
    case "assertDom":
    case "dom":
    case "expectDom":
      return expectDom(page, expectation, context);
    case "assertResponse":
    case "response":
    case "expectResponse":
      return expectResponse(page, expectation, context);
    case "networkResponse":
    case "expectNetworkResponse":
      return expectNetworkResponse(page, expectation, context);
    case "assertNoPageError":
    case "expectNoPageError":
    case "no-page-error":
      return expectNoPageError(page, expectation, context);
    case "assertFile":
    case "expectFile":
      return expectFile(page, expectation, context);
    case "assertConsistency":
    case "expectConsistency":
      return expectConsistency(page, expectation, context);
    case "assertPerf":
    case "expectPerf":
      return expectPerf(page, expectation, context);
    case "assertVisual":
    case "expectVisual":
      return expectVisual(page, expectation, context);
    case "assertVisualPeers":
    case "expectVisualPeers":
      return expectVisualPeers(page, expectation, context);
    case "assertResidue":
    case "expectResidue":
      return expectResidue(page, expectation, context);
    // v1.11 REQ-Z32
    case "assertLayout":
    case "expectLayout":
      return expectLayout(page, expectation, context);
    case "composite":
      return expectComposite(page, expectation, context);
    case "waitForChange":
      return waitForChange(page, expectation, context);
    default:
      return {
        ok: false,
        type: kind,
        error: `unsupported-expectation:${kind}`,
      };
  }
}

module.exports = {
  runExpectation,
  expectTextExist,
  expectNoText,
  expectRegionSimilar,
  expectUrl,
  expectCount,
  expectDom,
  expectResponse,
  expectNetworkResponse,
  expectNoPageError,
  expectFile,
  expectConsistency,
  expectPerf,
  expectVisual,
  expectVisualPeers,
  expectResidue,
  expectLayout,
  assertResponseShape,
  shouldUseAdapterDomState,
  compareTextValue,
};
