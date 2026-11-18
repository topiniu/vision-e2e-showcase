"use strict";


const path = require("node:path");
const { fork } = require("node:child_process");

const WORKER_ENTRY = path.join(__dirname, "session-worker-entry.js");

function isProcessIsolationEnabled(request = {}) {
  if (request && request.processIsolation === true) {
    return true;
  }
  if (request && request.processIsolation === false) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(String(process.env.ZHUZHU_SESSION_PROCESS_ISOLATION || "").trim());
}

/**
 * Execute one session in a child process.
 *
 * @param {object} params
 * @param {object} params.request   the session request body (as received)
 * @param {object} params.options   store/root paths (must be serializable)
 * @param {(event:object)=>void} params.onEvent  run events, forwarded live
 * @param {AbortSignal} params.signal  aborting KILLS the child
 */
function runSessionInWorker({ request, options, onEvent = null, signal = null, killGraceMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_ENTRY, [], {
      // `ipc` would be simpler, but stdout framing keeps the child usable
      // standalone (`node session-worker-entry.js < payload`) which makes it
      // debuggable without the parent.
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        // The child must not recursively isolate.
        ZHUZHU_SESSION_PROCESS_ISOLATION: "0",
      },
    });

    let settled = false;
    let killTimer = null;
    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      detachAbort();
      fn(value);
    };

    const onAbort = () => {
      // The point of this whole module: cancel is a kill, not a request.
      try {
        child.kill("SIGTERM");
      } catch (_error) {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_error) {
          // already gone
        }
      }, Math.max(500, killGraceMs));
      if (typeof killTimer.unref === "function") {
        killTimer.unref();
      }
    };
    const detachAbort = () => {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("message", (message) => {
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "event") {
        if (typeof onEvent === "function") {
          try {
            onEvent(message.event);
          } catch (_error) {
            // Progress delivery must never affect the session.
          }
        }
        return;
      }
      if (message.type === "result") {
        if (signal?.aborted) return;
        finish(resolve, { ok: true, response: message.response, isolated: true });
        return;
      }
      if (message.type === "error") {
        if (signal?.aborted) return;
        finish(resolve, { ok: false, error: message.error, isolated: true });
      }
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    child.on("error", (error) => {
      finish(reject, error);
    });

    child.on("exit", (code, signalName) => {
      // A killed child is a *successful cancel*, not an engine error. The parent
      // still owns finalizing the session document — the child may have died
      // before it could.
      finish(resolve, {
        ok: false,
        killed: Boolean(signalName) || signal?.aborted === true,
        exitCode: code,
        signal: signalName || null,
        isolated: true,
        error: signalName || signal?.aborted
          ? { code: "session-killed", message: `Session worker was killed (${signalName}).`, retriable: false }
          : {
              code: "session-worker-exited",
              message:
                `Session worker exited with code ${code} before returning a result.` +
                (stderr ? ` stderr: ${stderr.slice(-600)}` : ""),
              retriable: true,
            },
      });
    });

    child.send({ type: "run", request, options });
  });
}

module.exports = {
  WORKER_ENTRY,
  isProcessIsolationEnabled,
  runSessionInWorker,
};
