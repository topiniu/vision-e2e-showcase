import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function verifyLocalPatch(directory = path.join(root, "vendor", "picomatch")) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "security-patch.json"), "utf8"));
  assert.equal(manifest.advisory, "GHSA-fc5q-39xc-vjpf");
  const entries = fs.readdirSync(directory, { recursive: true });
  for (const name of entries) {
    assert.ok(!fs.lstatSync(path.join(directory, name)).isSymbolicLink(), `Unexpected symlink: ${name}`);
  }
  const actual = entries
    .filter((name) => fs.lstatSync(path.join(directory, name)).isFile() && name !== "security-patch.json")
    .map((name) => name.replaceAll(path.sep, "/")).sort();
  assert.deepEqual(actual, Object.keys(manifest.files).sort(), "Local security branch contains unexpected or missing files");
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  assert.equal(metadata.name, "@vision-e2e/picomatch");
  assert.equal(metadata.version, manifest.patchedVersion);
  assert.equal(metadata.private, true);
  for (const [name, digest] of Object.entries(manifest.files)) {
    const absolute = path.join(directory, name);
    assert.ok(!fs.lstatSync(absolute).isSymbolicLink(), `Unexpected symlink: ${name}`);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"), digest, `Local patch integrity mismatch: ${name}`);
  }
  return manifest;
}

export function verifyInstalledDependencies(projectRoot = root) {
  const fromRoot = createRequire(path.join(projectRoot, "package.json"));
  const packageJson = fromRoot("./package.json");
  assert.equal(packageJson.overrides.picomatch, "$picomatch");
  assert.equal(packageJson.devDependencies.picomatch, "file:vendor/picomatch");
  assert.equal(fromRoot("picomatch/package.json").name, "@vision-e2e/picomatch");
  const expected = fs.realpathSync(path.join(projectRoot, "vendor", "picomatch", "index.js"));
  for (const name of ["vite", "fdir", "tinyglobby", "@parcel/watcher"]) {
    const consumer = createRequire(fromRoot.resolve(`${name}/package.json`));
    assert.equal(fs.realpathSync(consumer.resolve("picomatch")), expected, `${name} loaded an unpatched matcher`);
  }
  for (const name of ["app-builder-lib", "@electron/universal"]) {
    const consumer = createRequire(fromRoot.resolve(`${name}/package.json`));
    assert.equal(consumer("minimatch/package.json").version, "11.0.9", `${name} loaded an affected minimatch`);
  }
}

function checkAudit() {
  assert.ok(process.env.npm_execpath, "Run this check through npm run check:security");
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "audit", "--json"], {
    cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout);
  assert.equal(report.error, undefined, JSON.stringify(report.error));
  assert.equal(result.status, 0, `npm audit failed: ${JSON.stringify(report.metadata?.vulnerabilities || report.error)}`);
  assert.equal(report.metadata?.vulnerabilities?.total, 0, "All dependencies, including development tools, must pass audit");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    verifyLocalPatch();
    verifyInstalledDependencies();
    checkAudit();
    const regression = spawnSync(process.execPath, ["--test", "test/runtime/dependency-security.test.js"], {
      cwd: root, encoding: "utf8", timeout: 30000,
    });
    if (regression.error) throw regression.error;
    assert.equal(regression.status, 0, regression.stdout + regression.stderr);
    console.log("All-dependency npm audit: 0 advisories. Local picomatch patch integrity and consumer resolution: verified.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
