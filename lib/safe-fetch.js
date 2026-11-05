/*
 * NoteFly 安全抓取
 * ------------------------------------------------------------
 * 采集企业文章要从公网取 HTML。抓取器是「能对外发请求」的部件，
 * 必须当成对外接口来审：
 *
 *  1. 只允许 http / https。file:、ftp:、data:、javascript: 一律拒绝。
 *  2. 拒绝解析到回环 / 私有网段 / 链路本地 / 云元数据地址的主机。
 *     —— 攻击者可以用一个「看起来正常」的 URL 把本机的 NoteFly 接口、
 *        Redis、或者 169.254.169.254（云厂商元数据）读出来。
 *  3. 每次重定向都重新校验。只校验初始 URL 等于没校验 —— 攻击者用一个
 *     公开跳转页就能把请求引到内网。
 *  4. 有超时、大小上限、重定向次数上限。
 *  5. 响应只取文本，不执行任何脚本。
 *
 * 实现说明：Node 的 fetch（undici）不暴露底层 socket 地址，无法在
 * 解析后校验真实 IP。这里采用「先 DNS 解析出全部 A/AAAA 记录，
 * 逐个检查是否落在禁止网段」的方式：DNS 重绑定（rebinding）仍有
 * 理论窗口，但配合解析后立即发起请求 + 禁止一切可疑网段，
 * 已能挡住实际使用中的内网探测。
 */
"use strict";

const dns = require("dns");
const net = require("net");

/* 抓取限制 */
const MAX_BYTES = 5 * 1024 * 1024;      // 单次最多 5MB
const DEFAULT_TIMEOUT_MS = 20000;       // 默认 20 秒
const MAX_REDIRECTS = 5;                // 最多 5 跳

/* 云元数据与常见内网服务的固定地址 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
]);

/* 判断一个 IPv4 是否属于禁止网段 */
function isPrivateIPv4(ip) {
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                                  // 0.0.0.0/8 本机
  if (a === 10) return true;                                 // 10.0.0.0/8 私有
  if (a === 127) return true;                                // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true;                   // 169.254/16 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16/12 私有
  if (a === 192 && b === 168) return true;                   // 192.168/16 私有
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true;                     // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true;      // 198.18/15 基准测试
  if (a >= 224) return true;                                 // 组播与保留
  return false;
}

/** 判断一个 IPv6 是否属于禁止网段（回环 / 唯一本地 / 链路本地 / 未指定） */
function isPrivateIPv6(ip) {
  const s = String(ip || "").toLowerCase();
  if (!s) return true;
  /* IPv4 映射地址（::ffff:127.0.0.1）要按 IPv4 判 */
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateIPv4(m[1]);
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fe80")) return true;    // 链路本地
  if (/^f[cd]/.test(s)) return true;        // 唯一本地 fc00::/7
  if (s.startsWith("ff")) return true;      // 组播
  return false;
}

/** 判断一个 IP 字面量是否禁止 */
function isBlockedIP(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // 不是合法 IP 字面量 → 交给 DNS 解析分支
}

/**
 * 校验一个 URL 是否允许抓取（只查协议与主机名形式，不做 DNS）
 * @returns {{ok:boolean, error?:string, url?:URL}}
 */
function checkURL(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, error: "链接格式不正确" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `不支持的协议：${u.protocol}（只允许 http/https）` };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, error: "链接缺少主机名" };
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, error: "拒绝访问本机或内网地址" };
  }
  /* 主机名本身就是 IP 字面量 → 直接判网段 */
  if (net.isIP(host)) {
    if (isBlockedIP(host)) return { ok: false, error: "拒绝访问本机或内网地址" };
  }
  /* 其它形式的内网指代 */
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return { ok: false, error: "拒绝访问本机或内网地址" };
  }
  return { ok: true, url: u };
}

/**
 * 解析主机名，逐个检查返回的 IP 是否落在禁止网段
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function checkResolved(host) {
  const h = String(host || "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return { ok: false, error: "拒绝访问本机或内网地址" };
  if (net.isIP(h)) {
    if (isBlockedIP(h)) return { ok: false, error: "拒绝访问本机或内网地址" };
    return { ok: true };
  }
  let addrs;
  try {
    addrs = await dns.promises.lookup(h, { all: true, verbatim: true });
  } catch (e) {
    return { ok: false, error: "域名解析失败：" + String((e && e.message) || e) };
  }
  if (!addrs || !addrs.length) return { ok: false, error: "域名没有解析到地址" };
  for (const a of addrs) {
    if (isBlockedIP(a.address)) {
      return { ok: false, error: `域名解析到内网地址（${a.address}），已拒绝访问` };
    }
  }
  return { ok: true };
}

/** 去掉 URL 里的追踪参数 —— 同一条文章的不同链接应当识别为同一篇 */
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return String(raw || "").trim();
  }
  u.hash = "";
  /* 常见的追踪参数 */
  const drop = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "from", "spm", "scene", "srcid", "sharer_shareinfo", "chksm", "clicktime",
    "enterid", "sessionid", "exportkey", "pass_ticket", "wx_header",
  ];
  for (const k of drop) u.searchParams.delete(k);
  /* 参数排序，保证同一篇文章的不同参数顺序归一 */
  const entries = Array.from(u.searchParams.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = "";
  for (const [k, v] of entries) u.searchParams.append(k, v);
  let s = u.toString();
  /* 微信链接常带 &scene= 之类的残留，这里再兜一层 */
  s = s.replace(/[?&]$/, "");
  return s;
}

/**
 * 抓取一个 URL 的文本内容（跟随重定向，每跳都校验）
 * @param {string} rawUrl
 * @param {{timeoutMs?:number, maxBytes?:number, maxRedirects?:number,
 *          headers?:object, method?:string}} opts
 * @returns {Promise<{ok:boolean, status?:number, finalUrl?:string, body?:string,
 *                    contentType?:string, error?:string, code?:string}>}
 */
async function fetchText(rawUrl, opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_BYTES;
  const maxRedirects = Number(o.maxRedirects) > 0 ? Number(o.maxRedirects) : MAX_REDIRECTS;

  let current = String(rawUrl || "").trim();
  let redirects = 0;

  while (true) {
    const checked = checkURL(current);
    if (!checked.ok) return { ok: false, error: checked.error, code: "blocked_url" };

    const resolved = await checkResolved(checked.url.hostname);
    if (!resolved.ok) return { ok: false, error: resolved.error, code: "blocked_host" };

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;

    let res;
    try {
      res = await fetch(checked.url.toString(), {
        method: o.method || "GET",
        redirect: "manual",     // 自己跟重定向，每跳都要校验
        headers: Object.assign({
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
        }, o.headers || {}),
        signal: controller ? controller.signal : undefined,
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
      return {
        ok: false,
        error: aborted
          ? `抓取超时（${Math.round(timeoutMs / 1000)} 秒未响应）`
          : "连不上目标站点：" + String((e && e.message) || e),
        code: aborted ? "timeout" : "network",
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    /* 重定向：逐跳校验 */
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      try { res.body && res.body.cancel && res.body.cancel(); } catch {}
      if (redirects >= maxRedirects) {
        return { ok: false, error: `重定向次数过多（超过 ${maxRedirects} 次）`, code: "too_many_redirects" };
      }
      redirects++;
      const next = new URL(res.headers.get("location"), checked.url).toString();
      current = next;
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    /* 大小限制：先看 Content-Length，超了直接拒绝，不下载 */
    const lenHeader = Number(res.headers.get("content-length") || 0);
    if (lenHeader && lenHeader > maxBytes) {
      try { res.body && res.body.cancel && res.body.cancel(); } catch {}
      return { ok: false, error: `页面体积超出限制（${Math.round(lenHeader / 1024 / 1024)}MB）`, code: "too_large" };
    }

    let body = "";
    try {
      if (typeof res.text === "function") {
        body = await res.text();
      } else {
        body = await new Response(res.body).text();
      }
    } catch (e) {
      return { ok: false, error: "读取响应内容失败：" + String((e && e.message) || e), code: "read_failed" };
    }
    /* 下载后再量一次：有些服务器不给 Content-Length */
    if (body.length > maxBytes) {
      return { ok: false, error: `页面体积超出限制（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`, code: "too_large" };
    }

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: checked.url.toString(),
      body,
      contentType,
      redirects,
      error: res.ok ? "" : `目标站点返回 HTTP ${res.status}`,
      code: res.ok ? "" : "http_error",
    };
  }
}

module.exports = {
  MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS,
  isPrivateIPv4,
  isPrivateIPv6,
  isBlockedIP,
  checkURL,
  checkResolved,
  normalizeUrl,
  fetchText,
};
