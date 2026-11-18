"use strict";


const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const MCP_ROUTE = "/mcp";
const SERVER_NAME = "zhuzhu-e2e";

const INSTRUCTIONS = [
  "Zhuzhu (猪猪) E2E automation MCP server, hosted in-process by the desktop app.",
  "Typical loop: validate_test_file -> run_headless (cheap RED calibration) -> run_app (visible final verification) -> get_run_summary.",
  "For long test files, submit with run_headless({wait:false}) and poll get_run_summary(sessionId) until `terminal` is true; several such submits run concurrently and are fully isolated. If a blocking call times out it still returns partial:{sessionId, roundId} — use it. list_sessions({testFileId}) recovers a lost handle; never scan the output directory by file mtime.",
  "`testFilePath` is always relative to the workspace `test-workflows/` directory, with no leading prefix.",
  "Call get_integration_doc first to read the current protocol version, the absolute workspace paths, and the capability list. Do not hardcode host/port or workspace paths.",
].join(" ");

// The stable capability catalog surfaced by get_integration_doc so接入方 can
// discover, per protocol version, which tools exist without reading prose.
const TOOL_CATALOG = [
  { name: "get_integration_doc", summary: "Current protocol version + workspace absolute paths + capability list + raw integration docs.", readOnly: true },
  { name: "validate_test_file", summary: "Validate a test-file JSON (or path). MUST pass before submit/run. Returns errors[]/warnings[] separated.", readOnly: true },
  { name: "run_headless", summary: "Headless execution (cheap, for RED calibration / iteration). wait:false returns a {sessionId, roundId} handle immediately; blocking mode also returns that handle instead of timing out empty.", readOnly: false },
  { name: "run_app", summary: "Visible App-run (expensive, for final verification). Async by default: returns a runId; poll get_run_summary. Pass wait:true to block.", readOnly: false },
  { name: "get_run_summary", summary: "Read a run's result by runId — works for both App-run ids and headless session ids. Poll until `terminal` is true.", readOnly: true },
  // v1.3 (需求单v3 Z13/Z10)
  { name: "cancel_run", summary: "Force-abort a queued/running App-run OR a running headless session (the id picks the channel) and release its resources. Idempotent — the unattended way to clear a wedged run without restarting the app.", readOnly: false },
  { name: "run_app_batch", summary: "Run N test files in parallel, each in its own visible browser instance, at a configurable concurrency. Overflow waits in the pool.", readOnly: false },
  // v1.4 (需求单v4 Z15-5)
  { name: "list_sessions", summary: "List recent headless sessions, optionally filtered by testFileId — the supported way to find a session handle again instead of guessing the newest directory on disk.", readOnly: true },
  { name: "list_test_files", summary: "List test files under test-workflows/.", readOnly: true },
  { name: "read_test_file", summary: "Read one test file (testFilePath relative to test-workflows/, no prefix).", readOnly: true },
  { name: "write_test_file", summary: "Write/create a test file under test-workflows/ (mode: save | create).", readOnly: false },
  { name: "get_auth_status", summary: "Probe login/reachability. surface: profile (stored headless auth) | panel (live visible browser).", readOnly: true },
  // v1.5 (守航支撑第一期 Z-B / Z-D / Z-K / Z-L)
  { name: "preflight", summary: "Answer 'can this machine run unattended tonight?' in one call — channels, front-end reachability + build freshness, auth profile, orphan sessions, disk, recommended concurrency. Any `fail` means do not start.", readOnly: true },
  { name: "get_env_fingerprint", summary: "Read the build identity actually being served (frontend build id + backend commits) without running a test. Use before dispatch to confirm your change reached the browser.", readOnly: true },
  { name: "verify_evidence", summary: "Verify a case's signed evidence bundle: recompute hashes, check the signature, and return {verdict, failureClass, discriminativePower, redCalibrated}. This replaces judging a RED by step-title regex.", readOnly: true },
  { name: "get_report_card", summary: "Machine-generated raw material for a plain-language QA report: per-case what-was-done / what-was-checked / evidence paths / RED calibration / risks / not-covered items. Facts only — the prose is the caller's job.", readOnly: true },
  // v1.6 (人工债清零 Z-F / Z-P)
  { name: "bootstrap_auth_profile", summary: "Create a named auth profile by driving a real login headlessly, using credentials referenced BY NAME from the workspace credential store. This is what makes a permission matrix testable without a human logging in.", readOnly: false },
  { name: "get_ui_contract", summary: "The UI contract graph: which testid is used by which cases, which routes runs actually reached, which testids proved unstable, and the coverage blind-spot map. Answers 'which entries use this component' and 'what has never been reached'.", readOnly: true },
  // v1.9 (需求单v5 REQ-Z25)
  { name: "get_capabilities", summary: "The machine-verifiable capability catalog: per capability an id, a status (ga | beta | planned), the MCP tool name and the REAL HTTP method+path. Read this instead of guessing a path — a 404 on a guess is indistinguishable from 'not implemented', and that ambiguity has cost two weeks before.", readOnly: true },
];

// ---- result / error shaping -------------------------------------------------

function isFailurePayload(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      (data.ok === false || data.success === false || (data.error && typeof data.error === "object")),
  );
}

// Wrap a plain payload object into an MCP tool result. Every tool returns both a
// human/agent-readable text block (pretty JSON) and machine-readable
// structuredContent, so clients can consume either.
function toToolResult(data) {
  const structured =
    data && typeof data === "object" && !Array.isArray(data) ? data : { value: data };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
    isError: isFailurePayload(data),
  };
}

// Normalize any thrown error into the unified `{ ok, error:{code,message,retriable} }`口径.
function normalizeError(err) {
  const message = err?.message || String(err);
  const code = err?.code || "mcp-tool-error";
  const retriable =
    typeof err?.retriable === "boolean"
      ? err.retriable
      : /timeout|ETIMEDOUT|ECONN|EAI_AGAIN|temporarily|not ready|unavailable|busy|503/i.test(message);
  return { ok: false, error: { code, message, retriable } };
}

// Invoke an injected dep, guaranteeing a well-formed tool result even if the dep
// throws. Missing deps degrade gracefully to a structured error.
async function callDep(fn, args) {
  if (typeof fn !== "function") {
    return toToolResult({ ok: false, error: { code: "capability-unavailable", message: "This capability is not available on the current host.", retriable: false } });
  }
  try {
    return toToolResult(await fn(args || {}));
  } catch (err) {
    return toToolResult(normalizeError(err));
  }
}

// ---- server construction ----------------------------------------------------

// Build a fresh McpServer wired to the injected deps. Called once per request in
// stateless mode (cheap: just tool registration).
function buildMcpServer(deps = {}) {
  const server = new McpServer(
    { name: SERVER_NAME, version: deps.serverVersion || "0.0.0" },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  const roTool = (name, description, inputSchema, run) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: true } },
      run,
    );
  // v1.5 Z-M: write/execute tools pass through the privilege gate before doing
  // anything. Enforced here rather than at the HTTP transport because /mcp
  // carries both groups on one route — a transport-level decision would either
  // lock the lab out of read-only tools or leave `write_test_file` open.
  const rwTool = (name, description, inputSchema, run) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: false } },
      async (args, extra) => {
        if (typeof deps.authorizeWrite === "function") {
          const decision = await deps.authorizeWrite({ tool: name, args });
          if (!decision?.allowed) {
            return toToolResult({
              ok: false,
              error: {
                code: "unauthorized",
                message:
                  decision?.reason ||
                  "This tool changes the workspace or drives a browser and requires an API token.",
                retriable: false,
              },
            });
          }
        }
        return run(args, extra);
      },
    );

  // get_integration_doc — protocol version + workspace absolute paths + capabilities.
  roTool(
    "get_integration_doc",
    "Return the current protocol version, absolute workspace paths (workspaceRoot / test-workflows / test-assets / output), the capability list, and the raw integration documents. Call this first; never hardcode host/port or workspace paths.",
    {},
    () => callDep(deps.getIntegrationDoc, {}),
  );

  // validate_test_file — MUST pass before submit/run. errors[]/warnings[] separated.
  roTool(
    "validate_test_file",
    "Validate a test-file JSON. Provide either `testFile` (the full JSON object) or `testFilePath` (relative to test-workflows/). Returns separated errors[]/warnings[] with locations and human-readable reasons. Fix all errors before running.",
    {
      testFilePath: z.string().optional().describe("Path relative to test-workflows/, no prefix. Used when testFile is omitted."),
      testFile: z.any().optional().describe("Full test-file JSON object (schemaVersion 2). Takes precedence over testFilePath."),
      mode: z.enum(["advisory", "gate"]).optional().describe("advisory (default) reports; gate blocks on quality-gate failures."),
      strict: z.boolean().optional().describe("Force gate mode (equivalent to mode:'gate')."),
    },
    (args) => callDep(deps.validateTestFile, args),
  );

  // v1.10 Z27: the run target — where/as whom a file runs. Same shape on every
  // run tool; validated server-side (unknown origins / denied hosts are a 400).
  const runTargetSchema = z
    .object({
      origins: z.record(z.string(), z.string()).optional().describe("Base addresses by name, e.g. { app: \"http://198.51.100.5:8000\", web: \"http://198.51.100.5:8041\" }. A file refers to them as {{origin.<name>}}; every referenced name must be supplied (no fallback)."),
      authProfile: z.string().optional().describe("Headless auth profile (storageState) to run as."),
      credentialRef: z.string().optional().describe("Key in the workspace .zhuzhu-credentials.json; exposed to steps as {{credential.<field>}}, secret fields masked in all evidence."),
      vars: z.record(z.string(), z.any()).optional().describe("Variables overriding the file's vars for this run."),
      preflight: z.boolean().optional().describe("Probe every used origin before running (default true); an unreachable one blocks the session as target-unavailable."),
    })
    .optional()
    .describe("v1.10: which environment/account to run against. Required when the file uses {{origin.*}}.");
  const stepOcrSchema = z
    .enum(["onFailure", "always", "off"])
    .optional()
    .describe("After-step OCR evidence: onFailure (default — failed steps only), always (pre-v1.10 behaviour, slow), off.");

  // run_headless — cheap, for RED calibration / iteration. v1.4 REQ-Z15: three
  // submit modes (async / bounded-wait / blocking) and a handle in every reply.
  rwTool(
    "run_headless",
    [
      "Run a test file headless (its own headless Chromium, independent of the visible browser). Cheap — use for RED calibration and iterative debugging.",
      "Submit modes: `wait:false` returns `{sessionId, roundId, status:'running'}` in ~1s and the session keeps running in the background — use this for long data-gen chains and to fan several files out concurrently.",
      "Blocking mode (default) waits up to `waitTimeoutMs` and, if the session is still running, returns the SAME handle with `waitTimedOut:true` plus `partial:{sessionId, roundId}` instead of a bare timeout — a timeout never means zero information. Pass `waitTimeoutMs:0` to block indefinitely.",
      "Either way, poll `get_run_summary({runId: sessionId})` until `terminal` is true; `list_sessions({testFileId})` finds the handle again if you lose it. Concurrent sessions are isolated (one Chromium process per session), so `reuseBrowser` may stay true when running several at once.",
      "Provide `testFilePath` (preferred) or an inline `testFile`.",
    ].join(" "),
    {
      testFilePath: z.string().optional().describe("Path relative to test-workflows/, no prefix."),
      testFile: z.any().optional().describe("Inline full test-file JSON, if not reading from disk."),
      caseIds: z.array(z.string()).optional().describe("Restrict execution to these case ids; omit to run all cases."),
      scope: z.enum(["all", "selected"]).optional().describe("all (default) or selected (with caseIds)."),
      authProfile: z.string().optional().describe("Stored headless auth profile name to reuse a login."),
      qualityGate: z.any().optional().describe("Optional quality-gate config forwarded to the runner."),
      allowBlocked: z.boolean().optional().describe("Run even if precheck would block (advisory override)."),
      reuseBrowser: z
        .boolean()
        .optional()
        .describe(
          "Reuse one Chromium process across root setup/cases/teardown of THIS session (a fresh context per case is still created). Default true. Scoped to one session — it never shares a browser with another session, so leaving it true is safe when several sessions overlap.",
        ),
      checkpoint: z.any().optional().describe("Data-gen checkpoint save config."),
      resume: z.any().optional().describe("Data-gen checkpoint resume config."),
      // v1.4 REQ-Z15-1 / Z15-2.
      wait: z
        .boolean()
        .optional()
        .describe(
          "false = submit and return a {sessionId, roundId, status:'running'} handle immediately (~1s), then poll get_run_summary. Default true (block, bounded by waitTimeoutMs).",
        ),
      waitTimeoutMs: z
        .number()
        .optional()
        .describe(
          "How long blocking mode may wait before returning the handle with waitTimedOut:true (default 50000, i.e. under the usual 60s client timeout). 0 = block until the session finishes.",
        ),
      sessionTimeoutMs: z
        .number()
        .optional()
        .describe("Per-session wall-clock ceiling (ms). The session always terminates and always writes an aggregate."),
      target: runTargetSchema,
      stepOcr: stepOcrSchema,
    },
    (args) => callDep(deps.runHeadless, args),
  );

  // run_app — expensive visible run, async by default (returns runId).
  rwTool(
    "run_app",
    "Run a test file in the visible App-run browser (final verification, expensive). Async by default: enqueues the run and returns a runId immediately — poll get_run_summary(runId) until terminal. Pass wait:true to block and get the final summary on this call. Requires the desktop panel to be up.",
    {
      testFilePath: z.string().describe("Path relative to test-workflows/, no prefix (required)."),
      caseId: z.string().optional().describe("Run a single case by id (sets scope to selected)."),
      scope: z.enum(["all", "selected"]).optional().describe("all (default) or selected."),
      wait: z.boolean().optional().describe("Block until the run finishes and return the final summary. Default false (returns runId)."),
      target: runTargetSchema,
    },
    (args) => callDep(deps.runApp, args),
  );

  // get_run_summary — unified reader for App-run ids and headless session ids.
  roTool(
    "get_run_summary",
    "Read the result of a run by id. Accepts both App-run ids (from run_app) and headless session ids (from run_headless, including the `partial.sessionId` returned on a wait timeout). Returns status, passed/failed detail, firstFailure and evidence/report paths, plus `terminal` — poll until `terminal` is true. The terminal payload uses the same fields a blocking run_headless returns. Safe to poll repeatedly (idempotent).",
    {
      runId: z.string().describe("The run id or headless session id to read."),
    },
    (args) => callDep(deps.getRunSummary, args),
  );

  // list_sessions — v1.4 REQ-Z15-5: find a lost handle without touching the disk.
  roTool(
    "list_sessions",
    "List recent headless sessions, newest first, optionally filtered by `testFileId` / `testFilePath` / `status`. Use it to recover a session handle after a disconnect or a timeout — never guess the newest `session-*` directory by file mtime, which silently picks up a concurrent session belonging to someone else.",
    {
      testFileId: z.string().optional().describe("Only sessions for this test-file id."),
      testFilePath: z.string().optional().describe("Only sessions for this test-file path (relative to test-workflows/)."),
      status: z.string().optional().describe("Only sessions in this status (running | passed | failed | blocked | cancelled)."),
      limit: z.number().optional().describe("How many sessions to return (default 10, max 100)."),
    },
    (args) => callDep(deps.listSessions, args),
  );

  // cancel_run — v1.3 REQ-Z13. The unattended escape hatch: clear a wedged run
  // without restarting the desktop app (which would drop this very channel).
  rwTool(
    "cancel_run",
    "Force-abort a run and release its resources. The id picks the channel: an App-run id cancels the queued/running App-run and frees its queue slot; a headless `session-*` id aborts that session, closes its browser and drives it to the `cancelled` terminal status in bounded time. Idempotent: cancelling an already-finished or unknown run reports that instead of failing. Use this when a run has stopped producing progress, or to clear an old session left running after a client timeout — it avoids restarting the desktop app, which would drop this MCP channel and the panel login state.",
    {
      runId: z.string().describe("The App-run id (externalRunId) or headless session id to abort."),
      reason: z.string().optional().describe("Free-text reason recorded on the cancelled run."),
      graceMs: z
        .number()
        .optional()
        .describe("Headless only: how long to let the aborted session unwind before the session document is force-finalized to `cancelled` (default 20000)."),
    },
    (args) => callDep(deps.cancelRun, args),
  );

  // run_app_batch — v1.3 Z10: parallel multi-instance visible execution.
  rwTool(
    "run_app_batch",
    "Run several test files in parallel, each in its OWN visible browser instance, at a configurable concurrency (overflow waits in the pool, nothing is dropped). Unlike run_app this does not go through the panel's single resident browser, so it is not serialized and one wedged instance cannot block the others. Blocks until every item finishes and returns per-item session results.",
    {
      items: z
        .array(z.any())
        .describe("One entry per test file, e.g. { testFilePath, caseIds?, authProfile? }. Each becomes an independent session."),
      concurrency: z.number().optional().describe("How many visible instances run at once. Defaults to the host setting (2). Bounded by machine resources."),
      authProfile: z.string().optional().describe("Shared auth profile inherited by items that do not override it."),
      sessionTimeoutMs: z.number().optional().describe("Per-session wall-clock ceiling (ms). Each session always terminates and always writes an aggregate."),
      target: runTargetSchema,
      stepOcr: stepOcrSchema,
    },
    (args) => callDep(deps.runAppBatch, args),
  );

  // list_test_files
  roTool(
    "list_test_files",
    "List the test files available under the workspace test-workflows/ directory, with basic metadata (id, name, group, case count).",
    {},
    () => callDep(deps.listTestFiles, {}),
  );

  // read_test_file
  roTool(
    "read_test_file",
    "Read a single test file. `testFilePath` is relative to test-workflows/ with no prefix.",
    {
      testFilePath: z.string().describe("Path relative to test-workflows/, no prefix."),
    },
    (args) => callDep(deps.readTestFile, args),
  );

  // write_test_file
  rwTool(
    "write_test_file",
    "Write a test file into the workspace test-workflows/ directory. mode 'save' (default) overwrites/updates an existing path; mode 'create' writes a new file, auto-incrementing the name to avoid collisions. `testFile` is the full JSON object.",
    {
      testFilePath: z.string().optional().describe("Target path relative to test-workflows/, no prefix (required for save)."),
      testFile: z.any().describe("Full test-file JSON object to persist."),
      mode: z.enum(["save", "create"]).optional().describe("save (default) or create."),
    },
    (args) => callDep(deps.writeTestFile, args),
  );

  // get_auth_status
  roTool(
    "get_auth_status",
    "Probe login state / environment reachability. surface 'profile' (default) reports a stored headless auth profile's freshness; surface 'panel' reports the live visible browser's login state.",
    {
      surface: z.enum(["profile", "panel"]).optional().describe("profile (stored headless auth, default) or panel (live visible browser)."),
      profile: z.string().optional().describe("Auth profile name when surface is 'profile'."),
    },
    (args) => callDep(deps.getAuthStatus, args),
  );

  // --- v1.5 guarded-run support tools ---------------------------------------

  // preflight — Z-L. One call before an unattended night.
  roTool(
    "preflight",
    [
      "Answer 'can this machine be trusted to run unattended tonight?' before dispatching anything.",
      "Checks the visible + headless channels, the workspace (existence / writability / free disk), the front-end under test (reachable + build identity + optional freshness), configured backend health endpoints, the named auth profile's freshness, sessions left running from a previous dispatch, and the concurrency this host can actually sustain.",
      "Every check reports pass | warn | fail with a `fix`. ANY `fail` means do not start the batch — fix it first. `warn` means it will cost you time. Also returns `recommendedConcurrency` measured from this host's real CPU/RAM.",
    ].join(" "),
    {
      baseUrl: z.string().optional().describe("The front-end under test, so reachability + build identity are verified. Strongly recommended."),
      profile: z.string().optional().describe("Auth profile name whose freshness should be checked."),
      backendProbes: z
        .array(z.any())
        .optional()
        .describe("Backend health endpoints to probe, e.g. [{name:'supplier-service', url:'http://127.0.0.1:8040/actuator/info'}]."),
      freshness: z
        .any()
        .optional()
        .describe("Optional freshness rules, e.g. {maxAgeMinutes: 120} or {requireChangedSince: '<previous fingerprint>'}."),
    },
    (args) => callDep(deps.preflight, args),
  );

  // get_env_fingerprint — Z-B. "Did my change actually reach the browser?"
  roTool(
    "get_env_fingerprint",
    [
      "Read the build identity of the artifact actually being served, without running a test.",
      "Returns the frontend build id (from <meta name=\"build-id\"> / window.__BUILD_ID__ / hashed chunk names / the document's ETag, in that priority order), the commit of each configured backend health endpoint, and a single `compositeId` you can pass back later as `freshness.requireChangedSince`.",
      "Use it right after changing code: if the compositeId did not move, the browser is still running the old bundle (a dead dev-server watcher looks exactly like this) and any test result would be meaningless. Anything unreadable is reported as `unknown` WITH a reason, never omitted.",
    ].join(" "),
    {
      baseUrl: z.string().describe("The page to fingerprint (required)."),
      backendProbes: z.array(z.any()).optional().describe("Backend health endpoints, e.g. [{name, url}]."),
    },
    (args) => callDep(deps.getEnvFingerprint, args),
  );

  // verify_evidence — Z-D. Structural RED judgement, no title regex.
  roTool(
    "verify_evidence",
    [
      "Verify a case's signed evidence bundle and return its machine verdict.",
      "Recomputes the summary hash from the file on disk and re-checks the HMAC signature against this workspace's key, then returns {valid, reasons[], verdict: green|red|blocked, failureClass, discriminativePower, redCalibrated}.",
      "`redCalibrated` is exactly `verdict === 'red' && failureClass === 'value-assertion'` — use it instead of matching step titles for the word 'assert'. `failureClass` distinguishes a product defect (value-assertion) from a test that could not reach its target (reach), a page exception (page-error), an environment block (env), and a timeout.",
      "`valid: false` with reasons naming the field means the bundle was edited, its summary file changed, or it came from a different workspace and was copied in.",
    ].join(" "),
    {
      bundlePath: z.string().optional().describe("Absolute path to an evidence-bundle.json."),
      sessionId: z.string().optional().describe("Headless session id; combined with caseId to locate the bundle."),
      caseId: z.string().optional().describe("Case id within the session (defaults to the only/first case)."),
    },
    (args) => callDep(deps.verifyEvidence, args),
  );

  // get_report_card — Z-K. Facts for the plain-language report.
  roTool(
    "get_report_card",
    [
      "Return machine-generated raw material for a plain-language QA report about a finished session.",
      "Per case: the author's own step titles for what was actually executed, every assertion with its expected/actual, the evidence paths, the RED-calibration verdict, and the risks (weak oracles from precheck, page errors, low discriminative power, unknown environment fields). Plus session-level verdictSummary, notCovered[] (each pointing at the platform capability that would close the gap), the environment fingerprint and any data residue.",
      "These are FACTS only: the card carries no free-text narrative field, by design. Rephrase and connect them; do not add facts that are not here.",
    ].join(" "),
    {
      sessionId: z.string().describe("The headless session id to build the card for."),
    },
    (args) => callDep(deps.getReportCard, args),
  );

  // bootstrap_auth_profile — Z-F. The thing that turns "需受限权限账号" from
  // HUMAN_INHERENT into a test.
  rwTool(
    "bootstrap_auth_profile",
    [
      "Create (or replace) a named auth profile by driving a real login in a fresh headless context, then saving the resulting storageState.",
      "This is what makes a permission matrix testable unattended: before v1.6 a second identity could only be produced by a human logging in at the panel, so an overnight run could only ever test as whoever logged in last.",
      "Credentials are referenced BY NAME (`credentialRef`) into the workspace credential store (`.zhuzhu-credentials.json`); they are never written into a test file and never appear in the response, the report or the audit log — only the field NAMES do.",
      "Login steps come from `loginSteps`, or from the referenced test file's own `recovery.login` (preferred: one definition of how to log in, rather than a second one that drifts).",
      "If the login flow runs but leaves no credential in the context, the profile is NOT saved and the call fails — an empty profile would fail at the first business step of every case tonight, far away from here.",
      "Afterwards, a case can run as that identity via `case.authProfile`, or a file can declare `settings.authMatrix: [...]` to run every case once per identity and get a comparison table.",
    ].join(" "),
    {
      profile: z.string().describe("Target profile name (letters, numbers, dot, underscore, dash)."),
      credentialRef: z.string().optional().describe("Key into the workspace credential store. Its fields become runtime variables for the login steps."),
      testFilePath: z.string().optional().describe("Reuse this file's recovery.login steps and baseUrl (relative to test-workflows/)."),
      loginSteps: z.array(z.any()).optional().describe("Explicit login steps, if not reusing a file's recovery.login."),
      baseUrl: z.string().optional().describe("Where the login flow starts (defaults to the test file's baseUrl)."),
      force: z.boolean().optional().describe("Replace an existing profile. Without it an existing profile is refused rather than clobbered — a profile is a credential, and overwriting the one an in-flight batch is using is a very confusing failure."),
    },
    (args) => callDep(deps.bootstrapAuthProfile, args),
  );

  // get_ui_contract — Z-P. "Which entries use this component" / blind-spot map.
  roTool(
    "get_ui_contract",
    [
      "The UI contract graph, merged from three sources that were never joined before: the authored test files (which testid is used by which case, with which action), Zhuzhu's own run history (which routes were actually reached, and which testids repeatedly failed to resolve), and — optionally — the front-end repo's exported testid inventory.",
      "Use it to answer: 'which entry points use this component' (needed to write a cross-entry consistency facet at all), 'which cases would break if I rename this testid' (change-impact), and 'what exists but has never been reached' (`blindSpots.declaredButNeverUsed` — a blind spot nobody can see is indistinguishable from coverage).",
      "`stability.unstable` marks a testid that keeps failing to resolve: that is a DRIFTED CONTRACT, not a flaky test.",
      "Pass `component` to get just the entry points for one component. Without a front-end inventory the graph still answers everything history can answer and says so in `completeness`.",
    ].join(" "),
    {
      component: z.string().optional().describe("Filter to one component/testid family and return its entry points."),
      maxRuns: z.number().optional().describe("How many recent runs to scan for reach/stability (default 200)."),
    },
    (args) => callDep(deps.getUiContract, args),
  );

  // v1.9 REQ-Z25: get_capabilities — the machine-verifiable catalog.
  //
  // Exposed as a tool (not just an HTTP route) because the accident it prevents
  // happened to an MCP consumer: office-lab needed `verify_evidence`, could not
  // find its path in the docs, guessed `/verify-evidence`, got a 404, and printed
  // "Zhuzhu Z-D 未上线" into two weeks of QA reports. The endpoint had shipped in
  // v1.5 at `/evidence/verify`. This tool makes that class of mistake impossible
  // to make silently: every capability states its status AND its real path.
  roTool(
    "get_capabilities",
    [
      "The machine-verifiable capability catalog. For every capability: `id`, `status` (ga | beta | planned), the MCP tool name, and the REAL HTTP `{method, path}`.",
      "Read this before wiring ANY endpoint. Never guess a path: a 404 on a guessed path is indistinguishable from 'not implemented', and inferring the latter from the former has previously produced a false 'not shipped' claim that survived two weeks in published reports.",
      "`status:'planned'` is the ONLY thing that means not-built. A capability that is absent from this list is also not built. Anything with `status:'ga'` is callable today at exactly the stated path.",
      "Entries may carry `commonMistakes` — paths people have wrongly guessed for that capability. `alternateHttp` lists additional valid method/path pairs.",
    ].join(" "),
    {
      surface: z.enum(["app", "bridge"]).optional().describe("Only capabilities routable on this surface (app = desktop :32147, bridge = standalone :32146)."),
      status: z.enum(["ga", "beta", "planned"]).optional().describe("Filter by implementation status."),
    },
    (args) => callDep(deps.getCapabilities, args || {}),
  );

  return server;
}

// ---- HTTP transport glue ----------------------------------------------------

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
}

function writeJsonRpcError(res, statusCode, code, message) {
  if (res.headersSent) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

// Handle one HTTP request to the /mcp endpoint. Stateless: POST carries a single
// JSON-RPC message (already parsed into `body` by the caller). GET/DELETE are not
// supported in stateless mode and return 405. `deps` is forwarded to buildMcpServer.
async function handleMcpHttpRequest({ req, res, body, deps }) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    writeJsonRpcError(
      res,
      405,
      -32000,
      "Method not allowed. This MCP endpoint is stateless; use POST for JSON-RPC messages.",
    );
    return;
  }

  // Ensure the Accept header satisfies the Streamable HTTP transport (it requires
  // both application/json and text/event-stream). Well-behaved MCP clients send
  // this; we backfill defensively so a slightly-off client still works.
  const accept = String(req.headers.accept || "");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
  }

  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    Promise.resolve()
      .then(() => transport.close())
      .catch(() => {});
    Promise.resolve()
      .then(() => server.close())
      .catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    writeJsonRpcError(res, 500, -32603, err?.message || String(err));
  }
}

module.exports = {
  MCP_ROUTE,
  SERVER_NAME,
  TOOL_CATALOG,
  buildMcpServer,
  handleMcpHttpRequest,
  // exported for tests / discovery
  toToolResult,
  normalizeError,
};
