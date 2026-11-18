const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRuntimeVariables,
  interpolateRuntimeTemplates,
} = require("../../runtime/protocol/runtime-vars");

test("runtime variables interpolate nested action strings with stable values", () => {
  const variables = createRuntimeVariables({
    runId: "run-123",
    now: new Date(2026, 5, 8, 14, 30, 22, 123),
  });
  const payload = interpolateRuntimeTemplates(
    [
      {
        type: "fill",
        target: {
          placeholder: "请输入打样需求描述",
          value: "自动化测试-{{$timestamp}}-{{$runId}}",
        },
      },
      {
        type: "assertVisible",
        target: {
          text: "自动化测试-{{$timestamp}}-{{$runId}}",
          scope: {
            testId: "demo-workflow-table",
          },
        },
      },
    ],
    variables,
  );

  assert.equal(variables.timestamp, "20260608-143022");
  assert.equal(variables.runId, "run-123");
  assert.equal(payload[0].target.value, "自动化测试-20260608-143022-run-123");
  assert.equal(payload[1].target.text, "自动化测试-20260608-143022-run-123");
  assert.equal(payload[1].target.scope.testId, "demo-workflow-table");
});

test("runtime variable interpolation leaves unknown placeholders untouched", () => {
  const payload = interpolateRuntimeTemplates(
    {
      type: "fill",
      value: "自动化测试-{{$unknown}}-{{$runId}}",
    },
    { runId: "run-abc" },
  );

  assert.equal(payload.value, "自动化测试-{{$unknown}}-run-abc");
});

test("custom vars can reference built-ins and use bare placeholder syntax", () => {
  const variables = createRuntimeVariables({
    runId: "run-123",
    now: new Date(2026, 5, 8, 14, 30, 22, 123),
    overrides: {
      caseToken: "自动化测试·复版历史·{{$timestamp}}",
    },
  });
  const payload = interpolateRuntimeTemplates(
    {
      type: "fill",
      target: {
        value: "{{caseToken}} / {{$caseToken}}",
      },
      expectation: {
        kind: "text-exists",
        text: ["{{caseToken}}"],
      },
    },
    variables,
  );

  assert.equal(variables.caseToken, "自动化测试·复版历史·20260608-143022");
  assert.equal(payload.target.value, "自动化测试·复版历史·20260608-143022 / 自动化测试·复版历史·20260608-143022");
  assert.deepEqual(payload.expectation.text, ["自动化测试·复版历史·20260608-143022"]);
});
