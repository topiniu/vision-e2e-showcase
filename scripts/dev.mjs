import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveDevServicePorts } from "./dev-ports.mjs";
import { getElectronLaunchOptions, quitElectronLaunchApp } from "./electron-launcher.mjs";

const require = createRequire(import.meta.url);
const {
  getDefaultZhuzhuUserDataRoot,
  getWorkspacePreferencesPath,
  normalizeWorkspaceRoot,
  readWorkspacePreferenceSync,
} = require("../src/shared/workspace-preferences.js");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
// Dev isolation: give the dev Electron its own userData dir so it never touches
// the packaged (release) app's settings, Chromium cache, cookies, auth cookies or
// window state — both apps otherwise share %APPDATA%/Zhuzhu (same app name) and
// fight over the cache lock. Honor an explicit ZHUZHU_USER_DATA_DIR; otherwise use
// a "Vision E2E Showcase-dev" sibling of the default userData root.
const explicitUserDataDir = String(process.env.ZHUZHU_USER_DATA_DIR || "").trim();
const defaultUserDataRoot = getDefaultZhuzhuUserDataRoot();
const devUserDataDir = explicitUserDataDir
  ? path.resolve(explicitUserDataDir)
  : path.join(path.dirname(defaultUserDataRoot), "Vision E2E Showcase-dev");
const explicitWorkspaceRoot = normalizeWorkspaceRoot(process.env.ZHUZHU_WORKSPACE_DIR);
// Read the remembered workspace from the *dev* userData, not release's, so dev
// starts from its own state (falls back to the repo root on first run).
const savedWorkspaceRoot = readWorkspacePreferenceSync(
  getWorkspacePreferencesPath(devUserDataDir),
);
const workspaceRoot = explicitWorkspaceRoot || savedWorkspaceRoot || projectRoot;
const workspaceEnv = {
  ...process.env,
  ...(workspaceRoot !== projectRoot || explicitWorkspaceRoot
    ? {
        ZHUZHU_WORKSPACE_DIR: workspaceRoot,
        ZHUZHU_WORKSPACE_SOURCE: explicitWorkspaceRoot ? "environment" : "preference",
      }
    : {}),
};
let devPorts;
try {
  devPorts = await resolveDevServicePorts(process.env);
} catch (error) {
  console.error(`[dev] Failed to resolve dev service ports: ${error?.message || error}`);
  process.exit(1);
}
const {
  panelUrl,
  panelHost,
  panelPort,
  runtimePort,
  runtimeUrl,
  appRunHost,
  appRunPort,
} = devPorts;
const restartWatchTargets = [
  "src/main",
  "src/preload",
  "runtime/assertions",
  "runtime/executor",
  "runtime/perception",
  "runtime/protocol",
  "runtime/reporting",
  "runtime/index.js",
  // The whole shared directory, not one file out of it. `src/shared` is the
  // contract boundary both the main process and the runtime server import
  // (test-file schema, precheck, api-guard, capability catalog). Watching only
  // `workspace-preferences.js` meant editing any of the others left the running
  // instance on the old behaviour while the edit looked applied — an api-guard
  // fix was verified as "still broken" against a process that had never
  // reloaded it. Panel files are excluded on purpose: Vite HMR owns those and
  // restarting Electron for them would be a regression.
  "src/shared",
]
  .map((target) => {
    const absolutePath = path.join(projectRoot, target);
    if (!fs.existsSync(absolutePath)) {
      return null;
    }
    return {
      absolutePath,
      relativePath: target,
      isDirectory: fs.statSync(absolutePath).isDirectory(),
    };
  })
  .filter(Boolean);

const restartWatchFileState = new Map();

let electronProcess = null;
let viteProcess = null;
let runtimeProcess = null;
let restartTimer = null;
let restartingElectron = false;
let shuttingDown = false;
let electronLaunchCount = 0;
const mainProcessWatchers = [];

function isRestartWatchFile(filePath) {
  return /\.(cjs|js|json|mjs)$/.test(filePath);
}

function getWatchFileSignature(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }
    return `${stats.mtimeMs}:${stats.size}`;
  } catch (_error) {
    return null;
  }
}

function rememberWatchFile(filePath) {
  const signature = getWatchFileSignature(filePath);
  if (signature) {
    restartWatchFileState.set(filePath, signature);
  }
}

function rememberWatchTree(targetPath) {
  try {
    const stats = fs.statSync(targetPath);
    if (stats.isFile()) {
      if (isRestartWatchFile(targetPath)) {
        rememberWatchFile(targetPath);
      }
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      const entryPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        rememberWatchTree(entryPath);
      } else if (entry.isFile() && isRestartWatchFile(entryPath)) {
        rememberWatchFile(entryPath);
      }
    }
  } catch (_error) {
    // Watch setup is best-effort; transient files can disappear during traversal.
  }
}

function hasMeaningfulWatchChange(filePath) {
  const signature = getWatchFileSignature(filePath);
  if (!signature) {
    return false;
  }
  const previousSignature = restartWatchFileState.get(filePath);
  restartWatchFileState.set(filePath, signature);
  return previousSignature !== signature;
}

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
}

function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", (error) => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error);
          return;
        }
        setTimeout(check, 250);
      });
      request.setTimeout(1_000, () => {
        request.destroy();
      });
    };
    check();
  });
}

function assertPortAvailable(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`Dev server port ${hostname}:${port} is unavailable: ${error.code || error.message}`));
    });
    server.once("listening", () => {
      server.close(resolve);
    });
    server.listen(Number(port), hostname);
  });
}

function startElectron() {
  electronLaunchCount += 1;
  const electronEnv = {
    ...workspaceEnv,
    ZHUZHU_USER_DATA_DIR: devUserDataDir,
    ZHUZHU_APP_MODE: "development",
    ZHUZHU_PANEL_DEV_SERVER_URL: panelUrl,
    ZHUZHU_APP_RUN_HOST: appRunHost,
    ZHUZHU_APP_RUN_PORT: String(appRunPort),
    ZHUZHU_SKIP_INITIAL_BROWSER_LOAD: process.env.ZHUZHU_SKIP_INITIAL_BROWSER_LOAD || "1",
    ZHUZHU_DEV_NO_FOCUS: process.env.ZHUZHU_DEV_NO_FOCUS || "1",
    ZHUZHU_DEV_RESTART_LAUNCH: electronLaunchCount > 1 ? "1" : "0",
  };
  const electronLaunch = getElectronLaunchOptions(projectRoot, { env: electronEnv });
  console.log(`[dev] Electron launch: ${electronLaunch.command}`);
  electronProcess = spawnProcess(electronLaunch.command, [...electronLaunch.args, projectRoot], {
    env: electronEnv,
  });

  electronProcess.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`[dev] Failed to start Electron: ${error?.message || error}`);
      shutdown();
    }
  });

  electronProcess.on("exit", (code, signal) => {
    electronProcess = null;
    if (shuttingDown) {
      return;
    }
    if (restartingElectron) {
      return;
    }
    console.error(`[dev] Electron exited with code ${code ?? "null"} signal ${signal ?? "none"}`);
    shutdown();
  });
}

function startRuntimeServer() {
  const runtimeEnv = {
    ...workspaceEnv,
    ZHUZHU_RUNTIME_PORT: String(runtimePort),
  };
  console.log(`[dev] Runtime server: ${runtimeUrl}`);
  runtimeProcess = spawnProcess(process.execPath, [path.join(projectRoot, "runtime/server/http.js")], {
    cwd: workspaceRoot,
    env: runtimeEnv,
  });

  runtimeProcess.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`[dev] Failed to start runtime server: ${error?.message || error}`);
      shutdown();
    }
  });

  runtimeProcess.on("exit", (code, signal) => {
    runtimeProcess = null;
    if (!shuttingDown) {
      console.error(`[dev] Runtime server exited with code ${code ?? "null"} signal ${signal ?? "none"}`);
      shutdown();
    }
  });
}

function restartElectron(reason) {
  if (shuttingDown) {
    return;
  }
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (restartingElectron) {
      return;
    }
    console.log(`[dev] Restarting Electron after ${reason}`);
    if (!electronProcess) {
      startElectron();
      return;
    }
    const previousProcess = electronProcess;
    previousProcess.once("exit", () => {
      restartingElectron = false;
      if (!shuttingDown) {
        startElectron();
      }
    });
    restartingElectron = true;
    quitElectronLaunchApp();
    setTimeout(() => {
      if (electronProcess === previousProcess) {
        previousProcess.kill("SIGTERM");
      }
    }, 1_500).unref();
  }, 180);
}

function watchMainProcessFiles() {
  restartWatchTargets.forEach((target) => rememberWatchTree(target.absolutePath));
  restartWatchTargets.forEach((target) => {
    const watcher = fs.watch(target.absolutePath, { recursive: target.isDirectory }, (_eventType, filename) => {
      if (!filename) {
        if (!target.isDirectory && hasMeaningfulWatchChange(target.absolutePath)) {
          restartElectron(target.relativePath);
        }
        return;
      }
      const changedPath = target.isDirectory ? path.join(target.relativePath, filename) : target.relativePath;
      const absoluteChangedPath = target.isDirectory ? path.join(target.absolutePath, filename) : target.absolutePath;
      if (isRestartWatchFile(changedPath) && hasMeaningfulWatchChange(absoluteChangedPath)) {
        restartElectron(changedPath);
      }
    });
    mainProcessWatchers.push(watcher);
  });
}

function closeMainProcessWatchers() {
  while (mainProcessWatchers.length) {
    const watcher = mainProcessWatchers.pop();
    try {
      watcher.close();
    } catch (_error) {
      // Ignore watcher shutdown races.
    }
  }
}

function shutdown({ exit = false, exitCode = 0 } = {}) {
  if (shuttingDown) {
    if (exit) {
      process.exit(exitCode);
    }
    return;
  }
  shuttingDown = true;
  clearTimeout(restartTimer);
  closeMainProcessWatchers();
  quitElectronLaunchApp();
  electronProcess?.kill("SIGTERM");
  viteProcess?.kill("SIGTERM");
  runtimeProcess?.kill("SIGTERM");
  if (exit) {
    setTimeout(() => process.exit(exitCode), 120).unref();
  }
}

process.on("SIGINT", () => shutdown({ exit: true }));
process.on("SIGTERM", () => shutdown({ exit: true }));
process.on("exit", shutdown);

try {
  for (const [service, shifted] of Object.entries(devPorts.shifted)) {
    if (shifted) {
      console.log(`[dev] ${service} port ${devPorts.preferred[service]} is occupied; using ${devPorts[`${service}Port`]}.`);
    }
  }
  await assertPortAvailable(panelUrl);
  await assertPortAvailable(runtimeUrl);
  await assertPortAvailable(`http://${appRunHost}:${appRunPort}`);
  startRuntimeServer();
  viteProcess = spawnProcess(process.execPath, ["scripts/web.mjs"], {
    env: {
      ...workspaceEnv,
      ZHUZHU_WEB_HOST: panelHost,
      ZHUZHU_WEB_PORT: String(panelPort),
      ZHUZHU_APP_RUN_HOST: appRunHost,
      ZHUZHU_APP_RUN_PORT: String(appRunPort),
    },
  });
  viteProcess.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] Panel server exited with code ${code ?? "null"} signal ${signal ?? "none"}`);
      shutdown();
    }
  });
  await waitForServer(`${runtimeUrl}/status`);
  await waitForServer(panelUrl);
  startElectron();
  watchMainProcessFiles();
  console.log(`[dev] Panel HMR: ${panelUrl}`);
  console.log(`[dev] App Run API: http://127.0.0.1:${appRunPort}`);
  console.log(`[dev] Workspace: ${workspaceRoot}`);
  console.log(`[dev] User data (isolated from release): ${devUserDataDir}`);
} catch (error) {
  console.error(`[dev] Failed to start dev services: ${error?.message || error}`);
  shutdown();
  process.exitCode = 1;
}
