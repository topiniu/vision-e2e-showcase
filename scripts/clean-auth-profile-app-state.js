#!/usr/bin/env node
"use strict";

// 2026-10-27: strip app-state localStorage keys that earlier full write-backs
// left in auth profiles (pinned columns, fixed filter keys, batch-search tabs …),
// keeping cookies and auth keys only. Runs since then no longer add such keys
// (see runtime/executor/storage-writeback.js); this cleans what is already there.
//
//   node scripts/clean-auth-profile-app-state.js <profile> [...profiles]   # dry run
//   node scripts/clean-auth-profile-app-state.js --apply <profile> ...      # write (keeps a .bak)
//   node scripts/clean-auth-profile-app-state.js --all [--apply]

const fs = require("node:fs");
const path = require("node:path");
const { mergeAuthOnly } = require("../runtime/executor/storage-writeback");

const root = path.join(__dirname, "..", "output", "auth-profiles");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const names = args.includes("--all")
  ? fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, "storageState.json")))
  : args.filter((a) => !a.startsWith("--"));

if (!names.length) {
  console.error("usage: clean-auth-profile-app-state.js [--apply] (--all | <profile> ...)");
  process.exit(2);
}

for (const name of names) {
  const file = path.join(root, name, "storageState.json");
  if (!fs.existsSync(file)) {
    console.log(`${name}: no storageState.json, skipped`);
    continue;
  }
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  // Auth-only merge of the state with itself and no baseline keeps exactly the auth state.
  const cleaned = mergeAuthOnly(null, state);
  const before = state.origins.flatMap((o) => (o.localStorage || []).map((i) => `${o.origin} ${i.name}`));
  const after = new Set(cleaned.origins.flatMap((o) => o.localStorage.map((i) => `${o.origin} ${i.name}`)));
  const removed = before.filter((k) => !after.has(k));
  console.log(`${name}: ${removed.length} app-state key(s)${removed.length ? ":" : ""}`);
  for (const k of removed) console.log(`  - ${k}`);
  if (apply && removed.length) {
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
    console.log(`  written (backup: storageState.json.bak)`);
  }
}
if (!apply) console.log("\n(dry run — pass --apply to write)");
