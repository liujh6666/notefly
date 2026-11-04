/*
 * 公众号排版渲染引擎
 * ------------------------------------------------------------
 * 把 Markdown 正文渲染成「可直接粘贴进微信公众号编辑器、样式不丢失」的 HTML。
 *
 * 取材自 gzh-design skill 的主题组件库，但做了关键改造：
 *   组件库（44KB Markdown）→ 设计令牌 + 参数化渲染函数（本文件）
 *   7 套主题共用一套组件语义，差异全部由 lib/gzh-themes.js 的令牌驱动。
 *
 * 微信平台铁律（全部在本文件强制遵守，渲染层不允许违反）：
 *   1. 禁 <style> / <script> / <div> / class / id / position:fixed|absolute|sticky
 *      / float / @media / @keyframes / display:grid / CSS 变量 —— 样式必须内联
 *   2. 所有非空文字节点必须包在 <span leaf=""> 里，否则粘贴后样式会被剥掉
 *   3. 装饰性空元素内部必须放 <span leaf=""><br></span> 占位，否则微信直接删元素
 *   4. 同一个 <p> 里不要混多个 font-size；不要把 font-size / border-bottom 打在
 *      <strong> 上 —— 微信编辑器会自动"纠正"并重写样式
 *   5. 代码块每行一个 <p style="margin:0">，缩进用全角空格，不要用 white-space:pre
 *   6. 正文中文标点用全角（代码块与行内代码除外）
 */

"use strict";

const { parseMarkdown, parseInline, plainText, analyze, englishLabel } = require("./gzh-markdown");
const { getTheme, DEFAULT_THEME_ID } = require("./gzh-themes");

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO_STACK = "'SF Mono',Consolas,Monaco,monospace";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 文字节点统一走这里 —— 保证一定被 span leaf 包裹 */
function leaf(text) {
  return `<span leaf="">${esc(text)}</span>`;
}

/**
 * 中文语境下的半角标点转全角。
 * 只在正文文字上做，代码块 / 行内代码 / URL 不受影响（调用方负责区分）。
 */
function cnPunct(text) {
  return String(text == null ? "" : text)
    .replace(/([一-鿿㐀-䶿])\s*,\s*/g, "$1，")
    .replace(/([一-鿿㐀-䶿])\s*;\s*/g, "$1；")
    .replace(/([一-鿿㐀-䶿])\s*!\s*/g, "$1！")
    .replace(/([一-鿿㐀-䶿])\s*\?\s*/g, "$1？")
    .replace(/([一-鿿㐀-䶿])\s*:\s*/g, "$1：")
    /* 中文引号内的直引号 → 弯引号 */
    .replace(/「([^」]*)」/g, "「$1」");
}

/** 半角直引号 → 中文弯引号（成对替换） */
function smartQuotes(text) {
  let s = String(text == null ? "" : text);
  let open = true;
  s = s.replace(/"/g, () => (open = !open) ? "“" : "”");
  s = s.replace(/'/g, "’");
  return s;
}

/** 全角空格（代码块缩进用） */
function ideoSpace(s) {
  return String(s == null ? "" : s).replace(/^([ \t]+)/, (m) => "　".repeat(m.length));
}

/* ------------------------------------------------------------------ *
 * 关键词自动标记（gzh-design 的核心特色：正文关键词下划线）
 * ------------------------------------------------------------------ */

/**
 * 从一段正文里挑出值得加下划线的关键短语。
 * 保守策略：只标明确信号（引号内的金句、带单位的数字），最多 2 个，避免满屏下划线。
 * @returns {Array<{start:number,end:number}>} 在原文字符串中的区间
 */
function pickKeywords(text) {
  const s = String(text || "");
  const hits = [];
  const seen = new Set();

  /* 金句：中文引号 / 书名号里的短句 */
  const quoteRe = /[「『“"]([^」』”"\n]{4,20})[」』”"]/g;
  let m;
  while ((m = quoteRe.exec(s)) !== null) {
    const body = m[1];
    const start = m.index + m[0].indexOf(body);
    if (!seen.has(body)) {
      seen.add(body);
      hits.push({ start, end: start + body.length, weight: 3 });
    }
  }

  /* 关键数据：数字 + 单位 */
  const numRe = /(\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|个|次|年|天|小时|分钟|秒|人|条|元|美元|条|行|点|分))/g;
  while ((m = numRe.exec(s)) !== null) {
    hits.push({ start: m.index, end: m.index + m[0].length, weight: 2 });
  }

  hits.sort((a, b) => b.weight - a.weight || a.start - b.start);

  /* 去重叠，最多留 2 个 */
  const picked = [];
  for (const h of hits) {
    if (picked.length >= 2) break;
    if (picked.some((p) => h.start < p.end && h.end > p.start)) continue;
    picked.push(h);
  }
  return picked.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ *
 * 行内标记渲染
 * ------------------------------------------------------------------ */

/**
 * 把一段文字渲染成内联样式片段。
 * @param {string} src 原始文本（可含行内标记）
 * @param {object} t 主题令牌
 * @param {object} opts { markKeywords: 是否自动加关键词下划线 }
 */
function renderInline(src, t, opts) {
  const tokens = parseInline(src);
  let out = "";

  for (const tk of tokens) {
    switch (tk.t) {
      case "code":
        out +=
          `<span style="background:#F1F5F9;color:${t.primary};padding:1px 6px;border-radius:4px;font-family:${MONO_STACK};font-size:${t.fontSize};">` +
          leaf(tk.v) +
          `</span>`;
        break;

      case "bold":
        /* 微信会自动重写 <strong> 的 font-size / border-bottom，所以只给颜色 */
        out += `<strong style="color:${t.primaryDeep};">${leaf(tk.v)}</strong>`;
        break;

      case "italic":
        out += `<em style="font-style:italic;color:${t.bodyColor};">${leaf(tk.v)}</em>`;
        break;

      case "mark":
        out +=
          `<span style="background:${t.accent};padding:1px 4px;border-radius:3px;font-weight:600;">` +
          leaf(tk.v) +
          `</span>`;
        break;

      case "underline":
        out +=
          `<span style="border-bottom:2px solid ${t.primary};font-weight:600;">${leaf(tk.v)}</span>`;
        break;

      case "del":
        out += `<span style="text-decoration:line-through;color:${t.faintColor};">${leaf(tk.v)}</span>`;
        break;

      case "link":
        out +=
          `<a href="${esc(tk.href)}" style="color:${t.primary};text-decoration:none;border-bottom:1px solid ${t.underline};">` +
          leaf(tk.v) +
          `</a>`;
        break;

      default: {
        /* 纯文本：自动加关键词下划线 */
        const raw = tk.v;
        if (opts && opts.markKeywords) {
          const spans = pickKeywords(raw);
          if (spans.length) {
            let pos = 0;
            for (const sp of spans) {
              if (sp.start > pos) out += leaf(cnPunct(raw.slice(pos, sp.start)));
              const kw = raw.slice(sp.start, sp.end);
              out +=
                `<span style="border-bottom:${t.underlineWeight} solid ${t.underline};font-weight:600;">` +
                leaf(cnPunct(kw)) +
                `</span>`;
              pos = sp.end;
            }
            if (pos < raw.length) out += leaf(cnPunct(raw.slice(pos)));
            break;
          }
        }
        out += leaf(cnPunct(smartQuotes(raw)));
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

/** 章节标题 —— 5 种形态，按主题令牌的 heading 字段选择 */
function renderChapter(s, t, isFirst) {
  const no = s.no;
  const en = englishLabel(s.title);
  const marginTop = isFirst ? "16px" : t.sectionGap;

  if (t.heading === "badge") {
    /* 红白色系：红底编号标签 + 标题 + 底部粗线 */
    const badge = s.isEnding ? "∞" : no;
    return (
      `<section style="margin-top:${marginTop};margin-bottom:28px;padding:0 ${t.padX};">` +
      `<section style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:3px solid ${t.primary};">` +
      `<section style="display:flex;align-items:center;">` +
      `<span style="display:inline-block;background:${t.primary};color:#FFFFFF;font-size:18px;font-weight:900;padding:4px 14px;border-radius:6px;margin-right:14px;line-height:1.3;">${leaf(badge)}</span>` +
      `<section>` +
      `<p style="font-size:10px;color:${t.primary};font-weight:700;letter-spacing:3px;margin:0 0 2px;text-transform:uppercase;">${leaf(s.isEnding ? "THE END" : en)}</p>` +
      `<h3 style="font-size:18px;font-weight:800;color:${t.titleColor};margin:0;letter-spacing:0.5px;">${leaf(s.title)}</h3>` +
      `</section></section></section>` +
      `</section>`
    );
  }

  if (t.heading === "watermark") {
    /* 石墨极简：超大水印编号 + 标题 + 1px 细线 */
    const big = s.isEnding ? "∞" : no;
    return (
      `<section style="margin-top:${marginTop};margin-bottom:32px;padding:0 ${t.padX};">` +
      `<section style="position:relative;padding-bottom:20px;border-bottom:1px solid ${t.lineColor};">` +
      `<p style="font-size:48px;font-weight:900;color:${t.lineColor};margin:0;line-height:1;letter-spacing:-2px;">${leaf(big)}</p>` +
      `<section style="margin-top:-8px;">` +
      `<p style="font-size:10px;color:${t.faintColor};font-weight:500;letter-spacing:3px;margin:0 0 6px;text-transform:uppercase;">${leaf(s.isEnding ? "EPILOGUE" : en)}</p>` +
      `<h3 style="font-size:20px;font-weight:800;color:${t.titleColor};margin:0;letter-spacing:0.5px;line-height:1.4;">${leaf(s.title)}</h3>` +
      `</section></section></section>`
    );
  }

  if (t.heading === "serif") {
    /* 留白禅意：墨绿英文小标 + 衬线大标题 + 短细线 */
    const label = s.isEnding ? "∞ · POSTSCRIPT" : `${no} · ${en}`;
    return (
      `<section style="margin-top:${marginTop};margin-bottom:32px;padding:0 ${t.padX};">` +
      `<p style="font-size:10px;color:${t.primary};font-weight:600;letter-spacing:4px;margin:0 0 10px;text-transform:uppercase;">${leaf(label)}</p>` +
      `<h3 style="font-family:${t.headingFont};font-size:22px;font-weight:700;color:${t.titleColor};margin:0 0 16px;letter-spacing:0.5px;line-height:1.4;">${leaf(s.title)}</h3>` +
      `<section style="width:40px;height:2px;background:${t.primary};"><span leaf=""><br></span></section>` +
      `</section>`
    );
  }

  if (t.heading === "ticket") {
    /* 摸鱼票据：实底方块编号 + 标题 + 斜杠副标 */
    return (
      `<section style="margin-top:${marginTop};margin-bottom:32px;padding:0 ${t.padX};">` +
      `<section style="display:flex;align-items:center;gap:12px;margin-bottom:24px;padding-bottom:12px;border-bottom:2px solid ${t.primaryDeep};">` +
      `<section style="background:${t.primary};color:#fff;font-size:12px;font-weight:800;padding:6px 12px;letter-spacing:2px;">${leaf(no)}</section>` +
      `<section style="font-size:18px;font-weight:800;color:${t.titleColor};letter-spacing:1px;">${leaf(s.title)}</section>` +
      `<section style="font-size:12px;color:${t.mutedColor};">${leaf("/ " + en)}</section>` +
      `</section></section>`
    );
  }

  /* split：大编号 + 竖线 + 中英双行（摸鱼绿 / 只此青绿 / 橄榄手记） */
  const part = s.isEnding ? "LAST" : "PART";
  return (
    `<section style="margin-top:${marginTop};margin-bottom:32px;padding:0 ${t.padX};">` +
    `<section style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">` +
    `<section style="text-align:center;flex-shrink:0;">` +
    `<p style="margin:0;font-size:28px;font-weight:900;color:${t.primary};line-height:1;letter-spacing:-2px;">${leaf(no)}</p>` +
    `<p style="margin:0;font-size:8px;font-weight:700;color:${t.faintColor};letter-spacing:2px;">${leaf(part)}</p>` +
    `</section>` +
    `<span style="width:1px;height:36px;background:${t.lineColor};flex-shrink:0;display:inline-block;overflow:hidden;vertical-align:middle;font-size:0;line-height:0;"><span leaf="">&nbsp;</span></span>` +
    `<section>` +
    `<p style="margin:0 0 1px;font-size:17px;font-weight:900;color:${t.titleColor};letter-spacing:0.3px;">${leaf(s.title)}</p>` +
    `<p style="margin:0;font-size:11px;font-weight:600;color:${t.faintColor};letter-spacing:1.5px;">${leaf(en)}</p>` +
    `</section></section></section>`
  );
}

/** 子标题（###） */
function renderSubHeading(text, t) {
  return (
    `<p style="margin:28px 0 14px;font-size:${parseInt(t.fontSize, 10) + 1}px;font-weight:800;color:${t.titleColor};letter-spacing:0.5px;">` +
    leaf(text) +
    `</p>`
  );
}

/** 正文段落 */
function renderParagraph(text, t, opts) {
  return (
    `<p style="margin-bottom:${t.paraGap};font-size:${t.fontSize};line-height:${t.lineHeight};text-align:justify;color:${t.bodyColor};letter-spacing:${t.letterSpacing};">` +
    renderInline(text, t, opts) +
    `</p>`
  );
}

/** 引用块 —— 三种形态 */
function renderQuote(text, t, opts) {
  const inner = renderInline(text, t, opts);

  if (t.quoteStyle === "bar") {
    return (
      `<section style="background:${t.primaryBg};border-radius:0 10px 10px 0;border-left:4px solid ${t.primary};padding:18px 22px;margin-bottom:24px;">` +
      `<p style="margin:0;font-size:${parseInt(t.fontSize, 10) + 1}px;font-weight:800;color:${t.primaryDeep};line-height:${t.lineHeight};">${inner}</p>` +
      `</section>`
    );
  }
  if (t.quoteStyle === "plain") {
    return (
      `<section style="border-left:2px solid ${t.lineColor};padding:10px 18px;margin-bottom:24px;background:${t.softBg};">` +
      `<p style="margin:0;font-size:${parseInt(t.fontSize, 10) - 1}px;color:${t.bodyColor};line-height:${t.lineHeight};text-align:justify;">${inner}</p>` +
      `</section>`
    );
  }
  /* card */
  return (
    `<section style="background:${t.softBg};border-radius:${t.radius};padding:18px 20px;margin-bottom:24px;border:1px solid ${t.borderColor};">` +
    `<p style="margin:0;font-size:${t.fontSize};color:${t.bodyColor};line-height:${t.lineHeight};text-align:justify;">${inner}</p>` +
    `</section>`
  );
}

/** 代码块 —— 深色 / 浅色两版；每行一个 p，缩进用全角空格 */
function renderCode(lang, lines, t) {
  const head = lang
    ? `<section style="padding:9px 14px;background:#0F172A;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#FF5F56;margin-right:7px;font-size:0;line-height:0;overflow:hidden;"><span leaf=""><br></span></span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#FFBD2E;margin-right:7px;font-size:0;line-height:0;overflow:hidden;"><span leaf=""><br></span></span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#27C93F;font-size:0;line-height:0;overflow:hidden;"><span leaf=""><br></span></span><span style="margin-left:12px;font-size:12px;color:#64748B;font-family:${MONO_STACK};letter-spacing:1px;">${leaf(lang)}</span></section>`
    : "";

  if (t.codeStyle === "light") {
    return (
      `<section style="margin:0 0 20px;border-radius:8px;overflow:hidden;background:#F6F8FA;border:1px solid #E5E7EB;border-left:3px solid ${t.primary};">` +
      (lang ? `<section style="padding:7px 14px;border-bottom:1px solid #E5E7EB;"><span style="font-size:12px;color:#9CA3AF;font-family:${MONO_STACK};letter-spacing:1px;">${leaf(lang)}</span></section>` : "") +
      `<section style="padding:11px 14px;">` +
      lines
        .map(
          (l) =>
            `<p style="margin:0;font-family:${MONO_STACK};font-size:13px;line-height:1.6;color:#24292F;">${leaf(ideoSpace(l))}</p>`
        )
        .join("") +
      `</section></section>`
    );
  }

  return (
    `<section style="margin:0 0 20px;border-radius:8px;overflow:hidden;background:#1E293B;box-shadow:0 4px 16px -8px rgba(15,23,42,0.4);">` +
    head +
    `<section style="padding:11px 14px;">` +
    lines
      .map(
        (l) =>
          `<p style="margin:0;font-family:${MONO_STACK};font-size:13px;line-height:1.6;color:#E2E8F0;">${leaf(ideoSpace(l))}</p>`
      )
      .join("") +
    `</section></section>`
  );
}

/** 图片 —— 圆角容器 + 可选说明 */
function renderImage(src, alt, t) {
  const cap = alt
    ? `<p style="font-size:12px;color:${t.faintColor};text-align:center;margin:0 0 24px;">${leaf("— " + alt)}</p>`
    : "";
  return (
    `<section style="background:#FFF;border-radius:12px;padding:6px;border:1px solid ${t.lineColor};box-shadow:0 4px 12px -2px rgba(0,0,0,0.08);margin-bottom:8px;">` +
    `<section style="margin:0;border-radius:8px;overflow:hidden;">` +
    `<span leaf=""><img src="${esc(src)}" style="max-width:100%;height:auto;display:block;margin:0 auto;"></span>` +
    `</section></section>` + cap
  );
}

/** 列表 */
function renderList(ordered, items, t, opts) {
  const rows = items
    .map((it, idx) => {
      const mark = ordered
        ? `<span style="display:inline-block;min-width:20px;font-weight:800;color:${t.primary};">${leaf(String(idx + 1) + ".")}</span>`
        : `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${t.primary};margin-right:9px;font-size:0;line-height:0;overflow:hidden;vertical-align:middle;"><span leaf=""><br></span></span>`;
      return (
        `<section style="display:flex;align-items:flex-start;margin-bottom:12px;">` +
        `<section style="flex-shrink:0;padding-top:2px;">${mark}</section>` +
        `<section style="flex:1;min-width:0;">` +
        `<p style="margin:0;font-size:${t.fontSize};line-height:${t.lineHeight};color:${t.bodyColor};text-align:justify;">${renderInline(it, t, opts)}</p>` +
        `</section></section>`
      );
    })
    .join("");
  return `<section style="margin:0 0 24px;padding:0 ${t.padX};">${rows}</section>`;
}

/** 表格 —— 用带底色的行模拟（公众号不支持真表格样式） */
function renderTable(head, rows, t) {
  const th = head
    .map(
      (c) =>
        `<section style="flex:1;min-width:0;padding:9px 10px;font-weight:700;color:#FFFFFF;background:${t.primary};font-size:${parseInt(t.fontSize, 10) - 1}px;">${leaf(c)}</section>`
    )
    .join("");
  const trs = rows
    .map(
      (r, ri) =>
        `<section style="display:flex;border-bottom:1px solid ${t.lineColor};">` +
        head
          .map(
            (_, ci) =>
              `<section style="flex:1;min-width:0;padding:9px 10px;font-size:${parseInt(t.fontSize, 10) - 1}px;color:${t.bodyColor};background:${ri % 2 ? "#FAFAFA" : "#FFFFFF"};">${leaf(r[ci] || "")}</section>`
          )
          .join("") +
        `</section>`
    )
    .join("");
  return (
    `<section style="margin:0 0 24px;padding:0 ${t.padX};">` +
    `<section style="display:flex;background:${t.primary};">${th}</section>` +
    trs +
    `</section>`
  );
}

/** 分隔线 */
function renderDivider(t) {
  return (
    `<section style="margin:32px auto;width:60px;height:2px;background:${t.lineColor};">` +
    `<span leaf=""><br></span></section>`
  );
}

/** 目录 —— 3 章以上自动生成，取前 3 个要点 */
function renderToc(sections, t) {
  if (sections.length < 3) return "";
  const picks = sections.slice(0, 3);
  const cards = picks
    .map(
      (s) =>
        `<section style="flex:1;min-width:0;padding:16px 14px;background:${t.softBg};border-radius:${t.radius};border:1px solid ${t.borderColor};">` +
        `<p style="margin:0 0 6px;font-size:16px;font-weight:900;color:${t.primary};letter-spacing:-1px;">${leaf(s.no)}</p>` +
        `<p style="margin:0;font-size:13px;font-weight:600;color:${t.titleColor};line-height:1.6;">${leaf(s.title)}</p>` +
        `</section>`
    )
    .join("");
  return (
    `<section style="margin:0 0 40px;padding:0 ${t.padX};">` +
    `<p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:3px;color:${t.faintColor};text-transform:uppercase;">${leaf("CONTENTS")}</p>` +
    `<section style="display:flex;gap:12px;">${cards}</section>` +
    `</section>`
  );
}

/** 尾部作者签名区 */
function renderSignature(t, opts) {
  const name = opts.authorName ? esc(opts.authorName) : "{{作者名}}";
  const bio = opts.authorBio ? esc(opts.authorBio) : "{{一句话简介}}";
  return (
    `<section style="padding:0 ${t.padX};">` +
    `<p style="margin-bottom:20px;font-size:${t.fontSize};line-height:${t.lineHeight};text-align:justify;color:${t.bodyColor};">` +
    leaf(`我是 ${name}，${bio}。`) +
    `</p>` +
    `<p style="margin-bottom:20px;font-size:${t.fontSize};line-height:${t.lineHeight};text-align:justify;color:${t.bodyColor};">` +
    leaf("如果你觉得今天这篇有收获，欢迎") +
    `<strong style="color:${t.primary};">${leaf("点赞、在看、转发")}</strong>` +
    leaf("三连，我们下篇见。") +
    `</p>` +
    `</section>`
  );
}

/** END 结束符 */
function renderEnd(t) {
  return (
    `<section style="margin:40px auto 32px;text-align:center;padding:0 ${t.padX};">` +
    `<section style="display:inline-block;padding:6px 16px;border:1px solid ${t.lineColor};border-radius:20px;">` +
    `<span style="font-size:11px;font-weight:700;letter-spacing:4px;color:${t.faintColor};">${leaf("END")}</span>` +
    `</section></section>`
  );
}

/* ------------------------------------------------------------------ *
 * 主渲染入口
 * ------------------------------------------------------------------ */

/**
 * 把 Markdown 渲染成公众号 HTML。
 *
 * @param {string} markdown 正文（Markdown）
 * @param {object} options
 *   themeId     主题 id，默认 moyu-green
 *   title       文章标题（用于封面卡与目录）
 *   cover       封面图 URL（可选）
 *   authorName  作者名（可选，缺省留 {{作者名}} 占位）
 *   authorBio   作者简介（可选）
 *   signature   是否输出签名区，默认 true
 *   toc         是否输出目录，默认「章节 ≥3 时自动」
 *   markKeywords 是否自动给关键词加下划线，默认 true
 * @returns {{ html: string, themeId: string, sectionCount: number, wordCount: number }}
 */
function renderGzh(markdown, options) {
  const opts = options || {};
  const t = getTheme(opts.themeId);
  const markKeywords = opts.markKeywords !== false;

  const blocks = parseMarkdown(markdown);
  const { intro, sections } = analyze(blocks);
  const title = String(opts.title || "").trim();

  const inner = [];

  /* 封面卡 */
  if (opts.cover) {
    inner.push(
      `<section style="margin:0 0 32px;padding:0 ${t.padX};">` +
        `<section style="border-radius:${t.radius};overflow:hidden;border:1px solid ${t.borderColor};">` +
        `<span leaf=""><img src="${esc(opts.cover)}" style="max-width:100%;height:auto;display:block;margin:0 auto;"></span>` +
        `</section></section>`
    );
  }

  /* 引言（正文开头的第一个引用块） */
  const introQuote = intro.find((b) => b.type === "quote");
  if (introQuote) {
    inner.push(
      `<section style="margin:0 0 28px;padding:0 ${t.padX};">` +
        `<section style="border-left:3px solid ${t.primary};padding:14px 18px;background:${t.softBg};border-radius:0 ${t.radius} ${t.radius} 0;">` +
        `<p style="margin:0;font-size:${parseInt(t.fontSize, 10) + 1}px;font-weight:700;color:${t.primaryDeep};line-height:${t.lineHeight};">` +
        renderInline(introQuote.text, t, { markKeywords: false }) +
        `</p></section></section>`
    );
  }

  /* 前言正文 */
  for (const b of intro) {
    if (b.type === "quote" && b === introQuote) continue;
    inner.push(renderBlock(b, t, { markKeywords }));
  }

  /* 目录 */
  if (opts.toc !== false) inner.push(renderToc(sections, t));

  /* 章节 */
  sections.forEach((s, idx) => {
    inner.push(renderChapter(s, t, idx === 0));
    for (const b of s.blocks) {
      if (b.type === "heading") inner.push(renderSubHeading(plainText(b.text), t));
      else inner.push(renderBlock(b, t, { markKeywords }));
    }
  });

  /* END + 签名 */
  inner.push(renderEnd(t));
  if (opts.signature !== false) inner.push(renderSignature(t, opts));

  const html =
    `<section style="max-width:677px;margin:0 auto;background:${t.paperBg};font-family:${FONT_STACK};color:${t.bodyColor};line-height:${t.lineHeight};letter-spacing:${t.letterSpacing};overflow-x:hidden;">` +
    inner.join("") +
    `</section>`;

  const wordCount = String(markdown || "").replace(/\s/g, "").length;
  return { html, themeId: t.id, sectionCount: sections.length, wordCount };
}

/** 单个块的渲染分发 */
function renderBlock(b, t, opts) {
  switch (b.type) {
    case "paragraph":
      return renderParagraph(b.text, t, opts);
    case "quote":
      return renderQuote(b.text, t, opts);
    case "code":
      return renderCode(b.lang, b.lines, t);
    case "image":
      return renderImage(b.src, b.alt, t);
    case "list":
      return renderList(b.ordered, b.items, t, opts);
    case "table":
      return renderTable(b.head, b.rows, t);
    case "divider":
      return renderDivider(t);
    case "heading":
      return renderSubHeading(plainText(b.text), t);
    default:
      return "";
  }
}

module.exports = { renderGzh, DEFAULT_THEME_ID };
