"use strict";


const fs = require("node:fs/promises");
const path = require("node:path");

const CHECKPOINT_FILE = "checkpoint.json";
const STORAGE_STATE_FILE = "checkpoint-storage-state.json";

// Persist a checkpoint under `dir`. `storageState` (Playwright storageState
// object) is written to its own file so a resume can hand it straight back to the
// browser context via `storageStatePath`. `runtimeVariables` is the snapshot of
// created-data ids the tail steps reference.
async function saveCheckpoint(dir, { atIndex, atStepId = null, runtimeVariables = {}, storageState = null } = {}) {
  if (!dir) {
    throw new Error("saveCheckpoint requires a directory");
  }
  if (!Number.isInteger(atIndex) || atIndex < 0) {
    throw new Error("saveCheckpoint requires a non-negative integer atIndex");
  }
  await fs.mkdir(dir, { recursive: true });
  let storageStatePath = null;
  if (storageState && typeof storageState === "object") {
    storageStatePath = path.join(dir, STORAGE_STATE_FILE);
    await fs.writeFile(storageStatePath, `${JSON.stringify(storageState, null, 2)}\n`, "utf8");
  }
  const record = {
    version: 1,
    atIndex,
    atStepId: atStepId || null,
    runtimeVariables: runtimeVariables && typeof runtimeVariables === "object" ? { ...runtimeVariables } : {},
    storageStatePath,
    savedAt: Date.now(),
  };
  const checkpointPath = path.join(dir, CHECKPOINT_FILE);
  await fs.writeFile(checkpointPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { checkpointPath, storageStatePath, record };
}

async function loadCheckpoint(dir) {
  if (!dir) {
    return null;
  }
  try {
    const raw = await fs.readFile(path.join(dir, CHECKPOINT_FILE), "utf8");
    const record = JSON.parse(raw);
    if (!record || !Number.isInteger(record.atIndex)) {
      return null;
    }
    return record;
  } catch (_error) {
    return null;
  }
}

// Z11-3: explicit invalidation so a stale checkpoint never leaks into another run.
async function clearCheckpoint(dir) {
  if (!dir) {
    return;
  }
  for (const name of [CHECKPOINT_FILE, STORAGE_STATE_FILE]) {
    try {
      await fs.rm(path.join(dir, name), { force: true });
    } catch (_error) {
      // best-effort cleanup
    }
  }
}

// Pure planning: given normalized actions + a loaded checkpoint, decide where to
// resume, which step ids to skip, and what runtime state / storage to restore.
// No checkpoint (or a malformed one) => start from the top, restore nothing.
function planResume(actions = [], checkpoint = null) {
  if (!checkpoint) {
    return { startIndex: 0, skippedStepIds: [], resumeRuntimeVariables: {}, storageStatePath: null };
  }
  const list = Array.isArray(actions) ? actions : [];
  // Prefer matching the checkpoint step by id (robust to added/removed steps
  // shifting indices); fall back to the stored index.
  let resumeAfterIndex = null;
  if (checkpoint.atStepId) {
    const match = list.find((action) => action && action.id === checkpoint.atStepId);
    if (match && Number.isInteger(Number(match.index))) {
      resumeAfterIndex = Number(match.index);
    }
  }
  if (resumeAfterIndex === null && Number.isInteger(checkpoint.atIndex)) {
    resumeAfterIndex = checkpoint.atIndex;
  }
  if (resumeAfterIndex === null) {
    return { startIndex: 0, skippedStepIds: [], resumeRuntimeVariables: {}, storageStatePath: null };
  }
  const startIndex = resumeAfterIndex + 1;
  const skippedStepIds = list
    .filter((action) => Number(action?.index) < startIndex)
    .map((action) => action?.id)
    .filter(Boolean);
  return {
    startIndex,
    skippedStepIds,
    resumeRuntimeVariables: checkpoint.runtimeVariables && typeof checkpoint.runtimeVariables === "object"
      ? { ...checkpoint.runtimeVariables }
      : {},
    storageStatePath: checkpoint.storageStatePath || null,
  };
}

// A caller-supplied checkpoint id is used as a directory name under the
// checkpoints root; keep it filesystem-safe and confined (no traversal).
function sanitizeCheckpointId(id) {
  const raw = String(id == null ? "" : id).trim();
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return safe;
}

function resolveCheckpointDir(checkpointsRoot, checkpointId) {
  const safe = sanitizeCheckpointId(checkpointId);
  if (!safe) {
    return null;
  }
  return path.join(checkpointsRoot, safe);
}

// List saved checkpoints under a root (each is a subdirectory with checkpoint.json).
async function listCheckpoints(checkpointsRoot) {
  let entries;
  try {
    entries = await fs.readdir(checkpointsRoot, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const record = await loadCheckpoint(path.join(checkpointsRoot, entry.name));
    if (record) {
      out.push({
        id: entry.name,
        atIndex: record.atIndex,
        atStepId: record.atStepId || null,
        savedAt: record.savedAt || null,
        hasStorageState: Boolean(record.storageStatePath),
        runtimeVariableKeys: Object.keys(record.runtimeVariables || {}),
      });
    }
  }
  return out;
}

module.exports = {
  CHECKPOINT_FILE,
  STORAGE_STATE_FILE,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  planResume,
  sanitizeCheckpointId,
  resolveCheckpointDir,
  listCheckpoints,
};
