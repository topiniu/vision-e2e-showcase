const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { getIntegrationWorkspacePaths } = require("../../src/shared/integration-workspace");

test("describes the active workspace paths exposed to AI integrations", () => {
  const workspaceRoot = path.resolve(path.join(path.sep, "tmp", "zhuzhu-custom-workspace"));
  assert.deepEqual(getIntegrationWorkspacePaths(workspaceRoot), {
    workspaceRoot,
    testWorkflowsRoot: path.join(workspaceRoot, "test-workflows"),
    testAssetsRoot: path.join(workspaceRoot, "test-assets"),
    outputRoot: path.join(workspaceRoot, "output"),
    testFilePathMode: "relative-to-test-workflows",
  });
});
