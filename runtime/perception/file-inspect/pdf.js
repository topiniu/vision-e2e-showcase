"use strict";


const zlib = require("node:zlib");

function countPages(buffer) {
  const text = buffer.toString("latin1");
  // `/Type /Page` (not /Pages). Both spellings and spacing variants occur.
  const pageMatches = text.match(/\/Type\s*\/Page[^s]/g) || [];
  if (pageMatches.length) {
    return pageMatches.length;
  }
  // Fall back to the /Count on the page tree root.
  const count = /\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/.exec(text);
  return count ? Number(count[1]) : null;
}

// Pull every stream body, inflating the FlateDecode ones.
function extractStreams(buffer) {
  const streams = [];
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(marker, cursor);
    if (start < 0) {
      break;
    }
    const end = buffer.indexOf(endMarker, start);
    if (end < 0) {
      break;
    }
    // The dictionary immediately precedes `stream`; look back a bounded window
    // for the filter declaration.
    const dictionaryStart = Math.max(0, start - 512);
    const dictionary = buffer.toString("latin1", dictionaryStart, start);
    let bodyStart = start + marker.length;
    // Skip the EOL after the `stream` keyword (CRLF or LF, per the spec).
    if (buffer[bodyStart] === 0x0d) {
      bodyStart += 1;
    }
    if (buffer[bodyStart] === 0x0a) {
      bodyStart += 1;
    }
    const body = buffer.subarray(bodyStart, end);
    if (/\/FlateDecode/.test(dictionary)) {
      try {
        streams.push(zlib.inflateSync(body));
      } catch (_error) {
        try {
          streams.push(zlib.inflateRawSync(body));
        } catch (_rawError) {
          // An undecodable stream is skipped; `textLayerUnavailable` below will
          // report that extraction was incomplete if nothing else yields text.
        }
      }
    } else if (!/\/(DCTDecode|JPXDecode|CCITTFaxDecode|RunLengthDecode|ASCII85Decode|LZWDecode)/.test(dictionary)) {
      streams.push(Buffer.from(body));
    }
    cursor = end + endMarker.length;
  }
  return streams;
}

function decodePdfLiteral(literal) {
  // PDF string escapes: \n \r \t \b \f \( \) \\ \ddd
  let out = "";
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = literal[index + 1];
    if (next == null) {
      break;
    }
    if (/[0-7]/.test(next)) {
      const octal = literal.slice(index + 1).match(/^[0-7]{1,3}/)[0];
      out += String.fromCharCode(parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
    out += map[next] ?? next;
    index += 1;
  }
  return out;
}

function extractTextFromContentStream(streamText) {
  const chunks = [];
  // Tj / ' / " take one literal or hex string; TJ takes an array of them.
  const regex = /\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]+>|\bTJ\b|\bTj\b|\bT\*\b|\bTd\b|\bTD\b|\bET\b/g;
  let match;
  let pendingLine = [];
  while ((match = regex.exec(streamText)) !== null) {
    const token = match[0];
    if (token.startsWith("(")) {
      pendingLine.push(decodePdfLiteral(token.slice(1, -1)));
    } else if (token.startsWith("<")) {
      const hex = token.slice(1, -1).replace(/\s+/g, "");
      // UTF-16BE is the common encoding for hex strings from real generators.
      let decoded = "";
      if (hex.length % 4 === 0) {
        for (let i = 0; i < hex.length; i += 4) {
          decoded += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
        }
      } else {
        for (let i = 0; i + 1 < hex.length; i += 2) {
          decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
      }
      pendingLine.push(decoded);
    } else if (token === "T*" || token === "Td" || token === "TD" || token === "ET") {
      if (pendingLine.length) {
        chunks.push(pendingLine.join(""));
        pendingLine = [];
      }
    }
  }
  if (pendingLine.length) {
    chunks.push(pendingLine.join(""));
  }
  return chunks.join("\n");
}

function inspectPdf(buffer) {
  const isPdf = buffer.length >= 5 && buffer.toString("latin1", 0, 5) === "%PDF-";
  if (!isPdf) {
    return { ok: false, error: "not-a-pdf" };
  }
  const version = /^%PDF-(\d+\.\d+)/.exec(buffer.toString("latin1", 0, 16))?.[1] || null;
  const encrypted = /\/Encrypt\b/.test(buffer.toString("latin1"));
  const pages = countPages(buffer);
  const streams = extractStreams(buffer);
  const text = streams
    .map((stream) => extractTextFromContentStream(stream.toString("latin1")))
    .filter((value) => value.trim())
    .join("\n");
  const result = { ok: true, version, pages, encrypted, streamCount: streams.length, text };
  if (!text.trim()) {
    result.textLayerUnavailable = encrypted
      ? "the PDF is encrypted, so its text layer cannot be read"
      : streams.length
        ? "content streams were found but no text-showing operators could be decoded (custom CID font encoding, or text rendered as outlines) — a text assertion against this file cannot be trusted and is reported as unverifiable rather than empty"
        : "no readable content streams (scanned/image-only PDF)";
  }
  return result;
}

module.exports = {
  countPages,
  extractStreams,
  extractTextFromContentStream,
  inspectPdf,
};
