"use strict";


const { ABORT_ERROR_CODES, ROUTE_FAULT_MODES, parseRouteFaultSpec } = require("../../src/shared/route-fault");

const MAX_RECORDED_HITS = 20;

function describePattern(spec) {
  return spec.urlIncludes ? `url includes "${spec.urlIncludes}"` : `url matches /${spec.urlMatches}/`;
}

class RouteFaultRegistry {
  constructor({ page } = {}) {
    this.page = page;
    this.faults = [];
    this.disposed = false;
    this.pendingDelays = new Set();
  }

  // Install one fault for the action. Returns a step-shaped result.
  async install(action) {
    const startedAt = Date.now();
    const { spec, errors } = parseRouteFaultSpec(action.raw || {});
    if (!spec) {
      return failedResult(action, "invalid-route-fault", errors.join("; "), startedAt);
    }
    if (!this.page || typeof this.page.route !== "function") {
      return failedResult(action, "route-fault-unsupported", "This page cannot intercept requests (no page.route).", startedAt);
    }
    const fault = {
      stepId: action.id || null,
      stepIndex: action.index ?? null,
      name: spec.name,
      pattern: describePattern(spec),
      method: spec.method,
      mode: spec.mode,
      ...(spec.mode === "abort" ? { errorCode: spec.errorCode } : {}),
      ...(spec.mode === "respond" ? { status: spec.status } : {}),
      ...(spec.delayMs ? { delayMs: spec.delayMs } : {}),
      times: spec.times,
      minHits: spec.minHits,
      hits: 0,
      passedThrough: 0,
      hitUrls: [],
      errors: [],
      installedAt: startedAt,
      removedAt: null,
    };
    const matches = (url) => {
      const text = String(url);
      return spec.urlIncludes ? text.includes(spec.urlIncludes) : spec.regex.test(text);
    };
    const handler = async (route, request) => {
      if (this.disposed) return route.fallback();
      if (spec.method && request.method() !== spec.method) {
        fault.passedThrough += 1;
        return route.fallback();
      }
      if (spec.times != null && fault.hits >= spec.times) {
        fault.passedThrough += 1;
        return route.fallback();
      }
      fault.hits += 1;
      if (fault.hitUrls.length < MAX_RECORDED_HITS) {
        fault.hitUrls.push({ url: request.url(), method: request.method(), at: Date.now() });
      }
      try {
        if (spec.delayMs) {
          const elapsed = await new Promise((resolve) => {
            const finish = (value) => {
              clearTimeout(timer);
              this.pendingDelays.delete(cancel);
              resolve(value);
            };
            const cancel = () => finish(false);
            const timer = setTimeout(() => finish(true), spec.delayMs);
            this.pendingDelays.add(cancel);
          });
          if (!elapsed) {
            fault.errors.push("Run ended before the injected delay completed.");
            return await route.fallback();
          }
        }
        if (spec.mode === "abort") {
          return await route.abort(spec.errorCode);
        }
        if (spec.mode === "respond") {
          return await route.fulfill({
            status: spec.status,
            headers: spec.headers,
            contentType: spec.contentType,
            body: spec.body,
          });
        }
        return await route.fallback();
      } catch (error) {
        // A matched request is not proof that interception actually succeeded.
        if (fault.errors.length < MAX_RECORDED_HITS) fault.errors.push(String(error.message || error));
        return undefined;
      }
    };
    const predicate = (url) => matches(typeof url === "string" ? url : url.href);
    await this.page.route(predicate, handler);
    this.faults.push({ fault, predicate, handler });
    return {
      ok: true,
      type: "routeFault",
      data: {
        action: {
          success: true,
          error: null,
          detail: `route-fault-installed: ${spec.mode} ${fault.pattern}`,
          navigation: null,
          inputArtifacts: null,
          popupTrace: null,
          apiRequest: null,
          apiResponse: null,
        },
        routeFault: { ...fault, hitUrls: [] },
        resolution: null,
        snapshot: null,
        expectation: null,
        retry: { attempts: 1, retries: 0 },
        trace: { durationMs: Date.now() - startedAt },
      },
      error: null,
      telemetry: { durationMs: Date.now() - startedAt },
      evidence: null,
    };
  }

  // Remove every route this run installed. Idempotent; never throws.
  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cancel of [...this.pendingDelays]) cancel();
    // Let cancelled handlers record their outcome before building the report.
    await Promise.resolve();
    for (const entry of this.faults) {
      entry.fault.removedAt = Date.now();
      try {
        await this.page.unroute(entry.predicate, entry.handler);
      } catch (_error) {
        // page already closed — the route went with it
      }
    }
  }

  getReport() {
    return this.faults.map((entry) => ({ ...entry.fault, hitUrls: [...entry.fault.hitUrls] }));
  }

  // Faults that fired fewer times than they promised to.
  getUnmet() {
    return this.getReport().filter((fault) => fault.hits < fault.minHits || fault.errors.length);
  }

  // True when `url` is a request one of this run's faults actually intercepted
  // (page-diagnostics uses it to recognise the browser's load-failure line).
  matchesFaultedUrl(url) {
    const text = String(url || "");
    return this.faults.some((entry) => entry.fault.hitUrls.some((hit) => hit.url === text) || (entry.fault.hits > 0 && entry.predicate(text)));
  }

  hasFaults() {
    return this.faults.length > 0;
  }
}

function failedResult(action, code, message, startedAt) {
  return {
    ok: false,
    type: "routeFault",
    data: {
      action: { success: false, error: message, detail: code },
      resolution: null,
      snapshot: null,
      expectation: null,
      retry: { attempts: 1, retries: 0 },
      trace: { durationMs: Date.now() - startedAt },
    },
    error: { code, message, retryable: false, details: null },
    telemetry: { durationMs: Date.now() - startedAt },
    evidence: null,
  };
}

// The synthetic end-of-run check for one unmet fault. Its own entry (not a
// rewrite of the install step), because chronologically the check happens when
// the case is over — the install itself did succeed.
function buildUnmetResult(fault) {
  const code = fault.errors?.length ? "route-fault-apply-failed" : "route-fault-not-hit";
  const message = fault.errors?.length ? `routeFault could not apply the requested fault: ${fault.errors.join("; ")}` :
    `routeFault ${fault.name ? `"${fault.name}" ` : ""}(${fault.mode} ${fault.pattern}` +
    `${fault.method ? ` ${fault.method}` : ""}) intercepted ${fault.hits} request(s), expected at least ${fault.minHits}. ` +
    "The faulted request never happened (or the pattern does not match it), so whatever this case asserted " +
    "about the failure path was observed on the normal path.";
  return {
    ok: false,
    type: "routeFault",
    routeFaultCheck: true,
    data: {
      action: { success: false, error: message, detail: "route-fault-hit-check" },
      routeFault: fault,
      resolution: null,
      snapshot: null,
      expectation: null,
      retry: { attempts: 1, retries: 0 },
      trace: { durationMs: 0 },
    },
    error: { code, message, retryable: false, details: { stepId: fault.stepId, hits: fault.hits, minHits: fault.minHits, pattern: fault.pattern } },
    telemetry: { durationMs: 0 },
    evidence: null,
  };
}

module.exports = {
  ABORT_ERROR_CODES,
  ROUTE_FAULT_MODES,
  RouteFaultRegistry,
  buildUnmetResult,
  parseRouteFaultSpec,
};
