/*
 * P0 回归：一键排版不得改坏受保护片段（1104 审查报告 P0-1）
 * 这些用例在修复前应当失败 —— 它们就是复现用例。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { formatMarkdown } = require("../lib/text-tools");

/* 受保护片段必须逐字节出现在结果里 */
function assertPreserved(original, snippet, label) {
  const r = formatMarkdown(original);
  assert.ok(
    r.text.includes(snippet),
    `${label}：受保护片段被改坏。\n  期望包含: ${JSON.stringify(snippet)}\n  实际输出: ${JSON.stringify(r.text)}`
  );
  return r;
}

test("行内代码 + 链接混排：行内代码不被替换成链接", () => {
  const src = "运行 `npm install`，参见[文档](https://example.com)。";
  const r = formatMarkdown(src);
  assertPreserved(src, "`npm install`", "行内代码");
  assertPreserved(src, "[文档](https://example.com)", "链接");
  /* 原文里 `npm install` 在「运行」后面：结果不得把「运行」后面的内容变成链接 */
  const after = r.text.split("运行")[1] || "";
  assert.ok(
    after.includes("`npm install`"),
    "行内代码应保持在原位，实际：" + JSON.stringify(r.text)
  );
});

test("行内公式 + 链接混排：公式不被替换", () => {
  const src = "当 $x=1$ 时，见[说明](https://example.com/doc)。";
  assertPreserved(src, "$x=1$", "行内公式");
  assertPreserved(src, "[说明](https://example.com/doc)", "链接");
});

test("HTML 标签 + 链接混排：标签不被替换", () => {
  const src = "<b>加粗</b>文字，再看[链接](https://example.com)。";
  assertPreserved(src, "<b>加粗</b>", "HTML 标签");
  assertPreserved(src, "[链接](https://example.com)", "链接");
});

test("代码块里的连续空行不被压缩（多行字符串语义）", () => {
  const src = [
    "前文段落。",
    "",
    "```python",
    "s = \"\"\"a",
    "",
    "",
    "",
    "b\"\"\"",
    "```",
    "",
    "后文段落。",
  ].join("\n");
  const r = formatMarkdown(src);
  const block = r.text.slice(r.text.indexOf("```"), r.text.lastIndexOf("```") + 3);
  assert.ok(
    block.split("\n").length === 7,
    "代码块内 5 行（含 3 个空行）必须保持原样，实际：\n" + block
  );
});

test("同一篇混合文档连续排版两次，结果一致（幂等）", () => {
  const src = [
    "# 标题一",
    "",
    "运行 `npm install`，参见[文档](https://example.com)。公式 $a+b=c$ 与 <i>标签</i>。",
    "",
    "",
    "",
    "```js",
    "const x = 1;   // 代码",
    "",
    "",
    "const y = 2;",
    "```",
    "",
    "- 项目一",
    "- 项目二",
  ].join("\n");
  const once = formatMarkdown(src).text;
  const twice = formatMarkdown(once).text;
  assert.equal(twice, once, "排版必须幂等：\n一次:\n" + once + "\n\n两次:\n" + twice);
});
