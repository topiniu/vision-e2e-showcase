const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateText, rewriteOrigins } = require("../../scripts/migrate-origins");
const { applyRunTarget, normalizeRunTarget } = require("../../src/shared/run-target");

// v1.10 Z27-6: the migration tool that moves files off hard-coded addresses.

test("origins are rewritten only at a URL boundary", () => {
  const maps = [{ origin: "http://localhost:8000", name: "app" }];
  const { text, count } = rewriteOrigins(
    '{"a":"http://localhost:8000/x","b":"http://localhost:8000","c":"http://localhost:80001/y","d":"http://localhost:8000?q=1"}',
    maps,
  );
  assert.equal(count, 3);
  assert.equal(text, '{"a":"{{origin.app}}/x","b":"{{origin.app}}","c":"http://localhost:80001/y","d":"{{origin.app}}?q=1"}');
});

test("credential literals are replaced inside recovery only, formatting and updatedAt handled", () => {
  const source = [
    "{",
    '  "updatedAt": "2026-01-01T00:00:00.000Z",',
    '  "baseUrl": "http://localhost:8000/login",',
    '  "recovery": { "login": { "steps": [',
    '    { "type": "fill", "target": { "locator": "input", "value": "demo-user" } },',
    '    { "type": "fill", "target": { "locator": "input[type=password]" }, "value": "demo-password-not-valid" }',
    "  ] } },",
    '  "cases": [ { "id": "c", "steps": [ { "type": "fill", "value": "demo-user" } ] } ]',
    "}",
    "",
  ].join("\r\n");
  const result = migrateText(source, {
    maps: [{ origin: "http://localhost:8000", name: "app" }],
    credentials: [{ field: "username", literal: "demo-user" }, { field: "password", literal: "demo-password-not-valid" }],
    now: "2026-10-08T00:00:00.000Z",
  });
  assert.equal(result.changed, true);
  assert.equal(result.originCount, 1);
  assert.equal(result.credentialCount, 2);
  const json = JSON.parse(result.text);
  assert.equal(json.baseUrl, "{{origin.app}}/login");
  assert.equal(json.recovery.login.steps[0].target.value, "{{credential.username}}");
  assert.equal(json.recovery.login.steps[1].value, "{{credential.password}}");
  assert.equal(json.cases[0].steps[0].value, "demo-user", "the same literal outside recovery is business data — untouched");
  assert.equal(json.updatedAt, "2026-10-08T00:00:00.000Z");
  assert.ok(result.text.includes("\r\n"), "CRLF preserved");
  assert.ok(/\r\n$/.test(result.text), "trailing newline preserved");
});

test("an unchanged file is returned byte-identical (updatedAt not touched)", () => {
  const source = '{\n  "updatedAt": "x",\n  "baseUrl": "{{origin.app}}/"\n}\n';
  const result = migrateText(source, { maps: [{ origin: "http://localhost:8000", name: "app" }] });
  assert.equal(result.changed, false);
  assert.equal(result.text, source);
});

test("a migrated file runs against whatever target the caller passes", () => {
  const migrated = JSON.parse(migrateText('{"baseUrl":"http://localhost:8000/login","cases":[]}', {
    maps: [{ origin: "http://localhost:8000", name: "app" }],
  }).text);
  const a = applyRunTarget(migrated, normalizeRunTarget({ origins: { app: "http://198.51.100.5:8000" } }));
  const b = applyRunTarget(migrated, normalizeRunTarget({ origins: { app: "http://198.51.100.7:8004" } }));
  assert.equal(a.testFile.baseUrl, "http://198.51.100.5:8000/login");
  assert.equal(b.testFile.baseUrl, "http://198.51.100.7:8004/login");
});

test("run-target validation: names, URLs, deny and allow lists", () => {
  assert.throws(() => normalizeRunTarget({ origins: { "1bad": "http://x" } }), /target\.origins key/);
  assert.throws(() => normalizeRunTarget({ origins: { app: "localhost:8000" } }), (error) => error.code === "invalid-target");
  assert.throws(() => normalizeRunTarget({ origins: { app: "ftp://10.0.0.1" } }), (error) => error.code === "invalid-target");
  assert.throws(
    () => normalizeRunTarget({ origins: { app: "https://production.example.org" } }),
    (error) => error.code === "target-origin-denied",
    "the apex of a denied *.domain is denied too",
  );
  assert.ok(normalizeRunTarget({ origins: { app: "http://app.test.example.org" } }), "the pre (test) domain is allowed");
  const strict = { deny: [], allow: ["198.51.100.5"] };
  assert.throws(() => normalizeRunTarget({ origins: { app: "http://198.51.100.6:8000" } }, { policy: strict }), (error) => error.code === "target-origin-denied");
  assert.ok(normalizeRunTarget({ origins: { app: "http://198.51.100.5:8000" } }, { policy: strict }));
  assert.equal(normalizeRunTarget(null), null, "no target = legacy behaviour");
});
