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
  sanitizeCheckpointId,
  resolveCheckpointDir,
  listCheckpoints,
} = require("../../runtime/executor/checkpoint-store");
const { handleCheckpointRoute } = require("../../src/main/desktop-runtime-routes");

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// --- store id helpers ---

test("Z11 sanitizeCheckpointId keeps it filesystem-safe and confined", () => {
  // path separators become dashes, so no traversal escapes the checkpoints root
  assert.equal(sanitizeCheckpointId("demo-0261/../../etc"), "demo-0261-..-..-etc");
  assert.ok(!sanitizeCheckpointId("../../secret").includes("/"));
  assert.equal(sanitizeCheckpointId("  spu chain 1 "), "spu-chain-1");
  assert.equal(sanitizeCheckpointId(""), "");
  assert.equal(sanitizeCheckpointId("a/b\\c"), "a-b-c");
});

test("Z11 resolveCheckpointDir stays under the root", () => {
  const dir = resolveCheckpointDir("/tmp/checkpoints", "demo-0261");
  assert.equal(dir, path.join("/tmp/checkpoints", "demo-0261"));
  assert.equal(resolveCheckpointDir("/tmp/checkpoints", "///"), null);
});

test("Z11 listCheckpoints reports saved checkpoints", async () => {
  const root = await makeTempRoot("zhuzhu-ck-list-");
  await saveCheckpoint(resolveCheckpointDir(root, "chain-a"), {
    atIndex: 5,
    atStepId: "idx5",
    runtimeVariables: { spuId: "SPU-1" },
    storageState: { cookies: [], origins: [] },
  });
  await saveCheckpoint(resolveCheckpointDir(root, "chain-b"), { atIndex: 2, runtimeVariables: {} });
  const items = await listCheckpoints(root);
  const ids = items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["chain-a", "chain-b"]);
  const a = items.find((i) => i.id === "chain-a");
  assert.equal(a.atStepId, "idx5");
  assert.equal(a.hasStorageState, true);
  assert.deepEqual(a.runtimeVariableKeys, ["spuId"]);
});

test("Z11 planResume matches by atStepId even when index shifts", () => {
  // A step was inserted at the front, shifting indices; atStepId still resolves.
  const actions = [
    { index: 0, id: "new-first" },
    { index: 1, id: "idx5" },
    { index: 2, id: "tail" },
  ];
  const plan = planResume(actions, { atIndex: 5, atStepId: "idx5", runtimeVariables: { a: "1" } });
  assert.equal(plan.startIndex, 2); // resume after the step whose id is idx5 (now index 1)
  assert.deepEqual(plan.resumeRuntimeVariables, { a: "1" });
});

// --- HTTP route handler ---

test("Z11 handleCheckpointRoute GET lists, DELETE clears", async () => {
  const root = await makeTempRoot("zhuzhu-ck-route-");
  await saveCheckpoint(resolveCheckpointDir(root, "chain-a"), { atIndex: 1, runtimeVariables: {} });
  const deps = { listCheckpoints, clearCheckpoint, resolveCheckpointDir, checkpointsRoot: root };

  const list = await handleCheckpointRoute("GET", "/checkpoints", deps);
  assert.equal(list.statusCode, 200);
  assert.equal(list.payload.data.checkpoints.length, 1);

  const del = await handleCheckpointRoute("DELETE", "/checkpoints/chain-a", deps);
  assert.equal(del.statusCode, 200);
  assert.equal(del.payload.data.cleared, true);
  assert.equal(await loadCheckpoint(resolveCheckpointDir(root, "chain-a")), null);

  const listAfter = await handleCheckpointRoute("GET", "/checkpoints", deps);
  assert.equal(listAfter.payload.data.checkpoints.length, 0);
});

test("Z11 handleCheckpointRoute rejects bad id and passes through non-checkpoint paths", async () => {
  const root = await makeTempRoot("zhuzhu-ck-route2-");
  const deps = { listCheckpoints, clearCheckpoint, resolveCheckpointDir, checkpointsRoot: root };
  const bad = await handleCheckpointRoute("DELETE", "/checkpoints/%2F%2F%2F", deps);
  assert.equal(bad.statusCode, 400);
  assert.equal(await handleCheckpointRoute("GET", "/test-sessions/abc", deps), null);
});
