
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { releaseConsoleMessageArgs } = require("../../runtime/perception/console-message-args");

const execFileAsync = promisify(execFile);
const PROBE = path.join(__dirname, "..", "fixtures", "console-handle-probe.js");
const MESSAGES = 1500 * 5; // warm-up round + 4 measured rounds

// The measurement runs in a child with --expose-gc; see the fixture header for
// why the flag cannot simply be added to `npm test`.
async function runProbe(mode) {
  const { stdout } = await execFileAsync(process.execPath, ["--expose-gc", PROBE, mode], {
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

test("releasing console args keeps main-process heap flat under console noise", async () => {
  const { growthMb, seen } = await runProbe("release");

  assert.equal(seen, MESSAGES, "listener must observe every message");
  // Leaking would add ~6.2KB x 6000 messages = ~37MB here. 12MB leaves ample
  // room for ordinary allocation noise while still failing an actual leak.
  assert.ok(
    growthMb < 12,
    `heap grew ${growthMb.toFixed(1)}MB across 6000 released messages — args are not being disposed`,
  );
});

test("the unreleased listener is what leaks (control)", async () => {
  // The control that gives the assertion above its meaning: same load, same
  // machine, only difference is the missing release. If this ever stops
  // growing, Playwright changed its handle lifetime and the gate above has
  // quietly become vacuous — at which point this test failing is the signal to
  // go re-read `releaseConsoleMessageArgs`, not to delete the release call.
  const { growthMb } = await runProbe("keep");

  assert.ok(
    growthMb > 12,
    `the un-disposed control only grew ${growthMb.toFixed(1)}MB — Playwright may no longer pin console args; re-verify the fix still has a purpose`,
  );
});

test("releaseConsoleMessageArgs tolerates non-Playwright message shapes", () => {
  assert.equal(releaseConsoleMessageArgs(null), 0);
  assert.equal(releaseConsoleMessageArgs({}), 0);
  assert.equal(releaseConsoleMessageArgs({ args: () => [] }), 0);
  assert.equal(releaseConsoleMessageArgs({ args: () => [{}] }), 0);
  assert.equal(
    releaseConsoleMessageArgs({
      args: () => {
        throw new Error("no args on this shape");
      },
    }),
    0,
  );
  // A rejected dispose must be swallowed, not turned into an unhandled rejection.
  assert.equal(
    releaseConsoleMessageArgs({ args: () => [{ dispose: () => Promise.reject(new Error("gone")) }] }),
    1,
  );
  // A synchronously throwing dispose must not escape either.
  assert.equal(
    releaseConsoleMessageArgs({
      args: () => [
        {
          dispose() {
            throw new Error("page closed");
          },
        },
      ],
    }),
    0,
  );
});
