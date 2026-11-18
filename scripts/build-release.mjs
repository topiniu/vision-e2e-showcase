import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createIcns } from "./release-assets.mjs";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Silence the single DEP0190 warning we knowingly accept: on Windows we spawn
// the `.cmd` bins through a shell (see run()), which Node flags because args are
// concatenated rather than escaped. Our args are our own constants, not input.
const originalProcessEmit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === "warning" && data && data.name === "DeprecationWarning" && data.code === "DEP0190") {
    return false;
  }
  return originalProcessEmit.call(this, name, data, ...rest);
};

const requestedTarget = process.argv.includes("--mac")
  ? "mac"
  : process.argv.includes("--win")
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : process.platform === "win32"
        ? "win"
        : null;
const directoryOnly = process.argv.includes("--dir");

if (!requestedTarget) {
  throw new Error(`Release builds are supported on macOS and Windows; received ${process.platform}.`);
}
if ((requestedTarget === "mac" && process.platform !== "darwin") ||
    (requestedTarget === "win" && process.platform !== "win32")) {
  throw new Error(`Build ${requestedTarget} on its native operating system so the bundled Playwright browser matches the installer.`);
}

const binExtension = process.platform === "win32" ? ".cmd" : "";
const playwrightBin = path.join(projectRoot, "node_modules", ".bin", `playwright${binExtension}`);
const electronBuilderBin = path.join(projectRoot, "node_modules", ".bin", `electron-builder${binExtension}`);

// ---------------------------------------------------------------------------
// Console formatting
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open, close) => (text) => (useColor ? `\x1b[${open}m${text}\x1b[${close}m` : `${text}`);
const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  green: wrap(32, 39),
  red: wrap(31, 39),
  cyan: wrap(36, 39),
  yellow: wrap(33, 39),
};
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const bar = () => color.cyan("─".repeat(56));

const TOTAL_STEPS = 3;
let stepNo = 0;
function step(label) {
  stepNo += 1;
  console.log(color.bold(`▸ [${stepNo}/${TOTAL_STEPS}] ${label}`));
}
function substep(text, done = false) {
  console.log(`    ${color.dim("·")} ${text}${done ? ` ${color.green("✓")}` : ""}`);
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
// Approximate on-disk size of a directory tree, resilient to transient files that
// electron-builder is actively writing.
function measureDirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const stat = safeStat(full);
        if (stat) total += stat.size;
      }
    }
  }
  return total;
}
// Size of just this build's output — the *subdirectories* of the output dir (e.g.
// win-unpacked / mac). This deliberately ignores top-level files so pre-existing
// installer artifacts from earlier builds (Zhuzhu-x.y.z.exe) don't mask progress.
function measureBuildOutputSize(outputAbs) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(outputAbs, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      total += measureDirSize(path.join(outputAbs, entry.name));
    }
  }
  return total;
}
function readValue(source, name, fallback) {
  try {
    const value = require(source)[name];
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
function readOutputDir() {
  try {
    const yml = fs.readFileSync(path.join(projectRoot, "electron-builder.yml"), "utf8");
    const match = yml.match(/^\s*output:\s*(.+)$/m);
    if (match) return match[1].trim().replace(/['"]/g, "");
  } catch {
    /* fall through */
  }
  return "release";
}

function printHeader(pkgVersion, electronVersion) {
  const targetLabel = directoryOnly
    ? `${requestedTarget} · --dir`
    : requestedTarget === "win"
      ? "win · nsis"
      : "mac · dmg+zip";
  const info = [
    `版本 ${pkgVersion}`,
    `目标 ${targetLabel} (${process.arch})`,
    electronVersion ? `Electron ${electronVersion}` : null,
    `Node ${process.versions.node}`,
  ]
    .filter(Boolean)
    .join("   ");
  console.log("");
  console.log(bar());
  console.log(`  ${color.bold("Zhuzhu 猪猪")}  ·  ${color.bold("Release build")}`);
  console.log(`  ${color.dim(info)}`);
  console.log(bar());
  console.log("");
}

function printSummary(outputDir, durationMs, pkgVersion) {
  const absoluteOutput = path.join(projectRoot, outputDir);
  const entries = (() => {
    try {
      return fs.readdirSync(absoluteOutput);
    } catch {
      return [];
    }
  })();
  const files = entries
    .map((name) => ({ name, stat: safeStat(path.join(absoluteOutput, name)) }))
    .filter((entry) => entry.stat && entry.stat.isFile() && !/^builder-(debug|effective-config)\./.test(entry.name));
  const rank = (name) => (/\.(exe|dmg|zip|msi|appimage|deb)$/i.test(name) ? 0 : 1);
  files.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

  console.log("");
  console.log(bar());
  // For --dir there is no installer; show the unpacked directory this build
  // produced (+ its app.asar size) instead of stale installer files from prior
  // builds that still sit in the output dir.
  if (directoryOnly || !files.length) {
    const dirs = entries.filter((name) => safeStat(path.join(absoluteOutput, name))?.isDirectory());
    console.log(`  ${color.bold("产物")} ${color.dim("(未生成安装包，--dir)")}`);
    for (const dir of dirs) {
      const dirSize = measureDirSize(path.join(absoluteOutput, dir));
      console.log(`    ${color.green(`${outputDir}/${dir}`)}  ${color.bold(formatSize(dirSize))}`);
      const asarPath = path.join(absoluteOutput, dir, "resources", "app.asar");
      const asarStat = safeStat(asarPath);
      if (asarStat) console.log(`      ${color.dim(`resources/app.asar  ${formatSize(asarStat.size)}`)}`);
    }
  } else {
    console.log(`  ${color.bold("产物")} ${color.dim(`(${outputDir}/)`)}`);
    const nameWidth = Math.min(46, Math.max(...files.map((entry) => entry.name.length)));
    for (const entry of files) {
      const primary = rank(entry.name) === 0;
      const name = entry.name.padEnd(nameWidth);
      const label = primary ? color.green(name) : color.dim(name);
      console.log(`    ${label}  ${color.bold(formatSize(entry.stat.size))}`);
    }
  }
  console.log("");
  console.log(`  ${color.green("✓ 完成")}  ${color.dim(`用时 ${formatDuration(durationMs)}  ·  版本 ${pkgVersion}`)}`);
  console.log(bar());
  console.log("");
}

// Translate electron-builder's verbose `• event  key=value` log stream into a
// few concise milestones. The giant "duplicate dependency references" line and
// the per-file signtool spam are collapsed; unknown events and any error/stack
// output pass through so real failures stay visible.
function createBuilderLineHandler() {
  const state = { signCount: 0 };
  const skip = new Set([
    "electron-builder",
    "loaded configuration",
    "writing effective config",
    "skipped dependencies rebuild",
    "searching for node modules",
    "duplicate dependency references",
    "downloaded electron zip extracted successfully",
    "updating asar integrity executable resource",
    "default Electron icon is used",
    "rebuilding native production dependencies",
    "asar usage is disabled",
  ]);
  const field = (body, key) => {
    const match = body.match(new RegExp(`${key}=(\\S+)`));
    return match ? match[1] : null;
  };
  const handle = (raw) => {
    const line = stripAnsi(raw).trimEnd();
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("•")) {
      // Pass warnings, `⨯` errors and stack traces through untouched.
      const isError = trimmed.startsWith("⨯") || /^error\b/i.test(trimmed);
      console.log(isError ? color.red(`    ${trimmed}`) : color.dim(`    ${trimmed}`));
      return;
    }
    const body = trimmed.replace(/^•\s*/, "");
    const message = body.split(/\s{2,}/)[0].trim();
    if (message === "signing with signtool.exe") {
      state.signCount += 1;
      return;
    }
    if (skip.has(message)) return;
    switch (message) {
      case "packaging": {
        const electron = field(body, "electron");
        const platform = field(body, "platform");
        const arch = field(body, "arch");
        const detail = [electron ? `Electron ${electron}` : null, platform ? `${platform}/${arch}` : null]
          .filter(Boolean)
          .join(" · ");
        substep(`打包应用${detail ? ` · ${detail}` : ""}`);
        return;
      }
      case "downloaded": {
        const label = field(body, "label");
        if (label === "electron") substep("下载 Electron 运行时", true);
        else if (label) substep(`下载构建工具 ${label.replace(/\.(7z|tar\.gz|zip)$/i, "")}`, true);
        return;
      }
      case "building":
        substep(`生成安装包${field(body, "target") ? ` (${field(body, "target")})` : ""}`, true);
        return;
      case "building block map":
        substep("生成校验 blockmap", true);
        return;
      case "building embedded block map":
        return;
      default:
        substep(color.dim(message));
        return;
    }
  };
  return { handle, state };
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // On Windows the resolved bins are `.cmd` shims; Node refuses to spawn a
    // `.cmd` without a shell (CVE-2024-27980) and throws `spawn EINVAL`. Run
    // through cmd.exe and quote command/args so the space in the project path
    // (e.g. `D:\Work\Projects\...`) does not split the command line.
    const useShell = process.platform === "win32";
    const spawnCommand = useShell ? `"${command}"` : command;
    const spawnArgs = useShell
      ? args.map((arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg}"` : arg))
      : args;
    const streaming = typeof options.onLine === "function";
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: projectRoot,
      stdio: streaming ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: useShell,
      env: { ...process.env, ...options.env },
    });
    if (streaming) {
      const attach = (stream) => {
        let buffer = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            options.onLine(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
          }
        });
        stream.on("end", () => {
          if (buffer.trim()) options.onLine(buffer);
          buffer = "";
        });
      };
      attach(child.stdout);
      attach(child.stderr);
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with ${code ?? signal ?? "unknown"}.`));
    });
  });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function buildRelease() {
  const startedAt = Date.now();
  const pkgVersion = readValue(path.join(projectRoot, "package.json"), "version", "0.0.0");
  const electronVersion = readValue("electron/package.json", "version", null);
  const outputDir = readOutputDir();

  printHeader(pkgVersion, electronVersion);

  step("准备发布资源");
  const releaseAssetsRoot = path.join(projectRoot, ".release-assets");
  fs.mkdirSync(releaseAssetsRoot, { recursive: true });
  createIcns(projectRoot, path.join(releaseAssetsRoot, "app-icon.icns"));
  substep("生成应用图标资源", true);

  step(`安装 Playwright Chromium (${process.platform})`);
  await run(playwrightBin, ["install", "chromium"], {
    env: {
      PLAYWRIGHT_BROWSERS_PATH: "0",
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    },
  });
  substep("Chromium 已就绪", true);

  step(`electron-builder ${directoryOnly ? "打包 (--dir，不生成安装包)" : `构建${requestedTarget === "win" ? " (nsis)" : " (dmg+zip)"}`}`);
  const args = ["--config", "electron-builder.yml", `--${requestedTarget}`, "--publish", "never"];
  if (directoryOnly) {
    args.push("--dir");
  }
  const builder = createBuilderLineHandler();
  // The copy-Chromium + build-asar + afterPack phase emits almost no log lines
  // (it can be a quiet minute+ that looks hung). A heartbeat prints elapsed time
  // and the growing output size while the builder is silent, so progress is
  // visible. It resets whenever a real builder line comes through.
  const outputAbs = path.join(projectRoot, outputDir);
  const phaseStartedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastSize = -1;
  let lastSizeChangeAt = Date.now();
  const QUIET_MS = 8000;
  const STALL_WARN_MS = 90000;
  const heartbeat = setInterval(() => {
    if (Date.now() - lastActivityAt < QUIET_MS) return;
    const size = measureBuildOutputSize(outputAbs);
    if (size !== lastSize) {
      lastSize = size;
      lastSizeChangeAt = Date.now();
    }
    const elapsed = formatDuration(Date.now() - phaseStartedAt);
    const stalledMs = Date.now() - lastSizeChangeAt;
    if (stalledMs >= STALL_WARN_MS) {
      // Size hasn't moved for a while. Usually the asar-collection step (reading
      // node_modules, no disk growth) — but if a process isn't burning CPU it may
      // be a real stall (commonly antivirus locking files).
      console.log(`    ${color.dim("·")} ${color.yellow(`打包中… ⏱ ${elapsed} · 产物 ${formatSize(size)} 已 ${formatDuration(stalledMs)} 未变`)}`);
      console.log(`      ${color.dim("若任务管理器里 electron-builder/node 进程仍在吃 CPU/磁盘 → 正常（多为打 asar）；若为 0 → 疑似被杀软锁文件，可 Ctrl+C 后将项目目录加入 Defender 排除")}`);
      return;
    }
    const phase = stalledMs > 15000 ? "打包 asar（读取 node_modules，体积暂不变属正常）" : "拷贝资源 / 打包";
    console.log(`    ${color.dim("·")} ${color.dim(`${phase}… ⏱ ${elapsed} · 产物 ${formatSize(size)}`)}`);
  }, 10000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  const onLine = (line) => {
    lastActivityAt = Date.now();
    builder.handle(line);
  };
  try {
    await run(electronBuilderBin, args, {
      onLine,
      env: {
        PLAYWRIGHT_BROWSERS_PATH: "0",
        // The default GitHub host for electron-builder's NSIS/winCodeSign tooling
        // is often unreachable on the China network (same as the Electron/Playwright
        // mirrors). Default to npmmirror; an explicit env value still wins.
        ELECTRON_BUILDER_BINARIES_MIRROR:
          process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
          "https://registry.npmmirror.com/-/binary/electron-builder-binaries/",
      },
    });
  } finally {
    clearInterval(heartbeat);
  }
  if (builder.state.signCount > 0) {
    substep(`代码签名 ${builder.state.signCount} 个可执行文件`, true);
  }

  printSummary(outputDir, Date.now() - startedAt, pkgVersion);
}

buildRelease().catch((error) => {
  console.error("");
  console.error(color.red(`✗ 发布失败：${error?.message || error}`));
  if (error?.stack && process.env.DEBUG) {
    console.error(color.dim(error.stack));
  }
  process.exitCode = 1;
});
