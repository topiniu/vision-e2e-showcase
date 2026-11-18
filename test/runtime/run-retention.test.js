
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  planRunRetention,
  pruneRunArchive,
  resolveRetentionPolicy,
} = require("../../src/main/run-archive");

const DAY_MS = 24 * 60 * 60 * 1000;

function item(overrides = {}) {
  return {
    runDir: overrides.runDir || `/runs/${overrides.name || "run"}`,
    reportPath: overrides.reportPath || `${overrides.runDir || `/runs/${overrides.name || "run"}`}/report.json`,
    finishedAt: overrides.finishedAt ?? 0,
    runSizeBytes: overrides.runSizeBytes ?? 1024,
    ...overrides,
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-retention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRun(root, name, { finishedAt, bytes = 2048, signed = false }) {
  const runDir = path.join(root, name);
  await fs.mkdir(path.join(runDir, "steps"), { recursive: true });
  await fs.writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify({
      startedAt: finishedAt - 100,
      finishedAt,
      mode: "batch",
      testContext: { testFileId: "f", testFilePath: "f.json", testFileName: "F" },
      summary: { ok: true, type: "batch", data: { results: [] } },
      telemetry: { durationMs: 100, steps: 1, okCount: 1, errorCount: 0 },
    }),
  );
  // Real bytes, so the byte ceiling is exercised against measured sizes rather
  // than numbers the test made up.
  await fs.writeFile(path.join(runDir, "steps", "01-after.png"), Buffer.alloc(bytes, 7));
  if (signed) {
    await fs.writeFile(path.join(runDir, "evidence-bundle.json"), JSON.stringify({ signature: "sha256:test" }));
  }
  return runDir;
}

test("retention policy defaults are conservative and env-overridable", () => {
  const defaults = resolveRetentionPolicy({ now: 0 });
  assert.equal(defaults.maxAgeDays, 30);
  assert.equal(defaults.maxRuns, 300);
  assert.equal(defaults.maxBytes, 20 * 1024 * 1024 * 1024);

  const overridden = resolveRetentionPolicy({ maxAgeDays: 7, maxRuns: 10, maxBytes: 1000, now: 0 });
  assert.equal(overridden.maxAgeDays, 7);
  assert.equal(overridden.maxRuns, 10);
  assert.equal(overridden.maxBytes, 1000);

  // 0 means "no limit on this axis", which must not be confused with "delete
  // everything".
  assert.equal(resolveRetentionPolicy({ maxAgeDays: 0, now: 0 }).maxAgeDays, 0);
});

test("the plan keeps the newest runs and names why each other run goes", () => {
  const now = 10 * DAY_MS;
  const plan = planRunRetention(
    [
      item({ name: "fresh", finishedAt: now - 1 * DAY_MS }),
      item({ name: "older", finishedAt: now - 2 * DAY_MS }),
      item({ name: "ancient", finishedAt: now - 9 * DAY_MS }),
    ],
    { now, maxAgeDays: 5, maxRuns: 0, maxBytes: 0 },
  );

  assert.equal(plan.keptCount, 2);
  assert.deepEqual(
    plan.deletes.map((entry) => entry.runDir),
    ["/runs/ancient"],
  );
  assert.equal(plan.deletes[0].reason, "max-age");
});

test("the count ceiling drops oldest-first, never newest-first", () => {
  const now = 10 * DAY_MS;
  const plan = planRunRetention(
    [
      item({ name: "a", finishedAt: now - 1 }),
      item({ name: "b", finishedAt: now - 2 }),
      item({ name: "c", finishedAt: now - 3 }),
      item({ name: "d", finishedAt: now - 4 }),
    ],
    { now, maxAgeDays: 0, maxRuns: 2, maxBytes: 0 },
  );
  assert.deepEqual(plan.deletes.map((entry) => entry.reason), ["max-runs", "max-runs"]);
  assert.deepEqual(plan.deletes.map((entry) => entry.runDir), ["/runs/c", "/runs/d"]);
});

test("the byte ceiling counts what is kept, not what existed", () => {
  const now = 10 * DAY_MS;
  const plan = planRunRetention(
    [
      item({ name: "a", finishedAt: now - 1, runSizeBytes: 600 }),
      item({ name: "b", finishedAt: now - 2, runSizeBytes: 600 }),
      item({ name: "c", finishedAt: now - 3, runSizeBytes: 600 }),
    ],
    { now, maxAgeDays: 0, maxRuns: 0, maxBytes: 1000 },
  );
  assert.equal(plan.keptCount, 1);
  assert.equal(plan.keptBytes, 600);
  assert.deepEqual(plan.deletes.map((entry) => entry.reason), ["max-bytes", "max-bytes"]);
});

test("prune deletes over-limit runs, keeps the newest, and reports what it did", async (t) => {
  const root = await tempRoot(t);
  const now = Date.now();
  await writeRun(root, "20260101-000001-keep-newest", { finishedAt: now - 1000 });
  await writeRun(root, "20250101-000002-drop-old", { finishedAt: now - 90 * DAY_MS });
  await writeRun(root, "20250101-000003-drop-older", { finishedAt: now - 120 * DAY_MS });

  const outcome = await pruneRunArchive(root, { maxAgeDays: 30, maxRuns: 0, maxBytes: 0 });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.deleted, 2);
  assert.ok(outcome.freedBytes > 0);
  assert.equal(outcome.kept, 1);

  const remaining = (await fs.readdir(root)).filter((name) => name !== "index.json").sort();
  assert.deepEqual(remaining, ["20260101-000001-keep-newest"]);

  // The index must no longer advertise runs whose directories are gone —
  // otherwise the history list offers reports that 404.
  const index = JSON.parse(await fs.readFile(path.join(root, "index.json"), "utf8"));
  assert.equal(index.items.length, 1);
});

test("a signed evidence bundle is never deleted automatically", async (t) => {
  const root = await tempRoot(t);
  const now = Date.now();
  await writeRun(root, "20250101-000001-signed", { finishedAt: now - 200 * DAY_MS, signed: true });
  await writeRun(root, "20250101-000002-unsigned", { finishedAt: now - 200 * DAY_MS });

  const outcome = await pruneRunArchive(root, { maxAgeDays: 30, maxRuns: 0, maxBytes: 0 });

  assert.equal(outcome.deleted, 1);
  assert.equal(outcome.protected, 1);
  const remaining = (await fs.readdir(root)).filter((name) => name !== "index.json");
  assert.deepEqual(remaining, ["20250101-000001-signed"]);
});

// v1.9: the two ways the v1.8 policy silently did nothing in the field.
//
// Every test above starts from an empty directory, so `ensureRunArchive` always
// took its "no index — walk everything" branch and retention always saw the
// whole archive. Production never looks like that: the index exists, it is only
// appended to on normal completion, and it is authoritative. On the 2026-09-08
// machine that gap had grown to index=300 vs disk=1293 runs (6.5GB), with
// retention cheerfully reporting that nothing was over the limit.
test("prune reconciles with disk instead of trusting a stale index", async (t) => {
  const root = await tempRoot(t);
  const now = Date.now();
  await writeRun(root, "20260101-000001-indexed", { finishedAt: now - 1000 });
  // Build an index that knows about that one run only.
  await pruneRunArchive(root, { maxAgeDays: 0, maxRuns: 0, maxBytes: 0 });
  const before = JSON.parse(await fs.readFile(path.join(root, "index.json"), "utf8"));
  assert.equal(before.items.length, 1, "precondition: index knows one run");

  // Now two more runs land WITHOUT going through updateRunArchiveIndex — the
  // cancelled/crashed/other-channel case. A stale-index policy cannot see them.
  await writeRun(root, "20250101-000002-unindexed-old", { finishedAt: now - 90 * DAY_MS });
  await writeRun(root, "20250101-000003-unindexed-older", { finishedAt: now - 120 * DAY_MS });

  const outcome = await pruneRunArchive(root, { maxAgeDays: 30, maxRuns: 0, maxBytes: 0 });

  assert.equal(outcome.deleted, 2, "runs missing from the index must still be reachable by retention");
  const remaining = (await fs.readdir(root)).filter((name) => name !== "index.json").sort();
  assert.deepEqual(remaining, ["20260101-000001-indexed"]);
});

test("orphan run directories with no report are reclaimed once they are old", async (t) => {
  const root = await tempRoot(t);
  const now = Date.now();
  await writeRun(root, "20260101-000001-normal", { finishedAt: now - 1000 });

  // A run that died before writing report.json: invisible to every index-based
  // policy, because runs are discovered BY their report.
  const orphan = path.join(root, "20250101-000002-orphan");
  await fs.mkdir(path.join(orphan, "steps"), { recursive: true });
  await fs.writeFile(path.join(orphan, "steps", "01-after.png"), Buffer.alloc(4096, 7));
  const old = new Date(now - 10 * DAY_MS);
  await fs.utimes(orphan, old, old);

  // A signed orphan and a fresh orphan must both survive: one is evidence
  // somebody kept deliberately, the other may be a run in progress right now.
  const signedOrphan = path.join(root, "20250101-000003-orphan-signed");
  await fs.mkdir(signedOrphan, { recursive: true });
  await fs.writeFile(path.join(signedOrphan, "evidence-bundle.json"), JSON.stringify({ signature: "sha256:x" }));
  await fs.utimes(signedOrphan, old, old);
  const freshOrphan = path.join(root, "20260101-000004-orphan-fresh");
  await fs.mkdir(freshOrphan, { recursive: true });

  const outcome = await pruneRunArchive(root, { maxAgeDays: 0, maxRuns: 0, maxBytes: 0 });

  assert.equal(outcome.orphansDeleted, 1);
  assert.ok(outcome.freedBytes > 0);
  const remaining = (await fs.readdir(root)).filter((name) => name !== "index.json").sort();
  assert.deepEqual(remaining, [
    "20250101-000003-orphan-signed",
    "20260101-000001-normal",
    "20260101-000004-orphan-fresh",
  ]);
});

test("prune on an empty or unreadable archive is a no-op, not a throw", async (t) => {
  const root = await tempRoot(t);
  const outcome = await pruneRunArchive(root, { maxAgeDays: 1 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.deleted, 0);

  // Housekeeping must never be able to fail the thing that triggered it.
  const missing = await pruneRunArchive(path.join(root, "does-not-exist"), { maxAgeDays: 1 });
  assert.equal(missing.deleted, 0);
});
