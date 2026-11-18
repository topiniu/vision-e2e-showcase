const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { runDemo } = require("../../scripts/demo.cjs");

test("showcase executes a passing workflow and detects a wrong value with verified evidence", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vision-demo-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const results = await runDemo({ workspaceRoot });
  assert.deepEqual(results.map(({ status, evidenceVerified }) => ({ status, evidenceVerified })), [
    { status: "passed", evidenceVerified: true },
    { status: "failed", evidenceVerified: true },
  ]);
  for (const result of results) {
    const png = await fs.readFile(result.screenshot);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  }
});
