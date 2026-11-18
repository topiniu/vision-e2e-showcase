const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Persisted config for the auth auto-renewal feature. Lives next to
// workspace-preferences.json in the Zhuzhu userData root. The renewal engine
// (main process) reads this at startup to arm the heartbeat and writes it back
// after each renewal to record lastRenewAt / lastRenewStatus.
//
// The design is "blind periodic refresh" (option A-2): when enabled, the
// heartbeat re-runs `loginTestFilePath` headlessly every `intervalMinutes`
// (authBootstrap:"run"), keeping the shared storageState fresh. Credentials are
// NOT stored here — they live in the referenced login workflow (single shared
// account convention), so this file holds no secrets.
const AUTH_RENEWAL_CONFIG_FILE = "auth-renewal.json";

const DEFAULT_AUTH_RENEWAL_CONFIG = {
  version: 1,
  enabled: false,
  profile: "demo-local",
  loginTestFilePath: "common/auth-login-only.json",
  intervalMinutes: 120,
  lastRenewAt: null,
  lastRenewStatus: null, // "passed" | "failed" | null
  lastRenewError: null,
  updatedAt: null,
};

// Clamp interval to a sane range: at least 5 min (avoid hammering the single
// shared account / login endpoint), at most 24h.
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;

function getAuthRenewalConfigPath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), AUTH_RENEWAL_CONFIG_FILE);
}

function clampInterval(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return DEFAULT_AUTH_RENEWAL_CONFIG.intervalMinutes;
  }
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(num)));
}

function normalizeProfileField(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  if (!text || !/^[A-Za-z0-9._-]+$/.test(text)) {
    return fallback;
  }
  return text;
}

function normalizeLoginPath(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

// Merge a partial payload over the current/default config, coercing every field
// to a safe value. Unknown keys are dropped.
function normalizeAuthRenewalConfig(payload = {}, base = DEFAULT_AUTH_RENEWAL_CONFIG) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    version: 1,
    enabled: source.enabled === undefined ? Boolean(base.enabled) : Boolean(source.enabled),
    profile: normalizeProfileField(
      source.profile === undefined ? base.profile : source.profile,
      DEFAULT_AUTH_RENEWAL_CONFIG.profile,
    ),
    loginTestFilePath: normalizeLoginPath(
      source.loginTestFilePath === undefined ? base.loginTestFilePath : source.loginTestFilePath,
      DEFAULT_AUTH_RENEWAL_CONFIG.loginTestFilePath,
    ),
    intervalMinutes: clampInterval(
      source.intervalMinutes === undefined ? base.intervalMinutes : source.intervalMinutes,
    ),
    lastRenewAt: source.lastRenewAt === undefined ? (base.lastRenewAt ?? null) : (source.lastRenewAt ?? null),
    lastRenewStatus:
      source.lastRenewStatus === undefined ? (base.lastRenewStatus ?? null) : (source.lastRenewStatus ?? null),
    lastRenewError:
      source.lastRenewError === undefined ? (base.lastRenewError ?? null) : (source.lastRenewError ?? null),
    updatedAt: source.updatedAt === undefined ? (base.updatedAt ?? null) : source.updatedAt,
  };
}

function readAuthRenewalConfigSync(configPath) {
  try {
    const payload = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizeAuthRenewalConfig(payload);
  } catch (_error) {
    return { ...DEFAULT_AUTH_RENEWAL_CONFIG };
  }
}

async function writeAuthRenewalConfig(configPath, payload) {
  const normalized = normalizeAuthRenewalConfig(payload, payload);
  normalized.updatedAt = new Date().toISOString();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

module.exports = {
  AUTH_RENEWAL_CONFIG_FILE,
  DEFAULT_AUTH_RENEWAL_CONFIG,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  clampInterval,
  getAuthRenewalConfigPath,
  normalizeAuthRenewalConfig,
  readAuthRenewalConfigSync,
  writeAuthRenewalConfig,
};
