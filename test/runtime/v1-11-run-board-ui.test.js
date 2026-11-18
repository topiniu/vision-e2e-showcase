const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const { getRunBoard } = require("../../runtime/server/run-board");
const { handleRunBoardRoute } = require("../../runtime/server/run-board-http");

test("v1.11 Z33: dashboard updates live, filters history, escapes titles and fits 1280/1920", async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zz-board-ui-"));
  const board = getRunBoard({ outputRoot });
  const server = http.createServer((req, res) => handleRunBoardRoute(req, res, new URL(req.url, "http://local"), { outputRoot, label: "UI 验证（示例任务）" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    board.register({ id: "live-example", kind: "headless-session", title: "示例 · 排版验证", caseTotal: 3 });
    board.recordEvent("live-example", { type: "run-start", runId: "layout-1280", caseId: "c1", caseName: "1280 宽排版", totalSteps: 4 });
    board.recordEvent("live-example", { type: "step-start", stepIndex: 2, stepTitle: "检查筛选格不重叠", actionType: "assertLayout" });
    board.register({ id: "queued-example", kind: "batch-item", status: "queued", title: "示例 · 下一组用例" });
    board.register({ id: "history-example", kind: "cli-run", title: '<img src=x onerror="window.__xss=1">' });
    board.finish("history-example", { status: "failed", firstFailure: { code: "example-failure", message: "示例失败，用于验证筛选" } });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/run-board`);
    await page.locator("#live .run").waitFor();
    assert.match(await page.locator("#live").innerText(), /检查筛选格不重叠/);
    assert.equal(await page.locator("#queued .queue-row").count(), 1);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator("#history img").count(), 0);
    await page.locator("#theme").click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    await page.locator("#theme").click();
    const screenshotDir = process.env.ZHUZHU_BOARD_SCREENSHOT_DIR;
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal page overflow at ${width}`);
      if (screenshotDir) {
        fs.mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, `run-board-${width}-example.png`), fullPage: true });
      }
    }
    board.finish("live-example", { status: "passed", casesPassed: 3 });
    await page.locator("#history tr", { hasText: "示例 · 排版验证" }).waitFor();
    assert.equal(await page.locator("#live .run").count(), 0);
    await page.locator("#f-status").selectOption("failed");
    assert.equal(await page.locator("#history tr").count(), 1);
    assert.match(await page.locator("#history").innerText(), /example-failure/);
    await page.locator("#f-text").fill("not-found");
    assert.match(await page.locator("#history").innerText(), /没有符合条件/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
