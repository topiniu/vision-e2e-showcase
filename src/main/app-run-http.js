"use strict";


function buildEnqueueResponse(enqueued, request) {
  return {
    ok: true,
    status: enqueued.status, // "queued" | "running"
    externalRunId: enqueued.runId,
    testFilePath: request.testFilePath || "",
    scope: request.scope || "all",
    caseId: request.caseId || null,
    queuePosition: enqueued.queuePosition,
    summary: null,
    reportPath: null,
    accepted: true,
    links: {
      status: `/app-runs/${enqueued.runId}`,
      events: `/app-runs/${enqueued.runId}/events`,
    },
  };
}

// Status code for the synchronous (`wait=1`) opt-in path. Mirrors the legacy
// run-file contract: timeout -> 504, app-unavailable -> 503, everything else
// (passed or failed) -> 200 with the summarized body.
function resolveWaitStatus(result) {
  const status = result && result.status;
  if (status === "timeout") {
    return 504;
  }
  if (status === "app-unavailable" || status === "app-not-ready") {
    return 503;
  }
  return 200;
}

function formatSseEvent(event) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// Streams a run's events as Server-Sent Events. Replays everything after
// `cursor` first (so a reconnecting client backfills what it missed), then
// subscribes for live events. Ends the response once a terminal event is sent.
// `res` only needs writeHead/write/end/on; `queue` is the app-run queue.
function streamRunEvents({ queue, runId, res, cursor = 0, req = null }) {
  if (!queue.has(runId)) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: { code: "not-found", message: "Run not found." } }));
    return { ok: false };
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  let ended = false;
  let unsubscribe = () => {};
  const cleanup = () => {
    if (ended) {
      return;
    }
    ended = true;
    unsubscribe();
  };
  const emit = (event) => {
    if (ended) {
      return;
    }
    res.write(formatSseEvent(event));
    if (queue.isTerminal(event.status)) {
      cleanup();
      res.end();
    }
  };

  // Replay backlog synchronously (no await -> no event can slip in between the
  // replay and the subscribe below), then go live.
  const backlog = queue.getEventsSince(runId, Number.isFinite(cursor) ? cursor : 0) || [];
  for (const event of backlog) {
    emit(event);
    if (ended) {
      return { ok: true, replayed: backlog.length, live: false };
    }
  }
  unsubscribe = queue.subscribe(runId, emit);
  if (req && typeof req.on === "function") {
    req.on("close", cleanup);
  }
  return { ok: true, replayed: backlog.length, live: true, cleanup };
}

module.exports = {
  buildEnqueueResponse,
  resolveWaitStatus,
  formatSseEvent,
  streamRunEvents,
};
