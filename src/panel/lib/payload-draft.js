const ACTION_TYPES = ["click", "hover", "press", "fill", "check", "uncheck", "selectOption", "assertVisible", "assertUrl", "assertCount", "callApi", "capture", "openUrl", "reload", "goBack", "goForward", "scroll", "waitForText", "waitForNav", "waitForIdle", "comboSearchSelect", "cascaderSelect", "uploadFile", "useMacro"];
const COMMON_TEXT_EXPECTATIONS = ["text-exists", "text-absent", "waitForChange"];
const ADVANCED_EXPECTATIONS = ["composite", "region-similar", "assertDom", "assertResponse", "networkResponse"];
const NAVIGATION_BEHAVIOR_OPTIONS = ["ignore", "optional", "required"];
const WAIT_UNTIL_OPTIONS = ["commit", "domcontentloaded", "load", "networkidle"];
let stepCounter = 0;

function nextId(prefix = "step") {
  stepCounter += 1;
  return `${prefix}-${stepCounter}`;
}

function asArray(value) {
  if (value == null || value === "") {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function toNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function splitHints(value) {
  return String(value ?? "")
    .split(/\r?\n|[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function omit(source, keys) {
  const result = {};
  Object.entries(source || {}).forEach(([key, value]) => {
    if (!keys.includes(key)) {
      result[key] = value;
    }
  });
  return result;
}

function isEmptyObject(value) {
  return !value || Object.keys(value).length === 0;
}

function createEmptyExpectation(mode = "none") {
  return {
    mode,
    textsText: "",
    timeoutMs: "",
    intervalMs: "",
    threshold: "",
    reference: "",
    region: {
      x: "",
      y: "",
      width: "",
      height: "",
    },
    scope: {
      nearText: "",
      role: "",
      locator: "",
      testId: "",
    },
    assertions: [],
    rawExtras: {},
  };
}

function createEmptyStep(type = "click") {
  const normalizedType = type === "type" ? "fill" : type;
  return {
    id: nextId(),
    type: normalizedType,
    stepTitle: "",
    query: "",
    value: "",
    hintsText: "",
    targetStrategy: "auto",
    targetName: "",
    role: normalizedType === "comboSearchSelect" || normalizedType === "cascaderSelect" ? "combobox" : "",
    locator: "",
    placeholder: "",
    ariaLabel: "",
    title: "",
    testId: "",
    nearText: "",
    targetScope: {
      locator: "",
      testId: "",
      role: "",
      nearText: "",
    },
    iconHint: "",
    targetIndex: "",
    optionText: "",
    optionValue: "",
    optionPathText: "",
    optionMatch: "contains",
    optionIndex: "",
    optionWaitTimeoutMs: "",
    optionPollIntervalMs: "",
    filesText: "",
    uploadMode: "chooser",
    requestMethod: "GET",
    requestUrl: "",
    requestHeadersText: "",
    requestQueryText: "",
    requestBodyText: "",
    saveAs: "",
    macro: "",
    needRes: true,
    timeoutMs: 5000,
    retries: 0,
    retryDelayMs: 320,
    strictMatch: normalizedType === "assertVisible",
    enableScroll: false,
    waitForNav: false,
    waitForIdle: false,
    navigationBehavior: "ignore",
    navigationTimeoutMs: "",
    waitUntil: "domcontentloaded",
    settleStrategy: "",
    settleInitialMs: "",
    settleMaxMs: "",
    stabilizationDelayMs: 250,
    pageTransition: "same-tab",
    navigationTarget: {
      urlIncludes: "",
      urlMatches: "",
      pathEquals: "",
      titleIncludes: "",
    },
    autoScroll: {
      maxSteps: "",
      deltaY: "",
      settleMs: "",
    },
    expectation: createEmptyExpectation(),
    targetExtras: {},
    rawExtras: {},
  };
}

function parseLooseJson(raw) {
  if (raw == null) {
    throw new Error("Message payload is empty.");
  }
  if (typeof raw === "object") {
    return raw;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    throw new Error("Message payload is empty.");
  }
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const normalizedKeys = trimmed.replace(/(['"])?([a-zA-Z0-9_$]+)\1\s*:/g, "\"$2\":");
    const normalizedStrings = normalizedKeys.replace(
      /'([^']*)'/g,
      (_match, group) => `"${group.replace(/"/g, '\\"')}"`,
    );
    return JSON.parse(normalizedStrings);
  }
}

function summarizeTexts(value) {
  return asArray(value)
    .flatMap((item) => (typeof item === "string" ? item.split(/\r?\n|[,;|/]/) : [String(item)]))
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeAssertionItem(assertion = {}) {
  const mode = assertion.kind || assertion.type || "text-exists";
  return {
    id: nextId("assertion"),
    mode,
    textsText: summarizeTexts(assertion.texts ?? assertion.text ?? assertion.query),
    timeoutMs: assertion.timeoutMs ?? "",
    intervalMs: assertion.intervalMs ?? "",
    scope: normalizeExpectationScope(assertion.scope ?? assertion.within),
    rawExtras: omit(assertion, [
      "kind",
      "type",
      "texts",
      "text",
      "query",
      "timeoutMs",
      "intervalMs",
      "scope",
      "within",
    ]),
  };
}

function normalizeExpectationScope(scope = {}) {
  const source = scope && typeof scope === "object" ? scope : {};
  return {
    nearText: source.nearText ?? "",
    role: source.role ?? "",
    locator: source.locator ?? "",
    testId: source.testId ?? "",
  };
}

function scopeToPayload(scope) {
  const payload = {
    nearText: trimText(scope?.nearText),
    role: trimText(scope?.role),
    locator: trimText(scope?.locator),
    testId: trimText(scope?.testId),
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value));
}

function normalizeExpectation(rawExpectation) {
  if (!rawExpectation || (typeof rawExpectation === "object" && !Array.isArray(rawExpectation) && isEmptyObject(rawExpectation))) {
    return createEmptyExpectation();
  }

  if (typeof rawExpectation === "string" || Array.isArray(rawExpectation)) {
    return {
      ...createEmptyExpectation("text-exists"),
      mode: "text-exists",
      textsText: summarizeTexts(rawExpectation),
    };
  }

  const mode =
    rawExpectation.kind ||
    rawExpectation.type ||
    (rawExpectation.mode === "no-text" ? "text-absent" : rawExpectation.mode || "text-exists");

  return {
    ...createEmptyExpectation(mode),
    mode,
    textsText: summarizeTexts(rawExpectation.texts ?? rawExpectation.text ?? rawExpectation.query),
    timeoutMs: rawExpectation.timeoutMs ?? "",
    intervalMs: rawExpectation.intervalMs ?? "",
    threshold: rawExpectation.threshold ?? "",
    reference: rawExpectation.reference ?? "",
    region: {
      x: rawExpectation.region?.x ?? "",
      y: rawExpectation.region?.y ?? "",
      width: rawExpectation.region?.width ?? "",
      height: rawExpectation.region?.height ?? "",
    },
    scope: normalizeExpectationScope(rawExpectation.scope ?? rawExpectation.within),
    assertions: Array.isArray(rawExpectation.assertions)
      ? rawExpectation.assertions.map(normalizeAssertionItem)
      : [],
    rawExtras: omit(rawExpectation, [
      "kind",
      "type",
      "mode",
      "texts",
      "text",
      "query",
      "timeoutMs",
      "intervalMs",
      "threshold",
      "reference",
      "region",
      "scope",
      "within",
      "assertions",
    ]),
  };
}

function createAssertionFromExpectation(expectation) {
  const threshold = toNumber(expectation.threshold);
  return {
    id: nextId("assertion"),
    mode: expectation.mode,
    textsText: expectation.textsText,
    timeoutMs: expectation.timeoutMs,
    intervalMs: expectation.intervalMs,
    rawExtras: {
      ...clone(expectation.rawExtras),
      ...(Object.keys(scopeToPayload(expectation.scope)).length ? { scope: scopeToPayload(expectation.scope) } : {}),
      ...(expectation.mode === "waitForChange" && threshold != null
        ? {
            threshold,
          }
        : {}),
      ...(expectation.mode === "region-similar"
        ? {
            ...(threshold != null ? { threshold } : {}),
            reference: expectation.reference,
            region: {
              x: toNumber(expectation.region?.x) ?? expectation.region?.x,
              y: toNumber(expectation.region?.y) ?? expectation.region?.y,
              width: toNumber(expectation.region?.width) ?? expectation.region?.width,
              height: toNumber(expectation.region?.height) ?? expectation.region?.height,
            },
          }
        : {}),
    },
  };
}

function expectationWithWaitForChange(expectation, waitForChangeTimeoutMs) {
  const timeoutMs = waitForChangeTimeoutMs ?? "";
  const waitAssertion = {
    id: nextId("assertion"),
    mode: "waitForChange",
    textsText: "",
    timeoutMs,
    intervalMs: "",
    rawExtras: {},
  };
  if (!expectation || expectation.mode === "none") {
    return {
      ...createEmptyExpectation("waitForChange"),
      mode: "waitForChange",
      timeoutMs,
    };
  }
  if (expectation.mode === "composite") {
    return {
      ...expectation,
      assertions: [waitAssertion, ...(expectation.assertions || [])],
    };
  }
  return {
    ...createEmptyExpectation("composite"),
    mode: "composite",
    assertions: [waitAssertion, createAssertionFromExpectation(expectation)],
  };
}

function expectationToPayload(expectation) {
  if (!expectation || expectation.mode === "none") {
    return null;
  }

  if (expectation.mode === "waitForChange") {
    const base = {
      kind: "waitForChange",
      ...clone(expectation.rawExtras),
    };
    const timeoutMs = toNumber(expectation.timeoutMs);
    const intervalMs = toNumber(expectation.intervalMs);
    if (timeoutMs != null) {
      base.timeoutMs = timeoutMs;
    }
    if (intervalMs != null) {
      base.intervalMs = intervalMs;
    }
    const threshold = toNumber(expectation.threshold);
    if (threshold != null) {
      base.threshold = threshold;
    }
    return base;
  }

  const base = {
    kind: expectation.mode,
    ...clone(expectation.rawExtras),
  };
  const scope = scopeToPayload(expectation.scope);
  if (Object.keys(scope).length) {
    base.scope = scope;
  }

  if (COMMON_TEXT_EXPECTATIONS.includes(expectation.mode) || expectation.mode === "region-similar") {
    const texts = splitHints(expectation.textsText);
    if (texts.length) {
      base.text = texts;
    }
  }

  const timeoutMs = toNumber(expectation.timeoutMs);
  const intervalMs = toNumber(expectation.intervalMs);
  if (timeoutMs != null) {
    base.timeoutMs = timeoutMs;
  }
  if (intervalMs != null) {
    base.intervalMs = intervalMs;
  }

  if (expectation.mode === "region-similar") {
    const threshold = toNumber(expectation.threshold);
    if (threshold != null) {
      base.threshold = threshold;
    }
    if (trimText(expectation.reference)) {
      base.reference = trimText(expectation.reference);
    }
    const region = {
      x: toNumber(expectation.region.x),
      y: toNumber(expectation.region.y),
      width: toNumber(expectation.region.width),
      height: toNumber(expectation.region.height),
    };
    if (Object.values(region).every((value) => value != null)) {
      base.region = region;
    }
  }

  if (expectation.mode === "composite") {
    base.assertions = expectation.assertions.map((assertion) => {
      const item = {
        kind: assertion.mode,
        ...clone(assertion.rawExtras),
      };
      const childScope = scopeToPayload(assertion.scope);
      if (Object.keys(childScope).length) {
        item.scope = childScope;
      }
      const texts = splitHints(assertion.textsText);
      if (texts.length) {
        item.text = texts;
      }
      const childTimeout = toNumber(assertion.timeoutMs);
      const childInterval = toNumber(assertion.intervalMs);
      if (childTimeout != null) {
        item.timeoutMs = childTimeout;
      }
      if (childInterval != null) {
        item.intervalMs = childInterval;
      }
      return item;
    });
  }

  return base;
}

function actionFromStep(step) {
  const effectiveType =
    step.type === "type"
      ? "fill"
      : step.type === "inspect"
        ? trimText(step.query)
          ? "assertVisible"
          : "capture"
        : step.type;
  const action = {
    ...clone(step.rawExtras),
    type: effectiveType,
  };
  action.id = step.id;
  if (trimText(step.stepTitle)) {
    action.stepTitle = trimText(step.stepTitle);
  }

  const query = trimText(step.query);
  const hints = splitHints(step.hintsText);

  const target = {
    ...clone(step.targetExtras),
  };
  const targetName = trimText(step.targetName);
  if (query && !["comboSearchSelect", "cascaderSelect", "useMacro", "openUrl", "reload", "goBack", "goForward", "scroll", "waitForText", "waitForNav", "waitForIdle"].includes(effectiveType)) {
    target.text = query;
    target.name = target.name || targetName || query;
  }
  if (targetName) {
    target.name = targetName;
    if (effectiveType === "comboSearchSelect" || effectiveType === "cascaderSelect") {
      target.placeholder = target.placeholder || targetName;
    }
  }
  [
    ["strategy", step.targetStrategy],
    ["role", step.role],
    ["locator", step.locator],
    ["placeholder", step.placeholder],
    ["ariaLabel", step.ariaLabel],
    ["title", step.title],
    ["testId", step.testId],
    ["nearText", step.nearText],
    ["iconHint", step.iconHint],
  ].forEach(([key, value]) => {
    const text = trimText(value);
    if (text) {
      target[key] = text;
    }
  });
  const targetIndex = toNumber(step.targetIndex);
  if (targetIndex != null) {
    target.index = targetIndex;
  }
  const targetScope = scopeToPayload(step.targetScope);
  if (Object.keys(targetScope).length) {
    target.scope = targetScope;
  }

  if ((effectiveType !== "capture" && effectiveType !== "useMacro") || !isEmptyObject(target)) {
    action.target = {
      ...target,
    };
  }

  if (effectiveType === "openUrl" && query) {
    action.url = query;
    delete action.target;
  }
  if (effectiveType === "assertVisible" && query) {
    action.query = query;
  }
  if (effectiveType === "assertUrl" && query) {
    action.query = query;
    action.urlIncludes = query;
  }

  if (effectiveType === "fill" && trimText(step.value)) {
    action.target = {
      ...(action.target || {}),
      value: String(step.value),
    };
  }
  if (effectiveType === "press" && trimText(step.value)) {
    action.key = trimText(step.value);
  }
  if (effectiveType === "assertCount" && trimText(step.value)) {
    const count = toNumber(step.value);
    if (count != null) {
      action.count = count;
    }
  }
  if (effectiveType === "callApi") {
    action.request = {
      method: trimText(step.requestMethod) || "GET",
      url: trimText(step.requestUrl),
    };
    const headersText = trimText(step.requestHeadersText);
    const queryText = trimText(step.requestQueryText);
    const bodyText = trimText(step.requestBodyText);
    if (headersText) {
      action.request.headers = parseLooseJson(headersText);
    }
    if (queryText) {
      action.request.query = parseLooseJson(queryText);
    }
    if (bodyText) {
      action.request.body = parseLooseJson(bodyText);
    }
    if (trimText(step.saveAs)) {
      action.saveAs = trimText(step.saveAs);
    }
  }
  if (effectiveType === "useMacro") {
    const macroName = trimText(step.macro) || trimText(step.query);
    if (macroName) {
      action.macro = macroName;
    }
    delete action.target;
    return action;
  }
  if (effectiveType === "selectOption") {
    const optionText = trimText(step.optionText) || trimText(step.value);
    const optionValue = trimText(step.optionValue);
    const option = {
      text: optionText,
      value: optionValue,
      match: ["exact", "contains", "startsWith", "fuzzy"].includes(step.optionMatch)
        ? step.optionMatch
        : "contains",
    };
    const optionIndex = toNumber(step.optionIndex);
    if (optionIndex != null) {
      option.index = optionIndex;
    }
    action.option = Object.fromEntries(
      Object.entries(option).filter(([, value]) => value !== ""),
    );
    if (!optionText && trimText(step.value)) {
      action.value = trimText(step.value);
    }
  }

  if (effectiveType === "comboSearchSelect" || effectiveType === "cascaderSelect") {
    action.query = query;
    const optionPath = splitLines(step.optionPathText)
      .flatMap((item) => item.split(/[>/]|→|›/))
      .map((item) => trimText(item))
      .filter(Boolean);
    const option = {
      text: trimText(step.optionText),
      value: trimText(step.optionValue),
      path: optionPath,
      match: ["exact", "contains", "startsWith", "fuzzy"].includes(step.optionMatch)
        ? step.optionMatch
        : "contains",
    };
    const optionIndex = toNumber(step.optionIndex);
    if (optionIndex != null) {
      option.index = optionIndex;
    }
    action.option = Object.fromEntries(
      Object.entries(option).filter(([, value]) => (Array.isArray(value) ? value.length : value !== "")),
    );
    const optionWaitTimeoutMs = toNumber(step.optionWaitTimeoutMs);
    const optionPollIntervalMs = toNumber(step.optionPollIntervalMs);
    if (optionWaitTimeoutMs != null) {
      action.optionWaitTimeoutMs = optionWaitTimeoutMs;
    }
    if (optionPollIntervalMs != null) {
      action.optionPollIntervalMs = optionPollIntervalMs;
    }
  }

  if (effectiveType === "uploadFile") {
    if (query) {
      action.query = query;
    }
    action.mode = step.uploadMode === "input" ? "input" : "chooser";
    const files = splitLines(step.filesText).map((filePath) => ({ path: filePath }));
    if (files.length) {
      action.files = files;
    }
  }

  if (hints.length) {
    action.hints = hints;
  }

  action.needRes = Boolean(step.needRes);
  action.timeoutMs = toNumber(step.timeoutMs, 5000);
  action.retries = toNumber(step.retries, 0);
  action.retryDelayMs = toNumber(step.retryDelayMs, 320);
  action.strictMatch = Boolean(step.strictMatch);
  action.enableScroll = Boolean(step.enableScroll);
  action.waitForNav = Boolean(step.waitForNav);
  action.waitForIdle = Boolean(step.waitForIdle);
  action.navigationBehavior = NAVIGATION_BEHAVIOR_OPTIONS.includes(step.navigationBehavior)
    ? step.navigationBehavior
    : "ignore";
  const navigationTimeoutMs = toNumber(step.navigationTimeoutMs);
  if (navigationTimeoutMs != null) {
    action.navigationTimeoutMs = navigationTimeoutMs;
  }
  action.waitUntil = WAIT_UNTIL_OPTIONS.includes(step.waitUntil) ? step.waitUntil : "domcontentloaded";
  if (step.settleStrategy === "adaptive" || step.settleStrategy === "fixed") {
    action.settleStrategy = step.settleStrategy;
  }
  const settleInitialMs = toNumber(step.settleInitialMs);
  if (settleInitialMs != null) {
    action.settleInitialMs = settleInitialMs;
  }
  const settleMaxMs = toNumber(step.settleMaxMs);
  if (settleMaxMs != null) {
    action.settleMaxMs = settleMaxMs;
  }
  action.stabilizationDelayMs = toNumber(step.stabilizationDelayMs, 250);
  action.pageTransition = step.pageTransition || "same-tab";
  const navigationTarget = omit(
    {
      urlIncludes: trimText(step.navigationTarget?.urlIncludes),
      urlMatches: trimText(step.navigationTarget?.urlMatches),
      pathEquals: trimText(step.navigationTarget?.pathEquals),
      titleIncludes: trimText(step.navigationTarget?.titleIncludes),
    },
    ["urlIncludes", "urlMatches", "pathEquals", "titleIncludes"].filter(
      (key) => !trimText(step.navigationTarget?.[key]),
    ),
  );
  if (!isEmptyObject(navigationTarget)) {
    action.navigationTarget = navigationTarget;
  }

  const autoScroll = {
    maxSteps: toNumber(step.autoScroll?.maxSteps),
    deltaY: toNumber(step.autoScroll?.deltaY),
    settleMs: toNumber(step.autoScroll?.settleMs),
  };
  if (Object.values(autoScroll).some((value) => value != null)) {
    action.autoScroll = omit(autoScroll, Object.keys(autoScroll).filter((key) => autoScroll[key] == null));
  }

  const expectation = expectationToPayload(step.expectation);
  if (expectation) {
    action.expectation = expectation;
  }

  return action;
}

function draftToRuntimePayload(draft) {
  const actions = (draft?.steps || []).map(actionFromStep);
  if (actions.length <= 1) {
    return actions[0] || {};
  }
  return actions;
}

function stepFromAction(action = {}) {
  const rawType = action.type || action.kind;
  const isTopLevelAssertDom = rawType === "assertDom" || rawType === "expectDom";
  const type =
    rawType === "type"
      ? "fill"
      : isTopLevelAssertDom
        ? "capture"
      : rawType === "inspect"
        ? action.query || action.expectation || action.expect || action.expected
          ? "assertVisible"
          : "capture"
        : ACTION_TYPES.includes(rawType)
          ? rawType
          : "capture";
  const target = action.target && typeof action.target === "object" ? action.target : {};
  const step = createEmptyStep(type);
  step.id = action.id ? String(action.id) : step.id;
  step.stepTitle = action.stepTitle ?? action.displayTitle ?? action.label ?? "";

  step.query = String(action.url ?? action.query ?? target.name ?? target.text ?? target.query ?? target.placeholder ?? target.ariaLabel ?? target.title ?? "");
  if (type === "assertUrl" && !step.query) {
    step.query = String(action.urlIncludes ?? action.navigationTarget?.urlIncludes ?? action.pathEquals ?? action.titleIncludes ?? action.urlMatches ?? "");
  }
  step.value = String(action.key ?? action.keys ?? action.count ?? action.value ?? target.value ?? target.textValue ?? "");
  step.hintsText = asArray(action.hints ?? target.hints).join("\n");
  step.targetStrategy = target.strategy ?? "auto";
  step.targetName = target.name ?? "";
  step.role = target.role ?? "";
  step.locator = target.locator ?? "";
  step.placeholder = target.placeholder ?? "";
  step.ariaLabel = target.ariaLabel ?? "";
  step.title = target.title ?? "";
  step.testId = target.testId ?? "";
  step.nearText = target.nearText ?? "";
  step.targetScope = normalizeExpectationScope(target.scope);
  step.iconHint = target.iconHint ?? "";
  step.targetIndex = target.index ?? "";
  step.optionText = action.option?.text ?? action.optionText ?? "";
  step.optionValue = action.option?.value ?? action.optionValue ?? "";
  step.optionPathText = asArray(action.option?.path ?? action.option?.paths ?? action.optionPath ?? action.optionPathText).join(" / ");
  step.optionMatch = action.option?.match ?? action.optionMatch ?? "contains";
  step.optionIndex = action.option?.index ?? action.optionIndex ?? "";
  step.optionWaitTimeoutMs =
    action.optionWaitTimeoutMs ?? action.optionTimeoutMs ?? action.option?.waitTimeoutMs ?? "";
  step.optionPollIntervalMs =
    action.optionPollIntervalMs ?? action.optionIntervalMs ?? action.option?.pollIntervalMs ?? "";
  step.filesText = asArray(action.files)
    .map((item) => (typeof item === "string" ? item : item?.path || ""))
    .filter(Boolean)
    .join("\n") || splitLines(action.filesText).join("\n");
  step.uploadMode = action.mode === "input" || action.uploadMode === "input" ? "input" : "chooser";
  step.requestMethod = action.request?.method ?? action.method ?? "GET";
  step.requestUrl = action.request?.url ?? action.url ?? "";
  step.requestHeadersText = action.request?.headers ? JSON.stringify(action.request.headers, null, 2) : "";
  step.requestQueryText = action.request?.query ? JSON.stringify(action.request.query, null, 2) : "";
  step.requestBodyText = action.request?.body != null ? JSON.stringify(action.request.body, null, 2) : "";
  step.saveAs = action.saveAs ?? "";
  step.macro = action.macro ?? action.macroName ?? action.name ?? action.ref ?? "";
  step.needRes = action.needRes == null ? true : Boolean(action.needRes);
  step.timeoutMs = action.timeoutMs ?? 5000;
  step.retries = action.retries ?? action.retry ?? action.retryCount ?? 0;
  step.retryDelayMs = action.retryDelayMs ?? 320;
  step.strictMatch = action.strictMatch != null ? Boolean(action.strictMatch) : type === "assertVisible";
  step.enableScroll = Boolean(action.enableScroll ?? target.enableScroll);
  step.waitForNav = Boolean(action.waitForNav);
  step.waitForIdle = Boolean(action.waitForIdle);
  step.navigationBehavior = NAVIGATION_BEHAVIOR_OPTIONS.includes(action.navigationBehavior)
    ? action.navigationBehavior
    : "ignore";
  step.navigationTimeoutMs = action.navigationTimeoutMs ?? "";
  step.waitUntil = WAIT_UNTIL_OPTIONS.includes(action.waitUntil) ? action.waitUntil : "domcontentloaded";
  step.settleStrategy = action.settleStrategy === "adaptive" || action.settleStrategy === "fixed" ? action.settleStrategy : "";
  step.settleInitialMs = action.settleInitialMs ?? "";
  step.settleMaxMs = action.settleMaxMs ?? "";
  step.stabilizationDelayMs = action.stabilizationDelayMs ?? 250;
  step.pageTransition = action.pageTransition ?? "same-tab";
  step.navigationTarget = {
    urlIncludes: action.navigationTarget?.urlIncludes ?? "",
    urlMatches: action.navigationTarget?.urlMatches ?? "",
    pathEquals: action.navigationTarget?.pathEquals ?? "",
    titleIncludes: action.navigationTarget?.titleIncludes ?? "",
  };
  step.autoScroll = {
    maxSteps: action.autoScroll?.maxSteps ?? target.autoScroll?.maxSteps ?? "",
    deltaY: action.autoScroll?.deltaY ?? target.autoScroll?.deltaY ?? "",
    settleMs: action.autoScroll?.settleMs ?? target.autoScroll?.settleMs ?? "",
  };
  step.expectation = normalizeExpectation(
    isTopLevelAssertDom
      ? {
          kind: "assertDom",
          target: action.target,
          property: action.property,
          operator: action.operator ?? action.op ?? action.comparison,
          expected: action.expected,
          attribute: action.attribute ?? action.attributeName,
          saveAs: action.saveAs,
          timeoutMs: action.timeoutMs,
          intervalMs: action.intervalMs,
          visibleOnly: action.visibleOnly,
        }
      : action.expectation ?? action.expect ?? action.expected,
  );
  if (action.waitForChange) {
    step.expectation = expectationWithWaitForChange(step.expectation, action.waitForChangeTimeoutMs ?? "");
  }
  step.targetExtras = omit(target, [
    "text",
    "query",
    "value",
    "textValue",
    "name",
    "strategy",
    "role",
    "locator",
    "placeholder",
    "ariaLabel",
    "title",
    "testId",
    "nearText",
    "scope",
    "iconHint",
    "index",
    "hints",
    "enableScroll",
    "autoScroll",
  ]);
  step.rawExtras = omit(action, [
    "type",
    "kind",
    "action",
    "stepTitle",
    "displayTitle",
    "label",
    "target",
    "query",
    "value",
    "key",
    "keys",
    "count",
    "visibleOnly",
    "urlIncludes",
    "urlMatches",
    "pathEquals",
    "titleIncludes",
    "text",
    "hints",
    "needRes",
    "timeoutMs",
    "waitForChange",
    "waitForChangeTimeoutMs",
    "retries",
    "retry",
    "retryCount",
    "retryDelayMs",
    "strictMatch",
    "enableScroll",
    "autoScroll",
    "waitForNav",
    "waitForIdle",
    "navigationBehavior",
    "navigationTimeoutMs",
    "waitUntil",
    "settleStrategy",
    "settleInitialMs",
    "settleMaxMs",
    "stabilizationDelayMs",
    "pageTransition",
    "navigationTarget",
    "option",
    "optionText",
    "optionValue",
    "optionPath",
    "optionPathText",
    "optionMatch",
    "optionWaitTimeoutMs",
    "optionTimeoutMs",
    "optionPollIntervalMs",
    "optionIntervalMs",
    "files",
    "filesText",
    "mode",
    "uploadMode",
    "request",
    "method",
    "url",
    "headers",
    "query",
    "body",
    "saveAs",
    "macro",
    "macroName",
    "ref",
    "expectation",
    "expect",
    "expected",
  ]);
  if (isTopLevelAssertDom) {
    [
      "property",
      "operator",
      "op",
      "comparison",
      "expected",
      "attribute",
      "attributeName",
    ].forEach((key) => {
      delete step.rawExtras[key];
    });
  }
  return step;
}

function runtimePayloadToDraft(raw) {
  const payload = parseLooseJson(raw);
  const actions = Array.isArray(payload) ? payload : [payload];
  return {
    steps: actions.map(stepFromAction),
  };
}

function createDraftFromTemplate(template) {
  return runtimePayloadToDraft(clone(template));
}

const DEFAULT_DRAFT_TEMPLATE = [
  {
    type: "click",
    target: {
      text: "账号登陆",
    },
    needRes: true,
    timeoutMs: 5000,
    retries: 0,
    retryDelayMs: 320,
    strictMatch: false,
    enableScroll: false,
    waitForNav: false,
    waitForIdle: false,
    navigationBehavior: "ignore",
    waitUntil: "domcontentloaded",
    stabilizationDelayMs: 250,
  },
  {
    type: "type",
    target: {
      text: "账号",
      value: "DEMO_USER",
    },
    needRes: true,
    timeoutMs: 5000,
    retries: 0,
    retryDelayMs: 320,
    strictMatch: false,
    enableScroll: false,
    waitForNav: false,
    waitForIdle: false,
    navigationBehavior: "ignore",
    waitUntil: "domcontentloaded",
    stabilizationDelayMs: 250,
  },
  {
    type: "type",
    target: {
      text: "密码",
      value: "demo-password-not-valid",
    },
    needRes: true,
    timeoutMs: 5000,
    retries: 0,
    retryDelayMs: 320,
    strictMatch: false,
    enableScroll: false,
    waitForNav: false,
    waitForIdle: false,
    navigationBehavior: "ignore",
    waitUntil: "domcontentloaded",
    stabilizationDelayMs: 250,
  },
  {
    type: "click",
    target: {
      text: "登 录",
    },
    needRes: true,
    timeoutMs: 5000,
    retries: 0,
    retryDelayMs: 320,
    strictMatch: false,
    enableScroll: false,
    waitForNav: false,
    waitForIdle: false,
    navigationBehavior: "required",
    navigationTimeoutMs: 8000,
    waitUntil: "domcontentloaded",
    stabilizationDelayMs: 250,
    navigationTarget: {
      titleIncludes: "",
      urlIncludes: "",
      urlMatches: "",
      pathEquals: "",
    },
    expectation: {
      kind: "text-exists",
      text: ["入驻店铺订单"],
      timeoutMs: 6000,
    },
  },
];

function createDefaultDraft() {
  return createDraftFromTemplate(DEFAULT_DRAFT_TEMPLATE);
}

function firstDisplayLine(value) {
  return splitLines(value)[0] || trimText(value);
}

function getStepDisplayTitle(step) {
  const explicitTitle = trimText(step?.stepTitle);
  if (explicitTitle) {
    return explicitTitle;
  }
  if (step?.type === "cascaderSelect") {
    return (
      firstDisplayLine(step.optionPathText) ||
      trimText(step.optionText) ||
      trimText(step.optionValue) ||
      trimText(step.targetName) ||
      trimText(step.placeholder) ||
      "Cascader select"
    );
  }
  if (step?.type === "comboSearchSelect") {
    return (
      trimText(step.optionText) ||
      trimText(step.optionValue) ||
      trimText(step.query) ||
      trimText(step.targetName) ||
      trimText(step.placeholder) ||
      "Search select"
    );
  }
  if (step?.type === "uploadFile") {
    return firstDisplayLine(step.filesText) || trimText(step.query) || "Upload file";
  }
  if (step?.type === "press") {
    return trimText(step.value) || "Press key";
  }
  if (step?.type === "selectOption") {
    return trimText(step.optionText) || trimText(step.optionValue) || trimText(step.value) || "Select option";
  }
  if (step?.type === "assertUrl") {
    return trimText(step.query) || trimText(step.navigationTarget?.urlIncludes) || "Check URL";
  }
  if (step?.type === "assertCount") {
    return `${trimText(step.value) || "0"} matches`;
  }
  if (step?.type === "callApi") {
    return `${trimText(step.requestMethod) || "GET"} ${trimText(step.requestUrl) || "API request"}`;
  }
  if (step?.type === "useMacro") {
    return trimText(step.macro) || "Macro";
  }
  if (step?.type === "capture") {
    return trimText(step.query) || "Capture evidence";
  }
  return (
    trimText(step?.query) ||
    trimText(step?.targetName) ||
    trimText(step?.placeholder) ||
    trimText(step?.ariaLabel) ||
    trimText(step?.title) ||
    trimText(step?.testId) ||
    step?.type ||
    "Untitled step"
  );
}

function summarizeDraftActions(draft) {
  return (draft?.steps || []).map((step, index) => {
    const bits = [];
    if (step.navigationBehavior && step.navigationBehavior !== "ignore") {
      bits.push(`nav=${step.navigationBehavior}`);
    }
    if (step.retries) {
      bits.push(`retries=${step.retries}`);
    }
    if (step.expectation?.mode && step.expectation.mode !== "none") {
      bits.push(`expect=${step.expectation.mode}`);
    }
    return {
      id: step.id || `${index + 1}`,
      title: `${index + 1}. ${step.type} -> ${getStepDisplayTitle(step)}`,
      meta: bits.join(" | ") || "No extra modifiers.",
    };
  });
}

function validateDraft(draft) {
  const errors = [];
  (draft?.steps || []).forEach((step, index) => {
    const hasTarget =
      trimText(step.query) ||
      trimText(step.targetName) ||
      trimText(step.role) ||
      trimText(step.locator) ||
      trimText(step.placeholder) ||
      trimText(step.ariaLabel) ||
      trimText(step.title) ||
      trimText(step.testId) ||
      trimText(step.nearText) ||
      trimText(step.iconHint);
    if (!hasTarget && !["capture", "press", "assertUrl", "callApi", "useMacro", "openUrl", "reload", "goBack", "goForward", "scroll", "waitForText", "waitForNav", "waitForIdle"].includes(step.type)) {
      errors.push(
        `Step ${index + 1}: target is required; provide target text/query, name, placeholder, testId, ariaLabel, title, locator, or iconHint with context.`,
      );
    }
    if (step.type === "openUrl" && !trimText(step.query)) {
      errors.push(`Step ${index + 1}: URL is required for openUrl actions.`);
    }
    if (step.type === "fill" && !String(step.value ?? "").length) {
      errors.push(`Step ${index + 1}: value is required for fill actions.`);
    }
    if (step.type === "press" && !trimText(step.value)) {
      errors.push(`Step ${index + 1}: key is required for press actions.`);
    }
    if (step.type === "selectOption" && !trimText(step.value) && !trimText(step.optionText) && !trimText(step.optionValue)) {
      errors.push(`Step ${index + 1}: option text or value is required for select option actions.`);
    }
    if (step.type === "assertUrl" && !trimText(step.query) && !trimText(step.navigationTarget?.urlIncludes) && !trimText(step.navigationTarget?.urlMatches) && !trimText(step.navigationTarget?.pathEquals) && !trimText(step.navigationTarget?.titleIncludes)) {
      errors.push(`Step ${index + 1}: URL expectation is required for assertUrl actions.`);
    }
    if (step.type === "assertCount" && toNumber(step.value) == null) {
      errors.push(`Step ${index + 1}: expected count is required for assertCount actions.`);
    }
    if (step.type === "callApi" && !trimText(step.requestUrl)) {
      errors.push(`Step ${index + 1}: request URL is required for callApi actions.`);
    }
    if (step.type === "useMacro" && !trimText(step.macro)) {
      errors.push(`Step ${index + 1}: macro name is required for useMacro actions.`);
    }
    if (step.type === "comboSearchSelect") {
      if (!trimText(step.optionText) && !trimText(step.optionValue)) {
        errors.push(`Step ${index + 1}: option text or value is required for search select actions.`);
      }
    }
    if (step.type === "cascaderSelect") {
      if (!trimText(step.optionPathText) && !trimText(step.optionText) && !trimText(step.optionValue)) {
        errors.push(`Step ${index + 1}: option path or option text is required for cascader select actions.`);
      }
    }
    if (step.type === "uploadFile" && !splitLines(step.filesText).length) {
      errors.push(`Step ${index + 1}: at least one file path is required for upload actions.`);
    }
    if (
      step.expectation?.mode === "region-similar" &&
      !trimText(step.expectation.reference)
    ) {
      errors.push(`Step ${index + 1}: region-similar expects a reference data URL.`);
    }
  });
  return errors;
}

function hasExpectationScope(scope) {
  return Object.values(scopeToPayload(scope)).some(Boolean);
}

function isHighReuseExpectationText(text) {
  const value = trimText(text);
  if (!value) {
    return false;
  }
  const commonTexts = new Set([
    "搜索",
    "重置",
    "确定",
    "取消",
    "保存",
    "提交",
    "新增",
    "删除",
    "添加图片",
    "请选择",
    "请输入",
  ]);
  return (
    commonTexts.has(value) ||
    value.length <= 2 ||
    /^请选择/.test(value) ||
    /^请输入/.test(value) ||
    value.includes("搜索") ||
    value.includes("请选择或搜索")
  );
}

function isSubmitLikeStep(step = {}) {
  const text = [
    step.query,
    step.targetName,
    step.placeholder,
    step.ariaLabel,
    step.title,
    step.stepTitle,
  ].map(trimText).join(" ");
  return /保存|提交|确认|确定|新增|创建|完成|上传|save|submit|confirm|create|upload/i.test(text);
}

function hasOnlyWaitForChangeExpectation(expectation) {
  if (!expectation || expectation.mode === "none") {
    return false;
  }
  if (expectation.mode === "waitForChange") {
    return true;
  }
  if (expectation.mode !== "composite") {
    return false;
  }
  const assertions = expectation.assertions || [];
  return assertions.length > 0 && assertions.every((item) => item.mode === "waitForChange");
}

function pushWarning(warnings, code, step, stepIndex, path, message) {
  warnings.push({
    code,
    severity: "warning",
    stepId: step.id || null,
    stepIndex,
    path,
    message,
  });
}

function hasScopedDraftExpectation(expectation = {}) {
  if (expectation.scope?.testId || expectation.scope?.locator || expectation.scope?.role || expectation.scope?.nearText) {
    return true;
  }
  return (expectation.assertions || []).some((item) => hasScopedDraftExpectation(item));
}

function hasStrongDraftExpectation(expectation = {}) {
  if (expectation.mode === "assertDom") {
    return true;
  }
  if (
    ["networkResponse", "assertResponse"].includes(expectation.mode) &&
    (expectation.rawExtras?.urlIncludes || expectation.rawExtras?.urlMatches || expectation.rawExtras?.request?.url)
  ) {
    return true;
  }
  if (["text-exists", "text-absent"].includes(expectation.mode) && hasScopedDraftExpectation(expectation)) {
    return true;
  }
  return (expectation.assertions || []).some((item) => hasStrongDraftExpectation(item));
}

function hasFollowingUploadEvidence(steps, stepIndex) {
  for (let index = stepIndex + 1; index < Math.min(steps.length, stepIndex + 7); index += 1) {
    const nextStep = steps[index];
    if (nextStep.type === "uploadFile") {
      continue;
    }
    return hasStrongDraftExpectation(nextStep.expectation);
  }
  return false;
}

function collectStepShapeWarnings(step, stepIndex, warnings, steps = []) {
  if (
    hasOnlyWaitForChangeExpectation(step.expectation) &&
    (["uploadFile"].includes(step.type) || (step.type === "click" && isSubmitLikeStep(step))) &&
    !(step.type === "uploadFile" && hasFollowingUploadEvidence(steps, stepIndex))
  ) {
    pushWarning(
      warnings,
      "wait-for-change-only-risk",
      step,
      stepIndex,
      "expectation",
      `Step ${stepIndex + 1}: waitForChange only proves pixels changed; use assertDom, networkResponse, or callApi/assertResponse as business evidence.`,
    );
  }

  if (step.type === "comboSearchSelect") {
    if (step.role && step.role !== "combobox") {
      pushWarning(
        warnings,
        "combo-search-select-role-risk",
        step,
        stepIndex,
        "target.role",
        `Step ${stepIndex + 1}: comboSearchSelect should use role=combobox for AntD/CJ search select controls.`,
      );
    }
    if (
      !trimText(step.testId) &&
      !trimText(step.locator) &&
      !trimText(step.ariaLabel) &&
      !trimText(step.title) &&
      !trimText(step.placeholder) &&
      !trimText(step.targetName) &&
      !trimText(step.nearText)
    ) {
      pushWarning(
        warnings,
        "combo-search-select-target-risk",
        step,
        stepIndex,
        "target",
        `Step ${stepIndex + 1}: comboSearchSelect should include placeholder, target name, or nearText to avoid opening the wrong select.`,
      );
    }
    if (!trimText(step.optionText) && !trimText(step.optionValue) && !trimText(step.optionPathText)) {
      pushWarning(
        warnings,
        "combo-search-select-option-risk",
        step,
        stepIndex,
        "option",
        `Step ${stepIndex + 1}: comboSearchSelect should include option text or value.`,
      );
    }
  }

  if (step.type === "cascaderSelect" && !trimText(step.optionPathText)) {
    pushWarning(
      warnings,
      "cascader-option-path-risk",
      step,
      stepIndex,
      "option.path",
      `Step ${stepIndex + 1}: cascaderSelect should use option.path[] so multi-level AntD/CJ choices are deterministic.`,
    );
  }

  if (
    step.type === "click" &&
    (step.role === "option" || /请选择|请选择或搜索|select|combobox|下拉|级联|cascader/i.test(`${step.placeholder} ${step.targetName} ${step.nearText} ${step.stepTitle}`))
  ) {
    pushWarning(
      warnings,
      "antd-select-click-risk",
      step,
      stepIndex,
      "type",
      `Step ${stepIndex + 1}: AntD/CJ select-like controls should use comboSearchSelect instead of click + text.`,
    );
  }
}

function collectExpectationWarnings(expectation, step, stepIndex, warnings, pathLabel = "expectation") {
  if (!expectation || expectation.mode === "none") {
    return;
  }
  if (expectation.mode === "composite") {
    (expectation.assertions || []).forEach((assertion, assertionIndex) => {
      collectExpectationWarnings(assertion, step, stepIndex, warnings, `${pathLabel}.assertions[${assertionIndex}]`);
    });
    return;
  }
  if (expectation.mode === "assertDom") {
    const rawTarget = expectation.rawExtras?.target || {};
    const hasStableTarget = rawTarget.locator || rawTarget.testId || rawTarget.role || rawTarget.placeholder || rawTarget.ariaLabel || rawTarget.title;
    if (!hasStableTarget) {
      warnings.push({
        code: "assert-dom-target-risk",
        severity: "warning",
        stepId: step.id || null,
        stepIndex,
        path: pathLabel,
        message: `Step ${stepIndex + 1}: assertDom should use a stable target such as locator, testId, role, placeholder, ariaLabel, or title.`,
      });
    }
    const usesOnlyText = rawTarget.text && !rawTarget.locator && !rawTarget.testId && !rawTarget.role;
    const lacksRowFilter = !rawTarget.hasText && !rawTarget.hasTexts;
    if (usesOnlyText && lacksRowFilter) {
      warnings.push({
        code: "assert-dom-table-row-scope-risk",
        severity: "warning",
        stepId: step.id || null,
        stepIndex,
        path: pathLabel,
        message: `Step ${stepIndex + 1}: assertDom table/list checks should use locator/testId/role plus hasText or hasTexts instead of text-only target.`,
      });
    }
    return;
  }
  if (expectation.mode === "networkResponse") {
    if (!expectation.rawExtras?.urlIncludes && !expectation.rawExtras?.urlMatches) {
      warnings.push({
        code: "network-response-url-required",
        severity: "warning",
        stepId: step.id || null,
        stepIndex,
        path: pathLabel,
        message: `Step ${stepIndex + 1}: networkResponse should include urlIncludes or urlMatches to avoid matching the wrong response.`,
      });
    }
    return;
  }
  if (expectation.mode === "waitForChange") {
    return;
  }
  if (expectation.mode !== "text-absent" || hasExpectationScope(expectation.scope)) {
    return;
  }
  const riskyTexts = splitHints(expectation.textsText).filter(isHighReuseExpectationText);
  if (!riskyTexts.length) {
    return;
  }
  warnings.push({
    code: "unscoped-text-absent-risk",
    severity: "warning",
    stepId: step.id || null,
    stepIndex,
    path: pathLabel,
    message: `Step ${stepIndex + 1}: text-absent checks high-reuse text "${riskyTexts.join(", ")}" without scope; it may be misjudged, consider adding expectation.scope.`,
  });
}

function getDraftWarnings(draft) {
  const warnings = [];
  (draft?.steps || []).forEach((step, index) => {
    collectStepShapeWarnings(step, index, warnings, draft.steps || []);
    collectExpectationWarnings(step.expectation, step, index, warnings);
  });
  return warnings;
}

module.exports = {
  ACTION_TYPES,
  COMMON_TEXT_EXPECTATIONS,
  ADVANCED_EXPECTATIONS,
  NAVIGATION_BEHAVIOR_OPTIONS,
  WAIT_UNTIL_OPTIONS,
  createEmptyStep,
  createEmptyExpectation,
  createDefaultDraft,
  createDraftFromTemplate,
  draftToRuntimePayload,
  runtimePayloadToDraft,
  getStepDisplayTitle,
  summarizeDraftActions,
  validateDraft,
  getDraftWarnings,
  parseLooseJson,
};
