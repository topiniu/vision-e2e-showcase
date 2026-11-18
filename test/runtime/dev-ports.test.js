const assert = require("node:assert/strict");
const test = require("node:test");

async function loadDevPorts() {
  return import("../../scripts/dev-ports.mjs");
}

test("dev services automatically move default ports when the DMG app or another dev process is listening", async () => {
  const { resolveDevServicePorts } = await loadDevPorts();
  const occupiedPorts = new Set([5174, 32146, 32147]);
  const probes = [];
  const result = await resolveDevServicePorts({}, {
    checkPort: async (port, host) => {
      probes.push([port, host]);
      return !occupiedPorts.has(port);
    },
  });

  assert.equal(result.panelPort, 5175);
  assert.equal(result.runtimePort, 32148);
  assert.equal(result.appRunPort, 32149);
  assert.equal(result.panelUrl, "http://127.0.0.1:5175");
  assert.deepEqual(result.shifted, {
    panel: true,
    runtime: true,
    appRun: true,
  });
  assert.ok(probes.some(([port, host]) => port === 32146 && host === "::"));
  assert.ok(probes.some(([port, host]) => port === 32148 && host === "0.0.0.0"));
});

test("explicit dev ports remain strict overrides", async () => {
  const { resolveDevServicePorts } = await loadDevPorts();
  const result = await resolveDevServicePorts({
    ZHUZHU_PANEL_DEV_SERVER_URL: "http://127.0.0.1:6200",
    ZHUZHU_RUNTIME_PORT: "6201",
    ZHUZHU_APP_RUN_PORT: "6202",
  }, {
    checkPort: async () => false,
  });

  assert.equal(result.panelPort, 6200);
  assert.equal(result.runtimePort, 6201);
  assert.equal(result.appRunPort, 6202);
  assert.deepEqual(result.shifted, {
    panel: false,
    runtime: false,
    appRun: false,
  });
});

test("automatic selection keeps the three dev services on distinct ports", async () => {
  const { resolveDevServicePorts } = await loadDevPorts();
  const result = await resolveDevServicePorts({
    ZHUZHU_WEB_PORT: "6300",
    ZHUZHU_RUNTIME_PORT: "6301",
  }, {
    checkPort: async () => true,
  });

  assert.equal(result.panelPort, 6300);
  assert.equal(result.runtimePort, 6301);
  assert.equal(result.appRunPort, 32147);
  assert.equal(new Set([result.panelPort, result.runtimePort, result.appRunPort]).size, 3);
});
