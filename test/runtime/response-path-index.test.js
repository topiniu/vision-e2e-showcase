const test = require("node:test");
const assert = require("node:assert/strict");
const { assertResponseShape } = require("../../runtime/assertions");
const { normalizePayload } = require("../../runtime/protocol/normalize");

// REQ-Z14 (需求单v3): capture a *scalar* out of a list response.
// Before v1.3, `data.content[0].workflowId` was read as the literal key
// `content[0]` (-> null) and `data.content[].workflowId` produced `[1152]`,
// which a downstream callApi body then sent as a malformed array (-> HTTP 400).

const pageListBody = {
  code: 200,
  data: {
    total: 2,
    content: [
      { workflowId: 1152, taskNo: "SP-001", tags: ["a", "b"] },
      { workflowId: 1153, taskNo: "SP-002", tags: ["c"] },
    ],
  },
};

function capture(path, extra = {}) {
  const result = assertResponseShape(
    { status: 200, method: "POST", url: "/api/demo/pageList", body: pageListBody },
    { status: 200, body: [{ path, saveAs: "taskWfId", ...extra }] },
  );
  return result;
}

test("saveAs with an array index captures a scalar, not null and not an array (Z14-1)", () => {
  const result = capture("data.content[0].workflowId");
  assert.equal(result.ok, true);
  assert.equal(result.captures.length, 1);
  assert.equal(result.captures[0].value, 1152);
  assert.equal(typeof result.captures[0].value, "number");
  assert.equal(Array.isArray(result.captures[0].value), false);
});

test("a non-zero index selects the right row", () => {
  assert.equal(capture("data.content[1].workflowId").captures[0].value, 1153);
});

test("an out-of-range index reports a missing capture instead of silently storing null", () => {
  const result = capture("data.content[9].workflowId");
  assert.equal(result.ok, false);
  assert.deepEqual(result.captures, []);
  assert.equal(result.failures[0].field, "body.data.content[9].workflowId");
  assert.equal(result.failures[0].operator, "exists");
});

test("the captured scalar is usable verbatim in a downstream callApi body (Z14-2)", () => {
  const captured = capture("data.content[0].workflowId").captures[0].value;
  // This is exactly what the `{{taskWfId}}` interpolation produces downstream.
  const body = JSON.parse(JSON.stringify({ workflowId: captured }));
  assert.equal(body.workflowId, 1152);
  assert.equal(JSON.stringify(body), '{"workflowId":1152}');
  // The old fan-out shape is what the backend rejected with 400.
  const legacy = capture("data.content[].workflowId").captures[0].value;
  assert.deepEqual(legacy, [1152, 1153]);
});

test("`first: true` collapses a fan-out path to a scalar (Z14 equivalent capability)", () => {
  const result = capture("data.content[].workflowId", { first: true });
  assert.equal(result.captures[0].value, 1152);
  // `saveAsScalar` is an accepted alias.
  assert.equal(capture("data.content[].workflowId", { saveAsScalar: true }).captures[0].value, 1152);
});

test("index accessors compose with nested keys and with each other", () => {
  const result = assertResponseShape(
    { status: 200, body: pageListBody },
    {
      body: [
        { path: "data.content[0].tags[1]", saveAs: "tag" },
        { path: "data.content[0].taskNo", expected: "SP-001" },
      ],
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.captures[0].value, "b");
});

test("index paths work as assertions too, not only as captures", () => {
  const pass = assertResponseShape(
    { status: 200, body: pageListBody },
    { body: [{ path: "data.content[0].workflowId", operator: "equals", expected: 1152 }] },
  );
  assert.equal(pass.ok, true);
  const fail = assertResponseShape(
    { status: 200, body: pageListBody },
    { body: [{ path: "data.content[0].workflowId", operator: "equals", expected: 9999 }] },
  );
  assert.equal(fail.ok, false);
  assert.equal(fail.failures[0].actual, 1152);
});

test("existing `[]` fan-out semantics are unchanged (no regression)", () => {
  const gaps = assertResponseShape(
    { status: 200, body: { data: { content: [{ id: 1 }, {}, { id: 3 }] } } },
    { body: [{ path: "data.content[].id", saveAs: "ids" }] },
  );
  // Positional (holes preserved) — exactly the pre-v1.3 shape for this path.
  assert.deepEqual(gaps.captures[0].value, [1, undefined, 3]);
  // And `first: true` still picks the first *defined* member out of it.
  const firstDefined = assertResponseShape(
    { status: 200, body: { data: { content: [{}, { id: 3 }] } } },
    { body: [{ path: "data.content[].id", saveAs: "ids", first: true }] },
  );
  assert.equal(firstDefined.captures[0].value, 3);
});

test("a `[]` applied directly to an array still drops null members (unchanged)", () => {
  const result = assertResponseShape(
    { status: 200, body: { rows: [{ tags: ["a"] }, { tags: null }, { tags: ["c"] }] } },
    { body: [{ path: "rows[].tags[]", saveAs: "tags" }] },
  );
  assert.deepEqual(result.captures[0].value, ["a", "c"]);
});

test("a top-level array body is addressable by index", () => {
  const result = assertResponseShape(
    { status: 200, body: [{ id: "a" }, { id: "b" }] },
    { body: [{ path: "[1].id", saveAs: "second" }] },
  );
  assert.equal(result.captures[0].value, "b");
});

test("the `first` switch survives payload normalization (not stripped as unknown)", () => {
  const { actions } = normalizePayload([
    {
      id: "probe",
      kind: "callApi",
      request: { method: "POST", url: "/api/demo/pageList" },
      expectation: {
        kind: "assertResponse",
        status: 200,
        body: [{ path: "data.content[].workflowId", saveAs: "taskWfId", first: true }],
      },
    },
  ]);
  assert.equal(actions[0].expectation.body[0].first, true);
  assert.equal(actions[0].expectation.body[0].path, "data.content[].workflowId");
});
