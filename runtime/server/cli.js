#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { observedRun } = require("./observed-run");

function parseArgs(argv) {
  const result = {
    payload: null,
    file: null,
    url: null,
    outputDir: null,
    headless: true,
    runId: null,
    storageStatePath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--payload" && next) {
      result.payload = next;
      index += 1;
    } else if (arg === "--file" && next) {
      result.file = next;
      index += 1;
    } else if (arg === "--url" && next) {
      result.url = next;
      index += 1;
    } else if (arg === "--output-dir" && next) {
      result.outputDir = next;
      index += 1;
    } else if (arg === "--run-id" && next) {
      result.runId = next;
      index += 1;
    } else if (arg === "--storage-state" && next) {
      result.storageStatePath = next;
      index += 1;
    } else if (arg === "--headed") {
      result.headless = false;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let payload = args.payload;
  if (!payload && args.file) {
    payload = fs.readFileSync(path.resolve(args.file), "utf8");
  }
  if (!payload) {
    throw new Error("Provide --payload or --file.");
  }
  const outputRoot = path.join(path.resolve(process.env.ZHUZHU_WORKSPACE_DIR || process.cwd()), "output");
  const result = await observedRun(payload, {
    url: args.url,
    outputDir: args.outputDir,
    headless: args.headless,
    runId: args.runId,
    storageStatePath: args.storageStatePath,
  }, { outputRoot, kind: "cli-run", trigger: "cli" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
