/*
 * 公众号 Markdown 解析
 * ------------------------------------------------------------
 * 把 Markdown 正文解析成一串「块」结构，交给 lib/gzh-render.js 按主题渲染。
 *
 * 只做解析，不做样式 —— 样式全部在渲染层按主题令牌生成。
 *
 * 块类型：
 *   heading   { level, text }          章节标题（## / ###）
 *   paragraph { text }                 正文段落（已合并软换行）
 *   quote     { text }                 引用块（> 开头，连续多行合并）
 *   code      { lang, lines }          围栏代码块
 *   list      { ordered, items[] }     有序 / 无序列表
 *   image     { src, alt }             独立成段的图片
 *   divider   {}                       分隔线
 *   table     { head[], rows[][] }      表格
 *
 * 行内标记保留为轻量标记，交由渲染层转成内联 span：
 *   **粗体**  *斜体*  `行内代码`  ==高亮==  ++下划线++  ~~删除线~~  [文字](链接)
 */

"use strict";

/* ------------------------------------------------------------------ *
 * 行内解析
 * ------------------------------------------------------------------ */

/**
 * 把一行文本切成 token 序列。
 * 输出的 token：{ t: "text"|"bold"|"italic"|"code"|"mark"|"underline"|"del"|"link", v: 值, href? }
 */
function parseInline(src) {
  const text = String(src == null ? "" : src);
  const out = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    /* 行内代码优先 —— 里面的内容不参与任何其它规则 */
    if (rest[0] === "`") {
      const m = /^`([^`]+)`/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "code", v: m[1] });
        i += m[0].length;
        continue;
      }
    }

    /* **粗体** */
    if (rest.startsWith("**")) {
      const m = /^\*\*([^*]+)\*\*/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "bold", v: m[1] });
        i += m[0].length;
        continue;
      }
    }

    /* ==高亮== */
    if (rest.startsWith("==")) {
      const m = /^==([^=]+)==/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "mark", v: m[1] });
        i += m[0].length;
        continue;
      }
    }

    /* ++下划线++ */
    if (rest.startsWith("++")) {
      const m = /^\+\+([^+\s][^+]*)\+\+/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "underline", v: m[1] });
        i += m[0].length;
        continue;
      }
    }

    /* ~~删除线~~ */
    if (rest.startsWith("~~")) {
      const m = /^~~([^~]+)~~/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "del", v: m[1] });
        i += m[0].length;
        continue;
      }
    }

    /* *斜体* —— 放在粗体之后，避免 ** 被当成斜体 */
    if (rest[0] === "*") {
      const m = /^\*([^*\n]+)\*/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "italic", v: m[1] });
        i += m[0].length;
        continue;
      }
    }

    /* [文字](链接) */
    if (rest[0] === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "link", v: m[1], href: m[2] });
        i += m[0].length;
        continue;
      }
    }

    buf += rest[0];
    i += 1;
  }
  flush();
  return out;
}

/** 只取纯文本（用于自动编号、英文标签推断等） */
function plainText(src) {
  return parseInline(src)
    .map((tk) => tk.v)
    .join("");
}

/* ------------------------------------------------------------------ *
 * 块级解析
 * ------------------------------------------------------------------ */

const RE_FENCE = /^```([^\s`]*)\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*(\d+)[.)]\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_DIVIDER = /^\s*([-*_])\s*(\1\s*){2,}$/;
const RE_IMAGE_ONLY = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

/**
 * 解析 Markdown 正文。
 * @param {string} md
 * @returns {Array} 块数组
 */
function parseMarkdown(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  const isTableSep = (s) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s) && s.indexOf("-") >= 0;

  while (i < lines.length) {
    const line = lines[i];

    /* 空行 */
    if (!line.trim()) {
      i += 1;
      continue;
    }

    /* 围栏代码块 */
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const body = [];
      i += 1;
      while (i < lines.length && !RE_FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 吃掉收尾围栏
      /* 去掉首尾空行，避免代码块里出现多余空行 */
      while (body.length && !body[0].trim()) body.shift();
      while (body.length && !body[body.length - 1].trim()) body.pop();
      blocks.push({ type: "code", lang, lines: body });
      continue;
    }

    /* 分隔线 */
    if (RE_DIVIDER.test(line)) {
      blocks.push({ type: "divider" });
      i += 1;
      continue;
    }

    /* 标题 */
    const h = RE_HEADING.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }

    /* 表格：当前行含 | 且下一行是分隔行 */
    if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    /* 独立成段的图片 */
    const img = RE_IMAGE_ONLY.exec(line);
    if (img) {
      blocks.push({ type: "image", src: img[2], alt: img[1] });
      i += 1;
      continue;
    }

    /* 引用块（连续 > 行合并） */
    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(RE_QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      blocks.push({ type: "quote", text: buf.join(" ").trim() });
      continue;
    }

    /* 列表 */
    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = RE_OL.test(line);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = ordered ? RE_OL.exec(l) : RE_UL.exec(l);
        if (!m) {
          /* 列表项的续行（缩进）并入上一项 */
          if (items.length && /^\s+\S/.test(l) && !RE_HEADING.test(l)) {
            items[items.length - 1] += " " + l.trim();
            i += 1;
            continue;
          }
          break;
        }
        items.push((ordered ? m[2] : m[1]).trim());
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    /* 段落：连续非空行合并（软换行折叠成空格） */
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (
        RE_HEADING.test(l) ||
        RE_FENCE.test(l) ||
        RE_QUOTE.test(l) ||
        RE_DIVIDER.test(l) ||
        RE_UL.test(l) ||
        RE_OL.test(l) ||
        RE_IMAGE_ONLY.test(l)
      ) {
        break;
      }
      para.push(l.trim());
      i += 1;
    }
    if (para.length) blocks.push({ type: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/* ------------------------------------------------------------------ *
 * 结构分析：章节切分、编号、英文标签
 * ------------------------------------------------------------------ */

/** 结语类章节的判定词（命中则编号用 ∞ / LAST） */
const ENDING_WORDS = ["总结", "结语", "写在最后", "后记", "尾声", "小结", "展望", "终章"];

/**
 * 把块数组切成「章节」结构。
 * # 一级标题视为文章标题（不单独成章节），## 为章节，### 为子标题。
 * @returns {{ title: string, intro: Array, sections: Array }}
 */
function analyze(blocks) {
  const title = "";
  let intro = [];
  const sections = [];
  let current = null;

  for (const b of blocks) {
    if (b.type === "heading" && b.level === 1 && !sections.length && !current) {
      continue; // 文章标题单独取
    }
    if (b.type === "heading" && b.level <= 2) {
      if (current) sections.push(current);
      current = { title: b.text, blocks: [] };
      continue;
    }
    if (!current) {
      intro.push(b);
    } else {
      current.blocks.push(b);
    }
  }
  if (current) sections.push(current);

  /* 编号：01 / 02 …，结语章用 ∞ */
  const total = sections.length;
  sections.forEach((s, idx) => {
    const isLast = idx === total - 1;
    s.no = String(idx + 1).padStart(2, "0");
    s.isLast = isLast && total > 1;
    if (s.isLast && ENDING_WORDS.some((w) => s.title.includes(w))) {
      s.no = "∞";
      s.isEnding = true;
    }
  });

  return { title, intro, sections };
}

/**
 * 从中文章节标题推断英文标签。
 * 依据 gzh-design 的约定：实测→TEST、教程→TUTORIAL、总结→SUMMARY 等。
 */
const EN_LABEL_MAP = [
  [/(实测|测评|评测|测试|对比)/, "TEST"],
  [/(教程|入门|上手|指南|怎么|如何|步骤|实操)/, "TUTORIAL"],
  [/(总结|复盘|小结|回顾)/, "SUMMARY"],
  [/(思考|观点|思考|想法)/, "THOUGHTS"],
  [/(清单|盘点|工具|推荐|合集)/, "PICK"],
  [/(原理|机制|架构|源码|实现|原理)/, "INSIDE"],
  [/(案例|实战|项目|经验)/, "CASE"],
  [/(方法|技巧|效率|实践)/, "METHOD"],
  [/(故事|随笔|记录|日记)/, "STORY"],
  [/(趋势|观察|解读|分析|报告)/, "INSIGHT"],
];

function englishLabel(title) {
  const t = String(title || "");
  for (const [re, label] of EN_LABEL_MAP) {
    if (re.test(t)) return label;
  }
  return "CHAPTER";
}

module.exports = {
  parseMarkdown,
  parseInline,
  plainText,
  analyze,
  englishLabel,
  ENDING_WORDS,
};
