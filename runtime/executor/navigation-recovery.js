const { detectUiFrameworks } = require('./ui-frameworks');
const { capturePageSnapshot, capturePageState } = require('../perception/page-snapshot');
const { runExpectation } = require('../assertions');
const { withProbeTimeout } = require('./hard-timeout');

const frameworkCache = new WeakMap();

function isContextDestroyedError(error) {
  const message = error?.message || "";
  return message.includes("Execution context was destroyed");
}

// REQ-Z12: `page.evaluate` takes no timeout in Playwright. This probe is called
// in the navigation-observation loop, so an unbounded one parks the loop before
// it can re-check the step deadline — the mechanism behind the openUrl freeze.
async function readPageMeta(page) {
  return withProbeTimeout(
    () =>
      page.evaluate(() => ({
        url: location.href,
        title: document.title,
      })),
    { label: "readPageMeta(page.evaluate)" },
  );
}

function getActionTargetTexts(action = {}) {
  const target = action.target || {};
  return [
    action.query,
    target.name,
    target.text,
    target.query,
    target.placeholder,
    target.ariaLabel,
    target.title,
  ]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

function needsTargetReadiness(action = {}) {
  if (action.actionDefinition?.needsTarget === true) {
    return true;
  }
  return ["click", "hover", "fill", "check", "uncheck", "selectOption", "assertVisible", "comboSearchSelect", "cascaderSelect", "uploadFile"].includes(action.kind);
}

async function readPageReadiness(page, action = {}) {
  const targetTexts = getActionTargetTexts(action);
  return withProbeTimeout(() => page.evaluate(({ targetTexts: rawTargetTexts }) => {
    const normalize = (value) =>
      typeof value === "string"
        ? value
            .normalize("NFKC")
            .toLowerCase()
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/[\s_-]+/g, "")
        : "";
    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const semanticCandidates = Array.from(
      document.querySelectorAll(
        "button, a, input, textarea, select, [role='button'], [role='link'], [role='tab'], [role='combobox'], [role='option'], [role='menuitem'], [contenteditable='true']",
      ),
    );
    const seen = new Set(semanticCandidates);
    const pointerCandidates = Array.from(document.querySelectorAll("body div, body span, body li"))
      .filter((el) => {
        if (seen.has(el)) {
          return false;
        }
        const style = window.getComputedStyle(el);
        return (
          style?.cursor === "pointer" ||
          typeof el.onclick === "function" ||
          el.hasAttribute("onclick") ||
          el.hasAttribute("tabindex")
        );
      });
    const interactableCount = semanticCandidates
      .concat(pointerCandidates)
      .filter((el) => isVisible(el))
      .slice(0, 251)
      .length;
    const bodyText = document.body?.innerText || "";
    const normalizedBodyText = normalize(bodyText);
    const targetTextMatched = (rawTargetTexts || [])
      .map((item) => normalize(item))
      .filter(Boolean)
      .some((item) => normalizedBodyText.includes(item));
    return {
      url: location.href,
      title: document.title,
      textLength: bodyText.trim().length,
      interactableCount,
      targetTextMatched,
    };
  }, { targetTexts }), { label: "readPageReadiness(page.evaluate)" });
}

async function waitForConfiguredLoadState(page, waitUntil, timeoutMs) {
  if (waitUntil === "commit") {
    await page.waitForTimeout(50);
    return;
  }
  await page.waitForLoadState(waitUntil || "domcontentloaded", {
    timeout: timeoutMs,
  });
}

function isNavigationTargetMatched(meta, target) {
  if (!target) {
    return true;
  }
  if (target.urlIncludes && !String(meta?.url || "").includes(target.urlIncludes)) {
    return false;
  }
  if (target.pathEquals) {
    try {
      const current = new URL(meta?.url || "about:blank");
      if (current.pathname !== target.pathEquals) {
        return false;
      }
    } catch (_error) {
      return false;
    }
  }
  if (target.titleIncludes && !String(meta?.title || "").includes(target.titleIncludes)) {
    return false;
  }
  if (target.urlMatches) {
    try {
      const pattern = new RegExp(target.urlMatches);
      if (!pattern.test(meta?.url || "")) {
        return false;
      }
    } catch (_error) {
      return false;
    }
  }
  return true;
}

async function waitForRecoverableNavigation(page, recovery, remainingMs) {
  const timeoutMs = Math.max(50, Math.min(remainingMs, recovery.timeoutMs ?? 5000));
  await waitForConfiguredLoadState(
    page,
    recovery.waitUntil || "domcontentloaded",
    timeoutMs,
  ).catch(() => {});
  const delayMs = Math.max(50, recovery.stabilizationDelayMs ?? 100);
  if (delayMs > 0) {
    await page.waitForTimeout(Math.min(delayMs, Math.max(0, remainingMs))).catch(() => {});
  }
}

async function runWithNavigationRecovery(page, recovery = {}, operation) {
  const timeoutMs = recovery.timeoutMs ?? 5000;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await operation();
    } catch (error) {
      if (!recovery.expectNavigation || !isContextDestroyedError(error)) {
        throw error;
      }
      lastError = error;
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        break;
      }
      await waitForRecoverableNavigation(page, recovery, remainingMs);
    }
  }

  throw lastError;
}

async function safeCapturePageSnapshot(page, options = {}, recovery = {}) {
  return runWithNavigationRecovery(page, recovery, () => capturePageSnapshot(page, options));
}

async function safeCapturePageState(page, options = {}, recovery = {}) {
  return runWithNavigationRecovery(page, recovery, () => capturePageState(page, options));
}

async function safeRunExpectation(page, expectation, context = {}, recovery = {}) {
  return runWithNavigationRecovery(page, recovery, () => runExpectation(page, expectation, context));
}

function getFrameworkFallback() {
  return {
    antd: {
      detected: false,
      confidence: 0,
      versionHint: null,
      components: [],
      signals: {},
    },
  };
}

async function readFrameworkCacheKey(page) {
  if (!page) {
    return "no-page";
  }
  try {
    return `${page.url?.() || ""}`;
  } catch (_error) {
    return "unknown-url";
  }
}

function invalidateUiFrameworkCache(page) {
  if (page) {
    frameworkCache.delete(page);
  }
}

async function safeDetectUiFrameworks(page, recovery = {}, options = {}) {
  if (!page || typeof page !== "object") {
    return {
      ...getFrameworkFallback(),
      cache: {
        hit: false,
        key: "no-page",
        refreshedAt: Date.now(),
      },
    };
  }
  const cacheKey = await readFrameworkCacheKey(page);
  const cached = frameworkCache.get(page);
  if (!options.forceRefresh && cached?.key === cacheKey) {
    return {
      ...cached.value,
      cache: {
        hit: true,
        key: cacheKey,
        refreshedAt: cached.refreshedAt,
      },
    };
  }

  const value = await runWithNavigationRecovery(page, recovery, () => detectUiFrameworks(page)).catch(() => getFrameworkFallback());
  frameworkCache.set(page, {
    key: cacheKey,
    value,
    refreshedAt: Date.now(),
  });
  return {
    ...value,
    cache: {
      hit: false,
      key: cacheKey,
      refreshedAt: Date.now(),
    },
  };
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function shouldSettleBeforeAction(action = {}) {
  return ["click", "hover", "press", "fill", "check", "uncheck", "selectOption", "assertVisible", "assertUrl", "assertCount", "capture", "comboSearchSelect", "cascaderSelect", "uploadFile", "waitForText"].includes(action.kind);
}

async function settlePageAdaptively(page, action) {
  const maxMs = Math.max(0, toFiniteNumber(action.settleMaxMs, 800));
  let delayMs = Math.max(0, toFiniteNumber(action.settleInitialMs, 50));
  const startedAt = Date.now();
  let lastError = null;
  const requireTargetReadiness = needsTargetReadiness(action);

  while (Date.now() - startedAt <= maxMs) {
    try {
      if (!requireTargetReadiness) {
        await readPageMeta(page);
        return;
      }
      const readiness = await readPageReadiness(page, action);
      if (readiness.interactableCount > 0 || readiness.targetTextMatched) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= maxMs) {
      break;
    }
    const remainingMs = maxMs - elapsedMs;
    const waitMs = Math.min(delayMs || 0, remainingMs);
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs).catch(() => {});
    }
    delayMs = delayMs > 0 ? Math.min(delayMs * 2, Math.max(delayMs, remainingMs)) : 50;
  }

  if (lastError && action.settleFallbackToLoadState !== false) {
    await page
      .waitForLoadState("domcontentloaded", {
        timeout: Math.min(action.timeoutMs ?? 5_000, 1_000),
      })
      .catch(() => {});
  }
}

async function settlePageBeforeAction(page, action) {
  if (!page || !shouldSettleBeforeAction(action)) {
    return;
  }

  if (action.settleStrategy === "adaptive") {
    await settlePageAdaptively(page, action);
    return;
  }

  await page
    .waitForLoadState("domcontentloaded", {
      timeout: Math.min(action.timeoutMs ?? 5_000, 5_000),
    })
    .catch(() => {});

  await page
    .waitForLoadState("networkidle", {
      timeout: Math.min(action.timeoutMs ?? 1_500, 1_500),
    })
    .catch(() => {});

  await page.waitForTimeout(250).catch(() => {});
}

async function waitForPostAction(page, action) {
  if (action.waitForNav) {
    await page.waitForLoadState("domcontentloaded", {
      timeout: action.timeoutMs,
    });
  }
  if (action.waitForIdle) {
    await page.waitForLoadState("networkidle", {
      timeout: action.timeoutMs,
    });
  }
}

function shouldUseFastIgnoreObservation(action = {}) {
  return (
    action.settleStrategy === "adaptive" &&
    (action.navigationBehavior ?? "ignore") === "ignore" &&
    action.actionDefinition?.mutatesPage !== true &&
    !action.waitForNav &&
    !action.waitForIdle &&
    !action.waitForChange
  );
}

async function observeNavigationAfterAction(page, action, beforeSnapshot) {
  const behavior = action.navigationBehavior ?? "ignore";
  const timeoutMs = action.navigationTimeoutMs ?? action.timeoutMs;
  const waitUntil = action.waitUntil ?? "domcontentloaded";
  const navigation = {
    behavior,
    waitUntil,
    target: action.navigationTarget ?? null,
    observed: false,
    matchedTarget: false,
    finalUrl: beforeSnapshot?.url ?? null,
    finalTitle: beforeSnapshot?.title ?? null,
    durationMs: 0,
    error: null,
  };
  const startedAt = Date.now();

  if (behavior === "ignore") {
    if (shouldUseFastIgnoreObservation(action)) {
      try {
        const meta = await readPageMeta(page);
        navigation.finalUrl = meta.url;
        navigation.finalTitle = meta.title;
        navigation.matchedTarget = isNavigationTargetMatched(meta, action.navigationTarget);
      } catch (error) {
        if (!navigation.error) {
          navigation.error = error.message || "navigation-meta-unavailable";
        }
      }
      navigation.durationMs = Date.now() - startedAt;
      return navigation;
    }
    await waitForPostAction(page, action);
  } else {
    const pollIntervalMs = 100;
    let meta = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        meta = await readPageMeta(page);
        const hasTarget = Boolean(action.navigationTarget);
        const matchedTarget = isNavigationTargetMatched(meta, action.navigationTarget);
        const observed =
          meta.url !== beforeSnapshot?.url ||
          meta.title !== beforeSnapshot?.title ||
          (hasTarget && matchedTarget);

        if (observed) {
          await waitForConfiguredLoadState(
            page,
            waitUntil,
            Math.max(50, timeoutMs - (Date.now() - startedAt)),
          ).catch(() => {});
          meta = await readPageMeta(page);
          navigation.finalUrl = meta.url;
          navigation.finalTitle = meta.title;
          navigation.observed = true;
          navigation.matchedTarget = isNavigationTargetMatched(meta, action.navigationTarget);
          break;
        }
      } catch (error) {
        if (!isContextDestroyedError(error)) {
          navigation.error = error.message || "navigation-meta-unavailable";
          break;
        }
      }
      await page.waitForTimeout(pollIntervalMs).catch(() => {});
    }

    if (!navigation.observed) {
      try {
        meta = await readPageMeta(page);
        navigation.finalUrl = meta.url;
        navigation.finalTitle = meta.title;
        navigation.matchedTarget = isNavigationTargetMatched(meta, action.navigationTarget);
      } catch (error) {
        if (!navigation.error) {
          navigation.error = error.message || "navigation-meta-unavailable";
        }
      }
    }
  }

  if (action.stabilizationDelayMs > 0) {
    await page.waitForTimeout(action.stabilizationDelayMs).catch(() => {});
  }
  navigation.durationMs = Date.now() - startedAt;
  return navigation;
}

module.exports = {
  runWithNavigationRecovery,
  safeCapturePageState,
  safeCapturePageSnapshot,
  safeRunExpectation,
  safeDetectUiFrameworks,
  invalidateUiFrameworkCache,
  readPageReadiness,
  settlePageBeforeAction,
  observeNavigationAfterAction,
};
