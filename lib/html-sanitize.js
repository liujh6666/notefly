/*
 * NoteFly HTML 净化
 * ------------------------------------------------------------
 * 采集到的文章 HTML 会被展示在界面里，也会被当作写作参考发给模型。
 * 未经净化的 HTML 里有三类风险：
 *   1. 脚本与事件属性（<script>、onclick=、javascript: 链接）
 *   2. 远程资源外泄（<img src="http://..."> 会把用户 IP 泄露给第三方）
 *   3. 布局污染（position:fixed 覆盖界面、float 撑破布局）
 *
 * 这里做的是「白名单净化」：只保留结构标签与文本属性，
 * 其余一律丢弃。样式只保留 inline 的白名单属性。
 *
 * 不引入 DOM 库：服务端没有浏览器，纯字符串解析够用且没有依赖风险。
 */
"use strict";

/* 允许保留的标签 */
const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "sub", "sup",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "a", "span", "div", "section", "article", "figure", "figcaption",
  "img", "video", "audio", "source", "picture", "iframe",
]);

/* 需要连同内容一起丢弃的标签（脚本、样式、导航等） */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "noscript", "iframe", "object", "embed", "applet",
  "template", "svg", "math", "form", "button", "select", "textarea",
  "nav", "header", "footer", "aside", "menu", "dialog",
]);

/* 允许保留的样式属性（inline style 里只留这几个） */
const ALLOWED_STYLE_PROPS = new Set([
  "color", "background-color", "font-size", "font-weight", "font-style",
  "text-align", "text-decoration", "line-height", "margin", "margin-top",
  "margin-bottom", "padding", "padding-top", "padding-bottom", "padding-left",
  "padding-right", "text-indent", "letter-spacing", "word-break", "white-space",
]);

/* 危险协议 */
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file):/i;

function escapeAttr(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 样式值里的危险内容：url() 会外泄、expression/behavior 是历史 XSS 载体 */
const DANGEROUS_STYLE_VALUE = /(url\s*\(|expression|javascript:|behavior\s*:|-moz-binding)/i;

/**
 * 净化 style 属性：按声明逐项过滤。
 *
 * 注意不能因为整串里出现了一个禁用属性就把整串丢掉 ——
 * 那样连同一串里安全的 color 也会被误伤。
 * 位置类属性（position/float/display/z-index…）本来就不在白名单里，
 * 逐项过滤已经把它们排除了；这里只再挡一次危险的值。
 */
function sanitizeStyle(raw) {
  const s = String(raw || "");
  if (!s) return "";
  const out = [];
  for (const decl of s.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    if (DANGEROUS_STYLE_VALUE.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join("; ");
}

/** 属性白名单 */
function sanitizeAttrs(tag, attrs) {
  const out = [];
  for (const [rawName, rawVal] of Object.entries(attrs || {})) {
    const name = rawName.toLowerCase();
    /* 事件属性一律丢弃 */
    if (name.startsWith("on")) continue;
    if (name === "style") {
      const st = sanitizeStyle(rawVal);
      if (st) out.push(`style="${escapeAttr(st)}"`);
      continue;
    }
    if (name === "href" || name === "src") {
      const v = String(rawVal || "").trim();
      if (!v) continue;
      if (DANGEROUS_SCHEME.test(v)) continue;
      /* 只允许 http/https 与站内相对地址 */
      if (/^https?:\/\//i.test(v) || v.startsWith("/") || v.startsWith("#")) {
        out.push(`${name}="${escapeAttr(v)}"`);
      }
      continue;
    }
    if (name === "alt" || name === "title" || name === "width" || name === "height") {
      out.push(`${name}="${escapeAttr(rawVal)}"`);
    }
  }
  return out.join(" ");
}

/**
 * 净化 HTML
 * @param {string} html
 * @param {{baseUrl?:string}} opts baseUrl 存在时把相对地址补成绝对
 */
function sanitizeHtml(html, opts) {
  const o = opts || {};
  const src = String(html || "");
  let out = "";
  let i = 0;
  const n = src.length;
  /* 栈：记录打开的标签，用来正确闭合 */
  const stack = [];

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out += escapeText(src.slice(i));
      break;
    }
    if (lt > i) out += escapeText(src.slice(i, lt));

    /* 注释 */
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    /* <!DOCTYPE> / <?xml> */
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    /* 结束标签 */
    if (src.startsWith("</", lt)) {
      const end = src.indexOf(">", lt);
      if (end < 0) { i = n; break; }
      const tag = src.slice(lt + 2, end).trim().toLowerCase();
      i = end + 1;
      if (!ALLOWED_TAGS.has(tag)) continue;
      /* 找到栈里最近的同名标签并闭合到那里 */
      const idx = stack.lastIndexOf(tag);
      if (idx >= 0) {
        while (stack.length > idx) {
          const t = stack.pop();
          out += `</${t}>`;
        }
      }
      continue;
    }

    /* 开始标签 */
    const end = src.indexOf(">", lt);
    if (end < 0) { i = n; break; }
    let inner = src.slice(lt + 1, end);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    i = end + 1;

    const m = inner.match(/^([a-zA-Z][a-zA-Z0-9:-]*)\s*([\s\S]*)$/);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const attrRaw = m[2] || "";

    if (DROP_WITH_CONTENT.has(tag)) {
      /* 连内容一起丢：找到对应闭合标签后整段跳过 */
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = src.slice(i);
      const cm = rest.match(closeRe);
      if (cm) {
        i += cm.index + cm[0].length;
      } else {
        i = n;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      /* 未知标签：保留其文本内容，丢掉标签本身 */
      continue;
    }

    /* 解析属性 */
    const attrs = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrRaw))) {
      const name = am[1].toLowerCase();
      const val = am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : (am[5] !== undefined ? am[5] : ""));
      attrs[name] = val;
    }

    let attrStr = sanitizeAttrs(tag, attrs);
    /* 相对地址补全 */
    if (o.baseUrl) {
      const abs = (name) => {
        const v = attrs[name];
        if (!v || /^(https?:)?\/\//i.test(v) || v.startsWith("data:")) return v;
        try { return new URL(v, o.baseUrl).toString(); } catch { return v; }
      };
      if (tag === "a" && attrs.href && !/^https?:\/\//i.test(attrs.href) && !attrs.href.startsWith("#")) {
        const u = abs("href");
        if (u !== attrs.href) attrStr = attrStr.replace(/href="[^"]*"/, `href="${escapeAttr(u)}"`);
      }
      if (tag === "img" && attrs.src && !/^https?:\/\//i.test(attrs.src)) {
        const u = abs("src");
        if (u !== attrs.src) attrStr = attrStr.replace(/src="[^"]*"/, `src="${escapeAttr(u)}"`);
      }
    }

    if (["br", "hr", "img", "source"].includes(tag)) {
      out += `<${tag}${attrStr ? " " + attrStr : ""} />`;
      continue;
    }
    out += `<${tag}${attrStr ? " " + attrStr : ""}>`;
    stack.push(tag);
  }

  /* 收尾：关闭未闭合的标签 */
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/**
 * 把 HTML 转成纯文本（保留段落/小标题/列表结构）
 * 采集的正文既要能展示，也要能作为写作参考 —— 纯文本更安全，
 * 也不容易被模型当成指令执行。
 */
function htmlToText(html) {
  const src = String(html || "");
  let s = src;
  /* 先删掉丢内容的标签 */
  for (const tag of DROP_WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi");
    s = s.replace(re, " ");
  }
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  /* 结构标签 → 换行/制表符，保留段落与列表层级 */
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|section|article|li|h[1-6]|tr|blockquote|pre)\s*>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "\n- ");
  s = s.replace(/<\s*(h[1-6])[^>]*>/gi, (m, t) => "\n" + "#".repeat(Number(t[1])) + " ");
  s = s.replace(/<[^>]+>/g, "");
  /* 解码常见实体 */
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…");
  /* 压缩空行 */
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

module.exports = {
  ALLOWED_TAGS,
  ALLOWED_STYLE_PROPS,
  sanitizeHtml,
  sanitizeStyle,
  sanitizeAttrs,
  htmlToText,
};
