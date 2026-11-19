import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const history = args.includes("--history");
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1] || ".")
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateReferences = String(process.env.ZHUZHU_PRIVATE_REFERENCES || "")
  .split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
const requirePolicy = /^(1|true|yes)$/i.test(process.env.ZHUZHU_REQUIRE_PRIVATE_REFERENCES || "");
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = [
  ...privateReferences.map((value) => ["private reference", new RegExp(escapeRegex(value), "i")]),
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["provider token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ["private-network URL", /https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/],
];
const issues = new Set();
const git = (...command) => execFileSync("git", command, { cwd: root, maxBuffer: 64 * 1024 * 1024 });

function inspectPath(relative, mode) {
  if (mode === "120000" || mode === "160000") issues.add(`${relative}: symbolic link or submodule`);
  if (/^(?:output|captures|node_modules|release|dist|\.playwright-mcp)\/|storageState\.json$|\.(?:tok|log|har|pptx|pdf|traineddata|pem|p12|pfx)$/.test(relative)
      || (/(?:^|\/)\.env(?:\.|$)/.test(relative) && relative !== ".env.example")
      || /(?:^|\/)\.zhuzhu-(?:credentials\.json|api-token|evidence-key)$/.test(relative)) {
    issues.add(`${relative}: private configuration or generated artifact`);
  }
  for (const [label, regex] of patterns) {
    if (label === "private reference" && regex.test(relative)) issues.add(`${relative}: ${label} in filename`);
  }
}

function inspectContent(buffer, relative, location = relative) {
  const binary = buffer.includes(0);
  if (binary && !/^(?:assets\/|src\/panel\/assets\/|docs\/demo\/)/.test(relative) && relative !== "test-assets/demo/fixture.png") {
    issues.add(`${location}: unreviewed binary asset`);
  }
  // Known references and credentials can also occur in uncompressed image metadata.
  const text = buffer.toString("utf8");
  for (const [label, regex] of patterns) {
    if (label === "private-network URL" && relative === "test/runtime/network-endpoints.test.js") continue;
    const match = regex.exec(text);
    if (match) issues.add(`${location}:${text.slice(0, match.index).split("\n").length}: ${label}`);
  }
  if (binary) return;
  for (const match of text.matchAll(/\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cn|com|net|org|io|dev|app))(?=[^a-z0-9.-]|$)/gi)) {
    if (!/(?:^|\.)example\.(?:com|net|org|test)$|\.test$/.test(match[1].toLowerCase())) {
      issues.add(`${location}:${text.slice(0, match.index).split("\n").length}: unreviewed wildcard environment domain`);
    }
  }
  if (relative.startsWith("test-workflows/") && relative.endsWith(".json")) {
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      const target = node.target || {};
      if (node.type === "fill" && /password|密码/i.test(JSON.stringify({ name: target.name, text: target.text, locator: target.locator }))) {
        const value = target.value ?? node.value;
        if (typeof value === "string" && !/^\{\{credential\.[\w.-]+\}\}$/.test(value)) issues.add(`${location}: literal password input`);
      }
      if (node.headers && Object.keys(node.headers).some((key) => /authorization|cookie|token/i.test(key))) {
        issues.add(`${location}: authentication header in a distributable workflow`);
      }
      for (const value of Object.values(node)) visit(value);
    };
    visit(JSON.parse(text));
  }
}

function inspectWorktree() {
  const paths = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean))];
  for (const relative of paths) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    inspectPath(relative, stat.isSymbolicLink() ? "120000" : "100644");
    if (!stat.isSymbolicLink()) inspectContent(fs.readFileSync(absolute), relative);
  }
  return `${paths.length} tracked/candidate files`;
}

function inspectHistory() {
  if (git("rev-parse", "--is-shallow-repository").toString().trim() !== "false") {
    throw new Error("Complete history required; use a full clone or fetch-depth: 0.");
  }
  const commits = git("rev-list", "--all").toString().trim().split("\n").filter(Boolean);
  if (!commits.length) throw new Error("No reachable commits to audit.");
  const objectPaths = new Map();
  for (const commit of commits) {
    for (const entry of git("ls-tree", "-rz", "--full-tree", commit).toString().split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, tab).split(" ");
      const relative = entry.slice(tab + 1);
      inspectPath(relative, mode);
      if (type === "blob") {
        if (!objectPaths.has(oid)) objectPaths.set(oid, new Set());
        objectPaths.get(oid).add(relative);
      }
    }
  }
  const objects = git("rev-list", "--all", "--objects", "--no-object-names").toString().trim().split("\n");
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root, input: objects.join("\n") + "\n", maxBuffer: 64 * 1024 * 1024,
  });
  let cursor = 0;
  for (const oid of objects) {
    const end = batch.indexOf(10, cursor);
    const [actual, type, sizeText] = batch.subarray(cursor, end).toString().split(" ");
    const size = Number(sizeText);
    if (actual !== oid || !Number.isFinite(size)) throw new Error("Invalid Git object stream.");
    const content = batch.subarray(end + 1, end + 1 + size);
    cursor = end + 2 + size;
    if (type === "blob") {
      for (const relative of objectPaths.get(oid) || []) inspectContent(content, relative, `git:${oid.slice(0, 12)}:${relative}`);
    } else if (type === "commit" || type === "tag") {
      inspectContent(content, "git-metadata", `git:${oid.slice(0, 12)}:${type}`);
    }
  }
  return `${commits.length} commits, ${objectPaths.size} unique file blobs, all reachable refs`;
}

try {
  if (requirePolicy && !privateReferences.length) throw new Error("Private release policy required but not configured.");
  const scope = history ? inspectHistory() : inspectWorktree();
  if (issues.size) {
    let message = [...issues].sort().join("\n");
    for (const reference of privateReferences) message = message.replace(new RegExp(escapeRegex(reference), "gi"), "[redacted]");
    console.error(message);
    process.exitCode = 1;
  } else {
    console.log(`${history ? "History privacy" : "Privacy"} gate passed: ${scope}.`);
    console.log(`Private reference policy: ${privateReferences.length ? "configured" : "not configured; private release review still required"}.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
