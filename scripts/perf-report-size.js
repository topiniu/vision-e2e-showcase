"use strict";


const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const { startHeavyPageServer } = require("../test/fixtures/heavy-page");
const { run } = require("../runtime");

function parseArgs(argv) {
  const args = { nodes: 20000, steps: 12 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--nodes") { args.nodes = Number(argv[i + 1]) || args.nodes; i += 1; }
    else if (argv[i] === "--steps") { args.steps = Number(argv[i + 1]) || args.steps; i += 1; }
  }
  return args;
}

function buildSteps(count) {
  const steps = [];
  for (let i = 0; i < count; i += 1) {
    // Alternate two shapes so the run exercises both a fill and a click, and ask
    // for evidence (`needRes`) because that is the profile a real case uses when
    // it wants proof.
    if (i % 2 === 0) {
      steps.push({
        type: "fill",
        target: { testId: "perf-search-input" },
        value: `sample-${i}`,
        needRes: true,
      });
    } else {
      steps.push({
        type: "click",
        target: { testId: "perf-search-btn" },
        needRes: true,
      });
    }
  }
  return steps;
}

function sizeOf(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = await startHeavyPageServer();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhuzhu-report-size-"));
  try {
    // A bare array is the batch payload shape (runtime/protocol/normalize.js);
    // `{steps:[...]}` normalizes to a single `capture` action instead.
    const result = await run(
      buildSteps(args.steps),
      { url: fixture.url(args.nodes), outputDir, headless: true },
    );
    const reportPath = result?.evidence?.reportPath;
    if (!reportPath) {
      throw new Error(`run produced no report: ${JSON.stringify(result?.error || result?.type)}`);
    }
    const raw = await fs.readFile(reportPath, "utf8");
    const report = JSON.parse(raw);
    const steps = report.summary?.data?.results || [];

    const fields = {};
    for (const step of steps) {
      const data = step.data || {};
      for (const key of Object.keys(data)) {
        fields[key] = (fields[key] || 0) + sizeOf(data[key]);
      }
    }

    const totalKb = Buffer.byteLength(raw) / 1024;
    process.stdout.write(
      `nodes=${args.nodes} steps=${steps.length} ok=${result.ok}\n` +
      `report.json = ${totalKb.toFixed(1)}KB  (${(totalKb / Math.max(steps.length, 1)).toFixed(1)}KB per step)\n`,
    );
    const ranked = Object.entries(fields).sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [key, bytes] of ranked) {
      const share = (bytes / 1024 / totalKb) * 100;
      process.stdout.write(
        `  step.data.${key.padEnd(18)} ${(bytes / 1024).toFixed(1).padStart(8)}KB  ${share.toFixed(1).padStart(5)}%\n`,
      );
    }
    const snapshotChars = steps.reduce(
      (sum, step) => sum + (step.data?.snapshot?.before?.text || "").length + (step.data?.snapshot?.after?.text || "").length,
      0,
    );
    const truncatedSamples = steps.filter(
      (step) => step.data?.snapshot?.before?.textTruncated || step.data?.snapshot?.after?.textTruncated,
    ).length;
    process.stdout.write(
      `  page-text carried: ${snapshotChars} chars across ${steps.length * 2} samples; ` +
      `${truncatedSamples} step(s) had a truncated sample\n`,
    );
  } finally {
    await fixture.close();
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
