"use strict";

const { withProbeTimeout } = require("./hard-timeout");

// v1.11 REQ-Z30: apply a requested viewport to a run and report what took effect.
//
// Two channels, two mechanisms:
//
//   * **Owned context** (headless, pooled headless, CLI): the viewport is a
//     `newContext` option — RunSession creates the context at the right size and
//     it dies with the run. Nothing to restore.
//   * **Injected page** (the visible App-run's resident Chrome): the page outlives
//     the run and is shared with the operator. It is usually a `viewport: null`
//     context (window-sized), and Playwright has no way to *un*-set an emulated
//     viewport once `page.setViewportSize` was called — its client keeps
//     reporting the stale size forever, which the visible adapter reads for
//     screenshot geometry. So for a window-sized page the override goes through
//     CDP (`Emulation.setDeviceMetricsOverride`) and is cleared again when the
//     run ends; Playwright's own bookkeeping is never touched. A page Playwright
//     already emulates is resized with `setViewportSize` and set back.
//
// The effective size is *measured* from the page (`innerWidth`/`innerHeight`),
// never echoed from the request: a run that asked for 1280 and rendered at 1440
// must fail loudly (`viewport-not-applied`), not pass at the wrong width.

async function measureViewport(page) {
  if (!page || typeof page.evaluate !== "function") {
    return null;
  }
  try {
    return await withProbeTimeout(() => page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    })), { label: "viewport.measure", timeoutMs: 1500, fallback: null });
  } catch (_error) {
    return null;
  }
}

async function openCdpSession(page) {
  const context = typeof page?.context === "function" ? page.context() : null;
  if (!context || typeof context.newCDPSession !== "function") {
    return null;
  }
  try {
    return await context.newCDPSession(page);
  } catch (_error) {
    return null;
  }
}

// Apply `viewport` to an injected page. Returns `{ mechanism, restore }`;
// `restore()` is idempotent and never throws.
async function applyInjectedViewport(page, viewport) {
  const emulated = typeof page?.viewportSize === "function" ? page.viewportSize() : null;
  if (emulated) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    let restored = false;
    return {
      mechanism: "playwright-viewport",
      restore: async () => {
        if (restored) {
          return;
        }
        restored = true;
        try {
          await page.setViewportSize(emulated);
        } catch (_error) {
          // the page may already be gone; nothing left to restore
        }
      },
    };
  }
  const cdp = await openCdpSession(page);
  if (!cdp) {
    const error = new Error(
      `Viewport ${viewport.width}x${viewport.height} was requested but this browser cannot emulate it ` +
        "(no CDP session on the injected page). Refusing to run at the window size instead.",
    );
    error.code = "viewport-unsupported";
    throw error;
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    // 0 = keep the window's own device scale factor (visual baselines are slotted by DPR).
    deviceScaleFactor: 0,
    mobile: false,
  });
  let restored = false;
  return {
    mechanism: "cdp-device-metrics",
    restore: async () => {
      if (restored) {
        return;
      }
      restored = true;
      try {
        await cdp.send("Emulation.clearDeviceMetricsOverride");
      } catch (_error) {
        // best effort — the page/target may have closed
      }
      try {
        await cdp.detach();
      } catch (_error) {
        // already detached
      }
    },
  };
}

// The runContext.viewport record. `matches` compares the MEASURED size with the
// request; only width/height are compared (DPR is the window's, by design).
function describeViewport({ requested = null, source = null, effective = null, mechanism = null } = {}) {
  const matches = requested && effective
    ? effective.width === requested.width && effective.height === requested.height
    : requested
      ? false
      : null;
  return {
    requested: requested ? { width: requested.width, height: requested.height } : null,
    source: requested ? source || "request" : "default",
    effective: effective
      ? { width: effective.width, height: effective.height, devicePixelRatio: effective.devicePixelRatio }
      : null,
    mechanism: mechanism || null,
    matches,
  };
}

module.exports = {
  applyInjectedViewport,
  describeViewport,
  measureViewport,
};
