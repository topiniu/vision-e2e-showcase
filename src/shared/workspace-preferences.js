const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const WORKSPACE_PREFERENCES_FILE = "workspace-preferences.json";

function getDefaultZhuzhuUserDataRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (env.ZHUZHU_USER_DATA_DIR) {
    return path.resolve(env.ZHUZHU_USER_DATA_DIR);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Vision E2E Showcase");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Vision E2E Showcase");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Vision E2E Showcase");
}

function getWorkspacePreferencesPath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), WORKSPACE_PREFERENCES_FILE);
}

function normalizeWorkspaceRoot(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const resolved = path.resolve(text);
  return resolved === path.parse(resolved).root ? "" : resolved;
}

function readWorkspacePreferenceSync(preferencesPath) {
  try {
    const payload = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
    return normalizeWorkspaceRoot(payload?.workspaceRoot);
  } catch (_error) {
    return "";
  }
}

async function writeWorkspacePreference(preferencesPath, workspaceRoot) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) {
    throw new Error("Choose a folder other than the filesystem root.");
  }
  await fsp.mkdir(path.dirname(preferencesPath), { recursive: true });
  await fsp.writeFile(preferencesPath, `${JSON.stringify({
    version: 1,
    workspaceRoot: normalizedRoot,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  return normalizedRoot;
}

async function clearWorkspacePreference(preferencesPath) {
  await fsp.rm(preferencesPath, { force: true });
}

module.exports = {
  WORKSPACE_PREFERENCES_FILE,
  clearWorkspacePreference,
  getDefaultZhuzhuUserDataRoot,
  getWorkspacePreferencesPath,
  normalizeWorkspaceRoot,
  readWorkspacePreferenceSync,
  writeWorkspacePreference,
};
