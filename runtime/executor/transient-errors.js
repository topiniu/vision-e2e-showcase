"use strict";


const TRANSIENT_PATTERNS = [
  /waiting for fonts/i,
  /page\.screenshot/i,
  /screenshot[^]*timeout/i,
  /Timeout[^]*exceeded[^]*screenshot/i,
  /Execution context was destroyed/i,
  /Target (?:page|frame|context)?[^]*closed/i,
  /frame was detached/i,
  /Navigation[^]*(?:interrupted|aborted)/i,
  /net::ERR_NETWORK_CHANGED/i,
  /net::ERR_CONNECTION_RESET/i,
  /net::ERR_ABORTED/i,
  /冻死/,
  /无进度/,
  /\bno[-\s]?progress\b/i,
  /render(?:er)?[^]*(?:froze|frozen)/i,
];

const TRANSIENT_CODES = new Set([
  "render-frozen",
  "render-freeze",
  "no-progress",
  "frozen",
  "fonts-not-ready",
  "fonts-not-loaded",
  "screenshot-failed",
  "screenshot-transient",
  "context-destroyed",
  "target-closed",
  "navigation-interrupted",
  "transient",
]);

function errorText(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return [error.code, error.message, error.name, error.detail]
    .filter((part) => typeof part === "string" && part)
    .join(" ");
}

function isTransientError(error) {
  if (!error) {
    return false;
  }
  // Explicit hint from a lower layer wins.
  if (typeof error === "object" && error.retryable === true) {
    return true;
  }
  const code = typeof error === "object" ? String(error.code || "") : "";
  if (code && TRANSIENT_CODES.has(code)) {
    return true;
  }
  const text = errorText(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = {
  isTransientError,
  errorText,
  TRANSIENT_PATTERNS,
  TRANSIENT_CODES,
};
