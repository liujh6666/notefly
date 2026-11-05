/*
 * NoteFly 文章正文抽取
 * ------------------------------------------------------------
 * 首版只承诺两类来源：
 *   1. 微信公众号文章（mp.weixin.qq.com）
 *   2. 普通公开文章页面（能从正文容器里取到段落）
 * 不承诺「支持任意网站采集」—— 抓不到就说抓不到，不伪造。
 *
 * 三条底线：
 *   1. 必须真的拿到正文才算成功。只有标题、没有正文的页面 → 明确失败。
 *   2. 识别出验证码 / 登录页 / 「内容已被删除」→ 明确失败，并提示用户
 *      可以打开原文手动粘贴正文。绝不绕过访问控制。
 *   3. 缺失字段标记「未知」，不允许瞎猜作者、发布时间。
 */
"use strict";

const { sanitizeHtml, htmlToText } = require("./html-sanitize");

/* 正文的最小长度：低于这个值基本可以判定「没抓到正文」 */
const MIN_BODY_LENGTH = 80;

/* 常见的内容容器选择器（按优先级） */
const CONTENT_SELECTORS = [
  /* 微信公众号 */
  "#js_content",
  "#img-content",
  ".rich_media_content",
  /* 通用文章页 */
  "article",
  "article[class*='content']",
  "[class*='article-content']",
  "[class*='articleContent']",
  "[class*='post-content']",
  "[class*='entry-content']",
  "[class*='rich-text']",
  "[class*='markdown-body']",
  "[class*='content']",
  "main",
];

/* 导航 / 广告 / 无关推荐 的容器选择器 */
const NOISE_SELECTORS = [
  "nav", "header", "footer", "aside",
  "[class*='nav']", "[class*='menu']", "[class*='sidebar']",
  "[class*='advert']", "[class*='ad-']", "[class*='banner']",
  "[class*='recommend']", "[class*='related']", "[class*='hot-list']",
  "[class*='comment']", "[class*='share']", "[class*='breadcrumb']",
  "[class*='copyright']", "[class*='footer']", "[class*='header']",
  "[id*='recommend']", "[id*='related']", "[id*='comment']",
  "[role='navigation']", "[role='banner']",
];

/* 页面级异常特征：命中就是抓取失败，绝不当作成功 */
const FAIL_PATTERNS = [
  { re: /环境异常|完成验证后即可继续访问|去验证/i, reason: "目标站点要求完成验证（验证码），无法自动采集" },
  { re: /该内容已被发布者删除|此内容因违规无法查看|内容已删除|该公众号已迁移/i, reason: "原文已被删除或无法查看" },
  { re: /请在微信客户端打开|在微信中打开此文章|环境异常.*微信/i, reason: "页面要求在微信客户端内打开，无法直接采集" },
  { re: /登录后(才|即可|可)(查看|阅读|继续)/i, reason: "页面需要登录后才能查看" },
  { re: /^(登录|注册|sign in|log in)/i, reason: "抓到的像是登录页，没有正文" },
  { re: /Access Denied|403 Forbidden|拒绝访问|权限不足/i, reason: "目标站点拒绝访问（403）" },
  { re: /Just a moment|Checking your browser|请稍候.*验证/i, reason: "目标站点正在进行人机验证" },
];

/* ---- 嵌套感知的容器抽取 ----
   旧实现用 `([\s\S]*?)<\/\1>` 惰性匹配，在第一个同名闭合标签就截断：
   `<div id="js_content"><div>开头</div><p>结尾</p></div>` 只能拿到「开头」，
   却因为超过最小长度被当作完整成功。这里改成扫描配平：
   找到符合过滤条件的开标签后，对同名标签计深度，直到真正闭合。
   不引第三方依赖，代价是只认无注释干扰的常规 HTML（与原口径一致）。 */

/* 不需要闭合的标签 */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按条件找开标签并返回其内部 HTML（深度配平）
 * @param {string} html
 * @param {(tag:string, attrs:string)=>boolean} filter
 * @returns {string} 容器内部 HTML（不含容器标签本身）；没找到返回 ""
 */
function extractContainer(html, filter) {
  /* 开标签：属性值里的 > 不算结束（引号成对消费，线性扫描无回溯风险） */
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  let m;
  while ((m = openRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    if (!filter(tag, attrs)) continue;
    if (m[3] === "/" || VOID_TAGS.has(tag)) return "";   /* 自闭合/void：没有内容 */
    const closeRe = new RegExp(`<(/?)${tag}(?:"[^"]*"|'[^']*'|[^>"'])*>`, "gi");
    closeRe.lastIndex = openRe.lastIndex;
    let depth = 1;
    let cm;
    while ((cm = closeRe.exec(html))) {
      if (cm[1] === "/") {
        depth--;
        if (depth === 0) return html.slice(openRe.lastIndex, cm.index);
      } else if (!/\/>$/.test(cm[0]) && !VOID_TAGS.has(tag)) {
        depth++;
      }
    }
    /* 没配平（HTML 残缺）：取到结尾，交给后续净化兜底 */
    return html.slice(openRe.lastIndex);
  }
  return "";
}

/* 从 HTML 里提取某个选择器的内容 */
function extractBySelector(html, selector) {
  /* 只支持简单选择器：标签、#id、.class、以及 [class*=xxx] 的组合形式 */
  const idMatch = selector.match(/^#([A-Za-z0-9_-]+)$/);
  if (idMatch) {
    const idRe = new RegExp(`(?:^|\\s)id\\s*=\\s*["']${escapeRe(idMatch[1])}["']`, "i");
    return extractContainer(html, (_tag, attrs) => idRe.test(attrs));
  }
  const clsMatch = selector.match(/^\.([A-Za-z0-9_-]+)$/);
  if (clsMatch) {
    const clsRe = new RegExp(`class\\s*=\\s*["'][^"']*\\b${escapeRe(clsMatch[1])}\\b[^"']*["']`, "i");
    return extractContainer(html, (_tag, attrs) => clsRe.test(attrs));
  }
  const tagMatch = selector.match(/^([a-zA-Z][a-zA-Z0-9]*)$/);
  if (tagMatch) {
    const want = tagMatch[1].toLowerCase();
    return extractContainer(html, (tag) => tag === want);
  }
  /* [class*='xxx'] 形式 */
  const attrMatch = selector.match(/^\[class\*=['"]?([^'"\]]+)['"]?\]$/);
  if (attrMatch) {
    const needle = attrMatch[1];
    return extractContainer(html, (_tag, attrs) => attrs.toLowerCase().includes(needle.toLowerCase()));
  }
  return "";
}

/** 去掉噪声容器 */
function stripNoise(html) {
  let s = html;
  for (const sel of NOISE_SELECTORS) {
    const tag = sel.match(/^[a-z]+$/);
    if (tag) {
      s = s.replace(new RegExp(`<${tag[0]}\\b[^>]*>[\\s\\S]*?<\\/${tag[0]}\\s*>`, "gi"), " ");
      continue;
    }
    const idM = sel.match(/^#([A-Za-z0-9_-]+)$/);
    if (idM) {
      s = s.replace(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bid=["']${idM[1]}["'][^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), " ");
      continue;
    }
    const clsM = sel.match(/^\.([A-Za-z0-9_-]+)$/);
    if (clsM) {
      s = s.replace(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bclass=["'][^"']*\\b${clsM[1]}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), " ");
      continue;
    }
    const attrM = sel.match(/^\[class\*=['"]?([^'"\]]+)['"]?\]$/);
    if (attrM) {
      s = s.replace(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bclass=["'][^"']*${attrM[1]}[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), " ");
    }
  }
  return s;
}

/** 取 <title> */
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    const t = htmlToText(m[1]).trim();
    if (t) return t;
  }
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return htmlToText(og[1]).trim();
  return "";
}

/** 取作者 / 来源账号 */
function extractAuthor(html) {
  /* 微信常见 meta */
  const metaKeys = [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+property=["']og:article:author["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']twitter:creator["'][^>]+content=["']([^"']*)["']/i,
  ];
  for (const re of metaKeys) {
    const m = html.match(re);
    if (m && m[1].trim()) return htmlToText(m[1]).trim();
  }
  /* 微信页面里的作者节点 */
  const wechat = html.match(/<a[^>]+id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i);
  if (wechat) {
    const t = htmlToText(wechat[1]).trim();
    if (t) return t;
  }
  /* 常见作者字段 */
  const byline = html.match(/class=["'][^"']*\bauthor\b[^"']*["'][^>]*>([\s\S]{0,200}?)<\/(?:span|div|p|a)>/i);
  if (byline) {
    const t = htmlToText(byline[1]).trim();
    if (t && t.length <= 40) return t;
  }
  const rel = html.match(/<link[^>]+rel=["']author["'][^>]*>/i);
  if (rel) {
    const t = htmlToText(rel[0]).replace(/<[^>]*>/g, "").trim();
    if (t) return t;
  }
  return "";
}

/** 取发布时间 */
function extractPublishedAt(html) {
  const metas = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']weibo:article:create_at["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']PubDate["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of metas) {
    const m = html.match(re);
    if (m && m[1].trim()) {
      const d = new Date(m[1].trim());
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  /* 页面里常见的可见时间文本 */
  const textPatterns = [
    /id=["']publish_time["'][^>]*>([^<]{4,40})</i,
    /class=["'][^"']*\bpublish[_-]?time\b[^"']*["'][^>]*>([^<]{4,40})</i,
    /class=["'][^"']*\barticle[-_]?time\b[^"']*["'][^>]*>([^<]{4,40})</i,
  ];
  for (const re of textPatterns) {
    const m = html.match(re);
    if (m && m[1].trim()) {
      const raw = m[1].trim();
      const d = new Date(raw.replace(/年|月/g, "-").replace(/日/g, ""));
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return "";
}

/** 页面标题里的站点名后缀 → 来源站点 */
function extractSiteName(html, finalUrl) {
  const m = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (m && m[1].trim()) return m[1].trim();
  try {
    return new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 从 HTML 抽取正文与元信息
 * @param {string} html
 * @param {{finalUrl?:string}} opts
 * @returns {{ok:boolean, reason?:string, code?:string, title?:string,
 *            author?:string, publishedAt?:string, siteName?:string,
 *            bodyHtml?:string, bodyText?:string, contentType?:string}}
 */
function extractArticle(html, opts) {
  const o = opts || {};
  const src = String(html || "");
  const finalUrl = o.finalUrl || "";

  if (!src.trim()) {
    return { ok: false, reason: "页面内容为空", code: "empty" };
  }

  /* 1. 先看是不是异常页 —— 命中就明确失败，绝不当成功 */
  const head = src.slice(0, 200000);
  for (const p of FAIL_PATTERNS) {
    if (p.re.test(head)) {
      return { ok: false, reason: p.reason, code: "blocked_page" };
    }
  }

  const title = extractTitle(src);
  const author = extractAuthor(src);
  const publishedAt = extractPublishedAt(src);
  const siteName = extractSiteName(src, finalUrl);

  /* 2. 找正文容器 */
  const cleaned = stripNoise(src);
  let bodyHtml = "";
  for (const sel of CONTENT_SELECTORS) {
    const chunk = extractBySelector(cleaned, sel);
    if (!chunk) continue;
    const text = htmlToText(chunk);
    if (text.length >= MIN_BODY_LENGTH) {
      bodyHtml = chunk;
      break;
    }
  }

  /* 3. 容器没命中时，退回「取全页文本里的最长段落块」 */
  if (!bodyHtml) {
    const whole = htmlToText(cleaned);
    if (whole.length >= MIN_BODY_LENGTH) {
      /* 从最长的一段连续正文里切出来 */
      const paras = whole.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 40);
      if (paras.length) {
        bodyHtml = paras.map((p) => `<p>${p.replace(/</g, "&lt;")}</p>`).join("\n");
      }
    }
  }

  if (!bodyHtml) {
    return {
      ok: false,
      reason: "没有识别到正文（页面结构无法解析，可能需要登录、是验证码页，或正文由脚本加载）",
      code: "no_content",
      title,
      author,
      publishedAt,
      siteName,
    };
  }

  /* 4. 净化并转纯文本 */
  const safeHtml = sanitizeHtml(bodyHtml, { baseUrl: finalUrl || undefined });
  const bodyText = htmlToText(safeHtml);

  if (bodyText.length < MIN_BODY_LENGTH) {
    return {
      ok: false,
      reason: `正文过短（仅 ${bodyText.length} 字），判定为未采集到有效正文`,
      code: "too_short",
      title,
      author,
      publishedAt,
      siteName,
    };
  }

  /* 5. 内容类型：按关键词粗判（用户可改） */
  const contentType = guessContentType(title + "\n" + bodyText);

  return {
    ok: true,
    title: title || "(未识别到标题)",
    author: author || "",
    publishedAt: publishedAt || "",
    siteName,
    bodyHtml: safeHtml,
    bodyText,
    contentType,
    wordCount: bodyText.replace(/\s/g, "").length,
  };
}

/** 粗判内容类型：企业资料 / 产品介绍 / 活动报道 / 案例 / 观点文章 */
function guessContentType(text) {
  const s = String(text || "");
  if (/(活动|大会|论坛|峰会|发布会|周年|现场|报名|参展|沙龙)/.test(s)) return "event";
  if (/(案例|客户|实践|落地|复盘|解决方案|成功故事)/.test(s)) return "case";
  if (/(产品|功能|版本|发布|上线|体验|特性|架构)/.test(s)) return "product";
  if (/(关于|简介|使命|愿景|团队|联系我们|关于我们)/.test(s)) return "company";
  return "opinion";
}

/** 内容类型字典（与前端共用同一份口径） */
const CONTENT_TYPES = [
  { id: "company", name: "企业资料" },
  { id: "product", name: "产品介绍" },
  { id: "event", name: "活动报道" },
  { id: "case", name: "案例" },
  { id: "opinion", name: "观点文章" },
];

module.exports = {
  MIN_BODY_LENGTH,
  CONTENT_SELECTORS,
  CONTENT_TYPES,
  extractArticle,
  extractBySelector,
  extractContainer,
  extractTitle,
  extractAuthor,
  extractPublishedAt,
  extractSiteName,
  htmlToText,
  guessContentType,
};
