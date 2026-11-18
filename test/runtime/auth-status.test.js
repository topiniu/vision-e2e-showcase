const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  hasAuthEvidence,
  getAuthProfileStatus,
  writeAuthProfileStorageState,
} = require("../../runtime/server/auth-profile");

// Z05: App-run panel-status and profile-status endpoints both decide "logged in?"
// via hasAuthEvidence, so the two channels share one login-state口径.

test("hasAuthEvidence detects an authenticated storageState (Z05)", () => {
  assert.equal(
    hasAuthEvidence({ cookies: [{ name: "SESSION", value: "abc123" }], origins: [] }),
    true,
  );
  assert.equal(
    hasAuthEvidence({
      cookies: [],
      origins: [{ origin: "http://x", localStorage: [{ name: "accessToken", value: "t" }] }],
    }),
    true,
  );
});

test("hasAuthEvidence treats an empty/anonymous storageState as logged out (Z05)", () => {
  assert.equal(hasAuthEvidence({ cookies: [], origins: [] }), false);
  assert.equal(hasAuthEvidence({ cookies: [{ name: "theme", value: "" }], origins: [] }), false);
  assert.equal(hasAuthEvidence(null), false);
});

test("getAuthProfileStatus reports ready + authenticated for a captured profile (Z05-1/Z05-3)", async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-auth-"));
  await writeAuthProfileStorageState(
    "demo-local",
    { cookies: [{ name: "SESSION", value: "abc" }], origins: [] },
    { outputRoot },
  );
  const status = await getAuthProfileStatus("demo-local", { outputRoot });
  assert.equal(status.ok, true);
  assert.equal(status.status, "ready");
  assert.equal(status.authenticated, true);

  const missing = await getAuthProfileStatus("nope", { outputRoot });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "missing");
});
