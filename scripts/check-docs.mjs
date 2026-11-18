import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [path.join(root, "README.md"), ...fs.readdirSync(path.join(root, "docs"), { recursive: true }).filter((name) => name.endsWith(".md")).map((name) => path.join(root, "docs", name))];
const missing = [];
for (const file of files) {
  for (const match of fs.readFileSync(file, "utf8").matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:\/\//i.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) missing.push(`${path.relative(root, file)}: ${target}`);
  }
}
if (missing.length) { console.error(missing.join("\n")); process.exitCode = 1; }
else console.log(`Documentation links passed: ${files.length} Markdown files.`);
