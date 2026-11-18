
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { run } = require("../../runtime");
const {
  collectEnvironmentFingerprint,
  computeCompositeId,
  evaluateFreshness,
  extractChunkHash,
  readBackendFingerprint,
} = require("../../runtime/perception/environment-fingerprint");
const { createDiagnosis } = require("../../runtime/server/diagnosis");

const outputRoot = path.join(os.tmpdir(), "zhuzhu-env-fingerprint");

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

function htmlServer(html) {
  return serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
}

test("B-1: a <meta name=build-id> is the highest-priority build identity", async () => {
  const { server, url } = await htmlServer(
    `<!doctype html><html><head><meta name="build-id" content="v5.19-abc123"><meta name="build-time" content="2026-08-25T01:00:00Z"></head><body>ok</body></html>`,
  );
  try {
    const result = await run([{ id: "noop", type: "capture" }], {
      url,
      headless: true,
      outputDir: outputRoot,
      runId: "env-b1",
      evidenceProfile: "fast",
    });
    const summary = JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
    assert.equal(summary.environmentFingerprint.frontend.source, "meta:build-id");
    assert.equal(summary.environmentFingerprint.frontend.buildId, "v5.19-abc123");
    // B-3: it is in the evidence, and persisted as its own artifact.
    assert.ok(fs.existsSync(path.join(summary.artifacts.runDir, "environment", "fingerprint.json")));
    assert.match(summary.environmentFingerprint.compositeId, /^fe:v5\.19-abc123/);
  } finally {
    server.close();
  }
});

test("B-1: window.__BUILD_ID__ and hashed chunk names are the next fallbacks", async () => {
  const withWindow = await htmlServer(
    `<!doctype html><html><body><script>window.__BUILD_ID__ = "win-777";</script></body></html>`,
  );
  try {
    const result = await run([{ id: "noop", type: "capture" }], {
      url: withWindow.url,
      headless: true,
      outputDir: outputRoot,
      runId: "env-b1-window",
      evidenceProfile: "fast",
    });
    const summary = JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
    assert.equal(summary.environmentFingerprint.frontend.source, "window.__BUILD_ID__");
    assert.equal(summary.environmentFingerprint.frontend.buildId, "win-777");
  } finally {
    withWindow.server.close();
  }

  // Chunk-hash extraction covers the "zero cooperation from the app" case.
  assert.equal(extractChunkHash("/static/js/main.4f2a91c8.js"), "4f2a91c8");
  assert.equal(extractChunkHash("https://x/umi.a1b2c3d4e5f6.js?v=1"), "a1b2c3d4e5f6");
  assert.equal(extractChunkHash("/assets/index-Dk3f_1aZ.js"), "Dk3f_1aZ");
  assert.equal(extractChunkHash("/static/app.js"), null);
});

test("B-4: an unreadable build identity records unknown WITH a reason, never an omission", async () => {
  const { server, url } = await htmlServer(`<!doctype html><html><body>no build info at all</body></html>`);
  try {
    const result = await run([{ id: "noop", type: "capture" }], {
      url,
      headless: true,
      outputDir: outputRoot,
      runId: "env-b4",
      evidenceProfile: "fast",
    });
    const summary = JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
    const fingerprint = summary.environmentFingerprint;
    assert.equal(fingerprint.frontend.buildId, "unknown");
    assert.ok(fingerprint.frontend.reason, "an unknown must explain itself");
    assert.deepEqual(
      fingerprint.unknowns.map((item) => item.what),
      ["frontend.buildId"],
      "unknowns are enumerated explicitly so a reader never has to notice a missing key",
    );
  } finally {
    server.close();
  }
});

test("B-4: a backend probe that 404s / returns non-JSON records unknown with the cause", async () => {
  const notFound = await serve((_request, response) => {
    response.writeHead(404);
    response.end("nope");
  });
  const notJson = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Whitelabel Error Page");
  });
  const good = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ git: { commit: { id: "deadbeef" } }, build: { time: "2026-08-25T00:00:00Z" } }));
  });
  try {
    const missing = await readBackendFingerprint(null, { url: notFound.url, name: "svc-404" });
    assert.equal(missing.commit, "unknown");
    assert.match(missing.reason, /HTTP 404/);

    const plain = await readBackendFingerprint(null, { url: notJson.url, name: "svc-html" });
    assert.equal(plain.commit, "unknown");
    assert.match(plain.reason, /not JSON/);

    const ok = await readBackendFingerprint(null, { url: good.url, name: "svc-ok" });
    assert.equal(ok.commit, "deadbeef");
    assert.equal(ok.commitPath, "git.commit.id");
    assert.equal(ok.buildTime, "2026-08-25T00:00:00Z");

    const unreachable = await readBackendFingerprint(null, { url: "http://127.0.0.1:1/actuator/info", name: "svc-down" });
    assert.equal(unreachable.commit, "unknown");
    assert.ok(unreachable.reason);
  } finally {
    notFound.server.close();
    notJson.server.close();
    good.server.close();
  }
});

test("B-2: a bundle older than maxAgeMinutes blocks the run (not green, not red)", async () => {
  const oldBuildTime = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { server, url } = await htmlServer(
    `<!doctype html><html><head><meta name="build-id" content="stale-1"><meta name="build-time" content="${oldBuildTime}"></head><body>stale</body></html>`,
  );
  try {
    const result = await run(
      [{ id: "should-not-run", type: "assertDom", target: { locator: "body" }, property: "exists", expected: true }],
      {
        url,
        headless: true,
        outputDir: outputRoot,
        runId: "env-b2",
        evidenceProfile: "fast",
        environment: { freshness: { maxAgeMinutes: 120 } },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.equal(result.blockedReason, "stale-artifact");
    assert.equal(result.error.code, "stale-artifact");
    assert.equal(result.data.results.length, 0, "no step may run against a stale artifact");
    // The verdict must resolve to `blocked`, so nobody debugs a case that never ran.
    const diagnosis = createDiagnosis({ ok: false, error: result.error, caseResults: [] });
    assert.equal(diagnosis.failureType, "stale-artifact");
    assert.equal(diagnosis.status, "blocked");
    assert.ok(diagnosis.fixHints.some((hint) => /ENVIRONMENT problem/i.test(hint)));
  } finally {
    server.close();
  }
});

test("B-2: requireChangedSince blocks when the fingerprint is byte-identical", async () => {
  const { server, url } = await htmlServer(
    `<!doctype html><html><head><meta name="build-id" content="same-build"></head><body>x</body></html>`,
  );
  try {
    const first = await run([{ id: "noop", type: "capture" }], {
      url,
      headless: true,
      outputDir: outputRoot,
      runId: "env-changed-1",
      evidenceProfile: "fast",
    });
    const previous = first.telemetry.environmentFingerprint.compositeId;

    const second = await run([{ id: "noop", type: "capture" }], {
      url,
      headless: true,
      outputDir: outputRoot,
      runId: "env-changed-2",
      evidenceProfile: "fast",
      environment: { freshness: { requireChangedSince: previous } },
    });
    assert.equal(second.blocked, true);
    assert.equal(second.blockedReason, "stale-artifact");
    assert.match(second.error.message, /did not reach the browser/);
  } finally {
    server.close();
  }
});

test("requireChangedSince passes when the build id actually moved", () => {
  const fingerprint = { frontend: { buildId: "build-2" }, backends: [], unknowns: [] };
  fingerprint.compositeId = computeCompositeId(fingerprint);
  assert.equal(evaluateFreshness(fingerprint, { requireChangedSince: "fe:build-1" }), null);
});

test("requireChangedSince with an unreadable build id blocks rather than assuming fresh", () => {
  const fingerprint = { frontend: { buildId: "unknown", reason: "no meta" }, backends: [], unknowns: [] };
  fingerprint.compositeId = computeCompositeId(fingerprint);
  const verdict = evaluateFreshness(fingerprint, { requireChangedSince: "fe:whatever" });
  assert.equal(verdict.blockedReason, "fingerprint-unavailable");
});

test("maxAgeMinutes with no available build time records an unknown but does NOT block", () => {
  const fingerprint = { frontend: { buildId: "b1" }, backends: [], unknowns: [] };
  fingerprint.compositeId = computeCompositeId(fingerprint);
  const verdict = evaluateFreshness(fingerprint, { maxAgeMinutes: 60 });
  assert.equal(verdict, null, "refusing to run because the app publishes no build time would make the gate unusable");
  assert.equal(fingerprint.unknowns[0].what, "freshness.buildAge");
});

test("fingerprint collection never fails a run, even with no page at all", async () => {
  const fingerprint = await collectEnvironmentFingerprint(null, {});
  assert.equal(fingerprint.frontend.buildId, "unknown");
  assert.match(fingerprint.frontend.reason, /no page/);
  assert.equal(fingerprint.compositeId, "fe:unknown");
});
