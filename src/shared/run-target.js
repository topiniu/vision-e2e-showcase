"use strict";


const ORIGIN_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ORIGIN_TOKEN_PATTERN = /\{\{\s*origin\.([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

// Production hosts a run may never target. Matched against the hostname;
// `*.example.com` matches any subdomain and the apex. Overridable with
// ZHUZHU_TARGET_DENY_HOSTS (comma separated; an explicit empty value disables
// the default list). The test environment (`*.test.example.org`) is not matched.
const DEFAULT_DENY_HOSTS = ["*.production.example.org"];

function createTargetError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.details = details;
  return error;
}

function parseHostList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function resolveHostPolicy(env = process.env) {
  const deny = Object.prototype.hasOwnProperty.call(env, "ZHUZHU_TARGET_DENY_HOSTS")
    ? parseHostList(env.ZHUZHU_TARGET_DENY_HOSTS)
    : DEFAULT_DENY_HOSTS;
  const allow = parseHostList(env.ZHUZHU_TARGET_ALLOW_HOSTS);
  return { deny, allow };
}

function hostMatches(hostname, pattern) {
  const host = String(hostname || "").toLowerCase();
  if (pattern.startsWith("*.")) {
    const apex = pattern.slice(2);
    return host === apex || host.endsWith(`.${apex}`);
  }
  return host === pattern;
}

// Returns null when the URL may be targeted, otherwise the reason it may not.
function checkHostAllowed(url, policy = resolveHostPolicy()) {
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch (_error) {
    return { reason: "invalid-url" };
  }
  const denied = policy.deny.find((pattern) => hostMatches(hostname, pattern));
  if (denied) {
    return { reason: "denied-host", hostname, pattern: denied };
  }
  if (policy.allow.length && !policy.allow.some((pattern) => hostMatches(hostname, pattern))) {
    return { reason: "not-in-allow-list", hostname };
  }
  return null;
}

function normalizeOriginUrl(name, value) {
  const text = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    throw createTargetError("invalid-target", `target.origins.${name} must be an absolute http(s) URL, got "${text}".`, { origin: name });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw createTargetError("invalid-target", `target.origins.${name} must use http or https.`, { origin: name });
  }
  // An origin is a base: `{{origin.app}}/login` must not become `//login`.
  return text.replace(/\/+$/, "");
}

// Validates and canonicalises a caller-supplied target. Returns null when no
// target was given (legacy behaviour: the file's own addresses are used as-is).
function normalizeRunTarget(raw, { policy = resolveHostPolicy() } = {}) {
  if (raw == null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw createTargetError("invalid-target", "target must be an object.");
  }
  const origins = {};
  const rawOrigins = raw.origins == null ? {} : raw.origins;
  if (typeof rawOrigins !== "object" || Array.isArray(rawOrigins)) {
    throw createTargetError("invalid-target", "target.origins must be an object of { name: url }.");
  }
  for (const [name, value] of Object.entries(rawOrigins)) {
    if (!ORIGIN_NAME_PATTERN.test(name)) {
      throw createTargetError("invalid-target", `target.origins key "${name}" must match ${ORIGIN_NAME_PATTERN}.`, { origin: name });
    }
    const url = normalizeOriginUrl(name, value);
    const blocked = checkHostAllowed(url, policy);
    if (blocked) {
      throw createTargetError(
        "target-origin-denied",
        `target.origins.${name} (${url}) may not be targeted: ${blocked.reason}${blocked.pattern ? ` (${blocked.pattern})` : ""}.`,
        { origin: name, url, ...blocked },
      );
    }
    origins[name] = url;
  }
  const vars = {};
  if (raw.vars != null) {
    if (typeof raw.vars !== "object" || Array.isArray(raw.vars)) {
      throw createTargetError("invalid-target", "target.vars must be an object.");
    }
    for (const [key, value] of Object.entries(raw.vars)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
        throw createTargetError("invalid-target", `target.vars key "${key}" is not a valid variable name.`, { variable: key });
      }
      vars[key] = value == null ? "" : String(value);
    }
  }
  const authProfile = raw.authProfile == null ? null : String(raw.authProfile).trim() || null;
  const credentialRef = raw.credentialRef == null ? null : String(raw.credentialRef).trim() || null;
  return {
    origins,
    authProfile,
    credentialRef,
    vars,
    preflight: raw.preflight !== false,
  };
}

function collectOriginReferences(value, found = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(ORIGIN_TOKEN_PATTERN)) {
      found.add(match[1]);
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectOriginReferences(item, found));
    return found;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectOriginReferences(item, found));
  }
  return found;
}

function substituteOrigins(value, origins) {
  if (typeof value === "string") {
    return value.includes("{{") ? value.replace(ORIGIN_TOKEN_PATTERN, (match, name) => origins[name] ?? match) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteOrigins(item, origins));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteOrigins(item, origins)]));
  }
  return value;
}

// Materialises `{{origin.*}}` in an already reference-resolved test file.
// Origins are substituted statically (they cannot change during a run), which
// covers every place a URL is read — baseUrl, steps, recovery detects, build
// probes — on every channel, with one rule. Throws `target-origin-missing` when
// the file references an origin the target does not supply.
function applyRunTarget(testFile, target, { policy = resolveHostPolicy() } = {}) {
  const referenced = [...collectOriginReferences(testFile)].sort();
  const origins = target?.origins || {};
  const missing = referenced.filter((name) => !Object.prototype.hasOwnProperty.call(origins, name));
  if (missing.length) {
    throw createTargetError(
      "target-origin-missing",
      target
        ? `This test file references origin(s) ${missing.map((name) => `"${name}"`).join(", ")} that target.origins does not supply. ` +
          "Pass them in target.origins; there is no fallback address."
        : `This test file references origin(s) ${missing.map((name) => `"${name}"`).join(", ")} but no target was given. ` +
          "Pass target.origins with the environment to run against.",
      { missing, referenced, supplied: Object.keys(origins) },
    );
  }
  const materialized = referenced.length ? substituteOrigins(testFile, origins) : testFile;
  // The base URL decides where the browser lands first; even a legacy file with
  // a literal address must not land on a denied host.
  const baseUrl = materialized?.baseUrl;
  if (typeof baseUrl === "string" && /^https?:\/\//i.test(baseUrl)) {
    const blocked = checkHostAllowed(baseUrl, policy);
    if (blocked) {
      throw createTargetError(
        "target-origin-denied",
        `baseUrl ${baseUrl} may not be targeted: ${blocked.reason}${blocked.pattern ? ` (${blocked.pattern})` : ""}.`,
        { url: baseUrl, ...blocked },
      );
    }
  }
  return { testFile: materialized, referenced, used: referenced.map((name) => ({ name, url: origins[name] })) };
}

// What a report may show about a target: addresses and names, never secrets.
function describeRunTarget(target, applied = null) {
  if (!target) {
    return null;
  }
  return {
    origins: { ...target.origins },
    usedOrigins: applied ? applied.referenced : null,
    authProfile: target.authProfile,
    credentialRef: target.credentialRef,
    varKeys: Object.keys(target.vars || {}),
    preflight: target.preflight,
  };
}

module.exports = {
  DEFAULT_DENY_HOSTS,
  applyRunTarget,
  checkHostAllowed,
  collectOriginReferences,
  describeRunTarget,
  normalizeRunTarget,
  resolveHostPolicy,
};
