import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const require = createRequire(import.meta.url);
const {
  buildTestFileName,
  createTestFileDraft,
  isSafeRelativeTestFilePath,
  normalizeTestFile,
} = require("../src/shared/test-file.js");
const {
  listRunArchive,
  readRunReport,
  rebuildRunArchive,
} = require("../src/main/run-archive.js");
const { handleRunBoardRoute } = require("../runtime/server/run-board-http.js");
const { listAppRunNetworkEndpoints } = require("../src/main/network-endpoints.js");
const { getIntegrationWorkspacePaths } = require("../src/shared/integration-workspace.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(process.env.ZHUZHU_WORKSPACE_DIR || projectRoot);
const testWorkflowsRoot = path.join(workspaceRoot, "test-workflows");
const outputRoot = path.join(workspaceRoot, "output");
const integrationWorkspace = getIntegrationWorkspacePaths(workspaceRoot);
const outputRunsRoot = path.join(outputRoot, "runs");
const debugLogRoot = path.join(outputRoot, "debug");
const buildCasesRunDebugLog = path.join(debugLogRoot, "build-cases-run-debug.log");
const externalIntegrationDocuments = [
  { id: "external-api", title: "External tool integration", audience: "Tools", path: "docs/test-file-json-integration-guide.md", description: "Runtime API, validation, sessions, visible app runs, and report-driven reruns." },
  { id: "ai-integration", title: "AI test generation integration", audience: "AI", path: "docs/ai-test-generation-integration.md", description: "How AI should generate, validate, execute, diagnose, and revise Zhuzhu test files." },
  { id: "ai-trust-loop", title: "AI trust-loop contract", audience: "AI", path: "docs/0.6.0/ai-trust-loop-contract.md", description: "The versioned quality-gate and repair-context contract for AI collaboration." },
];
const host = process.env.ZHUZHU_WEB_HOST || "127.0.0.1";
const port = Number(process.env.ZHUZHU_WEB_PORT || process.env.PORT || 5174);
const appRunPort = Number(process.env.ZHUZHU_APP_RUN_PORT || 32147);

const imageMimeByExtension = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function isInsideDirectory(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveTestWorkflowPath(rawPath) {
  if (!isSafeRelativeTestFilePath(rawPath)) {
    return null;
  }
  const targetPath = path.resolve(testWorkflowsRoot, rawPath);
  if (!isInsideDirectory(targetPath, testWorkflowsRoot) && targetPath !== testWorkflowsRoot) {
    return null;
  }
  return targetPath;
}

function getRelativeTestWorkflowPath(targetPath) {
  return path.relative(testWorkflowsRoot, targetPath).split(path.sep).join("/");
}

async function ensureTestWorkflowsRoot() {
  await fs.mkdir(testWorkflowsRoot, { recursive: true });
}

async function listJsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(target));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      files.push(target);
    }
  }
  return files;
}

async function listReportFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "steps") {
        files.push(...await listReportFiles(target));
      }
    } else if (entry.isFile() && entry.name === "report.json") {
      files.push(target);
    }
  }
  return files;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readExternalIntegrationDocuments() {
  const endpoints = listAppRunNetworkEndpoints({ port: appRunPort });
  const appRunHost = String(process.env.ZHUZHU_APP_RUN_HOST || "0.0.0.0").trim() || "0.0.0.0";
  return {
    success: true,
    networkAccess: appRunHost !== "127.0.0.1" && appRunHost !== "::1",
    bindHost: appRunHost,
    appRunBaseUrl: endpoints[0].baseUrl,
    endpoint: endpoints[0].documentsUrl,
    endpoints,
    workspace: integrationWorkspace,
    documents: await Promise.all(externalIntegrationDocuments.map(async (document) => ({
      ...document,
      markdown: await fs.readFile(path.join(projectRoot, document.path), "utf8"),
    }))),
  };
}

async function listTestWorkflowFiles() {
  await ensureTestWorkflowsRoot();
  const files = await listJsonFiles(testWorkflowsRoot);
  const items = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (!raw) {
      continue;
    }
    try {
      const testFile = normalizeTestFile(JSON.parse(raw));
      items.push({
        path: getRelativeTestWorkflowPath(filePath),
        id: testFile.id,
        name: testFile.name,
        createdAt: testFile.createdAt,
        updatedAt: testFile.updatedAt,
        group: testFile.group,
        baseUrl: testFile.baseUrl,
        tags: testFile.tags,
        caseCount: testFile.cases.length,
        requirement: testFile.requirement,
      });
    } catch (_error) {
      items.push({
        path: getRelativeTestWorkflowPath(filePath),
        id: path.basename(filePath, ".json"),
        name: path.basename(filePath, ".json"),
        group: "",
        baseUrl: "",
        tags: [],
        caseCount: 0,
        requirement: {},
        invalid: true,
      });
    }
  }
  items.sort((a, b) => `${a.group || ""}/${a.name}`.localeCompare(`${b.group || ""}/${b.name}`));
  return { success: true, files: items };
}

async function readTestWorkflowFile(relativePath) {
  await ensureTestWorkflowsRoot();
  const targetPath = resolveTestWorkflowPath(relativePath);
  if (!targetPath) {
    return { success: false, error: "invalid-path" };
  }
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return {
      success: true,
      path: getRelativeTestWorkflowPath(targetPath),
      testFile: normalizeTestFile(JSON.parse(raw)),
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "read-failed",
      message: error?.message || String(error),
    };
  }
}

async function saveTestWorkflowFile({ path: relativePath, testFile }) {
  await ensureTestWorkflowsRoot();
  let normalized = normalizeTestFile(testFile);
  const targetPath = resolveTestWorkflowPath(relativePath || buildTestFileName(normalized.name));
  if (!targetPath) {
    return { success: false, error: "invalid-path" };
  }
  const existingRaw = await fs.readFile(targetPath, "utf8").catch(() => null);
  if (existingRaw) {
    try {
      const existing = normalizeTestFile(JSON.parse(existingRaw));
      normalized = normalizeTestFile({
        ...normalized,
        createdAt: normalized.createdAt || existing.createdAt,
        updatedAt: normalized.updatedAt || existing.updatedAt,
      });
    } catch (_error) {
      // Keep the incoming normalized file if the existing file cannot be parsed.
    }
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return {
    success: true,
    path: getRelativeTestWorkflowPath(targetPath),
    testFile: normalized,
  };
}

async function getAvailableCopyPath(sourcePath) {
  const ext = path.extname(sourcePath) || ".json";
  const base = sourcePath.slice(0, -ext.length);
  let targetPath = `${base}-copy${ext}`;
  let counter = 2;
  while (true) {
    try {
      await fs.access(targetPath);
      targetPath = `${base}-copy-${counter}${ext}`;
      counter += 1;
    } catch (_error) {
      return targetPath;
    }
  }
}

async function copyTestWorkflowFile({ path: relativePath } = {}) {
  await ensureTestWorkflowsRoot();
  const sourcePath = resolveTestWorkflowPath(relativePath);
  if (!sourcePath) {
    return { success: false, error: "invalid-path" };
  }
  try {
    const raw = await fs.readFile(sourcePath, "utf8");
    const sourceFile = normalizeTestFile(JSON.parse(raw));
    const copySuffix = Date.now().toString(36);
    const copiedFile = normalizeTestFile({
      ...sourceFile,
      id: `${sourceFile.id}-copy-${copySuffix}`,
      name: `${sourceFile.name} Copy`,
    });
    const targetPath = await getAvailableCopyPath(sourcePath);
    await fs.writeFile(targetPath, `${JSON.stringify(copiedFile, null, 2)}\n`, "utf8");
    return {
      success: true,
      path: getRelativeTestWorkflowPath(targetPath),
      testFile: copiedFile,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "copy-failed",
      message: error?.message || String(error),
    };
  }
}

async function createTestWorkflowFile(payload = {}) {
  const source = payload?.testFile || payload || {};
  const now = new Date().toISOString();
  const testFile = createTestFileDraft({
    ...source,
    createdAt: source.createdAt || now,
    updatedAt: source.updatedAt || now,
  });
  const requestedName = payload?.path || buildTestFileName(testFile.name);
  let targetPath = resolveTestWorkflowPath(requestedName);
  if (!targetPath) {
    return { success: false, error: "invalid-path" };
  }
  let counter = 2;
  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, -ext.length);
  while (true) {
    try {
      await fs.access(targetPath);
      targetPath = `${base}-${counter}${ext}`;
      counter += 1;
    } catch (_error) {
      break;
    }
  }
  return saveTestWorkflowFile({
    path: getRelativeTestWorkflowPath(targetPath),
    testFile,
  });
}

async function listRunHistory({
  testFilePath = null,
  limit = 20,
  page = 1,
  pageSize = null,
  status = "",
  query = "",
  dateFrom = null,
  dateTo = null,
  sort = "newest",
  scope = "",
  excludeCaseRuns = false,
} = {}) {
  const response = await listRunArchive(outputRunsRoot, {
    testFilePath,
    page,
    pageSize: pageSize || limit,
    status,
    query,
    dateFrom,
    dateTo,
    sort,
    scope,
    excludeCaseRuns,
  });
  return {
    success: true,
    page: response.page,
    pageSize: response.pageSize,
    total: response.total,
    totalPages: response.totalPages,
    stats: response.stats,
    filteredStats: response.filteredStats,
    runs: (response.items || []).map((item) => ({
      reportPath: item.reportPath,
      runDir: item.runDir,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      ok: item.ok,
      mode: item.mode || "",
      telemetry: {
        durationMs: item.durationMs,
        steps: item.steps,
        okCount: item.okCount,
        errorCount: item.errorCount,
        browserUrl: item.browserUrl,
      },
      testContext: {
        testFileId: item.testFileId,
        testFilePath: item.testFilePath,
        testFileName: item.testFileName,
        caseId: item.caseId,
        caseName: item.caseName,
      },
      error: item.firstFailure,
      runContext: item.runContext,
    })),
  };
}

async function readEvidenceImage(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { success: false, error: "invalid-path" };
  }
  const targetPath = path.resolve(rawPath);
  if (!isInsideDirectory(targetPath, outputRoot)) {
    return { success: false, error: "path-not-allowed" };
  }
  const mimeType = imageMimeByExtension.get(path.extname(targetPath).toLowerCase());
  if (!mimeType) {
    return { success: false, error: "unsupported-image-type" };
  }
  try {
    const file = await fs.readFile(targetPath);
    return {
      success: true,
      path: targetPath,
      mimeType,
      dataUrl: `data:${mimeType};base64,${file.toString("base64")}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "read-failed",
      message: error?.message || String(error),
    };
  }
}

async function readEvidenceJson(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { success: false, error: "invalid-path" };
  }
  const targetPath = path.resolve(rawPath);
  if (!isInsideDirectory(targetPath, outputRunsRoot)) {
    return { success: false, error: "path-not-allowed" };
  }
  if (path.extname(targetPath).toLowerCase() !== ".json") {
    return { success: false, error: "unsupported-json-type" };
  }
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    return {
      success: true,
      path: targetPath,
      data: JSON.parse(raw),
    };
  } catch (error) {
    return {
      success: false,
      error: error?.code === "ENOENT" ? "file-not-found" : "read-failed",
      message: error?.message || String(error),
    };
  }
}

async function appendDebugLog(payload = {}) {
  await fs.mkdir(debugLogRoot, { recursive: true });
  const entry = {
    recordedAt: new Date().toISOString(),
    pid: process.pid,
    ...payload,
  };
  await fs.appendFile(buildCasesRunDebugLog, `${JSON.stringify(entry)}\n`, "utf8");
  return {
    success: true,
    path: buildCasesRunDebugLog,
  };
}

function webApiPlugin() {
  return {
    name: "zhuzhu-web-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url || "/", `http://${host}:${port}`);
        if (url.pathname !== "/run-board" && !url.pathname.startsWith("/run-board/")) return next();
        try {
          if (!await handleRunBoardRoute(request, response, url, { outputRoot, label: "web" })) next();
        } catch (error) {
          next(error);
        }
      });
      server.middlewares.use("/__zhuzhu", async (request, response) => {
        try {
          const url = new URL(request.url || "/", `http://${host}:${port}`);
          const method = request.method || "GET";
          if (method === "GET" && url.pathname === "/runtime-state") {
            sendJson(response, 200, {
              available: false,
              endpoint: "web-read-write-panel",
              capabilities: ["testFile.list", "testFile.read", "testFile.write", "history.list"],
              error: { message: "runtime-runner-unavailable-in-web-mode", details: null },
            });
            return;
          }
          if (method === "POST" && url.pathname === "/page-structure") {
            sendJson(response, 200, {
              success: false,
              error: {
                code: "browser-unavailable",
                message: "Page structure viewer requires the Zhuzhu desktop app controlled browser.",
              },
            });
            return;
          }
          if (method === "POST" && url.pathname === "/auth/capture") {
            sendJson(response, 200, {
              success: false,
              ok: false,
              error: {
                code: "browser-unavailable",
                message: "Auth profile capture requires the Zhuzhu desktop app controlled browser.",
              },
            });
            return;
          }
          if (method === "GET" && url.pathname === "/browser-state") {
            sendJson(response, 200, {
              title: "",
              url: "",
              requestedUrl: null,
              redirectChain: [],
              lastError: null,
              loadProgress: 0,
              loadStatus: "Web mode",
              isLoading: false,
              browserMode: "web-panel-only",
              browserTarget: "Open Zhuzhu desktop app to run automation",
              runtimeEndpoint: "unavailable-in-web-mode",
            });
            return;
          }
          if (method === "GET" && url.pathname === "/test-files") {
            sendJson(response, 200, await listTestWorkflowFiles());
            return;
          }
          if (method === "GET" && url.pathname === "/external-integration-documents") {
            sendJson(response, 200, await readExternalIntegrationDocuments());
            return;
          }
          if (method === "GET" && url.pathname === "/test-files/read") {
            sendJson(response, 200, await readTestWorkflowFile(url.searchParams.get("path")));
            return;
          }
          if (method === "POST" && url.pathname === "/test-files/save") {
            sendJson(response, 200, await saveTestWorkflowFile(await readJsonBody(request)));
            return;
          }
          if (method === "POST" && url.pathname === "/test-files/create") {
            sendJson(response, 200, await createTestWorkflowFile(await readJsonBody(request)));
            return;
          }
          if (method === "POST" && url.pathname === "/test-files/copy") {
            sendJson(response, 200, await copyTestWorkflowFile(await readJsonBody(request)));
            return;
          }
          if (method === "POST" && url.pathname === "/run-history") {
            sendJson(response, 200, await listRunHistory(await readJsonBody(request)));
            return;
          }
          if (method === "POST" && url.pathname === "/run-archive") {
            sendJson(response, 200, await listRunArchive(outputRunsRoot, await readJsonBody(request)));
            return;
          }
          if (method === "POST" && url.pathname === "/run-report") {
            const body = await readJsonBody(request);
            sendJson(response, 200, await readRunReport(outputRunsRoot, body.reportPath || body.path));
            return;
          }
          if (method === "POST" && url.pathname === "/run-archive/rebuild") {
            const index = await rebuildRunArchive(outputRunsRoot);
            sendJson(response, 200, {
              success: true,
              schemaVersion: index.schemaVersion,
              generatedAt: index.generatedAt,
              total: index.items?.length || 0,
            });
            return;
          }
          if (method === "POST" && url.pathname === "/debug-log") {
            sendJson(response, 200, await appendDebugLog(await readJsonBody(request)));
            return;
          }
          if (method === "POST" && url.pathname === "/evidence-image") {
            const body = await readJsonBody(request);
            sendJson(response, 200, await readEvidenceImage(body.path));
            return;
          }
          if (method === "POST" && url.pathname === "/evidence-json") {
            const body = await readJsonBody(request);
            sendJson(response, 200, await readEvidenceJson(body.path));
            return;
          }
          if (method === "POST" && (url.pathname === "/runtime-run" || url.pathname === "/runtime-stop")) {
            sendJson(response, 200, {
              ok: false,
              success: false,
              type: "web-runtime-unavailable",
              error: {
                code: "runtime-runner-unavailable-in-web-mode",
                message: "Web mode supports authoring test files. Open the Zhuzhu desktop app to run automation.",
              },
            });
            return;
          }
          sendJson(response, 404, { success: false, error: "not-found" });
        } catch (error) {
          sendJson(response, 500, {
            success: false,
            error: "web-api-failed",
            message: error?.message || String(error),
          });
        }
      });
    },
  };
}

// Inject the single-source-of-truth version (package.json) into the panel bundle,
// mirroring vite.config.mjs. This inline dev/web server does NOT load
// vite.config.mjs, so without this the panel's __ZHUZHU_VERSION__ is undefined in
// `npm run dev` / `npm run web` and the sidebar version goes blank.
const pkgVersion = require("../package.json").version;

const server = await createViteServer({
  root: path.resolve(projectRoot, "src", "panel"),
  base: "./",
  define: {
    __ZHUZHU_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [react(), tailwindcss(), webApiPlugin()],
  server: {
    host,
    port,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@panel": path.resolve(projectRoot, "src", "panel"),
    },
  },
});

await server.listen();
server.printUrls();
console.log(`[web] Zhuzhu web panel: http://${host}:${port}/#test-file`);
console.log("[web] Automation runtime is disabled in web mode. Use npm run dev for Zhuzhu desktop runtime execution.");
