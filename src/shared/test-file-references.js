const fs = require("node:fs");
const path = require("node:path");
const {
  isSafeRelativeTestFilePath,
  normalizeTestFile,
} = require("./test-file");

const DEFAULT_MAX_REF_DEPTH = 5;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function createReferenceError(code, message, refPath = "") {
  const error = new Error(message);
  error.code = code;
  error.refPath = refPath;
  return error;
}

function assertSafeReferencePath(refPath) {
  if (!isSafeRelativeTestFilePath(refPath)) {
    throw createReferenceError(
      "invalid-reference-path",
      `Reference path "${refPath || ""}" must be a safe relative JSON path under test-workflows/.`,
      refPath,
    );
  }
}

function resolveReferencePath(refPath, rootDir) {
  assertSafeReferencePath(refPath);
  const root = path.resolve(rootDir);
  const target = path.resolve(root, refPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw createReferenceError(
      "reference-outside-root",
      `Reference path "${refPath}" is outside test-workflows/.`,
      refPath,
    );
  }
  return target;
}

function readJsonFile(filePath, refPath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw createReferenceError(
      error?.code === "ENOENT" ? "reference-not-found" : "reference-read-failed",
      `Reference "${refPath}" could not be read: ${error?.message || String(error)}`,
      refPath,
    );
  }
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function hasNonEmptyStepGroup(source, key) {
  const value = source?.[key];
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Array.isArray(value?.steps) && value.steps.length > 0;
}

function mergeSettings(base, child) {
  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(child) ? child : {}),
  };
}

function mergeRequirement(base, child) {
  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(child) ? child : {}),
  };
}

function mergeTestFile(baseRaw, childRaw) {
  const base = isPlainObject(baseRaw) ? baseRaw : {};
  const child = isPlainObject(childRaw) ? childRaw : {};
  const merged = {
    ...clone(base),
    ...clone(child),
    vars: {
      ...(isPlainObject(base.vars) ? base.vars : {}),
      ...(isPlainObject(child.vars) ? child.vars : {}),
    },
    fixtures: {
      ...(isPlainObject(base.fixtures) ? base.fixtures : {}),
      ...(isPlainObject(child.fixtures) ? child.fixtures : {}),
    },
    macros: {
      ...(isPlainObject(base.macros) ? base.macros : {}),
      ...(isPlainObject(child.macros) ? child.macros : {}),
    },
    // Recovery handlers inherit like fixtures/macros: the shared base declares
    // e.g. `recovery.login` once and every extending file gets it (child keys
    // override base keys of the same name).
    recovery: {
      ...(isPlainObject(base.recovery) ? base.recovery : {}),
      ...(isPlainObject(child.recovery) ? child.recovery : {}),
    },
    requirement: mergeRequirement(base.requirement, child.requirement),
    settings: mergeSettings(base.settings, child.settings),
  };

  if (!hasNonEmptyStepGroup(child, "setup") && hasOwn(base, "setup")) {
    merged.setup = clone(base.setup);
  }
  if (!hasNonEmptyStepGroup(child, "teardown") && hasOwn(base, "teardown")) {
    merged.teardown = clone(base.teardown);
  }
  if (hasOwn(child, "cases")) {
    merged.cases = clone(child.cases);
  } else {
    delete merged.cases;
  }
  if (hasOwn(child, "extends")) {
    merged.extends = child.extends;
  }
  return merged;
}

function resolveLocalReferenceMap(map, { rootDir, stack, maxDepth, kind }) {
  if (!isPlainObject(map)) {
    return map;
  }
  const output = {};
  for (const [name, value] of Object.entries(map)) {
    if (isPlainObject(value) && typeof value.$ref === "string" && value.$ref.trim()) {
      const refPath = value.$ref.trim();
      const resolved = resolveReferenceValue(refPath, { rootDir, stack, maxDepth });
      if (!isPlainObject(resolved) || hasOwn(resolved, "cases") || hasOwn(resolved, "schemaVersion")) {
        throw createReferenceError(
          "invalid-local-reference",
          `${kind}.${name} $ref must point to a ${kind === "fixtures" ? "fixture" : "macro"} object, not a full test file.`,
          refPath,
        );
      }
      output[name] = resolved;
    } else {
      output[name] = value;
    }
  }
  return output;
}

function resolveReferenceValue(refPath, options) {
  const filePath = resolveReferencePath(refPath, options.rootDir);
  const normalizedPath = path.relative(path.resolve(options.rootDir), filePath).split(path.sep).join("/");
  if (options.stack.includes(normalizedPath)) {
    throw createReferenceError(
      "reference-cycle",
      `Reference cycle detected: ${[...options.stack, normalizedPath].join(" -> ")}.`,
      refPath,
    );
  }
  if (options.stack.length >= options.maxDepth) {
    throw createReferenceError(
      "reference-depth-exceeded",
      `Reference nesting exceeds ${options.maxDepth} levels.`,
      refPath,
    );
  }
  const raw = readJsonFile(filePath, refPath);
  return resolveTestFileReferences(raw, {
    ...options,
    sourcePath: normalizedPath,
    stack: [...options.stack, normalizedPath],
  });
}

function resolveTestFileReferences(raw, options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(process.cwd(), "test-workflows"));
  const maxDepth = options.maxDepth || DEFAULT_MAX_REF_DEPTH;
  const stack = Array.isArray(options.stack) ? options.stack : [];
  let source = clone(isPlainObject(raw) ? raw : {});

  if (typeof source.extends === "string" && source.extends.trim()) {
    const refPath = source.extends.trim();
    const base = resolveReferenceValue(refPath, { rootDir, stack, maxDepth });
    source = mergeTestFile(base, source);
  }

  source.fixtures = resolveLocalReferenceMap(source.fixtures, {
    rootDir,
    stack,
    maxDepth,
    kind: "fixtures",
  });
  source.macros = resolveLocalReferenceMap(source.macros, {
    rootDir,
    stack,
    maxDepth,
    kind: "macros",
  });
  return source;
}

function resolveAndNormalizeTestFile(raw, options = {}) {
  return normalizeTestFile(resolveTestFileReferences(raw, options));
}

module.exports = {
  DEFAULT_MAX_REF_DEPTH,
  resolveAndNormalizeTestFile,
  resolveTestFileReferences,
};
