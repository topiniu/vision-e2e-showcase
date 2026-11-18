"use strict";


const PAGE_ERROR_POLICIES = ["fail", "warn", "off"];
// v1.9 REQ-Z23: the windows a per-phase policy can address.
const PAGE_ERROR_PHASES = ["auth-bootstrap", "recovery", "under-test"];
const PAGE_ERROR_ORIGINS = ["same-origin", "third-party"];

// v1.9 REQ-Z23-1: an allowlist entry now carries WHERE and WHEN, not only WHAT.
// `match` became optional — "third-party scripts on the login page" is a valid
// (and much safer) thing to silence than a list of their messages. Every declared
// field must hold, so adding scope always NARROWS an entry, never widens it.
function normalizeAllowlistEntry(item) {
  if (typeof item === "string") {
    return { match: item.trim(), reason: "" };
  }
  if (item && typeof item === "object") {
    const entry = {
      match: String(item.match ?? item.pattern ?? item.text ?? "").trim(),
      reason: String(item.reason ?? "").trim(),
    };
    const url = String(item.url ?? item.urlIncludes ?? "").trim();
    if (url) {
      entry.url = url;
    }
    const origin = String(item.origin ?? "").trim().toLowerCase();
    if (PAGE_ERROR_ORIGINS.includes(origin)) {
      entry.origin = origin;
    }
    const phase = String(item.phase ?? "").trim().toLowerCase();
    if (PAGE_ERROR_PHASES.includes(phase)) {
      entry.phase = phase;
    }
    return entry;
  }
  return null;
}

function normalizePageErrorAllowlist(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map(normalizeAllowlistEntry)
    // An entry with no `match` is legal now, but only when it is scoped by
    // something else — otherwise it would be a blanket mute of the whole gate.
    .filter((item) => item && (item.match || item.url || item.origin || item.phase));
}

// v1.9 REQ-Z23-2: `pageErrorPolicy` may be a string (the product window, as
// before) or a per-phase map `{"auth-bootstrap":"off","under-test":"fail"}`.
function normalizePageErrorPolicySetting(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      const phase = String(key).trim().toLowerCase();
      const policy = String(item ?? "").trim().toLowerCase();
      if (PAGE_ERROR_PHASES.includes(phase) && PAGE_ERROR_POLICIES.includes(policy)) {
        output[phase] = policy;
      }
    }
    return Object.keys(output).length ? output : null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeBackendProbes(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return source
    .map((item) => {
      if (typeof item === "string") {
        return { url: item.trim(), name: "" };
      }
      if (item && typeof item === "object") {
        return {
          url: String(item.url ?? item.endpoint ?? "").trim(),
          name: String(item.name ?? item.label ?? "").trim(),
        };
      }
      return null;
    })
    .filter((item) => item && item.url);
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Returns only the keys the file actually declared, so `run()` keeps its own
// defaults for everything else (and so a `{}` spread is a no-op).
function buildGateRunOptions(testFile = {}) {
  const settings = (testFile && typeof testFile.settings === "object" && testFile.settings) || {};
  const options = {};

  // Z-A: page-error gate. v1.9 REQ-Z23: the policy may now be a per-phase map.
  const policy = normalizePageErrorPolicySetting(settings.pageErrorPolicy);
  if (policy != null) {
    options.pageErrorPolicy = policy;
  }
  const allowlist = normalizePageErrorAllowlist(settings.pageErrorAllowlist);
  if (allowlist.length) {
    options.pageErrorAllowlist = allowlist;
  }

  // Z-B: environment fingerprint + freshness gate.
  const backendProbes = normalizeBackendProbes(settings.buildProbe?.backend);
  const frontendProbe = settings.buildProbe?.frontend;
  if (backendProbes.length || frontendProbe || settings.freshness) {
    options.environment = {
      ...(backendProbes.length ? { backendProbes } : {}),
      ...(frontendProbe ? { frontendProbe } : {}),
      ...(settings.freshness && typeof settings.freshness === "object"
        ? {
            freshness: {
              ...(toPositiveNumber(settings.freshness.maxAgeMinutes)
                ? { maxAgeMinutes: toPositiveNumber(settings.freshness.maxAgeMinutes) }
                : {}),
              ...(settings.freshness.requireChangedSince
                ? { requireChangedSince: String(settings.freshness.requireChangedSince).trim() }
                : {}),
            },
          }
        : {}),
    };
  }

  // Z-C: download capture. On by default at the engine level; a file can turn it
  // off (`settings.captureDownloads: false`) for a flow that triggers huge
  // irrelevant downloads.
  if (settings.captureDownloads === false) {
    options.captureDownloads = false;
  }

  // Z-I: data tenancy (prefix for created records + residue reporting).
  if (settings.dataTenant && typeof settings.dataTenant === "object") {
    options.dataTenant = settings.dataTenant;
  }

  // Z-E: which baseline profile this file's visual assertions compare against.
  // Kept separate from `evidenceProfile` on purpose: two files may share an
  // evidence profile while needing different visual baselines (different themes,
  // different tenants), and silently sharing baselines across them would produce
  // diffs nobody can explain.
  if (settings.visualProfile) {
    options.visualProfile = String(settings.visualProfile).trim();
  }

  // Z-D: evidence-bundle signing/annotation inputs the file can influence.
  if (settings.qaTrace && typeof settings.qaTrace === "object") {
    options.qaTrace = settings.qaTrace;
  }

  // v1.10 Z29-1: when the after-step OCR runs (default "onFailure" at the
  // engine). Only an explicit, recognised value is forwarded.
  const stepOcr = normalizeStepOcrSetting(settings.stepOcr);
  if (stepOcr) {
    options.stepOcr = stepOcr;
  }

  return options;
}

const STEP_OCR_SETTINGS = ["onFailure", "always", "off"];

function normalizeStepOcrSetting(value) {
  const text = String(value ?? "").trim();
  return STEP_OCR_SETTINGS.find((item) => item.toLowerCase() === text.toLowerCase()) || null;
}

module.exports = {
  STEP_OCR_SETTINGS,
  PAGE_ERROR_ORIGINS,
  PAGE_ERROR_PHASES,
  PAGE_ERROR_POLICIES,
  buildGateRunOptions,
  normalizeBackendProbes,
  normalizePageErrorAllowlist,
  normalizePageErrorPolicySetting,
  normalizeStepOcrSetting,
};
