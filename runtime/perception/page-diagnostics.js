"use strict";


const { releaseConsoleMessageArgs } = require("./console-message-args");

const DEFAULT_MAX_ENTRIES = Math.max(
  10,
  Number(process.env.ZHUZHU_PAGE_ERROR_MAX_ENTRIES ?? 200),
);

const PAGE_ERROR_CODE = "page-error";
const PAGE_ERROR_POLICIES = ["fail", "warn", "off"];
// The three windows a page error can happen in. `under-test` is the only one the
// gate enforces by default — see the module header.
const PAGE_ERROR_PHASES = ["auth-bootstrap", "recovery", "under-test"];
const DEFAULT_PHASE_POLICY = Object.freeze({
  "auth-bootstrap": "off",
  recovery: "off",
  "under-test": "fail",
});
const ORIGIN_KINDS = ["same-origin", "third-party", "unknown"];

function normalizePageErrorPolicy(value, fallback = "fail") {
  const text = String(value ?? "").trim().toLowerCase();
  if (PAGE_ERROR_POLICIES.includes(text)) {
    return text;
  }
  if (text === "error" || text === "block") {
    return "fail";
  }
  if (text === "warning" || text === "advisory") {
    return "warn";
  }
  if (text === "none" || text === "disabled" || text === "0" || text === "false") {
    return "off";
  }
  return fallback;
}

function normalizePhaseName(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (PAGE_ERROR_PHASES.includes(text)) {
    return text;
  }
  // Tolerated aliases so a caller does not have to memorise the exact spelling.
  if (text === "auth" || text === "login" || text === "bootstrap" || text === "authbootstrap") {
    return "auth-bootstrap";
  }
  if (text === "recover" || text === "relogin") {
    return "recovery";
  }
  if (text === "test" || text === "case" || text === "undertest") {
    return "under-test";
  }
  return null;
}

// The env var is an operational escape hatch (e.g. "collect noise for one night
// before flipping the default to fail" — roadmap §8). It only applies when the
// file did not state a policy, so a file that explicitly demands `fail` can
// never be silently downgraded by a machine-level setting.
function resolvePageErrorPolicy(declared) {
  if (declared != null && typeof declared === "object" && !Array.isArray(declared)) {
    return resolvePageErrorPolicyMap(declared)["under-test"];
  }
  if (declared != null && String(declared).trim() !== "") {
    return normalizePageErrorPolicy(declared);
  }
  const fromEnv = process.env.ZHUZHU_PAGE_ERROR_POLICY;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    return normalizePageErrorPolicy(fromEnv);
  }
  return "fail";
}

// REQ-Z23-2: the policy is per phase.
//
// A bare string still means what it always meant — but it now sets the
// `under-test` window only, leaving the login/recovery windows at their (off)
// default. That is the direction the QA round asked for: a file that says
// `"fail"` wants its *product* watched, not the SSO CDN it passes through on the
// way in. Restoring the old all-phases behaviour is one explicit line:
// `{"auth-bootstrap": "fail"}`.
function resolvePageErrorPolicyMap(declared) {
  const base = { ...DEFAULT_PHASE_POLICY };
  if (declared != null && typeof declared === "object" && !Array.isArray(declared)) {
    for (const [key, value] of Object.entries(declared)) {
      const phase = normalizePhaseName(key);
      if (phase) {
        base[phase] = normalizePageErrorPolicy(value, base[phase]);
      }
    }
    return base;
  }
  base["under-test"] = resolvePageErrorPolicy(declared);
  return base;
}

// `/pattern/flags` is treated as a regex, anything else as a case-insensitive
// substring. Substring is the common case (people paste the message they saw);
// regex is there for families of messages.
function compileAllowlistMatcher(match) {
  const text = String(match ?? "").trim();
  if (!text) {
    return null;
  }
  const regexLike = /^\/(.*)\/([gimsuy]*)$/.exec(text);
  let literal = text;
  if (regexLike) {
    try {
      const regex = new RegExp(regexLike[1], regexLike[2].replace(/g/g, ""));
      return (value) => regex.test(value);
    } catch (_error) {
      // A malformed regex degrades to substring matching on the *inner* pattern
      // (the author clearly meant the thing between the slashes) rather than
      // throwing — an allowlist typo must not break the run it was meant to
      // make quieter, and must not silently match nothing either.
      literal = regexLike[1];
    }
  }
  const needle = literal.toLowerCase();
  return (value) => String(value ?? "").toLowerCase().includes(needle);
}

// URL scoping. `**` crosses path separators, `*` does not; a pattern with no
// wildcard at all is a plain substring (people paste the URL they saw). Slashed
// `/.../` is a regex, same convention as `match`.
function compileUrlMatcher(pattern) {
  const text = String(pattern ?? "").trim();
  if (!text) {
    return null;
  }
  const regexLike = /^\/(.*)\/([gimsuy]*)$/.exec(text);
  if (regexLike) {
    try {
      const regex = new RegExp(regexLike[1], regexLike[2].replace(/g/g, ""));
      return (value) => regex.test(String(value ?? ""));
    } catch (_error) {
      // fall through to glob/substring on the inner pattern
    }
  }
  if (!text.includes("*")) {
    const needle = text.toLowerCase();
    return (value) => String(value ?? "").toLowerCase().includes(needle);
  }
  const source = text
    .split("**")
    .map((chunk) =>
      chunk
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  try {
    const regex = new RegExp(source, "i");
    return (value) => regex.test(String(value ?? ""));
  } catch (_error) {
    return null;
  }
}

function normalizeOriginKind(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "same-origin" || text === "same" || text === "first-party" || text === "product") {
    return "same-origin";
  }
  if (text === "third-party" || text === "third" || text === "external" || text === "3p") {
    return "third-party";
  }
  if (text === "unknown") {
    return "unknown";
  }
  return null;
}

// An entry is `{match?, url?, origin?, phase?, reason}` and every declared field
// must hold. An entry that declares nothing at all is dropped: `{}` would mute
// the whole gate, which is precisely the failure mode this shape exists to make
// impossible to reach by accident.
function normalizeAllowlist(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((item) => {
      if (typeof item === "string") {
        return { match: item.trim(), url: null, origin: null, phase: null, reason: "" };
      }
      if (item && typeof item === "object") {
        return {
          match: String(item.match ?? item.pattern ?? item.text ?? "").trim(),
          url: String(item.url ?? item.urlIncludes ?? "").trim() || null,
          origin: normalizeOriginKind(item.origin),
          phase: normalizePhaseName(item.phase),
          reason: String(item.reason ?? "").trim(),
        };
      }
      return null;
    })
    .filter(Boolean)
    .map((item) => ({
      ...item,
      matcher: item.match ? compileAllowlistMatcher(item.match) : null,
      urlMatcher: item.url ? compileUrlMatcher(item.url) : null,
    }))
    .filter((item) => item.matcher || item.urlMatcher || item.origin || item.phase);
}

// A stable label for "which allowlist entry silenced this", used in the report
// and in the audit trail. `match` alone is no longer enough to identify an entry.
function describeAllowlistEntry(item = {}) {
  const parts = [];
  if (item.match) {
    parts.push(item.match);
  }
  if (item.url) {
    parts.push(`url=${item.url}`);
  }
  if (item.origin) {
    parts.push(`origin=${item.origin}`);
  }
  if (item.phase) {
    parts.push(`phase=${item.phase}`);
  }
  return parts.join(" & ") || "(empty)";
}

function readMessageStack(error) {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return null;
  }
  const stack = error.stack;
  return typeof stack === "string" && stack.trim() ? stack.trim() : null;
}

function readMessageText(error) {
  if (error == null) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  const message = error.message;
  if (typeof message === "string" && message.trim()) {
    return error.name && !message.startsWith(error.name) ? `${error.name}: ${message}` : message;
  }
  try {
    return String(error);
  } catch (_castError) {
    return "(unstringifiable page error)";
  }
}

function readHost(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    return new URL(text).host.toLowerCase() || null;
  } catch (_error) {
    return null;
  }
}

// Where the code that threw actually lives. A console error carries its script
// location; an uncaught exception only carries a stack, so the first absolute URL
// in it is the best available answer. Falling back to the page URL is honest for
// inline scripts — they really do belong to the document.
const STACK_URL_PATTERN = /\bhttps?:\/\/[^\s)'"]+/;

function readSourceUrl({ location = null, stack = null, pageUrl = null }) {
  if (location?.url) {
    return location.url;
  }
  if (typeof stack === "string") {
    const match = STACK_URL_PATTERN.exec(stack);
    if (match) {
      return match[0];
    }
  }
  return pageUrl || null;
}

// `third-party` is judged against the baseUrl under test, not against the page's
// current URL: while a run sits on the SSO login page, the *page* is already
// third-party, and comparing to it would classify the CDN noise as same-origin.
function classifyOrigin(sourceUrl, baseHost) {
  const sourceHost = readHost(sourceUrl);
  if (!sourceHost || !baseHost) {
    return "unknown";
  }
  return sourceHost === baseHost ? "same-origin" : "third-party";
}

// Turn a concrete URL into a scope pattern an allowlist entry can use. Keeps the
// host (that is the discriminating part for third-party noise) and drops the
// query/hash, which are per-run and would make the entry match nothing tomorrow.
function toUrlPattern(url) {
  const text = String(url ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = new URL(text);
    const dir = parsed.pathname.replace(/\/[^/]*$/, "/");
    return `${parsed.protocol}//${parsed.host}${dir}**`;
  } catch (_error) {
    return text.split("?")[0] || null;
  }
}

class PageDiagnostics {
  constructor({
    page = null,
    onEvent = null,
    runId = null,
    policy = null,
    allowlist = null,
    maxEntries = DEFAULT_MAX_ENTRIES,
    caseId = null,
    // v1.9 REQ-Z23: what "third-party" is measured against.
    baseUrl = null,
    // v1.9 REQ-Z23: URLs that mean "we are not in the product yet" — taken from
    // the file's own `recovery.*.detect`, so the platform recognises the login
    // page without the author having to describe it a second time.
    authPhaseDetects = null,
    evaluateDetect = null,
  } = {}) {
    this.page = page;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.runId = runId;
    this.phasePolicy = resolvePageErrorPolicyMap(policy);
    // Kept as the single-string field every existing consumer reads
    // (`summary.pageErrors.policy`, `assertNoPageError`): the policy of the
    // window that actually tests the product.
    this.policy = this.phasePolicy["under-test"];
    this.allowlist = normalizeAllowlist(allowlist);
    // v1.11 REQ-Z31: the browser's own "Failed to load resource" line for a
    // request that a routeFault step failed ON PURPOSE. Blaming the page for the
    // fault the test injected would fail every fault-injection case at the gate.
    // Only that browser line is exempt — anything the app throws in response
    // (an unhandled rejection, an error boundary) is still a real page error.
    this.injectedFaultMatcher = null;
    this.injectedFaultErrors = 0;
    this.baseUrl = baseUrl || null;
    this.baseHost = readHost(baseUrl);
    this.authPhaseDetects = Array.isArray(authPhaseDetects) ? authPhaseDetects.filter(Boolean) : [];
    this.evaluateDetect = typeof evaluateDetect === "function" ? evaluateDetect : null;
    this.maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    this.caseId = caseId;
    this.entries = [];
    this.dropped = 0;
    this.seq = 0;
    this.step = { stepId: null, stepIndex: null, phase: null };
    // Index of the first entry the gate has not yet reported. Lets the run loop
    // ask "did anything new blow up during *that* step" instead of re-failing
    // every later step on one old error.
    this.gateCursor = 0;
    // Independent cursor for the explicit `assertNoPageError` assertion. Kept
    // separate from the gate on purpose: the assertion must still be able to
    // fail a case when `pageErrorPolicy` is "warn"/"off" (that is the whole
    // reason to write it), and the gate must not be disarmed by an author who
    // happened to place an assertion earlier in the case.
    this.assertCursor = 0;
    this.disposed = false;
    this.listeners = [];
    this.attach();
  }

  attach() {
    const page = this.page;
    if (!page || typeof page.on !== "function") {
      return;
    }
    // THE missing listener (leak #1). An uncaught exception in app code — the
    // React event-pooling TypeError included — lands here and nowhere else.
    this.bind(page, "pageerror", (error) =>
      this.record({
        kind: "pageerror",
        message: readMessageText(error),
        stack: readMessageStack(error),
      }),
    );
    // `console.error` is a weaker signal than an uncaught throw (apps log
    // expected errors), but React's own "The above error occurred in ..." and
    // most error boundaries only ever reach console. Recorded with its own kind
    // so a consumer can weight them differently.
    this.bind(page, "console", (message) => {
      let type = "";
      try {
        type = typeof message?.type === "function" ? message.type() : message?.type || "";
      } catch (_error) {
        type = "";
      }
      if (type !== "error") {
        // v1.9 perf: still release the handles. Playwright materialises the args
        // when the message arrives, not when we look at them, so returning early
        // on a `log` leaks exactly as much as keeping an `error` would — and
        // `log` is the overwhelming majority. On the visible channel this page
        // outlives the run, so nothing else will ever collect them.
        releaseConsoleMessageArgs(message);
        return;
      }
      let text = "";
      try {
        text = typeof message?.text === "function" ? message.text() : message?.text || "";
      } catch (_error) {
        text = "";
      }
      let location = null;
      try {
        location = typeof message?.location === "function" ? message.location() : message?.location || null;
      } catch (_error) {
        location = null;
      }
      releaseConsoleMessageArgs(message);
      if (
        this.injectedFaultMatcher &&
        /^Failed to load resource/i.test(text) &&
        location?.url &&
        this.injectedFaultMatcher(location.url)
      ) {
        this.injectedFaultErrors += 1;
        return;
      }
      this.record({
        kind: "console-error",
        message: text,
        stack: null,
        location: location
          ? { url: location.url || null, lineNumber: location.lineNumber ?? null, columnNumber: location.columnNumber ?? null }
          : null,
      });
    });
  }

  setInjectedFaultMatcher(matcher) {
    this.injectedFaultMatcher = typeof matcher === "function" ? matcher : null;
  }

  bind(target, event, handler) {
    try {
      target.on(event, handler);
      this.listeners.push({ target, event, handler });
    } catch (_error) {
      // A limited/fake page (tests, non-Chromium) may not support the event.
    }
  }

  // Tell the diagnostics which step is currently executing, so every entry
  // carries the step that produced it. Without this the report can say "the page
  // threw" but not "it threw when you typed into the name field", which is the
  // only version an author can act on.
  setStep({ stepId = null, stepIndex = null, phase = null, caseId = undefined } = {}) {
    this.step = { stepId, stepIndex, phase };
    if (caseId !== undefined) {
      this.caseId = caseId;
    }
  }

  // AND across every declared field. `match` alone reproduces the v1.5 behaviour
  // exactly, so existing files keep working unchanged.
  matchAllowlist(message, context = {}) {
    for (const item of this.allowlist) {
      if (item.matcher && !item.matcher(message)) {
        continue;
      }
      if (item.urlMatcher && !item.urlMatcher(context.url) && !item.urlMatcher(context.sourceUrl)) {
        continue;
      }
      if (item.origin && item.origin !== context.origin) {
        continue;
      }
      if (item.phase && item.phase !== context.phase) {
        continue;
      }
      return item;
    }
    return null;
  }

  // Which of the three windows this error happened in. A recovery step says so
  // itself; otherwise the *page* decides — if we are sitting on a URL the file
  // declares as a recovery trigger (i.e. the login page), we are not testing the
  // product yet, whatever step index we are on.
  resolvePhaseGroup(url) {
    if (this.step.phase === "recovery") {
      return "recovery";
    }
    if (this.isAuthPhaseUrl(url)) {
      return "auth-bootstrap";
    }
    return "under-test";
  }

  isAuthPhaseUrl(url) {
    if (!url || !this.authPhaseDetects.length || !this.evaluateDetect) {
      return false;
    }
    for (const detect of this.authPhaseDetects) {
      try {
        if (this.evaluateDetect(detect, { url })) {
          return true;
        }
      } catch (_error) {
        // A malformed detect must not break error collection.
      }
    }
    return false;
  }

  policyForPhase(phase) {
    return this.phasePolicy[phase] || this.phasePolicy["under-test"];
  }

  readPageUrl() {
    try {
      return typeof this.page?.url === "function" ? this.page.url() : null;
    } catch (_error) {
      return null;
    }
  }

  record({ kind, message, stack = null, location = null }) {
    if (this.disposed) {
      return null;
    }
    const text = String(message ?? "").trim();
    if (!text) {
      return null;
    }
    // A pathological page (an error thrown inside a render loop) can emit
    // thousands. Keep the first N — they carry the root cause — and count the
    // rest, rather than letting the report balloon or the process gc-thrash.
    if (this.entries.length >= this.maxEntries) {
      this.dropped += 1;
      return null;
    }
    const pageUrl = this.readPageUrl();
    const sourceUrl = readSourceUrl({ location, stack, pageUrl });
    const phaseGroup = this.resolvePhaseGroup(pageUrl);
    const origin = classifyOrigin(sourceUrl, this.baseHost);
    const context = { url: pageUrl, sourceUrl, origin, phase: phaseGroup };
    const suppression = this.matchAllowlist(text, context);
    this.seq += 1;
    const entry = {
      seq: this.seq,
      at: Date.now(),
      kind,
      message: text,
      stack,
      location,
      url: pageUrl,
      // v1.9 REQ-Z23-1: the source of the error and the window it happened in.
      sourceUrl: sourceUrl || null,
      origin,
      phaseGroup,
      caseId: this.caseId,
      stepId: this.step.stepId,
      stepIndex: this.step.stepIndex,
      phase: this.step.phase,
      suppressed: Boolean(suppression),
      suppressedBy: suppression ? describeAllowlistEntry(suppression) : null,
      suppressedReason: suppression ? suppression.reason || null : null,
    };
    this.entries.push(entry);
    this.emit({
      type: "page-error",
      runId: this.runId,
      policy: this.policy,
      phasePolicy: this.phasePolicy,
      entry,
    });
    return entry;
  }

  emit(event) {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent(event);
    } catch (_error) {
      // Telemetry delivery must never affect the run.
    }
  }

  isGateEnforcing() {
    return this.phasePolicy["under-test"] === "fail";
  }

  // v1.9 REQ-Z23-2: two different suppression questions, deliberately answered
  // differently.
  //
  // The GATE is the default-on mechanism, so it only ever blames a phase whose
  // policy is `fail` — "warn" has always meant "record, don't blame".
  // The ASSERTION (`assertNoPageError`) is an explicit declaration by the author,
  // so it outranks a warn policy (that is why anybody writes it) — but it still
  // respects a phase that is switched fully `off`, because "off" for the login
  // window is the platform saying *this window is not what you are testing*.
  isGateSuppressed(entry) {
    return Boolean(entry?.suppressed) || this.policyForPhase(entry?.phaseGroup) !== "fail";
  }

  isAssertSuppressed(entry) {
    if (Boolean(entry?.suppressed)) {
      return true;
    }
    // The product window: the author knows what they are asserting, so a global
    // warn/off never silences an explicit assertNoPageError (the v1.5 contract —
    // that is why it exists). Only an allowlist entries can quiet it here.
    if (entry?.phaseGroup === "under-test" || !entry?.phaseGroup) {
      return false;
    }
    // The login/recovery windows: an explicit assertion still respects a phase
    // switched fully `off` — the platform is saying this window is not the
    // product, and the author opted into that by not overriding the phase policy.
    return this.policyForPhase(entry?.phaseGroup) === "off";
  }

  // Entries the gate has not consumed yet (suppressed ones never count). Called
  // after each step; consuming the cursor means one page error fails exactly one
  // step instead of cascading onto every step after it.
  takeNewGateFailures() {
    if (this.gateCursor >= this.entries.length) {
      return [];
    }
    const fresh = this.entries.slice(this.gateCursor).filter((item) => !this.isGateSuppressed(item));
    this.gateCursor = this.entries.length;
    return fresh;
  }

  // Backing the `assertNoPageError` assertion: "nothing blew up between the
  // previous such assertion (or the start of the run) and now".
  takeAssertionFailures({ sinceRunStart = false } = {}) {
    const from = sinceRunStart ? 0 : this.assertCursor;
    const fresh = this.entries.slice(from).filter((item) => !this.isAssertSuppressed(item));
    this.assertCursor = this.entries.length;
    return fresh;
  }

  getEntries() {
    return this.entries.slice();
  }

  getFailures() {
    return this.entries.filter((item) => !item.suppressed);
  }

  // v1.9 REQ-Z23-3: cluster every distinct noise this run saw into ready-to-paste
  // allowlist entries. The whole point is that the caller gets ALL of them in one
  // round: last round's QA ran the 3-minute flow ten times because each round
  // revealed exactly one new message to allowlist (the noise is non-deterministic
  // — the AntD `rowKey` warning only fires once the SKU step renders its table).
  //
  // Clustered by (url × origin × first line of the message), because that triple
  // is what a *scoped* entry keys on. Ordered noisiest-first, and the suggested
  // entry is deliberately narrow: url + origin + the message's first line, never
  // a bare substring — the shape that produced the seven over-broad entries.
  buildSuggestedAllowlist({ limit = 40, includeSuppressed = false } = {}) {
    const clusters = new Map();
    for (const entry of this.entries) {
      if (entry.suppressed && !includeSuppressed) {
        continue;
      }
      const firstLine = String(entry.message || "").split("\n")[0].trim();
      const urlPattern = toUrlPattern(entry.sourceUrl || entry.url);
      const key = `${urlPattern}|${entry.origin}|${firstLine}`;
      const found = clusters.get(key);
      if (found) {
        found.count += 1;
        if (!found.phases.includes(entry.phaseGroup)) {
          found.phases.push(entry.phaseGroup);
        }
        continue;
      }
      clusters.set(key, {
        count: 1,
        phases: [entry.phaseGroup],
        kind: entry.kind,
        message: firstLine,
        url: urlPattern,
        origin: entry.origin,
        sourceUrl: entry.sourceUrl || entry.url || null,
        alreadySuppressed: Boolean(entry.suppressed),
      });
    }
    return [...clusters.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((cluster) => ({
        count: cluster.count,
        isThirdParty: cluster.origin === "third-party",
        origin: cluster.origin,
        phase: cluster.phases.length === 1 ? cluster.phases[0] : null,
        phases: cluster.phases,
        kind: cluster.kind,
        observedMessage: cluster.message,
        sourceUrl: cluster.sourceUrl,
        alreadySuppressed: cluster.alreadySuppressed,
        // Paste-ready. `match` is the observed first line trimmed to a
        // recognisable length; the scope fields are what keep it from becoming
        // a global mute.
        suggestedEntry: {
          ...(cluster.url ? { url: cluster.url } : {}),
          ...(cluster.origin !== "unknown" ? { origin: cluster.origin } : {}),
          ...(cluster.phases.length === 1 ? { phase: cluster.phases[0] } : {}),
          match: cluster.message.slice(0, 120),
          reason:
            `【待补充理由】${cluster.origin === "third-party" ? "第三方" : "同源"}脚本在 ` +
            `${cluster.phases.join("/")} 阶段报出 ${cluster.count} 次；` +
            "确认与被测产品无关后再保留本条，并把这句占位理由改成真实依据。",
        },
      }));
  }

  // Compact projection for `summary.pageErrors` / the evidence bundle. Always
  // returns an object (even with zero entries) so a consumer can tell "the gate
  // ran and saw nothing" from "this run predates the gate" (`null`).
  getReport() {
    const failures = this.getFailures();
    return {
      policy: this.policy,
      // v1.9 REQ-Z23-2: the per-window policy actually in force. Present even
      // when it is the default, so "the login window was outside the gate" is a
      // recorded fact rather than something a reader has to know.
      phasePolicy: { ...this.phasePolicy },
      baseUrl: this.baseUrl,
      total: this.entries.length,
      failing: failures.length,
      suppressed: this.entries.length - failures.length,
      // How many were left un-blamed because of *where/when* rather than because
      // somebody allowlisted them. Separated so switching a phase off can never
      // be mistaken for a clean page.
      outOfScope: this.entries.filter((item) => !item.suppressed && this.policyForPhase(item.phaseGroup) !== "fail")
        .length,
      dropped: this.dropped,
      // v1.11 REQ-Z31: browser load-failure lines caused by an injected routeFault.
      ...(this.injectedFaultErrors ? { injectedFaultErrors: this.injectedFaultErrors } : {}),
      allowlist: this.allowlist.map((item) => ({
        match: item.match || null,
        url: item.url,
        origin: item.origin,
        phase: item.phase,
        reason: item.reason || null,
      })),
      entries: this.entries.map((item) => ({ ...item })),
    };
  }

  dispose() {
    this.disposed = true;
    for (const { target, event, handler } of this.listeners) {
      try {
        target.off?.(event, handler);
      } catch (_error) {
        // best-effort detach
      }
    }
    this.listeners = [];
  }
}

function createPageDiagnostics(options = {}) {
  return new PageDiagnostics(options);
}

// Human-readable failure text for the gate. Deliberately quotes the *original*
// message and stack head: the whole point of Z-A is that the author sees the
// real exception, not "a page error occurred".
function describePageErrorFailure(entries = []) {
  const first = entries[0];
  if (!first) {
    return "The page reported an uncaught error.";
  }
  const more = entries.length > 1 ? ` (+${entries.length - 1} more page error(s) in this step)` : "";
  const stackHead = first.stack ? ` | ${first.stack.split("\n").slice(0, 3).join(" ⏎ ")}` : "";
  return (
    `The page reported an uncaught ${first.kind === "console-error" ? "console error" : "exception"} while this ` +
    `step was running: ${first.message}${stackHead}${more}. ` +
    "A run whose page is throwing cannot be trusted as green, so the page-error gate failed this case " +
    '(set `settings.pageErrorPolicy` to "warn"/"off", or allowlist the message with a reason, to change that).'
  );
}

module.exports = {
  DEFAULT_PHASE_POLICY,
  ORIGIN_KINDS,
  PAGE_ERROR_CODE,
  PAGE_ERROR_PHASES,
  PAGE_ERROR_POLICIES,
  PageDiagnostics,
  classifyOrigin,
  compileUrlMatcher,
  createPageDiagnostics,
  describeAllowlistEntry,
  describePageErrorFailure,
  normalizeOriginKind,
  normalizePageErrorPolicy,
  normalizePhaseName,
  normalizeAllowlist,
  resolvePageErrorPolicy,
  resolvePageErrorPolicyMap,
  toUrlPattern,
};
