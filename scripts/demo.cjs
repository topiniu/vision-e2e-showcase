#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { startSelfcheckApp } = require("../test/fixtures/selfcheck-app");
const { createTestSession } = require("../runtime/server/test-session-runner");
const { TestSessionStore } = require("../runtime/server/session-store");
const { verifyEvidenceBundle } = require("../runtime/reporting/evidence-bundle");

const root = path.resolve(__dirname, "..");

async function prepareProfile(outputRoot) {
  const dir = path.join(outputRoot, "auth-profiles", "demo-local");
  await fs.mkdir(dir, { recursive: true });
  // The fixture has no authentication. Seed an empty state only when absent.
  await fs.writeFile(path.join(dir, "storageState.json"), '{"cookies":[],"origins":[]}', { flag: "wx", mode: 0o600 })
    .catch((error) => { if (error.code !== "EEXIST") throw error; });
}

async function runDemo({ workspaceRoot = root, serve = false } = {}) {
  const outputRoot = path.join(workspaceRoot, "output");
  await prepareProfile(outputRoot);
  const app = await startSelfcheckApp({ crash: false, port: serve ? 32148 : 0 });
  if (serve) {
    console.log(`Local demo: ${app.baseUrl}\nOpen the desktop app and run demo/passing.json or demo/failing.json.`);
    return app;
  }
  const store = new TestSessionStore({ outputRoot });
  const results = [];
  try {
    for (const [file, expectedStatus] of [["passing", "passed"], ["failing", "failed"]]) {
      const testFile = JSON.parse(await fs.readFile(path.join(root, "test-workflows", "demo", `${file}.json`), "utf8"));
      testFile.baseUrl = app.baseUrl;
      const outcome = await createTestSession({ testFile, authProfile: "demo-local", wait: true, waitTimeoutMs: 0 }, {
        store, outputRoot,
        outputRunsRoot: path.join(outputRoot, "runs"),
        testWorkflowsRoot: path.join(root, "test-workflows"),
      });
      assert.equal(outcome.response.status, expectedStatus, JSON.stringify(outcome.response));
      const session = await store.readSession(outcome.response.sessionId);
      const round = session.rounds.at(-1);
      const bundle = round.evidenceBundles[0];
      assert.equal(verifyEvidenceBundle({ bundlePath: bundle.bundlePath, workspaceRoot }).valid, true);
      if (file === "failing") assert.equal(bundle.failureClass, "value-assertion");
      const aggregate = JSON.parse(await fs.readFile(round.aggregatePath, "utf8"));
      const evidence = aggregate.caseResults[0].result.evidence;
      const summary = JSON.parse(await fs.readFile(evidence.summaryPath, "utf8"));
      const screenshot = summary.steps.map((step) => step.afterScreenshotPath).filter(Boolean).at(-1);
      assert.ok(screenshot, "Each demo must produce real screenshot evidence");
      results.push({ scenario: file, status: outcome.response.status, failureClass: bundle.failureClass, evidenceVerified: true, screenshot, reportPath: round.reportPath });
      console.log(`${file}: ${outcome.response.status}; evidence verified; ${round.reportPath}`);
    }
    await fs.mkdir(path.join(outputRoot, "demo"), { recursive: true });
    await fs.writeFile(path.join(outputRoot, "demo", "summary.json"), JSON.stringify(results, null, 2));
    return results;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  runDemo({ serve: process.argv.includes("--serve") }).then((app) => {
    if (app?.close) {
      const stop = () => app.close().then(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { runDemo };
