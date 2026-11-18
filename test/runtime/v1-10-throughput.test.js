const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { run } = require("../../runtime");

// v1.10 Z29: throughput changes that must not change a verdict.

function createCountingServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    // Count real page navigations only: the environment fingerprint also
    // fetches the HTML once to read a build id, which is not a page load.
    if (req.headers["sec-fetch-mode"] === "navigate") {
      hits.push(req.url);
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><body><main><h1>page ${req.url}</h1><button>继续</button></main></body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, hits, base: `http://127.0.0.1:${port}` });
    });
  });
}

function tempOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zz-v110-"));
}

test("v1.10 Z29-4: a leading reload followed by openUrl in a fresh context is elided, not executed", async () => {
  const { server, hits, base } = await createCountingServer();
  try {
    const result = await run(
      [
        { id: "fx-reload", type: "reload", phase: "fixtureSetup" },
        { id: "fx-open", type: "openUrl", url: `${base}/home`, phase: "fixtureSetup" },
      ],
      { url: `${base}/start`, outputDir: tempOutputDir(), headless: true },
    );
    assert.equal(result.ok, true);
    const [reloadStep, openStep] = result.data.results;
    assert.equal(reloadStep.skipped, true);
    assert.equal(reloadStep.data.action.detail, "elided-fresh-context-reload");
    assert.equal(openStep.ok, true);
    assert.equal(hits.filter((url) => url === "/start").length, 1, "the start page is loaded once, not reloaded");
    assert.equal(hits.filter((url) => url === "/home").length, 1);
  } finally {
    server.close();
  }
});

test("v1.10 Z29-4: elision is opt-out per run and never applies when the next step is not openUrl", async () => {
  const { server, hits, base } = await createCountingServer();
  try {
    await run(
      [
        { type: "reload" },
        { type: "openUrl", url: `${base}/home` },
      ],
      { url: `${base}/optout`, outputDir: tempOutputDir(), headless: true, elideLeadingReload: false },
    );
    assert.equal(hits.filter((url) => url === "/optout").length, 2, "opted out: the reload really runs");

    const kept = await run(
      [
        { type: "reload" },
        { type: "assertVisible", target: { text: "继续" } },
      ],
      { url: `${base}/kept`, outputDir: tempOutputDir(), headless: true },
    );
    assert.equal(kept.data.results[0].skipped, undefined);
    assert.equal(hits.filter((url) => url === "/kept").length, 2, "a reload not followed by openUrl is executed");
  } finally {
    server.close();
  }
});

test("v1.10 Z27: a run started without a target fails fast and names the missing origin", async () => {
  await assert.rejects(
    run([{ type: "openUrl", url: "{{origin.app}}/x" }], { url: "{{origin.app}}/login", outputDir: tempOutputDir(), headless: true }),
    (error) => error.code === "target-origin-missing" && error.details.missing.join() === "origin.app",
  );
  await assert.rejects(
    run([{ type: "fill", target: { text: "x" }, value: "{{credential.password}}" }], { outputDir: tempOutputDir(), headless: true }),
    (error) => error.code === "target-credential-missing",
  );
});

test("v1.10 Z27: a login that needs {{credential.*}} without a credentialRef fails with that reason in authTrace", async () => {
  const { server, base } = await createCountingServer();
  try {
    const result = await run(
      [{ type: "assertVisible", target: { text: "继续" }, timeoutMs: 1000 }],
      {
        url: `${base}/login`,
        outputDir: tempOutputDir(),
        headless: true,
        recovery: {
          login: {
            detect: { urlIncludes: "/login" },
            steps: [{ type: "fill", target: { text: "继续" }, value: "{{credential.username}}" }],
          },
        },
      },
    );
    assert.equal(result.telemetry.authTrace.recovery.triggered, true);
    assert.equal(result.telemetry.authTrace.recovery.succeeded, false);
    assert.equal(result.telemetry.authTrace.recovery.error.code, "target-credential-missing");
    assert.deepEqual(result.telemetry.authTrace.recovery.error.missing, ["credential.username"]);
  } finally {
    server.close();
  }
});

test("v1.10 Z29-4: a reload that carries its own expectation is never elided", async () => {
  const { server, hits, base } = await createCountingServer();
  try {
    const result = await run(
      [
        { type: "reload", expectation: { kind: "text-exists", texts: ["page /exp"], timeoutMs: 2000 } },
        { type: "openUrl", url: `${base}/home` },
      ],
      { url: `${base}/exp`, outputDir: tempOutputDir(), headless: true },
    );
    assert.equal(result.ok, true);
    assert.equal(hits.filter((url) => url === "/exp").length, 2);
  } finally {
    server.close();
  }
});
