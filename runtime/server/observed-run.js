"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getRunBoard } = require("./run-board");

// Standalone entry points have no session or App-run parent to register them.
// Keep observation here, outside the engine, to avoid duplicate case entries.
async function observedRun(payload, options = {}, { outputRoot, kind = "runtime-run", trigger, runImpl } = {}) {
  const { run } = require("..");
  const id = options.runId || `runtime-${randomUUID()}`;
  const board = getRunBoard({ outputRoot });
  board?.register({ id, kind, title: options.testContext?.caseName || options.url || id,
    testFileName: options.testContext?.testFileName, trigger, headed: options.headless === false, caseTotal: 1 });
  try {
    const result = await (runImpl || run)(payload, {
      ...options,
      runId: id,
      outputDir: options.outputDir || (outputRoot ? path.join(outputRoot, "runs") : undefined),
      onEvent: (event) => {
        board?.recordEvent(id, event);
        return options.onEvent?.(event);
      },
    });
    board?.finish(id, { status: result.ok ? "passed" : "failed", ok: result.ok,
      firstFailure: result.error, reportPath: result.evidence?.reportPath });
    return result;
  } catch (error) {
    board?.finish(id, { status: error.name === "AbortError" || error.code === "runtime-aborted" ? "cancelled" : "error",
      firstFailure: { code: error.code, message: error.message } });
    throw error;
  }
}

module.exports = { observedRun };
