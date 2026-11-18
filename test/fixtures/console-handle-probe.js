"use strict";


const { chromium } = require("playwright");

const { releaseConsoleMessageArgs } = require("../../runtime/perception/console-message-args");

const MODE = process.argv[2] === "keep" ? "keep" : "release";
const MESSAGES_PER_ROUND = 1500;
const ROUNDS = 4;

async function emitConsoleNoise(page, count) {
  await page.evaluate((n) => {
    for (let i = 0; i < n; i += 1) {
      console.log("app log", { i, payload: new Array(200).fill("x").join("") });
    }
  }, count);
  await page.waitForTimeout(250);
}

function heapUsedMb() {
  global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  let seen = 0;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");

    page.on("console", (message) => {
      seen += 1;
      // The same order browser-adapter.js uses: read the local previews first,
      // release afterwards. Reversing them reintroduces the leak.
      void message.type();
      void message.text();
      if (MODE === "release") {
        releaseConsoleMessageArgs(message);
      }
    });

    // One warm-up round so the baseline includes Playwright's own steady-state
    // allocation and only the *growth* is attributable to the handles.
    await emitConsoleNoise(page, MESSAGES_PER_ROUND);
    const baseline = heapUsedMb();
    for (let round = 0; round < ROUNDS; round += 1) {
      await emitConsoleNoise(page, MESSAGES_PER_ROUND);
    }
    const growthMb = heapUsedMb() - baseline;
    process.stdout.write(`${JSON.stringify({ growthMb, seen })}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
