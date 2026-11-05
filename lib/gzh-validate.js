/*
 * 公众号 HTML 合规校验
 * ------------------------------------------------------------
 * 移植自 gzh-design skill 的 scripts/validate_gzh_html.py。
 * 目的：把「平台禁用项」从模型自觉变成确定性兜底 —— 渲染完先自检，
 * 有 ERROR 就说明粘贴进公众号会掉样式，必须先修。
 *
 * ERROR 会被公众号过滤掉或导致样式失效；WARNING 多为半角标点（实际返工高频点）。
 */

"use strict";

const FORBIDDEN = [
  [/<style[\s>]/i, "ERROR", "<style> 标签会被过滤，样式必须内联"],
  [/<script[\s>]/i, "ERROR", "<script> 标签会被过滤"],
  [/<\/?div[\s>]/i, "ERROR", "<div> 会被改写，请用 <section>"],
  [/<link[\s>]/i, "ERROR", "外部 <link>（CSS/字体）会被过滤"],
  [/\sclass\s*=/i, "ERROR", "class 属性会被剥离，请用内联 style"],
  [/\sid\s*=/i, "ERROR", "id 属性会被剥离"],
  [/position\s*:\s*(fixed|absolute|sticky)/i, "ERROR", "position fixed/absolute/sticky 不被支持"],
  [/float\s*:/i, "ERROR", "float 不被支持"],
  [/@media/i, "ERROR", "@media 媒体查询不被支持"],
  [/@keyframes/i, "ERROR", "@keyframes 动画不被支持"],
  [/@import/i, "ERROR", "@import 不被支持"],
  [/display\s*:\s*grid/i, "ERROR", "display:grid 不被支持，请用 flex"],
  [/var\s*\(\s*--/i, "ERROR", "CSS 变量 var(--x) 不被支持，请写死值"],
  [/url\s*\(\s*['"]?https?:\/\/[^)]*\.(woff2?|ttf|otf|eot)/i, "ERROR", "外部字体不被支持"],
];

const CJK = /[一-鿿㐀-䶿]/;
const HALF_PUNCT = /[一-鿿㐀-䶿][,;!?]/;
const CODE_STYLE = /monospace|white-space\s*:\s*pre|courier|consolas|sf mono/i;

/**
 * 校验渲染产出的 HTML。
 * @param {string} html
 * @returns {{ ok:boolean, errors:string[], warnings:string[], spanLeafCount:number }}
 */
function validateGzhHtml(html) {
  const s = String(html || "");
  const errors = [];
  const warnings = [];

  for (const [re, level, msg] of FORBIDDEN) {
    const m = re.exec(s);
    if (m) {
      const line = s.slice(0, m.index).split("\n").length;
      (level === "ERROR" ? errors : warnings).push(`${msg}（第 ${line} 行附近：${m[0].slice(0, 40)}）`);
    }
  }

  /* 检查文字节点是否被 <span leaf=""> 包裹 —— 公众号粘贴保样式的关键 */
  const unwrapped = [];
  const halfPuncts = [];
  let spanLeafCount = 0;
  let leafDepth = 0;
  let codeDepth = 0;

  /* 简易标签栈扫描（只需要 span 的 leaf 属性与 style 里的代码特征） */
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  const stack = [];
  let last = 0;
  let m;

  const codeDepthOf = (attrs) => {
    const sm = /style\s*=\s*"([^"]*)"/i.exec(attrs || "");
    return sm && CODE_STYLE.test(sm[1]) ? 1 : 0;
  };

  while ((m = tagRe.exec(s)) !== null) {
    /* 标签之间的裸文本 */
    const between = s.slice(last, m.index);
    if (between.trim() && leafDepth === 0 && codeDepth === 0) {
      unwrapped.push(between.trim().slice(0, 40));
    }
    if (between && codeDepth === 0 && HALF_PUNCT.test(between)) {
      halfPuncts.push(between.trim().slice(0, 40));
    }
    last = m.index + m[0].length;

    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";

    if (!closing) {
      const isLeaf = tag === "span" && /\bleaf\b/i.test(attrs);
      const isCode = codeDepthOf(attrs);
      if (isLeaf) {
        spanLeafCount += 1;
        leafDepth += 1;
      }
      if (isCode) codeDepth += 1;
      stack.push({ tag, leaf: isLeaf, code: isCode });
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          if (stack[i].leaf) leafDepth -= 1;
          if (stack[i].code) codeDepth -= 1;
          stack.splice(i, 1);
          break;
        }
      }
    }
  }

  /* 尾部裸文本 */
  const tail = s.slice(last);
  if (tail.trim() && leafDepth === 0 && codeDepth === 0) unwrapped.push(tail.trim().slice(0, 40));

  if (unwrapped.length) {
    errors.push(`${unwrapped.length} 处文字未包在 <span leaf=""> 里（粘贴后会掉样式）：${unwrapped.slice(0, 3).join(" / ")}`);
  }
  if (halfPuncts.length) {
    warnings.push(`${halfPuncts.length} 处中文后半角标点，建议改全角：${halfPuncts.slice(0, 3).join(" / ")}`);
  }

  return { ok: errors.length === 0, errors, warnings, spanLeafCount };
}

/**
 * 媒体就绪检查（与样式合规检查分开 —— 合规只管「粘贴后样式在不在」，
 * 媒体管「图片离开 NoteFly 后还能不能显示」）：
 * 渲染产物里的图片若还是 /uploads/... 相对地址或站内地址，
 * 粘贴进公众号编辑器后图片不会显示（微信只认微信图床与外链白名单）。
 * @param {string} html
 * @returns {{ ready:boolean, localImages:number, remoteImages:number, message:string }}
 */
function checkMediaReadiness(html) {
  const s = String(html || "");
  const srcs = [];
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = imgRe.exec(s)) !== null) srcs.push(m[1].trim());

  let localImages = 0;
  let remoteImages = 0;
  for (const src of srcs) {
    if (!src) continue;
    if (/^https?:\/\//i.test(src)) remoteImages++;
    else localImages++;               /* /uploads/...、相对路径都算本地 */
  }
  const ready = localImages === 0;
  const message = ready
    ? ""
    : `正文有 ${localImages} 张图片还是 NoteFly 本地地址（/uploads/…），粘贴到公众号后不会显示。` +
      `请先在公众号编辑器里重新上传这些图片，或先在素材库把图片换成可公网访问的地址。`;
  return { ready, localImages, remoteImages, message };
}

module.exports = { validateGzhHtml, checkMediaReadiness, FORBIDDEN };
