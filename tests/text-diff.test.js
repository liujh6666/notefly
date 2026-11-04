/*
 * 回归用例：文本改动定位（lib/text-diff.js）
 * 覆盖：区间正确性、与去 AI 味真实输出的配合、HTML 转义与越界防护、超限放弃。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const textDiff = require("../lib/text-diff");
const textTools = require("../lib/text-tools");

const slice = (src, ranges) => ranges.map(([s, e]) => src.slice(s, e));

test("相同文本不产生标记", () => {
  const r = textDiff.diffMarkRanges("你好世界", "你好世界");
  assert.equal(r.before.length, 0);
  assert.equal(r.after.length, 0);
  assert.equal(r.skipped, false);
});

test("单处替换：原文标旧词、处理后标新词", () => {
  const a = "当底层能力不再是稀缺资源";
  const b = "当基础能力不再是稀缺资源";
  const r = textDiff.diffMarkRanges(a, b);
  assert.deepEqual(slice(a, r.before), ["底层"]);
  assert.deepEqual(slice(b, r.after), ["基础"]);
});

test("删除片段：只标原文侧", () => {
  const a = "我们能够有效地提升整体的效率。";
  const b = "我们能够提升整体的效率。";
  const r = textDiff.diffMarkRanges(a, b);
  assert.ok(slice(a, r.before).some((t) => t.includes("有效地")));
  assert.deepEqual(slice(a, r.before).join(""), "有效地");
});

test("区间不越界、不重叠且按顺序排列", () => {
  const a = "总而言之，这是一个非常机械的表达。真正的要点是场景与数据。";
  const b = "总而言之，真正的要点是场景与数据。";
  const r = textDiff.diffMarkRanges(a, b);
  const ordered = (rs) => rs.every(([s, e], i) => e > s && (i === 0 || s >= rs[i - 1][1]));
  assert.ok(ordered(r.before));
  assert.ok(ordered(r.after));
  for (const [s, e] of r.before) { assert.ok(s >= 0 && e <= a.length); }
  for (const [s, e] of r.after) { assert.ok(s >= 0 && e <= b.length); }
});

test("与去 AI 味真实输出配合：替换 / 删段都能标出来", () => {
  const src = "当底层能力不再是稀缺资源。\n\n总而言之，这是一个非常重要的问题。我们通过不断的探索，能够有效地提升整体的效率。";
  const r = textTools.humanizeText(src, { level: "strong" });
  const m = textDiff.diffMarkRanges(src, r.text);
  assert.equal(m.skipped, false);
  const beforeText = slice(src, m.before).join("");
  assert.ok(beforeText.includes("底层"), "原文侧应标出被替换的抽象词");
  /* 处理后侧标记拼回原文 = 原文与处理后不一致的总量有限，标记数不超过上限 */
  assert.ok(m.after.length <= 400);
});

test("markHtml 转义正文并只在区间外套标签", () => {
  const html = textDiff.markHtml('a<b & "c"d', [[0, 1]], "tt-hit");
  assert.equal(html, '<mark class="tt-hit">a</mark>&lt;b &amp; &quot;c&quot;d');
});

test("markHtml 忽略非法区间", () => {
  const html = textDiff.markHtml("abc", [[5, 9], [1, 1]], "tt-hit");
  assert.equal(html, "abc");
});

test("文本过长时放弃标记并置 skipped", () => {
  const a = "甲".repeat(21000) + "乙";
  const b = "甲".repeat(21000) + "丙";
  const r = textDiff.diffMarkRanges(a, b);
  assert.equal(r.before.length, 0);
  assert.equal(r.after.length, 0);
  assert.equal(r.skipped, true);
});
