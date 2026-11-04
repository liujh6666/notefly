/*
 * 回归用例 7：文本工具引擎（一键排版 + 去 AI 味）
 * 对应的核心约束：
 *   - 代码块 / 行内代码 / 链接 URL 一律不能被改；
 *   - 只做保守改写，不能把语义改坏；
 *   - 同一输入跑两次结果必须一致（幂等）；
 *   - 离线可用，不依赖任何网络。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const tt = require("../lib/text-tools");

/* ==================== 一键排版 ==================== */

test("排版：标题补空格、去掉结尾多余的 #", () => {
  const r = tt.formatMarkdown("#标题\n## 小节 ##\n");
  assert.match(r.text, /^# 标题$/m);
  assert.match(r.text, /^## 小节$/m);
});

test("排版：列表符号统一为 -，有序列表统一为 1.", () => {
  const r = tt.formatMarkdown("* a\n+ b\n1) c\n2. d\n");
  assert.match(r.text, /^- a$/m);
  assert.match(r.text, /^- b$/m);
  assert.match(r.text, /^1\. c$/m);
  assert.match(r.text, /^2\. d$/m);
});

test("排版：嵌套列表缩进折算成 2 空格一层", () => {
  const r = tt.formatMarkdown("- 一级\n    - 二级\n        - 三级\n");
  const lines = r.text.split("\n");
  assert.equal(lines[0], "- 一级");
  assert.equal(lines[1], "  - 二级");
  assert.equal(lines[2], "    - 三级");
});

test("排版：引用块补空格，分隔线统一为 ---", () => {
  const r = tt.formatMarkdown(">引用\n***\n");
  assert.match(r.text, /^> 引用$/m);
  assert.match(r.text, /^---$/m);
});

test("排版：中英文之间补空格", () => {
  const r = tt.formatMarkdown("使用 Node.js 和 Vue3 开发\n");
  assert.match(r.text, /使用 Node\.js 和 Vue3 开发/);
});

test("排版：中文语境的半角标点转全角", () => {
  const r = tt.formatMarkdown("这是句子,下一句.\n");
  assert.match(r.text, /这是句子，下一句。/);
});

test("排版：表格补齐缺失列并规范分隔行", () => {
  const r = tt.formatMarkdown("| 名称 | 说明 | 备注 |\n|---|---|\n| a | 说明 |\n");
  const lines = r.text.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "| a | 说明 |  |");
  assert.equal(lines[1].split("|").length, lines[0].split("|").length);
});

test("排版：加粗与斜体标记统一", () => {
  const r = tt.formatMarkdown("__粗__ 和 _斜_\n");
  assert.match(r.text, /\*\*粗\*\*/);
  assert.match(r.text, /\*斜\*/);
});

test("排版：代码块内容一个字都不能动", () => {
  const src = "```js\nconst a = 1;  // 保持原样,不要改\nconst  b   =   2;\n```\n";
  const r = tt.formatMarkdown(src, { level: "strong" });
  assert.match(r.text, /const a = 1;  \/\/ 保持原样,不要改/);
  assert.match(r.text, /const  b   =   2;/);
});

test("排版：行内代码内容不能动", () => {
  const r = tt.formatMarkdown("调用 `a  ,  b` 这个函数\n");
  assert.match(r.text, /`a  ,  b`/);
});

test("排版：链接的 URL 不能动", () => {
  const r = tt.formatMarkdown("见 https://example.com/a,b?x=1,2 链接\n");
  assert.match(r.text, /https:\/\/example\.com\/a,b\?x=1,2/);
});

test("排版：压缩多余空行", () => {
  const r = tt.formatMarkdown("一\n\n\n\n二\n");
  assert.equal(r.text, "一\n\n二");
});

test("排版：幂等 —— 跑两次结果一致", () => {
  const src = "#标题\n\n* a\n    * b\n\n这,是.测试\n\n```js\nconst a=1;\n```\n";
  const once = tt.formatMarkdown(src, { level: "medium" }).text;
  const twice = tt.formatMarkdown(once, { level: "medium" }).text;
  assert.equal(twice, once);
});

test("排版：空输入不崩", () => {
  assert.equal(tt.formatMarkdown("", {}).text, "");
  assert.equal(tt.formatMarkdown(null, {}).text, "");
  assert.equal(tt.formatMarkdown(undefined, {}).text, "");
});

test("排版：返回改动明细", () => {
  const r = tt.formatMarkdown("#标题\n\n* a\n");
  assert.ok(Array.isArray(r.changes));
  assert.ok(r.changes.length > 0);
  assert.ok(r.changes.every((c) => c.rule && c.label));
});

/* ==================== 去 AI 味 ==================== */

test("去AI味：删除空转插入语", () => {
  const r = tt.humanizeText("值得注意的是，这个方案不错。众所周知，Node.js 很成熟。", { level: "medium" });
  assert.ok(!r.text.includes("值得注意的是"));
  assert.ok(!r.text.includes("众所周知"));
  assert.match(r.text, /这个方案不错/);
  assert.match(r.text, /Node\.js 很成熟/);
});

test("去AI味：抽象词降级", () => {
  const r = tt.humanizeText("我们要通过赋能团队构建业务闭环。", { level: "medium" });
  assert.ok(!r.text.includes("赋能"));
  assert.ok(!r.text.includes("闭环"));
});

test("去AI味：拆解「不仅…而且…」", () => {
  const r = tt.humanizeText("这不仅提升了效率，而且还降低了成本。", { level: "medium" });
  assert.ok(!r.text.includes("不仅"));
  assert.ok(!r.text.includes("而且"));
  assert.match(r.text, /提升了效率[，,]还?降低了成本/);
});

test("去AI味：拆解「通过…我们能够…」", () => {
  const r = tt.humanizeText("通过这种方式，我们能够显著提升效率。", { level: "medium" });
  assert.ok(!r.text.includes("我们能够"));
});

test("去AI味：删除「在…的时代」整句式，不留残句", () => {
  const r = tt.humanizeText("在当今这个快速发展的时代，技术变化很快。", { level: "medium" });
  assert.ok(!r.text.includes("快速发展的时代"));
  assert.match(r.text, /技术变化很快/);
});

test("去AI味：删除序号式过渡", () => {
  const r = tt.humanizeText("首先要做准备。其次要执行。最后要复盘。", { level: "medium" });
  assert.ok(!r.text.includes("首先"));
  assert.ok(!r.text.includes("其次"));
  assert.ok(!r.text.includes("最后"));
});

test("去AI味：感叹号改句号、破折号改逗号", () => {
  const r = tt.humanizeText("这太棒了！这是重点——一定要记住。", { level: "medium" });
  assert.ok(!r.text.includes("！"));
  assert.ok(!r.text.includes("——"));
});

test("去AI味：移除 emoji", () => {
  const r = tt.humanizeText("发布成功 🚀 继续加油 🔥", { level: "medium" });
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(r.text));
  assert.match(r.text, /发布成功/);
});

test("去AI味：代码块与行内代码完全不动", () => {
  const src = "```js\n// 值得注意的是，这不是废话\nconst  a=1;\n```\n\n调用 `赋能` 这个词。\n";
  const r = tt.humanizeText(src, { level: "strong" });
  assert.match(r.text, /\/\/ 值得注意的是，这不是废话/);
  assert.match(r.text, /const  a=1;/);
  assert.match(r.text, /`赋能`/);
});

test("去AI味：light 级别只做最轻的改动", () => {
  const r = tt.humanizeText("值得注意的是，这个方案通过赋能实现闭环。", { level: "light" });
  assert.ok(!r.text.includes("值得注意的是"));
  /* light 不应该动抽象词 */
  assert.match(r.text, /赋能/);
});

test("去AI味：strong 级别删掉总结性尾段", () => {
  const r = tt.humanizeText("正文内容在这里。\n\n总而言之，这篇文章讲了一件事。", { level: "strong" });
  assert.ok(!r.text.includes("总而言之"));
  assert.match(r.text, /正文内容在这里/);
});

test("去AI味：幂等 —— 跑两次结果一致", () => {
  const src = "首先，值得注意的是，通过赋能的方式构建闭环，不仅快而且稳。\n\n其次，这极大地提效了！🚀\n";
  const once = tt.humanizeText(src, { level: "medium" }).text;
  const twice = tt.humanizeText(once, { level: "medium" }).text;
  assert.equal(twice, once);
});

test("去AI味：空输入不崩", () => {
  assert.equal(tt.humanizeText("", {}).text, "");
  assert.equal(tt.humanizeText(null, {}).text, "");
});

test("去AI味：返回改动明细与命中统计", () => {
  const r = tt.humanizeText("首先，值得注意的是，这个方案通过赋能实现闭环。", { level: "medium" });
  assert.ok(r.changes.length > 0);
  assert.ok(r.stats.hitCount > 0);
  assert.ok(r.stats.ruleCount > 0);
});

/* ==================== AI 味体检 ==================== */

test("体检：干净文章得 0 分", () => {
  const clean = "上周把构建流程换成了增量编译，冷启动从 90 秒降到 8 秒。代价是缓存偶尔失效，需要手动清一次。";
  const a = tt.analyzeAiStyle(clean);
  assert.equal(a.hitsCount, 0);
  assert.equal(a.score, 0);
  assert.equal(a.level, "low");
});

test("体检：AI 味文章得高分", () => {
  const a = tt.analyzeAiStyle(
    "首先，值得注意的是，在当今这个快速发展的时代，通过赋能的方式，我们能够构建完整的业务闭环，这极大地提升了效率！🚀 总而言之，这是一个成功的赋能。"
  );
  assert.ok(a.score >= 50, "score=" + a.score);
  assert.equal(a.level, "high");
  assert.ok(a.hitsCount >= 5);
});

test("体检：长文不会因为篇幅大而必然满分", () => {
  const clean = "这里是一段没有任何套话的技术描述。".repeat(100);
  const a = tt.analyzeAiStyle(clean);
  assert.ok(a.score <= 20, "score=" + a.score);
});

test("体检：检测句长过于均匀的机械节奏", () => {
  const even = "这个方案很好用。性能提升很明显。上手非常简单。文档也很完整。";
  const a = tt.analyzeAiStyle(even);
  assert.ok(a.hits.some((h) => h.kind === "rhythm"), JSON.stringify(a.hits));
});

test("体检：空输入不崩", () => {
  const a = tt.analyzeAiStyle("");
  assert.equal(a.score, 0);
  assert.equal(a.hitsCount, 0);
});

/* ==================== 保护段 ==================== */

test("保护段：抽走与还原是无损的", () => {
  const src = "看 `code` 和 [链接](https://a.b/c) 以及 <b>标签</b>";
  const p = tt.protectSegments(src, [/`[^`\n]+`/g, /<[^<>]+>/g, /\[[^\]]*\]\s*\([^)]+\)/g]);
  assert.notEqual(p.text, src);
  assert.equal(p.restore(p.text), src);
});
