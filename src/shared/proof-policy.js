const crypto = require("node:crypto");

const INTENTS = [
  "submit-create",
  "search-filter",
  "upload",
  "status-transition",
  "delete",
  "open-dialog",
  "navigate",
  "generic",
];

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function scoreGrade(score) {
  const value = clampScore(score);
  if (value >= 85) return "A";
  if (value >= 70) return "B";
  if (value >= 55) return "C";
  if (value >= 40) return "D";
  return "E";
}

function normalizeIntent(value) {
  return INTENTS.includes(value) ? value : "generic";
}

function inferIntent(step = {}) {
  if (INTENTS.includes(step.intent)) {
    return { intent: step.intent, source: "explicit", confidence: 0.95 };
  }
  if (["fill", "comboSearchSelect", "cascaderSelect", "select", "check", "uncheck", "press"].includes(step.type)) {
    return { intent: "generic", source: "action", confidence: 0.84 };
  }
  const text = [
    step.stepTitle,
    step.title,
    step.target?.text,
    step.target?.name,
    step.target?.ariaLabel,
    step.target?.title,
    step.query,
  ].filter(Boolean).join(" ");
  if (/创建|提交|保存|submit|create|save/i.test(text)) {
    return { intent: "submit-create", source: "heuristic", confidence: 0.62 };
  }
  if (/搜索|查询|筛选|search|filter/i.test(text)) {
    return { intent: "search-filter", source: "heuristic", confidence: 0.62 };
  }
  if (/上传|upload/i.test(text) || step.type === "uploadFile") {
    return { intent: "upload", source: "heuristic", confidence: 0.65 };
  }
  if (/删除|移除|delete|remove/i.test(text)) {
    return { intent: "delete", source: "heuristic", confidence: 0.62 };
  }
  if (/状态|流转|status/i.test(text) || (/(审核|通过|驳回)/.test(text) && /提交|确认|完成/.test(text))) {
    return { intent: "status-transition", source: "heuristic", confidence: 0.58 };
  }
  if (/打开|弹窗|抽屉|open|dialog|modal|drawer/i.test(text)) {
    return { intent: "open-dialog", source: "heuristic", confidence: 0.58 };
  }
  if (step.type === "assertUrl" || step.type === "navigate") {
    return { intent: "navigate", source: "action", confidence: 0.85 };
  }
  return { intent: "generic", source: "default", confidence: 0.5 };
}

function expectationKind(expectation = {}) {
  return String(expectation.kind || expectation.mode || "").trim();
}

function expectationAssertions(expectation = {}) {
  return Array.isArray(expectation.assertions) ? expectation.assertions : [];
}

function hasExpectationKind(expectation, kinds) {
  if (!expectation || typeof expectation !== "object") return false;
  const set = kinds instanceof Set ? kinds : new Set(Array.isArray(kinds) ? kinds : [kinds]);
  if (set.has(expectationKind(expectation))) return true;
  return expectationAssertions(expectation).some((item) => hasExpectationKind(item, set));
}

function hasScopedExpectation(expectation = {}) {
  if (!expectation || typeof expectation !== "object") return false;
  if (expectation.scope || expectation.within || expectation.target?.scope || expectation.target?.locator || expectation.target?.testId) {
    return true;
  }
  return expectationAssertions(expectation).some((item) => hasScopedExpectation(item));
}

function hasResponseUrl(expectation = {}) {
  if (!expectation || typeof expectation !== "object") return false;
  if (expectation.urlIncludes || expectation.urlMatches || expectation.request?.url) return true;
  return expectationAssertions(expectation).some((item) => hasResponseUrl(item));
}

function responseBodyAssertions(expectation = {}) {
  if (!expectation || typeof expectation !== "object") return [];
  const own = Array.isArray(expectation.body) ? expectation.body : [];
  return [
    ...own,
    ...expectationAssertions(expectation).flatMap((item) => responseBodyAssertions(item)),
  ];
}

function hasSaveAs(expectation = {}) {
  return responseBodyAssertions(expectation).some((item) => item?.saveAs) || Boolean(expectation?.saveAs);
}

function hasOnlyWaitForChange(expectation = {}) {
  if (!expectation || typeof expectation !== "object") return false;
  if (expectationKind(expectation) === "waitForChange") return true;
  const assertions = expectationAssertions(expectation);
  return assertions.length > 0 && assertions.every((item) => expectationKind(item) === "waitForChange");
}

function scoreLocator(step = {}) {
  const target = step.target || {};
  let score = 35;
  const reasons = [];
  if (!target || !Object.keys(target).length) {
    return { score: 20, grade: scoreGrade(20), reasons: ["missing target"] };
  }
  if (target.testId) {
    score = 88;
    reasons.push("target.testId");
  } else if (target.scope?.testId && (target.role || target.name || target.text || target.placeholder)) {
    score = 82;
    reasons.push("scope.testId + semantic target");
  } else if (target.role && (target.name || target.text)) {
    score = 76;
    reasons.push("role + name/text");
  } else if (target.ariaLabel || target.title) {
    score = 72;
    reasons.push("ariaLabel/title");
  } else if (target.locator) {
    score = 66;
    reasons.push("explicit locator");
  } else if (target.placeholder) {
    score = 62;
    reasons.push("placeholder");
  } else if (target.text || target.name) {
    score = target.scope ? 58 : 48;
    reasons.push(target.scope ? "scoped text/name" : "text/name only");
  }
  if (target.index != null || target.selectorIndex != null) {
    score -= 18;
    reasons.push("index-based disambiguation");
  }
  if (target.iconHint && !target.testId && !target.ariaLabel && !target.title && !target.nearText && !target.scope) {
    score -= 28;
    reasons.push("iconHint without stable context");
  }
  if (target.bbox || target.ocr || target.ocrText) {
    score -= 30;
    reasons.push("OCR/bbox fallback");
  }
  return { score: clampScore(score), grade: scoreGrade(score), reasons };
}

function scoreProof(step = {}) {
  const expectation = step.expectation || {};
  const intentInfo = inferIntent(step);
  let score = 30;
  const reasons = [];
  const hasNetwork = hasExpectationKind(expectation, ["networkResponse", "assertResponse"]);
  const hasDom = hasExpectationKind(expectation, "assertDom");
  const hasText = hasExpectationKind(expectation, ["text-exists", "text-absent", "assertVisible"]);
  const scoped = hasScopedExpectation(expectation);
  const bodyAssertions = responseBodyAssertions(expectation);
  if (hasNetwork && hasResponseUrl(expectation) && bodyAssertions.length && hasSaveAs(expectation)) {
    score = 92;
    reasons.push("response URL + body + saveAs");
  } else if (hasNetwork && hasResponseUrl(expectation) && bodyAssertions.length) {
    score = 85;
    reasons.push("response URL + body");
  } else if (hasNetwork && hasResponseUrl(expectation)) {
    score = 74;
    reasons.push("response URL + status");
  } else if (hasDom && scoped) {
    score = 80;
    reasons.push("scoped assertDom");
  } else if (hasDom) {
    score = 64;
    reasons.push("assertDom without strong scope");
  } else if (hasText && scoped) {
    score = 58;
    reasons.push("scoped text proof");
  } else if (hasText) {
    score = 42;
    reasons.push("global text proof");
  }
  if (hasOnlyWaitForChange(expectation)) {
    score = 18;
    reasons.push("waitForChange only");
  }
  if (!expectation || !Object.keys(expectation).length) {
    score = ["submit-create", "search-filter", "upload", "status-transition", "delete"].includes(intentInfo.intent) ? 20 : 50;
    reasons.push("missing expectation");
  }
  if (["submit-create", "search-filter", "upload", "status-transition", "delete"].includes(intentInfo.intent) && score < 55) {
    reasons.push(`intent ${intentInfo.intent} requires stronger business proof`);
  }
  return {
    score: clampScore(score),
    grade: scoreGrade(score),
    intent: intentInfo.intent,
    intentSource: intentInfo.source,
    intentConfidence: intentInfo.confidence,
    reasons,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

module.exports = {
  INTENTS,
  clampScore,
  scoreGrade,
  normalizeIntent,
  inferIntent,
  scoreLocator,
  scoreProof,
  hasOnlyWaitForChange,
  hasScopedExpectation,
  hasResponseUrl,
  responseBodyAssertions,
  stableStringify,
  hashObject,
};
