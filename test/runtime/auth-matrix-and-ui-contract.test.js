
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const {
  CREDENTIALS_FILE,
  bootstrapAuthProfile,
  buildAuthMatrixTable,
  describeCredentialFields,
  normalizeAuthMatrix,
  readCredentialStore,
  redactVariables,
  toRuntimeVariables,
} = require("../../runtime/server/auth-bootstrap");
const {
  buildUiContract,
  extractTestIds,
  findComponentEntries,
  readFrontendInventory,
} = require("../../runtime/server/ui-contract");
const { launchSharedBrowser } = require("../../runtime/executor/run-session");
const { run } = require("../../runtime");
const { getAuthProfileStatus } = require("../../runtime/server/auth-profile");

function tempWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhuzhu-authmatrix-"));
  fs.mkdirSync(path.join(root, "test-workflows"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A login page that only sets a session cookie for the right credentials, and an
// app page whose 导出 entry is hidden for the restricted account. That is the
// DEMO-1296-F7 shape, reduced.
function startLoginApp() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/api/login") {
        const role = url.searchParams.get("user") === "limited" ? "limited" : "admin";
        response.writeHead(200, {
          "Set-Cookie": `session=${role}; Path=/`,
          "Content-Type": "application/json",
        });
        return response.end(JSON.stringify({ ok: true, role }));
      }
      const cookie = String(request.headers.cookie || "");
      const role = /session=limited/.test(cookie) ? "limited" : /session=admin/.test(cookie) ? "admin" : null;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (url.pathname === "/login") {
        return response.end(`<!doctype html><html><body>
          <input data-testid="login-user" />
          <input data-testid="login-pass" type="password" />
          <button data-testid="login-submit">登录</button>
          <script>
            document.querySelector('[data-testid="login-submit"]').addEventListener("click", async () => {
              const user = document.querySelector('[data-testid="login-user"]').value;
              await fetch("/api/login?user=" + encodeURIComponent(user));
              location.href = "/app";
            });
          </script>
        </body></html>`);
      }
      return response.end(`<!doctype html><html><body>
        <div data-testid="who">${role || "anonymous"}</div>
        ${role === "admin" ? '<button data-testid="demo-export-btn">导出</button>' : ""}
        <div data-testid="demo-workflow-table">列表</div>
      </body></html>`);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// --- Z-F: credential hygiene -------------------------------------------------

test("F-3: credentials are referenced by name and never echoed back", async (t) => {
  const root = tempWorkspace(t);
  fs.writeFileSync(
    path.join(root, CREDENTIALS_FILE),
    JSON.stringify({ "demo-limited": { username: "demo-viewer", password: "s3cr3t!" } }),
  );
  const store = await readCredentialStore(root);
  assert.deepEqual(Object.keys(store), ["demo-limited"]);

  const { variables, secretNames } = toRuntimeVariables(store["demo-limited"]);
  assert.equal(variables.username, "demo-viewer");
  assert.equal(variables.password, "s3cr3t!");
  assert.deepEqual(secretNames, ["password"]);

  // Only field NAMES are reportable.
  assert.deepEqual(describeCredentialFields(store["demo-limited"]), [
    { field: "username", secret: false },
    { field: "password", secret: true },
  ]);
  const redacted = redactVariables(variables, secretNames);
  assert.equal(redacted.username, "demo-viewer");
  assert.equal(redacted.password, "[redacted]");
  assert.equal(JSON.stringify(redacted).includes("s3cr3t"), false);
});

test("a missing credential store or entry is a clear error, not a silent empty login", async (t) => {
  const root = tempWorkspace(t);
  assert.deepEqual(await readCredentialStore(root), {});
  const result = await bootstrapAuthProfile(
    { profile: "p", credentialRef: "nope", loginSteps: [{ id: "x", type: "capture" }], baseUrl: "http://127.0.0.1:1/" },
    { runImpl: async () => ({ ok: true }), launchBrowser: async () => ({}), outputRoot: path.join(root, "output"), workspaceRoot: root },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "credential-not-found");
  assert.match(result.error.message, new RegExp(CREDENTIALS_FILE));
});

test("bootstrap refuses without login steps rather than inventing a login", async (t) => {
  const root = tempWorkspace(t);
  const result = await bootstrapAuthProfile(
    { profile: "p", baseUrl: "http://127.0.0.1:1/" },
    { runImpl: async () => ({ ok: true }), launchBrowser: async () => ({}), outputRoot: path.join(root, "output"), workspaceRoot: root },
  );
  assert.equal(result.error.code, "login-steps-missing");
  assert.match(result.error.message, /deliberately has no built-in idea/);
});

test("an invalid profile name is rejected", async () => {
  const result = await bootstrapAuthProfile({ profile: "../../etc/passwd" }, {});
  assert.equal(result.error.code, "invalid-profile");
});

// --- Z-F: the real bootstrap + permission difference -------------------------

test("F-1/F-2: bootstrap creates a usable restricted profile and reports its coverage", async (t) => {
  const app = await startLoginApp();
  t.after(() => app.server.close());
  const root = tempWorkspace(t);
  const outputRoot = path.join(root, "output");
  fs.writeFileSync(
    path.join(root, CREDENTIALS_FILE),
    JSON.stringify({ limited: { username: "limited", password: "pw" } }),
  );

  // F-2: before bootstrap the profile does not resolve — knowable up front,
  // rather than failing halfway through tonight's batch.
  const before = await getAuthProfileStatus("demo-limited", { outputRoot });
  assert.equal(before.ok, false);
  assert.equal(before.error.code, "auth-missing");

  const result = await bootstrapAuthProfile(
    {
      profile: "demo-limited",
      credentialRef: "limited",
      baseUrl: `${app.url}/login`,
      loginSteps: [
        { id: "user", type: "fill", target: { testId: "login-user" }, value: "{{username}}" },
        { id: "pass", type: "fill", target: { testId: "login-pass" }, value: "{{password}}" },
        {
          id: "submit",
          type: "click",
          target: { testId: "login-submit" },
          expectation: { kind: "assertDom", target: { testId: "who" }, property: "text", operator: "equals", expected: "limited", timeoutMs: 8000 },
        },
      ],
    },
    {
      runImpl: run,
      launchBrowser: launchSharedBrowser,
      outputRoot,
      outputRunsRoot: path.join(outputRoot, "runs"),
      workspaceRoot: root,
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result.error || result));
  assert.equal(result.profile, "demo-limited");
  assert.ok(fs.existsSync(result.storageStatePath));
  assert.ok(result.coveredHosts.length >= 1, JSON.stringify(result.coveredHosts));
  assert.equal(result.cookieCount >= 1, true);
  // F-3: the response reports field names, never values.
  assert.deepEqual(result.credential, { ref: "limited", fields: [{ field: "username", secret: false }, { field: "password", secret: true }] });
  assert.equal(JSON.stringify(result).includes("pw\""), false);

  // The profile now resolves, so preflight/get_auth_status can vouch for it.
  const after = await getAuthProfileStatus("demo-limited", { outputRoot });
  assert.equal(after.ok, true);

  // F-1: running as that identity, "the export entry is absent" is true.
  const asLimited = await run(
    [
      {
        id: "assert-no-export",
        type: "assertDom",
        stepTitle: "assert 受限账号看不到导出入口",
        target: { testId: "demo-export-btn" },
        property: "exists",
        expected: false,
        timeoutMs: 4000,
      },
    ],
    {
      url: `${app.url}/app`,
      headless: true,
      storageStatePath: result.storageStatePath,
      outputDir: path.join(outputRoot, "runs"),
      runId: "as-limited",
      evidenceProfile: "fast",
    },
  );
  assert.equal(asLimited.ok, true, JSON.stringify(asLimited.data?.results?.[0]?.error));
});

test("bootstrap does NOT save a profile when the login left no credential", async (t) => {
  const app = await startLoginApp();
  t.after(() => app.server.close());
  const root = tempWorkspace(t);
  const outputRoot = path.join(root, "output");
  const result = await bootstrapAuthProfile(
    {
      profile: "never-logged-in",
      baseUrl: `${app.url}/login`,
      // A "login" that touches nothing: the flow runs, no cookie is set.
      loginSteps: [{ id: "noop", type: "capture", stepTitle: "什么都不做" }],
    },
    {
      runImpl: run,
      launchBrowser: launchSharedBrowser,
      outputRoot,
      outputRunsRoot: path.join(outputRoot, "runs"),
      workspaceRoot: root,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "auth-not-established");
  // An empty profile would fail at the first business step of every case tonight,
  // far away from here — so it is not written at all.
  assert.equal(fs.existsSync(path.join(outputRoot, "auth-profiles", "never-logged-in", "storageState.json")), false);
});

test("an existing profile is refused rather than clobbered unless force is set", async (t) => {
  const root = tempWorkspace(t);
  const outputRoot = path.join(root, "output");
  const dir = path.join(outputRoot, "auth-profiles", "existing");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "storageState.json"),
    JSON.stringify({ cookies: [{ name: "a", value: "b", domain: "x.test", path: "/" }], origins: [] }),
  );
  const result = await bootstrapAuthProfile(
    { profile: "existing", loginSteps: [{ id: "x", type: "capture" }], baseUrl: "http://127.0.0.1:1/" },
    { runImpl: async () => ({ ok: true }), launchBrowser: async () => ({}), outputRoot, workspaceRoot: root },
  );
  assert.equal(result.error.code, "profile-exists");
  assert.match(result.error.message, /force:true/);
  assert.equal(result.existing.cookieCount, 1);
});

// --- Z-F: the matrix table ---------------------------------------------------

test("normalizeAuthMatrix accepts plain names and labelled entries", () => {
  assert.deepEqual(normalizeAuthMatrix(["a", " b "]), [{ profile: "a" }, { profile: "b" }]);
  assert.deepEqual(normalizeAuthMatrix([{ profile: "c", label: "管理员" }]), [{ profile: "c", label: "管理员" }]);
  assert.deepEqual(normalizeAuthMatrix(null), []);
  assert.deepEqual(normalizeAuthMatrix([{ profile: "" }]), []);
});

test("F-4: the identity comparison table says who saw what, per case", () => {
  const table = buildAuthMatrixTable([
    {
      profile: "app-admin",
      caseResults: [
        { caseId: "case-export", result: { ok: true } },
        { caseId: "case-list", result: { ok: true } },
      ],
    },
    {
      profile: "demo-limited",
      caseResults: [
        { caseId: "case-export", result: { ok: false, error: { code: "expectation-not-met" } } },
        { caseId: "case-list", result: { ok: true } },
      ],
    },
  ]);
  assert.deepEqual(table.profiles, ["app-admin", "demo-limited"]);
  const exportRow = table.rows.find((row) => row.caseId === "case-export");
  assert.deepEqual(
    exportRow.cells.map((cell) => [cell.profile, cell.verdict]),
    [["app-admin", "green"], ["demo-limited", "red"]],
  );
  assert.equal(exportRow.differs, true);
  assert.equal(table.rows.find((row) => row.caseId === "case-list").differs, false);
  // Differing identities are usually the POINT of a permission matrix, so the
  // table reports and never auto-fails.
  assert.match(table.note, /不自动判失败/);
});

test("a case that did not run for one identity is 'not-run', not 'green'", () => {
  const table = buildAuthMatrixTable([
    { profile: "a", caseResults: [{ caseId: "c1", result: { ok: true } }] },
    { profile: "b", caseResults: [] },
  ]);
  assert.equal(table.rows[0].cells[1].verdict, "not-run");
});

// --- Z-P ---------------------------------------------------------------------

test("testids are extracted from both target.testId and [data-testid=...] locators", () => {
  const ids = extractTestIds(
    JSON.stringify({ target: { testId: "a-btn", locator: '[data-testid="b-table"] tbody tr' } }),
  );
  assert.deepEqual([...ids].sort(), ["a-btn", "b-table"]);
});

test("P-1/P-2: the graph joins test files, run history and the front-end inventory", async (t) => {
  const root = tempWorkspace(t);
  const workflows = path.join(root, "test-workflows");
  const runsRoot = path.join(root, "output", "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  // Two files touching the same component from different entries.
  fs.writeFileSync(
    path.join(workflows, "a.json"),
    JSON.stringify({
      id: "file-a",
      cases: [
        {
          id: "case-rule",
          name: "规则维护弹窗",
          steps: [{ id: "s1", type: "click", target: { testId: "demo-size-rule-part-list" } }],
        },
      ],
    }),
  );
  fs.mkdirSync(path.join(workflows, "nested"), { recursive: true });
  fs.writeFileSync(
    path.join(workflows, "nested", "b.json"),
    JSON.stringify({
      id: "file-b",
      cases: [
        {
          id: "case-edit",
          name: "编辑字段表",
          // Also exercises the consistencyGroup probe path.
          consistencyGroup: {
            probes: [
              { name: "编辑", steps: [{ id: "p1", type: "assertDom", target: { testId: "demo-size-rule-part-list" } }] },
            ],
          },
          steps: [{ id: "s1", type: "fill", target: { testId: "demo-tolerance-input-number" }, value: "1" }],
        },
      ],
    }),
  );

  // A run history where one testid kept failing to resolve.
  const runDir = path.join(runsRoot, "20260825-000000-000-r1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({
      generatedAt: 1,
      testContext: { testFileId: "file-a" },
      environmentFingerprint: { baseUrl: "http://app.test/demo/rule" },
      steps: [
        { status: "failed", code: "target-not-found", message: "target-not-found", expectation: null, title: "x",
          input: { target: { testId: "demo-ghost-btn" } } },
        { status: "passed", input: { target: { testId: "demo-size-rule-part-list" } } },
      ],
    }),
  );

  // The front-end inventory declares one entry nobody ever tested.
  const inventoryPath = path.join(root, "ui-contract.json");
  fs.writeFileSync(
    inventoryPath,
    JSON.stringify({
      components: {
        SizeRulePartList: [
          { testId: "demo-size-rule-part-list", routes: ["/demo/rule", "/demo/edit", "/demo/view"] },
        ],
        NeverTested: ["demo-never-reached-btn"],
      },
    }),
  );

  const contract = await buildUiContract({
    testWorkflowsRoot: workflows,
    outputRunsRoot: runsRoot,
    frontendInventoryPath: inventoryPath,
  });

  assert.equal(contract.completeness, "full");
  assert.equal(contract.sources.testFiles.parsed, 2);
  assert.equal(contract.sources.frontendInventory.testIds, 2);

  // P-1: which entry points use this component.
  const component = findComponentEntries(contract, "SizeRulePartList");
  assert.deepEqual(component.testIds, ["demo-size-rule-part-list"]);
  assert.deepEqual(
    component.entries.map((entry) => entry.caseId).sort(),
    ["case-edit", "case-rule"],
  );

  // P-2: the blind-spot map.
  assert.deepEqual(contract.blindSpots.declaredButNeverUsed, ["demo-never-reached-btn"]);
  assert.ok(contract.blindSpots.usedButNotDeclared.includes("demo-tolerance-input-number"));
  // A testid that keeps failing to resolve is a drifted contract, not a flake.
  assert.deepEqual(
    contract.blindSpots.unstable.map((item) => item.testId),
    ["demo-ghost-btn"],
  );

  // Reached routes come from history.
  assert.equal(contract.routes[0].route, "/demo/rule");
  assert.deepEqual(contract.routes[0].testFileIds, ["file-a"]);
  assert.ok(contract.summary.testIds >= 4);
});

test("without a front-end inventory the graph still works and says what it cannot answer", async (t) => {
  const root = tempWorkspace(t);
  const workflows = path.join(root, "test-workflows");
  fs.writeFileSync(
    path.join(workflows, "a.json"),
    JSON.stringify({ id: "f", cases: [{ id: "c", steps: [{ id: "s", type: "click", target: { testId: "x-btn" } }] }] }),
  );
  const contract = await buildUiContract({ testWorkflowsRoot: workflows, outputRunsRoot: null });
  assert.match(contract.completeness, /^history-only/);
  assert.deepEqual(contract.blindSpots.declaredButNeverUsed, []);
  assert.equal(contract.testIds.find((item) => item.testId === "x-btn").caseCount, 1);
  // A capability that only works once another team ships a file is a capability
  // nobody uses — so it degrades instead of erroring.
  assert.equal(contract.sources.frontendInventory, null);
});

test("a declared-but-untested component answers honestly rather than 'consistent'", async (t) => {
  const root = tempWorkspace(t);
  const inventoryPath = path.join(root, "ui-contract.json");
  fs.writeFileSync(inventoryPath, JSON.stringify({ components: { Lonely: ["lonely-btn"] } }));
  const contract = await buildUiContract({
    testWorkflowsRoot: path.join(root, "test-workflows"),
    frontendInventoryPath: inventoryPath,
  });
  const result = findComponentEntries(contract, "Lonely");
  assert.deepEqual(result.entries, []);
  assert.match(result.note, /覆盖盲区/);
});

test("the inventory reader tolerates the three shapes the exporter may emit", async (t) => {
  const root = tempWorkspace(t);
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  assert.equal((await readFrontendInventory(write("a.json", ["x", "y"]))).entries.size, 2);
  assert.equal((await readFrontendInventory(write("b.json", { testIds: [{ testId: "z" }] }))).entries.size, 1);
  assert.equal((await readFrontendInventory(write("c.json", { components: { C: ["q"] } }))).entries.size, 1);
  assert.equal(await readFrontendInventory(write("d.json", { unexpected: true })), null);
  assert.equal(await readFrontendInventory(path.join(root, "missing.json")), null);
});
