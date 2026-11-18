const test = require("node:test");
const assert = require("node:assert/strict");
const { compareTextValue } = require("../../runtime/assertions/index");

// Z08: before/after diff operators. `expected` is the earlier snapshot (captured
// via saveAs and interpolated in as {{savedVar}}); `actual` is the read-back value.

test("unchanged passes when the field kept its snapshot value (Z08 state-preservation)", () => {
  // e.g. after changing 款式条件, 已录尺寸 must remain "S,M,L".
  assert.equal(compareTextValue("S,M,L", "S,M,L", "unchanged"), true);
  assert.equal(compareTextValue("  S,M,L  ", "S,M,L", "unchanged"), true); // trimmed
  // Silent clear is caught: value no longer equals the snapshot.
  assert.equal(compareTextValue("", "S,M,L", "unchanged"), false);
  assert.equal(compareTextValue("S,M", "S,M,L", "unchanged"), false);
});

test("changed passes only when the value differs from the snapshot (Z08)", () => {
  assert.equal(compareTextValue("new", "old", "changed"), true);
  assert.equal(compareTextValue("same", "same", "changed"), false);
});

test("increased/decreased compare the numeric portion, ignoring labels (Z08)", () => {
  // "共 132 条" -> 132, "共 140 条" -> 140
  assert.equal(compareTextValue("共 140 条", "共 132 条", "increased"), true);
  assert.equal(compareTextValue("共 120 条", "共 132 条", "increased"), false);
  assert.equal(compareTextValue("共 120 条", "共 132 条", "decreased"), true);
  assert.equal(compareTextValue("￥98.50", "￥100.00", "decreased"), true);
});

test("numeric diff operators fail closed on non-numeric input (Z08)", () => {
  assert.equal(compareTextValue("abc", "123", "increased"), false);
  assert.equal(compareTextValue("123", "abc", "decreased"), false);
});

test("existing operators are unaffected by the new diff operators (Z08 regression)", () => {
  assert.equal(compareTextValue("hello world", "world", "contains"), true);
  assert.equal(compareTextValue("abc123", "\\d+", "matches"), true);
  assert.equal(compareTextValue("x", "", "exists"), true);
  assert.equal(compareTextValue("", "", "exists"), false);
  assert.equal(compareTextValue("5", "5", "equals"), true);
});
