"use strict";


function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// `target` / item entries: `{ testId }`, `{ locator }` (CSS) or `{ css }`.
function selectorOf(entry) {
  if (typeof entry === "string") {
    return entry.trim() || null;
  }
  if (!isPlainObject(entry)) {
    return null;
  }
  if (typeof entry.testId === "string" && entry.testId.trim()) {
    return `[data-testid="${entry.testId.trim().replace(/"/g, '\\"')}"]`;
  }
  const css = typeof entry.locator === "string" ? entry.locator : typeof entry.css === "string" ? entry.css : "";
  return css.trim() || null;
}

// Returns `{ spec, errors }`.
//   items: a CSS selector evaluated INSIDE the target (the common case — "every
//          filter cell of this panel"), or an array of explicit entries (strings
//          are CSS inside the target, objects are page-global testId/locator).
function parseLayoutSpec(raw = {}) {
  const errors = [];
  const containerSelector = raw.target == null ? null : selectorOf(raw.target);
  if (raw.target != null && !containerSelector) {
    errors.push("assertLayout.target must be { testId } or { locator } (CSS)");
  }
  let items = [];
  if (typeof raw.items === "string" && raw.items.trim()) {
    items = [{ selector: raw.items.trim(), scoped: true }];
  } else if (Array.isArray(raw.items) && raw.items.length) {
    for (const entry of raw.items) {
      const selector = selectorOf(entry);
      if (!selector) {
        errors.push("every assertLayout.items entry must be a CSS string or { testId } / { locator }");
        continue;
      }
      items.push({ selector, scoped: typeof entry === "string" });
    }
  } else {
    errors.push("assertLayout needs `items`: a CSS selector inside `target`, or a list of elements");
  }
  const noOverlap = raw.noOverlap !== false;
  const truncationRaw = raw.noTruncation ?? raw.truncation;
  const noTruncation = truncationRaw === false ? false : true;
  const truncationSelector = typeof truncationRaw === "string" && truncationRaw.trim() ? truncationRaw.trim() : null;
  const withinTarget = raw.withinTarget === true;
  if (withinTarget && !containerSelector) {
    errors.push("assertLayout.withinTarget needs a `target`");
  }
  if (!noOverlap && !noTruncation && !withinTarget) {
    errors.push("assertLayout checks nothing: noOverlap, noTruncation and withinTarget are all off");
  }
  const minItems = raw.minItems == null ? (noOverlap ? 2 : 1) : Number(raw.minItems);
  if (!Number.isInteger(minItems) || minItems < 1) {
    errors.push("assertLayout.minItems must be a positive integer");
  }
  const expectCount = raw.expectCount == null ? null : Number(raw.expectCount);
  if (expectCount != null && (!Number.isInteger(expectCount) || expectCount < 1)) {
    errors.push("assertLayout.expectCount must be a positive integer");
  }
  const tolerancePx = raw.tolerancePx == null ? 1 : Number(raw.tolerancePx);
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0 || tolerancePx > 50) {
    errors.push("assertLayout.tolerancePx must be 0..50");
  }
  const timeoutMs = raw.timeoutMs == null ? 5000 : Number(raw.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    errors.push("assertLayout.timeoutMs must be 0..60000");
  }
  if (errors.length) {
    return { spec: null, errors };
  }
  return {
    spec: {
      containerSelector,
      items,
      noOverlap,
      noTruncation,
      truncationSelector,
      withinTarget,
      minItems,
      expectCount,
      tolerancePx,
      timeoutMs,
    },
    errors: [],
  };
}

module.exports = {
  parseLayoutSpec,
  selectorOf,
};
