
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  expandConsistencyGroup,
  hasConsistencyGroup,
  normalizeProbes,
  probeSlotName,
  rewriteCaptures,
} = require("../../src/shared/consistency-group");
const { expectConsistency } = require("../../runtime/assertions");
const { buildExecutableCaseSteps } = require("../../src/shared/test-file");

const GROUP = {
  id: "part-order",
  subject: "字段顺序",
  probes: [
    {
      name: "规则维护弹窗",
      capture: "partOrder",
      steps: [
        { id: "open-a", type: "openUrl", url: "/a" },
        { id: "read-a", type: "assertDom", target: { testId: "list" }, property: "text", saveAs: "partOrder" },
      ],
    },
    {
      name: "编辑字段表",
      capture: "partOrder",
      steps: [
        { id: "open-b", type: "openUrl", url: "/b" },
        { id: "read-b", type: "assertDom", target: { testId: "list" }, property: "text", saveAs: "partOrder" },
      ],
    },
  ],
  expectation: { allEqual: true },
};

test("slot names satisfy the runtime-variable naming rule", () => {
  // A slot that fails `^[A-Za-z][A-Za-z0-9_-]*$` makes setRuntimeVariable throw,
  // the probe captures nothing, and the comparison then finds four equal empty
  // strings and passes. So this is load-bearing, not cosmetic.
  const rule = /^[A-Za-z][A-Za-z0-9_-]*$/;
  assert.match(probeSlotName(0, "partOrder"), rule);
  assert.match(probeSlotName(3, "part.order-v2"), rule);
  assert.match(probeSlotName(1, ""), rule);
  assert.notEqual(probeSlotName(0, "x"), probeSlotName(1, "x"));
});

test("each probe's captures are routed to its own slot", () => {
  const rewritten = rewriteCaptures(GROUP.probes[1].steps[1], 1, "partOrder");
  assert.equal(rewritten.saveAs, probeSlotName(1, "partOrder"));
  // The original object is untouched (expansion must not mutate the test file).
  assert.equal(GROUP.probes[1].steps[1].saveAs, "partOrder");
});

test("captures nested in expectation / body / composite are rewritten too", () => {
  const step = {
    id: "s",
    type: "callApi",
    expectation: {
      kind: "composite",
      assertions: [{ kind: "assertResponse", body: [{ path: "data.order", saveAs: "partOrder" }] }],
      saveAs: "partOrder",
    },
    saveAs: "partOrder",
  };
  const rewritten = rewriteCaptures(step, 2, "partOrder");
  const slot = probeSlotName(2, "partOrder");
  assert.equal(rewritten.saveAs, slot);
  assert.equal(rewritten.expectation.saveAs, slot);
  assert.equal(rewritten.expectation.assertions[0].body[0].saveAs, slot);
});

test("a capture with a different name is left alone", () => {
  const rewritten = rewriteCaptures({ id: "s", saveAs: "somethingElse" }, 0, "partOrder");
  assert.equal(rewritten.saveAs, "somethingElse");
});

test("expansion emits every probe inline plus exactly one comparison step", () => {
  const steps = expandConsistencyGroup({ consistencyGroup: GROUP });
  assert.equal(steps.length, 5);
  assert.deepEqual(
    steps.map((step) => step.type),
    ["openUrl", "assertDom", "openUrl", "assertDom", "assertConsistency"],
  );
  // Each probe step is attributed, so the report can say which entry a failure
  // came from.
  assert.equal(steps[0].sourceProbe, "规则维护弹窗");
  assert.equal(steps[2].sourceProbe, "编辑字段表");
  const check = steps.at(-1);
  assert.equal(check.subject, "字段顺序");
  assert.deepEqual(
    check.expectation.probes.map((probe) => probe.slot),
    [probeSlotName(0, "partOrder"), probeSlotName(1, "partOrder")],
  );
});

test("hasConsistencyGroup only fires for a group with probes", () => {
  assert.equal(hasConsistencyGroup({ consistencyGroup: GROUP }), true);
  assert.equal(hasConsistencyGroup({ consistencyGroup: { probes: [] } }), false);
  assert.equal(hasConsistencyGroup({}), false);
  assert.equal(normalizeProbes({ probes: [{ name: "empty", steps: [] }] }).length, 0);
});

test("buildExecutableCaseSteps appends the expansion after the case's own steps", () => {
  const steps = buildExecutableCaseSteps(
    {
      id: "f",
      cases: [
        {
          id: "c1",
          name: "c1",
          steps: [{ id: "setup-data", type: "callApi", request: { url: "/seed" } }],
          consistencyGroup: GROUP,
        },
      ],
    },
    "c1",
    { includeRootSetup: false, includeRootTeardown: false },
  );
  // Shared setup first — it is what puts the data in place before every entry
  // point is probed.
  assert.equal(steps[0].id, "setup-data");
  assert.equal(steps.at(-1).type, "assertConsistency");
  assert.equal(steps.length, 6);
});

// --- comparison --------------------------------------------------------------

function expectationFor(probes, extra = {}) {
  return { kind: "assertConsistency", subject: "字段顺序", probes, ...extra };
}

test("all entries agreeing is a pass with the agreed value reported", async () => {
  const result = await expectConsistency(
    null,
    expectationFor([
      { name: "A", slot: "s0" },
      { name: "B", slot: "s1" },
    ]),
    { runtimeVariables: { s0: "标题 状态 负责人", s1: "标题  状态 负责人" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.entryCount, 2);
  // Whitespace differences between entry points are not the finding.
  assert.equal(result.actual, "标题 状态 负责人");
});

test("ORDER differences are never normalized away — that is the whole point", async () => {
  const result = await expectConsistency(
    null,
    expectationFor([
      { name: "A", slot: "s0" },
      { name: "B", slot: "s1" },
    ]),
    { runtimeVariables: { s0: "标题 状态 负责人", s1: "负责人 状态 标题" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.distinctValues, 2);
});

test("the matrix names the conflicting entries, not just 'they differ'", async () => {
  const result = await expectConsistency(
    null,
    expectationFor([
      { name: "规则维护弹窗", slot: "s0" },
      { name: "编辑字段表", slot: "s1" },
      { name: "查看字段表popover", slot: "s2" },
      { name: "导出文件", slot: "s3" },
    ]),
    {
      runtimeVariables: {
        s0: "标题,状态,负责人,新增",
        s1: "新增,标题,状态,负责人",
        s2: "标题,状态,负责人,新增",
        s3: "负责人,状态,标题,新增",
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.distinctValues, 3);
  assert.equal(result.matrix.length, 4);
  // Grouped by value, so "which entries agree with which" is readable.
  assert.deepEqual(
    result.groups.find((group) => group.value === "标题,状态,负责人,新增").entries,
    ["规则维护弹窗", "查看字段表popover"],
  );
  assert.equal(result.conflicts.length, 3);
  assert.match(result.error, /3 种取值/);
});

test("J-2: an unreached probe blocks instead of letting the rest 'agree'", async () => {
  const result = await expectConsistency(
    null,
    expectationFor([
      { name: "A", slot: "s0" },
      { name: "B", slot: "s1" },
      { name: "打不开的入口", slot: "s2" },
    ]),
    { runtimeVariables: { s0: "x", s1: "x" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.error, /consistency-probe-unreached/);
  assert.match(result.error, /打不开的入口/);
  assert.match(result.detail, /没测到/);
});

test("an explicitly optional probe may be absent without blocking", async () => {
  const result = await expectConsistency(
    null,
    expectationFor([
      { name: "A", slot: "s0" },
      { name: "B", slot: "s1" },
      { name: "仅特定状态可达", slot: "s2", optional: true },
    ]),
    { runtimeVariables: { s0: "x", s1: "x" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.entryCount, 2);
  assert.equal(result.matrix.find((item) => item.slot === "s2").reached, false);
});

test('normalize:"none" compares raw values verbatim', async () => {
  const probes = [
    { name: "A", slot: "s0" },
    { name: "B", slot: "s1" },
  ];
  const variables = { runtimeVariables: { s0: "a b", s1: "a  b" } };
  assert.equal((await expectConsistency(null, expectationFor(probes), variables)).ok, true);
  assert.equal(
    (await expectConsistency(null, expectationFor(probes, { normalize: "none" }), variables)).ok,
    false,
  );
});

test("a single reachable entry is not a consistency claim but does not crash", async () => {
  const result = await expectConsistency(null, expectationFor([{ name: "A", slot: "s0" }]), {
    runtimeVariables: { s0: "x" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.entryCount, 1);
});
