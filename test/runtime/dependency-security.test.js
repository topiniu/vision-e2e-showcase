const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("dependency resolution loads the reviewed local matcher and patched minimatch", async () => {
  const { verifyLocalPatch, verifyInstalledDependencies } = await import("../../scripts/check-dependency-security.mjs");
  verifyLocalPatch();
  verifyInstalledDependencies();
});

test("a changed local security branch is rejected before the audit can report success", async (t) => {
  const { verifyLocalPatch } = await import("../../scripts/check-dependency-security.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "matcher-integrity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const copy = path.join(root, "picomatch");
  await fs.cp(path.resolve(__dirname, "../../vendor/picomatch"), copy, { recursive: true });
  await fs.appendFile(path.join(copy, "lib/parse.js"), "\n// unexpected change\n");
  assert.throws(() => verifyLocalPatch(copy), /integrity mismatch/);
});

test("repeated-extglob attack inputs finish in a bounded child process", () => {
  const script = `
    const assert = require('node:assert/strict');
    const pm = require(process.argv[1]);
    const posix = require(require('node:path').join(require('node:path').dirname(process.argv[1]), 'posix.js'));
    const samples = [
      ['+(*a)', 'a'.repeat(64) + '!'],
      ['*(*)', 'a'.repeat(64) + '/'],
      ['+(*)', 'a'.repeat(64) + '/'],
      ['*(*a)', 'a'.repeat(64) + '!'],
      ['+(*?a)', 'a'.repeat(64) + '!'],
      ['+(a|aa)', 'a'.repeat(64) + '!'],
      ['+(ab|abab)', 'ab'.repeat(64) + '!'],
      ['+(a|ab|b)', 'ab'.repeat(64) + '!'],
      ['+("a"|"aa")', 'a'.repeat(64) + '!'],
      ['+((a+))', 'a'.repeat(64) + '!'],
    ];
    for (const options of [{}, { maxExtglobRecursion: false }, { capture: true }, { windows: true }]) {
      for (const [pattern, input] of samples) {
        assert.equal(pm(pattern, options)(input), false);
        assert.equal(pm.makeRe(pattern, options).test(input), false);
        assert.equal(posix(pattern, options)(input), false);
        assert.equal(pm(pattern, options)(pattern), true, 'risky patterns use the existing literal fallback');
      }
    }
    for (const options of [{ nocase: true }, { flags: 'i' }]) {
      assert.equal(pm('+(a|AA)', options)('a'.repeat(64) + '!'), false);
      assert.equal(pm('+(a|AA)', options)('+(a|AA)'), true);
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script, require.resolve("picomatch")], {
    encoding: "utf8", timeout: 4000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("common glob, scan, callbacks, windows and direct parse APIs remain compatible", () => {
  const pm = require("picomatch");
  assert.equal(pm("**/*.{js,css}")("src/app/main.js"), true);
  assert.equal(pm("**/*.{js,css}")("src/app/main.ts"), false);
  assert.equal(pm("**/*", { dot: true })(".github/workflows/ci.yml"), true);
  assert.equal(pm("*.js")(".hidden.js"), false);
  assert.equal(pm("+(foo|bar)")("foobarfoo"), true);
  assert.equal(pm("+(ab)")("abab"), true);
  assert.equal(pm("src/[ab].js")("src/a.js"), true);
  assert.equal(pm("src/!(test).js")("src/main.js"), true);
  assert.equal(pm("src/!(test).js")("src/test.js"), false);
  assert.equal(pm("**/*.js", { windows: true })("src\\app\\main.js"), true);
  assert.equal(pm.scan("src/**/*.js").base, "src");
  assert.equal(pm.compileRe(pm.parse("**/*.js")).test("src/main.js"), true);
  const posix = require("picomatch/posix");
  assert.equal(posix("+(*)")("a".repeat(64) + "/"), false);
  const matches = [];
  const match = pm("**/*.js", { ignore: "**/test/**", onMatch: ({ input }) => matches.push(input) });
  assert.equal(match("src/main.js", true).isMatch, true);
  assert.equal(match("src/test/main.js"), false);
  assert.deepEqual(matches, ["src/main.js"]);
});

test("patched minimatch keeps builder file filters and has an amplification bound", () => {
  const fromBuilder = require("node:module").createRequire(require.resolve("app-builder-lib/package.json"));
  const { minimatch, Minimatch } = fromBuilder("minimatch");
  assert.equal(minimatch("dist/panel/index.html", "dist/panel/**/*", { dot: true }), true);
  assert.equal(new Minimatch("**/*.map").match("runtime/index.js"), false);
  assert.equal(new Minimatch("**/*.map").match("dist/index.js.map"), true);
  const result = spawnSync(process.execPath, ["-e", `
    const {Minimatch}=require(process.argv[1]);
    const pattern=Array.from({length:35},()=> '**/..').join('/')+'/file.js';
    try { new Minimatch(pattern,{optimizationLevel:2}).match('file.js'); }
    catch (error) { if (!(error instanceof RangeError)) throw error; }
  `, fromBuilder.resolve("minimatch")], { encoding: "utf8", timeout: 4000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
