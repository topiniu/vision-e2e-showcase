const test = require("node:test");
const assert = require("node:assert/strict");
const { assertResponseShape, compareTextValue, runExpectation } = require("../../runtime/assertions");
const {
  CANONICAL_OPERATORS,
  isSupportedAssertionOperator,
  normalizeAssertionOperator,
} = require("../../src/shared/assertion-operators");

// v1.10 Z28: assertions that used to report something other than what was written.

function bodyCheck(body, assertion) {
  return assertResponseShape({ status: 200, method: "POST", url: "/api/x", body }, { status: 200, body: [assertion] });
}

test("v1.10 Z28-2: notEquals means not-equal (the 2026-09-30 QA report: code=500 notEquals 100005 used to FAIL)", () => {
  assert.equal(bodyCheck({ code: 500 }, { path: "code", operator: "notEquals", expected: 100005 }).ok, true);
  assert.equal(bodyCheck({ code: 100005 }, { path: "code", operator: "notEquals", expected: 100005 }).ok, false);
  assert.equal(bodyCheck({ code: 500 }, { path: "code", operator: "!=", expected: "100005" }).ok, true, "interpolated string expected");
  assert.equal(bodyCheck({ code: 500 }, { path: "code", operator: "ne", expected: 100005 }).ok, true);
});

test("v1.10 Z28-2: an unknown operator fails loudly with unsupported-operator instead of acting as equals", () => {
  const result = bodyCheck({ code: 500 }, { path: "code", operator: "notEqualz", expected: 500 });
  assert.equal(result.ok, false, "a typo must not pass even when equals would have");
  assert.equal(result.failures[0].reason, "unsupported-operator");
  assert.match(result.failures[0].message, /notEqualz/);
  assert.equal(compareTextValue(500, 500, "bogus"), false);
});

test("v1.10 Z28-2: a JSON number and a numeric string compare as numbers; two strings never coerce", () => {
  assert.equal(compareTextValue(0, "0", "equals"), true, "totalRecords=0 vs interpolated \"0\"");
  assert.equal(compareTextValue(0, 0, "equals"), true);
  assert.equal(compareTextValue("0012", "12", "equals"), false, "identifiers stay strings");
  assert.equal(compareTextValue(30, "5", "greaterThan"), true, "30 > \"5\" numerically (text order would say false)");
  assert.equal(compareTextValue(true, "true", "equals"), true);
  assert.equal(bodyCheck({ data: { totalRecords: 0 } }, { path: "data.totalRecords", operator: "equals", expected: 0 }).ok, true);
  assert.equal(bodyCheck({ data: { totalRecords: 0 } }, { path: "data.totalRecords", operator: "equals", expected: "0" }).ok, true);
});

test("v1.10 Z28-2: exists / notExists are evaluated even without an expected value", () => {
  assert.equal(bodyCheck({ data: {} }, { path: "data.id", operator: "exists" }).ok, false, "used to be skipped -> green");
  assert.equal(bodyCheck({ data: { id: 7 } }, { path: "data.id", operator: "exists" }).ok, true);
  assert.equal(bodyCheck({ data: {} }, { path: "data.id", operator: "notExists" }).ok, true);
});

test("v1.10 Z28-2: a negative operator over a fan-out must hold for every member", () => {
  const rows = { list: [{ status: 1 }, { status: 5 }] };
  assert.equal(bodyCheck(rows, { path: "list[].status", operator: "notEquals", expected: 5 }).ok, false, "one row IS 5");
  assert.equal(bodyCheck(rows, { path: "list[].status", operator: "notEquals", expected: 9 }).ok, true);
  assert.equal(bodyCheck(rows, { path: "list[].status", operator: "equals", expected: 5 }).ok, true, "positive stays any-member");
});

test("v1.10 Z28-4: saveAs over an empty fan-out fails instead of capturing \"[]\"", () => {
  const result = bodyCheck({ data: { content: [] } }, { path: "data.content[].workflowId", saveAs: "wfId" });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, "capture-empty-array");
  assert.deepEqual(result.captures, []);
});

test("v1.10 Z28-2: expectCount / expectDom report an unsupported operator without polling", async () => {
  const page = {
    locator() {
      return {
        filter() { return this; },
        async evaluateAll() { return 3; },
        async count() { return 3; },
      };
    },
    async waitForTimeout() {},
  };
  const count = await runExpectation(page, { kind: "count", target: { locator: "li" }, count: 3, operator: "eqauls" });
  assert.equal(count.ok, false);
  assert.equal(count.error, "unsupported-operator");
  const startedAt = Date.now();
  const dom = await runExpectation(page, { kind: "expectDom", target: { testId: "x" }, property: "text", operator: "contians", expected: "a", timeoutMs: 3000 });
  assert.equal(dom.ok, false);
  assert.equal(dom.error, "unsupported-operator");
  assert.ok(Date.now() - startedAt < 1000, "did not spend the 3s timeout polling an impossible comparison");
});

test("v1.10 Z28-2: the operator vocabulary is closed and alias-aware", () => {
  assert.ok(CANONICAL_OPERATORS.includes("notEquals"));
  assert.ok(CANONICAL_OPERATORS.includes("notContains"));
  assert.equal(normalizeAssertionOperator(undefined), "equals");
  assert.equal(normalizeAssertionOperator(">="), "atLeast");
  assert.equal(isSupportedAssertionOperator("notEquals"), true);
  assert.equal(isSupportedAssertionOperator("notEqualz"), false);
});
