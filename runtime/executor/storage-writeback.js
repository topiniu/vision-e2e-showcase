"use strict";


const DEFAULT_AUTH_KEY_PATTERN = "token|auth|user_?info|session|platform|login|jwt|credential|passport|sso";

function resolveWritebackMode(env = process.env) {
  const raw = String(env.ZHUZHU_STORAGE_WRITEBACK || "").trim().toLowerCase();
  return raw === "full" || raw === "off" ? raw : "auth-only";
}

function resolveAuthKeyPattern(env = process.env) {
  const source = String(env.ZHUZHU_STORAGE_AUTH_KEY_PATTERN || "").trim() || DEFAULT_AUTH_KEY_PATTERN;
  try {
    return new RegExp(source, "i");
  } catch (_error) {
    return new RegExp(DEFAULT_AUTH_KEY_PATTERN, "i");
  }
}

function asState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    cookies: Array.isArray(state.cookies) ? state.cookies : [],
    origins: Array.isArray(state.origins) ? state.origins : [],
  };
}

// Pure: baseline = what the profile file holds now, live = context.storageState().
function mergeAuthOnly(baselineState, liveState, { authKeyPattern = resolveAuthKeyPattern() } = {}) {
  const baseline = asState(baselineState);
  const live = asState(liveState);
  const isAuthKey = (name) => authKeyPattern.test(String(name || ""));
  const liveByOrigin = new Map(live.origins.map((o) => [o && o.origin, Array.isArray(o && o.localStorage) ? o.localStorage : []]));
  const origins = [];
  const seen = new Set();
  for (const origin of baseline.origins) {
    if (!origin || !origin.origin) {
      continue;
    }
    seen.add(origin.origin);
    const baseItems = Array.isArray(origin.localStorage) ? origin.localStorage : [];
    const liveItems = liveByOrigin.get(origin.origin);
    // Origin absent from the live context (never visited this run): keep as is.
    if (!liveItems) {
      origins.push({ ...origin, localStorage: baseItems });
      continue;
    }
    const kept = baseItems.filter((item) => !isAuthKey(item.name));
    const auth = liveItems.filter((item) => isAuthKey(item.name));
    origins.push({ ...origin, localStorage: [...kept, ...auth] });
  }
  for (const origin of live.origins) {
    if (!origin || !origin.origin || seen.has(origin.origin)) {
      continue;
    }
    const auth = (Array.isArray(origin.localStorage) ? origin.localStorage : []).filter((item) => isAuthKey(item.name));
    if (auth.length) {
      origins.push({ origin: origin.origin, localStorage: auth });
    }
  }
  return { cookies: live.cookies, origins };
}

// Describe what the merge refused to persist (for logs / tests).
function droppedAppStateKeys(baselineState, liveState, options = {}) {
  const merged = mergeAuthOnly(baselineState, liveState, options);
  const persisted = new Map(merged.origins.map((o) => [o.origin, new Map(o.localStorage.map((i) => [i.name, i.value]))]));
  const dropped = [];
  for (const origin of asState(liveState).origins) {
    const kept = persisted.get(origin.origin) || new Map();
    for (const item of origin.localStorage || []) {
      if (!kept.has(item.name) || kept.get(item.name) !== item.value) {
        dropped.push(`${origin.origin} ${item.name}`);
      }
    }
  }
  return dropped;
}

module.exports = {
  DEFAULT_AUTH_KEY_PATTERN,
  droppedAppStateKeys,
  mergeAuthOnly,
  resolveAuthKeyPattern,
  resolveWritebackMode,
};
