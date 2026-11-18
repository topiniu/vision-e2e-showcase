"use strict";


const path = require("node:path");

async function main() {
  if (typeof process.send !== "function") {
    process.stderr.write(
      "session-worker-entry must be started with an IPC channel (child_process.fork), " +
        "since it reports its result over process.send.\n",
    );
    process.exit(2);
    return;
  }

  process.on("message", async (message) => {
    if (!message || message.type !== "run") {
      return;
    }
    const { request = {}, options = {} } = message;
    try {
      const { createTestSession } = require("./test-session-runner");
      const { TestSessionStore } = require("./session-store");
      const { launchSharedBrowser } = require("../executor/run-session");

      const outputRoot = options.outputRoot || path.join(process.cwd(), "output");
      const store = new TestSessionStore({ outputRoot });
      const result = await createTestSession(
        // The child's whole existence is this one session; an async submit here
        // would let the process exit before the work finished.
        { ...request, wait: true, waitTimeoutMs: 0 },
        {
          store,
          outputRoot,
          outputRunsRoot: options.outputRunsRoot || path.join(outputRoot, "runs"),
          testWorkflowsRoot: options.testWorkflowsRoot || null,
          browserContext: options.browserContext || null,
          checkpointsRoot: options.checkpointsRoot || null,
          launchBrowser: launchSharedBrowser,
          // Guard against a worker recursively spawning another worker.
          __insideWorker: true,
          // Forward every run event to the parent so its SSE stream and budget
          // are identical to the in-process path.
          onSessionEvent: (event) => {
            try {
              process.send({ type: "event", event });
            } catch (_error) {
              // Parent gone; the session still finishes and still writes its
              // artifacts, which is the part that matters.
            }
          },
        },
      );
      process.send({ type: "result", response: result.response });
    } catch (error) {
      process.send({
        type: "error",
        error: {
          code: error?.code || "session-worker-failed",
          message: error?.message || String(error),
          stack: error?.stack || null,
        },
      });
    } finally {
      // Exit explicitly: a lingering Chromium handle would otherwise keep the
      // child alive and turn "process isolation" into "process leak".
      setTimeout(() => process.exit(0), 50).unref?.();
    }
  });
}

void main();
