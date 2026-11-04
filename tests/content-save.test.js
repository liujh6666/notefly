/*
 * 回归用例 3：保存流程
 * 对应缺陷：保存失败仍提示“已保存”并退出编辑器。
 * 断言点：失败时 ok:false、正文不被清空、调用方据 ok 决定是否离开编辑页。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const content = require("../public/js/content-save");

const form = () => ({ type: "ARTICLE", title: "测试标题", body: "正文第一段", digest: "", cover: "", tagsStr: "a, b" });

test("保存失败（HTTP 500）→ ok:false，表单内容保持不变", async () => {
  const f = form();
  const api = async () => ({ ok: false, status: 500, error: "内容保存失败（磁盘写入异常）" });
  const r = await content.save(api, f);
  assert.equal(r.ok, false);
  assert.match(r.error, /磁盘写入异常/);
  assert.equal(f.title, "测试标题");
  assert.equal(f.body, "正文第一段");
});

test("断网 → ok:false 且带网络原因", async () => {
  const api = async () => ({ ok: false, status: 0, networkError: true, error: "无法连接 NoteFly 服务（可能已退出），请重启桌面版后重试" });
  const r = await content.save(api, form());
  assert.equal(r.ok, false);
  assert.match(r.error, /无法连接/);
});

test("成功 → ok:true 并带内容 ID（新建回填，供后续更新）", async () => {
  const api = async (path) => ({ ok: true, status: 200, id: "c-123", title: "测试标题" });
  const r = await content.save(api, form());
  assert.equal(r.ok, true);
  assert.equal(r.content.id, "c-123");
  assert.equal(r.created, true);
});

test("HTTP 200 但没有 id → 判为未确认，不能提示已保存", async () => {
  const api = async () => ({ ok: true, status: 200 });
  const r = await content.save(api, form());
  assert.equal(r.ok, false);
  assert.match(r.error, /内容 ID/);
});

test("更新走 PUT，带上已有 id", async () => {
  let seen = null;
  const api = async (path, opts) => { seen = { path, method: opts.method }; return { ok: true, status: 200, id: "c-9" }; };
  const f = Object.assign(form(), { id: "c-9" });
  const r = await content.save(api, f);
  assert.equal(r.ok, true);
  assert.equal(seen.path, "/contents/c-9");
  assert.equal(seen.method, "PUT");
  assert.equal(r.created, false);
});

test("空内容不提交请求（避免空稿保存成功）", async () => {
  let called = false;
  const api = async () => { called = true; return { ok: true, id: "x" }; };
  const r = await content.save(api, { type: "ARTICLE", title: "", body: "   " });
  assert.equal(r.ok, false);
  assert.equal(called, false);
  assert.match(r.error, /空的/);
});

test("标签按中英文逗号拆分并去空", () => {
  const p = content.buildPayload({ title: "t", body: "b", tagsStr: "掘金，开源, ,AI" });
  assert.deepEqual(p.tags, ["掘金", "开源", "AI"]);
});

test("普通文章不带模板标识（gzhTheme 为空）", () => {
  const p = content.buildPayload({ title: "t", body: "b" });
  assert.equal(p.gzhTheme, "");
});

test("公众号文章带模板标识，且类型仍是 ARTICLE（不影响平台发布）", () => {
  const p = content.buildPayload({ title: "t", body: "b", gzhTheme: "red-white" });
  assert.equal(p.gzhTheme, "red-white");
  /* 平台适配器按 contentType 严格匹配，改成新类型会导致所有平台发布失败 */
  assert.equal(p.type, "ARTICLE");
});

test("草稿标记：draft 只认布尔，缺省为 false", () => {
  assert.equal(content.buildPayload({ title: "t", body: "b" }).draft, false);
  assert.equal(content.buildPayload({ title: "t", body: "b", draft: true }).draft, true);
  assert.equal(content.buildPayload({ title: "t", body: "b", draft: "yes" }).draft, true);
  assert.equal(content.buildPayload({ title: "t", body: "b", draft: 0 }).draft, false);
});
