/*
 * 企业内容库 + 写作上下文 单元测试
 * 覆盖：企业隔离、版本不覆盖、去重、排除失效、检索失效、上下文预算
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-lib-"));
process.env.NOTEFLY_DATA_DIR = TMP;

const library = require("../lib/content-library");
const writingContext = require("../lib/writing-context");
const styleProfile = require("../lib/style-profile");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const BODY_A = `云原生数据库迁移实践

我们把核心系统迁到了云原生数据库。一致性边界收敛到租户内部，读延迟稳定。连接池改成随扩缩容自动伸缩的运行时行为。每两周做一次全量恢复演练。`;
const BODY_B = `产品定价完全公开

定价只有两个变量：用量与支持级别。社区版永久免费。标准版按月订阅。企业版按年签约。`;

/* 建两个企业，各放一篇文章 */
let A, B, artA, artB;
test("准备：建企业并入库", () => {
  A = library.createCompany({ name: "甲公司" }).company;
  B = library.createCompany({ name: "乙公司" }).company;
  artA = library.addArticle(A.id, { title: "云原生数据库迁移实践", body: BODY_A, sourceUrl: "https://x.com/a", normalizedUrl: "https://x.com/a", collectStatus: "success" }).article;
  artB = library.addArticle(B.id, { title: "产品定价完全公开", body: BODY_B, sourceUrl: "https://y.com/b", normalizedUrl: "https://y.com/b", collectStatus: "success" }).article;
  assert.ok(A.id && B.id && artA.id && artB.id);
});

test("企业隔离：A 的检索不返回 B 的文章", () => {
  library.invalidateIndex(A.id);
  library.invalidateIndex(B.id);
  const ra = library.search(A.id, "定价");
  assert.equal(ra.hits.length, 0, "A 企业不应命中 B 企业的内容");
  const rb = library.search(B.id, "定价");
  assert.ok(rb.hits.length >= 1);
  assert.ok(rb.hits.every((h) => h.articleId === artB.id));
});

test("单字不会造成误命中", () => {
  library.invalidateIndex(A.id);
  /* 「定」只出现在 A 的「决定/确定」这类词里，但检索「定价」不应命中 */
  const r = library.search(A.id, "定价");
  assert.equal(r.hits.length, 0);
});

test("排除文章后不再参与检索", () => {
  library.updateArticleMeta(A.id, artA.id, { excluded: true });
  library.invalidateIndex(A.id);
  const r = library.search(A.id, "云原生数据库");
  assert.equal(r.hits.length, 0);
  library.updateArticleMeta(A.id, artA.id, { excluded: false });
  library.invalidateIndex(A.id);
  assert.ok(library.search(A.id, "云原生数据库").hits.length >= 1);
});

test("删除文章后检索不再返回它", () => {
  const tmp = library.addArticle(A.id, { title: "临时文章", body: "临时内容待删除，用于验证删除后失效。", sourceUrl: "https://x.com/tmp", normalizedUrl: "https://x.com/tmp", collectStatus: "success" }).article;
  library.invalidateIndex(A.id);
  assert.ok(library.search(A.id, "临时内容").hits.some((h) => h.articleId === tmp.id));
  library.deleteArticle(A.id, tmp.id);
  library.invalidateIndex(A.id);
  assert.ok(!library.search(A.id, "临时内容").hits.some((h) => h.articleId === tmp.id));
});

test("同一链接重新采集：创建新版本而不是覆盖", () => {
  const before = library.getArticle(A.id, artA.id).version;
  const r = library.updateArticleBody(A.id, artA.id, BODY_A + "\n补充一段新的内容。", { reason: "collect" });
  assert.equal(r.changed, true);
  assert.equal(r.version, before + 1);
  const a = library.getArticle(A.id, artA.id);
  assert.ok(a.versions.length >= 2, "旧版本要留档");
});

test("正文指纹相同则不产生新版本", () => {
  const cur = library.getArticle(A.id, artA.id);
  const r = library.updateArticleBody(A.id, artA.id, cur.body, { reason: "collect" });
  assert.equal(r.changed, false);
});

test("风格档案：样本不足时如实提示", () => {
  const r = styleProfile.analyzeByRules([library.getArticle(A.id, artA.id)]);
  assert.equal(r.ok, true);
  assert.equal(r.profile.sufficiency.enough, false);
  assert.match(r.profile.sufficiency.message, /样本/);
});

test("风格档案：样本足够时给出置信度", () => {
  const arts = [];
  for (let i = 0; i < 5; i++) {
    arts.push(library.addArticle(A.id, {
      title: "样本 " + i, body: BODY_A + "第" + i + "段补充内容，介绍我们的实践与取舍。" + i,
      sourceUrl: "https://x.com/s" + i, normalizedUrl: "https://x.com/s" + i, collectStatus: "success",
    }).article);
  }
  library.invalidateIndex(A.id);
  const r = styleProfile.analyzeByRules(arts);
  assert.equal(r.ok, true);
  assert.ok(r.profile.confidence > 0.5);
  assert.equal(r.profile.sufficiency.enough, true);
  /* 事实与表达习惯分开 */
  assert.ok(r.profile.facts);
  assert.ok(Array.isArray(r.profile.facts.confirmed));
  assert.equal(r.profile.facts.confirmed.length, 0, "历史文章不能自动变成当前事实");
});

test("风格档案：用户手动修订在重新分析后保留", () => {
  const cur = library.getStyleProfile(A.id) || { style: {} };
  library.saveStyleProfile(A.id, Object.assign({}, cur, { manualRules: ["不要用「赋能」"] }));
  const again = styleProfile.analyzeByRules([library.getArticle(A.id, artA.id)]);
  const saved = library.saveStyleProfile(A.id, again.profile);
  assert.equal(saved.profile.manualRules.length, 1);
  assert.equal(saved.profile.manualRules[0], "不要用「赋能」");
});

test("写作上下文：带企业时返回资料片段与来源 ID", () => {
  library.invalidateIndex(A.id);
  const r = writingContext.buildContext({ companyId: A.id, query: "云原生数据库迁移" });
  assert.equal(r.ok, true);
  assert.equal(r.context.usedLibrary, true);
  assert.ok(r.context.materials.length >= 1);
  assert.ok(r.context.materials[0].sourceId, "资料片段必须带来源 ID");
  assert.ok(r.context.blocks.materials.includes("不是写作指令"), "样文必须声明不是指令");
});

test("写作上下文：没有企业时不使用任何企业资料", () => {
  const r = writingContext.buildContext({ companyId: "", query: "测试" });
  assert.equal(r.ok, true);
  assert.equal(r.context.usedLibrary, false);
  assert.equal(r.context.materials.length, 0);
});

test("写作上下文：选了企业但没资料且要求严格时报错", () => {
  const empty = library.createCompany({ name: "空企业" }).company;
  const r = writingContext.buildContext({ companyId: empty.id, query: "任意", requireLibrary: true });
  assert.equal(r.ok, false);
  assert.equal(r.needConfirmation, true);
  assert.match(r.reason, /没有可用|资料/);
});

test("写作上下文：有资料但没匹配上时也提示", () => {
  const r = writingContext.buildContext({ companyId: A.id, query: "完全不相关的量子计算与拓扑绝缘体", requireLibrary: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有匹配/);
});

test("写作上下文：上下文有预算上限，不会把整库塞进去", () => {
  for (let i = 0; i < 12; i++) {
    library.addArticle(A.id, {
      title: "长文 " + i, body: BODY_A.repeat(20) + "第" + i + "篇",
      sourceUrl: "https://x.com/L" + i, normalizedUrl: "https://x.com/L" + i, collectStatus: "success",
    });
  }
  library.invalidateIndex(A.id);
  const r = writingContext.buildContext({ companyId: A.id, query: "云原生数据库" });
  const totalChars = r.context.materials.reduce((s, m) => s + m.excerpt.length, 0);
  assert.ok(totalChars <= writingContext.BUDGET.facts + 2000, "资料片段总量要受预算约束，实际 " + totalChars);
  assert.ok(r.context.materials.length <= writingContext.MAX_SNIPPETS, "资料片段条数也要有上限");
});

test("写作上下文：缺关键事实时列出待补项，不编造", () => {
  const r = writingContext.buildContext({ companyId: A.id, query: "这次活动的时间与地点" });
  assert.ok(Array.isArray(r.context.missingFacts));
});

test("引用记录可保存并追溯", () => {
  const r = library.saveCitation(A.id, { action: "write", topic: "测试主题", styleVersion: 2, snapshot: [{ title: "x" }] });
  assert.equal(r.ok, true);
  const list = library.listCitations(A.id);
  assert.ok(list.length >= 1);
  assert.equal(list[0].topic, "测试主题");
  assert.equal(list[0].styleVersion, 2);
});

test("切到别的企业后，上下文不包含原企业的文章", () => {
  library.invalidateIndex(B.id);
  const r = writingContext.buildContext({ companyId: B.id, query: "定价" });
  const ids = r.context.materials.map((m) => m.articleId);
  assert.ok(ids.every((id) => id === artB.id), "只应引用 B 企业的文章");
});
