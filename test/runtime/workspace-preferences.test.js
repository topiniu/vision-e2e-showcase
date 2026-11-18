const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  clearWorkspacePreference,
  getDefaultZhuzhuUserDataRoot,
  getWorkspacePreferencesPath,
  normalizeWorkspaceRoot,
  readWorkspacePreferenceSync,
  writeWorkspacePreference,
} = require("../../src/shared/workspace-preferences");

test("resolves the standard Zhuzhu user-data roots", () => {
  assert.equal(
    getDefaultZhuzhuUserDataRoot({ platform: "darwin", home: "/Users/test", env: {} }),
    path.join("/Users/test", "Library", "Application Support", "Vision E2E Showcase"),
  );
  assert.equal(
    getDefaultZhuzhuUserDataRoot({ platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" } }),
    path.join("C:\\Users\\test\\AppData\\Roaming", "Vision E2E Showcase"),
  );
});

test("persists and clears a normalized workspace folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-workspace-preference-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preferencesPath = getWorkspacePreferencesPath(path.join(root, "user-data"));
  const workspaceRoot = path.join(root, "shared-workspace", "..");

  const savedRoot = await writeWorkspacePreference(preferencesPath, workspaceRoot);
  assert.equal(savedRoot, path.join(root, "shared-workspace", ".."));
  assert.equal(readWorkspacePreferenceSync(preferencesPath), savedRoot);

  await clearWorkspacePreference(preferencesPath);
  assert.equal(readWorkspacePreferenceSync(preferencesPath), "");
});

test("rejects filesystem roots as workspace folders", () => {
  assert.equal(normalizeWorkspaceRoot(path.parse(process.cwd()).root), "");
});
