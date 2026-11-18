
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { PNG } = require("pngjs");

const { run } = require("../../runtime");
const { evaluateFileAssertion, matchesPattern, inferKind } = require("../../runtime/perception/file-artifacts");
const { readXlsx } = require("../../runtime/perception/file-inspect/xlsx");
const { inspectImage } = require("../../runtime/perception/file-inspect/image");
const { inspectPdf } = require("../../runtime/perception/file-inspect/pdf");
const { openZip } = require("../../runtime/perception/file-inspect/zip");

const outputRoot = path.join(os.tmpdir(), "zhuzhu-file-artifacts");

// --- test-only ZIP writer (store + deflate), enough to build a real .xlsx ------
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function buildZip(files, { deflate = false } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, contentInput] of Object.entries(files)) {
    const content = Buffer.isBuffer(contentInput) ? contentInput : Buffer.from(contentInput, "utf8");
    const stored = deflate ? zlib.deflateRawSync(content) : content;
    const method = deflate ? 8 : 0;
    const nameBuffer = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc32(content), 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + stored.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

const WORKSHOP_TEXT = "1.发布前检查配置\n2.确认版本号";

function buildXlsx({ workshopText = WORKSHOP_TEXT, sheetName = "发布报告" } = {}) {
  const sharedStrings =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">` +
    `<si><t>发布说明</t></si>` +
    // A rich-text cell: several <t> runs, exactly how a real exporter emits
    // multi-line / styled content. "The text of the cell" is their concatenation.
    `<si>${workshopText
      .split("\n")
      .map((line, index) => `<r><t xml:space="preserve">${index ? "\n" : ""}${line}</t></r>`)
      .join("")}</si>` +
    `<si><t>文档</t></si>` +
    `</sst>`;
  const sheet =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>` +
    `<row r="98"><c r="A98" t="s"><v>0</v></c><c r="B98" t="s"><v>1</v></c><c r="C98"><v>42</v></c></row>` +
    `</sheetData></worksheet>`;
  return buildZip(
    {
      "[Content_Types].xml": `<?xml version="1.0"?><Types/>`,
      "xl/_rels/workbook.xml.rels":
        `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/workbook.xml":
        `<?xml version="1.0"?><workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/sharedStrings.xml": sharedStrings,
      "xl/worksheets/sheet1.xml": sheet,
    },
    { deflate: true },
  );
}

function buildPng({ width, height, cutOff }) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      // Table content occupies everything except a bottom margin. A "cut off"
      // export has NO bottom margin — its content runs into the last row.
      const contentBottom = cutOff ? height : height - 20;
      const isContent = y < contentBottom && x < width - (cutOff ? 0 : 20) && y % 4 !== 0;
      png.data[index] = isContent ? 20 : 255;
      png.data[index + 1] = isContent ? 20 : 255;
      png.data[index + 2] = isContent ? 20 : 255;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// --- a server that exports files, synchronously and asynchronously -----------
function createExportServer() {
  const goodXlsx = buildXlsx();
  const staleXlsx = buildXlsx({ workshopText: "旧文案：检查旧版本" });
  const goodPng = buildPng({ width: 400, height: 300, cutOff: false });
  const cutPng = buildPng({ width: 400, height: 300, cutOff: true });
  let asyncReady = false;

  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const sendFile = (buffer, fileName, mime) => {
        // HTTP headers are ASCII; a Chinese filename must go through RFC 5987
        // (`filename*=UTF-8''...`) with an ASCII fallback. This is exactly what
        // the real exporters do, so it also exercises Playwright's own
        // suggestedFilename() decoding.
        const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, "_");
        response.writeHead(200, {
          "Content-Type": mime,
          "Content-Disposition":
            `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Content-Length": buffer.length,
        });
        response.end(buffer);
      };
      if (url.pathname === "/export/techsheet.xlsx") {
        return sendFile(goodXlsx, "发布报告.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      }
      if (url.pathname === "/export/techsheet-stale.xlsx") {
        return sendFile(staleXlsx, "发布报告-stale.xlsx", "application/octet-stream");
      }
      if (url.pathname === "/export/board.png") {
        return sendFile(goodPng, "看板.png", "image/png");
      }
      if (url.pathname === "/export/board-cut.png") {
        return sendFile(cutPng, "看板-cut.png", "image/png");
      }
      if (url.pathname === "/export/async/submit") {
        asyncReady = false;
        setTimeout(() => {
          asyncReady = true;
        }, 250);
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ taskId: "t1" }));
      }
      if (url.pathname === "/export/async/status") {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ ready: asyncReady }));
      }
      if (url.pathname === "/export/async/file") {
        return sendFile(goodXlsx, "异步导出.xlsx", "application/octet-stream");
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>
        <a id="dl-xlsx" href="/export/techsheet.xlsx" download>导出发布报告</a>
        <a id="dl-stale" href="/export/techsheet-stale.xlsx" download>导出旧发布报告</a>
        <a id="dl-png" href="/export/board.png" download>导出看板</a>
        <a id="dl-png-cut" href="/export/board-cut.png" download>导出截断看板</a>
        <button id="submit-async">提交异步导出</button>
        <div id="async-state">idle</div>
        <a id="dl-async" href="/export/async/file" download style="display:none">取件</a>
        <script>
          document.querySelector("#submit-async").addEventListener("click", async () => {
            await fetch("/export/async/submit");
            document.querySelector("#async-state").textContent = "submitted";
            const poll = setInterval(async () => {
              const state = await (await fetch("/export/async/status")).json();
              if (state.ready) {
                clearInterval(poll);
                document.querySelector("#async-state").textContent = "ready";
                document.querySelector("#dl-async").style.display = "inline";
              }
            }, 80);
          });
        </script>
      </body></html>`);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

// --- pure inspectors ---------------------------------------------------------

test("the ZIP reader round-trips both stored and deflated entries", () => {
  for (const deflate of [false, true]) {
    const buffer = buildZip({ "a.txt": "hello", "dir/b.txt": "世界" }, { deflate });
    const zip = openZip(buffer);
    assert.deepEqual(zip.names, ["a.txt", "dir/b.txt"]);
    assert.equal(zip.readText("a.txt"), "hello");
    assert.equal(zip.readText("dir/b.txt"), "世界");
    assert.equal(zip.read("missing.txt"), null);
  }
});

test("the xlsx reader resolves a sheet by name and concatenates rich-text runs", () => {
  const workbook = readXlsx(buildXlsx());
  assert.deepEqual(workbook.sheetNames, ["发布报告"]);
  const cell = workbook.readCell("发布报告", "B98");
  assert.equal(cell.ok, true);
  // The multi-line workshop text survives intact — a reader that flattened the
  // newline would report a false mismatch against the real export.
  assert.equal(cell.value, WORKSHOP_TEXT);
  assert.equal(workbook.readCell("发布报告", "B1").value, "文档");
  assert.equal(workbook.readCell("发布报告", "C98").value, "42");
  // An empty cell is a real answer, not an error.
  const empty = workbook.readCell("发布报告", "Z1");
  assert.equal(empty.ok, true);
  assert.equal(empty.present, false);
  assert.equal(empty.value, null);
  // Sheet name resolution tolerates stray whitespace/case (exporters add them).
  assert.equal(workbook.resolveSheet(" 发布报告 ")?.name, "发布报告");
  assert.equal(workbook.resolveSheet("不存在"), null);
  assert.equal(workbook.resolveSheet(1)?.name, "发布报告");
});

test("the image inspector distinguishes a cut-off export from a complete one", () => {
  const good = inspectImage(buildPng({ width: 400, height: 300, cutOff: false }));
  const cut = inspectImage(buildPng({ width: 400, height: 300, cutOff: true }));
  assert.equal(good.format, "png");
  assert.equal(good.width, 400);
  assert.equal(good.height, 300);
  // A complete export ends in margin: no ink in the bottom rows, and a positive
  // bottom margin in pixels.
  assert.ok(good.bottomEdgeInkRatio < 0.01, `expected a clean bottom edge, got ${good.bottomEdgeInkRatio}`);
  assert.ok(good.bottomMarginPx >= 15);
  // A truncated export runs content into the last row.
  assert.ok(cut.bottomEdgeInkRatio > 0.5, `expected ink at the bottom edge, got ${cut.bottomEdgeInkRatio}`);
  assert.equal(cut.bottomMarginPx, 0);
  assert.ok(cut.rightEdgeInkRatio > 0.5);
});

test("the image inspector refuses to guess pixels for JPEG instead of passing vacuously", () => {
  // Minimal JPEG: SOI + SOF0 with a 120x80 frame.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x50, 0x00, 0x78, 0x03, 0x01, 0x11, 0x00, 0x02,
    0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  const info = inspectImage(jpeg);
  assert.equal(info.format, "jpeg");
  assert.equal(info.width, 120);
  assert.equal(info.height, 80);
  assert.ok(info.pixelsUnavailable);
});

test("the pdf inspector reports pages and text, and says so when the text layer is unreadable", () => {
  // A latin1 literal string, the way a WinAnsi-encoded PDF carries text.
  const content = "BT /F1 12 Tf (Export Report Title) Tj ET";
  const pdf = Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n2 0 obj<</Type /Page>>endobj\n` +
      `3 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n%%EOF`,
    "latin1",
  );
  const info = inspectPdf(pdf);
  assert.equal(info.ok, true);
  assert.equal(info.pages, 2);
  assert.match(info.text, /Export Report Title/);

  // CJK text in a real PDF arrives as a UTF-16BE hex string — that is the path
  // that actually matters for these exports, so it gets its own case.
  const hex = Buffer.from("导出报表标题", "utf16le").swap16().toString("hex");
  const hexContent = `BT /F1 12 Tf <${hex}> Tj ET`;
  const cjkPdf = Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n` +
      `2 0 obj<</Length ${hexContent.length}>>stream\n${hexContent}\nendstream endobj\n%%EOF`,
    "latin1",
  );
  assert.match(inspectPdf(cjkPdf).text, /导出报表标题/);

  const imageOnly = Buffer.from("%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n%%EOF", "latin1");
  const scanned = inspectPdf(imageOnly);
  assert.equal(scanned.pages, 1);
  assert.ok(scanned.textLayerUnavailable, "an unreadable text layer must be declared, not reported as empty text");
  assert.equal(inspectPdf(Buffer.from("not a pdf")).ok, false);
});

test("filename matching supports bare strings, globs and regexes", () => {
  assert.equal(matchesPattern("发布报告.xlsx", "*.xlsx"), true);
  assert.equal(matchesPattern("发布报告.xlsx", "*.csv"), false);
  assert.equal(matchesPattern("发布报告.xlsx", "xlsx"), true);
  assert.equal(matchesPattern("report-01.csv", "report-??.csv"), true);
  assert.equal(matchesPattern("report-01.csv", "/^report-\\d+\\.csv$/"), true);
  assert.equal(matchesPattern("anything", "*"), true);
  assert.equal(inferKind("x.xlsx"), "xlsx");
  assert.equal(inferKind("x.bin"), "raw");
  assert.equal(inferKind("x.bin", "image"), "image");
});

// --- end-to-end through a real download --------------------------------------

test("C-1: assert a specific xlsx cell of a real download (the DEMO-1310-F3 题目)", async () => {
  const { server, url } = await createExportServer();
  try {
    const result = await run(
      [
        { id: "click-export", type: "click", stepTitle: "点击导出发布报告", target: { locator: "#dl-xlsx" } },
        {
          id: "assert-workshop-text",
          type: "assertFile",
          stepTitle: "assert 导出 xlsx 发布说明=新文案",
          source: { from: "download", match: "*.xlsx" },
          expectation: {
            kind: "xlsx",
            sheet: "发布报告",
            cell: "B98",
            text: { equals: WORKSHOP_TEXT },
          },
        },
      ],
      { url, headless: true, outputDir: outputRoot, runId: "file-c1", evidenceProfile: "fast" },
    );

    assert.equal(result.ok, true, JSON.stringify(result.error || result.data?.results?.at(-1)?.error));
    const summary = JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
    // The download itself is evidence: saved, hashed, sized.
    assert.equal(summary.downloads.count, 1);
    const [file] = summary.downloads.files;
    assert.match(file.fileName, /\.xlsx$/);
    assert.ok(file.size > 0);
    assert.match(file.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(file.path), "the file must survive on disk, not vanish with the page");
    assert.ok(file.path.includes(path.join("artifacts", "downloads")));
  } finally {
    server.close();
  }
});

test("C-4: a failing xlsx assertion reports the file path AND the actual cell value", async () => {
  const { server, url } = await createExportServer();
  try {
    const result = await run(
      [
        { id: "click-export", type: "click", target: { locator: "#dl-stale" } },
        {
          id: "assert-workshop-text",
          type: "assertFile",
          stepTitle: "assert 导出 xlsx 发布说明=新文案",
          source: { from: "download", match: "*stale*" },
          expectation: { kind: "xlsx", sheet: "发布报告", cell: "B98", text: { equals: WORKSHOP_TEXT } },
        },
      ],
      { url, headless: true, outputDir: outputRoot, runId: "file-c4", evidenceProfile: "fast" },
    );

    assert.equal(result.ok, false);
    const summary = JSON.parse(fs.readFileSync(result.evidence.summaryPath, "utf8"));
    const failure = summary.firstFailure;
    assert.equal(failure.stepId, "assert-workshop-text");
    // The actual extracted value must be in the evidence — otherwise a human has
    // to open the file, and the HUMAN_INHERENT debt is not actually repaid.
    const expectation = failure.expectation;
    assert.ok(String(expectation.actual).includes("旧文案"), JSON.stringify(expectation));
    const raw = JSON.parse(fs.readFileSync(summary.artifacts.reportPath, "utf8"));
    const step = raw.summary.data.results.at(-1);
    assert.match(step.data.expectation.file.path, /stale/);
    assert.equal(step.data.expectation.details.cell.value, "旧文案：检查旧版本");
  } finally {
    server.close();
  }
});

test("C-2: a wide-table PNG export is asserted complete / cut-off (the DEMO-1296-F4 题目)", async () => {
  const { server, url } = await createExportServer();
  try {
    const complete = await run(
      [
        { id: "click-export", type: "click", target: { locator: "#dl-png" } },
        {
          id: "assert-not-truncated",
          type: "assertFile",
          stepTitle: "assert 导出 PNG 底部未被截断",
          source: { from: "download", match: "*.png" },
          expectation: {
            kind: "image",
            expectedMinHeightPx: 200,
            // The explainable truncation判据: a complete export ends in margin.
            bottomEdgeInkRatio: { atMost: 0.01 },
            bottomMarginPx: { atLeast: 8 },
            inkRatio: { atLeast: 0.05 },
          },
        },
      ],
      { url, headless: true, outputDir: outputRoot, runId: "file-c2-ok", evidenceProfile: "fast" },
    );
    assert.equal(complete.ok, true, JSON.stringify(complete.data?.results?.at(-1)?.error));

    const truncated = await run(
      [
        { id: "click-export", type: "click", target: { locator: "#dl-png-cut" } },
        {
          id: "assert-not-truncated",
          type: "assertFile",
          source: { from: "download", match: "*cut*" },
          expectation: { kind: "image", bottomEdgeInkRatio: { atMost: 0.01 } },
        },
      ],
      { url, headless: true, outputDir: outputRoot, runId: "file-c2-cut", evidenceProfile: "fast" },
    );
    assert.equal(truncated.ok, false, "a cut-off export must be red");
    const report = JSON.parse(fs.readFileSync(truncated.evidence.reportPath, "utf8"));
    const step = report.summary.data.results.at(-1);
    // The evidence must name the metric that tripped and the measured value —
    // "expectation not met" alone would send a human back to opening the file.
    assert.equal(step.data.expectation.error, "assertFile:bottomEdgeInkRatio.atMost");
    assert.equal(step.data.expectation.failures[0].reason, "bottomEdgeInkRatio.atMost");
    assert.ok(step.data.expectation.failures[0].actual > 0.5);
    assert.equal(step.data.expectation.details.bottomMarginPx, 0);
  } finally {
    server.close();
  }
});

test("C-3: an asynchronous export (submit -> poll -> fetch) is captured and asserted", async () => {
  const { server, url } = await createExportServer();
  try {
    const result = await run(
      [
        { id: "submit", type: "click", stepTitle: "提交异步导出", target: { locator: "#submit-async" } },
        {
          id: "wait-ready",
          type: "assertDom",
          stepTitle: "assert 下载中心状态=ready",
          target: { locator: "#async-state" },
          property: "text",
          operator: "equals",
          expected: "ready",
          timeoutMs: 5000,
        },
        { id: "pickup", type: "click", stepTitle: "取件", target: { locator: "#dl-async" } },
        {
          id: "assert-async-file",
          type: "assertFile",
          stepTitle: "assert 异步导出文件内容",
          source: { from: "download", match: "*.xlsx", timeoutMs: 10000 },
          expectation: { kind: "xlsx", sheet: "发布报告", cell: "B98", text: { contains: "检查配置" } },
        },
      ],
      { url, headless: true, outputDir: outputRoot, runId: "file-c3", evidenceProfile: "fast" },
    );
    assert.equal(result.ok, true, JSON.stringify(result.data?.results?.map((item) => item.error).filter(Boolean)));
  } finally {
    server.close();
  }
});

test("assertFile can read straight from a URL (no click needed)", async () => {
  const { server, url } = await createExportServer();
  try {
    const result = await evaluateFileAssertion(
      {
        source: { from: "url", url: `${url}export/board.png` },
        expectation: { kind: "image", width: 400, height: 300 },
      },
      {},
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.kind, "image");
    assert.equal(result.details.width, 400);
  } finally {
    server.close();
  }
});

// --- fail-closed behaviours --------------------------------------------------

test("assertFile fails closed when no download collector exists", async () => {
  const result = await evaluateFileAssertion(
    { source: { from: "download", match: "*.xlsx" }, expectation: { kind: "xlsx", cell: "A1" } },
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "download-capture-unavailable");
  assert.match(result.detail, /false green/);
});

test("assertFile with no expectation at all fails closed (it proves nothing)", async () => {
  const { server, url } = await createExportServer();
  try {
    const result = await evaluateFileAssertion(
      { source: { from: "url", url: `${url}export/board.png` }, expectation: {} },
      {},
    );
    // The raw path still yields the minimum meaningful claim ("a non-empty file
    // arrived") rather than a vacuous pass on a declared-but-empty expectation.
    assert.equal(result.kind, "image");
    assert.equal(result.ok, false);
    assert.match(String(result.error), /image|no-expectation/);
  } finally {
    server.close();
  }
});

test("a workspace-path source cannot escape the workspace root", async () => {
  const result = await evaluateFileAssertion(
    { source: { from: "path", path: "../../../../etc/passwd" }, expectation: { kind: "raw" } },
    { workspaceRoot: process.cwd() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "path-outside-workspace");
});

test("a missing download reports what WAS captured, so the author can fix the match", async () => {
  const { DownloadCollector } = require("../../runtime/perception/file-artifacts");
  const collector = new DownloadCollector({ page: null });
  collector.downloads.push({ fileName: "报表.csv", suggestedFilename: "报表.csv", path: "/tmp/x", at: 1, size: 1 });
  const result = await evaluateFileAssertion(
    { source: { from: "download", match: "*.xlsx", timeoutMs: 1 }, expectation: { kind: "xlsx", cell: "A1" } },
    { downloads: collector },
  );
  assert.equal(result.error, "download-not-found");
  assert.match(result.detail, /报表\.csv/);
});
