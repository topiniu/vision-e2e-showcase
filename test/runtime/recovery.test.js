const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateDetect,
  selectFiredRecoveries,
  selectReactiveRecoveries,
  hasDetectableRecovery,
} = require("../../runtime/executor/recovery");

test("evaluateDetect: urlIncludes / urlMatches / not / textExists", () => {
  assert.equal(evaluateDetect({ urlIncludes: "/login" }, { url: "http://x/login?next=1" }), true);
  assert.equal(evaluateDetect({ urlIncludes: "/login" }, { url: "http://x/demoWorkflow" }), false);
  assert.equal(evaluateDetect({ urlMatches: "/login|/signin" }, { url: "http://x/signin" }), true);
  assert.equal(evaluateDetect({ urlIncludesAny: ["/login", "/auth"] }, { url: "http://x/auth" }), true);
  // negation: "not on the app home"
  assert.equal(evaluateDetect({ not: { urlIncludes: "/home" } }, { url: "http://x/login" }), true);
  assert.equal(evaluateDetect({ not: { urlIncludes: "/home" } }, { url: "http://x/home" }), false);
  // textExists needs the optional hook
  assert.equal(
    evaluateDetect({ textExists: "请登录" }, { url: "http://x/", hasText: (t) => t === "请登录" }),
    true,
  );
  assert.equal(evaluateDetect({ textExists: "请登录" }, { url: "http://x/" }), false);
  // invalid / empty
  assert.equal(evaluateDetect(null, { url: "http://x/login" }), false);
  assert.equal(evaluateDetect({ urlMatches: "([" }, { url: "http://x/login" }), false);
});

test("selectFiredRecoveries returns fired handlers in declaration order", () => {
  const recovery = {
    login: { detect: { urlIncludes: "/login" }, steps: [{ id: "s1" }] },
    modal: { detect: { textExists: "确认" }, steps: [{ id: "s2" }] },
    noDetect: { steps: [{ id: "s3" }] }, // never fires proactively
  };
  const fired = selectFiredRecoveries(recovery, { url: "http://x/login" });
  assert.deepEqual(fired.map((f) => f.key), ["login"]);

  const both = selectFiredRecoveries(recovery, { url: "http://x/login", hasText: (t) => t === "确认" });
  assert.deepEqual(both.map((f) => f.key), ["login", "modal"]);

  assert.deepEqual(selectFiredRecoveries(recovery, { url: "http://x/home" }).map((f) => f.key), []);
});

test("selectReactiveRecoveries honors reactive flag", () => {
  const recovery = {
    login: { detect: { urlIncludes: "/login" }, steps: [], reactive: true },
    banner: { detect: { urlIncludes: "/login" }, steps: [], reactive: false },
  };
  const fired = selectReactiveRecoveries(recovery, { url: "http://x/login" });
  assert.deepEqual(fired.map((f) => f.key), ["login"]);
});

test("hasDetectableRecovery", () => {
  assert.equal(hasDetectableRecovery({ login: { detect: { urlIncludes: "/login" }, steps: [] } }), true);
  assert.equal(hasDetectableRecovery({ noDetect: { steps: [] } }), false);
  assert.equal(hasDetectableRecovery({}), false);
  assert.equal(hasDetectableRecovery(null), false);
});
