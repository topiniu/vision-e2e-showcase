"use strict";


const ABORT_ERROR_CODES = [
  "aborted",
  "accessdenied",
  "addressunreachable",
  "blockedbyclient",
  "blockedbyresponse",
  "connectionaborted",
  "connectionclosed",
  "connectionfailed",
  "connectionrefused",
  "connectionreset",
  "internetdisconnected",
  "namenotresolved",
  "timedout",
  "failed",
];
const ROUTE_FAULT_MODES = ["abort", "respond", "delay"];
const MAX_DELAY_MS = 120_000;

// Shared by the runtime and precheck: returns `{ spec, errors }`.
function parseRouteFaultSpec(raw = {}) {
  const errors = [];
  const urlIncludes = typeof raw.urlIncludes === "string" ? raw.urlIncludes.trim() : "";
  const urlMatches = typeof raw.urlMatches === "string" ? raw.urlMatches.trim() : "";
  if (!urlIncludes && !urlMatches) {
    errors.push("routeFault needs `urlIncludes` (substring) or `urlMatches` (regular expression)");
  }
  if (urlIncludes && urlMatches) {
    errors.push("routeFault takes either `urlIncludes` or `urlMatches`, not both");
  }
  let regex = null;
  if (urlMatches) {
    try {
      regex = new RegExp(urlMatches);
    } catch (error) {
      errors.push(`routeFault.urlMatches is not a valid regular expression: ${error.message}`);
    }
  }
  const mode = String(raw.mode || (raw.status != null || raw.body != null ? "respond" : "abort")).trim();
  if (!ROUTE_FAULT_MODES.includes(mode)) {
    errors.push(`routeFault.mode must be one of ${ROUTE_FAULT_MODES.join(" / ")}`);
  }
  const errorCode = String(raw.errorCode || "failed").trim();
  if (mode === "abort" && !ABORT_ERROR_CODES.includes(errorCode)) {
    errors.push(`routeFault.errorCode must be one of ${ABORT_ERROR_CODES.join(", ")}`);
  }
  const status = raw.status == null ? 500 : Number(raw.status);
  if (mode === "respond" && (!Number.isInteger(status) || status < 200 || status > 599)) {
    errors.push("routeFault.status must be an HTTP response status (200..599)");
  }
  const delayMs = raw.delayMs == null ? 0 : Number(raw.delayMs);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    errors.push(`routeFault.delayMs must be 0..${MAX_DELAY_MS}`);
  }
  if (mode === "delay" && !(delayMs > 0)) {
    errors.push("routeFault mode \"delay\" needs a positive `delayMs`");
  }
  const times = raw.times == null ? null : Number(raw.times);
  if (times != null && (!Number.isInteger(times) || times < 1)) {
    errors.push("routeFault.times must be a positive integer (omit it to fault every match)");
  }
  const minHits = raw.minHits == null ? 1 : Number(raw.minHits);
  if (!Number.isInteger(minHits) || minHits < 1) {
    errors.push("routeFault.minHits must be a positive integer (default 1)");
  }
  if (times != null && minHits > times) {
    errors.push("routeFault.minHits must not exceed times");
  }
  const method = typeof raw.method === "string" && raw.method.trim() ? raw.method.trim().toUpperCase() : null;
  if (errors.length) {
    return { spec: null, errors };
  }
  const body = raw.body == null ? "" : typeof raw.body === "string" ? raw.body : JSON.stringify(raw.body);
  const contentType =
    typeof raw.contentType === "string" && raw.contentType.trim()
      ? raw.contentType.trim()
      : raw.body != null && typeof raw.body !== "string"
        ? "application/json"
        : "text/plain";
  return {
    spec: {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
      urlIncludes: urlIncludes || null,
      urlMatches: urlMatches || null,
      regex,
      method,
      mode,
      errorCode,
      status,
      body,
      contentType,
      headers: raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers) ? { ...raw.headers } : {},
      delayMs,
      times,
      minHits,
    },
    errors: [],
  };
}

module.exports = {
  ABORT_ERROR_CODES,
  MAX_DELAY_MS,
  ROUTE_FAULT_MODES,
  parseRouteFaultSpec,
};
