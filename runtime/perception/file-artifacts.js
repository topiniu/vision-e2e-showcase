"use strict";


const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { readXlsx } = require("./file-inspect/xlsx");
const { inspectImage } = require("./file-inspect/image");
const { inspectPdf } = require("./file-inspect/pdf");
const { openZip } = require("./file-inspect/zip");

const MIME_BY_EXTENSION = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".json": "application/json",
  ".txt": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function guessMime(fileName) {
  return MIME_BY_EXTENSION[path.extname(String(fileName || "")).toLowerCase()] || "application/octet-stream";
}

// Glob-lite: `*.xlsx`, `发布报告*.xlsx`, `报表-??.csv`. A full glob engine is
// unnecessary — download names are simple — and a regex the author writes by hand
// is available via `/pattern/` for anything else.
function matchesPattern(name, pattern) {
  const text = String(name || "");
  const raw = String(pattern || "").trim();
  if (!raw || raw === "*") {
    return true;
  }
  const regexLike = /^\/(.*)\/([gimsuy]*)$/.exec(raw);
  if (regexLike) {
    try {
      return new RegExp(regexLike[1], regexLike[2].replace(/g/g, "")).test(text);
    } catch (_error) {
      return text.includes(raw);
    }
  }
  if (!/[*?]/.test(raw)) {
    // A bare string matches by extension-or-substring, which is what an author
    // writing `match: "xlsx"` means.
    return text === raw || text.includes(raw);
  }
  const escaped = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(text);
}

function sha256(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

class DownloadCollector {
  constructor({ page = null, artifactStore = null, onEvent = null, runId = null, maxFiles = 50 } = {}) {
    this.page = page;
    this.artifactStore = artifactStore;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.runId = runId;
    this.maxFiles = Math.max(1, Number(maxFiles) || 50);
    this.downloads = [];
    this.pending = new Set();
    this.waiters = [];
    this.step = { stepId: null, stepIndex: null };
    this.listeners = [];
    this.disposed = false;
    this.attach();
  }

  attach() {
    const page = this.page;
    if (!page || typeof page.on !== "function") {
      return;
    }
    const handler = (download) => {
      // Persist eagerly. Playwright deletes the temp file when the page closes,
      // so "we will read it later" is not an option — later the file is gone.
      const promise = this.persist(download).catch(() => null);
      this.pending.add(promise);
      promise.finally(() => this.pending.delete(promise));
    };
    try {
      page.on("download", handler);
      this.listeners.push({ target: page, event: "download", handler });
    } catch (_error) {
      // A fake/limited page in tests may not support the event.
    }
  }

  setStep({ stepId = null, stepIndex = null } = {}) {
    this.step = { stepId, stepIndex };
  }

  async persist(download) {
    if (this.disposed || this.downloads.length >= this.maxFiles) {
      return null;
    }
    const stepId = this.step.stepId;
    const stepIndex = this.step.stepIndex;
    let suggested = "download";
    try {
      suggested = (typeof download.suggestedFilename === "function" ? download.suggestedFilename() : null) || "download";
    } catch (_error) {
      suggested = "download";
    }
    const safeName = String(suggested).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "download";
    const prefix = Number.isInteger(stepIndex) ? String(stepIndex + 1).padStart(2, "0") : "xx";
    const relativePath = path.join("artifacts", "downloads", `${prefix}-${safeName}`);
    let absolutePath = null;
    let failure = null;
    try {
      if (this.artifactStore) {
        absolutePath = path.join(this.artifactStore.runDir, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await download.saveAs(absolutePath);
      } else if (typeof download.path === "function") {
        absolutePath = await download.path();
      }
    } catch (error) {
      failure = error?.message || String(error);
    }
    let size = null;
    let digest = null;
    if (absolutePath) {
      try {
        const buffer = await fs.readFile(absolutePath);
        size = buffer.length;
        digest = sha256(buffer);
      } catch (error) {
        failure = failure || error?.message || String(error);
      }
    }
    let url = null;
    try {
      url = typeof download.url === "function" ? download.url() : download.url || null;
    } catch (_error) {
      url = null;
    }
    const record = {
      seq: this.downloads.length + 1,
      at: Date.now(),
      suggestedFilename: String(suggested),
      fileName: path.basename(absolutePath || safeName),
      path: absolutePath,
      relativePath: absolutePath ? relativePath : null,
      size,
      mime: guessMime(suggested),
      sha256: digest,
      url,
      stepId,
      stepIndex,
      ...(failure ? { error: failure } : {}),
    };
    this.downloads.push(record);
    this.notify(record);
    if (this.onEvent) {
      try {
        this.onEvent({ type: "download-captured", runId: this.runId, download: record });
      } catch (_error) {
        // Telemetry must never affect the run.
      }
    }
    return record;
  }

  notify(record) {
    const waiters = this.waiters.slice();
    this.waiters = [];
    for (const waiter of waiters) {
      if (waiter.predicate(record)) {
        waiter.resolve(record);
      } else {
        this.waiters.push(waiter);
      }
    }
  }

  // Already-captured match first (the common case: the export finished during
  // the click step), then wait. Without the "already captured" branch an
  // `assertFile` written as its own step after the click would always time out.
  async waitForDownload({ match = "*", timeoutMs = 30_000 } = {}) {
    const predicate = (record) => matchesPattern(record.fileName, match) || matchesPattern(record.suggestedFilename, match);
    const existing = this.downloads.filter(predicate);
    if (existing.length) {
      return existing[existing.length - 1];
    }
    // A download whose save is still in flight must be awaited before declaring
    // "nothing matched" — otherwise a fast assertion races the file write.
    if (this.pending.size) {
      await Promise.allSettled(Array.from(this.pending));
      const settled = this.downloads.filter(predicate);
      if (settled.length) {
        return settled[settled.length - 1];
      }
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return null;
    }
    return new Promise((resolve) => {
      const waiter = { predicate, resolve: null };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve(null);
      }, timeoutMs);
      waiter.resolve = (record) => {
        clearTimeout(timer);
        resolve(record);
      };
      this.waiters.push(waiter);
    });
  }

  async settle() {
    if (this.pending.size) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  getReport() {
    return {
      count: this.downloads.length,
      files: this.downloads.map((item) => ({ ...item })),
    };
  }

  dispose() {
    this.disposed = true;
    for (const { target, event, handler } of this.listeners) {
      try {
        target.off?.(event, handler);
      } catch (_error) {
        // best-effort detach
      }
    }
    this.listeners = [];
    for (const waiter of this.waiters) {
      waiter.resolve(null);
    }
    this.waiters = [];
  }
}

// ---------------------------------------------------------------------------
// assertFile
// ---------------------------------------------------------------------------

function compareText(actual, expectation) {
  const text = actual == null ? "" : String(actual);
  const checks = [];
  const fail = (reason, expected) => checks.push({ ok: false, reason, expected, actual: text });
  if (expectation.equals != null) {
    const expected = String(expectation.equals);
    // Normalize CRLF only. Whitespace and line breaks inside an exported cell are
    // content (the workshop text is deliberately multi-line), so they are NOT
    // collapsed — a comparison that silently trims would hide a real regression.
    const ok = text.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n");
    ok ? checks.push({ ok: true, reason: "equals", expected, actual: text }) : fail("equals", expected);
  }
  if (expectation.contains != null) {
    const expected = String(expectation.contains);
    text.includes(expected)
      ? checks.push({ ok: true, reason: "contains", expected, actual: text })
      : fail("contains", expected);
  }
  if (expectation.notContains != null) {
    const expected = String(expectation.notContains);
    !text.includes(expected)
      ? checks.push({ ok: true, reason: "notContains", expected, actual: text })
      : fail("notContains", expected);
  }
  if (expectation.matches != null) {
    const source = String(expectation.matches);
    let regex = null;
    try {
      const regexLike = /^\/(.*)\/([gimsuy]*)$/.exec(source);
      regex = regexLike ? new RegExp(regexLike[1], regexLike[2].replace(/g/g, "")) : new RegExp(source);
    } catch (_error) {
      regex = null;
    }
    if (!regex) {
      fail("matches:invalid-regex", source);
    } else if (regex.test(text)) {
      checks.push({ ok: true, reason: "matches", expected: source, actual: text });
    } else {
      fail("matches", source);
    }
  }
  if (expectation.notEmpty === true) {
    text.trim()
      ? checks.push({ ok: true, reason: "notEmpty", expected: "non-empty", actual: text })
      : fail("notEmpty", "non-empty");
  }
  return checks;
}

function compareNumber(actual, bounds, label) {
  const checks = [];
  const value = Number(actual);
  if (bounds.atLeast != null) {
    checks.push({
      ok: Number.isFinite(value) && value >= Number(bounds.atLeast),
      reason: `${label}.atLeast`,
      expected: Number(bounds.atLeast),
      actual: Number.isFinite(value) ? value : actual,
    });
  }
  if (bounds.atMost != null) {
    checks.push({
      ok: Number.isFinite(value) && value <= Number(bounds.atMost),
      reason: `${label}.atMost`,
      expected: Number(bounds.atMost),
      actual: Number.isFinite(value) ? value : actual,
    });
  }
  if (bounds.equals != null) {
    checks.push({
      ok: Number(value) === Number(bounds.equals),
      reason: `${label}.equals`,
      expected: Number(bounds.equals),
      actual: Number.isFinite(value) ? value : actual,
    });
  }
  return checks;
}

function toBounds(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return { equals: value };
  }
  return typeof value === "object" ? value : null;
}

async function inspectXlsxExpectation(buffer, expectation) {
  const workbook = readXlsx(buffer);
  const details = { sheetNames: workbook.sheetNames };
  const checks = [];
  if (expectation.sheet != null && !workbook.resolveSheet(expectation.sheet)) {
    checks.push({
      ok: false,
      reason: "sheet",
      expected: expectation.sheet,
      actual: workbook.sheetNames,
      detail: "sheet not found in the workbook",
    });
    return { checks, details };
  }
  if (expectation.cell) {
    const cell = workbook.readCell(expectation.sheet ?? null, expectation.cell);
    details.cell = cell;
    if (!cell.ok) {
      checks.push({ ok: false, reason: "cell", expected: expectation.cell, actual: null, detail: cell.error });
    } else if (expectation.text) {
      checks.push(...compareText(cell.value, expectation.text));
    } else if (expectation.value != null) {
      checks.push(...compareText(cell.value, { equals: expectation.value }));
    } else {
      checks.push({ ok: cell.present, reason: "cell.present", expected: "present", actual: cell.present });
    }
  }
  if (expectation.range) {
    const range = workbook.readRange(expectation.sheet ?? null, expectation.range);
    details.range = range;
    if (!range.ok) {
      checks.push({ ok: false, reason: "range", expected: expectation.range, actual: null, detail: range.error });
    } else {
      const flat = range.rows.flat().filter((value) => value != null && String(value).trim() !== "");
      if (expectation.text) {
        checks.push(...compareText(flat.join("\n"), expectation.text));
      }
      const rowBounds = toBounds(expectation.nonEmptyCells);
      if (rowBounds) {
        checks.push(...compareNumber(flat.length, rowBounds, "nonEmptyCells"));
      }
    }
  }
  if (!expectation.cell && !expectation.range && expectation.text) {
    // No location given: search the whole first sheet. Slower but exactly what
    // "the export must mention this text somewhere" means.
    const sheet = workbook.readSheet(expectation.sheet ?? null, { range: "A1:ZZ5000" });
    const allText = sheet ? Array.from(sheet.cells.values()).map((cell) => cell.value).filter(Boolean).join("\n") : "";
    details.searchedSheet = sheet?.name ?? null;
    checks.push(...compareText(allText, expectation.text));
  }
  return { checks, details };
}

function inspectCsvExpectation(buffer, expectation) {
  const text = buffer.toString(expectation.encoding || "utf8").replace(/^﻿/, "");
  const rows = text.split(/\r?\n/).filter((line) => line.length);
  const details = { rowCount: rows.length, headerRow: rows[0] || null };
  const checks = [];
  if (expectation.text) {
    checks.push(...compareText(text, expectation.text));
  }
  const rowBounds = toBounds(expectation.rows);
  if (rowBounds) {
    checks.push(...compareNumber(rows.length, rowBounds, "rows"));
  }
  if (expectation.column && expectation.row != null) {
    // 1-based row/column, as a spreadsheet user counts.
    const cells = String(rows[Number(expectation.row) - 1] || "").split(expectation.delimiter || ",");
    const index = typeof expectation.column === "number"
      ? Number(expectation.column) - 1
      : String(rows[0] || "").split(expectation.delimiter || ",").indexOf(String(expectation.column));
    const value = index >= 0 ? cells[index] : null;
    details.cell = { row: expectation.row, column: expectation.column, value };
    checks.push(...compareText(value, expectation.text || { equals: expectation.value }));
  }
  return { checks, details };
}

function inspectPdfExpectation(buffer, expectation) {
  const info = inspectPdf(buffer);
  const details = { pages: info.pages, version: info.version, encrypted: info.encrypted };
  const checks = [];
  if (!info.ok) {
    checks.push({ ok: false, reason: "pdf", expected: "a readable PDF", actual: info.error });
    return { checks, details };
  }
  const pageBounds = toBounds(expectation.pages);
  if (pageBounds) {
    checks.push(...compareNumber(info.pages, pageBounds, "pages"));
  }
  if (expectation.text) {
    if (info.textLayerUnavailable) {
      // Fail closed: an unreadable text layer must not be reported as "text not
      // found" (which an author might accept as a legitimate red) nor as a pass.
      checks.push({
        ok: false,
        reason: "text:unverifiable",
        expected: expectation.text,
        actual: null,
        detail: info.textLayerUnavailable,
      });
    } else {
      details.textLength = info.text.length;
      checks.push(...compareText(info.text, expectation.text));
    }
  }
  return { checks, details };
}

function inspectImageExpectation(buffer, expectation) {
  const info = inspectImage(buffer, {
    edgeRows: Number(expectation.edgeRows) > 0 ? Number(expectation.edgeRows) : 8,
    edgeCols: Number(expectation.edgeCols) > 0 ? Number(expectation.edgeCols) : 8,
    tolerance: Number(expectation.tolerance) > 0 ? Number(expectation.tolerance) : 12,
  });
  const details = { ...info };
  const checks = [];
  if (!info.ok) {
    checks.push({ ok: false, reason: "image", expected: "a decodable image", actual: info.error });
    return { checks, details };
  }
  const widthBounds = toBounds(expectation.width);
  if (widthBounds) {
    checks.push(...compareNumber(info.width, widthBounds, "width"));
  }
  const heightBounds = toBounds(expectation.height);
  if (heightBounds) {
    checks.push(...compareNumber(info.height, heightBounds, "height"));
  }
  if (expectation.expectedMinHeightPx != null) {
    checks.push(...compareNumber(info.height, { atLeast: expectation.expectedMinHeightPx }, "height"));
  }
  if (expectation.expectedMinWidthPx != null) {
    checks.push(...compareNumber(info.width, { atLeast: expectation.expectedMinWidthPx }, "width"));
  }
  const pixelChecks = [
    ["inkRatio", expectation.inkRatio],
    ["bottomEdgeInkRatio", expectation.bottomEdgeInkRatio],
    ["topEdgeInkRatio", expectation.topEdgeInkRatio],
    ["rightEdgeInkRatio", expectation.rightEdgeInkRatio],
    ["bottomMarginPx", expectation.bottomMarginPx],
    ["rightMarginPx", expectation.rightMarginPx],
  ].filter(([, value]) => value != null);
  if (pixelChecks.length && info.pixelsUnavailable) {
    checks.push({
      ok: false,
      reason: "pixels:unverifiable",
      expected: "pixel-level analysis",
      actual: null,
      detail: info.pixelsUnavailable,
    });
  } else {
    for (const [metric, bounds] of pixelChecks) {
      checks.push(...compareNumber(info[metric], toBounds(bounds), metric));
    }
  }
  return { checks, details };
}

function inspectZipExpectation(buffer, expectation) {
  let zip;
  try {
    zip = openZip(buffer);
  } catch (error) {
    return { checks: [{ ok: false, reason: "zip", expected: "a readable zip", actual: error?.message || String(error) }], details: {} };
  }
  const names = zip.names;
  const details = { entryCount: names.length, names: names.slice(0, 60) };
  const checks = [];
  for (const wanted of Array.isArray(expectation.contains) ? expectation.contains : expectation.contains ? [expectation.contains] : []) {
    checks.push({
      ok: names.some((name) => matchesPattern(name, wanted)),
      reason: "contains",
      expected: wanted,
      actual: names.slice(0, 20),
    });
  }
  const entryBounds = toBounds(expectation.entries);
  if (entryBounds) {
    checks.push(...compareNumber(names.length, entryBounds, "entries"));
  }
  return { checks, details };
}

function inspectRawExpectation(buffer, expectation, record) {
  const details = { size: buffer.length, sha256: sha256(buffer), mime: record?.mime || null };
  const checks = [];
  const sizeBounds = toBounds(expectation.size);
  if (sizeBounds) {
    checks.push(...compareNumber(buffer.length, sizeBounds, "size"));
  }
  if (expectation.sha256) {
    const expected = String(expectation.sha256).startsWith("sha256:") ? expectation.sha256 : `sha256:${expectation.sha256}`;
    checks.push({ ok: details.sha256 === expected, reason: "sha256", expected, actual: details.sha256 });
  }
  if (expectation.text) {
    checks.push(...compareText(buffer.toString(expectation.encoding || "utf8"), expectation.text));
  }
  if (!checks.length) {
    // "A file arrived and is not empty" is the minimum meaningful claim; an
    // assertFile with no expectation at all must not silently pass.
    checks.push({ ok: buffer.length > 0, reason: "notEmpty", expected: "> 0 bytes", actual: buffer.length });
  }
  return { checks, details };
}

function inferKind(fileName, declaredKind) {
  if (declaredKind) {
    return String(declaredKind).toLowerCase();
  }
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (extension === ".xlsx" || extension === ".xlsm") {
    return "xlsx";
  }
  if (extension === ".csv") {
    return "csv";
  }
  if (extension === ".pdf") {
    return "pdf";
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    return "image";
  }
  if (extension === ".zip") {
    return "zip";
  }
  return "raw";
}

// Resolve the file the assertion is about. Three sources, in the order authors
// actually need them.
async function resolveFileSource({ source = {}, downloads = null, page = null, workspaceRoot = null }) {
  const from = String(source.from || (source.url ? "url" : source.path ? "path" : "download")).toLowerCase();
  if (from === "download") {
    if (!downloads) {
      return {
        error: "download-capture-unavailable",
        detail:
          "This run has no download collector attached, so a download-based file assertion cannot be verified. " +
          "Reported as a failure rather than a pass so it cannot become a false green.",
      };
    }
    const record = await downloads.waitForDownload({
      match: source.match || "*",
      timeoutMs: Number.isFinite(Number(source.timeoutMs)) ? Number(source.timeoutMs) : 30_000,
    });
    if (!record) {
      const seen = downloads.getReport().files.map((item) => item.fileName);
      return {
        error: "download-not-found",
        detail: `no download matched "${source.match || "*"}" within the timeout` +
          (seen.length ? `; downloads captured in this run: ${seen.join(", ")}` : "; no downloads were captured at all"),
      };
    }
    if (!record.path) {
      return { error: "download-not-saved", detail: record.error || "the download could not be written to disk" };
    }
    return { record, buffer: await fs.readFile(record.path), filePath: record.path, fileName: record.fileName };
  }
  if (from === "url") {
    const url = String(source.url || "").trim();
    if (!url) {
      return { error: "invalid-source", detail: 'source.from = "url" requires source.url' };
    }
    // Use the page's request context when available so the fetch inherits the
    // browser's cookies/proxy — an authenticated export URL is the normal case.
    let buffer = null;
    if (page && typeof page.request?.get === "function") {
      const response = await page.request.get(url, { timeout: Number(source.timeoutMs) || 30_000 });
      if (response.status() >= 400) {
        return { error: "url-fetch-failed", detail: `HTTP ${response.status()} for ${url}` };
      }
      buffer = await response.body();
    } else {
      const response = await fetch(url);
      if (!response.ok) {
        return { error: "url-fetch-failed", detail: `HTTP ${response.status} for ${url}` };
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }
    return { buffer, filePath: url, fileName: path.basename(new URL(url).pathname) || "download" };
  }
  if (from === "path" || from === "workspace") {
    const relative = String(source.path || "").trim();
    if (!relative) {
      return { error: "invalid-source", detail: 'source.from = "path" requires source.path' };
    }
    const root = workspaceRoot || process.cwd();
    const resolved = path.resolve(root, relative);
    // Confine reads to the workspace: an assertion must never become a file-read
    // primitive for an arbitrary path on the machine.
    if (!resolved.startsWith(path.resolve(root) + path.sep)) {
      return { error: "path-outside-workspace", detail: `${relative} resolves outside the workspace root` };
    }
    if (!fsSync.existsSync(resolved)) {
      return { error: "file-not-found", detail: resolved };
    }
    return { buffer: await fs.readFile(resolved), filePath: resolved, fileName: path.basename(resolved) };
  }
  return { error: "invalid-source", detail: `unknown source.from "${from}"` };
}

async function evaluateFileAssertion(spec = {}, context = {}) {
  const source = spec.source || {};
  const expectation = spec.expectation || {};
  const resolved = await resolveFileSource({
    source,
    downloads: context.downloads || null,
    page: context.page || null,
    workspaceRoot: context.workspaceRoot || null,
  });
  if (resolved.error) {
    return {
      ok: false,
      type: "assertFile",
      error: resolved.error,
      detail: resolved.detail || null,
      source,
    };
  }
  const kind = inferKind(resolved.fileName, expectation.kind);
  let outcome;
  try {
    if (kind === "xlsx") {
      outcome = await inspectXlsxExpectation(resolved.buffer, expectation);
    } else if (kind === "csv") {
      outcome = inspectCsvExpectation(resolved.buffer, expectation);
    } else if (kind === "pdf") {
      outcome = inspectPdfExpectation(resolved.buffer, expectation);
    } else if (kind === "image") {
      outcome = inspectImageExpectation(resolved.buffer, expectation);
    } else if (kind === "zip") {
      outcome = inspectZipExpectation(resolved.buffer, expectation);
    } else {
      outcome = inspectRawExpectation(resolved.buffer, expectation, resolved.record);
    }
  } catch (error) {
    return {
      ok: false,
      type: "assertFile",
      error: `file-inspect-failed:${error?.code || "error"}`,
      detail: error?.message || String(error),
      kind,
      file: { path: resolved.filePath, name: resolved.fileName, size: resolved.buffer.length },
    };
  }
  const failures = outcome.checks.filter((check) => !check.ok);
  return {
    ok: failures.length === 0 && outcome.checks.length > 0,
    type: "assertFile",
    kind,
    // Facet C-4: the path AND the extracted actual value travel with the result,
    // so a failure is actionable without reopening the file by hand.
    file: {
      path: resolved.filePath,
      name: resolved.fileName,
      size: resolved.buffer.length,
      sha256: sha256(resolved.buffer),
      mime: resolved.record?.mime || guessMime(resolved.fileName),
      ...(resolved.record ? { downloadedAt: resolved.record.at, url: resolved.record.url } : {}),
    },
    checks: outcome.checks,
    details: outcome.details,
    ...(outcome.checks.length === 0
      ? { error: "no-expectation", detail: "assertFile declared no expectation, so it proves nothing (fail-closed)" }
      : {}),
    ...(failures.length
      ? {
          error: `assertFile:${failures[0].reason}`,
          expected: failures[0].expected,
          actual: failures[0].actual,
          failures,
        }
      : {}),
  };
}

module.exports = {
  DownloadCollector,
  evaluateFileAssertion,
  guessMime,
  inferKind,
  matchesPattern,
  resolveFileSource,
  sha256,
};
