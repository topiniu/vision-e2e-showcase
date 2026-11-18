"use strict";


const OPERATOR_ALIASES = {
  equals: ["equals", "eq", "=", "==", "equal", "is"],
  notEquals: ["notEquals", "ne", "!=", "<>", "notEqual", "not-equals", "neq"],
  greaterThan: ["greaterThan", "gt", ">"],
  atLeast: ["atLeast", "gte", ">="],
  lessThan: ["lessThan", "lt", "<"],
  atMost: ["atMost", "lte", "<="],
  contains: ["contains", "includes"],
  notContains: ["notContains", "not-contains", "excludes", "doesNotContain"],
  matches: ["matches", "regex"],
  exists: ["exists"],
  notExists: ["notExists", "not-exists"],
  changed: ["changed"],
  unchanged: ["unchanged"],
  increased: ["increased"],
  decreased: ["decreased"],
};

const CANONICAL_OPERATORS = Object.keys(OPERATOR_ALIASES);

const ALIAS_LOOKUP = new Map();
for (const [canonical, aliases] of Object.entries(OPERATOR_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_LOOKUP.set(alias.toLowerCase(), canonical);
  }
}

// Returns the canonical operator, `"equals"` when none was given, or `null` for
// an operator that does not exist.
function normalizeAssertionOperator(value) {
  if (value == null) {
    return "equals";
  }
  const text = String(value).trim();
  if (!text) {
    return "equals";
  }
  return ALIAS_LOOKUP.get(text.toLowerCase()) || null;
}

function isSupportedAssertionOperator(value) {
  return normalizeAssertionOperator(value) !== null;
}

module.exports = {
  CANONICAL_OPERATORS,
  OPERATOR_ALIASES,
  isSupportedAssertionOperator,
  normalizeAssertionOperator,
};
