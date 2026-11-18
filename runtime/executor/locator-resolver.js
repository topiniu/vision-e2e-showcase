const {
  buildSemanticMatches,
  expandQuery,
  normalize,
} = require("../../src/main/semantic-matcher");
const { capturePageSnapshot } = require("../perception/page-snapshot");
const { resolveActionTargetWithAdapters } = require("./adapters");
// v1.8: every renderer probe in this file is hard-bounded. v1.3 (REQ-Z12) fixed
// `page-snapshot.js` for exactly this reason but left the resolver unguarded —
// `page.evaluate` has no default timeout, so a wedged renderer parked target
// resolution until the *step* deadline fired, and the abandoned evaluate kept
// running inside the page while the next step tried to use it. A bounded probe
// degrades to `null` (target not found by this strategy), which the caller
// already handles, instead of parking.
const { withProbeTimeout } = require("./hard-timeout");

const OCR_CONFIDENCE_THRESHOLD = 0.72;
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true']";
const VISIBLE_EDITABLE_SELECTOR = "input:visible, textarea:visible, select:visible, [contenteditable='true']:visible";
const INTERACTIVE_CANDIDATE_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [role='link'], [role='tab'], [role='combobox'], [role='option'], [role='menuitem'], [contenteditable='true']";
const CLICKABLE_CANDIDATE_SELECTOR =
  "button, a, [role='button'], [role='link'], [role='tab'], [role='combobox'], [role='option'], [role='menuitem'], input[type='button'], input[type='submit']";
const USERNAME_HINTS = [
  "账号",
  "账户",
  "用户名",
  "username",
  "account",
  "loginid",
  "loginname",
  "login",
];
const PASSWORD_HINTS = [
  "密码",
  "登录密码",
  "登陆密码",
  "password",
  "passwd",
  "pwd",
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function hasTargetScope(target = {}) {
  const scope = target.scope && typeof target.scope === "object" ? target.scope : null;
  return Boolean(scope && (scope.locator || scope.testId || scope.role || scope.nearText));
}

function buildTestIdSelector(testId) {
  const value = escapeCssString(testId);
  return `[data-testid="${value}"], [data-test-id="${value}"], [data-cy="${value}"]`;
}

function pickText(candidate) {
  return (
    candidate.text ||
    candidate.contextText ||
    candidate.ariaLabel ||
    candidate.title ||
    candidate.testId ||
    candidate.svgText ||
    candidate.placeholder ||
    candidate.name ||
    candidate.role ||
    candidate.tag ||
    ""
  );
}

function getTargetQuery(action) {
  const target = action.target || {};
  if (action.kind === "comboSearchSelect" || action.kind === "cascaderSelect") {
    return (
      target.name ||
      target.text ||
      target.query ||
      target.placeholder ||
      target.ariaLabel ||
      target.title ||
      target.nearText ||
      target.iconHint ||
      ""
    );
  }
  return (
    action.query ||
    target.name ||
    target.text ||
    target.query ||
    target.placeholder ||
    target.ariaLabel ||
    target.title ||
    target.iconHint ||
    ""
  );
}

function inferFillIntent(action) {
  if (action.kind !== "fill") {
    return null;
  }
  const normalizedQuery = normalize(getTargetQuery(action));
  if (!normalizedQuery) {
    return null;
  }
  if (USERNAME_HINTS.some((item) => normalizedQuery.includes(normalize(item)))) {
    return "username";
  }
  if (PASSWORD_HINTS.some((item) => normalizedQuery.includes(normalize(item)))) {
    return "password";
  }
  return null;
}

function buildEditableLocator(page, candidate) {
  if (candidate?.selector) {
    return page.locator(candidate.selector);
  }
  if (candidate?.idAttr) {
    return page.locator(`[id="${escapeCssString(candidate.idAttr)}"]`);
  }
  if (candidate?.name) {
    const name = escapeCssString(candidate.name);
    return page.locator(`input[name="${name}"], textarea[name="${name}"], select[name="${name}"]`).first();
  }
  return page.locator(VISIBLE_EDITABLE_SELECTOR).nth(candidate?.selectorIndex ?? 0);
}

// v1.8 perf: how many matches of one strategy are ever screened. A text like
// "查看" legitimately matches every row of an ERP list; screening 1000+ of them
// is never the right answer, and the cap makes the worst case bounded rather
// than merely "faster". `truncated` is reported so evidence shows it happened.
const CANDIDATE_SCREEN_LIMIT = Math.max(
  1,
  Number(process.env.ZHUZHU_CANDIDATE_SCREEN_LIMIT || 300),
);

// v1.8 perf: screen every match of a locator in ONE round-trip.
//
// This replaces a serial `for (i < count) { await nth(i).isVisible(); await
// nth(i).evaluate(nearText...) }` loop. Measured on a 20k-node list page with
// 1104 matches: the serial loop cost ~41ms *per candidate* (≈46s for the full
// loop, i.e. the step's hard timeout fires and the abandoned loop keeps running
// in the renderer); the batched form below is a single evaluateAll.
//
// The near-text algorithm is identical to the previous per-element one, with a
// single structural change: the geometric fallback used to run
// `document.querySelectorAll("body *")` **once per candidate** — that is the
// genuine O(N*M) in this file. Here the label index is built once and shared by
// every candidate.
async function screenCandidates(locator, { nearText = "", limit = CANDIDATE_SCREEN_LIMIT } = {}) {
  return locator.evaluateAll(
    (elements, { expectedText, max }) => {
      const normalizeText = (value) =>
        typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      const normalizeComparableText = (value) =>
        normalizeText(value)
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[​-‍﻿]/g, "")
          .replace(/[\s_-]+/g, "");
      const textIncludes = (value, expectedValue) => {
        const normalizedValue = normalizeText(value);
        const normalizedExpected = normalizeText(expectedValue);
        if (!normalizedExpected) {
          return true;
        }
        return (
          normalizedValue.includes(normalizedExpected) ||
          normalizeComparableText(normalizedValue).includes(normalizeComparableText(normalizedExpected))
        );
      };
      const directText = (node) =>
        normalizeText(
          Array.from(node?.childNodes || [])
            .filter((child) => child.nodeType === Node.TEXT_NODE)
            .map((child) => child.textContent || "")
            .join(" "),
        );
      const attrText = (node) =>
        normalizeText(
          [
            node?.getAttribute?.("aria-label"),
            node?.getAttribute?.("title"),
            node?.getAttribute?.("data-testid"),
            node?.getAttribute?.("data-test-id"),
            node?.getAttribute?.("data-cy"),
          ]
            .filter(Boolean)
            .join(" "),
        );
      // Playwright's own `isVisible()` semantics: a non-empty bounding box plus
      // `visibility !== hidden`. Kept identical so batching does not silently
      // change which candidates are considered.
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== "function") {
          return false;
        }
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) {
          return false;
        }
        const style = window.getComputedStyle(node);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0
        );
      };

      // Near-text only disambiguates *between* candidates; with a single match
      // the caller ignores it (this mirrors the previous `count > 1` gate). So a
      // unique locator never pays for the label index below.
      const expected = elements.length > 1 ? normalizeText(expectedText) : "";
      const truncated = elements.length > max;
      const screened = elements.slice(0, max);

      // Built lazily and at most once per call, no matter how many candidates
      // need the geometric fallback. This is the whole point of the rewrite.
      let labelIndex = null;
      const getLabelIndex = () => {
        if (labelIndex) {
          return labelIndex;
        }
        labelIndex = [];
        const nodes = document.querySelectorAll("body *");
        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          const area = rect.width * rect.height;
          // Cheap geometric rejection first — only survivors pay for text
          // extraction, which is what made the old per-candidate scan hurt.
          if (!(area > 0) || area > 40000 || rect.width > 420 || rect.height > 160) {
            continue;
          }
          const text = normalizeText(`${directText(node)} ${attrText(node)}`);
          if (!text || text.length > expected.length + 20) {
            continue;
          }
          if (!textIncludes(text, expected)) {
            continue;
          }
          if (!isVisible(node)) {
            continue;
          }
          labelIndex.push({
            node,
            area,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
          });
        }
        return labelIndex;
      };

      const matchNearText = (element) => {
        if (!expected) {
          return { matched: true, method: null, score: 0 };
        }
        const selfText = normalizeText(
          [element.innerText, element.textContent, attrText(element)].filter(Boolean).join(" "),
        );
        if (textIncludes(selfText, expected)) {
          return { matched: true, method: "self", score: -1000 };
        }

        const targetRect = element.getBoundingClientRect();
        const targetArea = Math.max(targetRect.width * targetRect.height, 1);
        const contextText = (node) =>
          normalizeText([node?.innerText, node?.textContent, attrText(node)].filter(Boolean).join(" "));
        const isCompactContext = (node) => {
          if (!node || typeof node.getBoundingClientRect !== "function") {
            return false;
          }
          const rect = node.getBoundingClientRect();
          const area = rect.width * rect.height;
          return (
            area > 0 &&
            area <= Math.max(targetArea * 90, 90000) &&
            rect.width <= Math.max(targetRect.width * 8, 420) &&
            rect.height <= Math.max(targetRect.height * 7, 280)
          );
        };

        let current = element.parentElement;
        for (let depth = 1; current && depth <= 4; depth += 1) {
          const localText = normalizeText(`${directText(current)} ${attrText(current)}`);
          if (textIncludes(localText, expected)) {
            return { matched: true, method: `ancestor-direct-${depth}`, score: -900 + depth };
          }
          const compactText = isCompactContext(current) ? contextText(current) : "";
          if (textIncludes(compactText, expected)) {
            const rect = current.getBoundingClientRect();
            return {
              matched: true,
              method: `ancestor-local-${depth}`,
              score: -800 + depth + (rect.width * rect.height) / 100000,
            };
          }
          current = current.parentElement;
        }

        const targetCenter = {
          x: targetRect.left + targetRect.width / 2,
          y: targetRect.top + targetRect.height / 2,
        };
        let nearest = null;
        for (const entry of getLabelIndex()) {
          if (entry.node === element) {
            continue;
          }
          const dx = Math.abs(entry.cx - targetCenter.x);
          const dy = Math.abs(entry.cy - targetCenter.y);
          const score = dx + dy + entry.area / 10000;
          if (!nearest || score < nearest.score) {
            nearest = { dx, dy, score };
          }
        }
        if (!nearest) {
          return { matched: false, method: "not-found", score: Number.POSITIVE_INFINITY };
        }
        if (nearest.dx <= Math.max(160, targetRect.width * 3) && nearest.dy <= 140) {
          return { matched: true, method: "geometric-text", score: nearest.score };
        }
        return { matched: false, method: "too-far", score: nearest.score };
      };

      return {
        total: elements.length,
        truncated,
        candidates: screened.map((element, index) => {
          const visible = isVisible(element);
          return {
            index,
            visible,
            // Near-text screening is only meaningful for candidates that are
            // actually visible; skipping it for the rest also skips the
            // expensive part for exactly the elements that never win.
            near: visible ? matchNearText(element) : { matched: false, method: "hidden", score: Number.POSITIVE_INFINITY },
          };
        }),
      };
    },
    { expectedText: nearText || "", max: limit },
  );
}

async function firstResolvable(locator, strategy, meta = {}) {
  // v1.8 perf: ONE selector-engine pass, not two. `locator.count()` followed by
  // `locator.evaluateAll()` re-runs the query, and for role/text locators that
  // query is the expensive part (Playwright computes accessible names for every
  // match — measured at ~50ms per call on a 20k-node page). `evaluateAll`
  // already reports how many elements it saw, so `count` is derived from it.
  const screening = await screenCandidates(locator, { nearText: meta.nearText || "" }).catch(() => null);
  const count = screening ? screening.total : await locator.count().catch(() => 0);
  // Surfaced in `locatorSummary` so a run whose candidate set was capped says so
  // in its own evidence rather than looking like it considered everything.
  let screenedCount = null;
  let screenTruncated = false;
  const buildResolution = async (handle, nearTextMatch = null) => {
    const resolvedNearTextMatch = nearTextMatch || {
      matched: meta.targetSummary?.nearTextMatched ?? false,
      method: meta.targetSummary?.nearTextMatchMethod ?? null,
    };
    const nearTextMatched = Boolean(
      resolvedNearTextMatch.matched ||
        meta.targetSummary?.nearTextMatched ||
        (strategy.includes("near-text") && meta.nearText),
    );
    const nearTextMatchMethod =
      resolvedNearTextMatch.method ||
      meta.targetSummary?.nearTextMatchMethod ||
      (nearTextMatched ? "resolved-near-text" : null);
    const enabled = await handle.isEnabled().catch(() => true);
    const box = await handle.boundingBox().catch(() => null);
    return {
      source: "dom",
      locator: handle,
      strategy,
      confidence: meta.confidence ?? 0.99,
      matchedText: meta.matchedText ?? null,
      targetSummary: {
        ...(meta.targetSummary || {}),
        nearText: meta.nearText || meta.targetSummary?.nearText || null,
        nearTextMatched,
        nearTextMatchMethod,
        enabled,
        bbox: box,
      },
      locatorSummary: {
        strategy,
        count,
        ...(screenedCount != null ? { screened: screenedCount } : {}),
        ...(screenTruncated ? { screenTruncated: true } : {}),
      },
      rankedCandidates: meta.rankedCandidates ?? null,
    };
  };

  if (count === 0) {
    return null;
  }

  // A screening failure (detached nodes mid-scan, a page navigating under us)
  // must not make the strategy unusable — fall back to the first visible match
  // via Playwright's own check, which is one round-trip rather than `count`.
  if (!screening) {
    const handle = locator.first();
    if ((await handle.isVisible().catch(() => false)) !== true) {
      return null;
    }
    return buildResolution(handle, { matched: false, method: "screen-failed" });
  }

  const candidates = screening.candidates || [];
  screenedCount = candidates.length;
  screenTruncated = Boolean(screening.truncated);

  if (meta.nearText && count > 1) {
    const nearMatches = candidates
      .filter((item) => item.visible && item.near?.matched)
      .sort(
        (a, b) => (a.near.score ?? Number.POSITIVE_INFINITY) - (b.near.score ?? Number.POSITIVE_INFINITY),
      );
    if (nearMatches[0]) {
      return buildResolution(locator.nth(nearMatches[0].index), nearMatches[0].near);
    }
    return null;
  }

  const firstVisible = candidates.find((item) => item.visible);
  if (!firstVisible) {
    return null;
  }
  return buildResolution(locator.nth(firstVisible.index), { matched: false, method: null });
}

// v1.8 perf: the source of this file's worst measured pathology.
//
// The predicate is unchanged — a scope root counts as usable if it is visible
// itself OR has any visible descendant (an AntD Modal root is a zero-size box
// whose dialog child is what the operator sees). What changed is how it is
// computed for *many* candidates.
//
// Before: `firstScopeRoot` looped `count` times, and each iteration ran
// `element.querySelectorAll("*").some(isVisible)` in its own round-trip. Nested
// candidates (a `div` selector matches a parent and its children) rescan the
// same subtrees, so the cost is O(count x subtree) — measured on the heavy-page
// fixture: 22.7 s at 3.9k nodes and 132.3 s at 9.9k nodes, i.e. quadratic.
//
// After: one round-trip. The cheap per-candidate check runs first; only if it
// fails does the pass build a visibility index — every visible node plus all of
// its ancestors, accumulated in a single O(N) walk (the `has()` guard is what
// keeps it amortised linear). Membership in that set is exactly
// "visible or has a visible descendant", answered in O(1) per candidate.
const SCOPE_ROOT_SCREEN_LIMIT = Math.max(
  1,
  Number(process.env.ZHUZHU_SCOPE_ROOT_SCREEN_LIMIT || 400),
);

async function screenScopeRoots(locator, limit = SCOPE_ROOT_SCREEN_LIMIT) {
  return locator
    .evaluateAll((elements, max) => {
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== "function") {
          return false;
        }
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) {
          return false;
        }
        const style = window.getComputedStyle(node);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0
        );
      };

      let index = null;
      const getIndex = () => {
        if (index) {
          return index;
        }
        index = new Set();
        for (const node of document.querySelectorAll("*")) {
          if (!isVisible(node)) {
            continue;
          }
          let current = node;
          // The `has` guard bounds the total ancestor walking across the whole
          // document to O(N), not O(N * depth).
          while (current && !index.has(current)) {
            index.add(current);
            current = current.parentElement;
          }
        }
        return index;
      };

      const screened = elements.slice(0, max);
      const usable = [];
      for (let i = 0; i < screened.length; i += 1) {
        const element = screened[i];
        if (isVisible(element)) {
          usable.push(i);
          continue;
        }
        if (getIndex().has(element)) {
          usable.push(i);
        }
      }
      return { total: elements.length, truncated: elements.length > max, usable };
    }, limit)
    .catch(() => null);
}

async function firstScopeRoot(locator, strategy, scope) {
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    return {
      locator: null,
      strategy,
      scopeSummary: { ...scope, matched: false, strategy, candidateCount: 0 },
    };
  }

  const screening = await screenScopeRoots(locator);
  // A screening failure must degrade to "try the first one", never to a serial
  // rescan — the serial rescan is the thing being removed.
  const index = screening ? screening.usable[0] : 0;
  if (index == null) {
    return {
      locator: null,
      strategy,
      scopeSummary: {
        ...scope,
        matched: false,
        strategy,
        candidateCount: count,
        ...(screening?.truncated ? { screenTruncated: true } : {}),
      },
    };
  }

  const handle = locator.nth(index);
  const box = await handle.boundingBox().catch(() => null);
  return {
    locator: handle,
    strategy,
    scopeSummary: {
      ...scope,
      matched: true,
      strategy,
      candidateIndex: index,
      candidateCount: count,
      bbox: box,
      ...(screening?.truncated ? { screenTruncated: true } : {}),
    },
  };
}

async function resolveNearTextScopeRoot(page, scope) {
  const result = await withProbeTimeout(() => page.evaluate((scopeInput) => {
    const nearText = String(scopeInput.nearText || "").trim();
    if (!nearText) {
      return null;
    }
    const normalizeText = (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== "function") {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) !== 0
      );
    };
    const hasVisibleDescendant = (node) =>
      Array.from(node.querySelectorAll?.("*") || []).some(isVisible);
    const textOf = (node) => normalizeText(node?.innerText || node?.textContent || "");
    const selectorFor = (node) => {
      const key = `e2e-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      node.setAttribute("data-e2e-auto-scope-id", key);
      return `[data-e2e-auto-scope-id="${key}"]`;
    };
    const candidates = Array.from(
      document.querySelectorAll("main, section, article, form, [role], .ant-modal, .ant-modal-content, .ant-drawer, .ant-drawer-content, .modal, .dialog, div"),
    )
      .filter((node) => (isVisible(node) || hasVisibleDescendant(node)) && textOf(node).includes(nearText))
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        const area = Math.max(rect.width * rect.height, 1);
        return {
          node,
          index,
          area,
          textLength: textOf(node).length,
          bbox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .sort((a, b) => a.area - b.area || a.textLength - b.textLength || a.index - b.index);
    const selected = candidates[0];
    if (!selected) {
      return {
        selector: null,
        candidateCount: 0,
      };
    }
    return {
      selector: selectorFor(selected.node),
      candidateCount: candidates.length,
      candidateIndex: selected.index,
      bbox: selected.bbox,
    };
  }, scope), { label: "resolver:evaluate@L581", fallback: null }).catch(() => null);

  if (!result?.selector) {
    return {
      locator: null,
      strategy: "scope:near-text",
      scopeSummary: {
        ...scope,
        matched: false,
        strategy: "scope:near-text",
        candidateCount: result?.candidateCount || 0,
      },
    };
  }

  return {
    locator: page.locator(result.selector).first(),
    strategy: "scope:near-text",
    scopeSummary: {
      ...scope,
      matched: true,
      strategy: "scope:near-text",
      candidateIndex: result.candidateIndex,
      candidateCount: result.candidateCount,
      bbox: result.bbox,
    },
  };
}

async function resolveTargetScopeRoot(page, target = {}) {
  const scope = target.scope && typeof target.scope === "object" ? target.scope : null;
  if (!scope || !hasTargetScope(target)) {
    return null;
  }

  const candidates = [];
  if (scope.locator) {
    candidates.push({
      locator: buildRawLocator(page, scope.locator),
      strategy: isXPathLocator(scope.locator) ? "scope:xpath" : "scope:css",
    });
  }
  if (scope.testId) {
    candidates.push({
      locator: page.locator(buildTestIdSelector(scope.testId)),
      strategy: "scope:test-id",
    });
  }
  if (scope.role) {
    const roleBase = page.getByRole(scope.role);
    candidates.push({
      locator: scope.nearText ? roleBase.filter({ hasText: scope.nearText }) : roleBase,
      strategy: "scope:role",
    });
    if (scope.role === "dialog") {
      const modalBase = page.locator(".ant-modal, .ant-modal-content, .ant-drawer, .ant-drawer-content, .modal, .dialog");
      candidates.push({
        locator: scope.nearText ? modalBase.filter({ hasText: scope.nearText }) : modalBase,
        strategy: "scope:dialog-compatible",
      });
    }
  }

  for (const candidate of candidates) {
    const scopedLocator = scope.nearText && !candidate.strategy.includes("role") && !candidate.strategy.includes("dialog")
      ? candidate.locator.filter({ hasText: scope.nearText })
      : candidate.locator;
    const found = await firstScopeRoot(scopedLocator, candidate.strategy, scope);
    if (found.locator) {
      return found;
    }
  }

  if (!scope.locator && !scope.testId && !scope.role && scope.nearText) {
    const found = await resolveNearTextScopeRoot(page, scope);
    if (found.locator) {
      return found;
    }
    return found;
  }

  return {
    locator: null,
    strategy: "scope:not-found",
    scopeSummary: {
      ...scope,
      matched: false,
      strategy: "scope:not-found",
      candidateCount: 0,
    },
  };
}

async function resolveAntSelectPlaceholder(page, action) {
  const target = action.target || {};
  const placeholder = target.placeholder || "";
  if (!["comboSearchSelect", "cascaderSelect"].includes(action.kind) || !placeholder) {
    return null;
  }

  const result = await withProbeTimeout(() => page.evaluate(({ placeholderText, nearText, targetIndex }) => {
    const normalizeText = (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const normalizedPlaceholder = normalizeText(placeholderText);
    const normalizedNearText = normalizeText(nearText);
    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (
        !style ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) =>
      normalizeText(
        [
          el?.innerText,
          el?.textContent,
          el?.getAttribute?.("aria-label"),
          el?.getAttribute?.("title"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    const inputTextOf = (el) => {
      const input = el?.querySelector?.(
        "input[role='combobox'], input.ant-select-selection-search-input, input[type='search'], input",
      );
      return normalizeText(
        [
          input?.getAttribute?.("placeholder"),
          input?.getAttribute?.("aria-label"),
          input?.getAttribute?.("title"),
          input?.getAttribute?.("name"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    };
    const ancestorText = (el) => {
      let current = el?.parentElement || null;
      let depth = 0;
      const chunks = [];
      while (current && depth < 8) {
        chunks.push(textOf(current));
        current = current.parentElement;
        depth += 1;
      }
      return normalizeText(chunks.join(" "));
    };
    const selectorFor = (el) => {
      if (!(el instanceof Element)) {
        return null;
      }
      const key = `e2e-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      el.setAttribute("data-e2e-auto-target-id", key);
      return `[data-e2e-auto-target-id="${key}"]`;
    };

    const nodes = Array.from(
      document.querySelectorAll(
        ".ant-select, .ant-cascader, .ant-cascader-picker, [class*=' ant-select '], [class^='ant-select '], [class$=' ant-select'], [class*=' ant-cascader'], [class^='ant-cascader'], [class$=' ant-cascader']",
      ),
    ).filter(isVisible);
    const matches = nodes
      .map((node, index) => {
        const directText = textOf(node);
        const inputText = inputTextOf(node);
        const fullText = normalizeText(`${directText} ${inputText}`);
        const placeholderMatched =
          Boolean(fullText) &&
          (fullText.includes(normalizedPlaceholder) ||
            (fullText.length >= 6 && normalizedPlaceholder.includes(fullText)));
        if (!placeholderMatched) {
          return null;
        }
        const ancestors = ancestorText(node);
        const nearMatched = normalizedNearText ? ancestors.includes(normalizedNearText) || fullText.includes(normalizedNearText) : false;
        const rect = node.getBoundingClientRect();
        const area = rect.width * rect.height;
        return {
          node,
          index,
          score: 100 + (nearMatched ? 40 : 0) - Math.min(area / 100000, 10),
          nearMatched,
          text: fullText,
          bbox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const selected = Number.isInteger(targetIndex) && targetIndex >= 0
      ? matches[targetIndex]
      : matches[0];
    if (!selected) {
      return null;
    }
    const selector = selectorFor(selected.node);
    return {
      selector,
      confidence: selected.nearMatched ? 0.98 : 0.93,
      matchedText: selected.text,
      targetSummary: {
        text: selected.text,
        placeholder: normalizedPlaceholder,
        nearText: normalizedNearText || null,
        nearTextMatched: selected.nearMatched,
        bbox: selected.bbox,
        candidateIndex: selected.index,
        candidateCount: matches.length,
      },
      rankedCandidates: matches.slice(0, 5).map((item) => ({
        id: `ant-select-${item.index}`,
        text: item.text,
        score: item.score,
        bbox: item.bbox,
      })),
    };
  }, {
    placeholderText: placeholder,
    nearText: target.nearText || "",
    targetIndex: target.index,
  }), { label: "resolver:evaluate@L744", fallback: null }).catch(() => null);

  if (!result?.selector) {
    return null;
  }

  const found = await firstResolvable(
    page.locator(result.selector),
    action.kind === "cascaderSelect" ? "explicit:ant-cascader-placeholder" : "explicit:ant-select-placeholder",
    {
      confidence: result.confidence,
      matchedText: result.matchedText,
      targetSummary: result.targetSummary,
      rankedCandidates: result.rankedCandidates,
    },
  );
  return found;
}

async function collectDomCandidates(page) {
  return withProbeTimeout(() => page.evaluate((interactiveSelector) => {
    const normalizeText = (value) =>
      typeof value === "string" ? value.trim() : "";
    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style) {
        return false;
      }
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const labelText = (el) => {
      if (!el) {
        return "";
      }
      const id = el.getAttribute("id");
      if (!id) {
        return "";
      }
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      return normalizeText(label?.innerText || label?.textContent || "");
    };
    const attrText = (el, name) => normalizeText(el?.getAttribute?.(name) || "");
    const hasPointerIntent = (el) => {
      if (!el || !(el instanceof Element)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      return (
        style?.cursor === "pointer" ||
        typeof el.onclick === "function" ||
        el.hasAttribute("onclick") ||
        el.hasAttribute("tabindex")
      );
    };
    const svgText = (el) => {
      const svg = el?.querySelector?.("svg");
      if (!svg) {
        return "";
      }
      return [
        attrText(svg, "aria-label"),
        normalizeText(svg.querySelector("title")?.textContent || ""),
        attrText(svg.querySelector("use"), "href"),
        attrText(svg.querySelector("use"), "xlink:href"),
      ]
        .filter(Boolean)
        .join(" ");
    };
    const siblingLabelText = (el) => {
      if (!el) {
        return "";
      }
      const wrapper = el.closest?.(
        ".formItemWrapper___3w21w, [class*='formItemWrapper'], .ant-form-item, form > div",
      );
      if (!wrapper) {
        return "";
      }
      const labelNode = wrapper.querySelector(
        "label, [class*='label'], .ant-form-item-label",
      );
      return normalizeText(labelNode?.innerText || labelNode?.textContent || "");
    };
    const isTextLikeElement = (el) => {
      if (!el || !(el instanceof Element)) {
        return false;
      }
      const tag = el.tagName;
      return ![
        "INPUT",
        "TEXTAREA",
        "SELECT",
        "BUTTON",
        "A",
        "SVG",
        "PATH",
        "IMG",
      ].includes(tag);
    };
    const contextualText = (el) => {
      if (!el) {
        return "";
      }
      const rect = el.getBoundingClientRect();
      const probes = Array.from(
        document.querySelectorAll("label, span, div, p, strong, em"),
      );
      let best = "";
      let bestScore = Number.POSITIVE_INFINITY;

      for (const probe of probes) {
        if (
          !isTextLikeElement(probe) ||
          probe === el ||
          probe.contains(el) ||
          !isVisible(probe)
        ) {
          continue;
        }
        const text = normalizeText(probe.innerText || probe.textContent || "");
        if (!text || text.length > 24) {
          continue;
        }
        const probeRect = probe.getBoundingClientRect();
        const deltaX = rect.left - probeRect.left;
        const deltaY = rect.top - probeRect.top;
        const verticallyAligned = Math.abs((probeRect.top + probeRect.height / 2) - (rect.top + rect.height / 2)) <= 32;
        const aboveInput = probeRect.bottom <= rect.top + 20;
        const leftOfInput = probeRect.right <= rect.left + 40;
        if (!verticallyAligned && !aboveInput && !leftOfInput) {
          continue;
        }
        const score =
          Math.abs(deltaY) +
          Math.abs(deltaX) * 0.35 +
          (aboveInput ? 0 : 18) +
          (leftOfInput ? 0 : 12);
        if (score < bestScore) {
          bestScore = score;
          best = text;
        }
      }

      return best;
    };
    const containerText = (el) => {
      let current = el?.parentElement || null;
      let depth = 0;
      while (current && depth < 4) {
        if (isVisible(current)) {
          const lines = String(current.innerText || current.textContent || "")
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)
            .filter((item) => item.length <= 24);
          const text = lines.find((item) => item && item !== normalizeText(el.value || ""));
          if (text) {
            return text;
          }
        }
        current = current.parentElement;
        depth += 1;
      }
      return "";
    };

    let editableIndex = 0;
    let clickableIndex = 0;

    const semanticCandidates = Array.from(document.querySelectorAll(interactiveSelector));
    const seen = new Set(semanticCandidates);
    const pointerCandidates = Array.from(document.querySelectorAll("body div, body span, body li"))
      .filter((el) => !seen.has(el) && hasPointerIntent(el));

    return semanticCandidates
      .concat(pointerCandidates)
      .filter((el) => isVisible(el))
      .slice(0, 300)
      .map((el, index) => {
        const selector = `e2e-dom-candidate-${index + 1}`;
        el.setAttribute("data-e2e-auto-dom-candidate-id", selector);
        const rect = el.getBoundingClientRect();
        const editable =
          el.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
        const selectorIndex = editable ? editableIndex++ : clickableIndex++;
        return {
          id: `dom-${index + 1}`,
          selector: `[data-e2e-auto-dom-candidate-id="${selector}"]`,
          tag: el.tagName,
          role: el.getAttribute("role") || null,
          text: normalizeText(el.innerText || el.textContent || el.value || ""),
          label: labelText(el),
          ariaLabel: attrText(el, "aria-label"),
          title: attrText(el, "title"),
          inputType: normalizeText(el.getAttribute("type") || ""),
          testId:
            attrText(el, "data-testid") ||
            attrText(el, "data-test-id") ||
            attrText(el, "data-cy"),
          className: normalizeText(String(el.getAttribute("class") || "")),
          svgText: svgText(el),
          contextText: [labelText(el), siblingLabelText(el), contextualText(el), containerText(el)]
            .filter(Boolean)
            .filter((value, idx, array) => array.indexOf(value) === idx)
            .join(" / "),
          placeholder: normalizeText(el.getAttribute("placeholder") || ""),
          name: normalizeText(el.getAttribute("name") || ""),
          idAttr: normalizeText(el.getAttribute("id") || ""),
          enabled:
            !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
          editable,
          selectorIndex,
          bbox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      });
  }, INTERACTIVE_CANDIDATE_SELECTOR), { label: "resolver:evaluate@L900", fallback: null });
}

async function resolveCollapsedMenuText(page, action) {
  if (!["click", "hover"].includes(action.kind)) {
    return null;
  }
  const query = getTargetQuery(action);
  if (!query) {
    return null;
  }

  const result = await withProbeTimeout(() => page.evaluate(({ queryText }) => {
    const normalizeText = (value) =>
      typeof value === "string"
        ? value
            .normalize("NFKC")
            .toLowerCase()
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/[\s_-]+/g, "")
        : "";
    const displayText = (value) =>
      typeof value === "string"
        ? value
            .normalize("NFKC")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\s+/g, " ")
            .trim()
        : "";
    const attrText = (el, name) => displayText(el?.getAttribute?.(name) || "");
    const isVisibleBox = (el) => {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (
        !style ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const menuSelector = [
      ".ant-menu-item",
      ".ant-menu-submenu-title",
      ".antc-menu-item",
      ".antc-menu-submenu-title",
      "[class*='ant-menu-item']",
      "[class*='ant-menu-submenu-title']",
      "[class*='antc-menu-item']",
      "[class*='antc-menu-submenu-title']",
      "[role='menuitem']",
    ].join(",");
    const titleSelector = [
      ".ant-menu-title-content",
      ".antc-menu-title-content",
      "[class*='ant-menu-title-content']",
      "[class*='antc-menu-title-content']",
    ].join(",");
    const query = normalizeText(queryText);
    if (!query) {
      return null;
    }

    const candidates = Array.from(document.querySelectorAll(menuSelector))
      .filter((el) => isVisibleBox(el))
      .slice(0, 300)
      .map((el, index) => {
        const titleNode = el.querySelector(titleSelector);
        const texts = [
          attrText(el, "aria-label"),
          attrText(el, "title"),
          attrText(el, "data-menu-id"),
          attrText(el, "data-testid"),
          attrText(el, "data-test-id"),
          attrText(titleNode, "title"),
          displayText(titleNode?.innerText || titleNode?.textContent || ""),
          displayText(el.innerText || el.textContent || ""),
        ].filter(Boolean);
        const uniqueTexts = texts.filter((item, idx, array) => array.indexOf(item) === idx);
        const normalizedTexts = uniqueTexts.map((item) => normalizeText(item));
        const exact = normalizedTexts.includes(query);
        const contains = !exact && normalizedTexts.some((item) => item.includes(query) || query.includes(item));
        if (!exact && !contains) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        const marker = `runtime-menu-target-${Date.now()}-${index}`;
        el.setAttribute("data-runtime-menu-target-id", marker);
        return {
          selector: `[data-runtime-menu-target-id="${marker}"]`,
          matchedText: uniqueTexts.find((item) => normalizeText(item) === query) || uniqueTexts[0] || queryText,
          confidence: exact ? 0.95 : 0.88,
          score: exact ? 1 : 0.86,
          targetSummary: {
            text: queryText,
            matchedText: uniqueTexts.join(" / "),
            role: el.getAttribute("role") || null,
            title: attrText(el, "title") || attrText(titleNode, "title") || null,
            ariaLabel: attrText(el, "aria-label") || null,
            className: displayText(String(el.getAttribute("class") || "")),
            collapsedMenuText: true,
            bbox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return candidates[0]
      ? {
          ...candidates[0],
          rankedCandidates: candidates.slice(0, 5).map((candidate, index) => ({
            id: `collapsed-menu-${index + 1}`,
            text: candidate.targetSummary.matchedText,
            score: candidate.score,
            bbox: candidate.targetSummary.bbox,
          })),
        }
      : null;
  }, { queryText: query }), { label: "resolver:evaluate@L1124", fallback: null }).catch(() => null);

  if (!result?.selector) {
    return null;
  }
  return firstResolvable(page.locator(result.selector), "dom:ant-menu-collapsed-text", {
    confidence: result.confidence,
    matchedText: result.matchedText,
    targetSummary: result.targetSummary,
    rankedCandidates: result.rankedCandidates,
  });
}

async function resolveUploadFileInput(page, action, scopeRoot = null) {
  if (action.kind !== "uploadFile") {
    return null;
  }
  const query = getTargetQuery(action);
  const nearText = action.target?.nearText || "";
  const fileInputLocator = scopeRoot?.locator
    ? scopeRoot.locator.locator("input[type='file']")
    : page.locator("input[type='file']");
  const result = await fileInputLocator.evaluateAll((inputs, { queryText, nearTextValue }) => {
    const normalizeText = (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const textMatchesLabel = (text, expected) => {
      const normalizedExpected = normalizeText(expected);
      if (!normalizedExpected) {
        return true;
      }
      return normalizeText(text)
        .split(/[\s/|,，;；]+/)
        .map((item) => item.replace(/^[*＊+＋:：-]+/, "").replace(/[:：]+$/, "").trim())
        .filter(Boolean)
        .some((item) => item === normalizedExpected);
    };
    const normalizedQuery = normalizeText(queryText);
    const normalizedNearText = normalizeText(nearTextValue);
    const attrText = (el, name) => normalizeText(el?.getAttribute?.(name) || "");
    const isVisibleBox = (el) => {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) =>
      normalizeText(
        [
          el?.innerText,
          el?.textContent,
          attrText(el, "aria-label"),
          attrText(el, "title"),
          attrText(el, "data-testid"),
          attrText(el, "data-test-id"),
          attrText(el, "data-cy"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    const labelFor = (input) => {
      const id = input.getAttribute("id");
      if (!id) {
        return "";
      }
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      return textOf(label);
    };
    const ranked = [];

    Array.from(inputs).forEach((input, inputIndex) => {
      const contexts = [];
      const ownText = normalizeText(
        [
          labelFor(input),
          attrText(input, "aria-label"),
          attrText(input, "title"),
          attrText(input, "name"),
          attrText(input, "id"),
          attrText(input, "data-upload-category"),
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (ownText) {
        contexts.push({
          element: input,
          text: ownText,
          depth: 0,
          rect: input.getBoundingClientRect(),
          visible: isVisibleBox(input),
        });
      }

      let current = input.parentElement;
      for (let depth = 1; current && depth <= 8 && current !== document.body; depth += 1) {
        const text = textOf(current);
        const rect = current.getBoundingClientRect();
        contexts.push({
          element: current,
          text,
          depth,
          rect,
          visible: isVisibleBox(current),
        });
        current = current.parentElement;
      }

      for (const context of contexts) {
        if (!context.text) {
          continue;
        }
        const nearMatched = textMatchesLabel(context.text, normalizedNearText);
        const queryMatched = textMatchesLabel(context.text, normalizedQuery);
        if (normalizedNearText && !nearMatched) {
          continue;
        }
        if (normalizedQuery && !queryMatched && !nearMatched) {
          continue;
        }
        const area = Math.max((context.rect?.width || 0) * (context.rect?.height || 0), 1);
        const visiblePenalty = context.visible ? 0 : 300;
        const queryPenalty = normalizedQuery && !queryMatched ? 40 : 0;
        const score = context.depth * 20 + area / 10000 + queryPenalty + visiblePenalty;
        ranked.push({
          id: `file-input-${inputIndex + 1}`,
          inputIndex,
          text: context.text,
          bbox: {
            x: context.rect?.x || 0,
            y: context.rect?.y || 0,
            width: context.rect?.width || 0,
            height: context.rect?.height || 0,
          },
          kind: "file-input",
          score,
          nearTextMatched: nearMatched,
          nearTextMatchMethod: `file-input-context-${context.depth}`,
          queryMatched,
        });
      }
    });

    ranked.sort((a, b) => a.score - b.score);
    return {
      top: ranked[0] || null,
      ranked: ranked.slice(0, 8),
    };
  }, {
    queryText: query,
    nearTextValue: nearText,
  });

  if (!result?.top) {
    return null;
  }

  const locator = fileInputLocator.nth(result.top.inputIndex);
  return {
    source: "dom",
    locator,
    strategy: scopeRoot?.locator ? "scoped:dom:file-input-near-text" : "dom:file-input-near-text",
    confidence: result.top.nearTextMatched ? 0.96 : 0.82,
    matchedText: result.top.text,
    targetSummary: {
      text: query || null,
      scope: scopeRoot?.scopeSummary || null,
      nearText: nearText || null,
      nearTextMatched: result.top.nearTextMatched,
      nearTextMatchMethod: result.top.nearTextMatchMethod,
      contextText: result.top.text,
      inputIndex: result.top.inputIndex,
      bbox: result.top.bbox,
    },
    locatorSummary: {
      strategy: scopeRoot?.locator ? "scoped:dom:file-input-near-text" : "dom:file-input-near-text",
      count: result.ranked.length,
    },
    rankedCandidates: result.ranked,
  };
}

async function resolveRoleNearTextCandidate(page, action) {
  const target = action.target || {};
  const query = getTargetQuery(action);
  if (!target.role || !query || !target.nearText) {
    return null;
  }

  const result = await withProbeTimeout(() => page.evaluate(({ role, queryText, nearText, targetIndex, interactiveSelector }) => {
    const normalizeText = (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const normalizeComparableText = (value) =>
      normalizeText(value)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\s_-]+/g, "");
    const normalizedQuery = normalizeComparableText(queryText);
    const normalizedNearText = normalizeComparableText(nearText);
    const attrText = (el, name) => normalizeText(el?.getAttribute?.(name) || "");
    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) =>
      normalizeText(
        [
          el?.innerText,
          el?.textContent,
          el?.value,
          attrText(el, "aria-label"),
          attrText(el, "title"),
          attrText(el, "data-testid"),
          attrText(el, "data-test-id"),
          attrText(el, "data-cy"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    const roleMatches = (el) => {
      const tag = el.tagName;
      const explicitRole = attrText(el, "role").toLowerCase();
      const inputType = attrText(el, "type").toLowerCase();
      if (role === "button") {
        return (
          tag === "BUTTON" ||
          explicitRole === "button" ||
          (tag === "INPUT" && ["button", "submit", "reset"].includes(inputType))
        );
      }
      if (role === "link") {
        return tag === "A" || explicitRole === "link";
      }
      if (role === "combobox") {
        return tag === "SELECT" || explicitRole === "combobox" || attrText(el, "aria-autocomplete");
      }
      return explicitRole === role;
    };
    const matchesQuery = (text) => {
      const comparable = normalizeComparableText(text);
      if (!normalizedQuery) {
        return true;
      }
      return comparable.includes(normalizedQuery) || (comparable.length >= 2 && normalizedQuery.includes(comparable));
    };
    const matchesNearText = (text) => {
      if (!normalizedNearText) {
        return true;
      }
      return normalizeComparableText(text).includes(normalizedNearText);
    };
    const selectorFor = (el) => {
      const key = `e2e-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      el.setAttribute("data-e2e-auto-target-id", key);
      return `[data-e2e-auto-target-id="${key}"]`;
    };
    const contextMatch = (el) => {
      if (matchesNearText(textOf(el))) {
        return { matched: true, method: "self", score: -1000 };
      }
      const targetRect = el.getBoundingClientRect();
      const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
      let current = el.parentElement;
      for (let depth = 1; current && current !== document.body && depth <= 10; depth += 1) {
        if (!isVisible(current)) {
          current = current.parentElement;
          continue;
        }
        const rect = current.getBoundingClientRect();
        const area = Math.max(rect.width * rect.height, 1);
        const className = String(current.getAttribute("class") || "").toLowerCase();
        const semanticContainer =
          current.getAttribute("role") === "dialog" ||
          className.includes("modal") ||
          className.includes("drawer") ||
          className.includes("popover") ||
          className.includes("dialog");
        const compactContainer =
          area <= viewportArea * 0.72 &&
          rect.width <= Math.max(targetRect.width * 18, 960) &&
          rect.height <= Math.max(targetRect.height * 18, 720);
        if ((semanticContainer || compactContainer) && matchesNearText(textOf(current))) {
          return {
            matched: true,
            method: semanticContainer ? `ancestor-semantic-${depth}` : `ancestor-local-${depth}`,
            score: depth * 10 + area / 100000,
          };
        }
        current = current.parentElement;
      }
      return { matched: false, method: "not-found", score: Number.POSITIVE_INFINITY };
    };

    const nodes = Array.from(document.querySelectorAll(interactiveSelector)).filter((el) => isVisible(el) && roleMatches(el));

    const matches = nodes
      .map((node, index) => {
        const text = textOf(node);
        if (!matchesQuery(text)) {
          return null;
        }
        const near = contextMatch(node);
        if (!near.matched) {
          return null;
        }
        const rect = node.getBoundingClientRect();
        const exactBonus = normalizeComparableText(text) === normalizedQuery ? -200 : 0;
        const score = near.score + exactBonus + index / 1000;
        return {
          node,
          index,
          text,
          score,
          nearTextMatched: true,
          nearTextMatchMethod: near.method,
          bbox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    const selected = Number.isInteger(targetIndex) && targetIndex >= 0
      ? matches[targetIndex]
      : matches[0];
    if (!selected) {
      return null;
    }
    return {
      selector: selectorFor(selected.node),
      confidence: 0.97,
      matchedText: selected.text,
      targetSummary: {
        text: queryText,
        role,
        nearText,
        nearTextMatched: selected.nearTextMatched,
        nearTextMatchMethod: selected.nearTextMatchMethod,
        bbox: selected.bbox,
        candidateIndex: selected.index,
        candidateCount: matches.length,
      },
      rankedCandidates: matches.slice(0, 8).map((item) => ({
        id: `role-near-${item.index}`,
        text: item.text,
        score: item.score,
        bbox: item.bbox,
        nearTextMatched: item.nearTextMatched,
        nearTextMatchMethod: item.nearTextMatchMethod,
      })),
    };
  }, {
    role: target.role,
    queryText: query,
    nearText: target.nearText,
    targetIndex: target.index,
    interactiveSelector: INTERACTIVE_CANDIDATE_SELECTOR,
  }), { label: "resolver:evaluate@L1434", fallback: null }).catch(() => null);

  if (!result?.selector) {
    return null;
  }

  return firstResolvable(page.locator(result.selector), "dom:role-near-text-normalized", {
    confidence: result.confidence,
    matchedText: result.matchedText,
    nearText: target.nearText,
    targetSummary: result.targetSummary,
    rankedCandidates: result.rankedCandidates,
  });
}

async function resolveExplicit(page, action) {
  const target = action.target || {};
  const candidates = [];
  const locator = target.locator || "";
  const query = getTargetQuery(action);
  const scope = target.scope && typeof target.scope === "object" ? target.scope : null;

  if (scope && query) {
    const textPattern = action.strictMatch
      ? new RegExp(`^\\s*${escapeRegex(query)}\\s*$`, "i")
      : new RegExp(escapeRegex(query), "i");
    const scopeCandidates = [];
    if (scope.locator) {
      scopeCandidates.push({
        locator: page.locator(scope.locator).getByText(textPattern),
        strategy: "explicit:scope-locator-text",
      });
    }
    if (scope.testId) {
      const testId = escapeCssString(scope.testId);
      scopeCandidates.push({
        locator: page
          .locator(`[data-testid="${testId}"], [data-test-id="${testId}"], [data-cy="${testId}"]`)
          .getByText(textPattern),
        strategy: "explicit:scope-testid-text",
      });
    }
    if (scope.role) {
      const roleBase = page.getByRole(scope.role);
      scopeCandidates.push({
        locator: (scope.nearText ? roleBase.filter({ hasText: scope.nearText }) : roleBase).getByText(textPattern),
        strategy: "explicit:scope-role-text",
      });
    }
    for (const candidate of scopeCandidates) {
      const found = await firstResolvable(candidate.locator, candidate.strategy, {
        matchedText: query,
        nearText: scope.nearText || target.nearText || null,
        targetSummary: {
          text: query,
          scope,
          nearText: scope.nearText || target.nearText || null,
        },
      });
      if (found) {
        return found;
      }
    }
  }

  if (locator) {
    candidates.push({
      locator: locator.startsWith("//") || locator.startsWith("xpath=")
        ? page.locator(locator.startsWith("xpath=") ? locator : `xpath=${locator}`)
        : page.locator(locator),
      strategy: locator.startsWith("//") || locator.startsWith("xpath=") ? "explicit:xpath" : "explicit:css",
    });
  }
  if (target.testId) {
    const testId = escapeCssString(target.testId);
    candidates.push({
      locator: page.locator(`[data-testid="${testId}"], [data-test-id="${testId}"], [data-cy="${testId}"]`),
      strategy: "explicit:test-id",
    });
  }
  if (target.role && !target.nearText) {
    const roleOptions = target.name || query
      ? { name: target.name || query, exact: action.strictMatch }
      : {};
    candidates.push({
      locator: page.getByRole(target.role, roleOptions),
      strategy: "accessibility:role-name",
    });
  }
  if (target.placeholder) {
    candidates.push({
      locator: page.getByPlaceholder(target.placeholder, { exact: action.strictMatch }),
      strategy: "accessibility:placeholder",
    });
  }
  if (target.ariaLabel) {
    candidates.push({
      locator: page.locator(`[aria-label="${escapeCssString(target.ariaLabel)}"]`),
      strategy: "accessibility:aria-label",
    });
  }
  if (target.title) {
    candidates.push({
      locator: page.locator(`[title="${escapeCssString(target.title)}"]`),
      strategy: "accessibility:title",
    });
  }

  for (const candidate of candidates) {
    const found = await firstResolvable(candidate.locator, candidate.strategy, {
      matchedText: query || target.ariaLabel || target.title || target.testId || locator,
      nearText: target.nearText || null,
      targetSummary: {
        text: query,
        role: target.role || null,
        locator: locator || null,
        placeholder: target.placeholder || null,
        ariaLabel: target.ariaLabel || null,
        title: target.title || null,
        testId: target.testId || null,
        nearText: target.nearText || null,
      },
    });
    if (found) {
      return found;
    }
  }
  const roleNearText = await resolveRoleNearTextCandidate(page, action);
  if (roleNearText) {
    return roleNearText;
  }
  const antSelect = await resolveAntSelectPlaceholder(page, action);
  if (antSelect) {
    return antSelect;
  }
  return null;
}

async function resolveScopedExplicit(page, action, scopeRoot) {
  const target = action.target || {};
  const root = scopeRoot.locator;
  const candidates = [];
  const locator = target.locator || "";
  const query = getTargetQuery(action);
  const textPattern = query
    ? action.strictMatch
      ? new RegExp(`^\\s*${escapeRegex(query)}\\s*$`, "i")
      : new RegExp(escapeRegex(query), "i")
    : null;

  if (action.kind === "uploadFile") {
    const uploadInput = await resolveUploadFileInput(page, action, scopeRoot);
    if (uploadInput) {
      return uploadInput;
    }
  }

  if (locator) {
    candidates.push({
      locator: buildRawLocator(root, locator),
      strategy: isXPathLocator(locator) ? "scoped:explicit:xpath" : "scoped:explicit:css",
    });
  }
  if (target.testId) {
    candidates.push({
      locator: root.locator(buildTestIdSelector(target.testId)),
      strategy: "scoped:explicit:test-id",
    });
  }
  if (target.role) {
    const roleOptions = target.name || query
      ? { name: target.name || query, exact: action.strictMatch }
      : {};
    candidates.push({
      locator: root.getByRole(target.role, roleOptions),
      strategy: "scoped:accessibility:role-name",
    });
  }
  if (target.placeholder) {
    const placeholderPattern = action.strictMatch
      ? new RegExp(`^\\s*${escapeRegex(target.placeholder)}\\s*$`, "i")
      : new RegExp(escapeRegex(target.placeholder), "i");
    candidates.push(
      {
        locator: root.getByPlaceholder(target.placeholder, { exact: action.strictMatch }),
        strategy: "scoped:accessibility:placeholder",
      },
      {
        locator: root.locator(`input[placeholder="${escapeCssString(target.placeholder)}"], textarea[placeholder="${escapeCssString(target.placeholder)}"]`),
        strategy: "scoped:dom:placeholder-attribute",
      },
      {
        locator: root
          .locator(
            ".ant-select, .ant-cascader, .ant-cascader-picker, [class*=' ant-select '], [class^='ant-select '], [class$=' ant-select'], [class*=' ant-cascader'], [class^='ant-cascader'], [class$=' ant-cascader']",
          )
          .filter({ hasText: placeholderPattern }),
        strategy: action.kind === "cascaderSelect" ? "scoped:explicit:ant-cascader-placeholder" : "scoped:explicit:ant-select-placeholder",
      },
    );
  }
  if (target.ariaLabel) {
    candidates.push({
      locator: root.locator(`[aria-label="${escapeCssString(target.ariaLabel)}"]`),
      strategy: "scoped:accessibility:aria-label",
    });
  }
  if (target.title) {
    candidates.push({
      locator: root.locator(`[title="${escapeCssString(target.title)}"]`),
      strategy: "scoped:accessibility:title",
    });
  }
  if (query) {
    const roleForAction =
      action.kind === "comboSearchSelect" || action.kind === "cascaderSelect"
        ? "combobox"
        : action.kind === "check" || action.kind === "uncheck"
          ? "checkbox"
          : action.kind === "selectOption"
            ? "combobox"
            : action.kind === "fill"
              ? "textbox"
              : "button";
    if (action.kind === "fill" || action.kind === "check" || action.kind === "uncheck" || action.kind === "selectOption" || action.kind === "uploadFile" || action.kind === "comboSearchSelect" || action.kind === "cascaderSelect") {
      candidates.push(
        {
          locator: root.getByLabel(query, { exact: action.strictMatch }),
          strategy: "scoped:dom:label",
        },
        {
          locator: root.getByPlaceholder(query, { exact: action.strictMatch }),
          strategy: "scoped:dom:placeholder-query",
        },
        {
          locator: root.getByRole(roleForAction, { name: query, exact: action.strictMatch }),
          strategy: `scoped:dom:role-${roleForAction}`,
        },
        {
          locator: root.locator(`input[name="${escapeCssString(query)}"], textarea[name="${escapeCssString(query)}"], select[name="${escapeCssString(query)}"]`),
          strategy: "scoped:dom:name",
        },
      );
    } else {
      candidates.push(
        {
          locator: root.getByRole("button", { name: query, exact: action.strictMatch }),
          strategy: "scoped:dom:role-button",
        },
        {
          locator: root.getByRole("link", { name: query, exact: action.strictMatch }),
          strategy: "scoped:dom:role-link",
        },
        {
          locator: root.getByText(textPattern),
          strategy: "scoped:dom:text",
        },
        {
          locator: root.getByLabel(query, { exact: action.strictMatch }),
          strategy: "scoped:dom:label",
        },
        {
          locator: root.locator(`[aria-label="${escapeCssString(query)}"], [title="${escapeCssString(query)}"]`),
          strategy: "scoped:dom:aria-title",
        },
      );
    }
  }

  for (const candidate of candidates) {
    const found = await firstResolvable(candidate.locator, candidate.strategy, {
      matchedText: query || target.ariaLabel || target.title || target.testId || locator,
      nearText: target.nearText || null,
      targetSummary: {
        text: query,
        role: target.role || null,
        locator: locator || null,
        placeholder: target.placeholder || null,
        ariaLabel: target.ariaLabel || null,
        title: target.title || null,
        testId: target.testId || null,
        nearText: target.nearText || null,
        scope: scopeRoot.scopeSummary,
      },
    }).catch(() => null);
    if (found) {
      return found;
    }
  }
  return null;
}

async function resolveScopedActionTarget(page, action) {
  const scopeRoot = await resolveTargetScopeRoot(page, action.target || {});
  if (!scopeRoot?.locator) {
    return {
      source: "dom",
      strategy: "scoped:scope-not-found",
      success: false,
      error: "target-scope-not-found",
      confidence: 0,
      matchedText: null,
      targetSummary: {
        text: getTargetQuery(action) || null,
        scope: scopeRoot?.scopeSummary || action.target?.scope || null,
      },
      locatorSummary: {
        strategy: "scoped:scope-not-found",
        count: 0,
      },
      rankedCandidates: [],
    };
  }

  const explicit = await resolveScopedExplicit(page, action, scopeRoot);
  if (explicit) {
    return explicit;
  }

  return {
    source: "dom",
    strategy: "scoped:not-found",
    success: false,
    error: "action-target-unresolved",
    confidence: 0,
    matchedText: null,
    targetSummary: {
      text: getTargetQuery(action) || null,
      scope: scopeRoot.scopeSummary,
    },
    locatorSummary: {
      strategy: "scoped:not-found",
      count: 0,
    },
    rankedCandidates: [],
  };
}

async function resolveExact(page, action) {
  const query = getTargetQuery(action);
  if (!query && (action.kind === "comboSearchSelect" || action.kind === "cascaderSelect")) {
    const comboCandidates = [
      {
        locator: page.getByRole("combobox"),
        strategy: "dom:role-combobox-first",
      },
      {
        locator: page.locator("select, [role='combobox'], input[list], input[aria-autocomplete]"),
        strategy: "dom:combobox-css-first",
      },
    ];
    for (const candidate of comboCandidates) {
      const count = await candidate.locator.count().catch(() => 0);
      if (count !== 1) {
        continue;
      }
      const found = await firstResolvable(candidate.locator, candidate.strategy, {
        matchedText: null,
        targetSummary: { text: null, role: "combobox" },
      });
      if (found) {
        return found;
      }
    }
  }
  if (!query) {
    return null;
  }

  const exactTextPattern = new RegExp(`^\\s*${escapeRegex(query)}\\s*$`, "i");
  const genericCandidates = [];

  if (action.kind === "fill" || action.kind === "check" || action.kind === "uncheck" || action.kind === "selectOption" || action.kind === "uploadFile" || action.kind === "comboSearchSelect" || action.kind === "cascaderSelect") {
    const roleForAction =
      action.kind === "comboSearchSelect" || action.kind === "cascaderSelect"
        ? "combobox"
        : action.kind === "check" || action.kind === "uncheck"
          ? "checkbox"
          : action.kind === "selectOption"
            ? "combobox"
            : "textbox";
    genericCandidates.push(
      {
        locator: page.getByLabel(query, { exact: true }),
        strategy: "dom:label-exact",
      },
      {
        locator: page.getByPlaceholder(query, { exact: true }),
        strategy: "dom:placeholder-exact",
      },
      {
        locator: page.getByRole(roleForAction, { name: query, exact: true }),
        strategy: `dom:role-${roleForAction}-exact`,
      },
      {
        locator: page.locator(`input[name="${query}"], textarea[name="${query}"], select[name="${query}"]`),
        strategy: "dom:name-exact",
      },
    );
  } else {
    if (action.target?.role) {
      genericCandidates.push({
        locator: page.getByRole(action.target.role, { name: query, exact: true }),
        strategy: `dom:role-${action.target.role}-exact`,
      });
    }
    genericCandidates.push(
      {
        locator: page.getByRole("button", { name: query, exact: true }),
        strategy: "dom:role-button-exact",
      },
      {
        locator: page.getByRole("link", { name: query, exact: true }),
        strategy: "dom:role-link-exact",
      },
      {
        locator: page.getByText(exactTextPattern),
        strategy: "dom:text-exact",
      },
      {
        locator: page.getByLabel(query, { exact: true }),
        strategy: "dom:label-exact",
      },
      {
        locator: page.locator(`[aria-label="${escapeCssString(query)}"], [title="${escapeCssString(query)}"]`),
        strategy: "dom:aria-title-exact",
      },
    );
  }

  for (const candidate of genericCandidates) {
    const found = await firstResolvable(candidate.locator, candidate.strategy, {
      matchedText: query,
      targetSummary: { text: query },
    });
    if (found) {
      return found;
    }
  }
  return null;
}

function resolveTypeHeuristicCandidate(action, domCandidates) {
  if (action.kind !== "fill") {
    return null;
  }
  const editableCandidates = domCandidates.filter((candidate) => candidate.editable);
  if (!editableCandidates.length) {
    return null;
  }

  const bucket = inferFillIntent(action);
  if (!bucket) {
    return null;
  }

  const withMetadata = editableCandidates.map((candidate) => ({
    candidate,
    haystack: normalize(
      [
        candidate.text,
        candidate.label,
        candidate.contextText,
        candidate.placeholder,
        candidate.name,
        candidate.idAttr,
        candidate.inputType,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  }));

  if (bucket === "username") {
    const matched = withMetadata.find(({ candidate, haystack }) =>
      normalize(candidate.inputType) !== "password" &&
      USERNAME_HINTS.some((item) => haystack.includes(normalize(item))),
    );
    return matched?.candidate
      ?? editableCandidates.find((candidate) => normalize(candidate.inputType) !== "password")
      ?? editableCandidates[0];
  }
  if (bucket === "password") {
    const matched = withMetadata.find(({ haystack }) =>
      PASSWORD_HINTS.some((item) => haystack.includes(normalize(item))),
    );
    return matched?.candidate
      ?? editableCandidates.find((candidate) => normalize(candidate.inputType) === "password")
      ?? editableCandidates[editableCandidates.length - 1];
  }
  return null;
}

async function resolveFuzzyDom(page, action) {
  const query = getTargetQuery(action);
  if (!query) {
    return null;
  }
  const semanticQuery = [query, action.target?.nearText, action.target?.iconHint]
    .filter(Boolean)
    .join(" ");
  const domCandidates = await collectDomCandidates(page);
  const heuristicCandidate = resolveTypeHeuristicCandidate(action, domCandidates);
  if (heuristicCandidate) {
    return {
      source: "dom",
      locator: buildEditableLocator(page, heuristicCandidate),
      strategy: "dom:type-heuristic",
      confidence: 0.84,
      matchedText: pickText(heuristicCandidate),
      targetSummary: heuristicCandidate,
      locatorSummary: {
        strategy: "dom:type-heuristic",
        count: domCandidates.filter((candidate) => candidate.editable).length,
      },
      rankedCandidates: [],
    };
  }
  const detections = domCandidates.map((candidate) => ({
    id: candidate.id,
    text: [
      candidate.text,
      candidate.label,
      candidate.contextText,
      candidate.placeholder,
      candidate.name,
      candidate.idAttr,
      candidate.inputType,
      candidate.ariaLabel,
      candidate.title,
      candidate.testId,
      candidate.svgText,
      candidate.className,
    ]
      .filter(Boolean)
      .join(" / "),
    bbox: candidate.bbox,
    kind: candidate.editable ? "input" : "button",
    score: candidate.enabled ? 0.7 : 0.2,
  }));
  const ranked = buildSemanticMatches({
    query: semanticQuery,
    detections,
    frameSize: null,
  }).slice(0, 8);

  const top = ranked[0];
  if (!top) {
    return null;
  }

  const matchedCandidate = domCandidates.find(
    (candidate) => candidate.id === top.id,
  );
  if (!matchedCandidate) {
    return null;
  }

  const normalizedQuery = normalize(query);
  const filter = [
    matchedCandidate.text,
    matchedCandidate.label,
    matchedCandidate.contextText,
    matchedCandidate.placeholder,
    matchedCandidate.name,
    matchedCandidate.idAttr,
    matchedCandidate.inputType,
    matchedCandidate.ariaLabel,
    matchedCandidate.title,
    matchedCandidate.testId,
    matchedCandidate.svgText,
  ]
    .filter(Boolean)
    .map((item) => normalize(item));
  const locator = matchedCandidate.editable
    ? buildEditableLocator(page, matchedCandidate)
    : matchedCandidate.selector
      ? page.locator(matchedCandidate.selector)
      : page.locator(CLICKABLE_CANDIDATE_SELECTOR).filter({
          hasText: new RegExp(escapeRegex(query), "i"),
        });

  const found = await firstResolvable(locator, "dom:fuzzy-ranked", {
    confidence: Math.min(0.94, top.score ?? 0.7),
    matchedText: pickText(matchedCandidate),
    targetSummary: matchedCandidate,
    rankedCandidates: ranked,
  });
  if (found) {
    return found;
  }

  if (filter.includes(normalizedQuery) || matchedCandidate.bbox) {
    return {
      source: "dom",
      locator: null,
      strategy: filter.includes(normalizedQuery) ? "dom:fuzzy-ranked-eval" : "dom:fuzzy-ranked-bbox",
      confidence: Math.min(filter.includes(normalizedQuery) ? 0.9 : 0.78, top.score ?? 0.7),
      matchedText: pickText(matchedCandidate),
      targetSummary: matchedCandidate,
      locatorSummary: {
        strategy: "dom:fuzzy-ranked-eval",
        count: ranked.length,
      },
      rankedCandidates: ranked,
      bbox: matchedCandidate.bbox,
    };
  }

  return null;
}

async function resolveWithOcr(page, action, ocrService) {
  const query = getTargetQuery(action);
  const nearText = action.target?.nearText || "";
  if (!ocrService || !query) {
    return null;
  }
  const snapshot = await capturePageSnapshot(page);
  const result = await ocrService.runOcr({
    imageBuffer: snapshot.screenshotBuffer,
    width: snapshot.viewport.width,
    height: snapshot.viewport.height,
  });
  const ranked = buildSemanticMatches({
    query,
    detections: result.detections,
    frameSize: {
      width: snapshot.viewport.width,
      height: snapshot.viewport.height,
    },
  }).slice(0, 8);
  let scopedRanked = ranked;
  let nearRanked = [];
  if (nearText) {
    nearRanked = buildSemanticMatches({
      query: nearText,
      detections: result.detections,
      frameSize: {
        width: snapshot.viewport.width,
        height: snapshot.viewport.height,
      },
    })
      .filter((item) => item.bbox && (item.score ?? 0) >= 0.55)
      .slice(0, 8);

    const centerOf = (bbox) => bbox
      ? {
          x: (bbox.x ?? 0) + (bbox.width ?? 0) / 2,
          y: (bbox.y ?? 0) + (bbox.height ?? 0) / 2,
        }
      : null;
    const weightedDistance = (a, b) => {
      if (!a || !b) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.abs(a.x - b.x) * 0.35 + Math.abs(a.y - b.y);
    };
    const maxNearDistance = Math.min(
      900,
      Math.max(420, snapshot.viewport.width * 0.24 + snapshot.viewport.height * 0.12),
    );
    scopedRanked = ranked
      .map((candidate) => {
        const candidateCenter = centerOf(candidate.bbox);
        const nearestNearText = nearRanked
          .map((nearCandidate) => ({
            candidate: nearCandidate,
            distance: weightedDistance(candidateCenter, centerOf(nearCandidate.bbox)),
          }))
          .sort((a, b) => a.distance - b.distance)[0] || null;
        return {
          ...candidate,
          nearText,
          nearTextMatched: Boolean(nearestNearText && nearestNearText.distance <= maxNearDistance),
          nearTextDistance: nearestNearText?.distance ?? null,
          nearTextReference: nearestNearText?.candidate
            ? {
                text: nearestNearText.candidate.text ?? null,
                bbox: nearestNearText.candidate.bbox ?? null,
                score: nearestNearText.candidate.score ?? null,
              }
            : null,
        };
      })
      .filter((candidate) => candidate.nearTextMatched)
      .sort((a, b) => (a.nearTextDistance ?? 0) - (b.nearTextDistance ?? 0) || (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 8);
  }

  const top = scopedRanked[0];
  if (!top) {
    return {
      source: "ocr",
      strategy: "ocr:none",
      confidence: 0,
      matchedText: null,
      targetSummary: {
        text: query,
        nearText: nearText || null,
        nearTextMatched: false,
        nearTextCandidateCount: nearRanked.length,
      },
      locatorSummary: { strategy: "ocr:none", count: ranked.length },
      rankedCandidates: scopedRanked.length ? scopedRanked : ranked,
      ocr: result,
    };
  }
  return {
    source: "ocr",
    strategy: nearText ? "ocr:fallback-near-text" : "ocr:fallback",
    confidence: top.score ?? 0.5,
    matchedText: top.text ?? null,
    targetSummary: {
      text: top.text ?? null,
      bbox: top.bbox ?? null,
      kind: top.kind ?? null,
      nearText: nearText || null,
      nearTextMatched: nearText ? Boolean(top.nearTextMatched) : false,
      nearTextDistance: top.nearTextDistance ?? null,
      nearTextReference: top.nearTextReference ?? null,
    },
    locatorSummary: { strategy: nearText ? "ocr:fallback-near-text" : "ocr:fallback", count: scopedRanked.length },
    rankedCandidates: scopedRanked,
    bbox: top.bbox ?? null,
    ocr: result,
  };
}

async function scrollPage(page, config) {
  await page.mouse.wheel(0, config.deltaY);
  await page.waitForTimeout(config.settleMs);
}

async function resolveActionTarget(page, action, options = {}) {
  const attempts = [];
  const maxSteps = action.autoScroll?.maxSteps ?? 10;
  const scrollConfig = {
    deltaY: action.autoScroll?.deltaY ?? 360,
    settleMs: action.autoScroll?.settleMs ?? 160,
  };

  const tryResolve = async () => {
    if (hasTargetScope(action.target || {})) {
      const scoped = await resolveScopedActionTarget(page, action);
      attempts.push({ strategy: scoped.strategy, confidence: scoped.confidence, error: scoped.error || null });
      return scoped;
    }
    const preferredUploadInput = action.kind === "uploadFile" && action.target?.nearText
      ? await resolveUploadFileInput(page, action)
      : null;
    if (preferredUploadInput) {
      attempts.push({ strategy: preferredUploadInput.strategy, confidence: preferredUploadInput.confidence });
      return preferredUploadInput;
    }
    const explicit = await resolveExplicit(page, action);
    if (explicit) {
      attempts.push({ strategy: explicit.strategy, confidence: explicit.confidence });
      return explicit;
    }
    const adapter = await resolveActionTargetWithAdapters(page, action, {
      uiContext: options.uiContext,
    });
    if (adapter) {
      attempts.push({
        strategy: adapter.strategy,
        confidence: adapter.confidence,
        adapter: adapter.adapter?.name || adapter.targetSummary?.adapter || null,
      });
      return adapter;
    }
    const exact = await resolveExact(page, action);
    if (exact) {
      attempts.push({ strategy: exact.strategy, confidence: exact.confidence });
      return exact;
    }
    const collapsedMenu = await resolveCollapsedMenuText(page, action);
    if (collapsedMenu) {
      attempts.push({ strategy: collapsedMenu.strategy, confidence: collapsedMenu.confidence });
      return collapsedMenu;
    }
    const uploadInput = await resolveUploadFileInput(page, action);
    if (uploadInput) {
      attempts.push({ strategy: uploadInput.strategy, confidence: uploadInput.confidence });
      return uploadInput;
    }
    const fuzzy = await resolveFuzzyDom(page, action);
    if (fuzzy) {
      attempts.push({ strategy: fuzzy.strategy, confidence: fuzzy.confidence });
      return fuzzy;
    }
    return null;
  };

  let resolution = await tryResolve();
  if (!resolution && action.enableScroll) {
    for (let step = 0; step < maxSteps; step += 1) {
      await scrollPage(page, scrollConfig);
      resolution = await tryResolve();
      attempts.push({ strategy: "scroll-retry", step: step + 1 });
      if (resolution) {
        break;
      }
    }
  }

  if (!resolution) {
    resolution = await resolveWithOcr(page, action, options.ocrService);
  }

  if (resolution?.success === false) {
    return {
      ...resolution,
      attempts,
    };
  }

  if (!resolution) {
    return {
      success: false,
      strategy: "not-found",
      confidence: 0,
      matchedText: null,
      targetSummary: null,
      locatorSummary: { strategy: "not-found", count: 0 },
      rankedCandidates: [],
      attempts,
    };
  }

  const lowConfidenceOcr =
    resolution?.source === "ocr" &&
    (resolution.confidence ?? 0) < OCR_CONFIDENCE_THRESHOLD;

  return {
    success: !lowConfidenceOcr,
    error: lowConfidenceOcr ? "low-confidence-target" : null,
    ...resolution,
    attempts,
  };
}

module.exports = {
  resolveActionTarget,
  OCR_CONFIDENCE_THRESHOLD,
};
