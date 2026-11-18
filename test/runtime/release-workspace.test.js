const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureReleaseWorkspace } = require("../../src/main/release-workspace");

test("release workspace seeds defaults without replacing user changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-release-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bundledWorkspaceRoot = path.join(root, "bundled");
  const workspaceRoot = path.join(root, "user", "workspace");
  await fs.mkdir(path.join(bundledWorkspaceRoot, "test-workflows"), { recursive: true });
  await fs.mkdir(path.join(bundledWorkspaceRoot, "test-assets"), { recursive: true });
  await fs.writeFile(path.join(bundledWorkspaceRoot, "test-workflows", "sample.json"), "bundled");
  await fs.writeFile(path.join(bundledWorkspaceRoot, "test-assets", "sample.txt"), "asset");

  const first = await ensureReleaseWorkspace({ workspaceRoot, bundledWorkspaceRoot });
  assert.equal(await fs.readFile(path.join(first.testWorkflowsRoot, "sample.json"), "utf8"), "bundled");
  assert.equal(await fs.readFile(path.join(first.testAssetsRoot, "sample.txt"), "utf8"), "asset");
  assert.equal((await fs.stat(first.outputRoot)).isDirectory(), true);

  await fs.writeFile(path.join(first.testWorkflowsRoot, "sample.json"), "user-edited");
  await fs.writeFile(path.join(bundledWorkspaceRoot, "test-workflows", "new.json"), "new-default");
  await ensureReleaseWorkspace({ workspaceRoot, bundledWorkspaceRoot });

  assert.equal(await fs.readFile(path.join(first.testWorkflowsRoot, "sample.json"), "utf8"), "user-edited");
  assert.equal(await fs.readFile(path.join(first.testWorkflowsRoot, "new.json"), "utf8"), "new-default");
});
