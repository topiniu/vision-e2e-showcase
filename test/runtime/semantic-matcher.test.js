const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSemanticMatches } = require("../../src/main/semantic-matcher");

test("semantic matcher does not rank target fragments as full composite OCR matches", () => {
  const matches = buildSemanticMatches({
    query: "账号登陆",
    detections: [
      {
        id: "scan-login-suffix",
        text: "登陆",
        score: 0.97,
        bbox: { x: 2068, y: 609, width: 42, height: 26 },
      },
      {
        id: "account-prefix",
        text: "账号",
        score: 0.96,
        bbox: { x: 2360, y: 605, width: 69, height: 43 },
      },
      {
        id: "account-login-full",
        text: "账号登陆",
        score: 0.9,
        bbox: { x: 2360, y: 605, width: 110, height: 43 },
      },
    ],
    frameSize: { width: 2560, height: 1440 },
  });

  assert.equal(matches[0].text, "账号登陆");
  assert.equal(matches.some((item) => item.text === "登陆"), false);
});

test("semantic matcher still allows submit synonyms when the query has submit intent", () => {
  const matches = buildSemanticMatches({
    query: "登录",
    detections: [
      {
        id: "login-variant",
        text: "登陆",
        score: 0.96,
        bbox: { x: 200, y: 620, width: 42, height: 26 },
      },
    ],
    frameSize: { width: 1280, height: 720 },
  });

  assert.equal(matches[0].text, "登陆");
  assert.equal(matches[0].categories.includes("submit"), true);
});
