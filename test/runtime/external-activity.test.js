const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer } = require("../../runtime/server/http");
const {
  createExternalActivityReporter,
  matchExternalCapability,
} = require("../../runtime/server/external-activity");

test("maps external runtime routes to user-facing capabilities", () => {
  assert.equal(matchExternalCapability("POST", "/validate-test-file")?.capability, "testFile.validate");
  assert.equal(matchExternalCapability("POST", "/test-sessions/session-1/run")?.capability, "testSession.run");
  assert.equal(matchExternalCapability("GET", "/status"), null);
});

test("emits started and completed lifecycle events for validate", async () => {
  const events = [];
  const server = createServer({
    externalActivityReporter: (event) => events.push(event),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/validate-test-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testFile: { name: "Activity smoke", cases: [] } }),
    });
    assert.ok([200, 422].includes(response.status));
    assert.equal(events.length, 2);
    assert.equal(events[0].phase, "started");
    assert.equal(events[0].capability, "testFile.validate");
    assert.equal(events[1].phase, "completed");
    assert.equal(events[1].id, events[0].id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("delivers lifecycle events to the desktop bridge in order", async () => {
  const events = [];
  const receiver = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(202);
    response.end();
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const reporter = createExternalActivityReporter({ port: receiver.address().port });
    reporter({ id: "ordered-1", phase: "started" });
    reporter({ id: "ordered-1", phase: "completed" });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("activity reporter timed out")), 1500);
      const poll = () => {
        if (events.length === 2) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    assert.deepEqual(events.map((event) => event.phase), ["started", "completed"]);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});
