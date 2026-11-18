#!/usr/bin/env node
const http = require("node:http");
const path = require("node:path");
const { handleRunBoardRoute } = require("../runtime/server/run-board-http");

const outputRoot = path.resolve(__dirname, "..", "output");
const server = http.createServer(async (req, res) => {
  try {
    const handled = await handleRunBoardRoute(req, res, new URL(req.url, "http://127.0.0.1"), { outputRoot, label: "Vision E2E · Local demo" });
    if (!handled) { res.writeHead(404); res.end("Not found"); }
  } catch (error) {
    res.writeHead(500); res.end("Unable to load local demo results");
  }
});
server.listen(32149, "127.0.0.1", () => console.log("Local demo results: http://127.0.0.1:32149/run-board"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
