"use strict";


const { chromium } = require("playwright");
const { startHeavyPageServer } = require("../test/fixtures/heavy-page");
const { capturePageState } = require("../runtime/perception/page-snapshot");
const { resolveActionTarget } = require("../runtime/executor/locator-resolver");

function parseArgs(argv) {
  const args = { sizes: [2000, 10000, 20000], repeat: 3, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sizes") {
      args.sizes = String(argv[i + 1] || "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
      i += 1;
    } else if (argv[i] === "--repeat") {
      args.repeat = Math.max(1, Number(argv[i + 1]) || 1);
      i += 1;
    } else if (argv[i] === "--json") {
      args.json = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms, value };
}

const SCOPED_ACTION = {
  kind: "click",
  target: { text: "确认定价", scope: { nearText: "定价确认" } },
};

const TEXT_ACTION = {
  kind: "click",
  target: { text: "查询" },
};

// The worst case that actually happens in an ERP list: a row-action label that
// legitimately matches every row, disambiguated by nearText. This is the
// scenario that used to cost one round-trip *per match* plus a full-document
// scan *per match*.
// Measured on v1.7.1: 22.7 s at 3.9k nodes / 132.3 s at 9.9k nodes — the
// scope-plus-nearText screening loop ran one round-trip per match and a
// full-document scan per match.
const MANY_MATCH_ACTION = {
  kind: "click",
  target: { text: "查看", nearText: "样品名称 7", scope: { testId: "perf-table" } },
};

async function benchSize(browser, url, repeat) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);

    // One warm-up of each probe so V8/Blink caches are not charged to sample 1.
    await capturePageState(page).catch(() => null);
    await resolveActionTarget(page, SCOPED_ACTION).catch(() => null);
    await resolveActionTarget(page, TEXT_ACTION).catch(() => null);

    const stateMs = [];
    const scopedMs = [];
    const textMs = [];
    const manyMs = [];
    let manyOk = false;
    let stateBytes = 0;
    let stateTextChars = 0;
    let scopedOk = false;
    let textOk = false;

    for (let i = 0; i < repeat; i += 1) {
      const state = await timed(() => capturePageState(page));
      stateMs.push(state.ms);
      stateBytes = Buffer.byteLength(JSON.stringify(state.value || {}));
      stateTextChars = (state.value?.text || "").length;

      const scoped = await timed(() => resolveActionTarget(page, SCOPED_ACTION).catch(() => null));
      scopedMs.push(scoped.ms);
      scopedOk = Boolean(scoped.value?.locator);

      const text = await timed(() => resolveActionTarget(page, TEXT_ACTION).catch(() => null));
      textMs.push(text.ms);
      textOk = Boolean(text.value?.locator);

      // Only sampled once: on the pre-v1.8 code path this single call takes
      // over a minute at 20k nodes, and repeating it adds nothing.
      if (i === 0) {
        const many = await timed(() => resolveActionTarget(page, MANY_MATCH_ACTION).catch(() => null));
        manyMs.push(many.ms);
        manyOk = Boolean(many.value?.locator);
      }
    }

    return {
      domNodes,
      capturePageStateMs: Math.round(median(stateMs)),
      resolveScopedMs: Math.round(median(scopedMs)),
      resolveTextMs: Math.round(median(textMs)),
      resolveManyMatchMs: Math.round(median(manyMs)),
      stateBytes,
      stateTextChars,
      scopedOk,
      textOk,
      manyOk,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = await startHeavyPageServer();
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const rows = [];
  try {
    for (const size of args.sizes) {
      const row = await benchSize(browser, fixture.url(size), args.repeat);
      rows.push({ requestedNodes: size, ...row });
      process.stdout.write(
        `nodes=${String(row.domNodes).padStart(6)}  ` +
        `state=${String(row.capturePageStateMs).padStart(6)}ms  ` +
        `scoped=${String(row.resolveScopedMs).padStart(6)}ms  ` +
        `text=${String(row.resolveTextMs).padStart(6)}ms  ` +
        `manyMatch=${String(row.resolveManyMatchMs).padStart(7)}ms  ` +
        `statePayload=${String(Math.round(row.stateBytes / 1024)).padStart(5)}KB  ` +
        `pageText=${String(row.stateTextChars).padStart(7)}chars  ` +
        `resolved=${row.scopedOk ? "scoped✓" : "scoped✗"}/${row.textOk ? "text✓" : "text✗"}/${row.manyOk ? "many✓" : "many✗"}\n`,
      );
    }
  } finally {
    await browser.close();
    await fixture.close();
  }

  // Growth factor between the two largest sizes: ~2x means linear, ~4x means
  // quadratic. This single number is the reason the sweep exists.
  if (rows.length >= 2) {
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const ratio = (a, b) => (b > 0 ? (a / b).toFixed(2) : "n/a");
    process.stdout.write(
      `\ngrowth ${prev.domNodes}→${last.domNodes} nodes (${ratio(last.domNodes, prev.domNodes)}x DOM): ` +
      `state ${ratio(last.capturePageStateMs, prev.capturePageStateMs)}x  ` +
      `scoped ${ratio(last.resolveScopedMs, prev.resolveScopedMs)}x  ` +
      `text ${ratio(last.resolveTextMs, prev.resolveTextMs)}x\n`,
    );
  }

  if (args.json) {
    require("node:fs").writeFileSync(args.json, `${JSON.stringify(rows, null, 2)}\n`);
    process.stdout.write(`\nwrote ${args.json}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
