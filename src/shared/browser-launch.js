"use strict";


const WEB_SECURITY_DISABLE_ARGS = [
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
];

// v1.4: conservative memory-safety args, applied to BOTH browser channels (the
// visible resident Chrome and every headless session).
//
// `--disable-dev-shm-usage` makes Chromium write its shared-memory files to
// /tmp instead of /dev/shm. On Linux/containers /dev/shm is often only 64MB, and
// exhausting it makes the renderer die exactly like a real OOM (`page.on('crash')`
// with no other clue). It is a no-op on Windows/macOS, so it is safe to always
// pass. Deliberately NOT included: --single-process (fragile), --no-sandbox
// (security), --disable-gpu (changes rendering, would invalidate visual evidence).
const MEMORY_SAFETY_ARGS = ["--disable-dev-shm-usage"];

// Optional V8 old-space ceiling for the renderer, in MB. Off by default: raising
// it lets a leaky page consume more before crashing, lowering it is the easiest
// way to *reproduce* an OOM crash on purpose. Read from the environment so it can
// be set per-machine without touching a test file.
function resolveMaxOldSpaceMb(explicitMb = null) {
  const raw = explicitMb ?? process.env.ZHUZHU_BROWSER_MAX_OLD_SPACE_MB;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

// The full memory-related arg list for a launch. Shared by the visible adapter
// and the headless context builder so the two channels cannot drift.
function buildMemoryLaunchArgs({ maxOldSpaceMb = null } = {}) {
  const ceiling = resolveMaxOldSpaceMb(maxOldSpaceMb);
  return [...MEMORY_SAFETY_ARGS, ...(ceiling ? [`--js-flags=--max-old-space-size=${ceiling}`] : [])];
}

// `proxyLaunchOptions` is the Playwright launch fragment already derived from the
// proxy preference (e.g. `{ args: ["--no-proxy-server"] }` or `{ proxy: {...} }`).
// Compatibility mode is explicit; normal runs preserve browser security checks.
function buildHeadlessBrowserContext(proxyLaunchOptions = {}, { alignWebSecurity = false, maxOldSpaceMb = null } = {}) {
  const proxy = proxyLaunchOptions && typeof proxyLaunchOptions === "object" ? proxyLaunchOptions : {};
  const args = [
    ...(Array.isArray(proxy.args) ? proxy.args : []),
    ...(alignWebSecurity ? WEB_SECURITY_DISABLE_ARGS : []),
    // v1.4: same memory-safety args the visible channel gets.
    ...buildMemoryLaunchArgs({ maxOldSpaceMb }),
  ];
  const launchOptions = {
    ...(proxy.proxy ? { proxy: proxy.proxy } : {}),
    ...(args.length ? { args } : {}),
  };
  const contextOptions = {
    ignoreHTTPSErrors: alignWebSecurity,
    ...(alignWebSecurity ? { bypassCSP: true } : {}),
  };
  return { launchOptions, contextOptions };
}

module.exports = {
  MEMORY_SAFETY_ARGS,
  WEB_SECURITY_DISABLE_ARGS,
  buildHeadlessBrowserContext,
  buildMemoryLaunchArgs,
  resolveMaxOldSpaceMb,
};
