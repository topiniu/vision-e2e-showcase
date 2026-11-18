const { EventEmitter } = require("events");
const { BrowserView, screen } = require("electron");
const { chromium } = require("playwright");
const { releaseConsoleMessageArgs } = require("../../runtime/perception/console-message-args");

const DEFAULT_PLAYWRIGHT_VIEWPORT = { width: 1280, height: 720 };
const WINDOW_PLACEMENT_INSET = 8;
// How long after a page `close` a browser `disconnected` still counts as "the
// user closed the window" rather than "something killed Chromium".
const USER_CLOSE_GRACE_MS = 3_000;

const clampPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

const normalizeViewport = (viewport) => {
  if (viewport === null) {
    return null;
  }
  return {
    width: clampPositiveInt(viewport?.width, DEFAULT_PLAYWRIGHT_VIEWPORT.width),
    height: clampPositiveInt(
      viewport?.height,
      DEFAULT_PLAYWRIGHT_VIEWPORT.height
    ),
  };
};

const normalizeRect = (rect) => {
  if (!rect || typeof rect !== "object") {
    return null;
  }
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
};

const getTargetWorkArea = (windowPlacement) =>
  normalizeRect(
    windowPlacement?.targetDisplay?.workArea ||
      windowPlacement?.targetDisplay?.bounds ||
      windowPlacement?.workArea ||
      null,
  );

const getTargetWindowBounds = (windowPlacement, { fill = true } = {}) => {
  const workArea = getTargetWorkArea(windowPlacement);
  if (!workArea) {
    return null;
  }
  const inset = Math.min(
    WINDOW_PLACEMENT_INSET,
    Math.floor(workArea.width / 8),
    Math.floor(workArea.height / 8),
  );
  const availableWidth = Math.max(320, workArea.width - inset * 2);
  const availableHeight = Math.max(240, workArea.height - inset * 2);
  const width = fill ? availableWidth : Math.min(1280, availableWidth);
  const height = fill ? availableHeight : Math.min(820, availableHeight);
  return {
    left: workArea.x + inset + Math.max(0, Math.floor((availableWidth - width) / 2)),
    top: workArea.y + inset + Math.max(0, Math.floor((availableHeight - height) / 2)),
    width,
    height,
  };
};

const getWindowPlacementLaunchArgs = (windowPlacement) => {
  const bounds = getTargetWindowBounds(windowPlacement, {
    fill: windowPlacement?.maximizeOnLaunch !== false,
  });
  if (!bounds) {
    return [];
  }
  return [
    `--window-position=${bounds.left},${bounds.top}`,
    `--window-size=${bounds.width},${bounds.height}`,
  ];
};

// v1.9 perf: read the dimensions out of the PNG header instead of decoding the
// image. `PNG.sync.read` materialises a full RGBA buffer — 8.3MB for a 1080p
// screenshot, 14.7MB at 1440p — and every caller here only ever wanted two
// integers. The IHDR chunk is at a fixed offset right after the 8-byte
// signature, so width/height are a pair of 32-bit reads.
//
// `bitmap` stays in the shape (it is part of the returned contract) but is now
// null: nothing in the app consumed it, and a consumer that genuinely needs
// pixels should decode the buffer itself rather than have every screenshot pay
// for it. See `parseImageSizeFromBuffer` callers before changing this back.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const parseImageSizeFromBuffer = (buffer) => {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return null;
    }
    // Bytes 8..15 are the IHDR chunk length + type; width/height follow.
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) {
      return null;
    }
    return { width, height, bitmap: null };
  } catch (_error) {
    return null;
  }
};

class BrowserAdapter extends EventEmitter {
  constructor({ mode }) {
    super();
    this.mode = mode;
  }

  isAvailable() {
    return false;
  }

  getDebugState() {
    return {};
  }
}

class EmbeddedDebugBrowserAdapter extends BrowserAdapter {
  constructor({
    mainWindow,
    preloadPath = null,
    installSessionDebugging,
  }) {
    super({ mode: "embedded-debug" });
    this.mainWindow = mainWindow;
    this.preloadPath = preloadPath;
    this.installSessionDebugging = installSessionDebugging;
    this.browserView = null;
    this.isInitialised = false;
  }

  async init() {
    if (this.isInitialised) {
      return this;
    }
    this.browserView = new BrowserView({
      webPreferences: {
        preload: this.preloadPath || undefined,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (typeof this.installSessionDebugging === "function") {
      this.installSessionDebugging(this.browserView.webContents.session);
    }
    this.attachWebContentsEvents();
    this.isInitialised = true;
    return this;
  }

  get view() {
    if (!this.browserView || this.browserView.webContents.isDestroyed()) {
      return null;
    }
    return this.browserView;
  }

  get webContents() {
    return this.view?.webContents || null;
  }

  isAvailable() {
    return Boolean(this.webContents && !this.webContents.isDestroyed());
  }

  attachToWindow(bounds) {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.view) {
      return;
    }
    this.mainWindow.addBrowserView(this.browserView);
    if (bounds) {
      this.browserView.setBounds(bounds);
    }
  }

  detachFromWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.view) {
      return;
    }
    try {
      this.mainWindow.removeBrowserView(this.browserView);
    } catch (_error) {
      // ignore detach failures during teardown
    }
  }

  setBounds(bounds) {
    this.view?.setBounds(bounds);
  }

  getBounds() {
    return this.view?.getBounds() || null;
  }

  getViewportSize() {
    const bounds = this.getBounds();
    return bounds
      ? { width: bounds.width, height: bounds.height }
      : { ...DEFAULT_PLAYWRIGHT_VIEWPORT };
  }

  attachWebContentsEvents() {
    const wc = this.webContents;
    if (!wc) {
      return;
    }
    wc.on("did-start-navigation", (event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      this.emit("did-start-navigation", { url, isInPlace });
    });
    wc.on("did-redirect-navigation", (event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      this.emit("did-redirect-navigation", { url, isInPlace });
    });
    wc.on("did-navigate", (_event, url) => {
      this.emit("did-navigate", { url });
    });
    wc.on("did-navigate-in-page", (_event, url) => {
      this.emit("did-navigate-in-page", { url });
    });
    wc.on("did-start-loading", () => {
      this.emit("did-start-loading", { url: this.getURL() });
    });
    wc.on("load-progress", (_event, progress) => {
      this.emit("load-progress", { progress });
    });
    wc.on("did-stop-loading", () => {
      this.emit("did-stop-loading", { url: this.getURL() });
    });
    wc.on("did-finish-load", () => {
      this.emit("did-finish-load", {
        url: this.getURL(),
        title: this.getTitle(),
      });
    });
    wc.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        this.emit("did-fail-load", {
          errorCode,
          errorDescription,
          validatedUrl,
          isMainFrame,
        });
      }
    );
    wc.on("page-title-updated", () => {
      this.emit("page-title-updated", { title: this.getTitle() });
    });
    wc.on("page-favicon-updated", (_event, favicons) => {
      this.emit("page-favicon-updated", { favicons });
    });
    wc.on("console-message", (_event, level, message, line, sourceId) => {
      this.emit("console-message", { level, message, line, sourceId });
    });
    wc.on("render-process-gone", (_event, details) => {
      this.emit("render-process-gone", details || {});
    });
    wc.on("unresponsive", () => {
      this.emit("unresponsive", { url: this.getURL() });
    });
  }

  async loadURL(url) {
    return this.webContents?.loadURL(url);
  }

  reload(ignoreCache = false) {
    if (!this.webContents) {
      return;
    }
    if (ignoreCache) {
      this.webContents.reloadIgnoringCache();
      return;
    }
    this.webContents.reload();
  }

  stop() {
    this.webContents?.stop();
  }

  async goBack() {
    if (this.canGoBack()) {
      this.webContents.goBack();
    }
  }

  async goForward() {
    if (this.canGoForward()) {
      this.webContents.goForward();
    }
  }

  canGoBack() {
    return this.webContents?.canGoBack?.() ?? false;
  }

  canGoForward() {
    return this.webContents?.canGoForward?.() ?? false;
  }

  isLoading() {
    return this.webContents?.isLoading?.() ?? false;
  }

  getURL() {
    return this.webContents?.getURL?.() || "";
  }

  getTitle() {
    return this.webContents?.getTitle?.() || "";
  }

  async evaluate(source) {
    if (!this.webContents) {
      throw new Error("browser-unavailable");
    }
    return this.webContents.executeJavaScript(source, true);
  }

  async sendInputEvent(event) {
    if (!this.webContents) {
      throw new Error("browser-unavailable");
    }
    return this.webContents.sendInputEvent(event);
  }

  async insertText(text) {
    if (!this.webContents) {
      throw new Error("browser-unavailable");
    }
    return this.webContents.insertText(String(text ?? ""));
  }

  async focus() {
    if (!this.webContents) {
      throw new Error("browser-unavailable");
    }
    return this.webContents.focus();
  }

  async captureScreenshot(options = {}) {
    if (!this.webContents) {
      throw new Error("browser-unavailable");
    }
    const image = await this.webContents.capturePage(options.rect ?? null);
    const format = options.format === "jpeg" ? "jpeg" : "png";
    const buffer =
      format === "jpeg"
        ? image.toJPEG(options.quality ?? 80)
        : image.toPNG(options.quality ?? 100);
    const size = image.getSize();
    return {
      format,
      buffer,
      width: size.width,
      height: size.height,
      // v1.9 perf: `image.toBitmap()` is another full RGBA copy (8.3MB at 1080p)
      // that no caller reads. Kept in the shape, not in memory — same reasoning
      // as the Playwright adapter's `parseImageSizeFromBuffer`.
      bitmap: null,
    };
  }

  async getCookies(urls = []) {
    if (!this.webContents) {
      return [];
    }
    return this.webContents.session.cookies.get(
      Array.isArray(urls) && urls[0] ? { url: urls[0] } : {}
    );
  }

  async setCookies(cookies = []) {
    if (!this.webContents || !Array.isArray(cookies)) {
      return;
    }
    for (const cookie of cookies) {
      if (cookie && cookie.url) {
        await this.webContents.session.cookies.set(cookie);
      }
    }
  }

  async close() {
    this.detachFromWindow();
    if (this.browserView && !this.browserView.webContents.isDestroyed()) {
      this.browserView.webContents.close();
    }
    this.browserView = null;
    this.isInitialised = false;
  }

  getDebugState() {
    return {
      mode: this.mode,
      embedded: true,
    };
  }
}

class PlaywrightVisibleBrowserAdapter extends BrowserAdapter {
  constructor({
    viewport = DEFAULT_PLAYWRIGHT_VIEWPORT,
    ignoreHTTPSErrors = false,
    storageStatePath = null,
    launchOptions = {},
    userAgent = null,
    locale = null,
    windowPlacement = null,
    maximizeOnLaunch = true,
  }) {
    super({ mode: "playwright-visible" });
    this.viewport = normalizeViewport(viewport);
    this.ignoreHTTPSErrors = ignoreHTTPSErrors;
    this.storageStatePath = storageStatePath;
    this.windowPlacement = windowPlacement && typeof windowPlacement === "object" ? windowPlacement : null;
    this.maximizeOnLaunch = maximizeOnLaunch !== false;
    const launchArgs = [
      ...(Array.isArray(launchOptions?.args) ? launchOptions.args : []),
      ...getWindowPlacementLaunchArgs(this.windowPlacement),
    ];
    this.launchOptions = {
      ...(launchOptions && typeof launchOptions === "object" ? launchOptions : {}),
      ...(launchArgs.length ? { args: launchArgs } : {}),
    };
    this.userAgent = typeof userAgent === "string" && userAgent.trim() ? userAgent.trim() : null;
    this.locale = typeof locale === "string" && locale.trim() ? locale.trim() : null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdpSession = null;
    this.isInitialised = false;
    this.isLoadingFlag = false;
    // v1.9 perf: set only while console forwarding is actually subscribed.
    this.consoleListener = null;
    // v1.9: timestamp of the last page `close`, used to classify a subsequent
    // browser `disconnected` as user-initiated instead of a crash/kill.
    this.pageClosedAt = 0;
    // `newListener` fires *before* the listener is added, so the count is still
    // 0 here — hence the microtask. This is what makes the lazy registration
    // transparent: a consumer just does `adapter.on("console-message", ...)`.
    this.on("newListener", (event) => {
      if (event === "console-message" && !this.consoleListener) {
        queueMicrotask(() => this.ensureConsoleForwarding());
      }
    });
    // v1.4: set by `page.on("crash")`. A Chromium renderer that runs out of
    // memory fires `crash` — NOT `close`, NOT `disconnected` — and
    // `page.isClosed()` keeps returning false afterwards. Without this flag
    // `isAvailable()` stayed true and the resident browser kept accepting runs
    // onto a dead page, which is how `run file` came to freeze on OOM.
    this.crashed = false;
  }

  async init() {
    if (this.isInitialised) {
      return this;
    }
    this.crashed = false;
    this.browser = await chromium.launch({
      headless: false,
      ...this.launchOptions,
    });
    this.browser.on("disconnected", () => {
      // v1.9: distinguish "the OS killed Chromium" from "the user closed the
      // window". Both arrive here as `disconnected`, but only the first one
      // should be auto-recovered — relaunching a browser somebody deliberately
      // closed is worse than leaving it closed. A user close always emits the
      // page's `close` first; a kill/crash of the browser process does not.
      const closedByUser =
        this.pageClosedAt && Date.now() - this.pageClosedAt < USER_CLOSE_GRACE_MS;
      this.page = null;
      this.context = null;
      this.browser = null;
      this.cdpSession = null;
      this.consoleListener = null;
      this.isInitialised = false;
      this.isLoadingFlag = false;
      this.emit("closed", {
        reason: closedByUser ? "browser-closed-by-user" : "browser-disconnected",
      });
    });
    const contextOptions = {
      viewport: this.viewport,
      ignoreHTTPSErrors: this.ignoreHTTPSErrors,
      ...(this.userAgent ? { userAgent: this.userAgent } : {}),
      ...(this.locale ? { locale: this.locale } : {}),
    };
    if (this.storageStatePath) {
      contextOptions.storageState = this.storageStatePath;
    }
    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();
    this.consoleListener = null;
    this.page.on("close", () => {
      this.page = null;
      this.cdpSession = null;
      // Bound to the page that just died; a re-launch must re-register.
      this.consoleListener = null;
      this.isLoadingFlag = false;
      // Read by the `disconnected` handler to tell a user close from a kill.
      this.pageClosedAt = Date.now();
      this.emit("closed", { reason: "page-closed" });
    });
    // v1.4: THE missing listener. Mark the adapter unusable so `isAvailable()`
    // turns false and the existing `createBrowserAdapter()` path tears this
    // instance down and relaunches, instead of handing a dead page to the next
    // run. The page object is intentionally kept (it is not closed) so callers
    // that read `page` for diagnostics still see something.
    this.page.on("crash", () => {
      this.crashed = true;
      this.isLoadingFlag = false;
      this.emit("closed", { reason: "renderer-crash-oom" });
    });
    this.cdpSession = await this.context.newCDPSession(this.page);
    await this.applyInitialWindowPlacement();
    this.attachPageEvents();
    this.isInitialised = true;
    return this;
  }

  isAvailable() {
    return Boolean(
      this.isInitialised &&
        // v1.4: a crashed renderer leaves every other check below still passing
        // (`isClosed()` is false, the browser is connected) — this is the only
        // signal that the page is actually dead.
        !this.crashed &&
        this.browser &&
        this.browser.isConnected?.() &&
        this.context &&
        this.page &&
        !this.page.isClosed?.(),
    );
  }

  attachPageEvents() {
    if (!this.page) {
      return;
    }
    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page.mainFrame()) {
        return;
      }
      this.emit("did-navigate", { url: frame.url() });
      this.emit("page-title-updated", { title: this.getTitle() });
    });
    this.page.on("domcontentloaded", () => {
      this.emit("did-start-loading", { url: this.getURL() });
    });
    this.page.on("load", () => {
      this.isLoadingFlag = false;
      this.emit("did-finish-load", {
        url: this.getURL(),
        title: this.getTitle(),
      });
      this.emit("did-stop-loading", { url: this.getURL() });
    });
    // v1.9 perf: console forwarding is LAZY — see `ensureConsoleForwarding()`.
    // Registering it unconditionally cost ~6.2KB of permanent main-process
    // memory per console call, for an event that currently has no subscriber.
    this.ensureConsoleForwarding();
    this.page.on("pageerror", (error) => {
      this.emit("console-message", {
        level: 3,
        message: error?.message || String(error),
        line: 0,
        sourceId: "pageerror",
      });
    });
    this.page.on("requestfailed", (request) => {
      if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
        const failure = request.failure();
        this.emit("did-fail-load", {
          errorCode: -1,
          errorDescription: failure?.errorText || "request-failed",
          validatedUrl: request.url(),
          isMainFrame: true,
        });
      }
    });
  }

  // v1.9 perf: THE console-handle leak, and why forwarding is lazy.
  //
  // Playwright materialises a JSHandle per argument of every console call as
  // soon as a `console` listener exists, and parks it on the connection until
  // somebody disposes it or the page closes. The visible page never closes — it
  // is resident for the whole app session — so an always-on listener turned
  // every `console.log` the product ever made into permanent main-process
  // memory: ~6.2KB each, measured, GC-proof. That is the 1.6GB main process.
  //
  // `console-message` currently has no subscriber anywhere in the app, so the
  // cheapest correct answer is not to register at all until one appears. The
  // contract is unchanged — subscribe to `console-message` and forwarding turns
  // itself on — but an unused event now costs nothing instead of leaking. When
  // it IS on, every message releases its args (see console-message-args.js);
  // that is not optional, it is the difference between flat and unbounded.
  ensureConsoleForwarding() {
    if (this.consoleListener || !this.page) {
      return;
    }
    if (this.listenerCount("console-message") === 0) {
      return;
    }
    const levelMap = { log: 1, info: 1, warning: 2, error: 3 };
    this.consoleListener = (message) => {
      const type = message.type();
      const text = message.text();
      // Release BEFORE emitting: a throwing subscriber must not strand handles.
      releaseConsoleMessageArgs(message);
      this.emit("console-message", {
        level: levelMap[type] ?? 0,
        message: text,
        line: 0,
        sourceId: "playwright-page",
      });
    };
    this.page.on("console", this.consoleListener);
  }

  async loadURL(url) {
    if (!this.page) {
      throw new Error("browser-unavailable");
    }
    this.isLoadingFlag = true;
    this.emit("did-start-navigation", { url, isInPlace: false });
    try {
      const response = await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      if (!response) {
        return null;
      }
      return response.url();
    } catch (error) {
      this.isLoadingFlag = false;
      this.emit("did-fail-load", {
        errorCode: -1,
        errorDescription: error?.message || String(error),
        validatedUrl: url,
        isMainFrame: true,
      });
      throw error;
    }
  }

  async reload(ignoreCache = false) {
    if (!this.page) {
      return null;
    }
    this.isLoadingFlag = true;
    return this.page.reload({
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }

  async stop() {
    if (!this.page) {
      return;
    }
    try {
      await this.page.evaluate(() => window.stop());
    } catch (_error) {
      // ignore
    } finally {
      this.isLoadingFlag = false;
    }
  }

  async getNavigationHistory() {
    if (!this.cdpSession) {
      return { currentIndex: 0, entries: [] };
    }
    try {
      return await this.cdpSession.send("Page.getNavigationHistory");
    } catch (_error) {
      return { currentIndex: 0, entries: [] };
    }
  }

  async goBack() {
    if (!this.page) {
      return null;
    }
    this.isLoadingFlag = true;
    return this.page.goBack({ waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  async goForward() {
    if (!this.page) {
      return null;
    }
    this.isLoadingFlag = true;
    return this.page.goForward({
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }

  async canGoBack() {
    const history = await this.getNavigationHistory();
    return history.currentIndex > 0;
  }

  async canGoForward() {
    const history = await this.getNavigationHistory();
    return history.currentIndex < history.entries.length - 1;
  }

  isLoading() {
    return this.isLoadingFlag;
  }

  isAvailable() {
    return Boolean(
      this.browser?.isConnected?.() &&
        this.context &&
        this.page &&
        !this.page.isClosed?.()
    );
  }

  getURL() {
    if (!this.isAvailable()) {
      return "";
    }
    return this.page?.url?.() || "";
  }

  async getTitle() {
    if (!this.isAvailable()) {
      return "";
    }
    try {
      return await this.page.title();
    } catch (_error) {
      return "";
    }
  }

  getViewportSize() {
    const viewport = this.page?.viewportSize?.();
    if (viewport) {
      return viewport;
    }
    return this.viewport || { ...DEFAULT_PLAYWRIGHT_VIEWPORT };
  }

  async getContentViewportSize() {
    const viewport = this.page?.viewportSize?.();
    if (viewport) {
      return viewport;
    }
    if (this.cdpSession) {
      try {
        const metrics = await this.cdpSession.send("Page.getLayoutMetrics");
        const visualViewport = metrics?.visualViewport;
        if (visualViewport?.clientWidth && visualViewport?.clientHeight) {
          return {
            width: Math.round(visualViewport.clientWidth),
            height: Math.round(visualViewport.clientHeight),
          };
        }
      } catch (_error) {
        // Fall through to DOM metrics.
      }
    }
    if (this.page) {
      try {
        return await this.page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));
      } catch (_error) {
        // Fall through to configured default.
      }
    }
    return this.getViewportSize();
  }

  async getWindowBounds() {
    if (!this.cdpSession) {
      return null;
    }
    try {
      const { windowId } = await this.cdpSession.send("Browser.getWindowForTarget");
      const { bounds } = await this.cdpSession.send("Browser.getWindowBounds", {
        windowId,
      });
      return bounds || null;
    } catch (_error) {
      return null;
    }
  }

  async applyInitialWindowPlacement() {
    if (!this.cdpSession) {
      return false;
    }
    try {
      const { windowId } = await this.cdpSession.send("Browser.getWindowForTarget");
      const targetBounds = getTargetWindowBounds(this.windowPlacement, {
        fill: this.maximizeOnLaunch,
      });
      if (targetBounds) {
        await this.cdpSession.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            windowState: "normal",
          },
        });
        await this.cdpSession.send("Browser.setWindowBounds", {
          windowId,
          bounds: targetBounds,
        });
      }
      if (this.maximizeOnLaunch) {
        await this.cdpSession.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            windowState: "maximized",
          },
        });
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  async maximizeWindow() {
    return this.applyInitialWindowPlacement();
  }

  async getMapping() {
    const bounds = await this.getWindowBounds();
    const viewport = await this.getContentViewportSize();
    if (!bounds) {
      return null;
    }
    const display = screen.getDisplayMatching({
      x: bounds.left ?? 0,
      y: bounds.top ?? 0,
      width: bounds.width ?? viewport.width,
      height: bounds.height ?? viewport.height,
    });
    const scaleFactor = display?.scaleFactor ?? 1;
    const screenBounds = {
      x: Math.round((bounds.left ?? 0) * scaleFactor),
      y: Math.round((bounds.top ?? 0) * scaleFactor),
      width: Math.round(viewport.width * scaleFactor),
      height: Math.round(viewport.height * scaleFactor),
    };
    return {
      timestamp: Date.now(),
      windowBounds: {
        x: bounds.left ?? 0,
        y: bounds.top ?? 0,
        width: bounds.width ?? viewport.width,
        height: bounds.height ?? viewport.height,
      },
      contentBounds: {
        x: bounds.left ?? 0,
        y: bounds.top ?? 0,
        width: viewport.width,
        height: viewport.height,
      },
      viewBounds: {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      },
      screenBounds,
      display: {
        id: display?.id ?? null,
        scaleFactor,
        rotation: display?.rotation ?? null,
        touchSupport: display?.touchSupport ?? null,
      },
      transforms: {
        viewToScreen: {
          scaleX: scaleFactor,
          scaleY: scaleFactor,
          translateX: screenBounds.x,
          translateY: screenBounds.y,
        },
        screenToView: {
          scaleX: scaleFactor ? 1 / scaleFactor : 0,
          scaleY: scaleFactor ? 1 / scaleFactor : 0,
          translateX: scaleFactor ? -screenBounds.x / scaleFactor : 0,
          translateY: scaleFactor ? -screenBounds.y / scaleFactor : 0,
        },
      },
    };
  }

  async evaluate(source) {
    if (!this.page) {
      throw new Error("browser-unavailable");
    }
    return this.page.evaluate((scriptSource) => {
      return window.eval(scriptSource);
    }, source);
  }

  async sendInputEvent(event) {
    if (!this.page) {
      throw new Error("browser-unavailable");
    }
    const type = event?.type;
    if (type === "mouseMove") {
      await this.page.mouse.move(event.x ?? 0, event.y ?? 0);
      return;
    }
    if (type === "mouseDown") {
      await this.page.mouse.move(event.x ?? 0, event.y ?? 0);
      await this.page.mouse.down({ button: event.button || "left" });
      return;
    }
    if (type === "mouseUp") {
      await this.page.mouse.move(event.x ?? 0, event.y ?? 0);
      await this.page.mouse.up({ button: event.button || "left" });
      return;
    }
    if (type === "mouseWheel") {
      await this.page.mouse.move(event.x ?? 0, event.y ?? 0);
      await this.page.mouse.wheel(event.deltaX ?? 0, event.deltaY ?? 0);
      return;
    }
    if (type === "keyDown") {
      await this.page.keyboard.down(event.keyCode);
      return;
    }
    if (type === "char") {
      await this.page.keyboard.insertText(event.keyCode);
      return;
    }
    if (type === "keyUp") {
      await this.page.keyboard.up(event.keyCode);
    }
  }

  async insertText(text) {
    if (!this.page) {
      throw new Error("browser-unavailable");
    }
    await this.page.keyboard.insertText(String(text ?? ""));
  }

  async focus() {
    if (!this.page) {
      throw new Error("browser-unavailable");
    }
    await this.page.bringToFront();
  }

  async captureScreenshot(options = {}) {
    if (!this.page) {
      throw new Error("browser-unavailable");
    }
    const format = options.format === "jpeg" ? "jpeg" : "png";
    const clip = options.rect
      ? {
          x: Math.max(0, options.rect.x ?? 0),
          y: Math.max(0, options.rect.y ?? 0),
          width: Math.max(1, options.rect.width ?? 1),
          height: Math.max(1, options.rect.height ?? 1),
        }
      : undefined;
    const buffer = await this.page.screenshot({
      type: format,
      quality: format === "jpeg" ? options.quality ?? 80 : undefined,
      clip,
      animations: "disabled",
    });
    const parsed = format === "png" ? parseImageSizeFromBuffer(buffer) : null;
    const viewport = await this.getContentViewportSize();
    return {
      format,
      buffer,
      width: parsed?.width ?? clip?.width ?? viewport.width,
      height: parsed?.height ?? clip?.height ?? viewport.height,
      bitmap: parsed?.bitmap ?? null,
    };
  }

  async getCookies(urls = []) {
    if (!this.context) {
      return [];
    }
    const cookies = await this.context.cookies(urls);
    return cookies;
  }

  async setCookies(cookies = []) {
    if (!this.context || !Array.isArray(cookies) || !cookies.length) {
      return;
    }
    await this.context.addCookies(cookies);
  }

  async close() {
    if (this.context) {
      await this.context.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    this.cdpSession = null;
    this.consoleListener = null;
    this.isInitialised = false;
  }

  getDebugState() {
    return {
      mode: this.mode,
      embedded: false,
      consoleForwarding: Boolean(this.consoleListener),
      ignoreHTTPSErrors: this.ignoreHTTPSErrors,
      viewport: this.viewport,
      windowPlacement: this.windowPlacement
        ? {
            displayCount: this.windowPlacement.displayCount ?? null,
            avoidsAppDisplay: this.windowPlacement.avoidsAppDisplay ?? false,
            appDisplayId: this.windowPlacement.appDisplay?.id ?? null,
            targetDisplayId: this.windowPlacement.targetDisplay?.id ?? null,
            targetWorkArea: getTargetWorkArea(this.windowPlacement),
          }
        : null,
      maximizeOnLaunch: this.maximizeOnLaunch,
    };
  }
}

module.exports = {
  EmbeddedDebugBrowserAdapter,
  PlaywrightVisibleBrowserAdapter,
};
