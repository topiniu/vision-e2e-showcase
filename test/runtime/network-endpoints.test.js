const assert = require("node:assert/strict");
const test = require("node:test");
const {
  classifyNetworkAddress,
  getRequestOrigin,
  listAppRunNetworkEndpoints,
} = require("../../src/main/network-endpoints");

test("classifies private LAN and Tailscale IPv4 addresses", () => {
  assert.equal(classifyNetworkAddress("192.168.0.2"), "lan");
  assert.equal(classifyNetworkAddress("10.0.0.2"), "lan");
  assert.equal(classifyNetworkAddress("172.20.1.9"), "lan");
  assert.equal(classifyNetworkAddress("100.64.0.1"), "tailnet");
  assert.equal(classifyNetworkAddress("100.127.255.254"), "tailnet");
  assert.equal(classifyNetworkAddress("100.128.0.1"), null);
  assert.equal(classifyNetworkAddress("198.18.0.1"), null);
});

test("lists copyable local, LAN, and Tailnet endpoints without duplicates", () => {
  const endpoints = listAppRunNetworkEndpoints({
    port: 32147,
    interfaces: {
      en0: [
        { address: "192.168.0.2", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
      utun5: [{ address: "100.64.0.2", family: "IPv4", internal: false }],
      duplicate: [{ address: "192.168.0.2", family: 4, internal: false }],
    },
  });

  assert.deepEqual(endpoints.map((endpoint) => endpoint.kind), ["local", "lan", "tailnet"]);
  assert.equal(endpoints[1].baseUrl, "http://192.168.0.2:32147");
  assert.equal(endpoints[2].documentsUrl, "http://100.64.0.2:32147/external-integration-documents");
});

test("uses proxy protocol and request host for remotely fetched documentation", () => {
  assert.equal(getRequestOrigin({ headers: { host: "zhuzhu.example.ts.net", "x-forwarded-proto": "https" } }), "https://zhuzhu.example.ts.net");
  assert.equal(getRequestOrigin({ headers: {} }, 32147), "http://127.0.0.1:32147");
});
