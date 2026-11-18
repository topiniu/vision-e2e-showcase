const fs = require("node:fs/promises");
const path = require("node:path");
// v1.4: the credential-presence check lives in the executor layer so the live
// browser context and a stored profile are judged by the exact same rule.
const { hasAuthEvidence } = require("../executor/auth-evidence");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, "output");

function normalizeProfileName(profile) {
  const value = String(profile || "").trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    return null;
  }
  return value;
}

function getAuthProfilePath(profile, { outputRoot = DEFAULT_OUTPUT_ROOT } = {}) {
  const safeProfile = normalizeProfileName(profile);
  if (!safeProfile) {
    return null;
  }
  return path.join(path.resolve(outputRoot), "auth-profiles", safeProfile, "storageState.json");
}

function normalizeStorageState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const cookies = Array.isArray(value.cookies) ? value.cookies : [];
  const origins = Array.isArray(value.origins) ? value.origins : [];
  return {
    ...value,
    cookies,
    origins,
  };
}

// Default window before a cookie's real expiry within which we flag the profile
// as "expiring" so a run/renewal happens before it actually dies.
const DEFAULT_EXPIRING_THRESHOLD_MS = 30 * 60 * 1000;

// Evaluate how fresh a stored auth profile is, purely from local data (no
// network). We read Playwright cookie `expires` (unix seconds; -1 = session
// cookie that has no time-expiry) for every value-bearing cookie and take the
// earliest real expiry. This catches cookie time-expiry cheaply; it does NOT
// catch a server-side session that died early — that needs the active probe
// (the login-only run's post-login assert). Staleness:
//   - "expired"  : no auth evidence, or earliest cookie expiry already passed
//   - "expiring" : earliest cookie expiry within `expiringThresholdMs`
//   - "fresh"    : evidence present and not near expiry
//   - "unknown"  : evidence present but only session cookies (no time to judge)
function evaluateAuthFreshness(storageState, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const expiringThresholdMs = Number.isFinite(options.expiringThresholdMs)
    ? options.expiringThresholdMs
    : DEFAULT_EXPIRING_THRESHOLD_MS;
  const normalized = normalizeStorageState(storageState);
  const evidence = hasAuthEvidence(normalized);
  let earliestCookieExpiryMs = null;
  if (normalized) {
    for (const cookie of normalized.cookies) {
      if (!String(cookie?.value || "").trim()) {
        continue;
      }
      const expires = Number(cookie?.expires);
      if (!Number.isFinite(expires) || expires <= 0) {
        continue; // session cookie (-1) or missing — no time-expiry to judge
      }
      const expiresMs = expires * 1000;
      if (earliestCookieExpiryMs === null || expiresMs < earliestCookieExpiryMs) {
        earliestCookieExpiryMs = expiresMs;
      }
    }
  }
  let staleness;
  if (!evidence) {
    staleness = "expired";
  } else if (earliestCookieExpiryMs === null) {
    staleness = "unknown";
  } else if (earliestCookieExpiryMs <= now) {
    staleness = "expired";
  } else if (earliestCookieExpiryMs - now <= expiringThresholdMs) {
    staleness = "expiring";
  } else {
    staleness = "fresh";
  }
  return {
    staleness,
    evidence,
    earliestCookieExpiry: earliestCookieExpiryMs,
    expiresInMs: earliestCookieExpiryMs === null ? null : earliestCookieExpiryMs - now,
    cookieCount: normalized?.cookies.length || 0,
    originCount: normalized?.origins.length || 0,
    domains: collectAuthDomains(normalized),
  };
}

// The set of hosts/domains this profile actually covers — cookie `domain`s (a
// leading-dot wildcard is kept as-is) plus localStorage origin hosts. This is
// what tells the user "which sites is this login good for": Playwright re-injects
// each cookie only on its matching domain, so a profile is scoped by construction.
function collectAuthDomains(storageState) {
  const normalized = normalizeStorageState(storageState);
  if (!normalized) {
    return [];
  }
  const set = new Set();
  for (const cookie of normalized.cookies) {
    const domain = String(cookie?.domain || "").trim();
    if (domain) {
      set.add(domain);
    }
  }
  for (const origin of normalized.origins) {
    const value = String(origin?.origin || "").trim();
    if (!value) {
      continue;
    }
    try {
      set.add(new URL(value).host);
    } catch (_error) {
      set.add(value);
    }
  }
  return Array.from(set).sort();
}

async function getAuthProfileStatus(profile, options = {}) {
  const safeProfile = normalizeProfileName(profile);
  if (!safeProfile) {
    return {
      ok: false,
      profile: profile || "",
      status: "missing",
      storageStatePath: null,
      error: {
        code: "auth-missing",
        message: "authProfile is required and must contain only letters, numbers, dot, underscore, or dash.",
      },
    };
  }
  const storageStatePath = getAuthProfilePath(safeProfile, options);
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(storageStatePath, "utf8"),
      fs.stat(storageStatePath).catch(() => null),
    ]);
    const storageState = JSON.parse(raw);
    const freshness = evaluateAuthFreshness(storageState, options);
    return {
      ok: true,
      profile: safeProfile,
      status: "ready",
      storageStatePath,
      authenticated: freshness.evidence,
      // Additive freshness fields (backward-compatible with existing /auth/status
      // consumers): captured-at from file mtime + local cookie-expiry verdict.
      capturedAt: stat ? stat.mtimeMs : null,
      staleness: freshness.staleness,
      earliestCookieExpiry: freshness.earliestCookieExpiry,
      expiresInMs: freshness.expiresInMs,
      cookieCount: freshness.cookieCount,
      originCount: freshness.originCount,
      domains: freshness.domains,
    };
  } catch (error) {
    const code = error?.code === "ENOENT" ? "auth-missing" : "auth-invalid";
    return {
      ok: false,
      profile: safeProfile,
      status: error?.code === "ENOENT" ? "missing" : "invalid",
      storageStatePath,
      error: {
        code,
        message:
          code === "auth-missing"
            ? `Auth profile "${safeProfile}" does not have storageState.json.`
            : `Auth profile "${safeProfile}" storageState.json is not readable JSON.`,
      },
    };
  }
}

async function writeAuthProfileStorageState(profile, storageState, options = {}) {
  const safeProfile = normalizeProfileName(profile);
  if (!safeProfile) {
    return {
      ok: false,
      error: {
        code: "auth-missing",
        message: "authProfile is required.",
      },
    };
  }
  const normalized = normalizeStorageState(storageState);
  if (!normalized) {
    return {
      ok: false,
      profile: safeProfile,
      error: {
        code: "auth-invalid",
        message: "storageState must be an object with optional cookies and origins arrays.",
      },
    };
  }
  const storageStatePath = getAuthProfilePath(safeProfile, options);
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
  await fs.writeFile(storageStatePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return {
    ok: true,
    profile: safeProfile,
    status: "ready",
    storageStatePath,
    authenticated: hasAuthEvidence(normalized),
    cookieCount: normalized.cookies.length,
    originCount: normalized.origins.length,
  };
}

async function captureAuthProfile(profile, options = {}) {
  const safeProfile = normalizeProfileName(profile);
  if (!safeProfile) {
    return {
      ok: false,
      error: {
        code: "auth-missing",
        message: "authProfile is required.",
      },
    };
  }
  if (options.storageState) {
    return writeAuthProfileStorageState(safeProfile, options.storageState, options);
  }
  const context = typeof options.contextProvider === "function"
    ? await options.contextProvider()
    : options.context;
  if (!context || typeof context.storageState !== "function") {
    return {
      ok: false,
      profile: safeProfile,
      error: {
        code: "browser-unavailable",
        message: "No browser context is available to capture storageState.",
      },
    };
  }
  const storageStatePath = getAuthProfilePath(safeProfile, options);
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
  const storageState = await context.storageState({ path: storageStatePath });
  const normalized = normalizeStorageState(storageState);
  return {
    ok: true,
    profile: safeProfile,
    status: "ready",
    storageStatePath,
    authenticated: hasAuthEvidence(normalized),
    cookieCount: normalized?.cookies.length || 0,
    originCount: normalized?.origins.length || 0,
  };
}

async function resetAuthProfile(profile, options = {}) {
  const safeProfile = normalizeProfileName(profile);
  if (!safeProfile) {
    return {
      ok: false,
      error: {
        code: "auth-missing",
        message: "authProfile is required.",
      },
    };
  }
  const storageStatePath = getAuthProfilePath(safeProfile, options);
  await fs.rm(storageStatePath, { force: true }).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
  return {
    ok: true,
    profile: safeProfile,
    status: "reset",
    storageStatePath,
  };
}

module.exports = {
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_EXPIRING_THRESHOLD_MS,
  captureAuthProfile,
  // v1.6 Z-F: the bootstrap flow reports which hosts a freshly created profile
  // covers, so a permission matrix can say what each identity can reach.
  collectAuthDomains,
  evaluateAuthFreshness,
  getAuthProfilePath,
  getAuthProfileStatus,
  hasAuthEvidence,
  normalizeStorageState,
  normalizeProfileName,
  resetAuthProfile,
  writeAuthProfileStorageState,
};
