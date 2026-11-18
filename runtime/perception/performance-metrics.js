"use strict";


const { withProbeTimeout } = require("../executor/hard-timeout");

// The browser-side collector. Installed once per page; it accumulates long tasks
// and layout shifts from the moment it is installed, because a long task that
// happened before anybody was watching is unmeasurable after the fact.
const INSTALL_SCRIPT = `(() => {
  if (window.__zhuzhuPerf) { return "already"; }
  const state = {
    longTasks: [],
    layoutShift: 0,
    lcp: null,
    interactions: [],
    installedAt: performance.now(),
  };
  window.__zhuzhuPerf = state;
  const observe = (type, handler, extra) => {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) { handler(entry); }
      });
      observer.observe({ type, buffered: true, ...(extra || {}) });
      return observer;
    } catch (_error) {
      // Not every entry type exists in every Chromium build; a missing observer
      // must degrade to "this metric is unavailable", never to a thrown error
      // that kills the page's own scripts.
      return null;
    }
  };
  observe("longtask", (entry) => {
    if (state.longTasks.length < 500) {
      state.longTasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
    }
  });
  observe("largest-contentful-paint", (entry) => { state.lcp = entry.startTime; });
  observe("layout-shift", (entry) => { if (!entry.hadRecentInput) { state.layoutShift += entry.value; } });
  observe("event", (entry) => {
    if (entry.duration >= 16 && state.interactions.length < 300) {
      state.interactions.push({ name: entry.name, duration: entry.duration, start: entry.startTime });
    }
  }, { durationThreshold: 16 });
  return "installed";
})()`;

// Read-and-reset. Reset semantics matter: `assertPerf` almost always means "the
// interaction I just performed", so metrics have to be attributable to a window
// rather than to the whole page lifetime.
const READ_SCRIPT = `(() => {
  const state = window.__zhuzhuPerf;
  const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  const paints = {};
  try {
    for (const entry of performance.getEntriesByType("paint")) { paints[entry.name] = entry.startTime; }
  } catch (_error) { /* ignore */ }
  const countDepth = (root) => {
    let max = 0;
    const walk = (node, depth) => {
      if (depth > max) { max = depth; }
      const children = node.children || [];
      for (let i = 0; i < children.length; i += 1) { walk(children[i], depth + 1); }
    };
    try { walk(root, 0); } catch (_error) { /* ignore */ }
    return max;
  };
  const longTasks = state ? state.longTasks.slice() : [];
  const interactions = state ? state.interactions.slice() : [];
  const result = {
    available: Boolean(state),
    domNodes: document.getElementsByTagName("*").length,
    domDepth: countDepth(document.documentElement),
    longTaskCount: longTasks.length,
    longTaskTotalMs: Math.round(longTasks.reduce((sum, item) => sum + item.duration, 0)),
    longTaskMaxMs: Math.round(longTasks.reduce((max, item) => Math.max(max, item.duration), 0)),
    layoutShift: state ? Number(state.layoutShift.toFixed(4)) : null,
    lcpMs: state && state.lcp != null ? Math.round(state.lcp) : null,
    interactionCount: interactions.length,
    interactionMaxMs: Math.round(interactions.reduce((max, item) => Math.max(max, item.duration), 0)),
    firstPaintMs: paints["first-paint"] != null ? Math.round(paints["first-paint"]) : null,
    firstContentfulPaintMs: paints["first-contentful-paint"] != null ? Math.round(paints["first-contentful-paint"]) : null,
    navigationMs: nav ? Math.round(nav.duration) : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadEventMs: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
    transferredBytes: nav && nav.transferSize ? nav.transferSize : null,
    resourceCount: (() => { try { return performance.getEntriesByType("resource").length; } catch (_error) { return null; } })(),
  };
  if (state) { state.longTasks = []; state.interactions = []; state.layoutShift = 0; }
  return result;
})()`;

const METRIC_ALIASES = {
  longTaskTotal: "longTaskTotalMs",
  longTasks: "longTaskCount",
  domNodeCount: "domNodes",
  nodes: "domNodes",
  depth: "domDepth",
  interactionLatencyMs: "interactionMaxMs",
  lcp: "lcpMs",
  cls: "layoutShift",
  navigation: "navigationMs",
  fcp: "firstContentfulPaintMs",
};

function resolveMetricName(name) {
  const text = String(name || "").trim();
  return METRIC_ALIASES[text] || text;
}

class PerformanceCollector {
  constructor({ page = null, runId = null } = {}) {
    this.page = page;
    this.runId = runId;
    this.installed = false;
    this.samples = [];
    this.lastError = null;
  }

  async install() {
    if (this.installed || !this.page || typeof this.page.evaluate !== "function") {
      return this.installed;
    }
    try {
      // `addInitScript` would also catch pre-navigation tasks, but it only applies
      // to *future* navigations; installing directly covers the page we already
      // have. Both are attempted, so a later navigation keeps the observers.
      if (typeof this.page.addInitScript === "function") {
        await this.page.addInitScript(`(() => { ${INSTALL_SCRIPT} })()`);
      }
      await withProbeTimeout(() => this.page.evaluate(INSTALL_SCRIPT), { label: "performance:install" });
      this.installed = true;
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.installed = false;
    }
    return this.installed;
  }

  // Advisory by construction: a failed sample records the reason and returns
  // null. Performance telemetry must never be the thing that fails a run.
  async sample({ stepId = null, stepIndex = null, label = null } = {}) {
    if (!this.page || typeof this.page.evaluate !== "function") {
      return null;
    }
    if (!this.installed) {
      await this.install();
    }
    try {
      const metrics = await withProbeTimeout(() => this.page.evaluate(READ_SCRIPT), { label: "performance:read" });
      const sample = { at: Date.now(), stepId, stepIndex, label, ...metrics };
      this.samples.push(sample);
      return sample;
    } catch (error) {
      this.lastError = error?.message || String(error);
      return null;
    }
  }

  getLatest() {
    return this.samples.at(-1) || null;
  }

  // Per-metric spread across the run's samples. Facet G-2: a report must show the
  // jitter band, so nobody treats one sample as a conclusion.
  getReport() {
    if (!this.samples.length) {
      return this.lastError ? { samples: 0, unavailable: this.lastError } : null;
    }
    const numericKeys = [
      "domNodes",
      "domDepth",
      "longTaskCount",
      "longTaskTotalMs",
      "longTaskMaxMs",
      "interactionMaxMs",
      "lcpMs",
      "layoutShift",
      "navigationMs",
      "firstContentfulPaintMs",
      "resourceCount",
    ];
    const spread = {};
    for (const key of numericKeys) {
      const values = this.samples.map((item) => item[key]).filter((value) => Number.isFinite(value));
      if (!values.length) {
        continue;
      }
      spread[key] = {
        min: Math.min(...values),
        max: Math.max(...values),
        last: values.at(-1),
        samples: values.length,
      };
    }
    // "Where did it get stuck" — the slowest step by long-task time, which is the
    // question a person actually asks (facet G-3).
    const slowest = this.samples
      .filter((item) => Number.isFinite(item.longTaskTotalMs))
      .reduce((worst, item) => (!worst || item.longTaskTotalMs > worst.longTaskTotalMs ? item : worst), null);
    return {
      samples: this.samples.length,
      spread,
      timeline: this.samples.map((item) => ({
        stepId: item.stepId,
        stepIndex: item.stepIndex,
        longTaskTotalMs: item.longTaskTotalMs,
        longTaskMaxMs: item.longTaskMaxMs,
        interactionMaxMs: item.interactionMaxMs,
        domNodes: item.domNodes,
      })),
      slowestStep: slowest ? { stepId: slowest.stepId, stepIndex: slowest.stepIndex, longTaskTotalMs: slowest.longTaskTotalMs } : null,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}

function createPerformanceCollector(options = {}) {
  return new PerformanceCollector(options);
}

// The `assertPerf` evaluator.
//
// Fails closed when the metric could not be read: an unverifiable performance
// claim reported as a pass is exactly the "机验绿灯 ≠ 真的不卡" problem restated.
async function evaluatePerfAssertion(spec = {}, context = {}) {
  const collector = context.performance || null;
  const metric = resolveMetricName(spec.metric);
  if (!metric) {
    return {
      ok: false,
      type: "assertPerf",
      error: "assertPerf:no-metric",
      detail: 'assertPerf requires `metric`, e.g. {"metric":"longTaskTotalMs","atMost":300}',
    };
  }
  if (!collector) {
    return {
      ok: false,
      type: "assertPerf",
      error: "performance-collector-unavailable",
      detail:
        "This run has no performance collector attached, so the metric could not be measured. " +
        "Reported as a failure rather than a pass so it cannot become an unverifiable green.",
      metric,
    };
  }
  const sample = await collector.sample({ label: `assertPerf:${metric}` });
  if (!sample || !Number.isFinite(sample[metric])) {
    return {
      ok: false,
      type: "assertPerf",
      error: "performance-metric-unavailable",
      detail:
        `Metric "${metric}" could not be read from this page` +
        (collector.lastError ? ` (${collector.lastError})` : "") +
        ". Available metrics: " +
        Object.keys(sample || {})
          .filter((key) => Number.isFinite(sample?.[key]))
          .join(", "),
      metric,
    };
  }
  const actual = sample[metric];
  const checks = [];
  if (spec.atMost != null) {
    checks.push({ ok: actual <= Number(spec.atMost), reason: "atMost", expected: Number(spec.atMost), actual });
  }
  if (spec.atLeast != null) {
    checks.push({ ok: actual >= Number(spec.atLeast), reason: "atLeast", expected: Number(spec.atLeast), actual });
  }
  if (spec.equals != null) {
    checks.push({ ok: actual === Number(spec.equals), reason: "equals", expected: Number(spec.equals), actual });
  }
  // Regression form: compare against a baseline captured earlier in this run (a
  // runtime variable), with a tolerance. This is the form the口径纪律 endorses —
  // same machine, same data, same session.
  if (spec.baseline) {
    const baselineRaw = context.runtimeVariables?.[String(spec.baseline)];
    const baseline = Number(baselineRaw);
    if (!Number.isFinite(baseline)) {
      checks.push({
        ok: false,
        reason: "baseline:missing",
        expected: `runtime variable ${spec.baseline}`,
        actual: baselineRaw ?? null,
        detail: "the declared baseline variable holds no number, so no regression comparison was possible",
      });
    } else {
      const toleranceRatio = Number.isFinite(Number(spec.toleranceRatio)) ? Number(spec.toleranceRatio) : 0.5;
      const limit = baseline * (1 + toleranceRatio);
      checks.push({
        ok: actual <= limit,
        reason: "baseline",
        expected: `<= ${Math.round(limit)} (baseline ${baseline} +${Math.round(toleranceRatio * 100)}%)`,
        actual,
      });
    }
  }
  if (!checks.length) {
    return {
      ok: false,
      type: "assertPerf",
      metric,
      actual,
      error: "assertPerf:no-bound",
      detail: "assertPerf declared no atMost/atLeast/equals/baseline, so it proves nothing (fail-closed).",
      sample,
    };
  }
  if (spec.saveAs && typeof context.setRuntimeVariable === "function") {
    context.setRuntimeVariable(String(spec.saveAs), actual, "performance");
  }
  const failures = checks.filter((check) => !check.ok);
  return {
    ok: failures.length === 0,
    type: "assertPerf",
    metric,
    actual,
    checks,
    // The whole sample travels with the result: "longTaskTotalMs exceeded" is
    // much more actionable next to "domNodes was 8400".
    sample,
    ...(failures.length
      ? {
          error: `assertPerf:${metric}:${failures[0].reason}`,
          expected: failures[0].expected,
          failures,
          detail:
            "Performance assertions are regression判据 only: compare against a baseline captured in the SAME " +
            "environment with the SAME data volume before treating this as a product defect.",
        }
      : {}),
  };
}

module.exports = {
  INSTALL_SCRIPT,
  METRIC_ALIASES,
  PerformanceCollector,
  READ_SCRIPT,
  createPerformanceCollector,
  evaluatePerfAssertion,
  resolveMetricName,
};
