"use strict";


const RUN_ID_LENGTH = 8;

function shortRunId(runId) {
  const text = String(runId || "").replace(/[^A-Za-z0-9]/g, "");
  return (text.slice(-RUN_ID_LENGTH) || "00000000").padStart(RUN_ID_LENGTH, "0");
}

// The prefix template may use `{{runId8}}`; anything else is taken literally.
// Kept deliberately simple: a prefix is a naming convention, not a DSL.
function resolveTenantPrefix(dataTenant = {}, runId = "") {
  const declared = String(dataTenant?.prefix ?? "").trim();
  const template = declared || "QA-{{runId8}}-";
  return template.replace(/\{\{\s*runId8\s*\}\}/g, shortRunId(runId));
}

function normalizeDataTenant(value, runId) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    prefix: resolveTenantPrefix(value, runId),
    // On by default: the whole point is that the report can say what was created.
    registerCreated: value.registerCreated !== false,
    // Entity kinds whose creation should be registered even when the step did not
    // say so explicitly (matched against the step id / title).
    entityHints: Array.isArray(value.entityHints) ? value.entityHints.map(String) : [],
  };
}

// --- created-entity registry -------------------------------------------------

// A registry entry is deliberately thin: {kind, identifier, stepId, createdAt}.
// Anything richer would need the engine to understand the product's domain model,
// which it must not.
class DataTenantRegistry {
  constructor({ prefix = "", runId = null } = {}) {
    this.prefix = prefix;
    this.runId = runId;
    this.created = [];
    this.cleaned = new Set();
    this.baselineBefore = null;
    this.baselineAfter = null;
  }

  // Called when a step reports having created something. Two sources feed this:
  // an explicit `registerCreated` on the step, and (as a convenience) any capture
  // whose value carries the tenant prefix — because a value that carries this
  // run's prefix can only have been created by this run.
  register({ kind = "entity", identifier, stepId = null, stepIndex = null, source = "declared" }) {
    const value = String(identifier ?? "").trim();
    if (!value) {
      return null;
    }
    const key = `${kind}::${value}`;
    if (this.created.some((item) => item.key === key)) {
      return null;
    }
    const entry = { key, kind, identifier: value, stepId, stepIndex, source, createdAt: Date.now() };
    this.created.push(entry);
    return entry;
  }

  // Scan a capture for the tenant prefix. Cheap, and it catches the common case
  // where the author captured the new record's name/id without also declaring it.
  registerFromCapture({ name, value, stepId = null, stepIndex = null }) {
    if (!this.prefix) {
      return null;
    }
    const text = String(value ?? "");
    if (!text.includes(this.prefix)) {
      return null;
    }
    return this.register({
      kind: String(name || "entity"),
      identifier: text,
      stepId,
      stepIndex,
      source: "capture",
    });
  }

  markCleaned(identifier) {
    const value = String(identifier ?? "").trim();
    if (!value) {
      return;
    }
    for (const entry of this.created) {
      if (entry.identifier === value || entry.identifier.includes(value)) {
        this.cleaned.add(entry.key);
      }
    }
  }

  snapshotBaseline(phase, snapshot) {
    if (phase === "before") {
      this.baselineBefore = snapshot;
    } else {
      this.baselineAfter = snapshot;
    }
  }

  getResidue() {
    return this.created.filter((entry) => !this.cleaned.has(entry.key));
  }

  getReport() {
    if (!this.created.length && !this.baselineBefore) {
      return null;
    }
    const residue = this.getResidue();
    return {
      prefix: this.prefix || null,
      created: this.created.map((entry) => ({
        kind: entry.kind,
        identifier: entry.identifier,
        stepId: entry.stepId,
        stepIndex: entry.stepIndex,
        source: entry.source,
        cleaned: this.cleaned.has(entry.key),
      })),
      createdCount: this.created.length,
      cleanedCount: this.created.length - residue.length,
      // The number the batch verdict carries. Not a failure — but not invisible.
      residueCount: residue.length,
      residue: residue.map((entry) => ({ kind: entry.kind, identifier: entry.identifier, stepId: entry.stepId })),
      ...(this.baselineBefore ? { baselineDrift: diffBaseline(this.baselineBefore, this.baselineAfter) } : {}),
    };
  }
}

// --- baselineGuard -----------------------------------------------------------

// Compare two snapshots of "records this round must not touch". A snapshot is a
// plain `{key: value}` map produced by the author's own steps (a capture, or a
// `callApi` result), so the engine needs no knowledge of the domain.
function diffBaseline(before, after) {
  if (!before) {
    return null;
  }
  if (!after) {
    return {
      checked: false,
      reason:
        "只取到了跑前快照，没取到跑后快照（teardown 没跑完 / 会话被取消）。因此**不能**断言预置数据没被改动——" +
        "这是「没测到」，不是「没变化」。",
      before,
    };
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes = [];
  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    const same = JSON.stringify(from ?? null) === JSON.stringify(to ?? null);
    if (!same) {
      changes.push({ key, before: from ?? null, after: to ?? null });
    }
  }
  return {
    checked: true,
    keys: keys.length,
    drifted: changes.length > 0,
    changes,
    ...(changes.length
      ? {
          // This is the sentence that was missing when nobody could say who
          // disabled the preset category.
          detail:
            `本轮改动了声明为「绝不该被改动」的预置数据：${changes
              .map((item) => `${item.key} ${JSON.stringify(item.before)} → ${JSON.stringify(item.after)}`)
              .join("；")}。`,
        }
      : {}),
  };
}

// --- the assertResidue evaluator ---------------------------------------------

// `assertResidue` is how an author says "by this point, everything I created must
// be gone". Usually placed in teardown. Fails closed without a registry: an
// unverifiable cleanliness claim reported as clean is worse than no claim.
async function evaluateResidueAssertion(spec = {}, context = {}) {
  const registry = context.dataTenant || null;
  if (!registry) {
    return {
      ok: false,
      type: "assertResidue",
      error: "data-tenant-unavailable",
      detail:
        "本次 run 没有造数租户登记表（文件未声明 settings.dataTenant），因此无法核对残留。" +
        "判失败而不是判通过——一个无法核实的「已清理干净」比不声称更糟。",
    };
  }
  const allowed = Number.isFinite(Number(spec.atMost)) ? Number(spec.atMost) : 0;
  const report = registry.getReport() || { residueCount: 0, residue: [], created: [] };
  const drift = report.baselineDrift || null;
  const driftFailed = spec.baselineGuard !== false && drift?.drifted === true;
  return {
    ok: report.residueCount <= allowed && !driftFailed,
    type: "assertResidue",
    expected: `residue <= ${allowed}`,
    actual: `residue = ${report.residueCount}`,
    prefix: report.prefix,
    created: report.created,
    residue: report.residue,
    ...(drift ? { baselineDrift: drift } : {}),
    ...(report.residueCount > allowed
      ? {
          error: `assertResidue:residue ${report.residueCount} > ${allowed}`,
          detail:
            `本轮创建但未清理：${report.residue.map((item) => item.identifier).join("、")}。` +
            "残留会把后续轮次顶穿（虚拟化下拉里目标项被顶出视口、计数断言基数漂移），请补 teardown。",
        }
      : {}),
    ...(driftFailed
      ? {
          error: "assertResidue:baseline-drift",
          detail: drift.detail,
        }
      : {}),
  };
}

module.exports = {
  DataTenantRegistry,
  diffBaseline,
  evaluateResidueAssertion,
  normalizeDataTenant,
  resolveTenantPrefix,
  shortRunId,
};
