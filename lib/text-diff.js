/*
 * 文本改动定位（锚点对齐）
 * ---------------------------------------------------------------------------
 * 用途：给「去 AI 味」弹窗打标记 —— 原文标出被改写的片段，处理后标出对应的新
 *       片段。只看字符是否相同，不依赖任何规则，所以规则怎么调整都不用额外维护
 *       「命中位置」。
 *
 * 算法（diff-match-patch 的锚点思路，比逐字符 Myers 简单且不会爆内存）：
 *   1. 先吃掉两侧的公共前缀；
 *   2. 从当前位置向后找一段「在两份文本里都出现」的最短公共锚点（锚点越长越可靠，
 *      所以按 8 → 5 → 3 → 2 逐级退化），锚点之前各自没对上的部分就是改动；
 *   3. 跳到锚点继续，直到文本结束。
 * 改动都是局部替换/删除，锚点通常在几十字符内就能找到，复杂度近似 O(n)。
 */

const MAX_LEN_SUM = 40000;   // 两侧字符数之和上限，超了就不标记（不拖慢主流程）
const SCAN_AHEAD = 90;       // 每次找锚点最多向后扫多少字符
const ANCHOR_LENS = [8, 5, 3, 2];

/** 从 a[i..] 与 b[j..] 找下一个公共锚点（a[i] !== b[j] 时调用）。
 *  搜索起点是 j（含）：纯删除场景里 b[j] 本身就是合法对齐点；
 *  而 t=0 且 pj=j 时意味着 a[i..] === b[j..]，与 a[i] !== b[j] 矛盾，不会零进度。 */
function findAnchor(a, i, b, j) {
  for (const len of ANCHOR_LENS) {
    const limit = Math.min(SCAN_AHEAD, a.length - i - len);
    let best = null;
    for (let t = 0; t <= limit; t++) {
      const anchor = a.slice(i + t, i + t + len);
      const pj = b.indexOf(anchor, j);
      if (pj < 0) continue;
      const cost = t + (pj - j);
      if (!best || cost < best.cost) best = { ai: i + t, bj: pj, cost };
      if (cost <= len) break;   // 已经很近，没必要继续找
    }
    if (best) return best;
  }
  return null;
}

/**
 * 找出两侧需要高亮的区间
 * @param {string} before 原文
 * @param {string} after  处理后
 * @param {{maxMarks?:number}} opts
 * @returns {{before:Array<[number,number]>, after:Array<[number,number]>, skipped:boolean}}
 *          区间左闭右开，按出现顺序排列；skipped=true 表示文本太不相似，放弃标记
 */
function diffMarkRanges(before, after, opts) {
  const a = String(before == null ? "" : before);
  const b = String(after == null ? "" : after);
  const maxMarks = (opts && opts.maxMarks) || 400;
  if (!a || !b || a === b) return { before: [], after: [], skipped: false };
  if (a.length + b.length > MAX_LEN_SUM) return { before: [], after: [], skipped: true };

  const beforeRanges = [];
  const afterRanges = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    /* 公共前缀 */
    while (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    if (i >= a.length || j >= b.length) break;

    const hit = findAnchor(a, i, b, j);
    if (!hit || (hit.ai <= i && hit.bj <= j)) break;   // 后半段完全不像或无进展，整体当改动处理

    if (hit.ai > i) beforeRanges.push([i, hit.ai]);
    if (hit.bj > j) afterRanges.push([j, hit.bj]);
    i = hit.ai;
    j = hit.bj;
  }
  if (i < a.length) beforeRanges.push([i, a.length]);
  if (j < b.length) afterRanges.push([j, b.length]);

  /* 纯空白/换行的改动不标（那多半是排版差异，不是 AI 味） */
  const keep = (ranges, src) => ranges.filter(([s, e]) => src.slice(s, e).trim().length > 0);
  const nb = keep(beforeRanges, a);
  const na = keep(afterRanges, b);
  if (nb.length > maxMarks || na.length > maxMarks) {
    return { before: [], after: [], skipped: true };
  }
  return { before: nb, after: na, skipped: false };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 生成带 <mark> 的安全 HTML（内容一律转义，只有 mark 标签是标记）
 * @param {string} text
 * @param {Array<[number,number]>} ranges
 * @param {string} cls mark 的 class
 */
function markHtml(text, ranges, cls) {
  const src = String(text == null ? "" : text);
  if (!ranges || !ranges.length) return escapeHtml(src);
  const parts = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos || e <= s || e > src.length) continue;
    if (s > pos) parts.push(escapeHtml(src.slice(pos, s)));
    parts.push('<mark class="' + (cls || "tt-hit") + '">' + escapeHtml(src.slice(s, e)) + "</mark>");
    pos = e;
  }
  if (pos < src.length) parts.push(escapeHtml(src.slice(pos)));
  return parts.join("");
}

module.exports = { diffMarkRanges, markHtml, escapeHtml };
