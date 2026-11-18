function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

function formatRuntimeTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function isValidRuntimeVariableName(key) {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(String(key || ""));
}

// v1.10 Z27: names supplied by the run target, never by a capture —
// `origin.<name>` (environment base addresses) and `credential.<field>`
// (the selected test account). Kept in their own namespace so a `saveAs`
// can never overwrite an origin or a password.
const RUN_TARGET_NAMESPACES = ["origin", "credential"];

function isRunTargetVariableName(key) {
  const match = /^([A-Za-z]+)\.([A-Za-z][A-Za-z0-9_-]*)$/.exec(String(key || ""));
  return Boolean(match) && RUN_TARGET_NAMESPACES.includes(match[1]);
}

function isAcceptedRuntimeVariableName(key) {
  return isValidRuntimeVariableName(key) || isRunTargetVariableName(key);
}

function stringifyRuntimeVariableValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function createRuntimeVariables({ runId, now = new Date(), overrides = {} } = {}) {
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const variables = {
    timestamp: formatRuntimeTimestamp(date),
    timestampMs: String(date.getTime()),
    isoTimestamp: date.toISOString(),
    runId: runId == null ? "" : String(runId),
  };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (isAcceptedRuntimeVariableName(key)) {
      variables[key] = stringifyRuntimeVariableValue(value);
    }
  }
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const [key, value] of Object.entries(variables)) {
      const nextValue = interpolateString(value, variables);
      if (nextValue !== value) {
        variables[key] = nextValue;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return variables;
}

function createRuntimeVariableSources({ overrides = {}, sources = {} } = {}) {
  const nextSources = {
    timestamp: "builtin",
    timestampMs: "builtin",
    isoTimestamp: "builtin",
    runId: "builtin",
  };
  for (const key of Object.keys(overrides || {})) {
    if (isAcceptedRuntimeVariableName(key)) {
      nextSources[key] = "override";
    }
  }
  for (const [key, source] of Object.entries(sources || {})) {
    if (isAcceptedRuntimeVariableName(key) && source) {
      nextSources[key] = String(source);
    }
  }
  return nextSources;
}

function setRuntimeVariable(variables, sources, key, value, source = "capture") {
  if (!isValidRuntimeVariableName(key)) {
    const error = new Error(`Invalid runtime variable name: ${key}`);
    error.code = "invalid-runtime-variable-name";
    error.variableName = key;
    throw error;
  }
  variables[key] = stringifyRuntimeVariableValue(value);
  if (sources && typeof sources === "object") {
    sources[key] = source;
  }
  return variables[key];
}

function interpolateString(value, variables = {}) {
  if (typeof value !== "string" || !value.includes("{{")) {
    return value;
  }
  // v1.10 Z27: one optional dotted segment (`origin.app`). An unresolved name
  // is left verbatim, as before — e.g. a macro's `{{param.x}}` is expanded at
  // normalize time and never reaches here unresolved by design.
  return value.replace(/\{\{\s*\$?([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)?)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match,
  );
}

function interpolateRuntimeTemplates(value, variables = {}) {
  if (typeof value === "string") {
    return interpolateString(value, variables);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateRuntimeTemplates(item, variables));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, interpolateRuntimeTemplates(item, variables)]),
  );
}

module.exports = {
  createRuntimeVariables,
  createRuntimeVariableSources,
  formatRuntimeTimestamp,
  interpolateRuntimeTemplates,
  isAcceptedRuntimeVariableName,
  isRunTargetVariableName,
  isValidRuntimeVariableName,
  setRuntimeVariable,
  stringifyRuntimeVariableValue,
};
