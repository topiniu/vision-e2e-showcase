"use strict";


const fs = require("node:fs");
const path = require("node:path");

const ORIGIN_IN_TEXT = /https?:\/\/(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?/g;

function parseArgs(argv) {
  const args = { dir: "test-workflows", only: "", maps: [], credentials: [], write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--write") {
      args.write = true;
    } else if (flag === "--dir") {
      args.dir = value; i += 1;
    } else if (flag === "--only") {
      args.only = value; i += 1;
    } else if (flag === "--map") {
      const [origin, name] = String(value || "").split("=");
      if (!origin || !name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`--map expects <origin>=<name>, got "${value}"`);
      }
      args.maps.push({ origin: origin.replace(/\/+$/, ""), name });
      i += 1;
    } else if (flag === "--credential") {
      const [field, literal] = String(value || "").split("=");
      if (!field || literal == null || literal === "") {
        throw new Error(`--credential expects <field>=<literal>, got "${value}"`);
      }
      args.credentials.push({ field, literal });
      i += 1;
    }
  }
  return args;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace `origin` at a URL boundary: followed by `/`, `?`, `#`, a quote, or the
// end of the string. `http://localhost:8000` must not match `...:80001`.
function rewriteOrigins(text, maps) {
  let next = text;
  let count = 0;
  for (const { origin, name } of maps) {
    const pattern = new RegExp(`${escapeRegExp(origin)}(?=[/?#"'\\s]|$)`, "g");
    next = next.replace(pattern, () => {
      count += 1;
      return `{{origin.${name}}}`;
    });
  }
  return { text: next, count };
}

function inventoryOrigins(text) {
  const found = new Map();
  for (const match of text.matchAll(ORIGIN_IN_TEXT)) {
    found.set(match[0], (found.get(match[0]) || 0) + 1);
  }
  return found;
}

function rewriteRecoveryCredentials(json, credentials) {
  let count = 0;
  const visit = (node, insideRecovery) => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, insideRecovery));
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if (insideRecovery && (node.type === "fill" || node.kind === "fill")) {
      for (const key of ["value", "text"]) {
        const match = credentials.find((item) => item.literal === node[key]);
        if (match) {
          node[key] = `{{credential.${match.field}}}`;
          count += 1;
        }
      }
      const targetValue = node.target && typeof node.target === "object" ? node.target.value : undefined;
      const targetMatch = credentials.find((item) => item.literal === targetValue);
      if (targetMatch) {
        node.target.value = `{{credential.${targetMatch.field}}}`;
        count += 1;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      visit(value, insideRecovery || key === "recovery");
    }
  };
  visit(json, false);
  return count;
}

function detectFormat(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = /\n([ \t]+)"/.exec(text);
  const indent = indentMatch ? indentMatch[1] : "  ";
  return { eol, indent, trailingNewline: /\r?\n$/.test(text) };
}

function serialize(json, format) {
  const body = JSON.stringify(json, null, format.indent).split("\n").join(format.eol);
  return format.trailingNewline ? `${body}${format.eol}` : body;
}

function refreshUpdatedAt(text, now) {
  return text.replace(/("updatedAt"\s*:\s*")[^"]*(")/, `$1${now}$2`);
}

function listJsonFiles(root, only = "") {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          walk(full);
        }
      } else if (entry.name.endsWith(".json")) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (!only || relative.startsWith(only)) {
          files.push({ full, relative });
        }
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function migrateText(text, { maps = [], credentials = [], now = new Date().toISOString() } = {}) {
  const origins = rewriteOrigins(text, maps);
  let next = origins.text;
  let credentialCount = 0;
  if (credentials.length) {
    let json;
    try {
      json = JSON.parse(next);
    } catch (_error) {
      json = null;
    }
    if (json) {
      credentialCount = rewriteRecoveryCredentials(json, credentials);
      if (credentialCount) {
        next = serialize(json, detectFormat(text));
      }
    }
  }
  const changed = origins.count + credentialCount > 0;
  return {
    text: changed ? refreshUpdatedAt(next, now) : text,
    changed,
    originCount: origins.count,
    credentialCount,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.dir);
  const files = listJsonFiles(root, args.only);
  const inventory = new Map();
  let changedFiles = 0;
  let originTotal = 0;
  let credentialTotal = 0;
  for (const file of files) {
    const text = fs.readFileSync(file.full, "utf8");
    for (const [origin, count] of inventoryOrigins(text)) {
      inventory.set(origin, (inventory.get(origin) || 0) + count);
    }
    if (!args.maps.length && !args.credentials.length) {
      continue;
    }
    const result = migrateText(text, args);
    if (!result.changed) {
      continue;
    }
    changedFiles += 1;
    originTotal += result.originCount;
    credentialTotal += result.credentialCount;
    console.log(`${args.write ? "write" : "would change"}  ${file.relative}  origins=${result.originCount} credentials=${result.credentialCount}`);
    if (args.write) {
      fs.writeFileSync(file.full, result.text);
    }
  }
  console.log(`\nOrigins found in ${files.length} file(s) under ${path.relative(process.cwd(), root) || "."}:`);
  for (const [origin, count] of [...inventory].sort((a, b) => b[1] - a[1])) {
    const mapped = args.maps.find((item) => item.origin === origin);
    console.log(`  ${String(count).padStart(6)}  ${origin}${mapped ? `  -> {{origin.${mapped.name}}}` : ""}`);
  }
  if (args.maps.length || args.credentials.length) {
    console.log(`\n${args.write ? "Changed" : "Would change"} ${changedFiles} file(s): ${originTotal} origin reference(s), ${credentialTotal} credential literal(s).`);
    if (!args.write) {
      console.log("Dry run — nothing written. Re-run with --write to apply.");
    }
  } else {
    console.log("\nInventory only. Pass --map <origin>=<name> (repeatable) to preview a rewrite.");
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  inventoryOrigins,
  migrateText,
  rewriteOrigins,
  rewriteRecoveryCredentials,
};
