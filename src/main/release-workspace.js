const fs = require("node:fs/promises");
const path = require("node:path");

async function copyDefaults(sourceRoot, targetRoot) {
  try {
    await fs.access(sourceRoot);
  } catch (_error) {
    return;
  }
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

async function ensureReleaseWorkspace({ workspaceRoot, bundledWorkspaceRoot }) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const testWorkflowsRoot = path.join(resolvedWorkspaceRoot, "test-workflows");
  const testAssetsRoot = path.join(resolvedWorkspaceRoot, "test-assets");
  const outputRoot = path.join(resolvedWorkspaceRoot, "output");

  await fs.mkdir(resolvedWorkspaceRoot, { recursive: true });
  await copyDefaults(path.join(bundledWorkspaceRoot, "test-workflows"), testWorkflowsRoot);
  await copyDefaults(path.join(bundledWorkspaceRoot, "test-assets"), testAssetsRoot);
  await fs.mkdir(outputRoot, { recursive: true });

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    testWorkflowsRoot,
    testAssetsRoot,
    outputRoot,
  };
}

module.exports = {
  ensureReleaseWorkspace,
};
