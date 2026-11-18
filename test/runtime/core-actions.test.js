const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { run } = require("../../runtime");

function createFixtureServer() {
  const fixture = fs.readFileSync(path.join(process.cwd(), "static", "core-actions-fixture.html"));
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/demo/detail")) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        success: true,
        data: {
          status: 8,
          phaseDone: true,
          spuTempNo: "SPU-CAPTURE-001",
        },
      }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/?expanded=1`,
      });
    });
  });
}

function createTokenApiFixtureServer() {
  const fixture = `<!doctype html>
    <html>
      <body>
        <main>Token API fixture</main>
        <script>
          window.localStorage.setItem("_TOKEN_", "local-storage-token");
        </script>
      </body>
    </html>`;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/needs-token")) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      if (req.headers.token !== "local-storage-token") {
        res.statusCode = 405;
        res.end(JSON.stringify({ success: false, message: "Token is missing" }));
        return;
      }
      res.end(JSON.stringify({ success: true, data: { authed: true } }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

function createSharedUploadFixtureServer() {
  const fixture = `<!doctype html>
    <html>
      <body>
        <section>
          <div data-testid="demo-create-task-upload-trigger-正面图" data-upload-category="正面图">添加图片</div>
          <div data-testid="demo-create-task-upload-trigger-侧面图" data-upload-category="侧面图">添加图片</div>
          <div data-testid="demo-create-task-upload-trigger-版单图" data-upload-category="版单图">添加图片</div>
          <input id="shared-upload-input" type="file" hidden />
          <div id="front-upload-state">正面图未上传</div>
          <div id="side-upload-state">侧面图未上传</div>
          <div id="pattern-upload-state">版单图未上传</div>
        </section>
        <script>
          const input = document.getElementById("shared-upload-input");
          const states = {
            "正面图": document.getElementById("front-upload-state"),
            "侧面图": document.getElementById("side-upload-state"),
            "版单图": document.getElementById("pattern-upload-state"),
          };
          document.querySelectorAll("[data-upload-category]").forEach((trigger) => {
            trigger.addEventListener("click", () => {
              input.dataset.category = trigger.dataset.uploadCategory;
              input.value = "";
              input.click();
            });
          });
          input.addEventListener("change", () => {
            const category = input.dataset.category || "正面图";
            states[category].textContent = category + "已上传";
          });
        </script>
      </body>
    </html>`;
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

function createCollapsedMenuFixtureServer() {
  const fixture = `<!doctype html>
    <html>
      <head>
        <style>
          .antc-menu-inline-collapsed {
            width: 56px;
            padding: 0;
            list-style: none;
          }
          .antc-menu-item {
            width: 48px;
            height: 40px;
            line-height: 40px;
            cursor: pointer;
          }
          .antc-menu-title-content {
            display: none;
          }
        </style>
      </head>
      <body>
        <ul class="antc-menu antc-menu-inline antc-menu-inline-collapsed">
          <li class="antc-menu-item" role="menuitem" data-testid="collapsed-demo-menu">
            <span class="antc-menu-item-icon" aria-hidden="true">◎</span>
            <span class="antc-menu-title-content">示例任务</span>
          </li>
        </ul>
        <main id="status">未进入</main>
        <script>
          document.querySelector("[data-testid='collapsed-demo-menu']").addEventListener("click", () => {
            document.getElementById("status").textContent = "已进入示例任务";
          });
        </script>
      </body>
    </html>`;
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

function createLoginTabFixtureServer() {
  const fixture = `<!doctype html>
    <html>
      <head>
        <style>
          .login-tab {
            display: inline-block;
            padding: 8px 12px;
            cursor: pointer;
          }
          .qr-login {
            margin-top: 40px;
          }
        </style>
      </head>
      <body>
        <div class="login-tabs" aria-label="登录方式">
          <div class="login-tab" id="scan-login-tab">扫码登陆</div>
          <div class="login-tab" id="account-login-tab">账号登陆</div>
        </div>
        <section class="qr-login">
          <strong>企业微信扫码登录</strong>
          <p>请使用企业微信扫描二维码登录</p>
        </section>
        <main id="login-mode">扫码登录</main>
        <script>
          document.getElementById("account-login-tab").addEventListener("click", () => {
            document.getElementById("login-mode").textContent = "账号登陆已选中";
          });
        </script>
      </body>
    </html>`;
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

function createDelayedLoginTabFixtureServer() {
  const fixture = `<!doctype html>
    <html>
      <head>
        <style>
          .login-tab {
            display: inline-block;
            padding: 8px 12px;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <main id="login-root">登录</main>
        <script>
          setTimeout(() => {
            document.getElementById("login-root").innerHTML = [
              '<div class="login-tabs" aria-label="登录方式">',
              '<div class="login-tab" id="scan-login-tab">扫码登陆</div>',
              '<div class="login-tab" id="account-login-tab">账号登陆</div>',
              '</div>',
              '<main id="login-mode">扫码登录</main>'
            ].join("");
            document.getElementById("account-login-tab").addEventListener("click", () => {
              document.getElementById("login-mode").textContent = "账号登陆已选中";
            });
          }, 1200);
        </script>
      </body>
    </html>`;
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

test("runtime executes icon-only click, fill, search select, upload, assert, and capture", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: {
          strategy: "auto",
          role: "button",
          ariaLabel: "新增",
          title: "新增",
          iconHint: "add",
          nearText: "示例任务任务",
        },
        needRes: true,
      },
      {
        type: "fill",
        target: {
          strategy: "label",
          name: "任务名称",
        },
        value: "打样任务A",
        needRes: true,
      },
      {
        type: "comboSearchSelect",
        target: {
          strategy: "role",
          role: "combobox",
          name: "项目成员",
        },
        query: "示例团队",
        option: {
          text: "示例团队测试项目成员",
          match: "contains",
        },
        needRes: true,
      },
      {
        type: "uploadFile",
        target: {
          strategy: "label",
          name: "上传图片",
        },
        files: [{ path: "test-assets/demo/fixture.png" }],
        mode: "input",
        needRes: true,
      },
      {
        type: "assertVisible",
        query: "上传成功",
        needRes: true,
      },
      {
        type: "capture",
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "core-actions",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.okCount, 6);

  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const traces = report.evidence.steps
    .map((step) => step?.tracePath)
    .filter(Boolean)
    .map((tracePath) => JSON.parse(fs.readFileSync(tracePath, "utf8")));

  assert.equal(traces[0].normalizedTarget.ariaLabel, "新增");
  assert.equal(traces[2].popupTrace.option.text, "示例团队测试项目成员");
  assert.equal(traces[3].inputArtifacts.files[0].path, "test-assets/demo/fixture.png");
  assert.equal(traces[5].actionDefinition.needsTarget, false);
  assert.equal(traces[2].actionResult.detail, "combo-search-select");
  assert.equal(traces[3].actionResult.inputArtifacts.files[0].path, "test-assets/demo/fixture.png");
  assert.equal(typeof traces[5].durationMs, "number");
  assert.equal(traces[5].retrySummary.attempts, 1);
});

test("click resolves collapsed Ant menu item by hidden title content", async () => {
  const { server, url } = await createCollapsedMenuFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  try {
    const result = await run(
      {
        type: "click",
        target: {
          text: "示例任务",
        },
        expectation: {
          kind: "text-exists",
          text: "已进入示例任务",
          timeoutMs: 1000,
        },
        needRes: true,
        timeoutMs: 1000,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "collapsed-ant-menu-click",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
    assert.equal(trace.selectedLocatorStrategy, "dom:ant-menu-collapsed-text");
    assert.equal(trace.actionResult.detail, "locator-click");
    assert.match(result.data.snapshot.after.text, /已进入示例任务/);
  } finally {
    server.close();
  }
});

test("click resolves declared tab role through DOM before OCR fallback", async () => {
  const { server, url } = await createLoginTabFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  try {
    const result = await run(
      {
        type: "click",
        target: {
          text: "账号登陆",
          name: "账号登陆",
          role: "tab",
          strategy: "auto",
        },
        expectation: {
          kind: "text-exists",
          text: "账号登陆已选中",
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
        timeoutMs: 1000,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "login-tab-dom-role",
      },
    );

    assert.equal(result.ok, true);
    assert.match(result.data.snapshot.after.text, /账号登陆已选中/);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
    assert.match(trace.selectedLocatorStrategy, /^dom:/);
    assert.notEqual(trace.selectedLocatorStrategy?.startsWith("ocr:"), true);
    assert.equal(trace.selectedCandidate.text, "账号登陆");
    assert.equal(trace.domSummary.before.interactableCount, 2);
  } finally {
    server.close();
  }
});

test("click retries target resolution when the initial page snapshot has no interactables", async () => {
  const { server, url } = await createDelayedLoginTabFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  try {
    const result = await run(
      {
        type: "click",
        target: {
          text: "账号登陆",
          name: "账号登陆",
          role: "tab",
          strategy: "auto",
        },
        expectation: {
          kind: "text-exists",
          text: "账号登陆已选中",
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
        timeoutMs: 5000,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "delayed-login-tab-resolve-retry",
      },
    );

    assert.equal(result.ok, true);
    assert.match(result.data.snapshot.after.text, /账号登陆已选中/);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
    assert.equal(trace.targetResolveRetry.reason, "empty-page-before-resolve");
    assert.equal(trace.targetResolveRetry.retrySuccess, true);
    assert.match(trace.selectedLocatorStrategy, /^dom:/);
    assert.notEqual(trace.selectedLocatorStrategy?.startsWith("ocr:"), true);
    assert.equal(trace.domSummary.before.interactableCount > 0, true);
  } finally {
    server.close();
  }
});

test("fill reports target-not-found instead of crashing when target cannot be resolved", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "fill",
      target: {
        strategy: "label",
        name: "不存在的输入框",
      },
      value: "anything",
      needRes: true,
      timeoutMs: 800,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "fill-missing-target",
    },
  );

  assert.equal(result.ok, false);
  assert.ok(["target-not-found", "low-confidence-target"].includes(result.error.code));
  assert.notEqual(result.error.message, "Cannot read properties of null (reading 'source')");
});

test("runtime executes hover, press, check, uncheck, native select, url, and count actions", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString()}?expanded=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "assertUrl",
        urlIncludes: "core-actions-fixture.html",
        needRes: true,
      },
      {
        type: "click",
        target: {
          ariaLabel: "新增",
        },
        needRes: false,
      },
      {
        type: "hover",
        target: {
          role: "button",
          text: "查看提示",
        },
        expectation: {
          kind: "text-exists",
          text: "悬停提示已显示",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "check",
        target: {
          text: "同意创建规则",
        },
        expectation: {
          kind: "text-exists",
          text: "规则已勾选",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "uncheck",
        target: {
          text: "同意创建规则",
        },
        expectation: {
          kind: "text-exists",
          text: "规则未勾选",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "selectOption",
        target: {
          name: "任务优先级",
        },
        option: {
          value: "P1",
        },
        expectation: {
          kind: "text-exists",
          text: "已选择P1",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "press",
        target: {
          ariaLabel: "快捷键输入",
        },
        key: "Enter",
        needRes: true,
      },
      {
        type: "assertCount",
        target: {
          locator: ".count-item",
        },
        count: 2,
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "expanded-core-actions",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.okCount, 8);

  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  assert.equal(report.summary.data.results[0].data.expectation.type, "expectUrl");
  assert.equal(report.summary.data.results[7].data.expectation.type, "expectCount");
  assert.equal(report.summary.data.results[7].data.expectation.actual, 2);
});

test("fill maps account intent to loginName instead of password input", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString()}?expanded=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: {
          ariaLabel: "新增",
        },
        needRes: false,
      },
      {
        type: "fill",
        target: {
          name: "账号",
        },
        value: "demo-user",
        expectation: {
          kind: "text-exists",
          text: "账号已填:demo-user",
          timeoutMs: 1000,
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "fill-account-login-name",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.okCount, 2);

  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const fillTrace = JSON.parse(fs.readFileSync(report.evidence.steps[1].tracePath, "utf8"));
  assert.equal(fillTrace.selectedLocatorStrategy, "dom:type-heuristic");
  assert.equal(fillTrace.selectedCandidate.idAttr, "loginName");
  assert.notEqual(fillTrace.selectedCandidate.inputType, "password");
});

test("runtime variables keep fill value and expectation text in sync", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: {
          ariaLabel: "新增",
        },
        needRes: false,
      },
      {
        type: "fill",
        target: {
          name: "任务名称",
        },
        value: "自动化测试-{{$timestamp}}-{{$runId}}",
        expectation: {
          kind: "text-exists",
          text: "自动化测试-{{$timestamp}}-{{$runId}}",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "assertVisible",
        target: {
          text: "自动化测试-{{$timestamp}}-{{$runId}}",
          scope: {
            testId: "task-result-table",
          },
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "runtime-vars",
      runtimeVariables: {
        timestamp: "20260608-143022",
      },
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  assert.equal(report.runtimeVariables.timestamp, "20260608-143022");
  assert.equal(report.runtimeVariables.runId, "runtime-vars");
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[1].tracePath, "utf8"));
  assert.equal(trace.input.value, "自动化测试-20260608-143022-runtime-vars");
  assert.deepEqual(
    report.summary.data.results[1].data.expectation.matched,
    ["自动化测试-20260608-143022-runtime-vars"],
  );
  const assertTrace = JSON.parse(fs.readFileSync(report.evidence.steps[2].tracePath, "utf8"));
  assert.equal(assertTrace.selectedLocatorStrategy, null);
  assert.deepEqual(report.summary.data.results[2].data.expectation.scope, {
    nearText: "",
    role: "",
    locator: "",
    testId: "task-result-table",
  });
});

test("assertVisible with target scope fails when text only exists outside the scope", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "assertVisible",
      target: {
        text: "只在外部出现",
        scope: {
          testId: "task-result-table",
        },
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "scoped-assert-visible-missing",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "expectation-not-met");
  assert.deepEqual(result.error.details.expectation.missing, ["只在外部出现"]);
});

test("fill resolves duplicate placeholders inside target scope only", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "fill",
      target: {
        placeholder: "重复输入",
        value: "scoped-beta",
        scope: {
          testId: "scope-beta",
        },
      },
      expectation: {
        kind: "text-exists",
        text: "B:scoped-beta",
        scope: {
          testId: "scope-beta",
        },
        timeoutMs: 1000,
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "scoped-fill-placeholder",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "scoped:accessibility:placeholder");
  assert.equal(trace.selectedCandidate.scope.testId, "scope-beta");
  assert.match(result.data.snapshot.after.text, /A 未点击/);
});

test("click resolves duplicate text buttons inside target scope only", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "click",
      target: {
        text: "重复按钮",
        scope: {
          locator: "[data-testid='scope-beta']",
        },
      },
      expectation: {
        kind: "text-exists",
        text: "B 已点击",
        scope: {
          testId: "scope-beta",
        },
        timeoutMs: 1000,
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "scoped-click-button",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "scoped:dom:role-button");
  assert.equal(trace.selectedCandidate.scope.locator, "[data-testid='scope-beta']");
  assert.match(result.data.snapshot.after.text, /A 未点击/);
});

test("target scope is a hard boundary and does not fall back to the full page", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "click",
      target: {
        text: "新增",
        scope: {
          testId: "scope-beta",
        },
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "scoped-hard-boundary",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "action-target-unresolved");
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "scoped:not-found");
  assert.equal(trace.selectedCandidate.scope.testId, "scope-beta");
  assert.equal(trace.candidateListTopN.length, 0);
});

test("upload file resolves duplicate add-image buttons by nearText", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const file = { path: "test-assets/demo/fixture.png" };

  const result = await run(
    [
      {
        type: "click",
        target: {
          ariaLabel: "新增",
        },
        needRes: false,
      },
      {
        type: "uploadFile",
        target: {
          role: "button",
          name: "添加图片",
          nearText: "正面图",
          iconHint: "add",
        },
        files: [file],
        mode: "input",
        expectation: {
          kind: "text-exists",
          text: "正面图已上传",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "uploadFile",
        target: {
          role: "button",
          name: "添加图片",
          nearText: "侧面图",
          iconHint: "add",
        },
        files: [file],
        mode: "input",
        expectation: {
          kind: "text-exists",
          text: "侧面图已上传",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "uploadFile",
        target: {
          role: "button",
          name: "添加图片",
          nearText: "版单图",
          iconHint: "add",
        },
        files: [file],
        mode: "input",
        expectation: {
          kind: "text-exists",
          text: "版单图已上传",
          timeoutMs: 1000,
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "upload-near-text",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.okCount, 4);

  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const traces = report.evidence.steps
    .slice(1)
    .map((step) => JSON.parse(fs.readFileSync(step.tracePath, "utf8")));
  assert.deepEqual(
    traces.map((trace) => trace.selectedCandidate.nearText),
    ["正面图", "侧面图", "版单图"],
  );
  assert.ok(traces.every((trace) => trace.selectedCandidate.nearTextMatched));
  assert.ok(traces.every((trace) => trace.selectedLocatorStrategy === "dom:file-input-near-text"));
  assert.ok(
    traces.every((trace) =>
      String(trace.selectedCandidate.nearTextMatchMethod || "").startsWith("file-input-context"),
    ),
  );
});

test("upload file resolves hidden file inputs by nearText when trigger is not a button", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const file = { path: "test-assets/demo/fixture.png" };

  const result = await run(
    [
      {
        type: "click",
        target: {
          ariaLabel: "新增",
        },
        needRes: false,
      },
      {
        type: "uploadFile",
        target: {
          role: "button",
          name: "添加图片",
          nearText: "窄屏正面图",
          iconHint: "add",
        },
        files: [file],
        mode: "input",
        expectation: {
          kind: "text-exists",
          text: "窄屏正面图已上传",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "uploadFile",
        target: {
          role: "button",
          name: "添加图片",
          nearText: "窄屏侧面图",
          iconHint: "add",
        },
        files: [file],
        mode: "input",
        expectation: {
          kind: "text-exists",
          text: "窄屏侧面图已上传",
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        type: "uploadFile",
        target: {
          role: "button",
          name: "添加图片",
          nearText: "窄屏版单图",
          iconHint: "add",
        },
        files: [file],
        mode: "input",
        expectation: {
          kind: "text-exists",
          text: "窄屏版单图已上传",
          timeoutMs: 1000,
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "upload-hidden-input-near-text",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.okCount, 4);

  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const traces = report.evidence.steps
    .slice(1)
    .map((step) => JSON.parse(fs.readFileSync(step.tracePath, "utf8")));
  assert.deepEqual(
    traces.map((trace) => trace.selectedLocatorStrategy),
    [
      "dom:file-input-near-text",
      "dom:file-input-near-text",
      "dom:file-input-near-text",
    ],
  );
  assert.deepEqual(
    traces.map((trace) => trace.selectedCandidate.nearText),
    ["窄屏正面图", "窄屏侧面图", "窄屏版单图"],
  );
  assert.ok(traces.every((trace) => trace.selectedCandidate.nearTextMatched));
});

test("upload file chooser mode clicks the matched trigger before using a shared file input", async () => {
  const { server, url } = await createSharedUploadFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const file = { path: "test-assets/demo/fixture.png" };

  try {
    const result = await run(
      [
        {
          id: "step-upload-front-image",
          type: "uploadFile",
          target: { strategy: "auto", testId: "demo-create-task-upload-trigger-正面图" },
          files: [file],
          mode: "chooser",
          expectation: {
            kind: "text-exists",
            text: "正面图已上传",
            timeoutMs: 1000,
          },
          needRes: true,
        },
        {
          id: "step-upload-side-image",
          type: "uploadFile",
          target: { strategy: "auto", testId: "demo-create-task-upload-trigger-侧面图" },
          files: [file],
          mode: "chooser",
          expectation: {
            kind: "text-exists",
            text: "侧面图已上传",
            timeoutMs: 1000,
          },
          needRes: true,
        },
        {
          id: "step-upload-pattern-image",
          type: "uploadFile",
          target: { strategy: "auto", testId: "demo-create-task-upload-trigger-版单图" },
          files: [file],
          mode: "chooser",
          expectation: {
            kind: "text-exists",
            text: "版单图已上传",
            timeoutMs: 1000,
          },
          needRes: true,
        },
      ],
      {
        url,
        headless: true,
        outputDir,
        runId: "shared-upload-chooser",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.okCount, 3);

    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const traces = report.evidence.steps
      .map((step) => JSON.parse(fs.readFileSync(step.tracePath, "utf8")));
    assert.deepEqual(
      traces.map((trace) => trace.inputArtifacts.mode),
      ["chooser", "chooser", "chooser"],
    );
    assert.deepEqual(
      traces.map((trace) => trace.selectedCandidate.testId),
      [
        "demo-create-task-upload-trigger-正面图",
        "demo-create-task-upload-trigger-侧面图",
        "demo-create-task-upload-trigger-版单图",
      ],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("search select uses the first visible combobox when target name is omitted", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: {
          ariaLabel: "新增",
        },
        needRes: false,
      },
      {
        type: "comboSearchSelect",
        query: "示例团队",
        option: {
          text: "示例团队测试项目成员",
          match: "contains",
        },
        needRes: true,
        timeoutMs: 1000,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-targetless",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.okCount, 2);

  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[1].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.equal(trace.finalStatus, "ok");
  assert.equal(trace.popupTrace.option.text, "示例团队测试项目成员");
});

test("search select clicks the concrete AntD option instead of a page ancestor", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "role",
        role: "combobox",
        name: "负责人",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-ant-option",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[0].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.equal(trace.popupTrace.option.text, "促佳贸易");
  assert.match(trace.popupTrace.optionClick, /click/);
});

test("search select can target a combobox by placeholder text", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-placeholder",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[0].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.equal(trace.normalizedTarget.placeholder, "请输入负责人姓名搜索");
  assert.equal(trace.popupTrace.option.text, "促佳贸易");
});

test("search select reads legacy AntD selected value after option click", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?legacySelectedValue=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-legacy-selected-value",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.match(trace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select reads visible selector text when AntD selected value uses custom markup", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?customSelectedText=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-custom-selected-text",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.match(trace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select waits for delayed selected value after option click", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?selectionDelay=1800`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
      optionWaitTimeoutMs: 3000,
      optionPollIntervalMs: 100,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-delayed-selected-value",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.match(trace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select reads expected selected text rendered next to AntD root", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?externalSelectedText=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-external-selected-text",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.match(trace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select reads expected selected text rendered as a sibling text node", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?externalTextNodeSelected=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-external-text-node",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.match(trace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select reads selected value from marked AntD root after rerender", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?replaceOwnerRootOnSelect=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-marked-root-rerender",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.match(trace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select keeps a stable AntD root locator when the target is already the root", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?replaceOperatorRootAfterMarker=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        locator: "#operator-select",
      },
      query: "促佳",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1200,
      optionWaitTimeoutMs: 1200,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-root-target-stable",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.match(trace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select resolves AntD virtual options when aria listbox is hidden", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        testId: "demo-supply-chain-supplier-select",
      },
      query: "SH000291",
      option: {
        text: "SH000291",
        match: "contains",
      },
      expectation: {
        kind: "text-exists",
        text: "已选择项目成员",
        timeoutMs: 1000,
      },
      needRes: true,
      timeoutMs: 1200,
      optionWaitTimeoutMs: 1500,
      optionPollIntervalMs: 100,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-hidden-aria-listbox",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.equal(trace.actionResult.popupTrace.optionScope, "aria-linked-virtual-list");
  assert.equal(trace.executionPath.optionResolve, "aria-linked-virtual-list");
  assert.match(trace.executionPath.summary, /option:aria-linked-virtual-list/);
  assert.match(trace.popupTrace.selected.actual, /SH000291/);
});

test("search select accepts committed AntD input value after virtual option click", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?supplierValueOnlySelected=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        testId: "demo-supply-chain-supplier-select",
      },
      query: "SH000291",
      option: {
        text: "SH000291",
        match: "contains",
      },
      expectation: {
        kind: "text-exists",
        text: "已选择项目成员",
        timeoutMs: 1000,
      },
      needRes: true,
      timeoutMs: 1200,
      optionWaitTimeoutMs: 1500,
      optionPollIntervalMs: 100,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-input-value-selected",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.success, true);
  assert.equal(trace.actionResult.popupTrace.optionScope, "aria-linked-virtual-list");
  assert.match(trace.popupTrace.selected.actual, /SH000291/);
});

test("search select does not use a stale dropdown from another AntD select", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?brokenOperator=1&staleOwnerDropdown=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请选择或搜索运营",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-stale-dropdown",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "action-failed");
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "explicit:ant-select-placeholder");
  assert.equal(trace.actionResult.error, "selection-not-applied");
  assert.doesNotMatch(trace.actionResult.popupTrace.optionScope, /visible-fallback/);
});

test("search select moves focus before typing into the next AntD select", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "comboSearchSelect",
        target: {
          strategy: "auto",
          placeholder: "请输入负责人姓名搜索",
          nearText: "创建任务任务",
        },
        query: "促",
        option: {
          text: "促佳贸易",
          match: "contains",
        },
        needRes: true,
        timeoutMs: 1000,
      },
      {
        type: "comboSearchSelect",
        target: {
          strategy: "auto",
          placeholder: "请选择或搜索运营",
          nearText: "创建任务任务",
        },
        query: "促",
        option: {
          text: "促佳贸易",
          match: "contains",
        },
        needRes: true,
        timeoutMs: 1000,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-next-focus",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const ownerTrace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  const operatorTrace = JSON.parse(fs.readFileSync(report.evidence.steps[1].tracePath, "utf8"));
  assert.equal(ownerTrace.actionResult.success, true);
  assert.equal(operatorTrace.actionResult.success, true);
  assert.match(operatorTrace.popupTrace.selected.actual, /促佳贸易/);
});

test("search select does not treat AntD search input text as selected value", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?misleadingOperatorInput=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请选择或搜索运营",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-misleading-input",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "action-failed");
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.error, "selection-not-applied");
  assert.equal(trace.actionResult.popupTrace.selected.actual, "");
});

test("search select does not treat hidden AntD selected item as applied value", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?hiddenOperatorSelected=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        strategy: "auto",
        placeholder: "请选择或搜索运营",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-hidden-selected-item",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "action-failed");
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.actionResult.error, "selection-not-applied");
  assert.equal(trace.actionResult.popupTrace.selected.actual, "");
});

test("search select resolves duplicate placeholder inside target scope", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        placeholder: "请输入负责人姓名搜索",
        scope: {
          locator: ".dialog",
          nearText: "创建任务任务",
        },
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-scoped-placeholder",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "scoped:explicit:ant-select-placeholder");
  assert.equal(trace.selectedCandidate.scope.locator, ".dialog");
  assert.equal(trace.selectedCandidate.scope.nearText, "创建任务任务");
  assert.equal(trace.popupTrace.option.text, "促佳贸易");
});

test("search select accepts unique AntD placeholder inside scope even when near text names the modal", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
        scope: {
          locator: ".dialog",
        },
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-scoped-modal-near-text",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "scoped:explicit:ant-select-placeholder");
  assert.equal(trace.selectedCandidate.scope.locator, ".dialog");
  assert.equal(trace.selectedCandidate.nearText, "创建任务任务");
  assert.equal(trace.selectedCandidate.nearTextMatched, false);
  assert.equal(trace.popupTrace.option.text, "促佳贸易");
});

test("search select treats Ant select placeholder text as a high-confidence target", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      id: "step-33",
      target: {
        name: "请输入负责人姓名搜索",
        placeholder: "请输入负责人姓名搜索",
        strategy: "auto",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳",
        value: "促佳贸易",
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
      strictMatch: false,
      enableScroll: false,
      expectation: {
        kind: "text-absent",
        text: ["请输入负责人姓名搜索"],
      },
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-ant-placeholder",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[0].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.equal(trace.normalizedTarget.placeholder, "请输入负责人姓名搜索");
  assert.equal(trace.selectedLocatorStrategy, "explicit:ant-select-placeholder");
  assert.ok(trace.resolverPipeline[0].confidence >= 0.9);
  assert.equal(trace.popupTrace.option.text, "促佳");
  assert.match(result.data.snapshot.after.text, /促佳贸易/);
});

test("search select waits for delayed async options before clicking", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?delay=700`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "comboSearchSelect",
      target: {
        name: "请输入负责人姓名搜索",
        placeholder: "请输入负责人姓名搜索",
        nearText: "创建任务任务",
      },
      query: "促",
      option: {
        text: "促佳贸易",
        match: "contains",
      },
      optionWaitTimeoutMs: 1500,
      optionPollIntervalMs: 100,
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "search-select-delayed-option",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[0].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.equal(trace.popupTrace.optionWait.timeoutMs, 1500);
  assert.equal(trace.popupTrace.optionWait.pollIntervalMs, 100);
  assert.ok(trace.popupTrace.optionScopeWait.attempts > 1);
  assert.match(result.data.snapshot.after.text, /促佳贸易/);
});

test("cascader select chooses a multi-level AntD option path", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "cascaderSelect",
      target: {
        name: "请选择类目",
        placeholder: "请选择类目",
        nearText: "创建任务任务",
      },
      option: {
        path: ["女士服装", "婚礼及活动", "花童 礼服"],
        match: "contains",
      },
      optionWaitTimeoutMs: 1500,
      optionPollIntervalMs: 100,
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "cascader-select-path",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[0].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "explicit:ant-cascader-placeholder");
  assert.deepEqual(trace.popupTrace.cascaderPath, ["女士服装", "婚礼及活动", "花童 礼服"]);
  assert.equal(trace.popupTrace.clicked.length, 3);
  assert.equal(trace.popupTrace.expansionProbes.length, 2);
  assert.equal(trace.popupTrace.expansionProbes.every((item) => item.expanded === false), true);
  assert.match(result.data.snapshot.after.text, /女士服装 \/ 婚礼及活动 \/ 花童 礼服/);
});

test("cascader select expands intermediate levels by hover before clicking leaf", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?cascader=hover`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "cascaderSelect",
      target: {
        name: "请选择类目",
        placeholder: "请选择类目",
        nearText: "创建任务任务",
      },
      option: {
        path: ["女士服装", "婚礼及活动", "花童 礼服"],
        match: "contains",
      },
      optionWaitTimeoutMs: 1500,
      optionPollIntervalMs: 100,
      needRes: true,
      timeoutMs: 1000,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "cascader-select-hover-path",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[0].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.deepEqual(trace.popupTrace.clicked.map((item) => item.clickMode), [
    "hover-expand",
    "hover-expand",
    "locator-click",
  ]);
  assert.equal(trace.popupTrace.expansionProbes.every((item) => item.expanded === true), true);
  assert.match(result.data.snapshot.after.text, /女士服装 \/ 婚礼及活动 \/ 花童 礼服/);
});

test("cascader select resolves repeated labels by menu level", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-ant-select-fixture.html"),
  ).toString()}?cascader=hover`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "cascaderSelect",
      target: {
        name: "请选择类目",
        placeholder: "请选择类目",
        strategy: "auto",
        role: "combobox",
      },
      query: "",
      option: {
        path: ["宠物用品", "宠物用品", "猫用品"],
        match: "contains",
      },
      needRes: true,
      timeoutMs: 1000,
      optionWaitTimeoutMs: 1500,
      optionPollIntervalMs: 100,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "cascader-select-repeated-labels",
    },
  );

  assert.equal(result.ok, true);
  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const tracePath = report.evidence.steps[0].tracePath;
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  assert.deepEqual(trace.popupTrace.cascaderPath, ["宠物用品", "宠物用品", "猫用品"]);
  assert.deepEqual(trace.popupTrace.optionWait.waits.map((item) => item.level), [0, 1, 2]);
  assert.match(result.data.snapshot.after.text, /宠物用品 \/ 宠物用品 \/ 猫用品/);
});

test("v0.5 business assertions cover DOM state, callApi, and networkResponse", async () => {
  const { server, url } = await createFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const events = [];
  try {
    const result = await run(
      [
        {
          type: "click",
          target: { locator: "#create-task" },
          needRes: true,
        },
        {
          type: "assertVisible",
          target: { testId: "quick-task-row" },
          expectation: {
            kind: "assertDom",
            target: { testId: "quick-task-row", hasText: "快速任务" },
            property: "attribute",
            attribute: "data-status",
            operator: "equals",
            expected: "8",
            timeoutMs: 1000,
          },
        },
        {
          type: "assertVisible",
          target: { locator: "#dom-value-input" },
          expectation: {
            kind: "assertDom",
            target: { locator: "#dom-value-input" },
            property: "value",
            operator: "equals",
            expected: "待验证",
            timeoutMs: 1000,
          },
        },
        {
          type: "assertVisible",
          target: { locator: "#dom-radio" },
          expectation: {
            kind: "assertDom",
            target: { locator: "#dom-radio" },
            property: "checked",
            expected: true,
            timeoutMs: 1000,
          },
        },
        {
          type: "assertVisible",
          target: { locator: "#disabled-submit" },
          expectation: {
            kind: "assertDom",
            target: { locator: "#disabled-submit" },
            property: "disabled",
            expected: true,
            timeoutMs: 1000,
          },
        },
        {
          type: "callApi",
          request: {
            method: "GET",
            url: "/api/demo/detail",
            headers: {
              authorization: "Bearer secret-token",
            },
          },
          expectation: {
            kind: "assertResponse",
            status: 200,
            body: [
              { path: "data.status", expected: 8 },
              { path: "data.phaseDone", expected: true },
            ],
          },
          needRes: true,
        },
        {
          type: "click",
          target: { locator: "#network-submit" },
          expectation: {
            kind: "networkResponse",
            urlIncludes: "/api/demo/detail",
            status: 200,
            body: [{ path: "data.status", expected: 8 }],
            timeoutMs: 2000,
          },
          needRes: true,
        },
      ],
      {
        url,
        headless: true,
        outputDir,
        runId: "v05-business-assertions",
        onEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.okCount, 7);
    assert.equal(result.data.results[1].data.expectation.type, "expectDom");
    assert.equal(result.data.results[5].data.action.apiResponse.status, 200);
    assert.equal(result.data.results[6].data.expectation.type, "expectNetworkResponse");
    const completedEvents = events.filter((event) => event.type === "step-complete");
    assert.equal(completedEvents.length, 7);
    assert.equal(completedEvents[5].diagnostics.action.apiResponse.status, 200);
    assert.equal(completedEvents[6].diagnostics.expectation.type, "expectNetworkResponse");

    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const apiTrace = JSON.parse(fs.readFileSync(report.evidence.steps[5].tracePath, "utf8"));
    const networkTrace = JSON.parse(fs.readFileSync(report.evidence.steps[6].tracePath, "utf8"));
    assert.equal(apiTrace.expectation.type, "expectResponse");
    assert.equal(apiTrace.actionResult.apiResponse.status, 200);
    assert.equal(apiTrace.actionResult.apiRequest.headers.authorization, "[redacted]");
    assert.equal(typeof apiTrace.durationMs, "number");
    assert.equal(apiTrace.retrySummary.attempts, 1);
    assert.equal(networkTrace.expectation.type, "expectNetworkResponse");
    assert.equal(networkTrace.expectation.observedCount >= 1, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime captures response and DOM values into variables for later steps", async () => {
  const { server, url } = await createFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const events = [];
  try {
    const result = await run(
      [
        {
          type: "click",
          target: { locator: "#create-task" },
          needRes: true,
        },
        {
          type: "callApi",
          request: {
            method: "GET",
            url: "/api/demo/detail",
          },
          expectation: {
            kind: "assertResponse",
            status: 200,
            body: [{ path: "data.spuTempNo", saveAs: "apiSpuNo" }],
          },
          needRes: true,
        },
        {
          type: "click",
          target: { locator: "#network-submit" },
          expectation: {
            kind: "networkResponse",
            urlIncludes: "/api/demo/detail",
            status: 200,
            body: [{ path: "data.spuTempNo", expected: "{{apiSpuNo}}", saveAs: "networkSpuNo" }],
            timeoutMs: 2000,
          },
          needRes: true,
        },
        {
          type: "assertVisible",
          target: { locator: "#network-state" },
          expectation: {
            kind: "text-exists",
            text: ["{{networkSpuNo}}"],
            timeoutMs: 1000,
          },
        },
        {
          type: "assertVisible",
          target: { locator: "#dom-value-input" },
          expectation: {
            kind: "assertDom",
            target: { locator: "#dom-value-input" },
            property: "value",
            expected: "待验证",
            saveAs: "domValue",
            timeoutMs: 1000,
          },
        },
        {
          type: "assertVisible",
          target: { locator: "#dom-value-input" },
          expectation: {
            kind: "assertDom",
            target: { locator: "#dom-value-input" },
            property: "value",
            expected: "{{domValue}}",
            timeoutMs: 1000,
          },
        },
      ],
      {
        url,
        headless: true,
        outputDir,
        runId: "runtime-capture-vars",
        onEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.okCount, 6);
    assert.equal(result.runtimeVariables.apiSpuNo, "SPU-CAPTURE-001");
    assert.equal(result.runtimeVariables.networkSpuNo, "SPU-CAPTURE-001");
    assert.equal(result.runtimeVariables.domValue, "待验证");
    assert.equal(result.runtimeVariableSources.networkSpuNo, "capture");
    const captureEvents = events.filter((event) => event.type === "step-complete" && event.runtimeVariables?.networkSpuNo);
    assert.ok(captureEvents.length >= 1);
  } finally {
    server.close();
  }
});

test("callApi injects localStorage token into request headers", async () => {
  const { server, url } = await createTokenApiFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  try {
    const result = await run(
      [
        {
          type: "callApi",
          request: {
            method: "POST",
            url: "/api/needs-token",
            body: { probe: true },
          },
          expectation: {
            kind: "assertResponse",
            status: 200,
            body: [{ path: "data.authed", expected: true }],
          },
          needRes: true,
        },
      ],
      {
        url,
        headless: true,
        outputDir,
        runId: "call-api-local-storage-token",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data.results[0].data.action.apiResponse.status, 200);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const apiTrace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
    assert.equal(apiTrace.actionResult.apiRequest.auth.source, "localStorage");
    assert.equal(apiTrace.actionResult.apiRequest.auth.key, "_TOKEN_");
    assert.equal(apiTrace.actionResult.apiRequest.auth.header, "token");
    assert.equal(apiTrace.actionResult.apiRequest.headers.token, "[redacted]");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime capture fails clearly for missing paths and invalid variable names", async () => {
  const { server, url } = await createFixtureServer();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  try {
    const missingPath = await run(
      [
        {
          type: "callApi",
          request: { method: "GET", url: "/api/demo/detail" },
          expectation: {
            kind: "assertResponse",
            status: 200,
            body: [{ path: "data.missingSpuNo", saveAs: "missingSpuNo" }],
          },
        },
      ],
      { url, headless: true, outputDir, runId: "runtime-capture-missing" },
    );
    assert.equal(missingPath.ok, false);
    assert.equal(missingPath.data.results[0].data.expectation.failures[0].operator, "exists");

    const invalidName = await run(
      [
        {
          type: "callApi",
          request: { method: "GET", url: "/api/demo/detail" },
          expectation: {
            kind: "assertResponse",
            status: 200,
            body: [{ path: "data.spuTempNo", saveAs: "1badName" }],
          },
        },
      ],
      { url, headless: true, outputDir, runId: "runtime-capture-invalid" },
    );
    assert.equal(invalidName.ok, false);
    assert.equal(invalidName.data.results[0].data.expectation.error, "invalid-runtime-variable-name");
  } finally {
    server.close();
  }
});

test("assertDom tagText exact match ignores superstring tags in the same row", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString()}?expanded=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: { locator: "#create-task" },
        needRes: false,
      },
      {
        type: "capture",
        expectation: {
          kind: "assertDom",
          target: {
            testId: "quick-task-row-hidden-status",
            hasText: "自动化测试-快速任务-001",
          },
          property: "text",
          operator: "contains",
          expected: "任务跟进人",
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
      },
      {
        type: "capture",
        expectation: {
          kind: "assertDom",
          target: {
            testId: "quick-task-row-hidden-status",
            hasText: "自动化测试-快速任务-001",
            tagText: "任务跟进",
          },
          property: "exists",
          operator: "equals",
          expected: true,
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "assert-dom-tag-scope",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "batch-partial-failure");
  assert.equal(result.data.results[1].ok, true);
  assert.equal(result.data.results[1].data.expectation.actual.includes("任务跟进人"), true);
  assert.equal(result.data.results[2].error.code, "expectation-not-met");
  assert.equal(result.data.results[2].data.expectation.type, "expectDom");
  assert.equal(result.data.results[2].data.expectation.property, "exists");
  assert.equal(result.data.results[2].data.expectation.actual, false);
});

test("assertDom tagMatch contains must be explicitly requested for partial tag text", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString()}?expanded=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: { locator: "#create-task" },
        needRes: false,
      },
      {
        type: "capture",
        expectation: {
          kind: "assertDom",
          target: {
            testId: "quick-task-row-hidden-status",
            hasText: "自动化测试-快速任务-001",
            tagText: "任务跟进",
            tagMatch: "contains",
          },
          property: "exists",
          operator: "equals",
          expected: true,
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "assert-dom-tag-contains-match",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.results[1].data.expectation.type, "expectDom");
  assert.equal(result.data.results[1].data.expectation.actual, true);
});

test("assertDom tagText finds the visible quick task tag in the scoped row", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString()}?expanded=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: { locator: "#create-task" },
        needRes: false,
      },
      {
        type: "capture",
        expectation: {
          kind: "assertDom",
          target: {
            testId: "quick-task-row-hidden-status",
            hasText: "自动化测试-快速任务-001",
            tagText: "快速任务",
          },
          property: "exists",
          operator: "equals",
          expected: true,
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "assert-dom-visible-tag-scope",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.results[1].data.expectation.type, "expectDom");
  assert.equal(result.data.results[1].data.expectation.property, "exists");
  assert.equal(result.data.results[1].data.expectation.actual, true);
});

test("assertDom tagText attribute reads the matched tag attribute", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString()}?expanded=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: { locator: "#create-task" },
        needRes: false,
      },
      {
        type: "capture",
        expectation: {
          kind: "assertDom",
          target: {
            testId: "quick-task-row",
            tagText: "任务跟进",
          },
          property: "attribute",
          attribute: "data-status-code",
          operator: "equals",
          expected: "8",
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "assert-dom-tag-attribute",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.results[1].data.expectation.type, "expectDom");
  assert.equal(result.data.results[1].data.expectation.property, "attribute");
  assert.equal(result.data.results[1].data.expectation.actual, "8");
});

test("click resolves nested modal cancel by nearText before falling back to OCR", async () => {
  const fixtureUrl = `${pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString()}?nested=1`;
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        type: "click",
        target: {
          role: "button",
          name: "取消",
          text: "取消",
          nearText: "选择物料",
        },
        expectation: {
          kind: "composite",
          assertions: [
            {
              kind: "text-absent",
              text: "确定",
              timeoutMs: 1000,
              intervalMs: 100,
            },
            {
              kind: "assertDom",
              target: { testId: "demo-create-task-modal" },
              property: "attribute",
              attribute: "data-open",
              operator: "equals",
              expected: "true",
              timeoutMs: 1000,
              intervalMs: 100,
            },
          ],
        },
        needRes: true,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "nested-modal-cancel-near-text",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.results[0].data.action.detail, "locator-click");

  const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
  const trace = JSON.parse(fs.readFileSync(report.evidence.steps[0].tracePath, "utf8"));
  assert.equal(trace.selectedLocatorStrategy, "dom:role-near-text-normalized");
  assert.equal(trace.selectedCandidate.nearTextMatched, true);
  assert.match(trace.selectedCandidate.nearTextMatchMethod, /^ancestor-/);
  assert.equal(trace.selectedCandidate.text, "取消");
});

test("text scope can read visible descendants from zero-size AntD modal root", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "capture",
      expectation: {
        kind: "text-exists",
        text: "供应链负责人",
        scope: {
          testId: "ant-modal-zero-root",
        },
        timeoutMs: 1000,
        intervalMs: 100,
      },
      needRes: true,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "zero-size-modal-scope",
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.expectation.matched, ["供应链负责人"]);
  assert.equal(result.data.expectation.scopeMatched, true);
});

test("assertDom visible treats zero-size AntD modal root with visible dialog as visible", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "capture",
      expectation: {
        kind: "assertDom",
        target: {
          testId: "ant-modal-zero-root",
        },
        property: "visible",
        operator: "equals",
        expected: true,
        timeoutMs: 1000,
        intervalMs: 100,
      },
      needRes: true,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "zero-size-modal-root-visible",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.expectation.type, "expectDom");
  assert.equal(result.data.expectation.actual, true);
  assert.equal(result.data.expectation.locatorDiagnostics.native.count, 1);
});

test("assertVisible expectation with target aliases to assertDom visible", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "capture",
      expectation: {
        kind: "assertVisible",
        target: {
          locator: "[data-testid=\"ant-modal-zero-root\"] .ant-modal",
          hasText: "创建任务任务",
        },
        timeoutMs: 1000,
        intervalMs: 100,
      },
      needRes: true,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "assert-visible-expectation-target",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.expectation.type, "expectDom");
  assert.equal(result.data.expectation.property, "visible");
  assert.equal(result.data.expectation.actual, true);
});

test("scoped text-absent ignores placeholder attributes after value is generated", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    {
      type: "capture",
      expectation: {
        kind: "text-absent",
        text: "请输入SPU货号",
        scope: {
          testId: "ant-modal-zero-root",
        },
        timeoutMs: 1000,
        intervalMs: 100,
      },
      needRes: true,
    },
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "scoped-placeholder-attribute-absent",
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.expectation.present, []);
  assert.equal(result.data.expectation.scopeMatched, true);
  assert.match(result.data.expectation.textSample, /DEMO2026A00221/);
  assert.doesNotMatch(result.data.expectation.textSample, /请输入SPU货号/);
});

test("scoped text-absent treats a missing dialog scope as absent", async () => {
  const fixture = `<!doctype html>
    <html>
      <body>
        <main>
          <section>
            <h1>任务跟进</h1>
            <table>
              <thead>
                <tr><th>项目成员类型</th></tr>
              </thead>
              <tbody>
                <tr><td>入驻项目成员</td></tr>
              </tbody>
            </table>
          </section>
        </main>
      </body>
    </html>`;
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  const { url } = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}/` });
    });
  });
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  try {
    const result = await run(
      {
        type: "capture",
        expectation: {
          kind: "text-absent",
          text: "项目成员类型",
          scope: {
            role: "dialog",
          },
          timeoutMs: 1000,
          intervalMs: 100,
        },
        needRes: true,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "missing-dialog-scope-text-absent",
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.data.expectation.present, []);
    assert.equal(result.data.expectation.scopeMatched, false);
    assert.equal(result.data.expectation.textSample, "");
  } finally {
    server.close();
  }
});

test("runtime skips case steps after setup failure but still runs teardown", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        id: "setup-fails",
        type: "assertVisible",
        phase: "setup",
        query: "永远不存在的 setup 文案",
        timeoutMs: 200,
        needRes: false,
      },
      {
        id: "case-skipped",
        type: "click",
        phase: "case",
        target: { role: "button", ariaLabel: "新增" },
        needRes: false,
      },
      {
        id: "teardown-runs",
        type: "capture",
        phase: "teardown",
        needRes: false,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "scaffold-setup-failure",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.results.length, 3);
  assert.equal(result.data.results[0].ok, false);
  assert.equal(result.data.results[1].skipped, true);
  assert.equal(result.data.results[1].data.action.detail, "skipped-after-setup-failure");
  assert.equal(result.data.results[2].ok, true);
  assert.equal(result.data.results[2].skipped, undefined);
});

test("runtime can stop remaining scaffold steps after setup failure", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const events = [];

  const result = await run(
    [
      {
        id: "root-setup-fails",
        type: "assertVisible",
        phase: "setup",
        query: "永远不存在的 root setup 文案",
        timeoutMs: 200,
        needRes: false,
      },
      {
        id: "root-setup-unrun",
        type: "capture",
        phase: "setup",
        needRes: false,
      },
      {
        id: "case-unrun",
        type: "click",
        phase: "case",
        target: { role: "button", ariaLabel: "新增" },
        needRes: false,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "root-setup-stop-after-failure",
      stopAfterScaffoldFailure: true,
      onEvent: (event) => events.push(event),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0].ok, false);
  assert.equal(events.some((event) => event.stepId === "root-setup-unrun"), false);
  assert.equal(events.some((event) => event.stepId === "case-unrun"), false);
});

test("runtime stops later case steps after a failed step by default but still runs teardown", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const events = [];

  const result = await run(
    [
      {
        id: "case-fails",
        type: "assertVisible",
        phase: "case",
        query: "永远不存在的 case 文案",
        timeoutMs: 200,
        needRes: false,
      },
      {
        id: "case-stopped",
        type: "click",
        phase: "case",
        target: { role: "button", ariaLabel: "新增" },
        needRes: false,
      },
      {
        id: "teardown-runs",
        type: "capture",
        phase: "teardown",
        needRes: false,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "case-stop-on-failure-default",
      onEvent: (event) => events.push(event),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.results.length, 3);
  assert.equal(result.data.results[0].ok, false);
  assert.equal(result.data.results[1].stopped, true);
  assert.equal(result.data.results[1].data.action.detail, "stopped-after-failed-step");
  assert.equal(result.data.results[2].ok, true);
  assert.equal(result.data.errorCount, 1);
  assert.equal(events.find((event) => event.stepId === "case-stopped" && event.type === "step-complete")?.status, "stopped");
});

test("runtime can omit remaining case steps after a failed step but still run teardown", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");
  const events = [];

  const result = await run(
    [
      {
        id: "case-fails",
        type: "assertVisible",
        phase: "case",
        query: "永远不存在的 case 文案",
        timeoutMs: 200,
        needRes: false,
      },
      {
        id: "case-unrun",
        type: "click",
        phase: "case",
        target: { role: "button", ariaLabel: "新增" },
        needRes: false,
      },
      {
        id: "teardown-runs",
        type: "capture",
        phase: "teardown",
        needRes: false,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "case-stop-after-failure-no-unrun-results",
      stopAfterCaseFailure: true,
      onEvent: (event) => events.push(event),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.results.length, 2);
  assert.equal(result.data.results[0].ok, false);
  assert.equal(result.data.results[1].input.id, "teardown-runs");
  assert.equal(result.data.results[1].ok, true);
  assert.equal(events.some((event) => event.stepId === "case-unrun"), false);
});

test("runtime keeps running case steps after a failed step when stopOnFailure is disabled", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "static", "core-actions-fixture.html"),
  ).toString();
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-core-actions");

  const result = await run(
    [
      {
        id: "case-fails",
        type: "assertVisible",
        phase: "case",
        query: "永远不存在的 case 文案",
        timeoutMs: 200,
        needRes: false,
      },
      {
        id: "case-continues",
        type: "click",
        phase: "case",
        target: { role: "button", ariaLabel: "新增" },
        needRes: false,
      },
    ],
    {
      url: fixtureUrl,
      headless: true,
      outputDir,
      runId: "case-continue-after-failure",
      stopOnFailure: false,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.results.length, 2);
  assert.equal(result.data.results[0].ok, false);
  assert.equal(result.data.results[1].ok, true);
  assert.equal(result.data.results[1].stopped, undefined);
});
