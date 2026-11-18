"use strict";


const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const {
  collectAuthDomains,
  evaluateAuthFreshness,
  getAuthProfilePath,
  normalizeProfileName,
  normalizeStorageState,
} = require("./auth-profile");

const CREDENTIALS_FILE = ".zhuzhu-credentials.json";
// Variable names whose values must never reach a report, a trace, or an audit
// line. Matched case-insensitively against the credential's field names.
const SECRET_FIELD_PATTERN = /pass|secret|token|otp|pin|credential/i;

function credentialsPath(workspaceRoot) {
  return path.join(workspaceRoot || process.cwd(), CREDENTIALS_FILE);
}

// The store is a flat `{ name: {username, password, ...} }` map. Deliberately
// dumb: a credential store with features is a credential store with bugs, and
// this one only has to keep secrets out of test files.
async function readCredentialStore(workspaceRoot) {
  const file = credentialsPath(workspaceRoot);
  if (!fsSync.existsSync(file)) {
    return {};
  }
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function describeCredentialFields(entry = {}) {
  // Field NAMES only — never values. This is what a report may show.
  return Object.keys(entry).map((key) => ({
    field: key,
    secret: SECRET_FIELD_PATTERN.test(key),
  }));
}

function toRuntimeVariables(entry = {}) {
  const variables = {};
  const secretNames = [];
  for (const [key, value] of Object.entries(entry)) {
    // Runtime variable names must match ^[A-Za-z][A-Za-z0-9_-]*$.
    const name = String(key).replace(/[^A-Za-z0-9_-]/g, "");
    if (!name || !/^[A-Za-z]/.test(name)) {
      continue;
    }
    variables[name] = value == null ? "" : String(value);
    if (SECRET_FIELD_PATTERN.test(key)) {
      secretNames.push(name);
    }
  }
  return { variables, secretNames };
}

function redactVariables(variables = {}, secretNames = []) {
  const redacted = {};
  for (const [key, value] of Object.entries(variables)) {
    redacted[key] = secretNames.includes(key) ? "[redacted]" : value;
  }
  return redacted;
}

/**
 * Run a login flow in a fresh browser context and save the resulting
 * storageState as a named profile.
 *
 * @param {object} params
 * @param {string} params.profile        target profile name
 * @param {string} params.credentialRef  key into the workspace credential store
 * @param {Array}  params.loginSteps     login steps; falls back to testFile.recovery.login.steps
 * @param {object} params.testFile       optional file whose recovery.login is reused
 * @param {string} params.baseUrl        where the login flow starts
 */
async function bootstrapAuthProfile(params = {}, deps = {}) {
  const {
    profile,
    credentialRef = null,
    loginSteps = null,
    testFile = null,
    baseUrl = null,
    force = false,
  } = params;
  const { runImpl, launchBrowser, outputRoot, workspaceRoot, outputRunsRoot, browserContext = null } = deps;

  const safeProfile = normalizeProfileName(profile);
  if (!safeProfile) {
    return {
      ok: false,
      error: { code: "invalid-profile", message: "profile must contain only letters, numbers, dot, underscore or dash." },
    };
  }
  const steps = Array.isArray(loginSteps) && loginSteps.length
    ? loginSteps
    : Array.isArray(testFile?.recovery?.login?.steps) && testFile.recovery.login.steps.length
      ? testFile.recovery.login.steps
      : null;
  if (!steps) {
    return {
      ok: false,
      profile: safeProfile,
      error: {
        code: "login-steps-missing",
        message:
          "No login steps were provided and the test file declares no recovery.login. " +
          "Pass `loginSteps`, or point at a file that declares its login recovery — this endpoint " +
          "deliberately has no built-in idea of how your app logs in.",
      },
    };
  }
  const resolvedBaseUrl = baseUrl || testFile?.baseUrl || null;
  if (!resolvedBaseUrl) {
    return {
      ok: false,
      profile: safeProfile,
      error: { code: "base-url-missing", message: "baseUrl is required (or provide a test file that declares one)." },
    };
  }

  const storageStatePath = getAuthProfilePath(safeProfile, { outputRoot });
  if (!force && fsSync.existsSync(storageStatePath)) {
    // Refuse rather than silently overwrite: a profile is a credential, and
    // clobbering the one an in-flight batch is using is a very confusing failure.
    const existing = normalizeStorageState(JSON.parse(await fs.readFile(storageStatePath, "utf8")));
    return {
      ok: false,
      profile: safeProfile,
      storageStatePath,
      existing: { cookieCount: existing?.cookies.length ?? 0, hosts: collectAuthDomains(existing) },
      error: {
        code: "profile-exists",
        message: `Auth profile "${safeProfile}" already exists. Pass force:true to replace it.`,
      },
    };
  }

  let variables = {};
  let secretNames = [];
  let credentialFields = [];
  if (credentialRef) {
    const store = await readCredentialStore(workspaceRoot);
    const entry = store[credentialRef];
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        profile: safeProfile,
        error: {
          code: "credential-not-found",
          message:
            `No credential named "${credentialRef}" in ${CREDENTIALS_FILE}. ` +
            "Credentials are referenced by name so they never appear in a test file or a report.",
        },
      };
    }
    ({ variables, secretNames } = toRuntimeVariables(entry));
    // v1.10 Z27: a session run exposes the account as `{{credential.<field>}}`;
    // offer the same names here so ONE `recovery.login` serves both the
    // bootstrap and the run. The bare names stay for files written before.
    for (const [name, value] of Object.entries({ ...variables })) {
      variables[`credential.${name}`] = value;
    }
    credentialFields = describeCredentialFields(entry);
  }

  const runId = `auth-bootstrap-${safeProfile}-${Date.now()}`;
  let browser = null;
  let context = null;
  try {
    browser = await launchBrowser({ headless: true, launchOptions: browserContext?.launchOptions || null });
    context = await browser.newContext({ ignoreHTTPSErrors: true, ...(browserContext?.contextOptions || {}) });
    const page = await context.newPage();
    const result = await runImpl(steps, {
      page,
      context,
      browser,
      runId,
      url: resolvedBaseUrl,
      outputDir: outputRunsRoot,
      runtimeVariables: variables,
      // v1.10 Z27-5: the header promise ("never reach a report or a trace") was
      // only kept for THIS function's response — the bootstrap run's own
      // summary.json/report.json used to carry the password verbatim.
      secretValues: secretNames.map((name) => variables[name]).filter(Boolean),
      evidenceProfile: "fast",
      // The login page throwing IS a finding, but it must not stop us from
      // reporting the actual outcome of the bootstrap, so the gate is advisory here.
      pageErrorPolicy: "warn",
      testContext: { caseId: null, caseName: `auth-bootstrap:${safeProfile}` },
      runContext: { triggerSurface: "auth-bootstrap", profile: safeProfile },
    });

    const storageState = await context.storageState();
    const normalized = normalizeStorageState(storageState);
    const freshness = evaluateAuthFreshness(normalized, {});
    if (!freshness.evidence) {
      // The login steps "succeeded" but left no credential. Saving that profile
      // would produce a profile that fails at the first business step of every
      // case tonight — with a confusing error, far from here.
      return {
        ok: false,
        profile: safeProfile,
        error: {
          code: "auth-not-established",
          message:
            "The login flow ran but the browser context holds no credential afterwards, so this would be an " +
            "empty profile. Not saved. Check the login steps against the run report.",
        },
        loginRunOk: result?.ok ?? null,
        evidence: result?.evidence?.reportPath ? { reportPath: result.evidence.reportPath } : null,
        runtimeVariables: redactVariables(variables, [...secretNames, ...secretNames.map((name) => `credential.${name}`)]),
      };
    }

    await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
    await fs.writeFile(storageStatePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

    return {
      ok: true,
      profile: safeProfile,
      status: "ready",
      storageStatePath,
      // F-1/F-4: what this identity can reach, so a permission matrix can be read.
      coveredHosts: collectAuthDomains(normalized),
      cookieCount: normalized.cookies.length,
      originCount: normalized.origins.length,
      expiresAt: freshness.earliestCookieExpiry ?? null,
      expiresInMs: freshness.expiresInMs ?? null,
      staleness: freshness.staleness ?? null,
      // F-3: field NAMES only. The credential itself never appears in a response,
      // a report, or an audit line.
      credential: credentialRef ? { ref: credentialRef, fields: credentialFields } : null,
      loginRunOk: result?.ok ?? null,
      evidence: result?.evidence?.reportPath ? { reportPath: result.evidence.reportPath } : null,
    };
  } catch (error) {
    return {
      ok: false,
      profile: safeProfile,
      error: { code: "auth-bootstrap-failed", message: error?.message || String(error), retriable: true },
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

// --- authMatrix --------------------------------------------------------------

// A file may declare `settings.authMatrix: ["app-admin", "demo-limited"]`, meaning
// "run every case once per identity and give me the comparison". The session
// layer expands it; this helper just states the shape and builds the table.
function normalizeAuthMatrix(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((item) => (typeof item === "string" ? { profile: item.trim() } : { profile: String(item?.profile || "").trim(), label: item?.label }))
    .filter((item) => item.profile);
}

// F-4: the readable "who can see what" table. Built from per-identity case
// results, keyed by case, so the answer to "did the limited account lose the
// export entry" is one row rather than two reports to diff by hand.
function buildAuthMatrixTable(runsByProfile = []) {
  const caseIds = [...new Set(runsByProfile.flatMap((entry) => (entry.caseResults || []).map((item) => item.caseId)))];
  const rows = caseIds.map((caseId) => {
    const cells = runsByProfile.map((entry) => {
      const found = (entry.caseResults || []).find((item) => item.caseId === caseId);
      return {
        profile: entry.profile,
        verdict: found ? (found.result?.blocked ? "blocked" : found.result?.ok ? "green" : "red") : "not-run",
        firstFailureCode: found?.result?.error?.code ?? null,
      };
    });
    const verdicts = [...new Set(cells.map((cell) => cell.verdict))];
    return {
      caseId,
      cells,
      // "The identities disagree" is the interesting signal for a permission
      // matrix — it is usually the POINT (a limited account should fail the
      // export case), so it is reported, never auto-failed.
      differs: verdicts.length > 1,
    };
  });
  return {
    profiles: runsByProfile.map((entry) => entry.profile),
    rows,
    note:
      "身份之间结果不同通常正是权限矩阵想要的结果（受限账号本就该看不到导出入口），" +
      "因此这张表只呈现差异、不自动判失败；判定写在用例自己的断言里。",
  };
}

module.exports = {
  CREDENTIALS_FILE,
  bootstrapAuthProfile,
  buildAuthMatrixTable,
  credentialsPath,
  describeCredentialFields,
  normalizeAuthMatrix,
  readCredentialStore,
  redactVariables,
  toRuntimeVariables,
};
