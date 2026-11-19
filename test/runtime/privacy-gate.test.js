const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "../../scripts/check-public-snapshot.mjs");
const privateReference = "team.example.invalid";

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "showcase-privacy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Demo Reviewer");
  git("config", "user.email", "reviewer@example.invalid");
  return { root, git };
}

function check(root, { history = false, references = "", required = false } = {}) {
  return spawnSync(process.execPath, [script, "--root", root, ...(history ? ["--history"] : [])], {
    encoding: "utf8",
    env: { ...process.env, ZHUZHU_PRIVATE_REFERENCES: references, ZHUZHU_REQUIRE_PRIVATE_REFERENCES: required ? "1" : "0" },
  });
}

test("privacy gate rejects unreviewed wildcard domains and literal distributed passwords", async (t) => {
  const { root } = await repository(t);
  const file = path.join(root, "example.txt");
  await fs.writeFile(file, ["*", "private-sample", "net"].join("."));
  assert.equal(check(root).status, 1);
  await fs.writeFile(file, "*.example.test\ntest/runtime/*.test.js\n*.production.example.org");
  assert.equal(check(root).status, 0);
  await fs.mkdir(path.join(root, "test-workflows"));
  const workflow = path.join(root, "test-workflows/demo.json");
  await fs.writeFile(workflow, JSON.stringify({ steps: [{ type: "fill", target: { name: "password" }, value: "local-test-only" }] }));
  assert.equal(check(root).status, 1);
  await fs.writeFile(workflow, JSON.stringify({ steps: [{ type: "fill", target: { name: "password" }, value: "{{credential.password}}" }] }));
  assert.equal(check(root).status, 0);
});

test("private policy matches literal references, scans binary metadata and redacts diagnostics", async (t) => {
  const { root } = await repository(t);
  await fs.mkdir(path.join(root, "assets"));
  const file = path.join(root, "assets/fixture.png");
  await fs.writeFile(file, Buffer.from("\0metadata " + privateReference.toUpperCase()));
  const result = check(root, { references: privateReference });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private reference/);
  assert.equal(result.stderr.toLowerCase().includes(privateReference), false);
  await fs.writeFile(file, Buffer.from("\0metadata teamXexampleXinvalid"));
  assert.equal(check(root, { references: privateReference }).status, 0);
});

test("history gate catches a removed reference and rejects shallow history", async (t) => {
  const { root, git } = await repository(t);
  await fs.writeFile(path.join(root, "removed.txt"), privateReference);
  git("add", "."); git("commit", "-m", "Add synthetic fixture");
  git("rm", "removed.txt");
  await fs.writeFile(path.join(root, "safe.txt"), "safe");
  git("add", "."); git("commit", "-m", "Remove fixture");
  assert.equal(check(root, { references: privateReference }).status, 0);
  const result = check(root, { history: true, references: privateReference });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git:.*removed\.txt/);
  assert.equal(result.stderr.includes(privateReference), false);
  await fs.writeFile(path.join(root, ".git/shallow"), git("rev-parse", "HEAD"));
  assert.match(check(root, { history: true }).stderr, /Complete history required/);
});

test("history gate audits side branches and commit metadata", async (t) => {
  const { root, git } = await repository(t);
  await fs.writeFile(path.join(root, "safe.txt"), "safe");
  git("add", "."); git("commit", "-m", "Clean main");
  git("checkout", "-b", "retained-fixture");
  git("commit", "--allow-empty", "-m", privateReference);
  git("checkout", "main");
  assert.equal(check(root, { references: privateReference }).status, 0);
  const result = check(root, { history: true, references: privateReference });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git:.*:commit:.*private reference/);
  git("branch", "-D", "retained-fixture");
  assert.equal(check(root, { history: true, references: privateReference }).status, 0);
});

test("a required private release policy fails closed when missing", async (t) => {
  const { root } = await repository(t);
  await fs.writeFile(path.join(root, "safe.txt"), "safe");
  const missing = check(root, { required: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /policy required but not configured/);
  assert.equal(check(root, { required: true, references: privateReference }).status, 0);
});
