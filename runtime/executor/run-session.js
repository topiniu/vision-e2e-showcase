const fs = require("node:fs");
const { chromium } = require("playwright");
const { mergeAuthOnly, resolveWritebackMode } = require("./storage-writeback");

class RunSession {
  constructor({
    headless = true,
    storageStatePath = null,
    viewport = { width: 1440, height: 900 },
    ignoreHTTPSErrors = false,
    // Z09: browser launch/context options so a headless run can be given the
    // *same* network + security context the visible App-run panel uses (proxy,
    // TLS, CORS/CSP, host resolution). Without this a headless run against a
    // qiankun front-end fails `loadMicroApp` with `Failed to fetch` while the
    // panel — same machine, same network — loads the micro-app fine. Injected as
    // plain objects so the runtime stays framework-agnostic; the Electron main
    // process derives them from panel preferences (see buildHeadlessBrowserContext).
    launchOptions = null,
    contextOptions = null,
    page = null,
    context = null,
    browser = null,
  } = {}) {
    this.headless = headless;
    this.storageStatePath = storageStatePath;
    this.viewport = viewport;
    this.ignoreHTTPSErrors = ignoreHTTPSErrors;
    this.launchOptions = launchOptions && typeof launchOptions === "object" ? launchOptions : null;
    this.contextOptions = contextOptions && typeof contextOptions === "object" ? contextOptions : null;
    this.browser = browser;
    this.context = context;
    this.page = page;
    // Three ownership modes (v1.2.1 browser-pool efficiency):
    //  - injected page   (visible App-run): own neither — start/close are no-ops.
    //  - injected browser (pooled headless): own the context+page only — create a
    //    fresh isolated context per case but reuse the expensive browser process
    //    across all cases in a session, so `chromium.launch` is paid once, not N+2.
    //  - nothing injected (standalone/CLI): own browser+context+page.
    this.ownsBrowser = !page && !browser;
    this.ownsContext = !page;
  }

  async start() {
    if (this.page) {
      return this;
    }
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.headless,
        ...(this.launchOptions || {}),
      });
      this.ownsBrowser = true;
    }
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: this.ignoreHTTPSErrors,
      viewport: this.viewport,
      ...(this.contextOptions || {}),
      ...(this.storageStatePath && fs.existsSync(this.storageStatePath)
        ? { storageState: this.storageStatePath }
        : {}),
    });
    this.page = await this.context.newPage();
    return this;
  }

  async navigate(url) {
    if (!url) {
      return null;
    }
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    return this.page.url();
  }

  // Z11: capture the live browser state (cookies + localStorage) for a
  // checkpoint. Works whether the session owns the browser (headless) or was
  // handed an external page (visible panel) — resolve the context either way.
  async captureStorageState() {
    const context = this.context || (this.page && typeof this.page.context === "function" ? this.page.context() : null);
    if (!context || typeof context.storageState !== "function") {
      return null;
    }
    return context.storageState();
  }

  // 2026-10-27: write back only the auth state by default — a run may renew its
  // token but must not move the shared profile baseline (see storage-writeback.js).
  async saveStorageState() {
    if (!this.ownsContext || !this.storageStatePath || !this.context) {
      return null;
    }
    const mode = resolveWritebackMode();
    if (mode === "off") {
      return null;
    }
    if (mode === "full") {
      await this.context.storageState({ path: this.storageStatePath });
      return this.storageStatePath;
    }
    const live = await this.context.storageState();
    let baseline = null;
    try {
      baseline = JSON.parse(fs.readFileSync(this.storageStatePath, "utf8"));
    } catch (_error) {
      baseline = null;
    }
    const merged = mergeAuthOnly(baseline, live);
    const tmpPath = `${this.storageStatePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}
`, "utf8");
    fs.renameSync(tmpPath, this.storageStatePath);
    return this.storageStatePath;
  }

  async close() {
    // Close only what we own. In pooled mode (injected browser) we close the
    // per-case context but leave the shared browser process alive for the next
    // case; the pool owner closes the browser once the whole session is done.
    if (this.ownsContext && this.context) {
      try {
        await this.saveStorageState();
      } finally {
        await this.context.close();
      }
    }
    if (this.ownsBrowser && this.browser) {
      await this.browser.close();
    }
  }
}

// Launch a shared browser process that a whole test session reuses across its
// root-setup / cases / teardown. Each of those still gets an isolated context
// (via RunSession with this browser injected), so we keep per-case isolation
// while paying the expensive `chromium.launch` exactly once instead of N+2 times.
async function launchSharedBrowser({ headless = true, launchOptions = null } = {}) {
  return chromium.launch({
    headless,
    ...(launchOptions && typeof launchOptions === "object" ? launchOptions : {}),
  });
}

module.exports = {
  RunSession,
  launchSharedBrowser,
};
