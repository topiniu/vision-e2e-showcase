"use strict";


const fs = require("node:fs");
const path = require("node:path");
const { getRunBoard } = require("./run-board");

const PAGE_PATH = path.join(__dirname, "run-board-page.html");
const PUSH_THROTTLE_MS = 800;
const TICK_MS = 5000;
const HEARTBEAT_MS = 15000;

let pageCache = null;

function readPage() {
  // Re-read in development so the page can be edited without a restart.
  if (pageCache && process.env.NODE_ENV === "production") {
    return pageCache;
  }
  pageCache = fs.readFileSync(PAGE_PATH, "utf8");
  return pageCache;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

// Returns true when the request was a board route (and has been answered).
async function handleRunBoardRoute(req, res, url, { outputRoot, label = null } = {}) {
  if (req.method !== "GET" || !(url.pathname === "/run-board" || url.pathname.startsWith("/run-board/"))) {
    return false;
  }
  const board = getRunBoard({ outputRoot });
  if (!board) {
    sendJson(res, 503, { ok: false, error: { code: "run-board-unavailable", message: "No workspace output root." } });
    return true;
  }
  board.noteServer(label);
  if (url.pathname === "/run-board" || url.pathname === "/run-board/") {
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readPage());
    } catch (error) {
      sendJson(res, 500, { ok: false, error: { code: "run-board-page-missing", message: error.message } });
    }
    return true;
  }
  if (url.pathname === "/run-board/data") {
    const snapshot = await board.snapshot({ historyLimit: url.searchParams.get("history") || 100 });
    sendJson(res, 200, { ok: true, data: snapshot });
    return true;
  }
  if (url.pathname === "/run-board/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    let pending = null;
    let finishedSinceLastPush = false;
    let previousHistoryHead = null;
    const push = async () => {
      pending = null;
      if (closed) {
        return;
      }
      try {
        const snapshot = await board.snapshot({ historyLimit: 1 });
        const head = snapshot.history[0];
        const historyHead = head ? `${head.id}:${head.finishedAt}` : "";
        const payload = {
          generatedAt: snapshot.generatedAt,
          live: snapshot.live,
          queued: snapshot.queued,
          // Tell the page to refetch history/stats only when something finished.
          historyChanged: finishedSinceLastPush || (previousHistoryHead !== null && historyHead !== previousHistoryHead),
        };
        previousHistoryHead = historyHead;
        finishedSinceLastPush = false;
        res.write(`event: board\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (_error) {
        // next change / tick will retry
      }
    };
    const schedule = () => {
      if (!pending && !closed) {
        pending = setTimeout(push, PUSH_THROTTLE_MS);
      }
    };
    const unsubscribe = board.subscribe((event) => {
      if (event?.type === "finished") {
        finishedSinceLastPush = true;
      }
      schedule();
    });
    const tick = setInterval(schedule, TICK_MS);
    const heartbeat = setInterval(() => {
      if (!closed) {
        res.write(": heartbeat\n\n");
      }
    }, HEARTBEAT_MS);
    const close = () => {
      closed = true;
      unsubscribe();
      clearInterval(tick);
      clearInterval(heartbeat);
      if (pending) {
        clearTimeout(pending);
      }
    };
    req.on("close", close);
    res.on("error", close);
    await push();
    return true;
  }
  sendJson(res, 404, { ok: false, error: { code: "not-found", message: "Run board routes: /run-board, /run-board/data, /run-board/events." } });
  return true;
}

module.exports = {
  handleRunBoardRoute,
};
