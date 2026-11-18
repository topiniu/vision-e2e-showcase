"use strict";


const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { run } = require("../runtime");

function parseArgs(argv) {
  const args = { steps: 12, rounds: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--steps") { args.steps = Number(argv[i + 1]) || args.steps; i += 1; }
    else if (argv[i] === "--rounds") { args.rounds = Number(argv[i + 1]) || args.rounds; i += 1; }
  }
  return args;
}

// A list page with a table of mixed CJK/Latin text — OCR cost scales with how
// much text the screenshot carries, so an empty page would understate it.
function renderPage() {
  const rows = Array.from({ length: 30 }, (_, i) =>
    `<tr><td>DEMO2026A0${1000 + i}</td><td>示例任务任务 ${i}</td><td>任务跟进</td><td>2026-10-0${(i % 9) + 1}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>perf</title></head><body>
    <main>
      <h1>示例任务工作台</h1>
      <input data-testid="perf-search-input" placeholder="请输入SPU" />
      <button data-testid="perf-search-btn" onclick="document.querySelector('#out').textContent='已查询 '+Date.now()">查询</button>
      <div id="out">未查询</div>
      <table>${rows}</table>
    </main></body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data: { totalRecords: 30 } }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(renderPage());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}

function buildSteps(count, base) {
  const steps = [];
  for (let i = 0; i < count; i += 1) {
    const shape = i % 3;
    if (shape === 0) {
      steps.push({ type: "fill", target: { testId: "perf-search-input" }, value: `JY-${i}`, needRes: true, stabilizationDelayMs: 0 });
    } else if (shape === 1) {
      steps.push({ type: "click", target: { testId: "perf-search-btn" }, needRes: true, stabilizationDelayMs: 0 });
    } else {
      steps.push({
        type: "callApi",
        request: { method: "GET", url: `${base}/api/list?i=${i}` },
        expectation: { kind: "response", body: [{ path: "data.totalRecords", operator: "equals", expected: 30 }] },
        needRes: true,
        stabilizationDelayMs: 0,
      });
    }
  }
  return steps;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

async function measure(mode, steps, base) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `zz-perf-evidence-${mode}-`));
  const startedAt = Date.now();
  const result = await run(steps, {
    url: `${base}/`,
    outputDir,
    headless: true,
    stepOcr: mode === "legacy" ? "always" : "onFailure",
  });
  const wallMs = Date.now() - startedAt;
  const stepResults = result.data?.results || [];
  const durations = stepResults.map((item) => Number(item.telemetry?.durationMs || 0));
  const stages = {};
  for (const item of stepResults) {
    const stageMap = item.telemetry?.stages || item.data?.telemetry?.stages || {};
    for (const [name, ms] of Object.entries(stageMap)) {
      if (name !== "total") {
        stages[name] = (stages[name] || 0) + Number(ms || 0);
      }
    }
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  return { ok: result.ok, wallMs, durations, stages };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { server, base } = await startServer();
  const steps = buildSteps(args.steps, base);
  const byMode = { legacy: [], "v1.10": [] };
  try {
    for (let round = 0; round < args.rounds; round += 1) {
      for (const mode of Object.keys(byMode)) {
        byMode[mode].push(await measure(mode, steps, base));
      }
    }
  } finally {
    server.close();
  }
  console.log(`steps=${args.steps} rounds=${args.rounds} (fill/click/callApi, all needRes)`);
  const summary = {};
  for (const [mode, samples] of Object.entries(byMode)) {
    const durations = samples.flatMap((item) => item.durations);
    const wall = median(samples.map((item) => item.wallMs));
    const stages = {};
    for (const sample of samples) {
      for (const [name, ms] of Object.entries(sample.stages)) {
        stages[name] = (stages[name] || 0) + ms / samples.length;
      }
    }
    summary[mode] = { wall, stepMedian: median(durations) };
    const top = Object.entries(stages).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([name, ms]) => `${name}=${Math.round(ms)}ms`).join("  ");
    console.log(`${mode.padEnd(7)} ok=${samples.every((item) => item.ok)}  run wall(median)=${wall}ms  step median=${median(durations)}ms  | ${top}`);
  }
  const saved = summary.legacy.wall - summary["v1.10"].wall;
  console.log(`\nv1.10 vs legacy: run wall ${summary["v1.10"].wall}ms vs ${summary.legacy.wall}ms ` +
    `(${saved >= 0 ? "-" : "+"}${Math.abs(saved)}ms, ${Math.round((saved / Math.max(1, summary.legacy.wall)) * 100)}%)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
