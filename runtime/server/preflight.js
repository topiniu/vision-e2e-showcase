"use strict";


const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// v1.9 REQ-Z26: the discovery record is a preflight subject like any other.
const { readEndpointFile } = require("../../src/shared/service-discovery");

const PROBE_TIMEOUT_MS = Math.max(1_000, Number(process.env.ZHUZHU_PREFLIGHT_PROBE_TIMEOUT_MS || 5_000));

function check(name, status, detail, fix = null, extra = null) {
  return { name, status, detail, ...(fix ? { fix } : {}), ...(extra ? { data: extra } : {}) };
}

async function withTimeout(promiseFactory, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function probeHttp(url, { method = "GET" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method, signal: controller.signal, redirect: "manual" });
    return { ok: response.status < 500, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// --- individual checks -------------------------------------------------------

async function checkWorkspace(workspaceRoot) {
  const checks = [];
  if (!workspaceRoot || !fsSync.existsSync(workspaceRoot)) {
    checks.push(
      check(
        "workspace",
        "fail",
        `the workspace root does not exist: ${workspaceRoot || "(unset)"}`,
        "Set the workspace directory in Settings, or ZHUZHU_WORKSPACE_DIR.",
      ),
    );
    return checks;
  }
  const workflowsRoot = path.join(workspaceRoot, "test-workflows");
  checks.push(
    fsSync.existsSync(workflowsRoot)
      ? check("workspace.test-workflows", "pass", workflowsRoot)
      : check(
          "workspace.test-workflows",
          "fail",
          `${workflowsRoot} is missing, so no test file can be resolved`,
          "Create test-workflows/ in the workspace root (or point the workspace at the directory that has it).",
        ),
  );
  // Writability, proven by writing — a permissions check that only reads the
  // mode bits is wrong on Windows often enough to be useless.
  const probePath = path.join(workspaceRoot, `.zhuzhu-preflight-${process.pid}.tmp`);
  try {
    await fs.writeFile(probePath, "ok");
    await fs.rm(probePath, { force: true });
    checks.push(check("workspace.writable", "pass", "the workspace root accepts writes"));
  } catch (error) {
    checks.push(
      check(
        "workspace.writable",
        "fail",
        `the workspace root is not writable: ${error?.message || error}`,
        "Runs need to write output/runs and output/sessions. Fix the permissions or choose another workspace.",
      ),
    );
  }
  return checks;
}

async function checkDiskSpace(workspaceRoot) {
  // A night of ~20 sessions with screenshots + traces is comfortably under a few
  // GB; below 2 GB free a night will end in half-written evidence.
  try {
    const stats = await fs.statfs(workspaceRoot);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const freeGb = freeBytes / (1024 * 1024 * 1024);
    const rounded = Math.round(freeGb * 10) / 10;
    if (freeGb < 2) {
      return check(
        "disk.free",
        "fail",
        `only ${rounded} GB free on the workspace volume`,
        "Free space or run the run-archive cleanup: a night of unattended runs writes screenshots, traces and downloads.",
        { freeGb: rounded },
      );
    }
    if (freeGb < 10) {
      return check("disk.free", "warn", `${rounded} GB free on the workspace volume`, "Consider archiving old output/runs before an all-night batch.", { freeGb: rounded });
    }
    return check("disk.free", "pass", `${rounded} GB free`, null, { freeGb: rounded });
  } catch (error) {
    return check("disk.free", "warn", `could not read free space: ${error?.message || error}`, "Check the volume manually before a long batch.");
  }
}

async function checkFrontend({ baseUrl, collectFingerprint = null, freshness = null }) {
  const checks = [];
  if (!baseUrl) {
    checks.push(
      check(
        "frontend.reachable",
        "warn",
        "no baseUrl was supplied, so the app under test was not probed",
        "Pass ?baseUrl=... (or the profile's baseUrl) so preflight can verify the front-end is actually serving.",
      ),
    );
    return checks;
  }
  const probe = await probeHttp(baseUrl);
  if (!probe.ok) {
    checks.push(
      check(
        "frontend.reachable",
        "fail",
        `the front-end under test is not reachable at ${baseUrl}${probe.error ? ` (${probe.error})` : ` (HTTP ${probe.status})`}`,
        "Start / restart the front-end dev server (or fix the URL). Nothing can be tested tonight until this answers.",
        { status: probe.status },
      ),
    );
    return checks;
  }
  checks.push(check("frontend.reachable", "pass", `${baseUrl} responded HTTP ${probe.status}`));
  if (typeof collectFingerprint === "function") {
    try {
      const fingerprint = await withTimeout(() => collectFingerprint({ baseUrl }), PROBE_TIMEOUT_MS * 3, "build fingerprint");
      const buildId = fingerprint?.frontend?.buildId ?? "unknown";
      if (buildId === "unknown") {
        checks.push(
          check(
            "frontend.buildId",
            "warn",
            `no build identity could be read from ${baseUrl}: ${fingerprint?.frontend?.reason || "unknown"}`,
            'Add <meta name="build-id"> / window.__BUILD_ID__, or serve hashed chunk names — otherwise evidence cannot say which build it is about and the freshness gate cannot work.',
            { fingerprint },
          ),
        );
      } else {
        checks.push(check("frontend.buildId", "pass", `build ${buildId} (via ${fingerprint.frontend.source})`, null, { fingerprint }));
      }
      if (freshness && fingerprint) {
        const { evaluateFreshness } = require("../perception/environment-fingerprint");
        const verdict = evaluateFreshness(fingerprint, freshness);
        checks.push(
          verdict
            ? check("frontend.freshness", "fail", verdict.message, "Rebuild/restart the front-end, then re-probe.", verdict.details)
            : check("frontend.freshness", "pass", "the served artifact satisfies the declared freshness rules"),
        );
      }
    } catch (error) {
      checks.push(check("frontend.buildId", "warn", `the fingerprint probe failed: ${error?.message || error}`, "Not fatal, but evidence tonight will not name the build."));
    }
  }
  return checks;
}

async function checkBackends(probes = []) {
  const checks = [];
  for (const probe of probes) {
    const result = await probeHttp(probe.url);
    checks.push(
      result.ok
        ? check(`backend.${probe.name || probe.url}`, "pass", `HTTP ${result.status}`)
        : check(
            `backend.${probe.name || probe.url}`,
            "warn",
            `health endpoint did not answer: ${probe.url}${result.error ? ` (${result.error})` : ` (HTTP ${result.status})`}`,
            "A failing backend probe does not stop a UI run, but evidence will record its commit as unknown.",
          ),
    );
  }
  return checks;
}

function checkAuthProfile(status, profileName) {
  if (!profileName) {
    return check(
      "auth.profile",
      "warn",
      "no auth profile was named, so login freshness was not verified",
      "Pass ?profile=<name> so preflight can check the stored credential before the night starts.",
    );
  }
  if (!status || status.exists === false) {
    return check(
      "auth.profile",
      "fail",
      `auth profile "${profileName}" does not exist`,
      "Create it with bootstrap_auth_profile (or log in once in the panel and save the profile). Every session tonight would otherwise fail at the first business step.",
    );
  }
  if (status.stale === true || status.fresh === false) {
    return check(
      "auth.profile",
      "warn",
      `auth profile "${profileName}" looks stale${status.ageMinutes != null ? ` (${Math.round(status.ageMinutes)} min old)` : ""}`,
      "Refresh it with bootstrap_auth_profile before dispatching, or accept one reactive re-login per session.",
      status,
    );
  }
  return check("auth.profile", "pass", `auth profile "${profileName}" is present and fresh`, null, status);
}

function checkOrphanSessions(sessions = []) {
  const running = sessions.filter((item) => item?.status === "running");
  if (!running.length) {
    return check("sessions.orphans", "pass", "no sessions are left running");
  }
  return check(
    "sessions.orphans",
    "warn",
    `${running.length} session(s) are still marked running from a previous dispatch: ${running.map((item) => item.id).join(", ")}`,
    `Cancel them first — cancel_run({runId:"${running[0].id}"}) — otherwise they hold browsers and confuse tonight's handles.`,
    { sessions: running.map((item) => ({ id: item.id, startedAt: item.startedAt ?? null, testFileId: item.testFile?.id ?? null })) },
  );
}

// Concurrency advice from real machine resources. Deliberately conservative: each
// visible/headless Chromium with a heavy SPA comfortably eats ~1 core and ~1.2 GB
// at peak, and the v1.4 OOM incident was a machine running more than it could.
function checkConcurrency() {
  const cpus = os.cpus()?.length || 1;
  const freeGb = os.freemem() / (1024 * 1024 * 1024);
  const totalGb = os.totalmem() / (1024 * 1024 * 1024);
  const byCpu = Math.max(1, Math.floor((cpus - 1) / 2));
  const byMemory = Math.max(1, Math.floor(freeGb / 1.5));
  const recommended = Math.max(1, Math.min(byCpu, byMemory, 6));
  const detail =
    `${cpus} logical CPUs, ${Math.round(freeGb * 10) / 10}/${Math.round(totalGb)} GB RAM free ` +
    `-> recommended concurrency ${recommended} (cpu-bound ${byCpu}, memory-bound ${byMemory})`;
  if (freeGb < 2) {
    return check(
      "host.concurrency",
      "warn",
      `${detail}. Free memory is very low; a renderer OOM is likely (see telemetry.browserCrash).`,
      "Close other Chrome windows / applications, or run with concurrency 1.",
      { cpus, freeGb: Math.round(freeGb * 10) / 10, recommended },
    );
  }
  return check("host.concurrency", "pass", detail, null, { cpus, freeGb: Math.round(freeGb * 10) / 10, recommended });
}

function summarize(checks) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const item of checks) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }
  const ready = counts.fail === 0;
  return {
    ready,
    verdict: counts.fail ? "do-not-run" : counts.warn ? "run-with-warnings" : "ready",
    counts,
    // The single sentence a dispatcher needs.
    message: counts.fail
      ? `Do not start an unattended batch: ${counts.fail} blocking problem(s) — ${checks
          .filter((item) => item.status === "fail")
          .map((item) => item.name)
          .join(", ")}.`
      : counts.warn
        ? `Safe to start, with ${counts.warn} caveat(s) that will cost time: ${checks
            .filter((item) => item.status === "warn")
            .map((item) => item.name)
            .join(", ")}.`
        : "All preflight checks passed; an unattended batch can start.",
  };
}

// v1.9 REQ-Z26: is the service-discovery record present, current, and pointing at
// THIS process? A consumer whose stored base drifts loses its MCP tools silently
// — the 2026-08-26 round lost all 18 of them that way and never saw an error.
// Preflight is where a dispatcher already looks before starting a night, so it is
// where the drift has to become visible.
function checkServiceDiscovery({ expectedBaseUrl = null } = {}) {
  const record = readEndpointFile();
  if (!record.ok) {
    return check(
      "discovery.endpointFile",
      record.reason === "stale" ? "warn" : "warn",
      record.message || `the discovery record is unusable (${record.reason})`,
      `Consumers should read ${record.filePath} instead of storing a port. ` +
        "If the desktop App is running and this says absent/stale, it predates v1.9 — restart it.",
      { reason: record.reason, filePath: record.filePath },
    );
  }
  const advertised = record.document?.appRunBaseUrl || null;
  if (expectedBaseUrl && advertised && advertised !== expectedBaseUrl) {
    return check(
      "discovery.endpointFile",
      "warn",
      `the discovery record advertises ${advertised} but this surface is ${expectedBaseUrl} — two Zhuzhu instances, or a stale record`,
      "Consumers reading the file will reach the OTHER instance. Close the one you do not want, then restart.",
      { advertised, expectedBaseUrl, filePath: record.filePath },
    );
  }
  return check(
    "discovery.endpointFile",
    "pass",
    `discovery record is current: ${advertised} (pid ${record.document?.pid})`,
    null,
    { filePath: record.filePath, document: record.document },
  );
}

async function runPreflight(options = {}) {
  const {
    workspaceRoot = process.cwd(),
    baseUrl = null,
    profile = null,
    backendProbes = [],
    freshness = null,
    collectFingerprint = null,
    getAuthStatus = null,
    listSessions = null,
    appRunStatus = null,
    headlessAvailable = true,
    ocrAvailable = null,
  } = options;

  const checks = [];
  checks.push(...(await checkWorkspace(workspaceRoot)));
  checks.push(await checkDiskSpace(workspaceRoot));
  checks.push(checkConcurrency());
  checks.push(checkServiceDiscovery({ expectedBaseUrl: options.selfBaseUrl || null }));

  // Execution channels.
  if (appRunStatus) {
    const queue = appRunStatus.queue || {};
    if (appRunStatus.available !== false) {
      checks.push(check("channel.app-run", "pass", `queue depth ${queue.pending ?? 0}, running ${queue.running ?? 0}`, null, queue));
    } else if (appRunStatus.optional === true) {
      // The standalone bridge has no visible channel BY DESIGN. Reporting that
      // as `fail` would tell a headless-only dispatcher "do not run tonight",
      // which is simply wrong advice — and a probe that cries wolf about its own
      // architecture is a probe people stop reading.
      checks.push(
        check(
          "channel.app-run",
          "warn",
          `no visible App-run channel here: ${appRunStatus.reason || "not available on this surface"}`,
          "Headless dispatch is unaffected. If you need visible final verification, probe the desktop app's port (32147) instead.",
        ),
      );
    } else {
      checks.push(
        check(
          "channel.app-run",
          "fail",
          `the visible App-run channel is unavailable: ${appRunStatus.reason || "unknown"}`,
          "Start the desktop app (npm run dev / the packaged Zhuzhu). Headless-only dispatch still works, but nothing can be verified in a visible browser.",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "channel.app-run",
        "warn",
        "the App-run channel could not be probed from here",
        "Run preflight against the desktop app's port (32147) to include the visible channel.",
      ),
    );
  }
  checks.push(
    headlessAvailable
      ? check("channel.headless", "pass", "the headless session channel is available")
      : check("channel.headless", "fail", "the headless session channel is unavailable", "Check the Playwright Chromium install (npx playwright install chromium)."),
  );

  checks.push(...(await checkFrontend({ baseUrl, collectFingerprint, freshness })));
  checks.push(...(await checkBackends(backendProbes)));

  if (typeof getAuthStatus === "function") {
    try {
      const status = await withTimeout(() => getAuthStatus({ profile }), PROBE_TIMEOUT_MS * 2, "auth status");
      checks.push(checkAuthProfile(status, profile));
    } catch (error) {
      checks.push(check("auth.profile", "warn", `the auth probe failed: ${error?.message || error}`, "Verify the profile manually with get_auth_status."));
    }
  } else {
    checks.push(checkAuthProfile(null, profile));
  }

  if (typeof listSessions === "function") {
    try {
      const listed = await withTimeout(() => listSessions({ status: "running", limit: 20 }), PROBE_TIMEOUT_MS * 2, "list sessions");
      checks.push(checkOrphanSessions(listed?.sessions || listed || []));
    } catch (error) {
      checks.push(check("sessions.orphans", "warn", `could not list sessions: ${error?.message || error}`, "Check output/sessions for stale running sessions."));
    }
  }

  if (ocrAvailable === false) {
    checks.push(
      check(
        "dependency.ocr",
        "warn",
        "OCR is unavailable, so visual/text fallback resolution is disabled",
        "Install the OCR dependency if any test file relies on OCR fallback; DOM-only files are unaffected.",
      ),
    );
  } else if (ocrAvailable === true) {
    checks.push(check("dependency.ocr", "pass", "OCR is available"));
  }

  const summary = summarize(checks);
  const recommended = checks.find((item) => item.name === "host.concurrency")?.data?.recommended ?? null;
  return {
    generatedAt: Date.now(),
    ...summary,
    recommendedConcurrency: recommended,
    checks,
  };
}

module.exports = {
  // v1.10 Z27-4: reused by the session runner to probe target origins.
  probeHttp,
  checkAuthProfile,
  checkConcurrency,
  checkOrphanSessions,
  checkServiceDiscovery,
  runPreflight,
  summarize,
};
