const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { run } = require("../../runtime/executor/run-orchestrator");

// v1.4 REQ-Z17: proactive login recovery used to fire once per case just because
// the run navigates to the file's `baseUrl` first — and for these files baseUrl
// IS the login page, so `recovery.login.detect.urlIncludes: "/login"` always
// matched even on a browser that was perfectly logged in
// (reproduced by output/runs/20260821-1804..1806 — three cases, three logins).
// The gate: proactive recovery is skipped when the live context already carries a
// credential; reactive recovery (a step really failed) is never gated.

const AUTHENTICATED_STATE = {
  cookies: [{ name: "SESSION", value: "abc123", domain: "localhost", path: "/", expires: -1 }],
  origins: [],
};
const LOGGED_OUT_STATE = { cookies: [], origins: [] };

function createFakePage({ storageState = LOGGED_OUT_STATE, url = "http://localhost:8000/login", failGoto = false } = {}) {
  let currentUrl = url;
  return {
    url: () => currentUrl,
    async evaluate() {
      return {
        url: currentUrl,
        title: "DEMO",
        text: "",
        interactables: [],
        viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
        antd: { detected: false, confidence: 0, versionHint: null, components: [], signals: {} },
      };
    },
    async waitForTimeout() {},
    async waitForLoadState() {},
    async screenshot() {
      return Buffer.alloc(0);
    },
    async goto(target) {
      if (failGoto) {
        throw new Error("net::ERR_ABORTED");
      }
      currentUrl = target;
      return null;
    },
    on() {},
    off() {},
    context() {
      return {
        async storageState() {
          return storageState;
        },
      };
    },
  };
}

// A "login" handler shaped like the real one in common/demo-base.json, with
// its steps reduced to a single navigation so the test needs no DOM.
function loginRecovery() {
  return {
    login: {
      detect: { urlIncludes: "/login" },
      steps: [
        { id: "recovery-login", type: "openUrl", url: "http://localhost:8000/demoWorkflow", retries: 0 },
      ],
    },
  };
}

function businessStep(id = "business", overrides = {}) {
  return { id, type: "openUrl", url: "http://localhost:8000/demoWorkflow", retries: 0, ...overrides };
}

async function withTempOutputDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-auth-gate-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("proactive login recovery is skipped when the live context already holds a credential", async () => {
  await withTempOutputDir(async (outputDir) => {
    const events = [];
    const result = await run([businessStep()], {
      page: createFakePage({ storageState: AUTHENTICATED_STATE }),
      recovery: loginRecovery(),
      outputDir,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.ok, true);
    assert.equal(events.some((event) => event.type === "recovery-start"), false);
    const skipped = events.filter((event) => event.type === "recovery-skipped");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].recoveryKey, "login");
    assert.equal(skipped[0].reason, "authenticated");
    assert.deepEqual(result.telemetry.recoverySkipped, [{ key: "login", reason: "authenticated" }]);
  });
});

test("proactive login recovery still runs when the context has no credential", async () => {
  await withTempOutputDir(async (outputDir) => {
    const events = [];
    const result = await run([businessStep()], {
      page: createFakePage({ storageState: LOGGED_OUT_STATE }),
      recovery: loginRecovery(),
      outputDir,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.ok, true);
    const started = events.filter((event) => event.type === "recovery-start");
    assert.equal(started.length, 1);
    assert.equal(started[0].recoveryKey, "login");
    assert.equal(events.some((event) => event.type === "recovery-skipped"), false);
    assert.equal(result.telemetry.recoverySkipped, undefined);
  });
});

test("ZHUZHU_RECOVERY_AUTH_GATE=0 restores the pre-v1.4 unconditional login", async () => {
  const previous = process.env.ZHUZHU_RECOVERY_AUTH_GATE;
  process.env.ZHUZHU_RECOVERY_AUTH_GATE = "0";
  try {
    await withTempOutputDir(async (outputDir) => {
      const events = [];
      await run([businessStep()], {
        page: createFakePage({ storageState: AUTHENTICATED_STATE }),
        recovery: loginRecovery(),
        outputDir,
        onEvent: (event) => events.push(event),
      });
      assert.equal(events.some((event) => event.type === "recovery-start"), true);
      assert.equal(events.some((event) => event.type === "recovery-skipped"), false);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ZHUZHU_RECOVERY_AUTH_GATE;
    } else {
      process.env.ZHUZHU_RECOVERY_AUTH_GATE = previous;
    }
  }
});

test("reactive recovery is NOT auth-gated: a failed step still triggers login", async () => {
  await withTempOutputDir(async (outputDir) => {
    const events = [];
    // Credential present (so the proactive pass is gated away) but the business
    // step fails while the page sits on /login — the classic "token exists but is
    // server-side dead" shape. Recovery must run, otherwise nothing could heal it.
    const result = await run([businessStep("business-fails")], {
      page: createFakePage({ storageState: AUTHENTICATED_STATE, failGoto: true }),
      recovery: loginRecovery(),
      outputDir,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.ok, false);
    assert.equal(events.some((event) => event.type === "recovery-skipped"), true);
    const started = events.filter((event) => event.type === "recovery-start");
    assert.equal(started.length, 1);
    assert.equal(started[0].recoveryKey, "login");
  });
});
