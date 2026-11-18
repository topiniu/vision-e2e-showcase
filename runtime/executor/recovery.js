
function evaluateDetect(detect, ctx = {}) {
  if (!detect || typeof detect !== "object" || Array.isArray(detect)) {
    return false;
  }
  if (detect.not && typeof detect.not === "object") {
    return !evaluateDetect(detect.not, ctx);
  }
  const url = String(ctx.url || "");
  if (typeof detect.urlIncludes === "string" && detect.urlIncludes) {
    if (url.includes(detect.urlIncludes)) {
      return true;
    }
  }
  if (Array.isArray(detect.urlIncludesAny)) {
    if (detect.urlIncludesAny.some((s) => typeof s === "string" && s && url.includes(s))) {
      return true;
    }
  }
  if (typeof detect.urlMatches === "string" && detect.urlMatches) {
    try {
      if (new RegExp(detect.urlMatches).test(url)) {
        return true;
      }
    } catch (_error) {
      // invalid regex -> treated as no-match
    }
  }
  if (typeof detect.textExists === "string" && detect.textExists && typeof ctx.hasText === "function") {
    if (ctx.hasText(detect.textExists)) {
      return true;
    }
  }
  return false;
}

// Which recovery handlers currently fire, in declaration order. Handlers with no
// `detect` never fire proactively (they can only be triggered explicitly).
function selectFiredRecoveries(recoveryMap, ctx = {}) {
  const source = recoveryMap && typeof recoveryMap === "object" && !Array.isArray(recoveryMap) ? recoveryMap : {};
  const fired = [];
  for (const [key, handler] of Object.entries(source)) {
    if (!handler || typeof handler !== "object") {
      continue;
    }
    if (handler.detect && evaluateDetect(handler.detect, ctx)) {
      fired.push({ key, handler });
    }
  }
  return fired;
}

// True when the file has at least one recovery handler with a detect condition.
function hasDetectableRecovery(recoveryMap) {
  const source = recoveryMap && typeof recoveryMap === "object" && !Array.isArray(recoveryMap) ? recoveryMap : {};
  return Object.values(source).some((handler) => handler && typeof handler === "object" && handler.detect);
}

// Reactive selection after a step failed: re-evaluate detects (a mid-run session
// loss typically redirects to /login, which the same detect catches), limited to
// handlers marked `reactive` (default true). Returns fired handlers in order.
function selectReactiveRecoveries(recoveryMap, ctx = {}) {
  return selectFiredRecoveries(recoveryMap, ctx).filter(({ handler }) => handler.reactive !== false);
}

module.exports = {
  evaluateDetect,
  selectFiredRecoveries,
  selectReactiveRecoveries,
  hasDetectableRecovery,
};
