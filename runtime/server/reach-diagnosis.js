"use strict";


const { buildUiContract } = require("./ui-contract");

const REACH_CODES = new Set([
  "target-not-found",
  "target-scope-not-found",
  "scope-not-found",
  "low-confidence-target",
  "target-ambiguous",
  "testid-never-rendered",
]);

// The reach question only applies to a failure that could not find its element.
// A value assertion that DID find the element and compared wrong is not reach —
// blurring that is how "红了但其实没测到" happened in the first place.
function isReachClassFailure({ code = "", failureClass = null, expectation = null } = {}) {
  const text = String(code || "").trim();
  if (REACH_CODES.has(text) || text.includes("target-not-found") || text.includes("scope-not-found")) {
    return true;
  }
  if (failureClass === "reach") {
    return true;
  }
  // A DOM expectation whose actual value is empty/absent never compared anything:
  // it is a reach failure wearing an assertion's clothes.
  if (expectation && expectation.ok === false) {
    const actual = expectation.actual;
    const looksAbsent =
      actual == null ||
      actual === "" ||
      actual === false ||
      actual === 0 ||
      String(actual).toLowerCase() === "not found";
    return looksAbsent && String(expectation.property || "") === "exists";
  }
  return false;
}

// Every testid the failing step referenced. A step can name more than one (a
// scope plus a target), and any of them may be the one that drifted.
function readStepTestIds(step = {}) {
  const found = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if ((key === "testId" || key === "testid" || key === "dataTestId") && typeof item === "string" && item.trim()) {
        found.add(item.trim());
      } else if (item && typeof item === "object") {
        visit(item);
      } else if (typeof item === "string") {
        const match = /\[data-testid=\\?["']([^"'\\]+)\\?["']\]/.exec(item);
        if (match) {
          found.add(match[1]);
        }
      }
    }
  };
  visit(step.target || null);
  visit(step.scope || null);
  visit(step.originalStep || null);
  visit(step.expectation || null);
  return [...found];
}

// What "where should I be" looks like, read from the step's own declarations. The
// runtime does not invent a required tab: it reports what the case (or the
// contract) already says, and says nothing when neither does.
function readRequiredState(step = {}, originalStep = {}) {
  const source = originalStep && typeof originalStep === "object" ? originalStep : {};
  const declared = source.requires || source.preconditions || source.reach || null;
  const output = {};
  const pick = (keys, target) => {
    for (const key of keys) {
      const value = source[key] ?? declared?.[key];
      if (value != null && String(value).trim() !== "") {
        output[target] = value;
        return;
      }
    }
  };
  pick(["requiredBoard", "board"], "requiredBoard");
  pick(["requiredTab", "tab"], "requiredTab");
  if (declared?.statusFields && typeof declared.statusFields === "object") {
    output.requiredStatusFields = declared.statusFields;
  } else if (source.requiredStatusFields && typeof source.requiredStatusFields === "object") {
    output.requiredStatusFields = source.requiredStatusFields;
  }
  const authCodes = declared?.authCodes || source.requiredAuthCodes || source.authCodes;
  if (Array.isArray(authCodes) && authCodes.length) {
    output.requiredAuthCodes = authCodes.map((item) => String(item)).filter(Boolean);
  }
  return output;
}

function summarizeContractEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    testId: entry.testId,
    declaredByFrontend: Boolean(entry.declaredByFrontend),
    components: entry.components || [],
    routes: entry.routes || [],
    caseCount: entry.caseCount ?? 0,
    stability: entry.stability || null,
  };
}

/**
 * Decide `reach` vs `target-drift` for one failing step and explain the decision.
 *
 * @returns {object|null} `{ verdict, testidInContract, ... }`, or `null` when the
 *   failure is not reach-class at all. A reach-class failure the contract cannot
 *   answer returns an object whose `verdict` is `"unknown"` and whose `reason`
 *   says why — facet Z24-3 explicitly forbids guessing here.
 */
function buildReachDiagnosis({ step = {}, contract = null, currentUrl = null } = {}) {
  const failure = {
    code: step.code || step.error?.code || "",
    failureClass: step.failureClass || null,
    expectation: step.expectation || null,
  };
  if (!isReachClassFailure(failure)) {
    return null;
  }
  const testIds = readStepTestIds(step);
  if (!contract) {
    return {
      verdict: "unknown",
      testidInContract: null,
      testIds,
      reason:
        "没有可用的 UI 契约（GET /ui-contract 未构建或无前端 testid 清单），无法判断这是「状态没到」还是「testid 漂移」。" +
        "不猜——请先让前端仓导出 testid 清单（extract-ui-contract）并放到 workspace 的 ui-contract.json。",
      currentUrl: currentUrl || null,
    };
  }
  const byId = new Map((contract.testIds || []).map((item) => [item.testId, item]));
  const entries = testIds.map((testId) => byId.get(testId) || null);
  const knownEntries = entries.filter(Boolean);

  // No testid at all in the step (text/role-only target): the contract cannot
  // speak to it. Honest null rather than a guess.
  if (!testIds.length) {
    return {
      verdict: "unknown",
      testidInContract: null,
      testIds,
      reason:
        "该步骤没有用 testId 定位（文本/role 定位），UI 契约按 testId 建图，无法判断是状态没到还是定位漂移。" +
        "给这个元素补一个 data-testid 后本判定即可生效（见 docs/testid-contract.md）。",
      currentUrl: currentUrl || null,
    };
  }

  // The decisive question, and the only one the contract can answer with
  // authority: does the front-end still declare this testid?
  const declared = knownEntries.filter((item) => item.declaredByFrontend);
  const inventoryAvailable = Boolean(contract.sources?.frontendInventory);

  if (inventoryAvailable && !declared.length) {
    // 8% case: the front-end inventory does not have it -> the test is stale.
    return {
      verdict: "target-drift",
      testidInContract: false,
      testIds,
      contractEntries: knownEntries.map(summarizeContractEntry),
      reason: `前端 testid 清单里没有 ${testIds.join(" / ")}——这是真漂移（元素被改名或删除），不是状态没到。`,
      fix: `testid 不在契约里，改用例：把 ${testIds.join(" / ")} 换成前端现在实际输出的 testid（查 GET /ui-contract?component=…）。`,
      currentUrl: currentUrl || null,
    };
  }

  const unstable = knownEntries.filter((item) => item.stability?.unstable);
  if (unstable.length) {
    // History says this testid keeps failing to resolve. That is a drifting
    // contract, and only Zhuzhu's own run history knows it.
    return {
      verdict: "target-drift",
      testidInContract: inventoryAvailable ? true : null,
      testIds,
      contractEntries: knownEntries.map(summarizeContractEntry),
      reason:
        `${unstable.map((item) => `${item.testId}(${item.stability.notFound}/${item.stability.seen} 次定位失败)`).join("、")}` +
        " 在历史 run 里反复定位不到——按运行史判定为定位漂移，而不是单次状态没到。",
      fix: "先核对该 testid 是否还存在于前端产物（GET /ui-contract），确认漂移后改用例；若前端确认未改名，再按 reach 处理。",
      currentUrl: currentUrl || null,
    };
  }

  if (inventoryAvailable && declared.length) {
    // 92% case: the front-end DOES declare it, and history has not marked it
    // unstable -> the element exists, we were simply not where it lives.
    const routes = [...new Set(declared.flatMap((item) => item.routes || []))];
    const components = [...new Set(declared.flatMap((item) => item.components || []))];
    // Anything the CASE itself declared about its preconditions. Reported, never
    // invented: if the author wrote `requiredTab`, say it; if not, stay silent
    // rather than naming a tab we guessed from a route.
    const requiredState = readRequiredState(step, step.originalStep || step);
    return {
      verdict: "reach",
      testidInContract: true,
      testIds,
      contractEntries: declared.map(summarizeContractEntry),
      ...requiredState,
      ...(routes.length ? { declaredRoutes: routes } : {}),
      ...(components.length ? { declaredComponents: components } : {}),
      reason:
        `${testIds.join(" / ")} 在前端契约里存在且历史定位稳定，说明元素本身没问题——是当时的页面状态没到（tab/看板/前置数据）。`,
      fix:
        "先把状态造到位再点：" +
        (requiredState.requiredTab ? `该步骤声明需要 tab「${requiredState.requiredTab}」；` : "") +
        (requiredState.requiredBoard ? `需要看板「${requiredState.requiredBoard}」；` : "") +
        (routes.length ? `该元素声明在 ${routes.join(" / ")}；` : "") +
        (components.length ? `所属组件 ${components.join(" / ")}；` : "") +
        "补上前置动作（切 tab / 切看板 / 造出需要的记录），不要改 testid。",
      currentUrl: currentUrl || null,
    };
  }

  // No front-end inventory: history alone cannot distinguish the two. Say so.
  return {
    verdict: "unknown",
    testidInContract: null,
    testIds,
    contractEntries: knownEntries.map(summarizeContractEntry),
    reason:
      "UI 契约目前只有运行史、没有前端 testid 清单（contract.completeness = history-only），" +
      "因此无法区分「状态没到」与「testid 漂移」——不猜。让前端仓导出 testid 清单后本判定即可给出结论。",
    fix: "先人工看一眼失败步骤的 after 截图；同时补齐前端 testid 清单，之后这一判定就自动化了。",
    currentUrl: currentUrl || null,
  };
}

// Convenience wrapper for the session layer: build the contract once per round,
// then diagnose. `maxRuns` is bounded because the contract walks run history.
async function diagnoseReach({ step = {}, testWorkflowsRoot = null, outputRunsRoot = null, frontendInventoryPath = null, currentUrl = null, maxRuns = 80 } = {}) {
  let contract = null;
  try {
    contract = await buildUiContract({
      testWorkflowsRoot,
      outputRunsRoot,
      frontendInventoryPath,
      maxRuns,
    });
  } catch (_error) {
    contract = null;
  }
  return buildReachDiagnosis({ step, contract, currentUrl });
}

module.exports = {
  REACH_CODES,
  buildReachDiagnosis,
  diagnoseReach,
  isReachClassFailure,
  readStepTestIds,
  readRequiredState,
};
