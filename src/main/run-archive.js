const fs = require("node:fs/promises");
const path = require("node:path");

const RUN_ARCHIVE_SCHEMA_VERSION = 2;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function isInsideDirectory(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function listReportFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "steps") {
        files.push(...await listReportFiles(target));
      }
    } else if (entry.isFile() && entry.name === "report.json") {
      files.push(target);
    }
  }
  return files;
}

async function getDirectorySize(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(target);
    } else if (entry.isFile()) {
      const stat = await fs.stat(target).catch(() => null);
      total += stat?.size || 0;
    }
  }
  return total;
}

function toNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeRunStatus(report = {}) {
  const ok = report.summary?.ok;
  if (ok === true) {
    return "passed";
  }
  if (ok === false || report.error) {
    return "failed";
  }
  if (report.telemetry?.errorCount != null) {
    return Number(report.telemetry.errorCount) > 0 ? "failed" : "passed";
  }
  return "unknown";
}

function safeString(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function pickErrorMessage(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || error.code || error.error || safeString(error);
}

function getStepTitle(step = {}) {
  return (
    step.input?.stepTitle ||
    step.input?.title ||
    step.input?.id ||
    step.stepTitle ||
    step.title ||
    step.id ||
    ""
  );
}

function getStepActionType(step = {}) {
  return step.input?.type || step.input?.kind || step.type || step.kind || "";
}

function getStepTracePath(step = {}) {
  return (
    step.evidence?.tracePath ||
    step.data?.evidence?.tracePath ||
    step.raw?.data?.evidence?.tracePath ||
    step.result?.evidence?.tracePath ||
    null
  );
}

function getScreenshotPath(step = {}, key) {
  return (
    step.evidence?.[key] ||
    step.data?.evidence?.[key] ||
    step.raw?.data?.evidence?.[key] ||
    step.result?.evidence?.[key] ||
    null
  );
}

function getStepRequest(step = {}) {
  return (
    step.data?.action?.apiRequest ||
    step.raw?.data?.action?.apiRequest ||
    step.input?.request ||
    step.request ||
    null
  );
}

function getStepResponse(step = {}) {
  return (
    step.data?.action?.apiResponse ||
    step.data?.expectation?.response ||
    step.raw?.data?.action?.apiResponse ||
    step.raw?.data?.expectation?.response ||
    null
  );
}

function findFailedStep(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const caseResults = Array.isArray(value.caseResults) ? value.caseResults : [];
  for (const caseResult of caseResults) {
    const found = findFailedStep(caseResult?.result || caseResult);
    if (found) {
      return found;
    }
  }
  const resultSteps = Array.isArray(value.data?.results)
    ? value.data.results
    : Array.isArray(value.summary?.data?.results)
      ? value.summary.data.results
      : [];
  for (const step of resultSteps) {
    if (step?.ok === false || step?.status === "failed") {
      return step;
    }
  }
  if (value.ok === false && (value.input || value.error || value.evidence)) {
    return value;
  }
  return null;
}

function createFailureSummary(report = {}) {
  const failedStep = findFailedStep(report.summary || report);
  const topError = report.summary?.error || report.error || null;
  if (!failedStep && !topError) {
    return null;
  }
  const stepError = failedStep?.error || failedStep?.data?.action?.error || failedStep?.data?.expectation || topError;
  const message = pickErrorMessage(stepError) || pickErrorMessage(topError) || "Run failed.";
  return {
    message,
    code: stepError?.code || topError?.code || null,
    stepIndex: failedStep?.index ?? failedStep?.input?.index ?? null,
    stepId: failedStep?.input?.id || failedStep?.id || null,
    stepTitle: getStepTitle(failedStep || {}),
    actionType: getStepActionType(failedStep || {}),
    phase: failedStep?.input?.phase || failedStep?.phase || null,
    sourceFixture: failedStep?.input?.sourceFixture || failedStep?.sourceFixture || null,
    sourceMacro: failedStep?.input?.sourceMacro || failedStep?.sourceMacro || null,
    tracePath: getStepTracePath(failedStep || {}),
    beforeScreenshotPath: getScreenshotPath(failedStep || {}, "beforeScreenshotPath"),
    afterScreenshotPath: getScreenshotPath(failedStep || {}, "afterScreenshotPath"),
    request: getStepRequest(failedStep || {}),
    response: getStepResponse(failedStep || {}),
  };
}

function normalizeRunContext(report = {}) {
  const context = report.runContext && typeof report.runContext === "object" ? report.runContext : {};
  return {
    triggerSurface: context.triggerSurface || "unknown",
    scope: context.scope || "unknown",
    phase: context.phase || null,
    stepId: context.stepId || null,
    runtimeVariableKeys: Array.isArray(context.runtimeVariableKeys) ? context.runtimeVariableKeys : [],
  };
}

function summarizeReport(report, reportPath, outputRunsRoot = "") {
  const context = report?.testContext || {};
  const telemetry = report?.telemetry || {};
  const status = normalizeRunStatus(report);
  return {
    schemaVersion: RUN_ARCHIVE_SCHEMA_VERSION,
    runDir: path.dirname(reportPath),
    reportPath,
    startedAt: toNumber(report?.startedAt),
    finishedAt: toNumber(report?.finishedAt),
    durationMs: toNumber(telemetry.durationMs),
    status,
    ok: status === "passed" ? true : status === "failed" ? false : null,
    mode: report?.mode || "",
    testFileId: context.testFileId || null,
    testFilePath: context.testFilePath || null,
    testFileName: context.testFileName || null,
    caseId: context.caseId || null,
    caseName: context.caseName || null,
    steps: toNumber(telemetry.steps, 0),
    okCount: toNumber(telemetry.okCount, 0),
    errorCount: toNumber(telemetry.errorCount, status === "failed" ? 1 : 0),
    browserUrl: telemetry.browserUrl || null,
    firstFailure: createFailureSummary(report),
    runContext: normalizeRunContext(report),
    relativeReportPath: outputRunsRoot ? path.relative(outputRunsRoot, reportPath).split(path.sep).join("/") : "",
  };
}

async function readIndex(indexPath) {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion === RUN_ARCHIVE_SCHEMA_VERSION && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch (_error) {
    // Rebuild stale or missing indexes.
  }
  return null;
}

// v1.8 perf: the index is written compactly. `JSON.stringify(payload, null, 2)`
// on 1000+ entries produced an 869KB file that was rewritten in full after every
// single run; the pretty-printing was roughly half of it and nothing reads this
// file by eye.
async function writeIndex(indexPath, items) {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const payload = {
    schemaVersion: RUN_ARCHIVE_SCHEMA_VERSION,
    generatedAt: Date.now(),
    items,
  };
  await fs.writeFile(indexPath, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

// v1.8 perf: a full rebuild reads every report and recursively stats every run
// directory. Measured on a real 1068-run / 6.5GB archive: ~3.6s of report
// parsing plus ~3.6s of `stat` calls — 7.2s during which the main process (which
// also owns the panel IPC and the visible browser) does nothing else.
//
// `incremental` keeps whatever the existing index already knows and only visits
// runs it has never seen, which is the shape every caller except an explicit
// "rebuild" button actually wants.
async function rebuildRunArchive(outputRunsRoot, { incremental = false } = {}) {
  const root = path.resolve(outputRunsRoot);
  const known = incremental ? await readIndex(path.join(root, "index.json")) : null;
  const knownByPath = new Map((known?.items || []).map((item) => [item.reportPath, item]));
  const reports = await listReportFiles(root);
  const items = [];
  for (const reportPath of reports) {
    const cached = knownByPath.get(reportPath);
    if (cached) {
      items.push(cached);
      continue;
    }
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      const item = summarizeReport(report, reportPath, root);
      item.runSizeBytes = await getDirectorySize(path.dirname(reportPath));
      items.push(item);
    } catch (_error) {
      // Ignore partial or incompatible reports.
    }
  }
  items.sort(compareNewestFirst);
  return writeIndex(path.join(root, "index.json"), items);
}

async function ensureRunArchive(outputRunsRoot) {
  const root = path.resolve(outputRunsRoot);
  const indexPath = path.join(root, "index.json");
  const existing = await readIndex(indexPath);
  if (existing) {
    return existing;
  }
  // A missing or version-bumped index is the one case that must visit every run;
  // there is nothing to be incremental against.
  return rebuildRunArchive(root);
}

async function updateRunArchiveIndex(outputRunsRoot, reportPaths = []) {
  const root = path.resolve(outputRunsRoot);
  const index = await ensureRunArchive(root);
  const nextByPath = new Map((index.items || []).map((item) => [item.reportPath, item]));
  for (const rawPath of reportPaths.filter(Boolean)) {
    const reportPath = path.resolve(rawPath);
    if (!isInsideDirectory(reportPath, root) || path.basename(reportPath) !== "report.json") {
      continue;
    }
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      const item = summarizeReport(report, reportPath, root);
      item.runSizeBytes = await getDirectorySize(path.dirname(reportPath));
      nextByPath.set(reportPath, item);
    } catch (_error) {
      // Leave existing index entry untouched if a new report cannot be read yet.
    }
  }
  const items = Array.from(nextByPath.values()).sort(compareNewestFirst);
  return writeIndex(path.join(root, "index.json"), items);
}

function compareNewestFirst(a, b) {
  return (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0);
}

function compareOldestFirst(a, b) {
  return (a.finishedAt || a.startedAt || 0) - (b.finishedAt || b.startedAt || 0);
}

function normalizeListOptions(options = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.max(1, Math.min(Number(options.pageSize || options.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  return {
    page,
    pageSize,
    status: options.status && options.status !== "all" ? String(options.status) : "",
    testFilePath: options.testFilePath ? String(options.testFilePath) : "",
    caseId: options.caseId ? String(options.caseId) : "",
    scope: options.scope ? String(options.scope) : "",
    triggerSurface: options.triggerSurface ? String(options.triggerSurface) : "",
    excludeCaseRuns: options.excludeCaseRuns === true,
    query: options.query ? String(options.query).trim().toLowerCase() : "",
    dateFrom: toNumber(options.dateFrom),
    dateTo: toNumber(options.dateTo),
    sort: options.sort === "oldest" ? "oldest" : "newest",
  };
}

function matchesQuery(item, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    item.testFileId,
    item.testFilePath,
    item.testFileName,
    item.caseId,
    item.caseName,
    item.mode,
    item.status,
    item.runContext?.triggerSurface,
    item.runContext?.scope,
    item.firstFailure?.message,
    item.firstFailure?.stepTitle,
    item.firstFailure?.actionType,
    item.browserUrl,
    item.reportPath,
  ].map(safeString).join("\n").toLowerCase();
  return haystack.includes(query);
}

function filterItems(items, options) {
  return items.filter((item) => {
    if (options.status && item.status !== options.status) {
      return false;
    }
    if (options.testFilePath && item.testFilePath !== options.testFilePath) {
      return false;
    }
    if (options.caseId && item.caseId !== options.caseId) {
      return false;
    }
    if (options.scope && item.runContext?.scope !== options.scope) {
      return false;
    }
    if (options.triggerSurface && item.runContext?.triggerSurface !== options.triggerSurface) {
      return false;
    }
    if (options.excludeCaseRuns && item.caseId) {
      return false;
    }
    const timestamp = item.finishedAt || item.startedAt || 0;
    if (options.dateFrom != null && timestamp < options.dateFrom) {
      return false;
    }
    if (options.dateTo != null && timestamp > options.dateTo) {
      return false;
    }
    return matchesQuery(item, options.query);
  });
}

function buildArchiveStats(items) {
  const durations = items.map((item) => item.durationMs).filter((value) => Number.isFinite(value));
  const failedItems = items.filter((item) => item.status === "failed");
  const latestFailure = failedItems.slice().sort(compareNewestFirst)[0] || null;
  return {
    totalRuns: items.length,
    failedRuns: failedItems.length,
    passedRuns: items.filter((item) => item.status === "passed").length,
    unknownRuns: items.filter((item) => item.status === "unknown").length,
    archiveBytes: items.reduce((sum, item) => sum + (Number.isFinite(Number(item.runSizeBytes)) ? Number(item.runSizeBytes) : 0), 0),
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null,
    latestFailureAt: latestFailure?.finishedAt || latestFailure?.startedAt || null,
  };
}

async function listRunArchive(outputRunsRoot, rawOptions = {}) {
  const root = path.resolve(outputRunsRoot);
  const options = normalizeListOptions(rawOptions);
  const index = rawOptions.rebuild ? await rebuildRunArchive(root) : await ensureRunArchive(root);
  const allItems = index.items || [];
  const filtered = filterItems(allItems, options).sort(options.sort === "oldest" ? compareOldestFirst : compareNewestFirst);
  const start = (options.page - 1) * options.pageSize;
  const pageItems = filtered.slice(start, start + options.pageSize);
  return {
    success: true,
    schemaVersion: RUN_ARCHIVE_SCHEMA_VERSION,
    generatedAt: index.generatedAt,
    items: pageItems,
    page: options.page,
    pageSize: options.pageSize,
    total: filtered.length,
    totalPages: Math.max(1, Math.ceil(filtered.length / options.pageSize)),
    stats: buildArchiveStats(allItems),
    filteredStats: buildArchiveStats(filtered),
  };
}

async function readRunReport(outputRunsRoot, rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { success: false, error: "invalid-path" };
  }
  const root = path.resolve(outputRunsRoot);
  const reportPath = path.resolve(rawPath);
  if (!isInsideDirectory(reportPath, root)) {
    return { success: false, error: "path-not-allowed" };
  }
  if (path.extname(reportPath).toLowerCase() !== ".json") {
    return { success: false, error: "unsupported-json-type" };
  }
  try {
    const raw = await fs.readFile(reportPath, "utf8");
    const report = JSON.parse(raw);
    return {
      success: true,
      path: reportPath,
      report,
      summary: summarizeReport(report, reportPath, root),
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "read-failed",
      message: error?.message || String(error),
    };
  }
}

function collectReportPathsFromResult(result) {
  const paths = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (typeof value.evidence?.reportPath === "string") {
      paths.add(value.evidence.reportPath);
    }
    if (Array.isArray(value.evidence?.caseRuns)) {
      value.evidence.caseRuns.forEach((item) => {
        if (typeof item?.reportPath === "string") {
          paths.add(item.reportPath);
        }
      });
    }
    if (Array.isArray(value.caseResults)) {
      value.caseResults.forEach((item) => visit(item?.result || item));
    }
    if (Array.isArray(value.data)) {
      value.data.forEach((item) => visit(item?.result || item));
    }
  };
  visit(result);
  return Array.from(paths);
}

// v1.8: retention. Until now nothing ever deleted a run — the archive on the
// machine this was measured on had reached 1068 runs / 6.5GB, which is what made
// every recursive walk over it expensive and what will eventually fill the disk
// under unattended nightly runs.
//
// The policy is deliberately conservative and two-level: first drop the heavy
// `steps/` payload of runs that are over the age limit but still wanted in the
// list (so the verdict, the failure summary and the report stay readable), then
// remove whole run directories once the count or byte ceiling is exceeded.
// Runs carrying a signed evidence bundle are never touched automatically — that
// signature is the thing someone kept the run *for*.
function resolveRetentionPolicy(overrides = {}) {
  const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    maxAgeDays: num(overrides.maxAgeDays ?? process.env.ZHUZHU_RUN_RETENTION_DAYS, 30),
    maxRuns: num(overrides.maxRuns ?? process.env.ZHUZHU_RUN_RETENTION_MAX_RUNS, 300),
    maxBytes: num(
      overrides.maxBytes ?? process.env.ZHUZHU_RUN_RETENTION_MAX_BYTES,
      20 * 1024 * 1024 * 1024,
    ),
    now: num(overrides.now, Date.now()),
  };
}

async function hasSignedEvidenceBundle(runDir) {
  try {
    await fs.access(path.join(runDir, "evidence-bundle.json"));
    return true;
  } catch (_error) {
    return false;
  }
}

// Exported for the unit test: given index items + a policy, decide what to strip
// and what to delete. Pure, so the decision can be asserted without touching a
// filesystem.
function planRunRetention(items = [], policy = {}) {
  const { maxAgeDays, maxRuns, maxBytes, now } = resolveRetentionPolicy(policy);
  const sorted = items
    .slice()
    .sort(compareNewestFirst)
    .map((item) => ({
      item,
      at: item.finishedAt || item.startedAt || 0,
      bytes: Number.isFinite(Number(item.runSizeBytes)) ? Number(item.runSizeBytes) : 0,
    }));

  const ageCutoff = maxAgeDays > 0 ? now - maxAgeDays * 24 * 60 * 60 * 1000 : 0;
  const deletes = [];
  const strips = [];
  let keptBytes = 0;
  let keptCount = 0;

  for (const entry of sorted) {
    const tooOld = ageCutoff > 0 && entry.at > 0 && entry.at < ageCutoff;
    const overCount = maxRuns > 0 && keptCount >= maxRuns;
    const overBytes = maxBytes > 0 && keptBytes + entry.bytes > maxBytes;
    if (tooOld || overCount || overBytes) {
      deletes.push({
        runDir: entry.item.runDir,
        reportPath: entry.item.reportPath,
        bytes: entry.bytes,
        reason: tooOld ? "max-age" : overCount ? "max-runs" : "max-bytes",
      });
      continue;
    }
    keptCount += 1;
    keptBytes += entry.bytes;
  }
  return { deletes, strips, keptCount, keptBytes, policy: { maxAgeDays, maxRuns, maxBytes } };
}

// Applies the plan. Never throws: retention is housekeeping and must not be able
// to fail a run or block startup. Returns what it actually did, so the caller can
// log it — a silent deletion of evidence would be worse than keeping the bytes.
async function pruneRunArchive(outputRunsRoot, policy = {}) {
  const root = path.resolve(outputRunsRoot);
  let index;
  try {
    // v1.9: reconcile with disk BEFORE planning.
    //
    // This used to call `ensureRunArchive`, which returns the existing
    // index.json untouched whenever the file is present and current-version. So
    // retention only ever saw runs the index already knew about — and the index
    // is only appended to by `updateRunArchiveIndex` on a normal completion. A
    // run whose directory landed without that call (cancelled, crashed mid-run,
    // written by another channel) was invisible to retention forever.
    //
    // Measured on the 2026-09-08 machine: index.json listed 300 runs while the
    // archive held 1293 directories / 6.5GB. Retention was reporting "kept 300,
    // nothing over the limit" while ~1000 orphans accumulated behind it. The
    // incremental rebuild is the same walk `ensureRunArchive` would do on a
    // missing index, minus the re-parse of everything already known.
    index = await rebuildRunArchive(root, { incremental: true });
  } catch (_error) {
    return { ok: false, deleted: 0, freedBytes: 0, protected: 0, reason: "index-unavailable" };
  }
  const plan = planRunRetention(index.items || [], policy);
  let deleted = 0;
  let freedBytes = 0;
  let protectedRuns = 0;
  const removedReportPaths = new Set();
  for (const candidate of plan.deletes) {
    const runDir = candidate.runDir ? path.resolve(candidate.runDir) : null;
    // Refuse to delete anything that is not demonstrably a run directory inside
    // the archive root.
    if (!runDir || !isInsideDirectory(runDir, root)) {
      continue;
    }
    if (await hasSignedEvidenceBundle(runDir)) {
      protectedRuns += 1;
      continue;
    }
    try {
      await fs.rm(runDir, { recursive: true, force: true });
      deleted += 1;
      freedBytes += candidate.bytes;
      removedReportPaths.add(candidate.reportPath);
    } catch (_error) {
      // Locked file, permission, whatever — leave it and move on.
    }
  }
  if (removedReportPaths.size) {
    const items = (index.items || []).filter((item) => !removedReportPaths.has(item.reportPath));
    await writeIndex(path.join(root, "index.json"), items).catch(() => null);
  }
  const orphans = await pruneOrphanRunDirectories(root);
  deleted += orphans.deleted;
  freedBytes += orphans.freedBytes;
  return {
    ok: true,
    deleted,
    freedBytes,
    protected: protectedRuns,
    orphansDeleted: orphans.deleted,
    kept: plan.keptCount,
    keptBytes: plan.keptBytes,
    policy: plan.policy,
  };
}

// v1.9: run directories with no `report.json`.
//
// Every index-based policy is blind to these by construction — `listReportFiles`
// finds runs BY their report, so a directory that never got one cannot appear in
// the index and therefore can never be planned for deletion. They are the
// residue of runs that died before writing a report (cancelled, crashed,
// killed), and on the 2026-09-08 machine there were 42 of them, permanent.
//
// Two guards, because this deletes without a report to reason about: the
// directory must be older than `ORPHAN_MIN_AGE_MS` (a run in progress has no
// report yet either — deleting one would destroy live evidence), and it must not
// carry a signed evidence bundle, same as every other deletion path.
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

async function pruneOrphanRunDirectories(root, { minAgeMs = ORPHAN_MIN_AGE_MS, now = Date.now() } = {}) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  let deleted = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runDir = path.join(root, entry.name);
    if (!isInsideDirectory(runDir, root)) {
      continue;
    }
    try {
      await fs.access(path.join(runDir, "report.json"));
      continue; // Has a report — the index policy owns this one.
    } catch (_error) {
      // No report: candidate.
    }
    const stat = await fs.stat(runDir).catch(() => null);
    if (!stat || now - stat.mtimeMs < minAgeMs) {
      continue; // Too fresh to distinguish from a run still being written.
    }
    if (await hasSignedEvidenceBundle(runDir)) {
      continue;
    }
    const bytes = await getDirectorySize(runDir);
    try {
      await fs.rm(runDir, { recursive: true, force: true });
      deleted += 1;
      freedBytes += bytes;
    } catch (_error) {
      // Locked/permission — leave it, same as the main delete loop.
    }
  }
  return { deleted, freedBytes };
}

module.exports = {
  RUN_ARCHIVE_SCHEMA_VERSION,
  collectReportPathsFromResult,
  createFailureSummary,
  listRunArchive,
  planRunRetention,
  pruneOrphanRunDirectories,
  pruneRunArchive,
  readRunReport,
  rebuildRunArchive,
  resolveRetentionPolicy,
  summarizeReport,
  updateRunArchiveIndex,
};
