const path = require("node:path");

function getIntegrationWorkspacePaths(rawWorkspaceRoot) {
  const workspaceRoot = path.resolve(rawWorkspaceRoot);
  return {
    workspaceRoot,
    testWorkflowsRoot: path.join(workspaceRoot, "test-workflows"),
    testAssetsRoot: path.join(workspaceRoot, "test-assets"),
    outputRoot: path.join(workspaceRoot, "output"),
    testFilePathMode: "relative-to-test-workflows",
  };
}

module.exports = {
  getIntegrationWorkspacePaths,
};
