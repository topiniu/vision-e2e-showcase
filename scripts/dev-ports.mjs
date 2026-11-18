import net from "node:net";

const DEFAULT_PANEL_PORT = 5174;
const DEFAULT_RUNTIME_PORT = 32146;
const DEFAULT_APP_RUN_PORT = 32147;

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

export function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function findAvailablePort(
  preferredPort,
  {
    host = "127.0.0.1",
    reservedPorts = new Set(),
    checkPort = isPortAvailable,
    maxAttempts = 100,
  } = {},
) {
  const hosts = Array.isArray(host) ? host : [host];
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65_535 || reservedPorts.has(candidate)) {
      continue;
    }
    let available = true;
    for (const candidateHost of hosts) {
      if (!await checkPort(candidate, candidateHost)) {
        available = false;
        break;
      }
    }
    if (available) {
      return candidate;
    }
  }
  throw new Error(`No available port found from ${preferredPort} after ${maxAttempts} attempts.`);
}

export async function resolveDevServicePorts(env = process.env, options = {}) {
  const checkPort = options.checkPort || isPortAvailable;
  const panelUrlInput = env.ZHUZHU_PANEL_DEV_SERVER_URL
    || `http://${env.ZHUZHU_WEB_HOST || "127.0.0.1"}:${env.ZHUZHU_WEB_PORT || env.PORT || DEFAULT_PANEL_PORT}`;
  const panelUrlObject = new URL(panelUrlInput);
  const panelHost = env.ZHUZHU_WEB_HOST || panelUrlObject.hostname || "127.0.0.1";
  const panelPreferredPort = normalizePort(
    env.ZHUZHU_WEB_PORT || panelUrlObject.port || env.PORT,
    DEFAULT_PANEL_PORT,
  );
  const runtimePreferredPort = normalizePort(env.ZHUZHU_RUNTIME_PORT, DEFAULT_RUNTIME_PORT);
  const appRunPreferredPort = normalizePort(env.ZHUZHU_APP_RUN_PORT, DEFAULT_APP_RUN_PORT);
  const panelPortIsExplicit = Boolean(env.ZHUZHU_PANEL_DEV_SERVER_URL || env.ZHUZHU_WEB_PORT || env.PORT);
  const runtimePortIsExplicit = Boolean(env.ZHUZHU_RUNTIME_PORT);
  const appRunPortIsExplicit = Boolean(env.ZHUZHU_APP_RUN_PORT);
  const pinnedPorts = new Set([
    panelPortIsExplicit ? panelPreferredPort : null,
    runtimePortIsExplicit ? runtimePreferredPort : null,
    appRunPortIsExplicit ? appRunPreferredPort : null,
  ].filter(Number.isInteger));
  const reservedPorts = new Set();

  const choosePort = async (preferredPort, { explicit, host }) => {
    if (explicit) {
      reservedPorts.add(preferredPort);
      return preferredPort;
    }
    const unavailablePorts = new Set([...pinnedPorts, ...reservedPorts]);
    const port = await findAvailablePort(preferredPort, {
      host,
      reservedPorts: unavailablePorts,
      checkPort,
    });
    reservedPorts.add(port);
    return port;
  };

  const panelPort = await choosePort(panelPreferredPort, {
    explicit: panelPortIsExplicit,
    host: panelHost,
  });
  const runtimePort = await choosePort(runtimePreferredPort, {
    explicit: runtimePortIsExplicit,
    // runtime/server/http.js uses server.listen(port), which binds the IPv6
    // unspecified address on macOS. Probe the same address so an existing
    // :::port listener is not mistaken for a free 127.0.0.1 port.
    host: ["::", "0.0.0.0"],
  });
  const appRunHost = String(env.ZHUZHU_APP_RUN_HOST || "0.0.0.0").trim() || "0.0.0.0";
  const appRunPort = await choosePort(appRunPreferredPort, {
    explicit: appRunPortIsExplicit,
    host: appRunHost,
  });
  if (new Set([panelPort, runtimePort, appRunPort]).size !== 3) {
    throw new Error("Panel, runtime, and App Run ports must be different.");
  }

  panelUrlObject.hostname = panelHost;
  panelUrlObject.port = String(panelPort);
  const panelUrl = panelUrlObject.toString().replace(/\/$/, "");

  return {
    panelHost,
    panelPort,
    panelUrl,
    runtimePort,
    runtimeUrl: `http://127.0.0.1:${runtimePort}`,
    appRunHost,
    appRunPort,
    shifted: {
      panel: panelPort !== panelPreferredPort,
      runtime: runtimePort !== runtimePreferredPort,
      appRun: appRunPort !== appRunPreferredPort,
    },
    preferred: {
      panel: panelPreferredPort,
      runtime: runtimePreferredPort,
      appRun: appRunPreferredPort,
    },
  };
}
