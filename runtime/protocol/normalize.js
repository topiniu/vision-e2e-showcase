const { randomUUID } = require("node:crypto");

function coercePayload(raw) {
  if (raw == null) {
    throw createInputError("Message payload is empty.");
  }
  if (typeof raw === "object") {
    return raw;
  }
  if (typeof raw !== "string") {
    throw createInputError("Message payload must be a string or object.");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw createInputError("Message payload is empty.");
  }
  try {
    return JSON.parse(trimmed);
  } catch (_jsonError) {
    const normalizedKeys = trimmed.replace(
      /(['"])?([a-zA-Z0-9_$]+)\1\s*:/g,
      '"$2":',
    );
    const normalizedStrings = normalizedKeys.replace(
      /'([^']*)'/g,
      (_match, group) => `"${group.replace(/"/g, '\\"')}"`,
    );
    return JSON.parse(normalizedStrings);
  }
}

function toArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function toNumber(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

const ACTION_DEFINITIONS = {
  click: { needsTarget: true, mutatesPage: true },
  hover: { needsTarget: true, mutatesPage: false },
  press: { needsTarget: false, mutatesPage: true },
  fill: { needsTarget: true, mutatesPage: true },
  check: { needsTarget: true, mutatesPage: true },
  uncheck: { needsTarget: true, mutatesPage: true },
  selectOption: { needsTarget: true, mutatesPage: true },
  assertVisible: { needsTarget: true, mutatesPage: false },
  assertUrl: { needsTarget: false, mutatesPage: false },
  assertCount: { needsTarget: false, mutatesPage: false },
  callApi: { needsTarget: false, mutatesPage: false },
  capture: { needsTarget: false, mutatesPage: false },
  comboSearchSelect: { needsTarget: true, mutatesPage: true },
  cascaderSelect: { needsTarget: true, mutatesPage: true },
  uploadFile: { needsTarget: true, mutatesPage: true, needsFiles: true },
  openUrl: { needsTarget: false, mutatesPage: true },
  reload: { needsTarget: false, mutatesPage: true },
  goBack: { needsTarget: false, mutatesPage: true },
  goForward: { needsTarget: false, mutatesPage: true },
  scroll: { needsTarget: false, mutatesPage: true },
  waitForText: { needsTarget: false, mutatesPage: false },
  waitForNav: { needsTarget: false, mutatesPage: false },
  waitForIdle: { needsTarget: false, mutatesPage: false },
  // v1.11 REQ-Z31: installs a request interception for the rest of the run.
  routeFault: { needsTarget: false, mutatesPage: false },
};

function normalizeKind(rawKind, input, query) {
  if (rawKind === "browser.openUrl") {
    return "openUrl";
  }
  if (rawKind === "browser.reload") {
    return "reload";
  }
  if (rawKind === "browser.goBack") {
    return "goBack";
  }
  if (rawKind === "browser.goForward") {
    return "goForward";
  }
  if (rawKind === "type") {
    return "fill";
  }
  if (rawKind === "select" || rawKind === "select.option") {
    return "selectOption";
  }
  if (rawKind === "assert.url" || rawKind === "expectUrl") {
    return "assertUrl";
  }
  if (rawKind === "assert.count" || rawKind === "expectCount") {
    return "assertCount";
  }
  if (rawKind === "api.call" || rawKind === "http.request") {
    return "callApi";
  }
  if (rawKind === "inspect") {
    return query || input.expectation || input.expect || input.expected
      ? "assertVisible"
      : "capture";
  }
  if (rawKind === "assertDom" || rawKind === "expectDom") {
    return "capture";
  }
  // v1.5: assertion-only steps that touch no element reuse the no-op `capture`
  // action path and carry their verdict entirely in the expectation, exactly the
  // way `assertDom` already does.
  if (
    rawKind === "assertNoPageError" ||
    rawKind === "expectNoPageError" ||
    rawKind === "assertFile" ||
    rawKind === "assertPerf" ||
    rawKind === "assertConsistency" ||
    rawKind === "assertVisual" ||
    rawKind === "assertVisualPeers" ||
    rawKind === "assertResidue" ||
    // v1.11 REQ-Z32
    rawKind === "assertLayout"
  ) {
    return "capture";
  }
  if (rawKind === "cascader" || rawKind === "cascader.select") {
    return "cascaderSelect";
  }
  return rawKind;
}

function isSafeRelativeAssetPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const text = value.trim();
  if (
    text.includes("\0") ||
    text.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(text)
  ) {
    return false;
  }
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    return false;
  }
  return parts[0] === "test-assets" || parts[0] === "test-workflows";
}

function normalizeFiles(input, kind) {
  const files = toArray(input.files ?? input.file ?? input.path)
    .map((item) => {
      if (typeof item === "string") {
        return { path: item.trim() };
      }
      if (item && typeof item === "object") {
        return {
          ...item,
          path: trimText(item.path),
          kind: trimText(item.kind),
          mimeType: trimText(item.mimeType),
        };
      }
      return null;
    })
    .filter(Boolean);

  if (kind !== "uploadFile") {
    return files;
  }
  if (!files.length) {
    throw createInputError("uploadFile requires at least one file.");
  }
  for (const file of files) {
    if (!isSafeRelativeAssetPath(file.path)) {
      throw createInputError(
        `uploadFile path must be relative and start with test-assets/ or test-workflows/: ${file.path}`,
      );
    }
  }
  return files;
}

function normalizeOption(value = {}) {
  const source = value && typeof value === "object" ? value : { text: value };
  const match = ["exact", "contains", "startsWith", "fuzzy"].includes(source.match)
    ? source.match
    : "contains";
  const path = toArray(source.path ?? source.paths ?? source.pathText)
    .flatMap((item) =>
      typeof item === "string" ? item.split(/\r?\n|[>/]|→|›/) : [item],
    )
    .map((item) => trimText(item))
    .filter(Boolean);
  return {
    text: trimText(source.text),
    value: trimText(source.value),
    match,
    index: Number.isInteger(source.index) ? source.index : null,
    path,
  };
}

function normalizeTarget(target, query, fallbackScope = null) {
  const source = target && typeof target === "object" ? target : {};
  return {
    ...source,
    strategy: trimText(source.strategy) || "auto",
    text: trimText(source.text || source.query || query),
    name: trimText(source.name || source.text || source.query || query),
    role: trimText(source.role),
    locator: trimText(source.locator),
    placeholder: trimText(source.placeholder),
    ariaLabel: trimText(source.ariaLabel),
    title: trimText(source.title),
    testId: trimText(source.testId),
    nearText: trimText(source.nearText),
    hasText: trimText(source.hasText),
    hasTexts: normalizeTextList(source.hasTexts ?? source.hasText),
    tagText: trimText(source.tagText),
    tagTexts: normalizeTextList(source.tagTexts ?? source.tagText),
    tagMatch: trimText(source.tagMatch) || "exact",
    iconHint: trimText(source.iconHint),
    index: Number.isInteger(source.index) ? source.index : null,
    scope: normalizeScope(source.scope ?? fallbackScope),
  };
}

function normalizeNavigationTarget(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const target = {
    urlIncludes: trimText(value.urlIncludes),
    urlMatches: trimText(value.urlMatches),
    pathEquals: trimText(value.pathEquals),
    titleIncludes: trimText(value.titleIncludes),
  };
  return Object.values(target).some(Boolean) ? target : null;
}

function normalizeScope(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const scope = {
    nearText: trimText(value.nearText),
    role: trimText(value.role),
    locator: trimText(value.locator),
    testId: trimText(value.testId),
  };
  return Object.values(scope).some(Boolean) ? scope : null;
}

function normalizeTextList(value) {
  return toArray(value)
    .flatMap((item) => {
      if (typeof item === "string") {
        return item.split(/\r?\n|[,;|/]/);
      }
      if (item && typeof item === "object" && typeof item.text === "string") {
        return [item.text];
      }
      if (item == null) {
        return [];
      }
      return [String(item)];
    })
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEvidenceProfile(value, fallback = "debug") {
  const text = trimText(value).toLowerCase();
  if (["debug", "fast", "turbo"].includes(text)) {
    return text;
  }
  if (text === "default" || text === "full") {
    return "debug";
  }
  return fallback;
}

function normalizeSettleStrategy(value, evidenceProfile) {
  const text = trimText(value).toLowerCase();
  if (text === "adaptive" || text === "fixed") {
    return text;
  }
  return evidenceProfile === "fast" || evidenceProfile === "turbo" ? "adaptive" : "fixed";
}

function normalizeRequest(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const headers = source.headers && typeof source.headers === "object" && !Array.isArray(source.headers)
    ? { ...source.headers }
    : {};
  const query = source.query && typeof source.query === "object" && !Array.isArray(source.query)
    ? { ...source.query }
    : {};
  return {
    method: trimText(source.method || "GET").toUpperCase(),
    url: trimText(source.url),
    headers,
    query,
    body: source.body ?? null,
    autoAuth: source.autoAuth === false ? false : true,
    authHeader: trimText(source.authHeader || source.authHeaderName),
    authStorageKey: trimText(source.authStorageKey || source.localStorageKey),
    auth: source.auth && typeof source.auth === "object" && !Array.isArray(source.auth)
      ? {
          header: trimText(source.auth.header || source.auth.headerName),
          localStorageKey: trimText(source.auth.localStorageKey || source.auth.storageKey),
          scheme: trimText(source.auth.scheme),
        }
      : null,
  };
}

function normalizeBodyAssertions(value) {
  return toArray(value)
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      return {
        path: trimText(item.path),
        operator: trimText(item.operator || item.op || item.comparison || "equals") || "equals",
        expected: item.expected,
        saveAs: trimText(item.saveAs),
        // REQ-Z14: keep the "capture the first match as a scalar" switch — the
        // normalizer strips unknown keys, so it must be whitelisted here too.
        first: item.first === true || item.saveAsScalar === true,
      };
    })
    .filter((item) => item && item.path);
}

function isEmptyPlainObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function normalizeExpectation(payload) {
  let raw =
    payload?.expectation ?? payload?.expect ?? payload?.expected ?? null;
  const rawKind = payload?.kind || payload?.type || payload?.action || payload?.assertion || "";
  if (rawKind === "assertDom" || rawKind === "expectDom") {
    raw = {
      kind: "assertDom",
      target: payload.target,
      property: payload.property,
      operator: payload.operator || payload.op || payload.comparison,
      expected: payload.expected,
      attribute: payload.attribute || payload.attributeName,
      saveAs: payload.saveAs,
      timeoutMs: payload.timeoutMs,
      intervalMs: payload.intervalMs,
      visibleOnly: payload.visibleOnly,
    };
  }
  // v1.5: assertion-only step kinds carry their whole contract at the top level
  // of the step object (that is what makes them readable in a test file), so the
  // expectation is synthesized from the step itself — same trick `assertDom`
  // above uses. Done before the empty-object check so a step with no explicit
  // `expectation` block still produces one.
  if (rawKind === "assertNoPageError" || rawKind === "expectNoPageError") {
    raw = { kind: "assertNoPageError", since: payload.since || null };
  }
  if (rawKind === "assertFile") {
    raw = {
      kind: "assertFile",
      source: payload.source ?? null,
      expectation: payload.expectation ?? null,
      waitForDownload: payload.waitForDownload ?? null,
      timeoutMs: payload.timeoutMs,
    };
  }
  if (rawKind === "assertResidue") {
    raw = {
      kind: "assertResidue",
      atMost: payload.atMost,
      baselineGuard: payload.baselineGuard,
    };
  }
  if (rawKind === "assertVisual") {
    raw = {
      kind: "assertVisual",
      target: payload.target ?? null,
      baseline: payload.baseline ?? null,
      profile: payload.profile ?? null,
      mask: payload.mask ?? null,
      expectation: payload.expectation ?? null,
      maxDiffRatio: payload.maxDiffRatio,
      onMissingBaseline: payload.onMissingBaseline ?? null,
    };
  }
  if (rawKind === "assertVisualPeers") {
    raw = {
      kind: "assertVisualPeers",
      target: payload.target ?? null,
      peers: payload.peers ?? payload.visualPeers ?? null,
      mustMatch: payload.mustMatch ?? null,
    };
  }
  // v1.11 REQ-Z32: the layout verdict, measured from rendered boxes.
  if (rawKind === "assertLayout") {
    raw = {
      kind: "assertLayout",
      target: payload.target ?? null,
      items: payload.items ?? null,
      noOverlap: payload.noOverlap,
      noTruncation: payload.noTruncation ?? payload.truncation,
      withinTarget: payload.withinTarget,
      minItems: payload.minItems,
      expectCount: payload.expectCount,
      tolerancePx: payload.tolerancePx,
      timeoutMs: payload.timeoutMs,
    };
  }
  if (rawKind === "assertConsistency") {
    raw = {
      kind: "assertConsistency",
      subject: payload.subject ?? null,
      probes: payload.probes ?? null,
      allEqual: payload.expectation?.allEqual,
      normalize: payload.expectation?.normalize ?? payload.normalize ?? null,
    };
  }
  if (rawKind === "assertPerf") {
    raw = {
      kind: "assertPerf",
      metric: payload.metric ?? null,
      atMost: payload.atMost,
      atLeast: payload.atLeast,
      equals: payload.equals,
      target: payload.target ?? null,
      baseline: payload.baseline ?? null,
      toleranceRatio: payload.toleranceRatio,
      saveAs: payload.saveAs ?? null,
      timeoutMs: payload.timeoutMs,
    };
  }
  if (isEmptyPlainObject(raw)) {
    raw = null;
  }
  const waitForChangeTimeoutMs = toNumber(
    payload?.waitForChangeTimeoutMs,
    toNumber(payload?.timeoutMs, 5000),
  );
  if (!raw && !payload?.waitForChange) {
    return null;
  }
  if (!raw && payload?.waitForChange) {
    return {
      kind: "waitForChange",
      texts: [],
      timeoutMs: waitForChangeTimeoutMs,
      intervalMs: null,
      scope: null,
    };
  }
  if (typeof raw === "string" || Array.isArray(raw)) {
    const expectation = {
      kind: "text-exists",
      texts: normalizeTextList(raw),
      timeoutMs: null,
      intervalMs: null,
      scope: null,
    };
    if (!payload?.waitForChange) {
      return expectation;
    }
    return {
      kind: "composite",
      assertions: [
        {
          kind: "waitForChange",
          timeoutMs: waitForChangeTimeoutMs,
        },
        expectation,
      ],
      raw,
    };
  }
  if (typeof raw === "object") {
    const scope = normalizeScope(raw.scope ?? raw.within);
    const expectation = {
      kind:
        raw.kind ||
        raw.type ||
        (raw.mode === "no-text" ? "text-absent" : "text-exists"),
      texts: normalizeTextList(raw.texts ?? raw.text ?? raw.query ?? raw.queries),
      timeoutMs: toNumber(raw.timeoutMs),
      intervalMs: toNumber(raw.intervalMs),
      threshold: toNumber(raw.threshold),
      region: raw.region ?? null,
      reference: raw.reference ?? null,
      urlIncludes: trimText(raw.urlIncludes),
      urlMatches: trimText(raw.urlMatches),
      pathEquals: trimText(raw.pathEquals),
      titleIncludes: trimText(raw.titleIncludes),
      target: raw.target && typeof raw.target === "object" ? raw.target : null,
      count: Number.isInteger(raw.count) ? raw.count : toNumber(raw.count),
      operator: trimText(raw.operator || raw.op || raw.comparison),
      visibleOnly: raw.visibleOnly == null ? true : Boolean(raw.visibleOnly),
      property: trimText(raw.property),
      expected: raw.expected,
      attribute: trimText(raw.attribute || raw.attributeName),
      saveAs: trimText(raw.saveAs),
      status: Number.isInteger(raw.status) ? raw.status : toNumber(raw.status),
      method: trimText(raw.method).toUpperCase(),
      body: normalizeBodyAssertions(raw.body ?? raw.json ?? raw.bodyAssertions),
      assertions: Array.isArray(raw.assertions) ? raw.assertions : null,
      scope,
      raw,
    };
    if (!payload?.waitForChange) {
      return expectation;
    }
    return {
      kind: "composite",
      assertions: [
        {
          kind: "waitForChange",
          timeoutMs: waitForChangeTimeoutMs,
        },
        expectation,
      ],
      raw,
    };
  }
  return null;
}

function normalizeAction(input, index = 0, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createInputError(`Action at index ${index} must be an object.`);
  }

  const rawKind =
    input.kind ||
    input.type ||
    input.action ||
    input.assertion ||
    "inspect";
  const target = input.target && typeof input.target === "object" ? input.target : {};
  const explicitQuery =
    typeof input.query === "string"
      ? input.query.trim()
      : typeof input.searchQuery === "string"
        ? input.searchQuery.trim()
        : typeof input.searchText === "string"
          ? input.searchText.trim()
          : typeof input.filterText === "string"
            ? input.filterText.trim()
            : "";
  const targetQuery =
    typeof target.name === "string"
      ? target.name.trim()
      : typeof target.text === "string"
        ? target.text.trim()
        : typeof target.query === "string"
          ? target.query.trim()
          : typeof target.ariaLabel === "string"
            ? target.ariaLabel.trim()
            : typeof target.title === "string"
              ? target.title.trim()
              : "";
  const query = explicitQuery || targetQuery;
  const kind = normalizeKind(rawKind, input, query);
  const normalizedTarget = normalizeTarget(
    target,
    kind === "comboSearchSelect" || kind === "cascaderSelect" ? "" : query,
    input.targetScope,
  );
  const files = normalizeFiles(input, kind);
  const option = normalizeOption(input.option ?? {
    text: input.optionText,
    value: input.optionValue,
    match: input.optionMatch,
  });
  const actionDefinition =
    ACTION_DEFINITIONS[kind] || { needsTarget: false, mutatesPage: false };
  const valueCandidate =
    input.value ??
    input.text ??
    input.textValue ??
    input.key ??
    input.keys ??
    input.optionText ??
    input.optionValue ??
    target.value ??
    target.textValue ??
    null;
  const hints = normalizeTextList([
    ...(toArray(input.hints)),
    ...(toArray(target.hints)),
  ]);

  const retriesRaw =
    Number.isInteger(input.retry) && input.retry >= 0
      ? input.retry
      : Number.isInteger(input.retries) && input.retries >= 0
        ? input.retries
        : Number.isInteger(input.retryCount) && input.retryCount >= 0
          ? input.retryCount
          : 0;

  const needRes =
    input.needRes == null
      ? ["click", "hover", "press", "fill", "check", "uncheck", "selectOption", "assertVisible", "assertUrl", "assertCount", "callApi", "capture", "comboSearchSelect", "cascaderSelect", "uploadFile"].includes(kind)
      : Boolean(input.needRes);

  const strictMatch =
    input.strictMatch != null
      ? Boolean(input.strictMatch)
      : kind === "assertVisible";
  const timeoutMs = toNumber(input.timeoutMs, 5000);
  const optionWaitTimeoutMs = toNumber(
    input.optionWaitTimeoutMs ?? input.optionTimeoutMs ?? input.option?.waitTimeoutMs,
    timeoutMs,
  );
  const optionPollIntervalMs = Math.max(
    50,
    toNumber(
      input.optionPollIntervalMs ?? input.optionIntervalMs ?? input.option?.pollIntervalMs,
      200,
    ),
  );
  const evidenceProfile = normalizeEvidenceProfile(
    input.evidenceProfile ?? input.runProfile ?? input.profile,
    normalizeEvidenceProfile(options.evidenceProfile ?? options.runProfile ?? options.profile, "debug"),
  );
  const settleStrategy = normalizeSettleStrategy(input.settleStrategy, evidenceProfile);

  return {
    id: input.id || `step-${index + 1}-${randomUUID().slice(0, 8)}`,
    index,
    raw: input,
    kind,
    phase: ["setup", "fixtureSetup", "case", "fixtureTeardown", "teardown"].includes(input.phase)
      ? input.phase
      : "case",
    sourceMacro: trimText(input.sourceMacro),
    sourceFixture: trimText(input.sourceFixture),
    query: kind === "comboSearchSelect" || kind === "cascaderSelect" ? explicitQuery : query,
    target: normalizedTarget,
    value: valueCandidate == null ? null : String(valueCandidate),
    key: trimText(input.key ?? input.keys ?? valueCandidate),
    count: Number.isInteger(input.count) ? input.count : toNumber(input.count),
    operator: trimText(input.operator || input.op || input.comparison) || "equals",
    visibleOnly: input.visibleOnly == null ? true : Boolean(input.visibleOnly),
    request: normalizeRequest(input.request ?? input),
    saveAs: trimText(input.saveAs),
    files,
    mode: input.mode === "input" ? "input" : "chooser",
    option,
    actionDefinition,
    migration:
      rawKind !== kind
        ? {
            from: rawKind,
            to: kind,
          }
        : null,
    hints,
    needRes,
    evidenceProfile,
    runProfile: evidenceProfile,
    strictMatch,
    timeoutMs,
    // REQ-Z12 (需求单v3): opt-in *exact* hard deadline for one step attempt. When
    // absent the platform derives one from the declared waits (see
    // `resolveStepHardTimeoutMs`); declaring it pins the wall-clock bound so an
    // author can assert "this step fails within N ms" precisely.
    hardTimeoutMs: toNumber(input.hardTimeoutMs),
    optionWaitTimeoutMs,
    optionPollIntervalMs,
    enableScroll: Boolean(
      input.enableScroll ?? target.enableScroll ?? false,
    ),
    autoScroll:
      input.autoScroll && typeof input.autoScroll === "object"
        ? {
            maxSteps: toNumber(input.autoScroll.maxSteps, 10),
            deltaY: toNumber(input.autoScroll.deltaY, 360),
            settleMs: toNumber(input.autoScroll.settleMs, 160),
          }
        : target.autoScroll && typeof target.autoScroll === "object"
          ? {
              maxSteps: toNumber(target.autoScroll.maxSteps, 10),
              deltaY: toNumber(target.autoScroll.deltaY, 360),
              settleMs: toNumber(target.autoScroll.settleMs, 160),
            }
          : null,
    waitForChange: Boolean(input.waitForChange),
    waitForChangeTimeoutMs: toNumber(
      input.waitForChangeTimeoutMs,
      toNumber(input.timeoutMs, 5000),
    ),
    waitForNav: Boolean(input.waitForNav),
    waitForIdle: Boolean(input.waitForIdle),
    navigationBehavior:
      input.navigationBehavior === "optional" || input.navigationBehavior === "required"
        ? input.navigationBehavior
        : "ignore",
    navigationTarget: normalizeNavigationTarget(input.navigationTarget),
    navigationTimeoutMs: toNumber(input.navigationTimeoutMs),
    waitUntil: ["commit", "domcontentloaded", "load", "networkidle"].includes(input.waitUntil)
      ? input.waitUntil
      : "domcontentloaded",
    settleStrategy,
    settleInitialMs: toNumber(input.settleInitialMs, 50),
    settleMaxMs: toNumber(input.settleMaxMs, settleStrategy === "adaptive" ? 800 : 0),
    stabilizationDelayMs: toNumber(input.stabilizationDelayMs, 250),
    pageTransition: input.pageTransition === "same-tab" ? "same-tab" : "same-tab",
    retries: retriesRaw,
    retryDelayMs: toNumber(input.retryDelayMs, 320),
    expectation: normalizeExpectation(input),
    selectorPlan: {
      query: kind === "comboSearchSelect" || kind === "cascaderSelect" ? explicitQuery : query,
      hints,
      target: normalizedTarget,
    },
  };
}

function normalizePayload(raw, options = {}) {
  const payload = coercePayload(raw);
  const inheritedProfile = normalizeEvidenceProfile(
    options.evidenceProfile ?? options.runProfile ?? options.profile,
    "debug",
  );
  if (Array.isArray(payload)) {
    return {
      mode: "batch",
      input: payload,
      evidenceProfile: inheritedProfile,
      actions: payload.map((item, index) => normalizeAction(item, index, {
        evidenceProfile: inheritedProfile,
      })),
    };
  }
  const payloadProfile = normalizeEvidenceProfile(
    payload.evidenceProfile ?? payload.runProfile ?? payload.profile,
    inheritedProfile,
  );
  return {
    mode: "single",
    input: payload,
    evidenceProfile: payloadProfile,
    actions: [normalizeAction(payload, 0, {
      evidenceProfile: payloadProfile,
    })],
  };
}

function createInputError(message) {
  const error = new Error(message);
  error.code = "invalid-input";
  error.retryable = false;
  return error;
}

module.exports = {
  coercePayload,
  normalizePayload,
  normalizeAction,
  normalizeExpectation,
  normalizeEvidenceProfile,
  ACTION_DEFINITIONS,
  isSafeRelativeAssetPath,
  createInputError,
};
