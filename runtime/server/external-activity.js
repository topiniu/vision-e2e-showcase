const http = require("node:http");

const DEFAULT_ACTIVITY_HOST = "127.0.0.1";
const DEFAULT_ACTIVITY_PORT = 32147;

const ROUTE_CAPABILITIES = [
  { method: "GET", pattern: /^\/capabilities$/, capability: "capabilities.read", label: "Read capabilities" },
  { method: "GET", pattern: /^\/schema\//, capability: "schema.read", label: "Read integration schema" },
  { method: "GET", pattern: /^\/auth\/status$/, capability: "auth.status", label: "Check auth profile" },
  { method: "POST", pattern: /^\/auth\/capture$/, capability: "auth.capture", label: "Capture auth profile" },
  { method: "POST", pattern: /^\/auth\/reset$/, capability: "auth.reset", label: "Reset auth profile" },
  { method: "POST", pattern: /^\/validate-test-file$/, capability: "testFile.validate", label: "Validate test file" },
  { method: "POST", pattern: /^\/test-sessions$/, capability: "testSession.create", label: "Create test session" },
  { method: "POST", pattern: /^\/test-sessions\/[^/]+\/run$/, capability: "testSession.run", label: "Run test session" },
  { method: "POST", pattern: /^\/test-sessions\/[^/]+\/feedback$/, capability: "testSession.feedback", label: "Submit session feedback" },
  { method: "GET", pattern: /^\/test-sessions\/[^/]+\/repair-context$/, capability: "testSession.repairContext", label: "Read repair context" },
  { method: "GET", pattern: /^\/test-sessions\/[^/]+\/rounds\/[^/]+\/repair-context$/, capability: "testSession.repairContext", label: "Read repair context" },
  { method: "GET", pattern: /^\/test-sessions\/[^/]+\/report$/, capability: "testSession.report", label: "Read session report" },
  { method: "GET", pattern: /^\/test-sessions\/[^/]+$/, capability: "testSession.read", label: "Read test session" },
  { method: "POST", pattern: /^\/run$/, capability: "runtime.run", label: "Run runtime payload" },
  { method: "POST", pattern: /^\/invoke$/, capability: "runtime.invoke", label: "Invoke capability" },
];

function matchExternalCapability(method, pathname) {
  return ROUTE_CAPABILITIES.find((route) => route.method === method && route.pattern.test(pathname)) || null;
}

function createExternalActivity(req, url, sequence = 0) {
  const route = matchExternalCapability(req.method, url.pathname);
  if (!route) {
    return null;
  }
  return {
    id: `runtime-http-${Date.now()}-${sequence}`,
    capability: route.capability,
    label: route.label,
    method: req.method,
    path: url.pathname,
    source: "Runtime API",
    caller: req.socket?.remoteAddress || "local tool",
    startedAt: new Date().toISOString(),
  };
}

function createExternalActivityReporter({
  host = process.env.ZHUZHU_ACTIVITY_HOST || DEFAULT_ACTIVITY_HOST,
  port = Number(process.env.ZHUZHU_ACTIVITY_PORT || process.env.ZHUZHU_APP_RUN_PORT || DEFAULT_ACTIVITY_PORT),
} = {}) {
  let pending = Promise.resolve();
  return (activity) => {
    if (!activity || !Number.isFinite(port) || port <= 0) {
      return;
    }
    pending = pending.then(() => new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(activity));
      const request = http.request({
        host,
        port,
        path: "/external-activity/events",
        method: "POST",
        timeout: 800,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
        },
      }, (response) => {
        response.resume();
        response.on("end", resolve);
      });
      request.on("error", resolve);
      request.on("timeout", () => request.destroy());
      request.end(body);
    })).catch(() => {});
  };
}

module.exports = {
  createExternalActivity,
  createExternalActivityReporter,
  matchExternalCapability,
};
