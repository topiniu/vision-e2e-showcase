const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mergeAuthOnly, droppedAppStateKeys, resolveWritebackMode } = require("../../runtime/executor/storage-writeback");
const { RunSession } = require("../../runtime/executor/run-session");

const O = "http://localhost:8004";
const baseline = {
  cookies: [{ name: "erpNum", value: "old" }],
  origins: [
    {
      origin: O,
      localStorage: [
        { name: "_TOKEN_", value: "t-old" },
        { name: "_USERINFO_", value: "u" },
        { name: "demoSpotBoard.filterPanel.fixedKeys.v2.1", value: "[\"a\"]" },
      ],
    },
    { origin: "http://other:1", localStorage: [{ name: "keep", value: "1" }] },
  ],
};
const live = {
  cookies: [{ name: "erpNum", value: "new" }],
  origins: [
    {
      origin: O,
      localStorage: [
        { name: "_TOKEN_", value: "t-new" },
        { name: "_USERINFO_", value: "u" },
        { name: "demoSpotBoard.filterPanel.fixedKeys.v2.1", value: "[\"a\",\"b\"]" },
        { name: "columnSetting.v1:/demoSpotBoard|0", value: "{\"pin\":\"image\"}" },
      ],
    },
    { origin: "http://new:2", localStorage: [{ name: "batchSearchActiveTab:x", value: "2" }, { name: "_TOKEN_", value: "n" }] },
  ],
};

test("auth-only merge renews cookies and auth keys but keeps the app-state baseline (2026-10-27)", () => {
  const merged = mergeAuthOnly(baseline, live);
  assert.deepEqual(merged.cookies, live.cookies);
  const main = merged.origins.find((o) => o.origin === O);
  const map = Object.fromEntries(main.localStorage.map((i) => [i.name, i.value]));
  assert.equal(map._TOKEN_, "t-new", "token renewed");
  assert.equal(map["demoSpotBoard.filterPanel.fixedKeys.v2.1"], "[\"a\"]", "app-state key keeps its baseline value");
  assert.equal(map["columnSetting.v1:/demoSpotBoard|0"], undefined, "keys the run created are not persisted");
  // untouched origin survives; new origin brings only its auth keys
  assert.ok(merged.origins.find((o) => o.origin === "http://other:1"));
  assert.deepEqual(merged.origins.find((o) => o.origin === "http://new:2").localStorage, [{ name: "_TOKEN_", value: "n" }]);
  const dropped = droppedAppStateKeys(baseline, live);
  assert.ok(dropped.includes(`${O} columnSetting.v1:/demoSpotBoard|0`));
});

test("auth-only merge without a baseline file persists only auth state", () => {
  const merged = mergeAuthOnly(null, live);
  const main = merged.origins.find((o) => o.origin === O);
  assert.deepEqual(main.localStorage.map((i) => i.name).sort(), ["_TOKEN_", "_USERINFO_"]);
});

test("writeback mode: default auth-only, env can select full / off", () => {
  assert.equal(resolveWritebackMode({}), "auth-only");
  assert.equal(resolveWritebackMode({ ZHUZHU_STORAGE_WRITEBACK: "FULL" }), "full");
  assert.equal(resolveWritebackMode({ ZHUZHU_STORAGE_WRITEBACK: "off" }), "off");
  assert.equal(resolveWritebackMode({ ZHUZHU_STORAGE_WRITEBACK: "bogus" }), "auth-only");
});

function fakeSession(storageStatePath) {
  const session = new RunSession({ storageStatePath });
  session.ownsContext = true;
  session.context = {
    storageState: async (opts = {}) => {
      if (opts.path) fs.writeFileSync(opts.path, JSON.stringify(live));
      return JSON.parse(JSON.stringify(live));
    },
  };
  return session;
}

test("RunSession.saveStorageState merges into the profile file instead of overwriting it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-writeback-"));
  const file = path.join(dir, "storageState.json");
  fs.writeFileSync(file, JSON.stringify(baseline));
  const prev = process.env.ZHUZHU_STORAGE_WRITEBACK;
  try {
    delete process.env.ZHUZHU_STORAGE_WRITEBACK;
    await fakeSession(file).saveStorageState();
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const names = saved.origins.find((o) => o.origin === O).localStorage.map((i) => i.name);
    assert.ok(!names.includes("columnSetting.v1:/demoSpotBoard|0"));
    assert.equal(fs.readdirSync(dir).length, 1, "no temp file left behind");

    process.env.ZHUZHU_STORAGE_WRITEBACK = "off";
    fs.writeFileSync(file, JSON.stringify(baseline));
    await fakeSession(file).saveStorageState();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), baseline);

    process.env.ZHUZHU_STORAGE_WRITEBACK = "full";
    await fakeSession(file).saveStorageState();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), live);
  } finally {
    if (prev === undefined) delete process.env.ZHUZHU_STORAGE_WRITEBACK;
    else process.env.ZHUZHU_STORAGE_WRITEBACK = prev;
  }
});
