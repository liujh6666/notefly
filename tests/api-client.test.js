/*
 * 回归用例 2：API 错误契约
 * 对应缺陷：HTTP 500 / 断网 / 非 JSON / 超时都被当成“成功”或吞成“服务未响应”。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApi, normalizeResponse } = require("../public/js/api-client");

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("200 + JSON → ok:true 且字段展开", async () => {
  const api = createApi({ fetchImpl: async () => jsonResponse(200, { id: "c1", title: "标题" }) });
  const r = await api("/contents");
  assert.equal(r.ok, true);
  assert.equal(r.id, "c1");
  assert.equal(r.status, 200);
});

test("HTTP 500 + JSON error → ok:false，错误原因原样保留", async () => {
  const api = createApi({ fetchImpl: async () => jsonResponse(500, { error: "内容保存失败（磁盘写入异常）" }) });
  const r = await api("/contents", { method: "POST", body: { title: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.match(r.error, /磁盘写入异常/);
});

test("HTTP 500 + HTML 错误页（非 JSON）→ 明确报错，不能说成功", async () => {
  const api = createApi({
    fetchImpl: async () => new Response("<html><body>Internal Server Error</body></html>", { status: 500, headers: { "Content-Type": "text/html" } }),
  });
  const r = await api("/contents", { method: "PUT", body: { title: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.match(r.error, /非 JSON/);
});

test("HTTP 200 但返回 HTML → 仍判失败（防止被网关/错误页伪装成功）", async () => {
  const api = createApi({ fetchImpl: async () => new Response("<html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } }) });
  const r = await api("/contents");
  assert.equal(r.ok, false);
  assert.match(r.error, /非 JSON/);
});

test("断网（fetch reject）→ networkError 且提示重启", async () => {
  const api = createApi({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  const r = await api("/contents");
  assert.equal(r.ok, false);
  assert.equal(r.networkError, true);
  assert.equal(r.status, 0);
  assert.match(r.error, /无法连接|重启/);
});

test("超时（AbortError）→ timedOut，且明确“结果未确认”", async () => {
  const api = createApi({
    timeoutMs: 20,
    fetchImpl: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  });
  const r = await api("/publish", { method: "POST", body: {} });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.error, /超时/);
  assert.match(r.error, /未确认/);
});

test("normalizeResponse 对空响应体也判失败", () => {
  const r = normalizeResponse({ ok: true, status: 204 }, "");
  assert.equal(r.ok, false);
  assert.match(r.error, /空响应/);
});
