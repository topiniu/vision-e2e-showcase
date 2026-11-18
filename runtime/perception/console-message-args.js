"use strict";


function releaseConsoleMessageArgs(message) {
  let args;
  try {
    args = typeof message?.args === "function" ? message.args() : null;
  } catch (_error) {
    // A fake/limited message object (tests, non-Playwright pages) has no args.
    return 0;
  }
  if (!Array.isArray(args) || !args.length) {
    return 0;
  }
  let released = 0;
  for (const arg of args) {
    if (typeof arg?.dispose !== "function") {
      continue;
    }
    try {
      const result = arg.dispose();
      released += 1;
      // Disposal is a round-trip to the browser. It is fire-and-forget on
      // purpose — awaiting it would serialise the console stream behind the
      // network, and a failed release (page already gone) is harmless.
      if (result && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch (_error) {
      // Page/context already closed — the handles died with it.
    }
  }
  return released;
}

module.exports = { releaseConsoleMessageArgs };
