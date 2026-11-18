"use strict";


const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

// Built fresh per call, deliberately: a module-level /g/ regex carries
// `lastIndex` between calls, so the second string scanned would start reading
// from wherever the first one stopped and silently drop matches.
//
// The locator pattern tolerates an optional backslash before the quote because
// the input is usually a JSON-serialized step, where `[data-testid="x"]` arrives
// as `[data-testid=\"x\"]`.
function extractTestIds(text) {
  const found = new Set();
  const source = String(text ?? "");
  const patterns = [
    /"testId"\s*:\s*"([^"]+)"/g,
    /\[data-testid=\\?["']([^"'\\]+)\\?["']\]/g,
    /\[data-test-id=\\?["']([^"'\\]+)\\?["']\]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      found.add(match[1]);
    }
  }
  return found;
}

async function walkJsonFiles(root, { limit = 2000 } = {}) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(full);
      }
    }
  }
  return files;
}

// --- source 1: the authored test files ---------------------------------------

// Which testid is used by which case, and with which action. This is the "which
// cases would this testid break" half of the answer, and it needs no cooperation
// from anybody else.
async function collectFromTestFiles(testWorkflowsRoot) {
  const usage = new Map();
  if (!testWorkflowsRoot || !fsSync.existsSync(testWorkflowsRoot)) {
    return { usage, files: 0 };
  }
  const files = await walkJsonFiles(testWorkflowsRoot);
  let parsed = 0;
  for (const file of files) {
    let testFile;
    try {
      testFile = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (_error) {
      continue;
    }
    parsed += 1;
    const relative = path.relative(testWorkflowsRoot, file);
    const visitCase = (caseItem) => {
      const steps = [
        ...(Array.isArray(caseItem?.steps) ? caseItem.steps : []),
        ...((caseItem?.consistencyGroup?.probes || []).flatMap((probe) => probe?.steps || [])),
      ];
      for (const step of steps) {
        const ids = extractTestIds(JSON.stringify(step ?? {}));
        for (const testId of ids) {
          if (!usage.has(testId)) {
            usage.set(testId, { testId, usedBy: [], actions: new Set() });
          }
          const record = usage.get(testId);
          record.actions.add(String(step?.type || step?.kind || "unknown"));
          const key = `${relative}#${caseItem?.id || ""}`;
          if (!record.usedBy.some((item) => item.key === key)) {
            record.usedBy.push({
              key,
              testFilePath: relative,
              testFileId: testFile?.id || null,
              caseId: caseItem?.id || null,
              caseName: caseItem?.name || null,
            });
          }
        }
      }
    };
    for (const caseItem of Array.isArray(testFile?.cases) ? testFile.cases : []) {
      visitCase(caseItem);
    }
    // Root setup/teardown, fixtures and macros use testids too.
    visitCase({ id: "__root__", name: "root setup/teardown", steps: [
      ...(testFile?.setup?.steps || []),
      ...(testFile?.teardown?.steps || []),
    ] });
  }
  return { usage, files: parsed };
}

// --- source 2 & 3: run history ------------------------------------------------

// Which routes runs actually reached, and which testids proved unstable. A
// testid that repeatedly fails to resolve is a contract that has drifted — and
// that fact only exists in Zhuzhu's history.
async function collectFromRunHistory(outputRunsRoot, { maxRuns = 200 } = {}) {
  const routes = new Map();
  const stability = new Map();
  if (!outputRunsRoot || !fsSync.existsSync(outputRunsRoot)) {
    return { routes, stability, scanned: 0 };
  }
  let dirs;
  try {
    dirs = (await fs.readdir(outputRunsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(-maxRuns);
  } catch (_error) {
    return { routes, stability, scanned: 0 };
  }
  let scanned = 0;
  for (const dir of dirs) {
    const summaryPath = path.join(outputRunsRoot, dir, "summary.json");
    let summary;
    try {
      summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    } catch (_error) {
      continue;
    }
    scanned += 1;
    const baseUrl = summary?.environmentFingerprint?.baseUrl || summary?.environmentFingerprint?.frontend?.url || null;
    if (baseUrl) {
      let route = baseUrl;
      try {
        route = new URL(baseUrl).pathname || baseUrl;
      } catch (_error) {
        route = baseUrl;
      }
      const record = routes.get(route) || { route, runs: 0, lastSeenAt: null, testFileIds: new Set() };
      record.runs += 1;
      record.lastSeenAt = Math.max(record.lastSeenAt || 0, summary.generatedAt || 0);
      if (summary.testContext?.testFileId) {
        record.testFileIds.add(summary.testContext.testFileId);
      }
      routes.set(route, record);
    }
    for (const step of summary?.steps || []) {
      const ids = extractTestIds(JSON.stringify(step ?? {}));
      const failedToResolve =
        step.status === "failed" &&
        /target-not-found|low-confidence-target|testid-never-rendered/.test(String(step.code || step.message || ""));
      for (const testId of ids) {
        const record = stability.get(testId) || { testId, seen: 0, notFound: 0 };
        record.seen += 1;
        if (failedToResolve) {
          record.notFound += 1;
        }
        stability.set(testId, record);
      }
    }
  }
  return { routes, stability, scanned };
}

// --- source 4 (optional): the front-end repo's exported inventory -------------

// Shape tolerated: either `{testIds: [...]}`, `{components: {Name: [ids]}}`, or a
// bare array. Deliberately permissive — the exporter lives in another repo and
// will change shape without telling us.
async function readFrontendInventory(inventoryPath) {
  if (!inventoryPath || !fsSync.existsSync(inventoryPath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
  } catch (_error) {
    return null;
  }
  const entries = new Map();
  const push = (testId, meta = {}) => {
    const key = String(testId || "").trim();
    if (!key) {
      return;
    }
    const record = entries.get(key) || { testId: key, components: new Set(), routes: new Set() };
    if (meta.component) {
      record.components.add(String(meta.component));
    }
    for (const route of meta.routes || []) {
      record.routes.add(String(route));
    }
    entries.set(key, record);
  };
  if (Array.isArray(parsed)) {
    parsed.forEach((item) =>
      typeof item === "string" ? push(item) : push(item?.testId, { component: item?.component, routes: item?.routes }),
    );
  } else if (Array.isArray(parsed?.testIds)) {
    parsed.testIds.forEach((item) =>
      typeof item === "string" ? push(item) : push(item?.testId, { component: item?.component, routes: item?.routes }),
    );
  } else if (parsed?.components && typeof parsed.components === "object") {
    for (const [component, ids] of Object.entries(parsed.components)) {
      for (const item of Array.isArray(ids) ? ids : []) {
        typeof item === "string" ? push(item, { component }) : push(item?.testId, { component, routes: item?.routes });
      }
    }
  } else {
    return null;
  }
  return { entries, source: inventoryPath };
}

// --- the merge ----------------------------------------------------------------

async function buildUiContract(options = {}) {
  const {
    testWorkflowsRoot = null,
    outputRunsRoot = null,
    frontendInventoryPath = null,
    maxRuns = 200,
  } = options;

  const [{ usage, files }, history, inventory] = await Promise.all([
    collectFromTestFiles(testWorkflowsRoot),
    collectFromRunHistory(outputRunsRoot, { maxRuns }),
    readFrontendInventory(frontendInventoryPath),
  ]);

  const allIds = new Set([
    ...usage.keys(),
    ...history.stability.keys(),
    ...(inventory ? inventory.entries.keys() : []),
  ]);

  const testIds = [...allIds].sort().map((testId) => {
    const used = usage.get(testId);
    const stable = history.stability.get(testId);
    const declared = inventory?.entries.get(testId) || null;
    return {
      testId,
      // "Which cases would break if this testid changed" — the change-impact answer.
      usedBy: used ? used.usedBy : [],
      caseCount: used ? used.usedBy.length : 0,
      actions: used ? [...used.actions].sort() : [],
      components: declared ? [...declared.components].sort() : [],
      routes: declared ? [...declared.routes].sort() : [],
      declaredByFrontend: Boolean(declared),
      stability: stable
        ? {
            seen: stable.seen,
            notFound: stable.notFound,
            // A testid that repeatedly fails to resolve is a drifted contract,
            // not a flaky test — and only run history knows this.
            unstable: stable.notFound > 0 && stable.notFound / stable.seen >= 0.2,
          }
        : null,
    };
  });

  // P-2: the coverage blind-spot map. Two kinds, reported separately because the
  // action differs: something the front-end declares that no case touches
  // (untested surface), and something a case references that the front-end does
  // not declare (a locator that may be about to break silently).
  const blindSpots = {
    declaredButNeverUsed: inventory
      ? testIds.filter((item) => item.declaredByFrontend && item.caseCount === 0).map((item) => item.testId)
      : [],
    usedButNotDeclared: inventory
      ? testIds.filter((item) => !item.declaredByFrontend && item.caseCount > 0).map((item) => item.testId)
      : [],
    unstable: testIds.filter((item) => item.stability?.unstable).map((item) => ({
      testId: item.testId,
      notFound: item.stability.notFound,
      seen: item.stability.seen,
    })),
  };

  return {
    contractVersion: 1,
    generatedAt: Date.now(),
    sources: {
      testFiles: { root: testWorkflowsRoot, parsed: files },
      runHistory: { root: outputRunsRoot, scanned: history.scanned, maxRuns },
      frontendInventory: inventory ? { path: inventory.source, testIds: inventory.entries.size } : null,
    },
    // Without a front-end inventory the graph still answers everything history
    // can answer; it says so rather than pretending the blind-spot map is complete.
    completeness: inventory
      ? "full"
      : "history-only: no front-end testid inventory was supplied, so `declaredButNeverUsed` cannot be computed — " +
        "point `frontendInventoryPath` at the export produced by the front-end repo's extract-ui-contract script",
    testIds,
    routes: [...history.routes.values()]
      .map((item) => ({
        route: item.route,
        runs: item.runs,
        lastSeenAt: item.lastSeenAt,
        testFileIds: [...item.testFileIds].sort(),
      }))
      .sort((a, b) => b.runs - a.runs),
    blindSpots,
    summary: {
      testIds: testIds.length,
      covered: testIds.filter((item) => item.caseCount > 0).length,
      routesReached: history.routes.size,
      unstable: blindSpots.unstable.length,
    },
  };
}

// P-1: "given a component name, list every entry point that uses it". Answered
// from the front-end inventory's component mapping plus the cases that touch its
// testids — which is what a cross-entry consistency facet needs to be written.
function findComponentEntries(contract, componentName) {
  const wanted = String(componentName || "").trim().toLowerCase();
  if (!wanted) {
    return { component: componentName, entries: [], testIds: [] };
  }
  const matched = (contract.testIds || []).filter(
    (item) =>
      item.components.some((component) => component.toLowerCase().includes(wanted)) ||
      item.testId.toLowerCase().includes(wanted),
  );
  const entries = [];
  for (const item of matched) {
    for (const usage of item.usedBy) {
      const key = `${usage.testFilePath}#${usage.caseId}`;
      if (!entries.some((entry) => entry.key === key)) {
        entries.push({ ...usage, testId: item.testId });
      }
    }
  }
  return {
    component: componentName,
    testIds: matched.map((item) => item.testId),
    entries,
    // The honest answer when a component is declared but untested.
    ...(matched.length && !entries.length
      ? { note: "该组件在前端清单里存在，但没有任何用例到达过它——这是覆盖盲区，不是「已覆盖且一致」。" }
      : {}),
  };
}

module.exports = {
  buildUiContract,
  collectFromRunHistory,
  collectFromTestFiles,
  extractTestIds,
  findComponentEntries,
  readFrontendInventory,
};
