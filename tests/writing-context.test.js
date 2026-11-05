/*
 * 写作上下文（lib/writing-context.js）单元测试
 * 覆盖：企业拦截、通用写作声明、资料组装与引用、缺资料拦截、上下文注入与引用快照
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-wctx-"));
process.env.NOTEFLY_DATA_DIR = TMP;

const library = require("../lib/content-library");
const wc = require("../lib/writing-context");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const BODY = `云原生数据库迁移实践

我们把核心系统迁到了云原生数据库。一致性边界收敛到租户内部，读延迟稳定在个位数毫秒。
连接池改成随扩缩容自动伸缩的运行时行为，不再依赖人工配置。
每两周做一次全量恢复演练，恢复目标控制在十分钟以内。`;

/* ---- 1. 未选企业 ---- */

test("未选企业且强制引用 → 明确拦截，不静默降级", () => {
  const r = wc.buildContext({ query: "数据库迁移", requireLibrary: true });
  assert.equal(r.ok, false);
  assert.equal(r.needConfirmation, true);
  assert.ok(/企业内容库/.test(r.reason));
});

test("未选企业但允许通用写作 → 如实声明未使用企业资料", () => {
  const r = wc.buildContext({ query: "数据库迁移", allowGeneric: true });
  assert.equal(r.ok, true);
  assert.equal(r.context.usedLibrary, false);
  assert.equal(r.context.companyId, null);
  assert.equal(r.context.citations.length, 0);
  assert.ok(/未.*企业资料|通用/.test(r.context.note));
});

/* ---- 2. 选了企业 ---- */

let company, article;
test("准备：建企业与资料", () => {
  company = library.createCompany({ name: "测试企业" }).company;
  article = library.addArticle(company.id, {
    title: "云原生数据库迁移实践",
    body: BODY,
    sourceUrl: "https://example.com/a",
    normalizedUrl: "https://example.com/a",
    collectStatus: "success",
  }).article;
  library.invalidateIndex(company.id);
  assert.ok(company.id && article.id);
});

test("空企业强制引用 → 拦截并要求先补资料", () => {
  const empty = library.createCompany({ name: "空企业" }).company;
  const r = wc.buildContext({ companyId: empty.id, query: "任意", requireLibrary: true });
  assert.equal(r.ok, false);
  assert.equal(r.needConfirmation, true);
  assert.ok(/采集|补录|资料/.test(r.reason));
});

test("选了企业且命中资料 → 组装上下文并带引用来源", () => {
  const r = wc.buildContext({ companyId: company.id, query: "数据库迁移 恢复演练" });
  assert.equal(r.ok, true);
  assert.equal(r.context.usedLibrary, true);
  assert.equal(r.context.companyId, company.id);
  assert.ok(r.context.materials.length >= 1, "至少有一条资料片段");
  assert.ok(r.context.materials.every((m) => m.articleId === article.id));
  /* 引用记录必须带来源，便于追溯 */
  assert.ok(Array.isArray(r.citations));
  assert.ok(r.citations.every((c) => c.articleId));
  /* 资料块里要有正文片段文本 */
  assert.ok(typeof r.context.blocks.materials === "string");
  assert.ok(/云原生|恢复演练/.test(r.context.blocks.materials));
});

test("上下文组装是纯读取：不产生引用记录之外的写入副作用", () => {
  const before = JSON.stringify(library.getCompany(company.id));
  wc.buildContext({ companyId: company.id, query: "数据库迁移" });
  assert.equal(JSON.stringify(library.getCompany(company.id)), before);
});

/* ---- 3. 上下文注入 ---- */

test("appendContextToMessages：把资料与要求注入 system 消息", () => {
  const r = wc.buildContext({ companyId: company.id, query: "数据库迁移" });
  const messages = [
    { role: "system", content: "你是写作助手" },
    { role: "user", content: "写一篇关于数据库迁移的文章" },
  ];
  const out = wc.appendContextToMessages(messages, r.context);
  /* 不修改原数组 */
  assert.equal(messages.length, 2);
  assert.ok(out.length >= 2);
  const joined = out.map((m) => m.content).join("\n");
  assert.ok(/云原生/.test(joined), "注入内容里应包含企业资料片段");
  assert.ok(/写一篇关于数据库迁移的文章/.test(joined), "原始用户消息必须保留");
});

test("appendMissingFactsNotice：无缺失时不加提示", () => {
  const r = wc.buildContext({ companyId: company.id, query: "数据库迁移" });
  const messages = [{ role: "user", content: "写一篇" }];
  const out = wc.appendMissingFactsNotice(messages, r.context);
  assert.equal(out.length, messages.length, "没有缺失事实时不应增加消息");
});

/* ---- 4. 引用快照 ---- */

test("buildCitationSnapshot：快照里带文章 ID 与来源", () => {
  const r = wc.buildContext({ companyId: company.id, query: "数据库迁移" });
  const snap = wc.buildCitationSnapshot(r.context);
  assert.ok(snap);
  const json = JSON.stringify(snap);
  assert.ok(json.includes(article.id), "快照必须能追溯到使用的文章");
});

/* ---- 5. 预算约束 ---- */

test("资料片段数量受 MAX_SNIPPETS 约束，总量受预算约束", () => {
  /* 造 6 篇文章，每篇都会命中 */
  for (let i = 0; i < 6; i++) {
    library.addArticle(company.id, {
      title: `迁移实践第 ${i} 篇：数据库恢复演练与一致性验证`,
      body: `第 ${i} 篇。数据库迁移与恢复演练是稳定性的基石，一致性验证覆盖主从延迟与快照回放。`,
      sourceUrl: `https://example.com/p${i}`,
      normalizedUrl: `https://example.com/p${i}`,
      collectStatus: "success",
    });
  }
  library.invalidateIndex(company.id);
  const r = wc.buildContext({ companyId: company.id, query: "数据库 迁移 恢复" });
  assert.equal(r.ok, true);
  assert.ok(r.context.materials.length <= 12, "片段数不超过上限");
  const totalLen = r.context.materials.reduce((n, m) => n + (m.text || "").length, 0);
  assert.ok(totalLen <= 12000, "资料总预算不超过 BUDGET.total");
});
