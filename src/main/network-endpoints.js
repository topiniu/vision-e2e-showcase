const os = require("node:os");

const DEFAULT_APP_RUN_PORT = 32147;
const EXTERNAL_INTEGRATION_DOCUMENTS_PATH = "/external-integration-documents";

function parseIpv4(address) {
  const octets = String(address || "").split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function classifyNetworkAddress(address) {
  const octets = parseIpv4(address);
  if (!octets) {
    return null;
  }
  const [first, second] = octets;
  if (first === 100 && second >= 64 && second <= 127) {
    return "tailnet";
  }
  if (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  ) {
    return "lan";
  }
  return null;
}

function buildEndpoint({ kind, label, address, interfaceName, port = DEFAULT_APP_RUN_PORT }) {
  const baseUrl = `http://${address}:${port}`;
  return {
    kind,
    label,
    address,
    interfaceName,
    baseUrl,
    documentsUrl: `${baseUrl}${EXTERNAL_INTEGRATION_DOCUMENTS_PATH}`,
  };
}

function listAppRunNetworkEndpoints({
  port = DEFAULT_APP_RUN_PORT,
  interfaces = os.networkInterfaces(),
} = {}) {
  const endpoints = [buildEndpoint({
    kind: "local",
    label: "This computer",
    address: "127.0.0.1",
    interfaceName: "loopback",
    port,
  })];
  const seen = new Set(["127.0.0.1"]);

  for (const [interfaceName, addresses] of Object.entries(interfaces || {})) {
    for (const entry of addresses || []) {
      if (entry?.internal || (entry?.family !== "IPv4" && entry?.family !== 4) || seen.has(entry.address)) {
        continue;
      }
      const kind = classifyNetworkAddress(entry.address);
      if (!kind) {
        continue;
      }
      seen.add(entry.address);
      endpoints.push(buildEndpoint({
        kind,
        label: kind === "tailnet" ? "Tailscale / Tailnet" : "Local network",
        address: entry.address,
        interfaceName,
        port,
      }));
    }
  }

  return endpoints.sort((left, right) => {
    const priority = { local: 0, lan: 1, tailnet: 2 };
    return (priority[left.kind] ?? 9) - (priority[right.kind] ?? 9) || left.address.localeCompare(right.address);
  });
}

function getRequestOrigin(request, fallbackPort = DEFAULT_APP_RUN_PORT) {
  const forwardedProto = String(request?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const protocol = forwardedProto === "https" ? "https" : "http";
  const host = String(request?.headers?.host || "").trim();
  return host ? `${protocol}://${host}` : `http://127.0.0.1:${fallbackPort}`;
}

module.exports = {
  DEFAULT_APP_RUN_PORT,
  EXTERNAL_INTEGRATION_DOCUMENTS_PATH,
  classifyNetworkAddress,
  getRequestOrigin,
  listAppRunNetworkEndpoints,
};
