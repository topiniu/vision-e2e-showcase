"use strict";


const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { isProcessAlive } = require("./active-session-registry");
const { summarizeSessionDoc } = require("./session-store");

const BOARD_DIRNAME = "run-board";
const LIVE_WRITE_INTERVAL_MS = 1000;
const HISTORY_FILE = "history.jsonl";
const HISTORY_ROTATE_BYTES = 4 * 1024 * 1024;
const HISTORY_TAIL_BYTES = 1024 * 1024;
const SESSION_BACKFILL_LIMIT = 200;
const BACKFILL_CACHE_MS = 15_000;
const MAX_TEXT = 300;

const TERMINAL_STATUSES = new Set([
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "timeout",
  "error",
  "stopped",
  "completed",
]);

// What kind of work an entry is, in the words the page shows.
const KIND_LABELS = {
  "headless-session": "无头会话",
  "headed-session": "有头会话",
  "batch-item": "批量排队",
  "app-run": "可视化 App-run",
  "panel-run": "面板手动运行",
  "runtime-run": "独立 Runtime",
  "cli-run": "命令行运行",
};

const boards = new Map();

function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}

function clip(value, max = MAX_TEXT) {
  if (value == null) {
    return null;
  }
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeFinalStatus(status, ok) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "completed") {
    return ok === false ? "failed" : "passed";
  }
  if (TERMINAL_STATUSES.has(value)) {
    return value;
  }
  if (ok === true) {
    return "passed";
  }
  if (ok === false) {
    return "failed";
  }
  return value || "unknown";
}

function compactFailure(failure) {
  if (!failure || typeof failure !== "object") {
    return null;
  }
  return {
    title: clip(failure.title || failure.stepTitle || failure.stepId || null, 120),
    code: clip(failure.code || null, 80),
    message: clip(failure.message || null),
    caseId: failure.caseId || null,
  };
}

const HOST = {
  pid: process.pid,
  hostname: os.hostname(),
  processStartedAt: Math.round(Date.now() - process.uptime() * 1000),
};

class RunBoard {
  constructor({ outputRoot }) {
    this.outputRoot = path.resolve(outputRoot);
    this.dir = path.join(this.outputRoot, BOARD_DIRNAME);
    this.liveDir = path.join(this.dir, "live");
    this.historyPath = path.join(this.dir, HISTORY_FILE);
    this.entries = new Map();
    this.subscribers = new Set();
    this.liveTimers = new Map();
    this.backfillCache = null;
    this.serverLabels = new Set();
  }

  // Which HTTP surfaces this process serves the board on (for the page header).
  noteServer(label) {
    if (label) {
      this.serverLabels.add(String(label));
    }
  }

  register(input = {}) {
    const id = String(input.id || "").trim();
    if (!id) {
      return null;
    }
    const now = Date.now();
    const existing = this.entries.get(id);
    const status = input.status === "queued" ? "queued" : "running";
    const entry = {
      ...(existing || {}),
      id,
      kind: input.kind || existing?.kind || "headless-session",
      title: clip(input.title || existing?.title || input.testFileName || input.testFilePath || id, 160),
      testFileName: input.testFileName ?? existing?.testFileName ?? null,
      testFilePath: input.testFilePath ?? existing?.testFilePath ?? null,
      trigger: input.trigger ?? existing?.trigger ?? null,
      batchId: input.batchId ?? existing?.batchId ?? null,
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      headed: input.headed ?? existing?.headed ?? false,
      status,
      queuedAt: input.queuedAt ?? existing?.queuedAt ?? (status === "queued" ? now : null),
      startedAt: status === "running" ? input.startedAt ?? existing?.startedAt ?? now : null,
      queuePosition: input.queuePosition ?? null,
      updatedAt: now,
      host: HOST,
      progress: existing?.progress || {
        caseTotal: Number.isFinite(Number(input.caseTotal)) ? Number(input.caseTotal) : null,
        casesDone: 0,
        casesPassed: 0,
        casesFailed: 0,
        currentCase: null,
        step: null,
        stepsPassed: 0,
        stepsFailed: 0,
        lastEventAt: null,
      },
    };
    if (Number.isFinite(Number(input.caseTotal))) {
      entry.progress.caseTotal = Number(input.caseTotal);
    }
    // Resolves a run id to the case it ran (session runs are `<session>-<round>-<case>`).
    entry.caseNames = input.caseNames || existing?.caseNames || null;
    this.entries.set(id, entry);
    this.touch(entry, { immediate: true });
    return entry;
  }

  // Mark a queued entry as started (keeps its queuedAt, so wait time is visible).
  start(id, patch = {}) {
    const entry = this.entries.get(String(id));
    if (!entry) {
      return this.register({ ...patch, id, status: "running" });
    }
    entry.status = "running";
    entry.startedAt = patch.startedAt || Date.now();
    entry.queuePosition = null;
    Object.assign(entry, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "status")));
    this.touch(entry, { immediate: true });
    return entry;
  }

  update(id, patch = {}) {
    const entry = this.entries.get(String(id));
    if (!entry) {
      return null;
    }
    Object.assign(entry, patch, { updatedAt: Date.now() });
    this.touch(entry);
    return entry;
  }

  // Drop an entry without recording history (a queued placeholder whose real
  // work registered under its own id).
  remove(id) {
    const key = String(id);
    if (!this.entries.has(key)) {
      return;
    }
    this.entries.delete(key);
    this.clearLive(key);
    this.notify({ type: "removed", id: key });
  }

  resolveCase(entry, event) {
    if (event.caseName || event.caseId) {
      return { id: event.caseId || null, name: event.caseName || event.caseId };
    }
    const runId = String(event.runId || "");
    if (/-root-setup$/.test(runId)) {
      return { id: "root-setup", name: "Root setup", root: true };
    }
    if (/-root-teardown$/.test(runId)) {
      return { id: "root-teardown", name: "Root teardown", root: true };
    }
    const names = entry.caseNames || null;
    if (names && entry.sessionId) {
      for (const [caseId, caseName] of Object.entries(names)) {
        if (runId.endsWith(`-${caseId}`)) {
          return { id: caseId, name: caseName || caseId };
        }
      }
    }
    return runId ? { id: runId, name: runId } : null;
  }

  // run()-level events → progress. Cheap: called for every step of every run.
  recordEvent(id, event = {}) {
    const entry = this.entries.get(String(id));
    if (!entry || !event || typeof event !== "object") {
      return;
    }
    const progress = entry.progress;
    progress.lastEventAt = Date.now();
    switch (event.type) {
      case "run-start": {
        const current = this.resolveCase(entry, event);
        progress.currentCase = current ? { ...current, startedAt: Date.now(), totalSteps: event.totalSteps ?? null, runId: event.runId || null } : null;
        progress.step = null;
        break;
      }
      case "step-start":
        progress.step = {
          index: event.stepIndex ?? null,
          id: event.stepId || null,
          title: clip(event.stepTitle || event.stepId || null, 120),
          actionType: event.actionType || null,
          phase: event.phase || null,
          startedAt: Date.now(),
          total: progress.currentCase?.totalSteps ?? null,
        };
        break;
      case "step-complete":
        if (event.status === "passed") {
          progress.stepsPassed += 1;
        } else if (event.status === "failed") {
          progress.stepsFailed += 1;
          progress.lastFailure = compactFailure({
            title: event.stepTitle || event.stepId,
            code: event.error?.code,
            message: event.message || event.error?.message,
            caseId: progress.currentCase?.id || null,
          });
        }
        break;
      case "run-complete": {
        const current = progress.currentCase;
        if (current && !current.root) {
          progress.casesDone += 1;
          if (["passed", "success"].includes(event.status) || event.result?.ok === true) {
            progress.casesPassed += 1;
          } else {
            progress.casesFailed += 1;
          }
        }
        progress.step = null;
        break;
      }
      default:
        return;
    }
    this.touch(entry);
  }

  finish(id, result = {}) {
    const key = String(id);
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    this.entries.delete(key);
    this.clearLive(key);
    const finishedAt = result.finishedAt || Date.now();
    const status = normalizeFinalStatus(result.status, result.ok);
    const record = {
      id: key,
      kind: entry.kind,
      title: entry.title,
      testFileName: entry.testFileName,
      testFilePath: entry.testFilePath,
      trigger: entry.trigger,
      batchId: entry.batchId,
      sessionId: entry.sessionId,
      headed: entry.headed,
      status,
      ok: status === "passed" ? true : status === "failed" ? false : null,
      queuedAt: entry.queuedAt,
      startedAt: entry.startedAt,
      finishedAt,
      waitMs: entry.queuedAt && entry.startedAt ? Math.max(0, entry.startedAt - entry.queuedAt) : null,
      durationMs: entry.startedAt ? Math.max(0, finishedAt - entry.startedAt) : null,
      // A blocked session ran 0 cases; the planned count is the useful number.
      casesTotal: Math.max(Number(result.casesTotal) || 0, Number(entry.progress.caseTotal) || 0) || (result.casesTotal ?? entry.progress.caseTotal ?? null),
      casesPassed: result.casesPassed ?? entry.progress.casesPassed,
      casesFailed: result.casesFailed ?? entry.progress.casesFailed,
      stepsPassed: entry.progress.stepsPassed,
      stepsFailed: entry.progress.stepsFailed,
      failureType: result.failureType || null,
      firstFailure: compactFailure(result.firstFailure) || entry.progress.lastFailure || null,
      reportPath: result.reportPath || null,
      host: { pid: HOST.pid, hostname: HOST.hostname },
    };
    this.appendHistory(record);
    this.notify({ type: "finished", id: key, record });
    return record;
  }

  // ---- persistence -------------------------------------------------------

  touch(entry, { immediate = false } = {}) {
    entry.updatedAt = Date.now();
    this.notify({ type: "changed", id: entry.id });
    if (immediate) {
      this.writeLive(entry.id);
      return;
    }
    if (this.liveTimers.has(entry.id)) {
      return;
    }
    const timer = setTimeout(() => {
      this.liveTimers.delete(entry.id);
      this.writeLive(entry.id);
    }, LIVE_WRITE_INTERVAL_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.liveTimers.set(entry.id, timer);
  }

  writeLive(id) {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    const file = path.join(this.liveDir, `${safeId(id)}.json`);
    const { caseNames, ...serializable } = entry;
    try {
      fs.mkdirSync(this.liveDir, { recursive: true });
      const staging = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(staging, JSON.stringify(serializable));
      fs.renameSync(staging, file);
    } catch (_error) {
      // observation only — a failed heartbeat never affects a run
    }
  }

  clearLive(id) {
    const timer = this.liveTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.liveTimers.delete(id);
    }
    try {
      fs.rmSync(path.join(this.liveDir, `${safeId(id)}.json`), { force: true });
    } catch (_error) {
      // best effort
    }
  }

  appendHistory(record) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        if (fs.statSync(this.historyPath).size > HISTORY_ROTATE_BYTES) {
          fs.renameSync(this.historyPath, path.join(this.dir, "history.1.jsonl"));
        }
      } catch (_error) {
        // no history yet
      }
      fs.appendFileSync(this.historyPath, `${JSON.stringify(record)}\n`);
    } catch (_error) {
      // observation only
    }
  }

  async readHistoryTail(limit) {
    const read = async (file) => {
      try {
        const handle = await fsp.open(file, "r");
        try {
          const { size } = await handle.stat();
          const length = Math.min(size, HISTORY_TAIL_BYTES);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, size - length);
          const lines = buffer.toString("utf8").split("\n");
          if (size > length) {
            lines.shift(); // partial first line
          }
          return lines.filter(Boolean).map((line) => {
            try {
              return JSON.parse(line);
            } catch (_error) {
              return null;
            }
          }).filter(Boolean);
        } finally {
          await handle.close();
        }
      } catch (_error) {
        return [];
      }
    };
    let records = await read(this.historyPath);
    if (records.length < limit) {
      records = [...(await read(path.join(this.dir, "history.1.jsonl"))), ...records];
    }
    return records.slice(-limit).reverse();
  }

  // Sessions that finished before the board existed (or in a process that never
  // reported). Read-only, cached; the session documents stay the source of truth.
  async readSessionBackfill() {
    if (this.backfillCache && Date.now() - this.backfillCache.at < BACKFILL_CACHE_MS) {
      return this.backfillCache.records;
    }
    const sessionsRoot = path.join(this.outputRoot, "sessions");
    let names = [];
    try {
      names = (await fsp.readdir(sessionsRoot)).filter((name) => name.startsWith("session-"));
    } catch (_error) {
      names = [];
    }
    names.sort().reverse();
    const records = [];
    for (const name of names.slice(0, SESSION_BACKFILL_LIMIT)) {
      try {
        const doc = JSON.parse(await fsp.readFile(path.join(sessionsRoot, name, "session.json"), "utf8"));
        const summary = summarizeSessionDoc(doc);
        if (!summary || !summary.terminal) {
          continue;
        }
        const rounds = Array.isArray(doc.rounds) ? doc.rounds : [];
        const latest = rounds.at(-1) || {};
        const started = Number(doc.createdAt) || Date.parse(doc.createdAt) || null;
        const finished = Number(doc.updatedAt) || Date.parse(doc.updatedAt) || null;
        records.push({
          id: summary.sessionId,
          kind: doc.request?.headed === true ? "headed-session" : "headless-session",
          title: summary.testFileName || summary.testFilePath || summary.sessionId,
          testFileName: summary.testFileName,
          testFilePath: summary.testFilePath,
          sessionId: summary.sessionId,
          status: normalizeFinalStatus(summary.status, summary.ok),
          ok: summary.ok,
          startedAt: started,
          finishedAt: finished,
          durationMs: started && finished ? Math.max(0, finished - started) : null,
          // rounds before v1.11 carry no tallies; one evidence bundle is written per case.
          casesTotal: latest.caseCount ?? (Array.isArray(latest.evidenceBundles) ? latest.evidenceBundles.length : null),
          casesPassed: latest.passedCount ?? null,
          casesFailed: latest.failedCount ?? null,
          failureType: summary.failureType,
          firstFailure: compactFailure(summary.firstFailure),
          reportPath: summary.reportPath,
          source: "sessions-archive",
        });
      } catch (_error) {
        // unreadable / mid-write session — skip
      }
    }
    this.backfillCache = { at: Date.now(), records };
    return records;
  }

  // Live entries written by OTHER processes on this workspace.
  async readForeignLive() {
    let files = [];
    try {
      files = (await fsp.readdir(this.liveDir)).filter((name) => name.endsWith(".json"));
    } catch (_error) {
      return [];
    }
    const output = [];
    for (const name of files) {
      try {
        const entry = JSON.parse(await fsp.readFile(path.join(this.liveDir, name), "utf8"));
        if (this.entries.has(entry.id)) {
          continue;
        }
        const host = entry.host || {};
        const sameHost = !host.hostname || host.hostname === HOST.hostname;
        if (host.pid === HOST.pid && host.processStartedAt === HOST.processStartedAt) {
          // Our own leftover from a crashed write path: we know it is not live.
          continue;
        }
        if (sameHost && host.pid && !isProcessAlive(host.pid)) {
          // Owner process died mid-run. Not live — and not "still running" forever.
          await fsp.rm(path.join(this.liveDir, name), { force: true }).catch(() => {});
          continue;
        }
        output.push({ ...entry, foreign: true });
      } catch (_error) {
        // half-written file — next poll
      }
    }
    return output;
  }

  // ---- read side ---------------------------------------------------------

  async snapshot({ historyLimit = 100 } = {}) {
    const limit = Math.max(1, Math.min(1000, Number(historyLimit) || 100));
    const own = [...this.entries.values()].map(({ caseNames, ...entry }) => entry);
    const foreign = await this.readForeignLive();
    const all = [...own, ...foreign];
    const now = Date.now();
    const live = all
      .filter((entry) => entry.status === "running")
      .map((entry) => ({ ...entry, elapsedMs: entry.startedAt ? now - entry.startedAt : null }))
      .sort((left, right) => (left.startedAt || 0) - (right.startedAt || 0));
    const queued = all
      .filter((entry) => entry.status === "queued")
      .map((entry) => ({ ...entry, waitingMs: entry.queuedAt ? now - entry.queuedAt : null }))
      .sort((left, right) => (left.queuePosition || 0) - (right.queuePosition || 0) || (left.queuedAt || 0) - (right.queuedAt || 0));
    const recorded = await this.readHistoryTail(limit);
    const seen = new Set(recorded.map((item) => item.sessionId || item.id));
    const backfill = (await this.readSessionBackfill()).filter((item) => !seen.has(item.id));
    const history = [...recorded, ...backfill]
      .sort((left, right) => (right.finishedAt || 0) - (left.finishedAt || 0))
      .slice(0, limit);
    return {
      generatedAt: now,
      host: { hostname: HOST.hostname, pid: HOST.pid, servers: [...this.serverLabels] },
      live,
      queued,
      history,
      historyWindow: { limit, count: history.length },
      stats: buildStats({ live, queued, history, now }),
      kinds: KIND_LABELS,
    };
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  notify(event) {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch (_error) {
        this.subscribers.delete(listener);
      }
    }
  }
}

// Numbers for the top of the page. Computed from the history window the page
// already has, so the tiles can never disagree with the table under them.
function buildStats({ live, queued, history, now }) {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const today = history.filter((item) => (item.finishedAt || 0) >= dayStart.getTime());
  const judged = today.filter((item) => item.status === "passed" || item.status === "failed");
  const passed = today.filter((item) => item.status === "passed").length;
  const durations = today.map((item) => item.durationMs).filter((value) => Number.isFinite(value));
  durations.sort((a, b) => a - b);
  const hourly = [];
  for (let offset = 23; offset >= 0; offset -= 1) {
    const end = now - offset * 3_600_000;
    const start = end - 3_600_000;
    const bucket = history.filter((item) => item.finishedAt > start && item.finishedAt <= end);
    hourly.push({
      hourEnd: end,
      passed: bucket.filter((item) => item.status === "passed").length,
      failed: bucket.filter((item) => item.status === "failed").length,
      other: bucket.filter((item) => item.status !== "passed" && item.status !== "failed").length,
    });
  }
  const byKind = {};
  for (const item of today) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  }
  return {
    running: live.length,
    queued: queued.length,
    today: {
      finished: today.length,
      passed,
      failed: today.filter((item) => item.status === "failed").length,
      blocked: today.filter((item) => item.status === "blocked").length,
      cancelled: today.filter((item) => item.status === "cancelled" || item.status === "stopped").length,
      passRate: judged.length ? passed / judged.length : null,
      medianDurationMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      byKind,
    },
    hourly,
  };
}

// A batch's items are not sessions until a worker picks them up. Register each
// as a queued placeholder; `start(index)` drops it the moment its session takes
// over under its own id. Shared by every batch entry (HTTP, MCP, panel).
function registerBatchPlaceholders(board, { items = [], trigger = null, headed = false, batchId = null } = {}) {
  const id = batchId || `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const placeholderId = (index) => `${id}-${index + 1}`;
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const label = item?.testFilePath || item?.path || item?.testFile?.name || item?.testFileId || `item ${index + 1}`;
    board?.register({
      id: placeholderId(index),
      kind: "batch-item",
      status: "queued",
      title: String(label),
      testFilePath: item?.testFilePath || item?.path || null,
      batchId: id,
      trigger,
      headed,
      queuePosition: index + 1,
    });
  });
  return {
    batchId: id,
    start: (index) => board?.remove(placeholderId(index)),
  };
}

function getRunBoard({ outputRoot } = {}) {
  if (!outputRoot) {
    return null;
  }
  const key = path.resolve(outputRoot);
  if (!boards.has(key)) {
    boards.set(key, new RunBoard({ outputRoot: key }));
  }
  return boards.get(key);
}

module.exports = {
  KIND_LABELS,
  RunBoard,
  buildStats,
  getRunBoard,
  normalizeFinalStatus,
  registerBatchPlaceholders,
};
