"use strict";


const VIEWPORT_KEYS = ["width", "height"];
// Bounds are sanity bounds, not product opinions: below 200px nothing renders a
// usable page, above 8K a screenshot no longer fits in memory comfortably.
const VIEWPORT_LIMITS = {
  width: { min: 200, max: 7680 },
  height: { min: 200, max: 4320 },
};

// Returns `{ viewport, errors }`. `viewport` is null when the value is absent or
// invalid; `errors` are human-readable reasons (precheck turns them into issues).
function parseViewport(value) {
  if (value == null) {
    return { viewport: null, errors: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { viewport: null, errors: ["viewport must be an object { width, height }"] };
  }
  const errors = [];
  const unknown = Object.keys(value).filter((key) => !VIEWPORT_KEYS.includes(key));
  if (unknown.length) {
    // A misspelt key ("widht") would otherwise silently run at the default size —
    // exactly the false green this field exists to prevent.
    errors.push(`unknown viewport key(s): ${unknown.join(", ")} (allowed: width, height)`);
  }
  const output = {};
  for (const key of VIEWPORT_KEYS) {
    const raw = value[key];
    const number = Number(raw);
    if (raw == null || raw === "" || !Number.isInteger(number)) {
      errors.push(`viewport.${key} must be an integer number of CSS pixels`);
      continue;
    }
    const { min, max } = VIEWPORT_LIMITS[key];
    if (number < min || number > max) {
      errors.push(`viewport.${key}=${number} is outside ${min}..${max}`);
      continue;
    }
    output[key] = number;
  }
  if (errors.length) {
    return { viewport: null, errors };
  }
  return { viewport: output, errors: [] };
}

function normalizeViewport(value) {
  return parseViewport(value).viewport;
}

// The case's own `viewport` beats the file's `settings.viewport`. `source` tells
// the evidence where the value came from; `null` means "the channel default".
function resolveCaseViewport(testFile = {}, caseItem = null) {
  const caseViewport = normalizeViewport(caseItem?.viewport);
  if (caseViewport) {
    return { viewport: caseViewport, source: "case" };
  }
  const fileViewport = normalizeViewport(testFile?.settings?.viewport);
  if (fileViewport) {
    return { viewport: fileViewport, source: "file" };
  }
  return { viewport: null, source: null };
}

// `run()` options fragment for one case. Empty when nothing was declared, so the
// channel keeps its own default (1440×900 headless, window-sized visible).
function buildViewportRunOptions(testFile = {}, caseItem = null) {
  const { viewport, source } = resolveCaseViewport(testFile, caseItem);
  return viewport ? { viewport, viewportSource: source } : {};
}

module.exports = {
  VIEWPORT_KEYS,
  VIEWPORT_LIMITS,
  buildViewportRunOptions,
  normalizeViewport,
  parseViewport,
  resolveCaseViewport,
};
