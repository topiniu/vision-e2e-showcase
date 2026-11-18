"use strict";


const { withProbeTimeout } = require("../executor/hard-timeout");

const UNKNOWN = "unknown";

function readEnvNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBackendProbeTimeoutMs() {
  return readEnvNumber("ZHUZHU_BUILD_PROBE_TIMEOUT_MS", 5_000);
}

// Extract a content hash from a bundler URL: `main.4f2a91c8.js`,
// `chunk-vendors.abc123.css`, `umi.a1b2c3d4.js`, `index-Dk3f_1aZ.js` (vite).
function extractChunkHash(url) {
  const fileName = String(url || "").split("?")[0].split("#")[0].split("/").pop() || "";
  const match = fileName.match(/[.\-_]([0-9a-f]{8,32})\.(?:js|mjs|css)$/i) ||
    fileName.match(/[.\-_]([A-Za-z0-9_-]{8,24})\.(?:js|mjs|css)$/);
  return match ? match[1] : null;
}

// Everything here runs inside the page, so it is bounded like every other page
// probe (a wedged renderer must not turn a fingerprint into a hang).
async function readFrontendFingerprint(page, { frontendProbe = null } = {}) {
  if (!page || typeof page.evaluate !== "function") {
    return { source: UNKNOWN, buildId: UNKNOWN, reason: "no page available to probe" };
  }
  let raw;
  try {
    raw = await withProbeTimeout(
      () =>
        page.evaluate((customMetaName) => {
          const readMeta = (name) => {
            const node = document.querySelector(`meta[name="${name}"]`);
            return node ? node.getAttribute("content") : null;
          };
          const scripts = Array.from(document.querySelectorAll("script[src]"))
            .map((node) => node.getAttribute("src"))
            .filter(Boolean);
          const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))
            .map((node) => node.getAttribute("href"))
            .filter(Boolean);
          return {
            customMeta: customMetaName ? readMeta(customMetaName) : null,
            metaBuildId: readMeta("build-id") || readMeta("buildId") || readMeta("build-version"),
            metaBuildTime: readMeta("build-time") || readMeta("buildTime"),
            windowBuildId:
              typeof window.__BUILD_ID__ !== "undefined"
                ? String(window.__BUILD_ID__)
                : typeof window.__APP_VERSION__ !== "undefined"
                  ? String(window.__APP_VERSION__)
                  : null,
            scripts: scripts.slice(0, 40),
            styles: styles.slice(0, 20),
            documentLastModified: document.lastModified || null,
            url: location.href,
            userAgent: navigator.userAgent,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            devicePixelRatio: window.devicePixelRatio || 1,
          };
        }, frontendProbe && typeof frontendProbe === "object" ? frontendProbe.metaName || null : null),
      { label: "environmentFingerprint(page.evaluate)" },
    );
  } catch (error) {
    return {
      source: UNKNOWN,
      buildId: UNKNOWN,
      reason: `frontend probe failed: ${error?.message || String(error)}`,
    };
  }

  const chunkHashes = [...raw.scripts, ...raw.styles].map(extractChunkHash).filter(Boolean);
  const base = {
    url: raw.url || null,
    userAgent: raw.userAgent || null,
    viewport: raw.viewport || null,
    devicePixelRatio: raw.devicePixelRatio ?? null,
    documentLastModified: raw.documentLastModified || null,
    chunkHashes: chunkHashes.slice(0, 8),
    scriptCount: raw.scripts.length,
  };
  if (raw.customMeta) {
    return { ...base, source: "meta:custom", buildId: raw.customMeta, buildTime: raw.metaBuildTime || null };
  }
  if (raw.metaBuildId) {
    return { ...base, source: "meta:build-id", buildId: raw.metaBuildId, buildTime: raw.metaBuildTime || null };
  }
  if (raw.windowBuildId) {
    return { ...base, source: "window.__BUILD_ID__", buildId: raw.windowBuildId, buildTime: null };
  }
  if (chunkHashes.length) {
    // Deterministic across runs of the same build, changes on any rebuild that
    // touches a hashed asset. Good enough to answer "is this the same artifact".
    return {
      ...base,
      source: "chunk-hash",
      buildId: chunkHashes.slice(0, 4).join("+"),
      buildTime: null,
    };
  }
  // Last resort: the HTTP validators of the document itself.
  //
  // Note what is deliberately NOT used here: `document.lastModified`. For a
  // dynamically served page (every SPA dev server) the DOM property falls back to
  // the *load time*, so it changes on every single run. Using it as a build
  // identity would make `requireChangedSince` always report "the code changed" —
  // a gate that always says yes is worse than no gate, because it looks like one.
  // The response headers, by contrast, are real validators or absent.
  const validators = await readDocumentValidators(page, raw.url);
  if (validators?.etag) {
    return { ...base, source: "http:etag", buildId: validators.etag, buildTime: validators.lastModified || null };
  }
  if (validators?.lastModified) {
    return {
      ...base,
      source: "http:last-modified",
      buildId: validators.lastModified,
      buildTime: validators.lastModified,
    };
  }
  return {
    ...base,
    source: UNKNOWN,
    buildId: UNKNOWN,
    reason:
      'no build identity found: add <meta name="build-id">, set window.__BUILD_ID__, serve hashed chunk filenames, ' +
      "or send an ETag/Last-Modified header for the document " +
      "(document.lastModified is deliberately not used — for a dynamically served page it is the load time, " +
      "which would change every run and make a freshness gate lie)",
  };
}

// Bounded read of the document's own validators. Uses the page's request context
// when available so it inherits cookies/proxy/TLS from the browser.
async function readDocumentValidators(page, url) {
  if (!url) {
    return null;
  }
  try {
    if (page && typeof page.request?.get === "function") {
      const response = await withProbeTimeout(
        () => page.request.get(url, { timeout: getBackendProbeTimeoutMs() }),
        { label: "documentValidators", timeoutMs: getBackendProbeTimeoutMs() + 2_000 },
      );
      const headers = response.headers() || {};
      return { etag: headers.etag || null, lastModified: headers["last-modified"] || null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getBackendProbeTimeoutMs());
    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      return {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (_error) {
    return null;
  }
}

function pickFirstPath(source, paths) {
  for (const dotted of paths) {
    let current = source;
    let ok = true;
    for (const key of dotted.split(".")) {
      if (current && typeof current === "object" && key in current) {
        current = current[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && (typeof current === "string" || typeof current === "number")) {
      return { path: dotted, value: String(current) };
    }
  }
  return null;
}

// Probed via the page's own request context when available (so it inherits the
// browser's proxy/TLS/cookies — the whole reason Z09 exists), otherwise via
// global fetch. Either way bounded, and a failure records `unknown` + reason.
async function readBackendFingerprint(page, probe) {
  const url = probe.url;
  const label = probe.name || url;
  const attempt = async () => {
    if (page && typeof page.request?.get === "function") {
      const response = await page.request.get(url, { timeout: getBackendProbeTimeoutMs() });
      const status = response.status();
      const text = await response.text();
      return { status, text };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getBackendProbeTimeoutMs());
    try {
      const response = await fetch(url, { signal: controller.signal });
      return { status: response.status, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const { status, text } = await withProbeTimeout(attempt, {
      label: `backendFingerprint(${label})`,
      timeoutMs: getBackendProbeTimeoutMs() + 2_000,
    });
    if (status >= 400) {
      return { name: label, url, commit: UNKNOWN, status, reason: `probe returned HTTP ${status}` };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      return {
        name: label,
        url,
        commit: UNKNOWN,
        status,
        reason: "probe response was not JSON",
        bodyPreview: String(text || "").slice(0, 160) || null,
      };
    }
    const commit = pickFirstPath(parsed, [
      "git.commit.id",
      "git.commit.id.abbrev",
      "git.commit.id.full",
      "build.commit",
      "commit",
      "gitCommit",
      "version",
      "build.version",
    ]);
    const buildTime = pickFirstPath(parsed, ["build.time", "git.build.time", "buildTime", "git.commit.time"]);
    return {
      name: label,
      url,
      status,
      commit: commit ? commit.value : UNKNOWN,
      commitPath: commit ? commit.path : null,
      buildTime: buildTime ? buildTime.value : null,
      ...(commit ? {} : { reason: "no recognizable commit/version field in the probe response" }),
    };
  } catch (error) {
    return { name: label, url, commit: UNKNOWN, reason: `probe failed: ${error?.message || String(error)}` };
  }
}

// A single string that identifies "the artifact under test", used for the
// changed-since comparison and printed in reports.
function computeCompositeId(fingerprint) {
  const parts = [`fe:${fingerprint.frontend?.buildId ?? UNKNOWN}`];
  for (const backend of fingerprint.backends || []) {
    parts.push(`be:${backend.name}=${backend.commit ?? UNKNOWN}`);
  }
  return parts.join("|");
}

async function collectEnvironmentFingerprint(page, options = {}) {
  const startedAt = Date.now();
  const frontend = await readFrontendFingerprint(page, options);
  const probes = Array.isArray(options.backendProbes) ? options.backendProbes : [];
  const backends = [];
  for (const probe of probes) {
    // Sequential on purpose: these are health endpoints on the machine under
    // test, and a fingerprint probe must never look like a load test.
    backends.push(await readBackendFingerprint(page, probe));
  }
  const fingerprint = {
    collectedAt: startedAt,
    durationMs: Date.now() - startedAt,
    baseUrl: options.baseUrl || frontend.url || null,
    frontend,
    backends,
    // Explicitly enumerate what we could NOT determine, so a reader never has to
    // notice an absent key (facet B-4).
    unknowns: [
      ...(frontend.buildId === UNKNOWN ? [{ what: "frontend.buildId", reason: frontend.reason || "unknown" }] : []),
      ...backends
        .filter((item) => item.commit === UNKNOWN)
        .map((item) => ({ what: `backend.${item.name}.commit`, reason: item.reason || "unknown" })),
    ],
  };
  fingerprint.compositeId = computeCompositeId(fingerprint);
  return fingerprint;
}

function parseTimestamp(value) {
  if (value == null || value === "") {
    return null;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1_000_000_000) {
    // seconds or milliseconds since epoch
    return asNumber > 1e12 ? asNumber : asNumber * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// The freshness gate. Returns `null` when the run may proceed, or a blocked
// verdict describing exactly which rule tripped.
//
// Two independent rules, both from the real incident:
//   maxAgeMinutes        — the artifact's build time is older than declared.
//   requireChangedSince  — the caller says "I changed the code"; if the
//                          fingerprint is byte-identical to the previous round,
//                          the change did not reach the browser.
function evaluateFreshness(fingerprint, freshness = {}) {
  if (!freshness || typeof freshness !== "object") {
    return null;
  }
  const maxAgeMinutes = Number(freshness.maxAgeMinutes);
  if (Number.isFinite(maxAgeMinutes) && maxAgeMinutes > 0) {
    // Only *declared* build times count (a meta tag, an HTTP Last-Modified, or a
    // backend build.time). `document.lastModified` is excluded for the reason
    // documented in `readFrontendFingerprint`: on a dev server it is the load
    // time, so an age computed from it is always ~0 and the gate would silently
    // never fire.
    const buildTime =
      parseTimestamp(fingerprint.frontend?.buildTime) ??
      parseTimestamp(fingerprint.backends?.find((item) => item.buildTime)?.buildTime);
    if (buildTime == null) {
      // Deliberately NOT a block: refusing to run because the app does not
      // publish a build time would make the gate unusable on most targets. It is
      // an explicit unknown instead, and the report says the age was unverifiable.
      fingerprint.unknowns.push({
        what: "freshness.buildAge",
        reason: "no build time available (add <meta name=\"build-time\"> or a backend build.time) — age unverified",
      });
    } else {
      const ageMinutes = (Date.now() - buildTime) / 60_000;
      if (ageMinutes > maxAgeMinutes) {
        return {
          blocked: true,
          blockedReason: "stale-artifact",
          rule: "maxAgeMinutes",
          message:
            `The artifact under test was built ${Math.round(ageMinutes)} minutes ago, older than the declared ` +
            `maxAgeMinutes=${maxAgeMinutes}. Running would produce a verdict about an old build — reported as ` +
            "blocked rather than passed or failed.",
          details: { ageMinutes: Math.round(ageMinutes), maxAgeMinutes, buildTime },
        };
      }
    }
  }
  const requireChangedSince = String(freshness.requireChangedSince ?? "").trim();
  if (requireChangedSince) {
    if (requireChangedSince === fingerprint.compositeId) {
      return {
        blocked: true,
        blockedReason: "stale-artifact",
        rule: "requireChangedSince",
        message:
          "The environment fingerprint is identical to the previous round, but the caller declared the code changed. " +
          "The change did not reach the browser (a dead dev-server watcher looks exactly like this), so this run " +
          "cannot prove anything about the new code and is reported as blocked.",
        details: { fingerprint: fingerprint.compositeId, requireChangedSince },
      };
    }
    if (fingerprint.frontend?.buildId === UNKNOWN) {
      return {
        blocked: true,
        blockedReason: "fingerprint-unavailable",
        rule: "requireChangedSince",
        message:
          "requireChangedSince was declared, but no frontend build identity could be read from the page — so " +
          '"did the code change" is unanswerable. Blocked instead of assumed fresh.',
        details: { reason: fingerprint.frontend?.reason || null },
      };
    }
  }
  return null;
}

module.exports = {
  UNKNOWN,
  collectEnvironmentFingerprint,
  computeCompositeId,
  evaluateFreshness,
  extractChunkHash,
  readBackendFingerprint,
  readFrontendFingerprint,
};
