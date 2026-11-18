"use strict";


const zlib = require("node:zlib");

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
  // The EOCD is at the end, but a trailing comment may push it back up to 64 KB.
  const minOffset = Math.max(0, buffer.length - 0x10000 - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

function readCentralDirectoryLocation(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw Object.assign(new Error("not-a-zip: end-of-central-directory signature not found"), {
      code: "not-a-zip",
    });
  }
  let entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralSize = buffer.readUInt32LE(eocdOffset + 12);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  // ZIP64: the 32-bit fields are saturated and the real values live in the ZIP64
  // EOCD record, located via a locator that sits immediately before the EOCD.
  if (centralOffset === 0xffffffff || entryCount === 0xffff || centralSize === 0xffffffff) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset >= 0 && buffer.readUInt32LE(locatorOffset) === EOCD64_LOCATOR_SIGNATURE) {
      const eocd64Offset = Number(buffer.readBigUInt64LE(locatorOffset + 8));
      if (buffer.readUInt32LE(eocd64Offset) === EOCD64_SIGNATURE) {
        entryCount = Number(buffer.readBigUInt64LE(eocd64Offset + 32));
        centralSize = Number(buffer.readBigUInt64LE(eocd64Offset + 40));
        centralOffset = Number(buffer.readBigUInt64LE(eocd64Offset + 48));
      }
    }
  }
  return { entryCount, centralSize, centralOffset };
}

function listEntries(buffer) {
  const { centralOffset } = readCentralDirectoryLocation(buffer);
  const entries = [];
  let offset = centralOffset;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === CENTRAL_SIGNATURE) {
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const extraStart = offset + 46 + nameLength;

    // ZIP64 extended information extra field (0x0001) overrides the saturated
    // 32-bit sizes/offset, in a fixed order, only for the fields that saturated.
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let cursor = extraStart;
      const extraEnd = extraStart + extraLength;
      while (cursor + 4 <= extraEnd) {
        const headerId = buffer.readUInt16LE(cursor);
        const dataSize = buffer.readUInt16LE(cursor + 2);
        let dataCursor = cursor + 4;
        if (headerId === 0x0001) {
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buffer.readBigUInt64LE(dataCursor));
            dataCursor += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buffer.readBigUInt64LE(dataCursor));
            dataCursor += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buffer.readBigUInt64LE(dataCursor));
          }
          break;
        }
        cursor += 4 + dataSize;
      }
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
    });
    offset = extraStart + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  // The local header repeats the name/extra lengths; the data begins after them.
  // (We trust the central directory for sizes — some writers leave the local
  // header's sizes zeroed and put them in a data descriptor.)
  const localOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw Object.assign(new Error(`corrupt-zip: bad local header for ${entry.name}`), { code: "corrupt-zip" });
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) {
    return Buffer.from(raw);
  }
  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(raw);
  }
  throw Object.assign(
    new Error(`unsupported-zip-compression: method ${entry.compressionMethod} for ${entry.name}`),
    { code: "unsupported-zip-compression" },
  );
}

function openZip(buffer) {
  const entries = listEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    entries,
    names: entries.map((entry) => entry.name),
    has: (name) => byName.has(name),
    read: (name) => {
      const entry = byName.get(name);
      if (!entry) {
        return null;
      }
      return readEntry(buffer, entry);
    },
    readText: (name) => {
      const data = byName.has(name) ? readEntry(buffer, byName.get(name)) : null;
      return data ? data.toString("utf8") : null;
    },
  };
}

module.exports = {
  listEntries,
  openZip,
  readEntry,
};
