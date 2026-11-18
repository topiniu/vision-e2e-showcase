const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  planResume,
} = require("../../runtime/executor/checkpoint-store");
const { RunSession } = require("../../runtime/executor/run-session");

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("Z11 saveCheckpoint round-trips index, ids and storageState", async () => {
  const dir = await makeTempDir("zhuzhu-ckpt-");
  const storageState = { cookies: [{ name: "sid", value: "abc" }], origins: [] };
  const saved = await saveCheckpoint(dir, {
    atIndex: 29,
    atStepId: "idx29-mode-switch",
    runtimeVariables: { spuId: "SPU-100", orderId: "ORD-200" },
    storageState,
  });
  assert.ok(saved.checkpointPath.endsWith("checkpoint.json"));
  assert.ok(saved.storageStatePath.endsWith("checkpoint-storage-state.json"));

  const loaded = await loadCheckpoint(dir);
  assert.equal(loaded.atIndex, 29);
  assert.equal(loaded.atStepId, "idx29-mode-switch");
  assert.deepEqual(loaded.runtimeVariables, { spuId: "SPU-100", orderId: "ORD-200" });
  // storageState was written to its own file the resume can hand back to the browser
  const persisted = JSON.parse(await fs.readFile(loaded.storageStatePath, "utf8"));
  assert.deepEqual(persisted, storageState);
});

test("Z11 saveCheckpoint without storageState leaves storageStatePath null", async () => {
  const dir = await makeTempDir("zhuzhu-ckpt-nostate-");
  const saved = await saveCheckpoint(dir, { atIndex: 3, runtimeVariables: { a: "1" } });
  assert.equal(saved.storageStatePath, null);
  const loaded = await loadCheckpoint(dir);
  assert.equal(loaded.storageStatePath, null);
});

test("Z11 saveCheckpoint rejects a bad index", async () => {
  const dir = await makeTempDir("zhuzhu-ckpt-bad-");
  await assert.rejects(() => saveCheckpoint(dir, { atIndex: -1 }), /non-negative integer/);
  await assert.rejects(() => saveCheckpoint(dir, { atIndex: 1.5 }), /non-negative integer/);
});

test("Z11 loadCheckpoint returns null when absent", async () => {
  const dir = await makeTempDir("zhuzhu-ckpt-absent-");
  assert.equal(await loadCheckpoint(dir), null);
});

test("Z11 clearCheckpoint invalidates a stale checkpoint (Z11-3)", async () => {
  const dir = await makeTempDir("zhuzhu-ckpt-clear-");
  await saveCheckpoint(dir, { atIndex: 5, runtimeVariables: {}, storageState: { cookies: [], origins: [] } });
  assert.notEqual(await loadCheckpoint(dir), null);
  await clearCheckpoint(dir);
  assert.equal(await loadCheckpoint(dir), null);
  // storage-state file is gone too
  await assert.rejects(() => fs.readFile(path.join(dir, "checkpoint-storage-state.json"), "utf8"));
});

test("Z11 planResume skips 1..N and restores ids + storage (Z11-1/Z11-2)", () => {
  const actions = [
    { index: 0, id: "s0" },
    { index: 1, id: "s1" },
    { index: 2, id: "s2" },
    { index: 3, id: "s3" },
  ];
  const checkpoint = {
    atIndex: 1,
    runtimeVariables: { spuId: "SPU-1" },
    storageStatePath: "/tmp/ckpt/storage.json",
  };
  const plan = planResume(actions, checkpoint);
  assert.equal(plan.startIndex, 2);
  assert.deepEqual(plan.skippedStepIds, ["s0", "s1"]);
  assert.deepEqual(plan.resumeRuntimeVariables, { spuId: "SPU-1" });
  assert.equal(plan.storageStatePath, "/tmp/ckpt/storage.json");
});

test("Z11 planResume with no checkpoint starts from the top", () => {
  const plan = planResume([{ index: 0, id: "s0" }], null);
  assert.equal(plan.startIndex, 0);
  assert.deepEqual(plan.skippedStepIds, []);
  assert.equal(plan.storageStatePath, null);
});

test("Z11 RunSession.captureStorageState reads the live context", async () => {
  const fakeState = { cookies: [{ name: "t", value: "1" }], origins: [] };
  const session = new RunSession({
    page: { context: () => ({ storageState: async () => fakeState }) },
  });
  const state = await session.captureStorageState();
  assert.deepEqual(state, fakeState);
});

test("Z11 RunSession.captureStorageState returns null without a context", async () => {
  const session = new RunSession({ page: {} });
  assert.equal(await session.captureStorageState(), null);
});
