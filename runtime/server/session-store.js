const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, "output");

function formatStamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

// Monotonic suffix for atomic-write staging files (see writeSession).
let writeSequence = 0;

// Windows fails `rename` with a sharing violation (EPERM/EACCES/EBUSY) while any
// other handle has the destination open — and v1.4 polls `session.json` while it
// is being rewritten, so this is a *normal* transient, not an error. Reads take
// microseconds, so a short retry ladder clears it.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !RENAME_RETRY_CODES.has(error?.code)) {
        throw error;
      }
      await delay(10 * attempt);
    }
  }
}

function createSessionId() {
  return `session-${formatStamp()}-${randomUUID().slice(0, 8)}`;
}

function isSafeSessionId(value) {
  return /^session-[A-Za-z0-9._-]+$/.test(String(value || ""));
}

// v1.4 REQ-Z15: statuses a session can no longer move away from. Callers poll
// `get_run_summary` / `GET /test-sessions/{id}` until `terminal` is true, so this
// predicate is the single source of truth for "stop polling".
// `pending` (created, not started), `running` and `cancelling` are in-flight.
const TERMINAL_SESSION_STATUSES = new Set(["passed", "failed", "blocked", "cancelled"]);

function isTerminalSessionStatus(status) {
  return TERMINAL_SESSION_STATUSES.has(String(status || ""));
}

// v1.4 REQ-Z15-3/Z15-5: one canonical projection of a session document, shared by
// the id reader (`get_run_summary`) and the list reader (`list_sessions`). Both
// surfaces therefore report the *same* 口径 as the synchronous run response
// (`status` / `firstFailure` / `reportPath`), which is exactly what Z15-3 asserts.
function summarizeSessionDoc(session) {
  if (!session || typeof session !== "object") {
    return null;
  }
  const rounds = Array.isArray(session.rounds) ? session.rounds : [];
  const latest = rounds.at(-1) || null;
  const status = latest?.status || session.status || "pending";
  return {
    sessionId: session.id,
    status,
    terminal: isTerminalSessionStatus(status),
    ok: latest ? latest.ok ?? null : null,
    roundId: latest?.id || null,
    roundCount: rounds.length,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    testFileId: session.testFile?.id || null,
    testFileName: session.testFile?.name || null,
    testFilePath: session.testFile?.path || null,
    authProfile: session.authProfile || "",
    failureType: latest?.failureType || null,
    firstFailure: latest?.firstFailure || null,
    reportPath: latest?.reportPath || null,
    diagnosisPath: latest?.diagnosisPath || null,
    repairContextPath: latest?.repairContextPath || null,
    cancelReason: session.cancelReason || null,
  };
}

class TestSessionStore {
  constructor({ outputRoot = DEFAULT_OUTPUT_ROOT } = {}) {
    this.outputRoot = path.resolve(outputRoot);
    this.sessionsRoot = path.join(this.outputRoot, "sessions");
  }

  getSessionDir(sessionId) {
    if (!isSafeSessionId(sessionId)) {
      return null;
    }
    return path.join(this.sessionsRoot, sessionId);
  }

  getSessionPath(sessionId) {
    const dir = this.getSessionDir(sessionId);
    return dir ? path.join(dir, "session.json") : null;
  }

  async createSession({ request = {}, testFile = {}, authProfile = "", feedback = "" } = {}) {
    const id = createSessionId();
    const dir = this.getSessionDir(id);
    const session = {
      schemaVersion: 1,
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "pending",
      authProfile: authProfile || "",
      testFile,
      request: {
        scope: request.scope || "all",
        caseIds: Array.isArray(request.caseIds) ? request.caseIds : [],
        runNow: request.runNow !== false,
        qualityGate: request.qualityGate === "off" || request.qualityGate === "advisory" || request.qualityGate === "gate" ? request.qualityGate : "advisory",
        allowBlocked: request.allowBlocked === true,
        authBootstrap: request.authBootstrap === "run" ? "run" : "auto",
        // v1.2.1: opt out of shared-browser reuse for this session (default reuse on).
        reuseBrowser: request.reuseBrowser !== false,
        // v1.3 Z10: run this session in its own *visible* browser instead of
        // headless — the parallel multi-instance App-run channel.
        headed: request.headed === true,
        // v1.3 REQ-Z12-3: per-session wall-clock ceiling (ms). 0/absent = the
        // platform default (ZHUZHU_SESSION_HARD_TIMEOUT_MS).
        sessionTimeoutMs: Number.isFinite(Number(request.sessionTimeoutMs)) && Number(request.sessionTimeoutMs) > 0
          ? Number(request.sessionTimeoutMs)
          : 0,
        // 2026-10-27: debug rounds — `stopOnFailure:false` keeps a case running past a failed
        // step (case phase only) so one round surfaces every broken step.
        ...(request.stopOnFailure === false ? { stopOnFailure: false } : {}),
        // 2026-10-27: idle watchdog (ms) — no run event for this long => wedged.
        // Absent = platform default (ZHUZHU_SESSION_IDLE_TIMEOUT_MS); 0 disables.
        ...(request.sessionIdleTimeoutMs !== undefined && request.sessionIdleTimeoutMs !== null && request.sessionIdleTimeoutMs !== "" && Number.isFinite(Number(request.sessionIdleTimeoutMs)) && Number(request.sessionIdleTimeoutMs) >= 0
          ? { sessionIdleTimeoutMs: Number(request.sessionIdleTimeoutMs) }
          : {}),
        // v1.10: fields the round reads back from `session.request`. This list
        // used to silently drop `checkpoint` / `resume` / `codeRefs`, so those
        // request options never reached the round at all.
        ...(request.checkpoint && typeof request.checkpoint === "object" ? { checkpoint: request.checkpoint } : {}),
        ...(request.resume && typeof request.resume === "object" ? { resume: request.resume } : {}),
        ...(request.codeRefs && typeof request.codeRefs === "object" ? { codeRefs: request.codeRefs } : {}),
        // v1.10 Z27: the normalised run target (addresses, profile, credential
        // NAME, vars). Never a secret: credential values stay in the store.
        ...(request.target && typeof request.target === "object" ? { target: request.target } : {}),
        // v1.10 Z29-1: request-level after-step OCR mode.
        ...(typeof request.stepOcr === "string" && request.stepOcr ? { stepOcr: request.stepOcr } : {}),
      },
      feedback: feedback ? [{ message: String(feedback), createdAt: Date.now() }] : [],
      rounds: [],
    };
    await fs.mkdir(path.join(dir, "rounds"), { recursive: true });
    await this.writeSession(session);
    return session;
  }

  async readSession(sessionId) {
    const sessionPath = this.getSessionPath(sessionId);
    if (!sessionPath) {
      return null;
    }
    try {
      return JSON.parse(await fs.readFile(sessionPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      // v1.4: `session.json` is now polled while it is being written (a caller
      // holding an async handle reads it every few hundred ms). `writeSession`
      // is atomic, but a foreign writer — or a filesystem without atomic
      // rename — could still expose a torn read. One retry turns that into a
      // hiccup instead of a spurious "corrupt session" for the poller.
      if (error instanceof SyntaxError) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return JSON.parse(await fs.readFile(sessionPath, "utf8"));
      }
      throw error;
    }
  }

  async writeSession(session) {
    const sessionPath = this.getSessionPath(session?.id);
    if (!sessionPath) {
      throw new Error("Invalid session id.");
    }
    const next = {
      ...session,
      updatedAt: Date.now(),
    };
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    // v1.4: write-then-rename instead of writing in place. A plain writeFile
    // truncates first, so anyone polling this document (async handles, Z15) can
    // observe an empty or half-written file and fail to parse it. Rename is
    // atomic within a directory, so a reader always sees one whole version.
    // The temp name is unique per write so two concurrent writers (e.g. the
    // cancel marker and the round persist) cannot clobber each other's staging file.
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const tempPath = `${sessionPath}.${process.pid}.${++writeSequence}.tmp`;
    try {
      await fs.writeFile(tempPath, text, "utf8");
      await renameWithRetry(tempPath, sessionPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      if (!RENAME_RETRY_CODES.has(error?.code)) {
        throw error;
      }
      // A sharing violation that outlived the retries (antivirus, an indexer, a
      // slow reader). Losing the write would be far worse than losing atomicity
      // — persisting progress is the whole point — so fall back to an in-place
      // write. `readSession` retries a torn parse, which is the only exposure.
      await fs.writeFile(sessionPath, text, "utf8");
    }
    return next;
  }

  getRoundDir(sessionId, roundNo) {
    const sessionDir = this.getSessionDir(sessionId);
    if (!sessionDir) {
      return null;
    }
    return path.join(sessionDir, "rounds", `round-${roundNo}`);
  }

  async writeRoundArtifact(sessionId, roundNo, name, value) {
    const roundDir = this.getRoundDir(sessionId, roundNo);
    if (!roundDir) {
      throw new Error("Invalid session id.");
    }
    await fs.mkdir(roundDir, { recursive: true });
    const targetPath = path.join(roundDir, name);
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    await fs.writeFile(targetPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    return targetPath;
  }

  async appendRound(session, round) {
    const next = {
      ...session,
      status: round.status,
      rounds: [...(session.rounds || []), round],
    };
    return this.writeSession(next);
  }

  async appendFeedback(sessionId, feedback) {
    const session = await this.readSession(sessionId);
    if (!session) {
      return null;
    }
    const item = {
      message: String(feedback?.message || feedback || "").trim(),
      nextAction: String(feedback?.nextAction || "review-and-rerun").trim(),
      createdAt: Date.now(),
    };
    if (!item.message) {
      throw new Error("feedback message is required.");
    }
    return this.writeSession({
      ...session,
      feedback: [...(session.feedback || []), item],
    });
  }

  async readLatestReport(sessionId) {
    const session = await this.readSession(sessionId);
    if (!session) {
      return null;
    }
    const latest = (session.rounds || []).at(-1);
    if (!latest?.reportPath) {
      return { session, latest, markdown: "" };
    }
    const markdown = await fs.readFile(latest.reportPath, "utf8").catch(() => "");
    return { session, latest, markdown };
  }

  async readRoundArtifact(sessionId, roundIdOrNo, name) {
    const session = await this.readSession(sessionId);
    if (!session || !/^[A-Za-z0-9._-]+$/.test(String(name || ""))) {
      return null;
    }
    const round = (session.rounds || []).find((item) =>
      item.id === roundIdOrNo || String(item.roundNo) === String(roundIdOrNo) || `round-${item.roundNo}` === roundIdOrNo,
    );
    if (!round) {
      return null;
    }
    const roundDir = this.getRoundDir(sessionId, round.roundNo);
    const targetPath = path.join(roundDir, name);
    const relative = path.relative(roundDir, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    const raw = await fs.readFile(targetPath, "utf8").catch(() => "");
    if (!raw) {
      return null;
    }
    if (name.endsWith(".json")) {
      return { session, latest: round, artifactPath: targetPath, json: JSON.parse(raw) };
    }
    return { session, latest: round, artifactPath: targetPath, text: raw };
  }

  // v1.4 REQ-Z15-5: reverse-lookup recent sessions, optionally filtered by test
  // file. This exists to *delete* the "按 mtime 猜最新目录" posture (`ls -1dt
  // session-* | head -1`), which silently picks up somebody else's concurrent
  // session and turns it into your evidence. Session ids are timestamp-prefixed
  // (`session-YYYYMMDD-HHMMSS-xxxxxxxx`), so a lexicographic descending sort of
  // the directory names is already newest-first — no stat() and no mtime.
  async listSessions({ testFileId = "", testFilePath = "", status = "", limit = 10, scanLimit = 500 } = {}) {
    let names;
    try {
      names = await fs.readdir(this.sessionsRoot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { sessions: [], scanned: 0, truncated: false };
      }
      throw error;
    }
    const wantedLimit = Math.min(Math.max(1, Number(limit) || 10), 100);
    const maxScan = Math.min(Math.max(wantedLimit, Number(scanLimit) || 500), 5_000);
    const candidates = names.filter(isSafeSessionId).sort().reverse();
    const scanned = candidates.slice(0, maxScan);
    const wantedFileId = String(testFileId || "").trim();
    const wantedFilePath = String(testFilePath || "").trim();
    const wantedStatus = String(status || "").trim();
    const filtered = Boolean(wantedFileId || wantedFilePath || wantedStatus);
    const matches = [];
    // Read in small concurrent batches: enough parallelism to stay fast on a
    // large sessions/ dir, bounded so it never opens hundreds of handles at once.
    for (let index = 0; index < scanned.length; index += 25) {
      const batch = scanned.slice(index, index + 25);
      const docs = await Promise.all(batch.map((id) => this.readSession(id).catch(() => null)));
      for (const doc of docs) {
        const summary = summarizeSessionDoc(doc);
        if (!summary) {
          continue;
        }
        if (wantedFileId && summary.testFileId !== wantedFileId) {
          continue;
        }
        if (wantedFilePath && summary.testFilePath !== wantedFilePath) {
          continue;
        }
        if (wantedStatus && summary.status !== wantedStatus) {
          continue;
        }
        matches.push(summary);
      }
      // Without a filter the newest-first scan order already answers the query,
      // so stop as soon as the page is full instead of reading the whole dir.
      if (!filtered && matches.length >= wantedLimit) {
        break;
      }
    }
    matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return {
      sessions: matches.slice(0, wantedLimit),
      scanned: scanned.length,
      truncated: candidates.length > scanned.length,
    };
  }

  async readLatestRoundArtifact(sessionId, name) {
    const session = await this.readSession(sessionId);
    const latest = (session?.rounds || []).at(-1);
    if (!latest) {
      return null;
    }
    return this.readRoundArtifact(sessionId, latest.id, name);
  }
}

module.exports = {
  DEFAULT_OUTPUT_ROOT,
  TERMINAL_SESSION_STATUSES,
  TestSessionStore,
  createSessionId,
  isSafeSessionId,
  isTerminalSessionStatus,
  summarizeSessionDoc,
};
