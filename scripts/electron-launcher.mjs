import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createIcns } from "./release-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(__dirname, "..");
const appName = "Vision E2E Showcase";
const devAppRootName = ".zhuzhu-electron";
const bundleId = "com.topiniu.vision-e2e-showcase.dev";
const bundleIconName = "zhuzhu.icns";
const electronExecutableName = "Electron";
const electronBundleName = "Electron.app";
const zhuzhuBundleName = `${appName}.app`;

function splitExtraLaunchArgs(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function replacePlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (!pattern.test(plist)) {
    return `${plist}\n<key>${key}</key>\n<string>${value}</string>\n`;
  }
  return plist.replace(pattern, `$1${value}$3`);
}

function readElectronVersion(projectRoot) {
  const versionPath = path.join(projectRoot, "node_modules", "electron", "dist", "version");
  try {
    return fs.readFileSync(versionPath, "utf8").trim();
  } catch (_error) {
    return "unknown";
  }
}

function readAppVersion(projectRoot) {
  const packageJsonPath = path.join(projectRoot, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "0.0.0";
  } catch (_error) {
    return "0.0.0";
  }
}

function getFileSignature(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch (_error) {
    return "missing";
  }
}

function getMacElectronBundlePath(projectRoot) {
  const distPath = path.join(projectRoot, "node_modules", "electron", "dist");
  const electronAppPath = path.join(distPath, electronBundleName);
  const zhuzhuAppPath = path.join(distPath, zhuzhuBundleName);
  if (fs.existsSync(electronAppPath)) {
    return fs.realpathSync(electronAppPath);
  }
  if (fs.existsSync(zhuzhuAppPath)) {
    return fs.realpathSync(zhuzhuAppPath);
  }
  throw new Error(`Electron app bundle is missing from ${distPath}`);
}

function readLauncherMarker(markerPath) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function signMacDevApp(targetAppPath) {
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", targetAppPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to sign Zhuzhu dev app: ${result.stderr || result.stdout || "codesign failed"}`);
  }
}

function ensureMacDevApp(projectRoot) {
  const sourceAppPath = getMacElectronBundlePath(projectRoot);
  const targetRoot = path.join(projectRoot, devAppRootName);
  const targetAppPath = path.join(targetRoot, zhuzhuBundleName);
  const markerPath = path.join(targetRoot, "launcher.json");
  const patchTarget = `${devAppRootName}/${zhuzhuBundleName}`;
  const patchVersion = 6;
  const electronVersion = readElectronVersion(projectRoot);
  const appVersion = readAppVersion(projectRoot);
  const sourceIconPath = path.join(projectRoot, "assets", "app-icon.png");
  const iconSignature = getFileSignature(sourceIconPath);
  const expectedMarker = JSON.stringify(
    {
      appName,
      bundleId,
      bundleIconName,
      appVersion,
      electronVersion,
      iconSignature,
      patchTarget,
      patchVersion,
    },
    null,
    2,
  );

  if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, "utf8") === expectedMarker) {
    return targetAppPath;
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const previousMarker = readLauncherMarker(markerPath);
  const canReuseExistingBundle = fs.existsSync(targetAppPath)
    && previousMarker?.electronVersion === electronVersion
    && previousMarker?.patchTarget === patchTarget
    && previousMarker?.patchVersion === patchVersion;
  if (!canReuseExistingBundle) {
    fs.rmSync(targetAppPath, { recursive: true, force: true });
    fs.cpSync(sourceAppPath, targetAppPath, { recursive: true, verbatimSymlinks: true });
  }

  const plistPath = path.join(targetAppPath, "Contents", "Info.plist");
  let plist = fs.readFileSync(plistPath, "utf8");
  plist = replacePlistString(plist, "CFBundleDisplayName", appName);
  plist = replacePlistString(plist, "CFBundleName", appName);
  plist = replacePlistString(plist, "CFBundleIdentifier", bundleId);
  plist = replacePlistString(plist, "CFBundleIconFile", bundleIconName);
  plist = replacePlistString(plist, "CFBundleExecutable", electronExecutableName);
  plist = replacePlistString(plist, "CFBundleShortVersionString", appVersion);
  plist = replacePlistString(plist, "CFBundleVersion", appVersion);
  fs.writeFileSync(plistPath, plist);

  const legacyExecutablePath = path.join(targetAppPath, "Contents", "MacOS", appName);
  if (appName !== electronExecutableName) {
    fs.rmSync(legacyExecutablePath, { force: true });
  }

  createIcns(projectRoot, path.join(targetAppPath, "Contents", "Resources", bundleIconName));
  fs.utimesSync(targetAppPath, new Date(), new Date());
  signMacDevApp(targetAppPath);
  fs.writeFileSync(markerPath, expectedMarker);

  return targetAppPath;
}

export function quitElectronLaunchApp() {
  if (process.platform !== "darwin") {
    return;
  }
  spawnSync("osascript", ["-e", `tell application id "${bundleId}" to quit`], {
    stdio: "ignore",
  });
}

export function getElectronLaunchOptions(projectRoot = defaultProjectRoot, options = {}) {
  // Recent Electron packages download their binary on first require.
  createRequire(import.meta.url)(path.join(projectRoot, "node_modules", "electron"));
  const env = options.env || process.env;
  const extraArgs = splitExtraLaunchArgs(env.ELECTRON_EXTRA_LAUNCH_ARGS);

  if (process.platform === "darwin") {
    const targetAppPath = ensureMacDevApp(projectRoot);
    return {
      command: path.join(targetAppPath, "Contents", "MacOS", electronExecutableName),
      args: extraArgs,
    };
  }

  return {
    command: getElectronBinaryPath(projectRoot),
    args: extraArgs,
  };
}

function getElectronBinaryPath(projectRoot) {
  const electronDir = path.join(projectRoot, "node_modules", "electron");
  const distDir = path.join(electronDir, "dist");
  // The `electron` package records its real executable name in path.txt. Spawn
  // that binary directly instead of the `.bin/electron.cmd` shim: Node refuses to
  // spawn `.cmd`/`.bat` files without `shell: true` (CVE-2024-27980), which throws
  // `spawn EINVAL` on Windows.
  try {
    const executableName = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
    if (executableName) {
      return path.join(distDir, executableName);
    }
  } catch (_error) {
    // Fall back to platform defaults below.
  }
  return path.join(distDir, process.platform === "win32" ? "electron.exe" : "electron");
}

function runCli() {
  const { command, args } = getElectronLaunchOptions(defaultProjectRoot);
  const child = spawn(command, [...args, ...process.argv.slice(2)], {
    cwd: defaultProjectRoot,
    stdio: "inherit",
    env: process.env,
  });

  child.on("close", (code, signal) => {
    if (code === null) {
      console.error(`${command} exited with signal ${signal}`);
      process.exit(1);
    }
    process.exit(code);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      quitElectronLaunchApp();
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runCli();
}
