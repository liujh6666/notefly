/*
 * 公众号排版引擎单元测试
 * ------------------------------------------------------------
 * 覆盖：Markdown 解析、主题令牌、渲染引擎、微信合规校验。
 *
 * 微信平台的限制是硬约束 —— 一旦产出违规 HTML，粘贴进公众号会掉样式，
 * 所以这里对每套主题都跑一遍合规校验，而不是只测一个主题。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const md = require("../lib/gzh-markdown");
const themes = require("../lib/gzh-themes");
const { renderGzh } = require("../lib/gzh-render");
const { validateGzhHtml } = require("../lib/gzh-validate");

const SAMPLE = `# 文章标题

> 一句金句，先抓住注意力。

## 第一节 概述

这一段提到性能提升了 35%，值得标记。**加粗**与==高亮==，还有 \`inline code\` 与 [链接](https://example.com)。

## 第二节 细节

- 列表项一
- 列表项二

\`\`\`js
const a = 1;
  console.log(a);
\`\`\`

![图片说明](https://example.com/a.png)

## 写在最后

结尾一段。`;

/* ------------------------------------------------------------------ *
 * 主题令牌
 * ------------------------------------------------------------------ */

test("主题清单有 7 套，且 id 唯一", () => {
  const list = themes.listThemes();
  assert.equal(list.length, 7);
  assert.equal(new Set(list.map((t) => t.id)).size, 7);
});

test("每套主题都有名称、场景与三个配色", () => {
  for (const t of themes.listThemes()) {
    assert.ok(t.name, t.id + " 缺 name");
    assert.ok(t.scene, t.id + " 缺 scene");
    assert.equal(t.swatch.length, 3, t.id + " 配色数不对");
  }
});

test("未知主题 id 回落到默认主题，不抛错", () => {
  const t = themes.getTheme("不存在的主题");
  assert.equal(t.id, themes.DEFAULT_THEME_ID);
});

test("下划线色与权威值一致（来自 theme-index）", () => {
  /* 这些是 gzh-design theme-index 里登记的权威值，改错会导致主题气质跑偏 */
  assert.equal(themes.getTheme("moyu-green").underline, "#A7F3D0");
  assert.equal(themes.getTheme("zhici-qinglv").underline, "#A5D1D2");
  assert.equal(themes.getTheme("red-white").underline, "#FECACA");
  assert.equal(themes.getTheme("graphite-minimal").underline, "#52525B");
  assert.equal(themes.getTheme("zen-whitespace").underline, "#B5C8BC");
  assert.equal(themes.getTheme("moyu-ticket").underline, "#A7F3D0");
  assert.equal(themes.getTheme("olive-journal").underline, "#ed7b2f");
});

/* ------------------------------------------------------------------ *
 * Markdown 解析
 * ------------------------------------------------------------------ */

test("解析出标题、引用、章节、列表、代码、图片", () => {
  const blocks = md.parseMarkdown(SAMPLE);
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("quote"));
  assert.ok(types.includes("paragraph"));
  assert.ok(types.includes("list"));
  assert.ok(types.includes("code"));
  assert.ok(types.includes("image"));
});

test("围栏代码块保留语言与原始行（含缩进）", () => {
  const blocks = md.parseMarkdown(SAMPLE);
  const code = blocks.find((b) => b.type === "code");
  assert.equal(code.lang, "js");
  assert.equal(code.lines.length, 2);
  assert.ok(code.lines[1].startsWith("  "), "代码缩进必须原样保留");
});

test("章节按出现顺序编号 01/02/03", () => {
  /* 用不带结语词的标题，避免最后一章被判成结语章（那才是 ∞） */
  const a = md.analyze(md.parseMarkdown("## 第一节\n\n正文。\n\n## 第二节\n\n正文。\n\n## 第三节\n\n正文。\n"));
  assert.equal(a.sections.length, 3);
  assert.deepEqual(a.sections.map((s) => s.no), ["01", "02", "03"]);
});

test("结语章用 ∞ 编号（末章 + 结语词）", () => {
  const a = md.analyze(md.parseMarkdown(SAMPLE));
  assert.equal(a.sections[2].no, "∞");
  assert.equal(a.sections[2].isEnding, true);
});

test("英文标签按标题关键词推断", () => {
  assert.equal(md.englishLabel("实测对比"), "TEST");
  assert.equal(md.englishLabel("新手教程"), "TUTORIAL");
  assert.equal(md.englishLabel("总结复盘"), "SUMMARY");
  assert.equal(md.englishLabel("随便起个名"), "CHAPTER");
});

test("行内标记解析成 token", () => {
  const tk = md.parseInline("**粗** ==亮== `码` ~~删~~ [链](https://a.com)");
  const kinds = tk.map((t) => t.t);
  assert.ok(kinds.includes("bold"));
  assert.ok(kinds.includes("mark"));
  assert.ok(kinds.includes("code"));
  assert.ok(kinds.includes("del"));
  assert.ok(kinds.includes("link"));
});

/* ------------------------------------------------------------------ *
 * 渲染引擎
 * ------------------------------------------------------------------ */

test("渲染出公众号正文片段（不含文档外壳）", () => {
  const r = renderGzh(SAMPLE, { themeId: "moyu-green" });
  assert.ok(r.html.startsWith("<section"), "必须是正文片段，不能包 html/head/body");
  assert.ok(!/<html|<head|<body/i.test(r.html), "不能有文档外壳");
  assert.ok(r.html.trim().endsWith("</section>"));
});

test("所有 7 套主题渲染结果都通过微信合规校验", () => {
  for (const t of themes.listThemes()) {
    const r = renderGzh(SAMPLE, { themeId: t.id, title: "标题", authorName: "爱吃桔子" });
    const c = validateGzhHtml(r.html);
    assert.equal(c.errors.length, 0, `${t.id} 有合规错误：${c.errors.join(" | ")}`);
    assert.equal(c.ok, true, `${t.id} 合规校验未通过`);
  }
});

test("渲染产物不含微信禁用元素", () => {
  const r = renderGzh(SAMPLE, { themeId: "red-white" });
  assert.ok(!/<div[\s>]/i.test(r.html), "不能有 div");
  assert.ok(!/<style[\s>]/i.test(r.html), "不能有 style 标签");
  assert.ok(!/\sclass\s*=/i.test(r.html), "不能有 class");
  assert.ok(!/\sid\s*=/i.test(r.html), "不能有 id");
  assert.ok(!/position\s*:\s*(fixed|absolute|sticky)/i.test(r.html), "不能用固定定位");
  assert.ok(!/display\s*:\s*grid/i.test(r.html), "不能用 grid");
  assert.ok(!/var\s*\(\s*--/.test(r.html), "不能用 CSS 变量");
});

test("所有文字节点都被 span leaf 包裹", () => {
  const r = renderGzh(SAMPLE, { themeId: "zen-whitespace" });
  const c = validateGzhHtml(r.html);
  assert.ok(c.spanLeafCount > 10, "span leaf 数量异常少：" + c.spanLeafCount);
  assert.equal(c.errors.length, 0);
});

test("章节标题带自动编号", () => {
  const r = renderGzh(SAMPLE, { themeId: "moyu-green" });
  assert.ok(r.html.includes(">01<") || r.html.includes('leaf="">01'), "应有 01 编号");
  assert.ok(r.html.includes("PART"), "应有 PART 标签");
});

test("章节 ≥3 时生成目录", () => {
  const r = renderGzh(SAMPLE, { themeId: "moyu-green" });
  assert.ok(r.html.includes("CONTENTS"), "3 章以上应有目录");
});

test("章节 <3 时不生成目录", () => {
  const r = renderGzh("## 只有一章\n\n正文。\n", { themeId: "moyu-green" });
  assert.ok(!r.html.includes("CONTENTS"), "不足 3 章不应有目录");
});

test("代码块逐行成 p（不能用 white-space:pre）", () => {
  const r = renderGzh(SAMPLE, { themeId: "moyu-green" });
  assert.ok(!/white-space\s*:\s*pre/i.test(r.html), "不能用 white-space:pre");
  assert.ok(r.html.includes("console.log(a);"), "代码内容必须保留");
});

test("代码块缩进用全角空格（源码空格会被原样渲染成大左缩进）", () => {
  const r = renderGzh("```\n  indented\n```\n", { themeId: "moyu-green" });
  assert.ok(r.html.includes("　　indented"), "缩进应转成全角空格");
});

test("签名区缺省留占位，不写死具体人名", () => {
  const r = renderGzh(SAMPLE, { themeId: "moyu-green" });
  assert.ok(r.html.includes("{{作者名}}"), "缺省应留占位");
  assert.ok(!r.html.includes("甲木"), "不能写死任何人名");
});

test("给了作者名则填进签名区", () => {
  const r = renderGzh(SAMPLE, { themeId: "moyu-green", authorName: "爱吃桔子" });
  assert.ok(r.html.includes("爱吃桔子"));
  assert.ok(!r.html.includes("{{作者名}}"));
});

test("关键词自动加下划线", () => {
  const r = renderGzh("## 标题\n\n> 这是「一句值得标记的金句」，很重要。\n", { themeId: "red-white" });
  assert.ok(/border-bottom:\s*2px solid #FECACA/.test(r.html), "红白主题应带粉色下划线");
});

test("关闭关键词标记则不下划线", () => {
  const r = renderGzh("## 标题\n\n> 这是「一句值得标记的金句」，很重要。\n", { themeId: "red-white", markKeywords: false });
  assert.ok(!/border-bottom:\s*2px solid #FECACA/.test(r.html), "关闭后不应有下划线");
});

test("中文标点转全角，代码块内保持原样", () => {
  const r = renderGzh("## 标题\n\n这是一句中文,应该用全角逗号。\n\n```\nconst x = 1, y = 2;\n```\n", { themeId: "moyu-green" });
  assert.ok(r.html.includes("，"), "正文半角逗号应转全角");
  assert.ok(r.html.includes("const x = 1, y = 2;"), "代码块内半角逗号必须原样保留");
});

test("空正文不报错，产出空片段", () => {
  const r = renderGzh("", { themeId: "moyu-green" });
  assert.equal(r.sectionCount, 0);
  assert.ok(r.html.includes("<section"));
});

test("未知主题回落到默认主题", () => {
  const r = renderGzh(SAMPLE, { themeId: "不存在" });
  assert.equal(r.themeId, themes.DEFAULT_THEME_ID);
});

test("不同主题产出不同视觉（主色不同）", () => {
  const a = renderGzh(SAMPLE, { themeId: "red-white" }).html;
  const b = renderGzh(SAMPLE, { themeId: "graphite-minimal" }).html;
  assert.notEqual(a, b);
  assert.ok(a.includes("#DC2626"));
  assert.ok(b.includes("#52525B"));
});

/* ------------------------------------------------------------------ *
 * 合规校验器
 * ------------------------------------------------------------------ */

test("校验器能抓出 div / style / class", () => {
  const c = validateGzhHtml('<div class="x"><style>a{}</style><p>文本</p></div>');
  assert.equal(c.ok, false);
  assert.ok(c.errors.length >= 3, "应报出多条错误");
});

test("校验器能抓出未包裹的文字", () => {
  const c = validateGzhHtml('<section><p>裸文字</p></section>');
  assert.equal(c.ok, false);
  assert.ok(c.errors.some((e) => /span leaf/.test(e)));
});

test("校验器抓出中文后半角标点（警告级）", () => {
  const c = validateGzhHtml('<section><p><span leaf="">中文,后面</span></p></section>');
  assert.ok(c.warnings.length >= 1, "应报半角标点警告");
});

test("合规产物校验通过", () => {
  const r = renderGzh(SAMPLE, { themeId: "olive-journal" });
  const c = validateGzhHtml(r.html);
  assert.equal(c.ok, true);
  assert.equal(c.warnings.length, 0);
});
