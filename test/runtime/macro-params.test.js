const test = require("node:test");
const assert = require("node:assert/strict");
const { buildExecutableCaseSteps, normalizeTestFile } = require("../../src/shared/test-file");

test("a parameterized macro is reused with different params per invocation (Z06-1)", () => {
  const file = normalizeTestFile({
    name: "Parameterized macro",
    macros: {
      createTask: {
        steps: [
          { id: "fill-title", type: "fill", target: { placeholder: "标题" }, value: "{{param.title}}" },
          { id: "fill-qty", type: "fill", target: { placeholder: "数量" }, value: "{{param.qty}}" },
          { id: "note", type: "fill", target: { placeholder: "备注" }, value: "环节-{{param.stage}}" },
        ],
      },
    },
    cases: [
      {
        id: "case-seed",
        name: "Seed data",
        steps: [
          { id: "seed-1", type: "useMacro", macro: "createTask", params: { title: "A", qty: 3, stage: "打样" } },
          { id: "seed-2", type: "useMacro", macro: "createTask", params: { title: "B", qty: 7, stage: "核价" } },
        ],
      },
    ],
  });

  const steps = buildExecutableCaseSteps(file, "case-seed");
  const values = steps.filter((s) => s.type === "fill").map((s) => s.value);
  // First invocation
  assert.equal(values[0], "A");
  assert.equal(values[1], 3); // whole-token preserves the numeric type
  assert.equal(values[2], "环节-打样");
  // Second invocation reuses the SAME macro definition with different params
  assert.equal(values[3], "B");
  assert.equal(values[4], 7);
  assert.equal(values[5], "环节-核价");
});

test("unfilled param tokens are left intact; `with`/`args` aliases work (Z06-1)", () => {
  const file = normalizeTestFile({
    name: "Alias params",
    macros: {
      openBoard: {
        steps: [{ id: "open", type: "openUrl", url: "http://x/{{param.board}}?f={{param.missing}}" }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        steps: [
          { id: "u1", type: "useMacro", macro: "openBoard", with: { board: "pricing" } },
        ],
      },
    ],
  });
  const steps = buildExecutableCaseSteps(file, "case-a");
  const open = steps.find((s) => s.type === "openUrl");
  // known param substituted, unknown token preserved verbatim
  assert.equal(open.url, "http://x/pricing?f={{param.missing}}");
});

test("param values may carry runtime {{var}} templates for later interpolation (Z06-2 saveAs handoff)", () => {
  const file = normalizeTestFile({
    name: "Param carries runtime var",
    macros: {
      cleanup: {
        steps: [{ id: "del", type: "callApi", request: { method: "DELETE", url: "/api/task/{{param.id}}" } }],
      },
    },
    cases: [
      {
        id: "case-a",
        name: "A",
        steps: [
          // {{createdTaskId}} is a run-time var (e.g. saved via saveAs earlier); it
          // must survive macro expansion untouched so run-time interpolation resolves it.
          { id: "teardown-del", type: "useMacro", macro: "cleanup", params: { id: "{{createdTaskId}}" } },
        ],
      },
    ],
  });
  const steps = buildExecutableCaseSteps(file, "case-a");
  const del = steps.find((s) => s.type === "callApi");
  assert.equal(del.request.url, "/api/task/{{createdTaskId}}");
});

test("macros without params still expand exactly as before (Z06 backward compat)", () => {
  const file = normalizeTestFile({
    name: "No params",
    macros: { m: { steps: [{ id: "s", type: "click", target: { text: "Go" } }] } },
    cases: [{ id: "c", name: "C", steps: [{ id: "u", type: "useMacro", macro: "m" }] }],
  });
  const steps = buildExecutableCaseSteps(file, "c");
  const click = steps.find((s) => s.type === "click");
  assert.equal(click.target.text, "Go");
});
