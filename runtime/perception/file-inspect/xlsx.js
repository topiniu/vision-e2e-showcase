"use strict";


const { openZip } = require("./zip");

// Minimal XML helpers. A real parser is unnecessary and risky here: the shapes we
// read are machine-generated, flat, and namespace-stable.
function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(xmlFragment) {
  return decodeXmlEntities(String(xmlFragment).replace(/<[^>]*>/g, ""));
}

// Concatenate every <t> run in an element, turning <br/> and explicit line-break
// runs into newlines so multi-line cell content survives.
function readTextRuns(xmlFragment) {
  if (!xmlFragment) {
    return "";
  }
  const normalized = String(xmlFragment).replace(/<br\s*\/?>/gi, "\n");
  const runs = [];
  const regex = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    runs.push(decodeXmlEntities(match[1]));
  }
  if (!runs.length) {
    return stripTags(normalized);
  }
  return runs.join("");
}

function parseSharedStrings(xml) {
  if (!xml) {
    return [];
  }
  const items = [];
  const regex = /<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    items.push(readTextRuns(match[1]));
  }
  return items;
}

function parseWorkbook(xml) {
  const sheets = [];
  const regex = /<(?:\w+:)?sheet\s([^>]*)\/?>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1];
    const name = /name="([^"]*)"/.exec(attrs);
    const sheetId = /sheetId="([^"]*)"/.exec(attrs);
    const rid = /r:id="([^"]*)"/.exec(attrs);
    sheets.push({
      name: name ? decodeXmlEntities(name[1]) : "",
      sheetId: sheetId ? sheetId[1] : null,
      rid: rid ? rid[1] : null,
    });
  }
  return sheets;
}

function parseRelationships(xml) {
  const map = new Map();
  if (!xml) {
    return map;
  }
  const regex = /<Relationship\s([^>]*)\/?>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1];
    const id = /Id="([^"]*)"/.exec(attrs);
    const target = /Target="([^"]*)"/.exec(attrs);
    if (id && target) {
      map.set(id[1], target[1].replace(/^\/?xl\//, "").replace(/^\.\//, ""));
    }
  }
  return map;
}

function columnToIndex(letters) {
  let index = 0;
  for (const char of String(letters).toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index; // 1-based
}

function indexToColumn(index) {
  let value = Number(index);
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function parseCellRef(ref) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(ref || "").trim());
  if (!match) {
    return null;
  }
  return { column: columnToIndex(match[1]), row: Number(match[2]), ref: match[1].toUpperCase() + match[2] };
}

function parseRange(range) {
  const [from, to] = String(range || "").split(":");
  const start = parseCellRef(from);
  const end = parseCellRef(to || from);
  if (!start || !end) {
    return null;
  }
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column),
  };
}

// Parse a worksheet into a `{ "B98": {value, type} }` map. Worksheets are big, so
// only the cells inside `wanted` (a predicate) are materialized when supplied.
function parseSheet(xml, sharedStrings, wanted = null) {
  const cells = new Map();
  let maxRow = 0;
  let maxColumn = 0;
  const cellRegex = /<(?:\w+:)?c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let match;
  while ((match = cellRegex.exec(xml)) !== null) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const refMatch = /r="([^"]*)"/.exec(attrs);
    if (!refMatch) {
      continue;
    }
    const parsed = parseCellRef(refMatch[1]);
    if (!parsed) {
      continue;
    }
    maxRow = Math.max(maxRow, parsed.row);
    maxColumn = Math.max(maxColumn, parsed.column);
    if (wanted && !wanted(parsed)) {
      continue;
    }
    const typeMatch = /t="([^"]*)"/.exec(attrs);
    const type = typeMatch ? typeMatch[1] : "n";
    let value = null;
    if (type === "s") {
      const vMatch = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
      const index = vMatch ? Number(vMatch[1]) : -1;
      value = index >= 0 && index < sharedStrings.length ? sharedStrings[index] : null;
    } else if (type === "inlineStr") {
      value = readTextRuns(body);
    } else if (type === "str") {
      const vMatch = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
      value = vMatch ? decodeXmlEntities(vMatch[1]) : null;
    } else {
      const vMatch = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
      value = vMatch ? decodeXmlEntities(vMatch[1]) : null;
    }
    cells.set(parsed.ref, { ref: parsed.ref, row: parsed.row, column: parsed.column, type, value });
  }
  return { cells, maxRow, maxColumn };
}

function readXlsx(buffer) {
  const zip = openZip(buffer);
  const workbookXml = zip.readText("xl/workbook.xml");
  if (!workbookXml) {
    throw Object.assign(new Error("not-an-xlsx: xl/workbook.xml is missing"), { code: "not-an-xlsx" });
  }
  const sharedStrings = parseSharedStrings(zip.readText("xl/sharedStrings.xml"));
  const relationships = parseRelationships(zip.readText("xl/_rels/workbook.xml.rels"));
  const sheets = parseWorkbook(workbookXml).map((sheet, index) => ({
    ...sheet,
    path:
      (sheet.rid && relationships.get(sheet.rid) && `xl/${relationships.get(sheet.rid)}`) ||
      `xl/worksheets/sheet${index + 1}.xml`,
  }));
  return {
    sheetNames: sheets.map((sheet) => sheet.name),
    sharedStringCount: sharedStrings.length,
    // Resolve by exact name, then case-insensitive/trimmed, then 1-based index.
    // Exporters do add stray spaces to sheet names, and an assertion failing
    // because of an invisible space would be a false negative that costs a human
    // an hour.
    resolveSheet(nameOrIndex) {
      if (nameOrIndex == null || nameOrIndex === "") {
        return sheets[0] || null;
      }
      if (Number.isInteger(nameOrIndex)) {
        return sheets[nameOrIndex - 1] || null;
      }
      const wanted = String(nameOrIndex);
      return (
        sheets.find((sheet) => sheet.name === wanted) ||
        sheets.find((sheet) => sheet.name.trim().toLowerCase() === wanted.trim().toLowerCase()) ||
        null
      );
    },
    readSheet(nameOrIndex, { range = null, cells: wantedCells = null } = {}) {
      const sheet = this.resolveSheet(nameOrIndex);
      if (!sheet) {
        return null;
      }
      const xml = zip.readText(sheet.path);
      if (!xml) {
        return null;
      }
      const rangeBox = range ? parseRange(range) : null;
      const wantedRefs = Array.isArray(wantedCells)
        ? new Set(wantedCells.map((ref) => parseCellRef(ref)?.ref).filter(Boolean))
        : null;
      const predicate =
        rangeBox || wantedRefs
          ? (parsed) =>
              (wantedRefs ? wantedRefs.has(parsed.ref) : false) ||
              (rangeBox
                ? parsed.row >= rangeBox.startRow &&
                  parsed.row <= rangeBox.endRow &&
                  parsed.column >= rangeBox.startColumn &&
                  parsed.column <= rangeBox.endColumn
                : false)
          : null;
      const parsedSheet = parseSheet(xml, sharedStrings, predicate);
      return { name: sheet.name, path: sheet.path, ...parsedSheet };
    },
    readCell(nameOrIndex, ref) {
      const parsedRef = parseCellRef(ref);
      if (!parsedRef) {
        return { ok: false, error: `invalid-cell-ref:${ref}` };
      }
      const sheet = this.readSheet(nameOrIndex, { cells: [parsedRef.ref] });
      if (!sheet) {
        return { ok: false, error: "sheet-not-found", sheetNames: this.sheetNames };
      }
      const cell = sheet.cells.get(parsedRef.ref);
      return {
        ok: true,
        sheetName: sheet.name,
        ref: parsedRef.ref,
        // An empty cell is a real answer ("" / null), not an error: "the export
        // left the workshop text blank" is exactly the kind of regression the
        // assertion has to be able to report.
        value: cell ? cell.value : null,
        type: cell ? cell.type : null,
        present: Boolean(cell),
      };
    },
    readRange(nameOrIndex, range) {
      const sheet = this.readSheet(nameOrIndex, { range });
      if (!sheet) {
        return { ok: false, error: "sheet-not-found", sheetNames: this.sheetNames };
      }
      const box = parseRange(range);
      const rows = [];
      for (let row = box.startRow; row <= box.endRow; row += 1) {
        const values = [];
        for (let column = box.startColumn; column <= box.endColumn; column += 1) {
          const cell = sheet.cells.get(`${indexToColumn(column)}${row}`);
          values.push(cell ? cell.value : null);
        }
        rows.push(values);
      }
      return { ok: true, sheetName: sheet.name, range, rows };
    },
  };
}

module.exports = {
  columnToIndex,
  indexToColumn,
  parseCellRef,
  parseRange,
  parseSharedStrings,
  readTextRuns,
  readXlsx,
};
