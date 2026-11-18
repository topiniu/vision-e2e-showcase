const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { run } = require("../../runtime");

function createHtmlServer(html) {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
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

function readTrace(report, index) {
  return JSON.parse(fs.readFileSync(report.evidence.steps[index].tracePath, "utf8"));
}

const antdFixture = `<!doctype html>
<html>
  <head>
    <style>
      .ant-modal-root { position: static; width: 0; height: 0; }
      .ant-modal { width: 720px; padding: 24px; border: 1px solid #d9d9d9; }
      .field { margin: 14px 0; }
      .label { display: block; font-weight: 600; margin-bottom: 8px; }
      .ant-radio-wrapper, .ant-checkbox-wrapper { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; cursor: pointer; }
      .ant-radio-button-wrapper { display: inline-flex; align-items: center; padding: 5px 12px; border: 1px solid #d9d9d9; cursor: pointer; }
      .ant-radio-button-wrapper-checked { color: #1677ff; border-color: #1677ff; box-shadow: 0 0 0 1px #1677ff inset; }
      .ant-radio, .ant-checkbox { display: inline-flex; width: 16px; height: 16px; border: 1px solid #d9d9d9; border-radius: 50%; }
      .ant-checkbox { border-radius: 4px; }
      .ant-radio-wrapper-checked .ant-radio, .ant-checkbox-wrapper-checked .ant-checkbox, .ant-switch-checked { border-color: #1677ff; background: #1677ff; }
      .ant-switch { display: inline-flex; width: 42px; height: 22px; border-radius: 999px; border: 1px solid #d9d9d9; align-items: center; cursor: pointer; }
      .ant-select, .ant-picker { width: 260px; min-height: 32px; border: 1px solid #d9d9d9; display: inline-flex; align-items: center; padding: 0 8px; }
      .ant-tabs-tab { display: inline-flex; padding: 8px 12px; cursor: pointer; }
      .ant-tabs-tab-active { color: #1677ff; border-bottom: 2px solid #1677ff; }
      .ant-select-selection-search-input { border: 0; outline: 0; flex: 1; }
      .ant-select-dropdown { position: absolute; top: 245px; left: 32px; border: 1px solid #d9d9d9; background: #fff; padding: 6px; }
      .ant-select-dropdown-hidden { display: none; }
      .ant-select-item-option { padding: 6px 10px; cursor: pointer; }
      .ant-table-row td { padding: 4px 8px; border: 1px solid #eee; }
      .ant-upload { display: inline-flex; border: 1px dashed #999; padding: 8px 12px; cursor: pointer; }
      input.hidden-control { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
    </style>
  </head>
  <body>
    <div class="ant-modal-root" data-testid="demo-supply-chain-action-modal">
      <div class="ant-modal">
        <section class="field" id="supplier-type-field">
          <span class="label">项目成员类型</span>
          <label class="ant-radio-wrapper">
            <span class="ant-radio"><input class="hidden-control" type="radio" name="supplierType" value="resident" /></span>
            <span>入驻项目成员</span>
          </label>
          <label class="ant-radio-wrapper">
            <span class="ant-radio"><input class="hidden-control" type="radio" name="supplierType" value="external" /></span>
            <span>非入驻项目成员</span>
          </label>
        </section>

        <section class="field">
          <span class="label">协议选项</span>
          <label class="ant-checkbox-wrapper">
            <span class="ant-checkbox"><input class="hidden-control" type="checkbox" name="agree" /></span>
            <span>同意协议</span>
          </label>
        </section>

        <section class="field">
          <span class="label">环节超时</span>
          <div class="ant-radio-group ant-radio-group-outline" data-testid="demo-filter-phase-overtime">
            <label class="ant-radio-button-wrapper ant-radio-button-wrapper-checked">
              <span class="ant-radio-button"><input class="ant-radio-button-input hidden-control" type="radio" name="phaseOvertime" value="-1" checked /></span>
              <span>全部</span>
            </label>
            <label class="ant-radio-button-wrapper">
              <span class="ant-radio-button"><input class="ant-radio-button-input hidden-control" type="radio" name="phaseOvertime" value="1" /></span>
              <span>已超时</span>
            </label>
            <label class="ant-radio-button-wrapper">
              <span class="ant-radio-button"><input class="ant-radio-button-input hidden-control" type="radio" name="phaseOvertime" value="0" /></span>
              <span>未超时</span>
            </label>
          </div>
        </section>

        <section class="field">
          <span class="label">开关项</span>
          <button class="ant-switch" role="switch" aria-label="启用通知" aria-checked="false" title="启用通知"></button>
        </section>

        <section class="field" data-testid="demo-supply-chain-board-mode-tabs">
          <div class="ant-tabs-tab ant-tabs-tab-active" data-node-key="supplyChain">
            <div role="tab" aria-selected="true">任务跟进人看板</div>
          </div>
          <div class="ant-tabs-tab" data-node-key="review">
            <div role="tab" aria-selected="false">产前样审版看板</div>
          </div>
        </section>

        <section class="field">
          <span class="label">项目成员</span>
          <div class="ant-select" role="combobox" title="项目成员">
            <span class="ant-select-selection-item"></span>
            <input class="ant-select-selection-search-input" role="combobox" placeholder="请选择或搜索项目成员" />
          </div>
          <div class="ant-select-dropdown ant-select-dropdown-hidden" role="listbox">
            <div class="ant-select-item-option" role="option" title="示例团队测试项目成员">示例团队测试项目成员</div>
          </div>
        </section>

        <section class="field">
          <span class="label">回样时间</span>
          <div class="ant-picker">
            <input placeholder="YYYY-MM-DD" value="2026-06-25" />
          </div>
        </section>

        <section class="field">
          <span class="label">选择附件</span>
          <span class="ant-upload">上传附件</span>
          <input id="antd-upload-input" type="file" hidden />
          <div id="upload-state">未上传</div>
        </section>

        <table class="ant-table"><tbody>
          <tr class="ant-table-row"><td>DEMO2026A00259</td><td><span class="ant-tag" data-status="任务跟进">任务跟进</span></td></tr>
        </tbody></table>
      </div>
    </div>
    <script>
      document.querySelectorAll(".ant-radio-wrapper").forEach((wrapper) => {
        wrapper.addEventListener("click", () => {
          document.querySelectorAll("input[name='supplierType']").forEach((input) => {
            input.checked = false;
            input.closest(".ant-radio-wrapper").classList.remove("ant-radio-wrapper-checked");
          });
          const input = wrapper.querySelector("input");
          input.checked = true;
          wrapper.classList.add("ant-radio-wrapper-checked");
        });
      });
      document.querySelectorAll(".ant-radio-button-wrapper").forEach((wrapper) => {
        wrapper.addEventListener("click", () => {
          document.querySelectorAll("input[name='phaseOvertime']").forEach((input) => {
            input.checked = false;
            input.closest(".ant-radio-button-wrapper").classList.remove("ant-radio-button-wrapper-checked");
          });
          const input = wrapper.querySelector("input");
          input.checked = true;
          wrapper.classList.add("ant-radio-button-wrapper-checked");
        });
      });
      document.querySelector(".ant-checkbox-wrapper").addEventListener("click", (event) => {
        const wrapper = event.currentTarget;
        const input = wrapper.querySelector("input");
        input.checked = !input.checked;
        wrapper.classList.toggle("ant-checkbox-wrapper-checked", input.checked);
      });
      document.querySelector(".ant-switch").addEventListener("click", (event) => {
        const next = event.currentTarget.getAttribute("aria-checked") !== "true";
        event.currentTarget.setAttribute("aria-checked", String(next));
        event.currentTarget.classList.toggle("ant-switch-checked", next);
      });
      document.querySelector(".ant-select").addEventListener("click", () => {
        document.querySelector(".ant-select-dropdown").classList.remove("ant-select-dropdown-hidden");
      });
      document.querySelector(".ant-select-item-option").addEventListener("click", (event) => {
        document.querySelector(".ant-select-selection-item").textContent = event.currentTarget.textContent;
        document.querySelector(".ant-select-dropdown").classList.add("ant-select-dropdown-hidden");
      });
      document.querySelector(".ant-upload").addEventListener("click", () => {
        document.querySelector("#antd-upload-input").click();
      });
      document.querySelector("#antd-upload-input").addEventListener("change", () => {
        document.querySelector("#upload-state").textContent = "附件已上传";
      });
    </script>
  </body>
</html>`;

test("AntD adapter resolves checked state from radio, checkbox, and switch wrappers", async () => {
  const { server, url } = await createHtmlServer(antdFixture);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-adapter");
  try {
    const result = await run(
      [
        {
          type: "click",
          target: {
            strategy: "auto",
            role: "radio",
            name: "入驻项目成员",
            nearText: "项目成员类型",
          },
          expectation: {
            kind: "assertDom",
            target: {
              strategy: "auto",
              role: "radio",
              name: "入驻项目成员",
              nearText: "项目成员类型",
            },
            property: "checked",
            operator: "equals",
            expected: true,
            timeoutMs: 1000,
          },
          needRes: true,
        },
        {
          type: "click",
          target: {
            role: "checkbox",
            name: "同意协议",
            nearText: "协议选项",
          },
          expectation: {
            kind: "assertDom",
            target: {
              role: "checkbox",
              name: "同意协议",
              nearText: "协议选项",
            },
            property: "checked",
            expected: true,
            timeoutMs: 1000,
          },
          needRes: true,
        },
        {
          type: "click",
          target: {
            role: "switch",
            name: "启用通知",
            nearText: "开关项",
          },
          expectation: {
            kind: "assertDom",
            target: {
              role: "switch",
              name: "启用通知",
              nearText: "开关项",
            },
            property: "checked",
            expected: true,
            timeoutMs: 1000,
          },
          needRes: true,
        },
      ],
      {
        url,
        headless: true,
        outputDir,
        runId: "antd-controls",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const radioTrace = readTrace(report, 0);
    assert.equal(radioTrace.uiContext.beforeAction.antd.detected, true);
    assert.equal(radioTrace.selectedLocatorStrategy, "adapter:antd.radio");
    assert.equal(radioTrace.expectation.locatorDiagnostics.selected, "adapter");
    assert.equal(radioTrace.expectation.locatorDiagnostics.adapter.adapter, "antd.radio");
  } finally {
    server.close();
  }
});

test("AntD adapter reads selected radio button value from group target", async () => {
  const { server, url } = await createHtmlServer(antdFixture);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-radio-group-value");
  try {
    const result = await run(
      [
        {
          type: "click",
          target: {
            strategy: "auto",
            text: "已超时",
            scope: {
              testId: "demo-filter-phase-overtime",
            },
          },
          expectation: {
            kind: "assertDom",
            target: {
              testId: "demo-filter-phase-overtime",
            },
            property: "value",
            operator: "equals",
            expected: "1",
            timeoutMs: 1000,
          },
          needRes: true,
        },
      ],
      {
        url,
        headless: true,
        outputDir,
        runId: "antd-radio-group-value",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = readTrace(report, 0);
    assert.equal(trace.expectation.actual, "1");
    assert.equal(trace.expectation.state.matchedInput.value, "1");
    assert.equal(trace.expectation.state.matchedInput.checked, true);
    assert.equal(trace.expectation.state.stateSource, "checked-input");
  } finally {
    server.close();
  }
});

test("AntD adapter resolves selected state from active tabs", async () => {
  const { server, url } = await createHtmlServer(antdFixture);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-adapter");
  try {
    const result = await run(
      {
        type: "capture",
        expectation: {
          kind: "assertDom",
          target: {
            locator: "[data-testid=\"demo-supply-chain-board-mode-tabs\"] .ant-tabs-tab[data-node-key=\"supplyChain\"]",
          },
          property: "selected",
          operator: "equals",
          expected: true,
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "antd-tabs-selected",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = readTrace(report, 0);
    assert.equal(trace.expectation.ok, true);
    assert.equal(trace.expectation.state.selected, true);
    assert.equal(trace.expectation.locatorDiagnostics.selected, "adapter");
    assert.equal(trace.expectation.locatorDiagnostics.adapter.stateSource, "class");
  } finally {
    server.close();
  }
});

test("AntD adapter supports select, picker value, table tag, and upload fixtures", async () => {
  const { server, url } = await createHtmlServer(antdFixture);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-adapter");
  try {
    const result = await run(
      [
        {
          type: "comboSearchSelect",
          target: {
            role: "combobox",
            name: "项目成员",
            nearText: "项目成员",
          },
          query: "示例团队",
          option: {
            text: "示例团队测试项目成员",
            match: "contains",
          },
          expectation: {
            kind: "assertDom",
            target: {
              role: "combobox",
              name: "项目成员",
              nearText: "项目成员",
            },
            property: "text",
            operator: "contains",
            expected: "示例团队测试项目成员",
            timeoutMs: 1000,
          },
          needRes: true,
        },
        {
          type: "capture",
          expectation: {
            kind: "assertDom",
            target: {
              role: "combobox",
              placeholder: "YYYY-MM-DD",
              nearText: "回样时间",
            },
            property: "value",
            operator: "equals",
            expected: "2026-06-25",
            timeoutMs: 1000,
          },
          needRes: true,
        },
        {
          type: "capture",
          expectation: {
            kind: "assertDom",
            target: {
              locator: ".ant-table-row",
              hasText: "DEMO2026A00259",
              tagText: "任务跟进",
            },
            property: "exists",
            expected: true,
            timeoutMs: 1000,
          },
          needRes: true,
        },
        {
          type: "uploadFile",
          target: {
            role: "button",
            name: "上传附件",
            nearText: "选择附件",
          },
          files: [{ path: "test-assets/demo/fixture.png" }],
          mode: "input",
          expectation: {
            kind: "text-exists",
            text: "附件已上传",
            timeoutMs: 1000,
          },
          needRes: true,
        },
      ],
      {
        url,
        headless: true,
        outputDir,
        runId: "antd-rich-controls",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const selectTrace = readTrace(report, 0);
    assert.equal(selectTrace.uiContext.beforeAction.antd.components.includes("select"), true);
    assert.equal(selectTrace.expectation.locatorDiagnostics.adapter.adapter, "antd.combobox");
    const uploadTrace = readTrace(report, 3);
    assert.match(uploadTrace.selectedLocatorStrategy, /file-input-near-text/);
  } finally {
    server.close();
  }
});

test("comboSearchSelect binds AntD select popup when target is matched by test id", async () => {
  const html = `<!doctype html>
    <html>
      <head>
        <style>
          body { margin: 24px; font-family: Arial, sans-serif; }
          .ant-modal-root { position: relative; }
          .ant-modal { width: 820px; padding: 24px; border: 1px solid #d9d9d9; }
          .ant-form-item-label { font-weight: 600; margin-bottom: 8px; }
          .ant-select { width: 100%; min-height: 32px; }
          .ant-select-selector { position: relative; min-height: 32px; border: 1px solid #d9d9d9; }
          .ant-select-selection-search { position: absolute; inset: 0; }
          .ant-select-selection-search-input {
            width: 100%;
            height: 30px;
            border: 0;
            outline: 0;
            padding: 4px 10px;
            background: transparent;
          }
          .ant-select-selection-placeholder { position: absolute; left: 10px; top: 7px; color: #999; pointer-events: none; }
          .ant-select-selection-item { position: absolute; left: 10px; top: 7px; color: #111; }
          .ant-select-dropdown { position: absolute; left: 48px; top: 110px; width: 720px; border: 1px solid #d9d9d9; background: #fff; padding: 4px 0; }
          .ant-select-dropdown-hidden { display: none; }
          .ant-select-item-option { padding: 8px 12px; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="ant-modal-root" data-testid="demo-supply-chain-action-modal">
          <div role="dialog" class="ant-modal">
            <form class="ant-form ant-form-vertical">
              <div class="ant-form-item">
                <div class="ant-form-item-label">
                  <label class="ant-form-item-required" title="项目编号录入负责人">项目编号录入负责人</label>
                </div>
                <div class="ant-form-item-control">
                  <div class="ant-select ant-select-in-form-item ant-select-single ant-select-show-arrow ant-select-show-search" data-testid="demo-supply-chain-cjspu-creator-select">
                    <div class="ant-select-selector">
                      <span class="ant-select-selection-search">
                        <input
                          type="search"
                          autocomplete="off"
                          class="ant-select-selection-search-input"
                          role="combobox"
                          aria-haspopup="listbox"
                          aria-owns="rc_select_30_list"
                          aria-autocomplete="list"
                          aria-controls="rc_select_30_list"
                          aria-expanded="false"
                          value=""
                          id="rc_select_30"
                        />
                      </span>
                      <span class="ant-select-selection-placeholder">请选择或搜索项目编号录入负责人</span>
                      <span class="ant-select-selection-item" style="display:none"></span>
                    </div>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
        <div class="ant-select-dropdown ant-select-dropdown-hidden">
          <div id="rc_select_30_list" role="listbox">
            <div id="rc_select_30_list_0" class="ant-select-item ant-select-item-option" role="option" title="促佳贸易">
              <div class="ant-select-item-option-content">促佳贸易</div>
            </div>
          </div>
        </div>
        <script>
          const root = document.querySelector("[data-testid='demo-supply-chain-cjspu-creator-select']");
          const input = document.querySelector("#rc_select_30");
          const dropdown = document.querySelector(".ant-select-dropdown");
          const placeholder = document.querySelector(".ant-select-selection-placeholder");
          const selected = document.querySelector(".ant-select-selection-item");
          root.addEventListener("click", () => {
            input.focus();
            input.setAttribute("aria-expanded", "true");
          });
          input.addEventListener("input", () => {
            placeholder.style.display = input.value ? "none" : "block";
            dropdown.classList.toggle("ant-select-dropdown-hidden", !input.value);
          });
          dropdown.addEventListener("click", (event) => {
            const option = event.target.closest(".ant-select-item-option");
            if (!option) {
              return;
            }
            selected.textContent = option.textContent.trim();
            selected.style.display = "inline";
            placeholder.style.display = "none";
            input.value = "";
            input.setAttribute("aria-expanded", "false");
            dropdown.classList.add("ant-select-dropdown-hidden");
          });
        </script>
      </body>
    </html>`;
  const { server, url } = await createHtmlServer(html);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-adapter");
  try {
    const result = await run(
      {
        id: "c09c-q-ph8-cjspu-creator",
        type: "comboSearchSelect",
        stepTitle: "项目编号录入负责人=促佳贸易",
        target: {
          role: "combobox",
          testId: "demo-supply-chain-cjspu-creator-select",
          placeholder: "请选择或搜索项目编号录入负责人",
          nearText: "项目编号录入负责人",
        },
        query: "促",
        option: {
          text: "促佳贸易",
          match: "contains",
        },
        optionWaitTimeoutMs: 2000,
        optionPollIntervalMs: 50,
        expectation: {
          kind: "text-absent",
          scope: {
            testId: "demo-supply-chain-action-modal",
          },
          text: ["请选择或搜索项目编号录入负责人"],
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "antd-testid-bound-combo",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = readTrace(report, 0);
    assert.equal(trace.selectedLocatorStrategy, "explicit:test-id");
    assert.equal(trace.popupTrace.openedBy, "root-click:nested-keyboard");
    assert.equal(trace.popupTrace.queryInput.activation, "focus");
    assert.equal(trace.popupTrace.queryInput.typed, true);
    assert.ok(trace.popupTrace.openDurationMs < 1000);
    assert.match(trace.popupTrace.optionScope, /^aria-linked/);
    assert.equal(trace.popupTrace.selected.actual.includes("促佳贸易"), true);
  } finally {
    server.close();
  }
});

test("runtime retries preserve each attempt trace and expose cumulative step duration", async () => {
  const html = `<!doctype html>
    <html>
      <body>
        <button id="retry-submit">提交</button>
        <div id="result"></div>
        <script>
          let attempts = 0;
          document.querySelector("#retry-submit").addEventListener("click", () => {
            attempts += 1;
            if (attempts >= 2) {
              document.querySelector("#result").textContent = "提交成功";
            }
          });
        </script>
      </body>
    </html>`;
  const { server, url } = await createHtmlServer(html);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-adapter");
  try {
    const result = await run(
      {
        type: "click",
        target: { locator: "#retry-submit" },
        retries: 1,
        retryDelayMs: 20,
        timeoutMs: 500,
        expectation: {
          kind: "text-exists",
          text: "提交成功",
          timeoutMs: 100,
          intervalMs: 25,
        },
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "retry-attempt-evidence",
        evidenceProfile: "fast",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.data.retry.attempts, 2);
    assert.equal(result.data.evidence.attempts.length, 2);
    assert.match(result.data.evidence.attempts[0].tracePath, /01-attempt-1-trace\.json$/);
    assert.match(result.data.evidence.attempts[1].tracePath, /01-attempt-2-trace\.json$/);
    assert.equal(fs.existsSync(result.data.evidence.attempts[0].tracePath), true);
    assert.equal(fs.existsSync(result.data.evidence.attempts[1].tracePath), true);
    assert.ok(result.telemetry.durationMs > result.data.evidence.attempts[1].durationMs);

    const firstTrace = JSON.parse(fs.readFileSync(result.data.evidence.attempts[0].tracePath, "utf8"));
    const secondTrace = JSON.parse(fs.readFileSync(result.data.evidence.attempts[1].tracePath, "utf8"));
    // maxAttempts = 作者声明的 retries(1) + 首次尝试(1) + 瞬时抖动自愈预算(TRANSIENT_RETRY_BUDGET=2)
    const expectedMaxAttempts = 1 + 1 + Number(process.env.ZHUZHU_TRANSIENT_RETRY_BUDGET ?? 2);
    assert.deepEqual(firstTrace.attempt, { number: 1, maxAttempts: expectedMaxAttempts });
    assert.deepEqual(secondTrace.attempt, { number: 2, maxAttempts: expectedMaxAttempts });
    assert.equal(firstTrace.retriesAttempted, 0);
    assert.equal(secondTrace.retriesAttempted, 1);
  } finally {
    server.close();
  }
});

test("AntD generic adapter does not steal plain text navigation targets", async () => {
  const html = `<!doctype html>
    <html>
      <body>
        <aside>
          <button id="nav-supply">任务跟进</button>
        </aside>
        <main>
          <div class="ant-select" title="负责人">
            <span class="ant-select-selection-item"></span>
            <input class="ant-select-selection-search-input" placeholder="请选择或搜索任务负责人" />
          </div>
          <div class="ant-select" title="运营">
            <span class="ant-select-selection-item"></span>
            <input class="ant-select-selection-search-input" placeholder="请选择或搜索运营" />
          </div>
          <div class="ant-picker"><input placeholder="开始日期" /></div>
          <section id="board"></section>
        </main>
        <script>
          document.querySelector("#nav-supply").addEventListener("click", () => {
            const button = document.createElement("button");
            button.dataset.testid = "demo-supply-chain-board-search-btn";
            button.textContent = "搜索";
            document.querySelector("#board").appendChild(button);
          });
        </script>
      </body>
    </html>`;
  const { server, url } = await createHtmlServer(html);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-adapter");
  try {
    const result = await run(
      {
        type: "click",
        target: {
          strategy: "auto",
          text: "任务跟进",
          name: "任务跟进",
        },
        expectation: {
          kind: "assertDom",
          target: {
            testId: "demo-supply-chain-board-search-btn",
          },
          property: "visible",
          expected: true,
          timeoutMs: 1000,
        },
        needRes: true,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "antd-nav-text-not-stolen",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = readTrace(report, 0);
    assert.notEqual(trace.selectedLocatorStrategy, "adapter:antd.target");
    assert.equal(trace.expectation.ok, true);
  } finally {
    server.close();
  }
});

test("UI framework detector does not flag a plain page as AntD", async () => {
  const { server, url } = await createHtmlServer(`<!doctype html><html><body><button>普通按钮</button></body></html>`);
  const outputDir = path.join(os.tmpdir(), "e2e-auto-test-antd-adapter");
  try {
    const result = await run(
      {
        type: "assertVisible",
        query: "普通按钮",
        needRes: true,
      },
      {
        url,
        headless: true,
        outputDir,
        runId: "non-antd-detector",
      },
    );

    assert.equal(result.ok, true);
    const report = JSON.parse(fs.readFileSync(result.evidence.reportPath, "utf8"));
    const trace = readTrace(report, 0);
    assert.equal(trace.uiContext.beforeAction.antd.detected, false);
  } finally {
    server.close();
  }
});
