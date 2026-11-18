"use strict";


function normalizeConcurrency(value, fallback = 1) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

// Run `items` through `runItem(item, index)` with at most `concurrency` in flight.
// Resolves to { results, stats } where results preserve input order and each entry
// is { ok, index, item, value?, error? }. A thrown/rejected item is captured as
// { ok:false, error } and never rejects the whole batch. `stats` reports the
// observed peak concurrency and per-item + total timing so callers can prove
// "parallel, not serial" (Z10-1).
async function runBatch({ items = [], concurrency = 1, runItem, now = () => Date.now() } = {}) {
  if (typeof runItem !== "function") {
    throw new Error("runBatch requires a runItem(item, index) function");
  }
  const list = Array.isArray(items) ? items : [];
  const limit = Math.min(normalizeConcurrency(concurrency), Math.max(1, list.length));
  const results = new Array(list.length);
  const startedAt = now();
  let nextIndex = 0;
  let active = 0;
  let peakConcurrency = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      if (index >= list.length) {
        return;
      }
      nextIndex += 1;
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      const itemStartedAt = now();
      try {
        const value = await runItem(list[index], index);
        results[index] = { ok: true, index, item: list[index], value, durationMs: now() - itemStartedAt };
      } catch (error) {
        results[index] = {
          ok: false,
          index,
          item: list[index],
          error: error && typeof error === "object"
            ? { code: error.code || "batch-item-failed", message: error.message || String(error) }
            : { code: "batch-item-failed", message: String(error) },
          durationMs: now() - itemStartedAt,
        };
      } finally {
        active -= 1;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    results,
    stats: {
      total: list.length,
      concurrency: limit,
      peakConcurrency,
      okCount: results.filter((item) => item && item.ok).length,
      errorCount: results.filter((item) => item && !item.ok).length,
      wallDurationMs: now() - startedAt,
    },
  };
}

module.exports = {
  normalizeConcurrency,
  runBatch,
};
