/*
 * P2 回归：AI Base URL 填了完整 endpoint 时不得重复拼接 /chat/completions
 * （1104 审查报告 P2：https://example.invalid/v1/chat/completions 被拼成 …/chat/completions/chat/completions）
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const ai = require("../lib/ai");

test("normalizeBaseUrl：完整 endpoint 保持原样，调用时不再追加路径", () => {
  const base = ai.normalizeBaseUrl("https://example.invalid/v1/chat/completions");
  assert.equal(base, "https://example.invalid/v1/chat/completions");
});

test("chat() 请求地址：完整 endpoint 不重复拼接（拦截到出站请求验证）", async () => {
  const origFetch = global.fetch;
  let hitUrl = "";
  global.fetch = async (url) => {
    hitUrl = String(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await ai.chat(
      { baseUrl: "https://example.invalid/v1/chat/completions", apiKey: "sk-test", model: "m" },
      { messages: [{ role: "user", content: "hi" }] }
    );
  } catch { /* 网络层错误不影响断言 */ } finally {
    global.fetch = origFetch;
  }
  assert.equal(hitUrl, "https://example.invalid/v1/chat/completions", `实际出站地址：${hitUrl}`);
});

test("常规 Base URL 仍然正常补全 /v1/chat/completions", () => {
  assert.equal(ai.normalizeBaseUrl("https://api.deepseek.com"), "https://api.deepseek.com/v1");
  assert.equal(ai.normalizeBaseUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1");
});
