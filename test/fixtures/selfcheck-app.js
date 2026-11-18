"use strict";


const http = require("node:http");
const zlib = require("node:zlib");
const { PNG } = require("pngjs");

// --- minimal ZIP writer (store/deflate), enough for a real .xlsx -------------

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

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, contentInput] of Object.entries(files)) {
    const content = Buffer.isBuffer(contentInput) ? contentInput : Buffer.from(contentInput, "utf8");
    const stored = zlib.deflateRawSync(content);
    const nameBuffer = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(content), 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + stored.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

const WORKSHOP_TEXT_NEW = "1.发布前检查配置\n2.确认版本号";
const WORKSHOP_TEXT_OLD = "旧文案：检查旧版本";

function buildTechSheetXlsx(workshopText) {
  const sharedStrings =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<si><t>发布说明</t></si>" +
    `<si>${workshopText
      .split("\n")
      .map((line, index) => `<r><t xml:space="preserve">${index ? "\n" : ""}${line}</t></r>`)
      .join("")}</si>` +
    "</sst>";
  const sheet =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="98"><c r="A98" t="s"><v>0</v></c><c r="B98" t="s"><v>1</v></c></row>' +
    "</sheetData></worksheet>";
  return buildZip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types/>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook><sheets><sheet name="发布报告" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/sharedStrings.xml": sharedStrings,
    "xl/worksheets/sheet1.xml": sheet,
  });
}

// A wide-table export. `cutOff` removes the bottom/right margin so content runs
// into the very last pixel row — the machine-detectable signature of truncation.
function buildBoardPng({ width = 480, height = 320, cutOff = false } = {}) {
  const png = new PNG({ width, height });
  const contentBottom = cutOff ? height : height - 24;
  const contentRight = cutOff ? width : width - 24;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const isRow = y % 5 !== 0;
      const isContent = y < contentBottom && x < contentRight && isRow;
      png.data[index] = isContent ? 30 : 255;
      png.data[index + 1] = isContent ? 30 : 255;
      png.data[index + 2] = isContent ? 30 : 255;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// --- the pages ---------------------------------------------------------------

// Escape #1 (DEMO-1239): typing into 品类名称 throws. Note what is deliberately
// NOT done here: nothing on the page turns red, no error message is shown, and
// the value still lands in the input. So every DOM assertion an author would
// write still passes — which is exactly how 17/17 facets went green while the
// feature was unusable.
function categoryPage({ crash }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="build-id" content="__BUILD_ID__"></head>
<body>
  <h1>分类规则维护</h1>
  <button data-testid="demo-category-copy-btn">复制</button>
  <input data-testid="demo-category-name-input" placeholder="品类名称" />
  <button data-testid="demo-category-save-btn">保存</button>
  <div data-testid="demo-category-list">文档</div>
  <script>
    var input = document.querySelector('[data-testid="demo-category-name-input"]');
    var list = document.querySelector('[data-testid="demo-category-list"]');
    input.addEventListener("input", function (event) {
      ${crash
        ? `// The v5.19 defect: the handler reads a property off an object the
         // framework has already recycled. Uncaught TypeError, no visible symptom.
         var pooled = null;
         pooled.target.value.trim();`
        : `// fixed build: read from the live element instead of a recycled event
         void event.target.value;`}
    });
    document.querySelector('[data-testid="demo-category-save-btn"]').addEventListener("click", function () {
      if (input.value) { list.textContent = "文档 " + input.value; }
    });
    document.querySelector('[data-testid="demo-category-copy-btn"]').addEventListener("click", function () {
      input.value = "文档-副本";
    });
  </script>
</body></html>`;
}

function exportPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="build-id" content="__BUILD_ID__"></head>
<body>
  <h1>发布报告导出</h1>
  <a data-testid="demo-techsheet-export-btn" href="./export/techsheet.xlsx" download>导出发布报告</a>
  <a data-testid="demo-board-export-btn" href="./export/board.png" download>导出宽表看板</a>
  <a data-testid="demo-board-export-cut-btn" href="./export/board-cut.png" download>导出宽表看板(截断)</a>
</body></html>`;
}

// Escape #2 (DEMO-1243): the same 字段顺序 rendered by four entry points, three of
// which disagree. Single-point assertions pass in every entry individually.
const PART_ORDERS = {
  rule: ["标题", "状态", "负责人", "新增字段"],
  edit: ["新增字段", "标题", "状态", "负责人"],
  view: ["标题", "状态", "负责人", "新增字段"],
  export: ["负责人", "状态", "标题", "新增字段"],
};

function partOrderPage(entry) {
  const order = PART_ORDERS[entry] || PART_ORDERS.rule;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="build-id" content="__BUILD_ID__"></head>
<body>
  <h1>字段顺序 · ${entry}</h1>
  <ol data-testid="demo-size-rule-part-list">
    ${order.map((item) => `<li data-testid="demo-size-rule-part-item">${item}</li>`).join("")}
  </ol>
</body></html>`;
}

/**
 * Start the self-check fixture app.
 *
 * @param {object} options
 * @param {boolean} options.crash        reproduce the input-crash defect (default true)
 * @param {boolean} options.staleExport  serve the OLD workshop text (default false)
 * @param {string}  options.buildId      the build identity the page advertises
 */
async function startSelfcheckApp({ crash = true, staleExport = false, buildId = "selfcheck-build-1", port = 0 } = {}) {
  const techSheet = buildTechSheetXlsx(staleExport ? WORKSHOP_TEXT_OLD : WORKSHOP_TEXT_NEW);
  const boardPng = buildBoardPng({ cutOff: false });
  const boardCutPng = buildBoardPng({ cutOff: true });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const html = (body) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body.replace(/__BUILD_ID__/g, buildId));
    };
    const file = (buffer, fileName, mime) => {
      const ascii = fileName.replace(/[^\x20-\x7E]/g, "_");
      response.writeHead(200, {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Content-Length": buffer.length,
      });
      response.end(buffer);
    };
    switch (url.pathname) {
      case "/export/techsheet.xlsx":
        return file(techSheet, "发布报告.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      case "/export/board.png":
        return file(boardPng, "宽表看板.png", "image/png");
      case "/export/board-cut.png":
        return file(boardCutPng, "宽表看板.png", "image/png");
      case "/export":
        return html(exportPage());
      case "/parts/rule":
        return html(partOrderPage("rule"));
      case "/parts/edit":
        return html(partOrderPage("edit"));
      case "/parts/view":
        return html(partOrderPage("view"));
      case "/parts/export":
        return html(partOrderPage("export"));
      default:
        return html(categoryPage({ crash }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  return {
    server,
    baseUrl,
    buildId,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = {
  PART_ORDERS,
  WORKSHOP_TEXT_NEW,
  WORKSHOP_TEXT_OLD,
  buildBoardPng,
  buildTechSheetXlsx,
  startSelfcheckApp,
};
