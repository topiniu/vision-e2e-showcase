
function createAbortError() {
  const error = new Error("Run stopped by user.");
  error.name = "AbortError";
  error.code = "runtime-aborted";
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function waitForAbort(signal) {
  if (!signal) {
    return new Promise(() => {});
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function raceAbort(promise, signal) {
  if (!signal) {
    return promise;
  }
  const operation = Promise.resolve(promise);
  operation.catch(() => {});
  return Promise.race([operation, waitForAbort(signal)]);
}

module.exports = {
  createAbortError,
  assertNotAborted,
  raceAbort,
};
