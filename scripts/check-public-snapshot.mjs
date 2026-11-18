import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root }).toString().split("\0").filter(Boolean))];
const issues = [];
const patterns = [
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,})\b/],
  ["private-network URL", /https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/],
];

for (const relative of paths) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) continue;
  if (fs.lstatSync(absolute).isSymbolicLink()) { issues.push(`${relative}: symbolic link`); continue; }
  if (/^(?:output|captures|node_modules|release|dist|\.playwright-mcp)\/|storageState\.json$|\.(?:log|har|pptx|pdf|traineddata)$/.test(relative)
      || (/(?:^|\/)\.env(?:\.|$)/.test(relative) && relative !== ".env.example")
      || /(?:^|\/)\.zhuzhu-(?:credentials\.json|api-token|evidence-key)$/.test(relative)) {
    issues.push(`${relative}: private configuration or generated artifact`);
  }
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) {
    if (!/^(?:assets\/|src\/panel\/assets\/|docs\/demo\/)/.test(relative) && relative !== "test-assets/demo/fixture.png") issues.push(`${relative}: unreviewed binary asset`);
    continue;
  }
  const text = buffer.toString();
  for (const [label, pattern] of patterns) {
    // This fixture exercises RFC1918 classification with synthetic addresses.
    if (label === "private-network URL" && relative === "test/runtime/network-endpoints.test.js") continue;
    const match = pattern.exec(text);
    if (match) issues.push(`${relative}:${text.slice(0, match.index).split("\n").length}: ${label}`);
  }
  if (relative.startsWith("test-workflows/") && relative.endsWith(".json")) {
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      const target = node.target || {};
      if (node.type === "fill" && /password|密码/i.test(JSON.stringify({ name: target.name, text: target.text, locator: target.locator }))) {
        const value = target.value ?? node.value;
        if (typeof value === "string" && !/^\{\{credential\.[\w.-]+\}\}$/.test(value)) issues.push(`${relative}: literal password input`);
      }
      if (node.headers && Object.keys(node.headers).some((key) => /authorization|cookie|token/i.test(key))) {
        issues.push(`${relative}: authentication header in a distributable workflow`);
      }
      for (const value of Object.values(node)) visit(value);
    };
    visit(JSON.parse(text));
  }
}
if (issues.length) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Privacy gate passed: ${paths.length} tracked/candidate files, no matched secrets or private artifacts.`);
}
