/*
 * 自研 RPA 发布引擎（不依赖 MultiPost）
 * 原理：Playwright 启动带持久化登录态的 Chromium，打开各平台发布页，
 *       用 DOM 自动化填充内容后停在编辑器（草稿模式），等人工确认再点发布。
 *
 * 适配器状态标注：
 *  - verified: 在真实环境验证过
 *  - unverified: 结构性编写，待真实账号验证（平台改版可能导致选择器失效）
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const dataDir = require("../lib/data-dir");
const logger = require("../lib/logger");

/* 数据目录可运行时切换（设置页 → 数据存储），所以这两个路径每次求值而不是启动时固定 */
const profileDir = () => dataDir.profileDir();
const stateDir = () => dataDir.stateDir();

/* ---------- 媒体路径解析 ----------
 * 素材在库里存的是网页预览地址（/uploads/xxx.png），setInputFiles 只认磁盘路径。
 * 三种形态必须区分清楚，混用会直接上传失败：
 *   素材 ID        → 不在这里处理（由服务端预先展开）
 *   /uploads/...   → 解析成当前数据目录下的真实文件，文件不存在就放弃（不猜）
 *   http(s)://...  → 远程图片，不能当本地文件传，明确返回空
 *   磁盘绝对路径   → 校验存在后原样使用
 * @returns {string} 可用的本地磁盘路径；不可用返回 ""
 */
function resolveLocalMedia(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return "";
  try {
    if (/^[/\\]uploads[/\\]/i.test(s)) {
      const rel = s.replace(/^[/\\]+uploads[/\\]/i, "");
      const abs = path.join(dataDir.get(), "uploads", rel);
      return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : "";
    }
    return fs.existsSync(s) && fs.statSync(s).isFile() ? path.resolve(s) : "";
  } catch {
    return "";
  }
}

/* 是否跑在 Electron 主进程里（桌面版）：是则直接接管内置浏览器会话 */
const ELECTRON = (() => {
  if (!process.versions.electron) return null;
  try { return require("electron"); } catch { return null; }
})();

/* 内置浏览器（webview）与后台发布窗口共用这个分区，登录态天然共享。
 * 这是**默认账号**的会话；同平台的额外账号各自有独立分区（persist:acct-<id>），
 * 分区不同 → cookie 不同 → 两个账号互不串会话。 */
const PARTITION = "persist:notefly";

/* ---------- 账号 → 分区解析 ----------
 * 引擎不该知道账号存在哪里（store.json 由服务端管），所以由服务端注入一个解析函数。
 * 没注入时按「accountId 就是平台 id」处理 —— 即原来的单账号行为。 */
let accountResolver = null;
function setAccountResolver(fn) {
  accountResolver = typeof fn === "function" ? fn : null;
}
/** @returns {{id:string, platform:string, partition:string}|null} */
function accountInfo(accountId) {
  const id = String(accountId || "");
  if (!id) return null;
  if (accountResolver) {
    try {
      const r = accountResolver(id);
      if (r) return r;
    } catch { /* 解析失败退回旧口径 */ }
  }
  /* 兜底：当作默认账号（id = 平台 id，共享分区） */
  return { id, platform: id, partition: PARTITION };
}

let ctxPromise = null;
let ctxHeaded = false;
/** 已把 storage-state 注入过当前上下文的平台 */
const stateApplied = new Set();

/* 默认无头运行：发布/巡检不弹任何外部浏览器窗口 */
async function launch(headed) {
  const opts = {
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (headed) {
    opts.viewport = null;
    opts.args.push("--start-maximized");
  } else {
    opts.viewport = { width: 1440, height: 900 };
  }
  return chromium.launchPersistentContext(profileDir(), opts);
}

async function getContext({ headed = false } = {}) {
  /* 关键修复：只要上下文已存在就复用，绝不再按 headed 参数盲目关闭重建。
     旧行为是“headed 不一致就关掉重建”——用户正在登录的可见窗口会被
     巡检/发布请求悄悄关掉重开成无头，登录进度直接丢失。
     浏览器模式下也不做「可见 → 无头」的降级（同样会关掉用户窗口）。 */
  if (!ctxPromise) {
    ctxHeaded = headed;
    ctxPromise = launch(headed).catch((e) => {
      ctxPromise = null;
      throw e;
    });
    return ctxPromise;
  }
  /* 反向升级：无头 → 可见（登录场景）。
     Playwright 无法把已运行的上下文变可见，只能重启；但用的是持久化上下文
     （profileDir()），cookie/登录态在磁盘上，重启后依然有效。
     若此刻有发布任务正在用这个上下文，关掉它会中断任务 —— 这种情况直接拒绝，
     提示用户等任务结束再登录。 */
  if (headed && !ctxHeaded) {
    if (hasOpenWorkers()) {
      throw new Error("当前有发布任务正在执行，无法切换到可见登录窗口；请等待任务结束后再登录");
    }
    const old = ctxPromise;
    ctxPromise = null;
    stateApplied.clear();           // 上下文换了，注入过的登录态要重来
    try { await old.then((c) => c.close()).catch(() => {}); } catch {}
    ctxHeaded = true;
    ctxPromise = launch(true).catch((e) => {
      ctxPromise = null;
      throw e;
    });
  }
  return ctxPromise;
}

/* 是否有正在使用的页面句柄（有 = 正在执行发布/登录，不能动上下文） */
function hasOpenWorkers() {
  for (const [, handles] of activeTasks) {
    for (const h of handles) if (h && h.page) return true;
  }
  return false;
}

function normSameSite(v) {
  const s = String(v || "").toLowerCase();
  if (s === "no_restriction" || s === "none") return "None";
  if (s === "strict") return "Strict";
  return "Lax";
}

/* 把某个平台的导入登录态注入浏览器上下文（cookie + 对应 origin 的 localStorage） */
async function applyState(platform) {
  if (!platform || stateApplied.has(platform)) return;
  stateApplied.add(platform);
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(stateDir(), platform + ".json"), "utf8")); } catch { return; }
  const ctx = await getContext().catch(() => null);
  if (!ctx || !st) return;
  const cookies = (st.cookies || [])
    .filter((c) => c && c.name && c.domain)
    .map((c) => ({
      name: c.name,
      value: c.value == null ? "" : String(c.value),
      domain: c.domain,
      path: c.path || "/",
      expires: typeof c.expires === "number" ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: normSameSite(c.sameSite),
    }));
  if (cookies.length) {
    await ctx.addCookies(cookies).catch((e) => console.warn("[rpa] 注入 cookie 失败:", e.message));
  }
  for (const o of st.origins || []) {
    if (!o || !o.origin || !Array.isArray(o.localStorage) || !o.localStorage.length) continue;
    const map = {};
    for (const it of o.localStorage) if (it && it.name) map[it.name] = it.value == null ? "" : String(it.value);
    await ctx.addInitScript(({ origin, map }) => {
      try {
        if (location.origin !== origin) return;
        for (const k in map) if (localStorage.getItem(k) === null) localStorage.setItem(k, map[k]);
      } catch {}
    }, { origin: o.origin, map });
  }
}

/* 应用内浏览器登录完成 → 写入 storage-state，并立即注入当前上下文 */
async function importState(platform, payload) {
  const { cookies = [], localStorage: ls = [], url = "" } = payload || {};
  const out = {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value == null ? "" : String(c.value),
      domain: c.domain,
      path: c.path || "/",
      expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : typeof c.expires === "number" ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: normSameSite(c.sameSite),
    })),
    origins: [],
    importedAt: new Date().toISOString(),
    sourceUrl: url,
  };
  let origin = "";
  try { origin = new URL(url).origin; } catch {}
  if (origin && ls.length) out.origins.push({ origin, localStorage: ls });
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), platform + ".json"), JSON.stringify(out, null, 2));
  stateApplied.delete(platform);
  await applyState(platform).catch(() => {});
  return { ok: true, cookieCount: out.cookies.length, localStorageCount: ls.length, hasState: out.cookies.length > 0 };
}

/* ---------- Electron 内置会话：默认账号共用 persist:notefly ---------- */
let cdpBrowser = null;
let cdpCtx = null;
/** Playwright Page -> 隐藏 BrowserWindow */
const workerWins = new Map();
/** Playwright Page -> 该页所在分区（复用页面时必须同一账号，否则会串号） */
const workerPartition = new Map();
/** 本次进程里用过的全部分区（「清除全部登录态」时要逐个清） */
const partitionsUsed = new Set();
/** accountId -> 可见登录窗口 {win, partition} */
const loginWins = new Map();

async function getCdpBrowser() {
  if (cdpBrowser && cdpBrowser.isConnected()) return cdpBrowser;
  cdpCtx = null;
  const port = process.env.NOTEFLY_CDP_PORT || "9333";
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  cdpBrowser = browser;
  browser.on("disconnected", () => {
    cdpBrowser = null;
    cdpCtx = null;
    workerPartition.clear();
  });
  return browser;
}

async function getCdpContext() {
  if (cdpCtx && cdpBrowser && cdpBrowser.isConnected()) return cdpCtx;
  const browser = await getCdpBrowser();
  /* 关键：必须复用浏览器里已有的那个 context（内置浏览器所在的分区），
   * 绝不能 newContext() —— 那会开一个空 context，登录态当场丢失。 */
  const ctx = browser.contexts()[0];
  if (!ctx) {
    await browser.close().catch(() => {});
    throw new Error("未找到内置浏览器会话，请重启 NoteFly 桌面版");
  }
  cdpCtx = ctx;
  return ctx;
}

/* 建窗 + 取页是「监听 page 事件 + loadURL」的两步动作，并发建窗会分不清
   哪个事件属于哪扇窗 → 串行化。 */
let ctxLock = Promise.resolve();
function withCtxLock(fn) {
  const p = ctxLock.then(fn, fn);
  ctxLock = p.then(() => {}, () => {});
  return p;
}

/**
 * 在指定分区开一个隐藏窗口并取出它的 Playwright Page。
 * 实测（Electron 真机）：CDP 连接把所有 session 的页面都并入同一个 Playwright
 * context —— 新分区的页面会触发 ctx 的 "page" 事件，**不需要**按 context 差集
 * 定位；分区之间的 cookie/存储隔离由 Chromium 的 partition 机制保证。
 */
async function openWorkerPage(url, partition, cfg = {}) {
  if (typeof ELECTRON === "undefined" || !ELECTRON) return null;
  return withCtxLock(async () => {
    const ctx = await getCdpContext();
    const before = new Set(ctx.pages());
    const win = new ELECTRON.BrowserWindow({
      show: false,
      width: cfg.width || 1440,
      height: cfg.height || 960,
      webPreferences: {
        partition,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const page = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("打开「" + (cfg.label || url) + "」超时：页面没有就绪")), 25000);
      const onPage = (p) => {
        if (before.has(p)) return;
        clearTimeout(timer);
        ctx.off("page", onPage);
        resolve(p);
      };
      ctx.on("page", onPage);
      win.loadURL(url).catch(() => {});
    });

    workerWins.set(page, win);
    workerPartition.set(page, partition);
    partitionsUsed.add(partition);
    page.on("close", () => {
      try { win.destroy(); } catch { /* 忽略 */ }
      workerWins.delete(page);
      workerPartition.delete(page);
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
    await sleep(600);
    return page;
  });
}

/* 在应用内隐藏窗口打开页面：登录态就是该账号所在分区的那一份 */
async function openElectronPage(url, partition = PARTITION, cfg = {}) {
  const targetPartition = partition || PARTITION;
  /* 复用本进程之前开过的后台页（只复用自己创建的、同分区的、没被任务占用的） */
  let origin = "";
  try { origin = new URL(url).origin; } catch { /* 忽略 */ }
  const inUse = new Set();
  for (const [, hs] of activeTasks) for (const h of hs) if (h.page) inUse.add(h.page);
  for (const [p, win] of workerWins) {
    try {
      if (!win.isDestroyed() && !inUse.has(p) && workerPartition.get(p) === targetPartition &&
        origin && p.url().startsWith(origin)) {
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await sleep(300);
        return p;
      }
    } catch { /* 忽略 */ }
  }
  return openWorkerPage(url, targetPartition, cfg);
}

async function openPage(url, accountId) {
  const acct = accountId ? accountInfo(accountId) : { id: "", platform: "", partition: PARTITION };
  if (ELECTRON) return openElectronPage(url, acct.partition, { label: acct.id || acct.platform });
  if (acct.platform) await applyState(acct.platform);
  const ctx = await getContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  return page;
}

/* ---------- 通用工具 ---------- */
async function waitSel(page, selector, timeout = 15000) {
  await page.waitForSelector(selector, { timeout });
  return page.$(selector);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 登录态判定：接口优先（参考 Wechatsync / 掘金社区实践） ----------
 * 做法：在页面上下文里 fetch 平台自己的「当前用户」接口，credentials:'include'
 *       让浏览器自动带上 cookie —— 不需要读取、拼装、复制任何 cookie。
 * 优点：服务端说了算。平台改版换按钮文案、改 DOM 结构都不影响判定结果；
 *       而 DOM 判断（找头像、找「登录」按钮）是最容易误判的一环。
 * judge 约定：
 *   { path: "data.user_id" }            取到值即已登录
 *   { codeField:"err_no", okCode:0 }    该字段等于 okCode 即已登录
 * HTTP 401/403 一律视为未登录；网络失败（多为 CORS）交回 DOM 兜底。
 */
function dig(obj, pathStr) {
  let cur = obj;
  for (const k of String(pathStr || "").split(".")) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

async function apiLoginState(page, spec) {
  if (!spec || !spec.api) return { known: false };
  const raw = await page.evaluate(async (api) => {
    try {
      const res = await fetch(api, { credentials: "include", headers: { accept: "application/json" } });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, head: text.replace(/\s+/g, " ").slice(0, 160) };
    } catch (e) {
      return { netError: String((e && e.message) || e) };
    }
  }, spec.api).catch((e) => ({ netError: String(e.message || e) }));

  if (raw.netError) return { known: false, detail: "接口不可达：" + raw.netError };
  if (raw.status === 401 || raw.status === 403) return { known: true, loggedIn: false, detail: "HTTP " + raw.status };
  if (!raw.status || raw.status >= 500 || !raw.json || typeof raw.json !== "object") return { known: false };

  const j = raw.json;
  if (spec.judge && spec.judge.path) {
    const v = dig(j, spec.judge.path);
    return { known: true, loggedIn: v !== undefined && v !== null && v !== "" && v !== 0, detail: raw.head };
  }
  if (spec.judge && spec.judge.codeField) {
    const code = j[spec.judge.codeField];
    return { known: true, loggedIn: String(code) === String(spec.judge.okCode), detail: raw.head };
  }
  return { known: false };
}

/* 统一的登录态校验：先接口，再 DOM，最后登录 cookie 兜底 */
async function verifyLogin(page, adapter) {
  const api = await apiLoginState(page, adapter.loginProbe);
  if (api.known) return { loggedIn: !!api.loggedIn, method: "api", detail: api.detail || "" };
  if (typeof adapter.isLoggedIn === "function") {
    try {
      const r = await adapter.isLoggedIn(page);
      const obj = (r && typeof r === "object") ? r : { loggedIn: !!r, detail: "" };
      if (obj.loggedIn) return { loggedIn: true, method: "dom", detail: obj.detail || "" };
      /* DOM 说没登录 —— 若适配器声明了「登录 cookie」，用会话里的 cookie 复核一次。
         某些平台（CSDN）页面证据会被推荐卡/其它产品入口干扰，cookie 更硬。 */
      const ck = adapter.loginProbe && adapter.loginProbe.cookieCheck;
      if (ck && ck.domain && Array.isArray(ck.any) && ck.any.length) {
        const hit = await hasLoginCookie(ck);
        if (hit) return { loggedIn: true, method: "cookie", detail: "检测到登录 cookie：" + hit };
        return { loggedIn: false, method: "dom", detail: obj.detail || "" };
      }
      return { loggedIn: false, method: "dom", detail: obj.detail || "" };
    } catch (e) {
      return { loggedIn: false, method: "dom", detail: String(e.message || e).slice(0, 160) };
    }
  }
  return { loggedIn: false, method: "none", detail: "该平台暂未配置登录探测" };
}

/* 会话里是否带着「只有登录才会种下」的 cookie。
   桌面版读内置浏览器分区（与用户登录是同一份）；纯 Playwright 上下文读 context。 */
async function hasLoginCookie(ck) {
  try {
    let names = [];
    if (ELECTRON) {
      const list = await ELECTRON.session.fromPartition(PARTITION).cookies.get({ domain: ck.domain });
      names = list.map((c) => c.name);
    } else if (typeof ctxPromise !== "undefined" && ctxPromise) {
      const ctx = await ctxPromise;
      const list = await ctx.cookies();
      names = list.filter((c) => (c.domain || "").replace(/^\./, "").endsWith(ck.domain)).map((c) => c.name);
    }
    const hit = ck.any.filter((n) => names.includes(n));
    return hit.length ? hit.join(",") : "";
  } catch {
    return "";
  }
}

/* 发布前验真（social-auto-upload 的「上传前先验，别拿过期凭证硬发」）
 * 两项廉价检查：页面是否被踢回登录页 + 接口是否说 must login。 */
const LOGIN_URL_RE = /(\/signin|\/login|\/passport|sso\.|account\/login)/i;
async function preflight(page, adapter) {
  const url = page.url();
  if (LOGIN_URL_RE.test(url)) {
    return { ok: false, reason: "被重定向到登录页（" + url.slice(0, 80) + "）" };
  }
  if (adapter.loginProbe) {
    const api = await apiLoginState(page, adapter.loginProbe);
    if (api.known && !api.loggedIn) return { ok: false, reason: "平台接口返回未登录：" + (api.detail || "") };
  }
  return { ok: true };
}

/* ---------- 适配器注册表 ----------
 * capabilities 三项独立能力，逐项验证、逐项放行：
 *   draft      能否把内容稳定填入编辑器并存为草稿
 *   autoSubmit 能否无人值守自动点发布（必须有提交证据链才可标 verified）
 *   verify     提交后能否自动核验最终结果（作品 ID / 管理页状态 / 公开 URL）
 * 注意：草稿能力验证通过 ≠ 自动提交能力通过，互不通用。 */
const ADAPTERS = {
  juejin: {
    label: "掘金",
    contentType: "ARTICLE",
    composeUrl: "https://juejin.cn/editor/drafts/new",
    status: "verified",
    /* 2026-11-05 真机干跑验证发布链：点「发布」→ 确认面板 .panel（分类 .item 必选）
       →「确定并发布」三步元素全部在位（页面上另有隐藏的 .byte-modal 上传视频旧弹窗，
       不能用它判断弹窗出现）。autoSubmit 据此放行。 */
    capabilities: { draft: "verified", autoSubmit: "verified", verify: "unverified" },
    /* 实测：未登录返回 {"err_no":403,"err_msg":"must login"}，已登录返回 err_no 0 + 矿石数 */
    loginProbe: { api: "https://api.juejin.cn/growth_api/v1/get_cur_point", judge: { codeField: "err_no", okCode: 0 } },
    async isLoggedIn(page) {
      /* 未登录时 /user/center 会被重定向到 /signin，这是最稳的判断 */
      await page.goto("https://juejin.cn/user/center", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await sleep(2500);
      if (/signin|login|passport/i.test(page.url())) return false;
      return page.evaluate(() => {
        try {
          const u = JSON.parse(localStorage.getItem("userInfo") || "null");
          if (u && u.user_id) return true;
        } catch {}
        /* 页面没有「登录」入口，且存在个人中心痕迹，视为已登录 */
        const hasLoginEntry = [...document.querySelectorAll("button, a")].some((el) =>
          /^(登录|登录\/注册|立即登录)$/.test((el.innerText || "").trim())
        );
        return !hasLoginEntry;
      });
    },
    async fill(page, snap) {
      /* 2026-11 实测掘金新编辑器：标题是 input.title-input，正文是 ByteMD + CodeMirror(CM5) */
      await waitSel(page, "input.title-input", 20000);
      await page.fill("input.title-input", snap.title || "");
      await page.locator(".CodeMirror").first().click();
      await page.evaluate(() => {
        const el = document.querySelector(".CodeMirror");
        if (el && el.CodeMirror) el.CodeMirror.setValue("");
      });
      /* 用 insertText 走真实输入事件，能触发掘金自动保存；CM5 setValue 不触发 change */
      await page.keyboard.insertText(snap.body || "");
      await sleep(2500); // 等自动保存草稿
    },
    /* 2026-11-05 实机探针：掘金编辑器页面无封面入口（封面在发布确认面板里选择），
       草稿模式拿不到 —— 如实说明 */
    async uploadCover(page, snap) {
      if (!snap || !snap.cover) return { ok: false, detail: "未设置封面" };
      return { ok: false, detail: "掘金的封面在发布确认面板中从正文图片选择，草稿模式暂不支持，发布时请人工设置" };
    },
    async submit(page) {
      /* 2026-11 实测掘金新编辑器发布确认面板：类名 .panel（含「确定并发布」），
         分类是面板里的 div.item 且必选。页面上另有隐藏的 .byte-modal（上传视频
         旧弹窗）—— 绝不能用 .publish-dialog/.byte-modal 判断弹窗是否出现。 */
      await page.getByRole("button", { name: "发布", exact: true }).first().click();
      const panel = page.locator(".panel", { hasText: "确定并发布" }).first();
      await panel.waitFor({ state: "visible", timeout: 15000 });
      await sleep(800);
      /* 分类必选：点第一项 */
      const cat = panel.locator("div.item").first();
      if (await cat.count()) await cat.click().catch(() => {});
      await sleep(500);
      await panel.getByRole("button", { name: "确定并发布" }).first().click();
      await sleep(3000);
    },
  },

  zhihu: {
    label: "知乎专栏",
    contentType: "ARTICLE",
    composeUrl: "https://zhuanlan.zhihu.com/write",
    homeUrl: "https://www.zhihu.com/",
    status: "unverified",
    capabilities: { draft: "unverified", autoSubmit: "none", verify: "unverified" },
    /* 实测：未登录 HTTP 401 AuthenticationInvalidRequest；已登录返回 id/url_token */
    loginProbe: { api: "https://www.zhihu.com/api/v4/me", judge: { path: "id" } },
    async isLoggedIn(page) {
      await page.goto("https://www.zhihu.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await sleep(2000);
      return page.evaluate(() =>
        !!(document.querySelector('.AppHeader-profile, [class*="ProfileAvatar"], button[aria-label="个人"]'))
      );
    },
    async fill(page, snap) {
      const title = await waitSel(page, 'textarea[placeholder*="标题"], .WriteIndex-titleInput textarea', 20000);
      await title.fill((snap.title || "").slice(0, 100));
      // 知乎正文是 contenteditable（不支持 Markdown 直接注入，去掉 MD 标记写纯文本）
      const editor = await waitSel(page, '.Editable[contenteditable="true"], div[contenteditable="true"]', 20000);
      await editor.click();
      const text = (snap.body || "")
        .replace(/^#{1,6}\s*/gm, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
        .replace(/^\s*[-*]\s+/gm, "• ");
      await page.keyboard.insertText(text);
      await sleep(1500);
    },
    async submit(page) {
      // 草稿自动保存；正式发布需人工处理（知乎发布前有原创声明等设置）
      await page.keyboard.press("Control+s").catch(() => {});
      await sleep(1500);
      throw new Error("知乎请打开浏览器窗口人工确认发布（已自动保存草稿）");
    },
  },

  weibo: {
    label: "微博",
    contentType: "DYNAMIC",
    composeUrl: "https://weibo.com",
    status: "unverified",
    capabilities: { draft: "unverified", autoSubmit: "unverified", verify: "unverified" },
    async isLoggedIn(page) {
      await page.goto("https://weibo.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await sleep(2500);
      return page.evaluate(() => {
        // 被踢到 newlogin = 会话未建立/已过期（哪怕 cookie 还在，微博也不认了）
        if (/newlogin|\/signin|passport\.weibo/i.test(location.href)) {
          return { loggedIn: false, detail: "微博把会话重定向到了登录页（newlogin），请重新登录一次" };
        }
        const loginPop = document.querySelector('[class*="LoginPop"], a[href*="signin"]');
        const nav = document.querySelector('nav, .Main_nav_version');
        if (!loginPop && nav) return { loggedIn: true, detail: "导航栏正常且无登录弹窗" };
        return { loggedIn: false, detail: "页面上出现了登录弹窗" };
      });
    },
    async fill(page, snap) {
      const box = await waitSel(page, '.Form_input, [contenteditable="true"][aria-label], .omp-body .DraftEditor-root div[contenteditable="true"]', 20000);
      await box.click();
      await page.keyboard.insertText((snap.title ? snap.title + "\n" : "") + (snap.body || ""));
      // 图片上传（可选）：/uploads/... 预览地址必须先解析成磁盘真实文件
      if (snap.images && snap.images.length) {
        const localFiles = snap.images.map(resolveLocalMedia).filter(Boolean);
        if (localFiles.length) {
          const fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.setInputFiles(localFiles);
            await sleep(5000); // 等上传
          }
        } else {
          logger.warn("发布引擎", "微博图片全部无法解析为本地文件，跳过图片上传", {
            传入: snap.images.join(", ").slice(0, 300),
          });
        }
      }
      await sleep(1000);
    },
    async submit(page) {
      const btn = await waitSel(page, 'button:has-text("发送"), a:has-text("发送")', 10000);
      await btn.click();
      await sleep(2000);
    },
  },
};

/* ---------- 通用适配器工厂（文章类平台） ----------
 * 大多数头条系/门户号平台的编辑器结构相似：
 *   标题：input[placeholder*="标题"]
 *   正文：ProseMirror / wangEditor / CodeMirror / contenteditable 之一
 * 填充策略按候选选择器逐个尝试，全部失败才报错。
 */
/* 不支持 Markdown 的富文本：去标记写纯文本（幂等，只处理最常见的行内/块级标记） */
function plainTextOf(md) {
  return md
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ");
}
function genericArticleAdapter(cfg) {
  return {
    label: cfg.label,
    contentType: cfg.contentType || "ARTICLE",
    composeUrl: cfg.composeUrl,
    homeUrl: cfg.homeUrl || "",
    loginUrl: cfg.loginUrl || "",
    checkUrl: cfg.checkUrl || "",
    loginProbe: cfg.loginProbe,
    status: "unverified",
    capabilities: { draft: "unverified", autoSubmit: "unverified", verify: "unverified" },
    async isLoggedIn(page) {
      const checkUrl = cfg.checkUrl || cfg.homeUrl || cfg.composeUrl;
      await page.goto(checkUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await sleep(3000);
      return page.evaluate(({ consoleCheck }) => {
        const url = location.href;
        const txtOf = (el) => ((el && (el.innerText || el.textContent)) || "").trim();
        const clsOf = (el) => {
          const c = el && el.className;
          if (!c) return "";
          return typeof c === "string" ? c : (c.baseVal || c.toString ? c.toString() : "");
        };
        const vis = (el) => !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));

        // 被踢到登录页 = 未登录（最可靠的信号，创作者后台未登录时都会重定向）
        if (/login|signin|passport|userAuth/i.test(url)) {
          return { loggedIn: false, detail: "被重定向到登录页（" + url.slice(0, 70) + "）" };
        }

        /* ---- 硬证据优先于登录入口 ----
           CSDN 实测：已登录页同时存在「可见的登录按钮」（toolbar-btn-login，
           属于其它产品的入口）和「隐藏的退出入口 + 个人头像」。
           若先看登录入口必误判。所以先找登录证据，找不到才看登录入口。 */
        // 先探一遍「可见的登录/注册入口」（后面多处要用）
        let visibleLogin = "";
        const entrySel = 'a,button,[role="button"],span[class*="login"],div[class*="login"],a[href*="signin"],a[href*="register"]';
        for (const el of document.querySelectorAll(entrySel)) {
          if (!vis(el)) continue;
          const sig = (clsOf(el) + " " + (el.getAttribute("href") || "") + " " + (el.getAttribute("id") || ""));
          if (/\b(login|signin|sign-in|passport|register)\b/i.test(sig)) { visibleLogin = clsOf(el).slice(0, 40) || sig.slice(0, 40); break; }
          const t = txtOf(el);
          if (/^(登录|注册|登陆|立即登录|免费注册|登录\/注册|新用户注册|sign in|log in|sign up)$/i.test(t)) { visibleLogin = t; break; }
        }
        // a) 退出/登出入口：可见的按文字算；隐藏的必须带 logout 类关键词
        //    且「有个人头像链接」或「页面上没有可见登录入口」佐证。
        let hiddenLogout = null;
        let hasPersonalLink = false;
        for (const el of document.querySelectorAll("a,button,span,div,li")) {
          const t = txtOf(el);
          if (/^(退出登录|退出|登出|退出账号|logout|sign out|log out)$/i.test(t)) {
            if (vis(el)) return { loggedIn: true, detail: "找到可见的退出入口" };
            const sig = (typeof el.className === "string" ? el.className : "") + " " + (el.id || "");
            if (/log(out|in)?|sign ?out/i.test(sig) && !hiddenLogout) hiddenLogout = sig.trim().slice(0, 40);
          }
        }
        for (const el of document.querySelectorAll('[class*="avatar"],img[class*="avatar"],a[class*="avatar"]')) {
          const link = el.closest && el.closest("a[href]");
          const href = link ? (link.getAttribute("href") || "") : "";
          if (href && !/login|signin|passport/i.test(href)) { hasPersonalLink = true; break; }
        }
        if (hiddenLogout && (hasPersonalLink || !visibleLogin)) {
          return { loggedIn: true, detail: "找到退出入口（" + hiddenLogout + "）" + (hasPersonalLink ? "与个人头像链接" : "，且页面无登录入口") };
        }

        // b) 可见用户昵称 —— 有实际文字且可见。
        //    推荐流/作者卡片也会用 nickname 类（简书首页一屏三张卡）：
        //    同一个类名出现多个不同文字 = 列表而非「我」，跳过。
        const seen = {};
        for (const el of document.querySelectorAll(
          '[class*="nickname"],[class*="user-name"],[class*="userName"],[class*="username"],[class*="header-user"],[class*="account-name"]'
        )) {
          const t = txtOf(el);
          if (!t || t.length > 24 || /^(登录|注册|游客|未登录|立即登录)$/.test(t) || !vis(el)) continue;
          const k = clsOf(el);
          (seen[k] = seen[k] || new Set()).add(t);
        }
        for (const [k, set] of Object.entries(seen)) {
          if (set.size === 1) {
            const t = [...set][0];
            return { loggedIn: true, detail: "找到用户昵称「" + t.slice(0, 16) + "」" };
          }
        }
        // c) 头像指向个人主页（可见）—— 必须是个人页链接，不能只按文字兜
        //    （CSDN 首页的推荐卡片带文字但指向别人的博客，按文字兜会误判）
        for (const el of document.querySelectorAll(
          '[class*="avatar"],[class*="user-info"],[class*="userInfo"],[class*="header-user"],img[class*="avatar"]'
        )) {
          if (!vis(el)) continue;
          const link = el.closest && el.closest("a[href]");
          if (link) {
            const href = link.getAttribute("href") || "";
            if (/\/(user|my|member|profile|author|space|account|creator)(\/|$|\?)/i.test(href) && !/login|signin/i.test(href)) {
              return { loggedIn: true, detail: "头像指向个人主页（" + href.slice(0, 50) + "）" };
            }
          }
        }

        /* ---- consoleCheck（创作者后台直检）----
           百家号这类后台：未登录必然重定向到 passport，登录后停在原页。
           「没被跳登录页 + 没有可见登录入口 + 页面有实质内容」= 已登录。 */
        if (consoleCheck) {
          if (!visibleLogin && document.body && document.body.innerText.trim().length > 100) {
            return { loggedIn: true, detail: "创作者后台正常打开，且未出现登录入口" };
          }
          if (visibleLogin) return { loggedIn: false, detail: "页面上有可见的「" + visibleLogin + "」入口" };
        }

        /* ---- 到这里都没有证据，按登录入口判未登录（可见才算）----
           隐藏的登录模板/其它产品的登录链接不能作为未登录依据。 */
        if (visibleLogin) {
          return { loggedIn: false, detail: "页面上有可见的登录入口（" + visibleLogin + "）" };
        }
        return { loggedIn: false, detail: "页面上找不到登录证据（昵称/头像/退出入口都没有）" };
      }, { consoleCheck: !!cfg.consoleCheck });
    },
    async fill(page, snap) {
      // 后台入口已下线/改版时页面标题通常带 404（如搜狐号 2026-11 改版），
      // 提前给出明确错误，不落到模糊的「编辑器未找到」
      const pageTitle = await page.title().catch(() => "");
      if (/404|页面不存在|页面找不到/.test(pageTitle)) {
        throw new Error(`[${cfg.label}] 后台入口页面已失效（${pageTitle.slice(0, 30)}），平台可能已改版或下线该路径，请在账号页人工检查`);
      }
      /* 平台「恢复上次草稿」弹窗（搜狐「继续编辑」等）会挡住编辑器初始化，
         不处理会让 fill 轮询超时 —— 2026-11-05 实机复发。点击进入后清残留。 */
      if (cfg.resumeDraftSel) {
        /* 平台「恢复上次草稿」弹窗（搜狐「继续编辑」等）：精确文本定位点击 */
        try {
          const loc = page.getByText(cfg.resumeDraftSel, { exact: true }).first();
          if (await loc.isVisible()) { await loc.click(); await sleep(3000); }
        } catch { /* 无弹窗，正常继续 */ }
      }
      // 中转入口：composeUrl 落在列表/首页路由时（编辑器元素不存在），先点一步进去
      if (cfg.entrySel) {
        const bodySels0 = cfg.bodySel || ["div[contenteditable='true']"];
        const titleSel0 = cfg.titleSel || 'input[placeholder*="标题"]';
        const inEditor = (await page.$(titleSel0).catch(() => null)) ||
          (await page.$(bodySels0[0]).catch(() => null));
        if (!inEditor) {
          const entry = await page.$(cfg.entrySel).catch(() => null);
          if (entry) {
            await entry.click().catch(() => {});
            await sleep(3000);
          }
        }
      }
      // Lexical 单根编辑器（百家号 FeEditor）：标题与正文同一个 contenteditable，
      // 第一行=标题。必须「标题→回车→正文」一次打完，分别填会把正文写进标题行
      if (cfg.lexicalSingleRoot) {
        const rootSel = (cfg.bodySel || ["div[contenteditable='true']"])[0];
        const root = await waitSel(page, rootSel, 20000).catch(() => null);
        if (!root) throw new Error(`[${cfg.label}] 未找到编辑器根元素`);
        await root.evaluate((n) => n.focus());
        const t0 = (snap.title || "").slice(0, cfg.titleMax || 64);
        if (t0) {
          await page.keyboard.insertText(t0);
          await page.keyboard.press("Enter");
        }
        await page.keyboard.insertText(cfg.plainText ? plainTextOf(snap.body || "") : (snap.body || ""));
        await sleep(1500);
        return;
      }
      // 标题
      const titleSel = cfg.titleSel || 'input[placeholder*="标题"], textarea[placeholder*="标题"]';
      const title = await waitSel(page, titleSel, 20000).catch(() => null);
      const titleText = (snap.title || "").slice(0, cfg.titleMax || 100);
      let titleDone = false;
      if (title && (await title.isVisible().catch(() => false))) {
        titleDone = await title.fill(titleText).then(() => true)
          .catch(() => false);
      }
      if (!titleDone) {
        /* CSDN 等「展示态」标题：无内容时显示 DIV（article-bar__title-display），
           真正的 input display:none —— 点击展示态切换出输入框（焦点自动落 input），
           2026-11-05 真机验证：点击后 insertText 直写成功 */
        const displayEl = await page.$('[class*="title-display"]').catch(() => null);
        if (displayEl && (await displayEl.isVisible().catch(() => false))) {
          await displayEl.click({ force: true }).catch(() => {});
          await sleep(800);
        }
        if (title) {
          titleDone = await title.fill(titleText).then(() => true).catch(() => false);
        }
        if (!titleDone && titleText) {
          /* 兜底 A：焦点已在输入框（点击展示态后），直接打字 */
          const activeOk = await page.evaluate(() => {
            const el = document.activeElement;
            return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && /title|标题/i.test(String(el.className) + (el.placeholder || ""));
          }).catch(() => false);
          if (activeOk) {
            await page.keyboard.insertText(titleText);
            titleDone = await page.evaluate((t) => {
              const el = document.activeElement;
              return el && (el.value === t || el.innerText === t);
            }, titleText).catch(() => false);
          }
        }
        if (!titleDone && titleText) {
          /* 兜底 B：React 受控组件用原生 setter 强制赋值并派发 input 事件 */
          titleDone = await page.evaluate(({ sel, text }) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(el, text);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return el.value === text;
          }, { sel: titleSel.split(",")[0].trim(), text: titleText }).catch(() => false);
        }
        if (!titleDone) console.warn(`[${cfg.label}] 标题填充失败，继续填正文`);
      }

      // 正文：按模式写入
      const body = snap.body || "";
      const bodySels = cfg.bodySel || [
        ".CodeMirror",                    // CodeMirror（Markdown）
        ".ProseMirror",                   // ProseMirror（头条系）
        ".w-e-text[contenteditable]",     // wangEditor
        "div[contenteditable='true']",    // 通用 contenteditable
        "textarea.el-textarea__inner, textarea",
      ];
      let done = false;
      let lastErr = "";
      /* 正文候选轮询等待最多 15s：编辑器 JS 初始化可能比标题框慢
         （搜狐号冷启动首开时 .ql-editor 迟到，一次性检查会假报「编辑器未找到」） */
      const bodyDeadline = Date.now() + 15000;
      while (!done && Date.now() < bodyDeadline) {
        for (const sel of bodySels) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        // 不可见的编辑器元素（如 CSDN 页面上隐藏的反馈 textarea）绝不能拿来填正文
        if (!(await el.isVisible().catch(() => false))) continue;
        // 残留清空：搜狐「继续编辑」/ 大鱼「已载入上次的草稿」会把旧内容留在编辑器，
        // 不清会导致新旧正文混排（2026-11-05 实机）—— 只在第一次命中时清一次
        if (cfg.clearBeforeFill && !done) {
          await el.evaluate((n) => n.focus()).catch(() => {});
          await page.keyboard.press("Control+a").catch(() => {});
          await page.keyboard.press("Delete").catch(() => {});
          await sleep(600);
        }
        try {
          if (sel.includes("CodeMirror")) {
            const ok = await page.evaluate((md) => {
              const cmEl = document.querySelector(".CodeMirror");
              if (cmEl && cmEl.CodeMirror) { cmEl.CodeMirror.setValue(md); return true; }
              return false;
            }, body);
            if (ok) { done = true; break; }
          } else if (sel.startsWith("textarea")) {
            await el.fill(body);
            done = true; break;
          } else {
            // focus 优先于 click：focus 是 DOM 行为，不会被浮层/hit-target 检查拦截
            // （百家号 FeEditor 的 click 会被命中检测卡到超时）
            const focused = await el.evaluate((n) => {
              n.focus();
              return document.activeElement === n || n.contains(document.activeElement);
            }).catch(() => false);
            if (!focused) await el.click({ force: true }).catch(() => {});
            if (cfg.plainText) {
              await page.keyboard.insertText(plainTextOf(body));
            } else {
              await page.keyboard.insertText(body);
            }
            done = true; break;
          }
        } catch (e) {
          lastErr = String(e.message || e);
        }
      }
        if (!done) await sleep(1200);
      }
      // iframe 兜底：UEditor 系（大鱼号等）把编辑区放在 iframe 的 body 里，
      // 主文档选择器永远找不到
      if (!done) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const el = await frame.$("body[contenteditable='true'], body[contenteditable='']").catch(() => null);
          if (!el || !(await el.isVisible().catch(() => false))) continue;
          try {
            await el.focus().catch(() => {});
            await page.keyboard.insertText(cfg.plainText ? plainTextOf(body) : body);
            done = true; break;
          } catch (e) {
            lastErr = String(e.message || e);
          }
        }
      }
      if (!done) throw new Error(`[${cfg.label}] 正文填充失败（编辑器未找到或改版）${lastErr ? "：" + lastErr : ""}`);
      await sleep(1500);
    },
    /* 草稿模式收尾：点平台的「存草稿」，让内容真正落到草稿箱。
       没配置存草稿按钮 / 按钮点不到时不算失败 —— 内容还在编辑器里，人工可存可发。 */
    async saveDraft(page) {
      if (cfg.draftAutoSave) return { ok: true, detail: "平台自动保存草稿，无需手动存" };
      const sels = cfg.draftSaveSel || [];
      for (const sel of sels) {
        const btn = await waitSel(page, sel, 4000).catch(() => null);
        if (!btn) continue;
        if (!(await btn.isVisible().catch(() => false))) continue;
        /* 文案防线：按钮文本必须含 存草稿/保存/草稿，防止点错「发布」类按钮 */
        const txt = (await btn.innerText().catch(() => "")) || "";
        if (!/草稿|保存/.test(txt)) continue;
        await btn.click().catch(() => {});
        await sleep(2500);
        /* 平台弹确认对话框（一点号「确认保存？」等）：点一次 确定/确认/保存 */
        const confirmSel = 'button:has-text("确定"), button:has-text("确认"), button:has-text("保存"), .el-button--primary, [class*="confirm"] button';
        for (const csel of confirmSel.split(", ")) {
          const c = await page.$(csel).catch(() => null);
          if (!c || !(await c.isVisible().catch(() => false))) continue;
          const ctxt = ((await c.innerText().catch(() => "")) || "").trim();
          if (!/确定|确认|保存|是/.test(ctxt)) continue;
          await c.click().catch(() => {});
          await sleep(2000);
          return { ok: true, detail: `已点击「${txt.trim().slice(0, 8)}」并确认弹窗「${ctxt.slice(0, 6)}」` };
        }
        return { ok: true, detail: `已点击「${txt.trim().slice(0, 8)}」，草稿已请求保存` };
      }
      return { ok: false, detail: "未找到存草稿按钮，内容停留在编辑器页，请人工保存或发布" };
    },
    /* 封面上传（DOM 路线）：点平台配置的封面入口 → 等 file 控件出现/文件对话框弹出 →
       注入本地封面。参考 MultiPost/Wechatsync 的做法：能走平台接口的平台直接在
       saveDraft 里一并传，不走这里。未配置入口的平台返回明确说明，不阻塞发布。 */
    async uploadCover(page, snap) {
      const local = resolveLocalMedia(snap && snap.cover);
      if (!local) {
        return { ok: false, detail: snap && snap.cover ? "封面不是本地文件，跳过上传" : "未设置封面" };
      }
      const injectIntoImageInputs = async () => {
        const els = page.locator('input[type=file]');
        const n = await els.count();
        for (let i = 0; i < n; i++) {
          const el = els.nth(i);
          const accept = (await el.getAttribute("accept").catch(() => "")) || "";
          if (!/image/i.test(accept)) continue;
          const cls = (await el.getAttribute("class").catch(() => "")) || "";
          /* 反馈表单/非封面上传控件（CSDN cfw 反馈框等）—— 封面注进去等于
             把图发给平台客服，2026-11-05 实机事故 */
          if (/cfw|feedback|report/i.test(cls)) continue;
          if (/\.md/i.test(accept)) continue;
          await el.setInputFiles(local).catch(() => {});
          await sleep(4000);
          return true;
        }
        return false;
      };
      /* 注入后验证：封面缩略图应出现在页面里（注入前后大图对比）。
         没有 → 平台拒收（如 webp）或注入了错误控件，如实回报 */
      const countBigImgs = () => page.evaluate(() =>
        [...document.querySelectorAll("img")].filter((im) => im.getBoundingClientRect().width > 40 && im.getBoundingClientRect().height > 30).length
      ).catch(() => 0);
      /* 平台封面在发布弹窗（CSDN/掘金）等草稿模式拿不到的场景：如实说明，不瞎扫控件 */
      if (cfg.coverNote) return { ok: false, detail: cfg.coverNote };
      const before = await countBigImgs();
      for (const sel of cfg.coverBtnSel || []) {
        const btn = await page.$(sel).catch(() => null);
        if (!btn || !(await btn.isVisible().catch(() => false))) continue;
        const fcPromise = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
        await btn.click().catch(() => {});
        /* 搜狐等平台点击后才挂载 image file input，轮询等待 */
        for (let i = 0; i < 10; i++) {
          await sleep(500);
          if (await injectIntoImageInputs()) {
            await sleep(6000);
            if ((await countBigImgs()) > before) return { ok: true, detail: "封面已上传" };
            /* 注入后没有新图 —— 平台可能拒收了文件（如 webp），如实回报 */
          }
        }
        const fc = await fcPromise;
        if (fc) {
          await fc.setFiles(local).catch(() => {});
          await sleep(6000);
          if ((await countBigImgs()) > before) return { ok: true, detail: "封面已通过文件对话框上传" };
        }
      }
      if (await injectIntoImageInputs()) {
        await sleep(6000);
        if ((await countBigImgs()) > before) return { ok: true, detail: "封面已上传（通用控件注入）" };
        return { ok: false, detail: "封面已注入控件但未出现预览 —— 平台可能拒收该格式，请改用 jpg/png 后重试" };
      }
      return { ok: false, detail: "未找到封面上传入口，请人工补传" };
    },
    async submit(page) {
      const sel = cfg.submitSel || 'button:has-text("发布"), button:has-text("发表")';
      const btn = await waitSel(page, sel, 10000).catch(() => null);
      if (btn) {
        await btn.click();
        await sleep(2000);
      } else {
        throw new Error(`[${cfg.label}] 未找到发布按钮，请在打开的浏览器窗口人工确认（内容已填充）`);
      }
    },
  };
}

/* ---------- 百家号接口存稿（移植 MultiPost-Extension baijiahao 适配器） ----------
 * DOM 路线在百家号走不通：Lexical 编辑器封面上传面板只有「找素材」入口，
 * 没有本地文件上传控件。MultiPost 的成熟做法是直接调平台内部接口：
 *   1. marked 把 Markdown 转 HTML（vendor/marked.min.js 注入页面上下文）
 *   2. 封面 → /materialui/picture/uploadProxy 上传 → CuttingPicproxy 裁横竖版
 *   3. /pcui/article/save 一并提交标题/正文/封面（errno=0 返回草稿 id）
 * 全部在页面上下文 fetch（credentials: include 自动带登录态），Token 取 localStorage。
 */
async function baijiahaoApiDraft(page, snap) {
  const coverPath = resolveLocalMedia(snap && snap.cover);
  const coverBuf = coverPath ? new Uint8Array(fs.readFileSync(coverPath)) : null;
  const coverName = coverPath ? path.basename(coverPath) : "";
  const markedPath = path.join(__dirname, "..", "public", "vendor", "marked.min.js");
  const markedSrc = fs.existsSync(markedPath) ? fs.readFileSync(markedPath, "utf8") : "";
  await page.evaluate((src) => {
    if (src && !window.marked) {
      try { (0, eval)(src); } catch { /* marked 不可用时回退简单换行转换 */ }
    }
  }, markedSrc);
  const r = await page.evaluate(async ({ title, body, coverBuf, coverName }) => {
    const html = (window.marked && typeof window.marked.parse === "function")
      ? window.marked.parse(body || "")
      : "<p>" + String(body || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>") + "</p>";
    let coverImages = null, coverMap = null, verticalCover = "";
    if (coverBuf) {
      const token = (localStorage.getItem("edit-token") || "").replace(/"/g, "");
      const file = new File([coverBuf], coverName || "cover", { type: "image/webp" });
      const fd = new FormData();
      fd.append("org_file_name", coverName || "cover");
      fd.append("type", "image");
      fd.append("app_id", "");
      fd.append("is_waterlog", "1");
      fd.append("save_material", "1");
      fd.append("no_compress", "0");
      fd.append("is_events", "");
      fd.append("article_type", "news");
      fd.append("media", file);
      const up = await fetch("https://baijiahao.baidu.com/materialui/picture/uploadProxy", {
        method: "POST", body: fd, credentials: "include", headers: { Token: token },
      });
      const ur = await up.json();
      const src = ur && ur.ret && ur.ret.https_url;
      if (!src) throw new Error("封面上传失败：" + JSON.stringify(ur).slice(0, 100));
      const dims = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = src;
      });
      if (!dims) throw new Error("封面尺寸获取失败");
      const calc = (ratio) => {
        let x = 0, y = 0, w, h;
        if (dims.w / dims.h > ratio) { h = dims.h; w = Math.floor(h * ratio); x = Math.floor((dims.w - w) / 2); }
        else { w = dims.w; h = Math.floor(w / ratio); y = Math.floor((dims.h - h) / 2); }
        return { x, y, w, h };
      };
      const crop = async (p) => {
        const cd = new FormData();
        cd.append("auto", "true");
        for (const [k, v] of Object.entries(p)) cd.append(k, String(v));
        cd.append("src", src);
        cd.append("type", "newsRow");
        cd.append("cutting_type", "cover_image");
        const cr = await (await fetch("https://baijiahao.baidu.com/pcui/Picture/CuttingPicproxy", { method: "POST", body: cd })).json();
        return cr && cr.errno === 0 && cr.data && cr.data.https_src;
      };
      const cp1 = calc(1.5), cp2 = calc(0.75);
      const hUrl = await crop(cp1);
      const vUrl = await crop(cp2);
      coverImages = [{ src: hUrl || src, cropData: { x: cp1.x, y: cp1.y, width: cp1.w, height: cp1.h }, machine_chooseimg: 0, isLegal: 0, cover_source_tag: "local" }];
      coverMap = [{ src: hUrl || src, origin_src: src }];
      verticalCover = vUrl || "";
    }
    const fd2 = new FormData();
    const len = (new DOMParser().parseFromString(html, "text/html").documentElement.textContent || "").length;
    fd2.append("type", "news");
    fd2.append("title", (title || "").slice(0, 64));
    fd2.append("content", html);
    fd2.append("vertical_cover", verticalCover);
    fd2.append("abstract", "");
    fd2.append("len", String(len));
    fd2.append("activity_list[0][id]", "ttv");
    fd2.append("activity_list[0][is_checked]", "1");
    fd2.append("activity_list[1][id]", "ai_tts");
    fd2.append("activity_list[1][is_checked]", "1");
    fd2.append("activity_list[2][id]", "reward");
    fd2.append("activity_list[2][is_checked]", "1");
    fd2.append("activity_list[3][id]", "aigc_bjh_status");
    fd2.append("activity_list[3][is_checked]", "0");
    fd2.append("source_reprinted_allow", "0");
    fd2.append("is_auto_optimize_cover", "1");
    fd2.append("abstract_from", "1");
    fd2.append("cover_layout", "one");
    fd2.append("cover_image_source[wide_cover_image_source]", "local");
    fd2.append("isBeautify", "false");
    fd2.append("usingImgFilter", "false");
    fd2.append("first_exclusive_publish_v2", "3");
    fd2.append("subtitle", "");
    fd2.append("bjhtopic_id", "");
    fd2.append("bjhtopic_info", "");
    if (coverImages) {
      fd2.append("cover_images", JSON.stringify(coverImages));
      fd2.append("_cover_images_map", JSON.stringify(coverMap));
    }
    fd2.append("source", "upload");
    fd2.append("cover_source", "upload");
    const token2 = (localStorage.getItem("edit-token") || "").replace(/"/g, "");
    const resp = await fetch("https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft", {
      method: "POST", body: fd2, credentials: "include", headers: { Token: token2 },
    });
    const rj = await resp.json();
    if (rj.errno !== 0) throw new Error("百家号存稿失败：" + String(rj.message || JSON.stringify(rj)).slice(0, 100));
    return { id: (rj.ret && rj.ret.id) || "" };
  }, { title: (snap && snap.title) || "", body: (snap && snap.body) || "", coverBuf, coverName });
  return { ok: true, detail: "已通过百家号接口存草稿" + (r.id ? "（草稿 id " + r.id + "，含封面）" : "（无封面）"), draftId: r.id };
}

const ADAPTERS_EXTRA = {
  csdn: genericArticleAdapter({
    label: "CSDN",
    composeUrl: "https://editor.csdn.net/md/",
    homeUrl: "https://www.csdn.net/",
    /* 首页有 WAF，内置浏览器打开偶发 403；登录一律走官方登录页 */
    loginUrl: "https://passport.csdn.net/login",
    /* DOM 判定的兜底：csdn.net 的 UserToken/UserNick 只在登录后种下
       （2026-11-05 实机 cookie 审计确认），页面证据模糊时用会话 cookie 复核 */
    loginProbe: { cookieCheck: { domain: "csdn.net", any: ["UserToken", "UserNick"] } },
    titleSel: 'input[placeholder*="标题"], .article-bar input',
    /* 2026-11 实机探针：CSDN 编辑器已改为 StackEdit 风格 contenteditable pre，
       旧 .CodeMirror（CM5 API）失效；页面上还有隐藏的反馈 textarea，
       因此候选列表必须先验可见性（fill 循环已内置 isVisible 过滤） */
    bodySel: ["pre.editor__inner", ".CodeMirror", "div[contenteditable='true']", "textarea"],
    /* 2026-11-05 实机探针：工具栏「保存草稿」button.btn-save（el-popover__reference） */
    draftSaveSel: ["button.btn-save"],
    /* 2026-11-05 实机探针：CSDN 编辑器页面无封面入口（封面在「发布文章」弹窗里），
       草稿模式拿不到 —— 如实说明，不再乱扫控件（此前封面被注进反馈表单） */
    coverNote: "CSDN 的封面在「发布文章」弹窗中设置，草稿模式暂不支持，发布时请人工上传封面",
  }),
  toutiao: (() => {
    const ad = genericArticleAdapter({
      label: "头条号",
      composeUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
      homeUrl: "https://mp.toutiao.com/",
      /* 2026-11-05 实机探针：头条标题是 textarea（无 class，placeholder 动态） */
      titleSel: 'textarea[placeholder*="标题"], input[placeholder*="标题"], .publish-title textarea, .publish-title input',
      bodySel: [".ProseMirror", "div[contenteditable='true']"],
      titleMax: 30,
      submitSel: 'button:has-text("发布"), button:has-text("发表")',
      /* 2026-11-05 实机探针：头条号编辑页左下角「草稿将自动保存」，无需点按钮 */
      draftAutoSave: true,
    });
    /* 头条封面专属流程（通用入口拿不到）：封面设置是 radio 组「单图/三图/无封面」
       → 点「单图」→ 出现上传图片框 → 点击后 filechooser/动态 input 注入 */
    ad.uploadCover = async function (page, snap) {
      const local = resolveLocalMedia(snap && snap.cover);
      if (!local) return { ok: false, detail: snap && snap.cover ? "封面不是本地文件，跳过上传" : "未设置封面" };
      const radio = await page.$('label:has-text("单图"), .byte-radio:has-text("单图")').catch(() => null);
      if (radio) {
        const checked = await radio.evaluate((n) => /checked|active/.test(String(n.className)) || /checked|active/.test(String(n.parentElement.className))).catch(() => false);
        if (!checked) { await radio.click().catch(() => {}); await sleep(2000); }
      }
      /* 上传框：2026-11-05 真机实测 .article-cover-add（154x120 图片框），
         点击后挂载 file input，注入后封面缩略图出现在页面 */
      const zoneSels = [".article-cover-add", '[class*="cover"] [class*="add"]', '[class*="upload-cover"]'];
      const before = await page.evaluate(() => [...document.querySelectorAll("img")].filter((im) => im.getBoundingClientRect().width > 40).length).catch(() => 0);
      for (const sel of zoneSels) {
        const zone = await page.$(sel).catch(() => null);
        if (!zone || !(await zone.isVisible().catch(() => false))) continue;
        const fcPromise = page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null);
        await zone.click({ force: true }).catch(() => {});
        await sleep(1500);
        const els = page.locator('input[type=file]');
        const n = await els.count();
        for (let k = 0; k < n; k++) {
          const accept = (await els.nth(k).getAttribute("accept").catch(() => "")) || "";
          if (!/image/i.test(accept)) continue;
          await els.nth(k).setInputFiles(local).catch(() => {});
          await sleep(6000);
          const after = await page.evaluate(() => [...document.querySelectorAll("img")].filter((im) => im.getBoundingClientRect().width > 40).length).catch(() => 0);
          if (after > before) return { ok: true, detail: "封面已上传" };
        }
        const fc = await fcPromise;
        if (fc) {
          await fc.setFiles(local).catch(() => {});
          await sleep(6000);
          const after = await page.evaluate(() => [...document.querySelectorAll("img")].filter((im) => im.getBoundingClientRect().width > 40).length).catch(() => 0);
          if (after > before) return { ok: true, detail: "封面已通过文件对话框上传" };
        }
      }
      return { ok: false, detail: "未找到头条封面上传区（单图模式已尝试），请人工补传" };
    };
    return ad;
  })(),
  baijiahao: (() => {
    const base = genericArticleAdapter({
      label: "百家号",
      composeUrl: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
      homeUrl: "https://baijiahao.baidu.com/",
      /* 首页是内容 feed（无任何登录证据）。登录检测走作者后台：
         未登录必被重定向到 passport.baidu.com，登录后停在原页（2026-11-05 实机验证） */
      checkUrl: "https://baijiahao.baidu.com/builder/rc/home",
      consoleCheck: true,
      titleSel: 'input[placeholder*="标题"]',
      /* 2026-11-05 实机探针：百家号已换 FeEditor（Lexical）新编辑器，
         标题与正文同一个 contenteditable 根（第一行=标题），且无 input 标题框；
         其 click 会被浮层命中检测卡到超时，fill 循环改用 focus() 绕过 */
      bodySel: ['div[class*="FeEditor"][contenteditable="true"]', ".ProseMirror", ".w-e-text[contenteditable]", "div[contenteditable='true']"],
      titleMax: 64,
      plainText: false,
      lexicalSingleRoot: true,
    });
    /* 封面与存稿走平台内部接口（DOM 面板没有本地上传入口）；
       接口失败回退 DOM 填充 + 存草稿按钮 */
    return Object.assign({}, base, {
      async fill(page, snap) {
        page._nfSnap = snap; /* 快照暂存，saveDraft 回退 DOM 时用 */
      },
      async uploadCover() {
        return { ok: true, detail: "封面随接口存稿一并上传" };
      },
      async saveDraft(page, snap) {
        const s = snap || page._nfSnap || {};
        try {
          return await baijiahaoApiDraft(page, s);
        } catch (e) {
          logger.warn("发布引擎", "百家号接口存稿失败，回退 DOM 填充（无封面）", { 错误: String(e.message || e).slice(0, 150) });
        }
        await base.fill(page, s);
        const dr = await base.saveDraft(page, s);
        return { ok: dr.ok, detail: (dr.detail || "") + "；封面未能自动上传，请人工补传" };
      },
    });
  })(),
  sohu: genericArticleAdapter({
    label: "搜狐号",
    /* 2026-11-05 实机探针（用户提供新创作中心地址后确认）：
       旧入口 /mpbp/bp/base-info 已 404 下线；新后台 mpfe/v4，
       文章编辑器 /news/addarticle?contentStatus=1，正文是 Quill（.ql-editor）。
       发布时可能触发腾讯滑块验证码（turing.captcha.gtimg.com）→ 停在草稿人工处理 */
    composeUrl: "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1",
    homeUrl: "https://mp.sohu.com/",
    titleSel: 'input[placeholder*="标题"]',
    bodySel: [".ql-editor", ".w-e-text[contenteditable]", ".ProseMirror", "div[contenteditable='true']"],
    plainText: true,
    /* 2026-11-05 实机探针：发布区有 发布/定时发布/存草稿 三个 li.publish-report-btn，
       必须用文本限定锁定「存草稿」，否则会拿到「发布」 */
    draftSaveSel: ['li.publish-report-btn:has-text("存草稿")'],
    /* 封面：点「上传图片」div.upload-file.mp-upload 后才挂载 image file input */
    coverBtnSel: ["div.upload-file.mp-upload"],
    /* 2026-11-05 实机：编辑器打开时若有历史草稿会弹「继续编辑」面板挡住初始化，
       导致 fill 轮询 15s 超时（16:49 任务复发）。点进去并清残留 */
    resumeDraftSel: "继续编辑",
    clearBeforeFill: true,
  }),
  oschina: genericArticleAdapter({
    label: "开源中国",
    composeUrl: "https://my.oschina.net/blog/write",
    homeUrl: "https://my.oschina.net/",
    titleSel: 'input[placeholder*="标题"], input[name="title"]',
    bodySel: [".CodeMirror", "div[contenteditable='true']", "textarea"],
  }),
  yidian: genericArticleAdapter({
    label: "一点号",
    composeUrl: "https://mp.yidianzixun.com/home/q/editor",
    homeUrl: "https://mp.yidianzixun.com/",
    /* 2026-11 实测：composeUrl 打开后落在 #/Home 文章列表（无任何编辑器元素），
       必须再点侧栏「发文章」（a[href="#/Writing/articleEditor"]）才进编辑器 */
    entrySel: 'a[href="#/Writing/articleEditor"]',
    /* 2026-11-05 实机探针：标题 input.post-title（通用 placeholder 选择器也命中） */
    titleSel: 'input.post-title, input[placeholder*="标题"]',
    bodySel: [".ProseMirror", "div[contenteditable='true']"],
    /* 一点号编辑器存草稿按钮未实测，给通用候选；找不到时回退停在编辑器 */
    draftSaveSel: ['button:has-text("存草稿")', 'button:has-text("保存")'],
    /* 2026-11-05 实机探针：编辑器右上「添加封面」→ upload-input 常驻 */
    coverBtnSel: ['div:has-text("添加封面")', 'input[type=file][accept*=image]'],
  }),
  dayu: genericArticleAdapter({
    label: "大鱼号",
    composeUrl: "https://mp.dayu.com/dashboard/article/write",
    homeUrl: "https://mp.dayu.com/",
    titleSel: 'input[placeholder*="标题"]',
    bodySel: [".ProseMirror", ".w-e-text[contenteditable]", "div[contenteditable='true']"],
    /* 2026-11-05 实机探针：编辑区下方「保存」button.w-btn；
       且页面会「自动载入上次的草稿」→ 填前清残留 */
    draftSaveSel: ['button.w-btn:has-text("保存")'],
    clearBeforeFill: true,
    /* 封面按钮为两层结构（点封面入口 → 面板里上传），交给通用兜底注入 */
    coverBtnSel: ['[class*="cover_normal-item"]', 'div:has-text("添加封面")'],
  }),
  /* ---------- 第二批平台（参照同类分发产品扩充，均为纯文字创作后台） ---------- */
  weixin: genericArticleAdapter({
    label: "微信公众号",
    composeUrl: "https://mp.weixin.qq.com/",
    homeUrl: "https://mp.weixin.qq.com/",
    titleSel: 'input[placeholder*="标题"], textarea[placeholder*="标题"], #title',
    bodySel: ["div[contenteditable='true']", ".ProseMirror", "iframe"],
  }),
  netease: genericArticleAdapter({
    label: "网易号",
    composeUrl: "https://mp.163.com/",
    homeUrl: "https://mp.163.com/",
    titleSel: 'input[placeholder*="标题"], input[class*="title"]',
    bodySel: [".ProseMirror", "div[contenteditable='true']", "textarea"],
  }),
  penguin: genericArticleAdapter({
    label: "企鹅号",
    composeUrl: "https://om.qq.com/userAuth/index",
    homeUrl: "https://om.qq.com/",
    titleSel: 'input[placeholder*="标题"], input[class*="title"]',
    bodySel: [".ProseMirror", ".w-e-text[contenteditable]", "div[contenteditable='true']"],
  }),
  jianshu: genericArticleAdapter({
    label: "简书",
    composeUrl: "https://www.jianshu.com/writer",
    homeUrl: "https://www.jianshu.com/",
    /* 首页推荐流里全是其他作者的 nickname 卡片，不能作为检测点；
       /writer 未登录必被重定向到登录页，登录后停在原页 */
    checkUrl: "https://www.jianshu.com/writer",
    consoleCheck: true,
    titleSel: 'input[placeholder*="标题"], textarea[placeholder*="标题"]',
    bodySel: [".ProseMirror", "div[contenteditable='true']", "textarea"],
  }),
  cnblogs: genericArticleAdapter({
    label: "博客园",
    composeUrl: "https://i.cnblogs.com/posts/edit",
    homeUrl: "https://www.cnblogs.com/",
    titleSel: 'input[placeholder*="标题"], input#post-title',
    bodySel: [".CodeMirror", "div[contenteditable='true']", "textarea"],
  }),
  segmentfault: genericArticleAdapter({
    label: "思否 SegmentFault",
    composeUrl: "https://segmentfault.com/write",
    homeUrl: "https://segmentfault.com/",
    titleSel: 'input[placeholder*="标题"], input[name="title"]',
    bodySel: [".CodeMirror", ".ProseMirror", "div[contenteditable='true']"],
  }),
  infoq: genericArticleAdapter({
    label: "InfoQ 写作社区",
    composeUrl: "https://xie.infoq.cn/",
    homeUrl: "https://xie.infoq.cn/",
    titleSel: 'input[placeholder*="标题"], textarea[placeholder*="标题"]',
    bodySel: [".ProseMirror", "div[contenteditable='true']", "textarea"],
  }),
  "51cto": genericArticleAdapter({
    label: "51CTO博客",
    composeUrl: "https://blog.51cto.com/",
    homeUrl: "https://blog.51cto.com/",
    titleSel: 'input[placeholder*="标题"], input[class*="title"]',
    bodySel: [".ProseMirror", ".CodeMirror", "div[contenteditable='true']", "textarea"],
  }),
  bilibili: genericArticleAdapter({
    label: "B站专栏",
    composeUrl: "https://member.bilibili.com/platform/text-edit",
    homeUrl: "https://member.bilibili.com/",
    titleSel: 'input[placeholder*="标题"], input[class*="title"]',
    bodySel: [".ProseMirror", "div[contenteditable='true']", "textarea"],
  }),
};

/* ---------- 任务页句柄（进程内，重启后失效） ---------- */
Object.assign(ADAPTERS, ADAPTERS_EXTRA); // 合并通用平台适配器
/** groupId -> [{ platform, page, state }] */
const activeTasks = new Map();

function loginUrlOf(a) {
  if (a.loginUrl) return a.loginUrl;   /* 显式登录页优先（CSDN 首页有 WAF 会 403） */
  if (a.homeUrl) return a.homeUrl;
  try { return new URL(a.composeUrl).origin + "/"; } catch { return a.composeUrl; }
}

function listPlatforms() {
  return Object.entries(ADAPTERS).map(([id, a]) => ({
    id,
    platform: id,
    label: a.label,
    contentType: a.contentType,
    status: a.status,
    capabilities: a.capabilities || { draft: "unverified", autoSubmit: "unverified", verify: "unverified" },
    composeUrl: a.composeUrl || "",
    /* homeUrl = 平台首页（快捷方式用）；没显式配的从 composeUrl 推 origin */
    homeUrl: a.homeUrl || (() => { try { return new URL(a.composeUrl).origin + "/"; } catch { return ""; } })(),
    loginUrl: loginUrlOf(a),
  }));
}

/* 填充发布：逐个账号开页填充，返回 targets 状态数组
 * accountIds 里的每一项是**账号 id**（默认账号 id = 平台 id，额外账号如 juejin-2） */
/* mode: "draft" = 只填内容存草稿（人工检查后手动发）；"publish" = 填完自动点平台发布按钮 */
async function publish(snapshot, accountIds, mode = "draft", opts = {}) {
  const groupId = "rpa-" + Date.now();
  const handles = [];
  const targets = [];
  const autoPublish = mode === "publish";
  const labelOf = (acct, adapter) => {
    const base = (adapter && adapter.label) || acct.platform;
    return acct.id === acct.platform ? base : `${base}（${acct.id}）`;
  };
  /* 逐目标进度回调：每确定一个账号的结果就通知调用方持久化
     （服务端据此做逐目标落盘 —— 第二账号卡死时不丢第一阶段记录） */
  const notify = () => {
    const t = targets[targets.length - 1];
    if (t && typeof opts.onProgress === "function") {
      try { opts.onProgress(t.platform, t); } catch { /* 回调失败不影响发布 */ }
    }
  };
  for (const accountId of accountIds) {
    const acct = accountInfo(accountId);
    const platform = acct.platform;
    const adapter = ADAPTERS[platform];
    if (!adapter) {
      targets.push({ platform, accountId, status: "failed", error: "无该平台适配器" });
      logger.error("发布引擎", `无该平台适配器：${platform}`);
      notify();
      continue;
    }
    if (adapter.contentType !== snapshot.type) {
      targets.push({ platform, accountId, status: "failed", error: `该平台不支持 ${snapshot.type}` });
      logger.error("发布引擎", `平台不支持该内容类型：${platform}（${snapshot.type}）`);
      notify();
      continue;
    }
    try {
      const page = await openPage(adapter.composeUrl, accountId);
      const pre = await preflight(page, adapter);
      if (!pre.ok) {
        await page.close().catch(() => {});
        throw new Error(`${labelOf(acct, adapter)} 登录态已失效（${pre.reason}）：请到「账号管理 → 登录」重新登录后再发布`);
      }
      await adapter.fill(page, snapshot);
      if (autoPublish) {
        /* 能力闸门（引擎层强制，绕过前端直接调 API 也拦得住）：
           自动提交必须逐平台验证过才放行；草稿能力通过不等于自动提交能力通过 */
        const cap = adapter.capabilities || {};
        if (cap.autoSubmit !== "verified") {
          handles.push({ platform, accountId, page, state: "ready" });
          targets.push({
            platform, accountId, status: "ready",
            error: `「${labelOf(acct, adapter)}」自动提交能力未验证，已停在草稿待确认，请在打开的页面人工发布`,
            capabilityLimited: true,
          });
          notify();
          continue;
        }
        /* 立即发布：填完直接走平台自己的发布流程。
           语义：submit 正常返回只能证明「点击了发布且页面接受」→ 记 accepted（已受理）；
           只有拿到作品 ID / 管理页状态 / 公开 URL 等证据（capabilities.verify）才记 success */
        await adapter.submit(page);
        handles.push({ platform, accountId, page, state: "accepted" });
        targets.push({
          platform, accountId, status: "accepted",
          evidence: { stage: "submitted", detail: "已点击平台发布按钮，等待平台受理/审核" },
          submittedAt: new Date().toISOString(),
        });
      } else {
        /* 草稿模式：封面 → 存草稿。
           （此前只停在编辑器 —— 不自动保存的平台草稿箱里什么都没有）
           任一步没成功都不算任务失败：内容还在编辑器里，人工可补。 */
        const notes = [];
        if (typeof adapter.uploadCover === "function") {
          const cr = await adapter.uploadCover(page, snapshot)
            .catch((e) => ({ ok: false, detail: String(e.message || e).slice(0, 120) }));
          notes.push("封面：" + (cr.detail || (cr.ok ? "已上传" : "未上传")));
          if (!cr.ok && cr.detail) logger.warn("发布引擎", `封面未上传：${platform}`, { 说明: cr.detail });
        }
        if (typeof adapter.saveDraft === "function") {
          const dr = await adapter.saveDraft(page, snapshot)
            .catch((e) => ({ ok: false, detail: String(e.message || e).slice(0, 120) }));
          notes.push(dr.detail || "");
          if (!dr.ok) logger.warn("发布引擎", `存草稿未完成（内容留在编辑器）：${platform}`, { 说明: dr.detail });
          else logger.info("发布引擎", `已存草稿：${platform}`, { 说明: dr.detail });
        }
        handles.push({ platform, accountId, page, state: "ready" });
        targets.push({
          platform, accountId, status: "ready",
          evidence: { stage: "draft", detail: notes.filter(Boolean).join("；") || "已填充内容，停在编辑器待人工确认" },
        });
      }
      notify();
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      /* 提交超时 ≠ 失败：请求可能已被平台接收，盲目重发会造成重复发文。
         记 unknown，必须先核验再决定是否重试 */
      const isTimeout = /timeout|timed out|超时/i.test(msg);
      if (isTimeout && autoPublish) {
        handles.push({ platform, accountId, page: null, state: "unknown" });
        targets.push({
          platform, accountId, status: "unknown",
          error: "提交超时：平台可能已接收请求，请先到平台后台核验是否已发布，确认未发布再重试",
        });
        logger.warn("发布引擎", `提交超时（结果未知，需人工核验）：${platform}`, { 账号: accountId, 错误: msg });
      } else {
        targets.push({ platform, accountId, status: "failed", error: autoPublish ? "自动发布失败：" + msg : msg });
        logger.error("发布引擎", `填充/发布失败：${platform}`, { 账号: accountId, 错误: msg, 模式: autoPublish ? "直接发布" : "存草稿箱" });
      }
      notify();
    }
  }
  activeTasks.set(groupId, handles);
  return { groupId, targets, open: handles.length > 0, mode };
}

/* 正式发布这一步把后台窗口亮出来 —— 参考 MultiPost：发布面板/分类选择这类需要
 * 人工确认的环节，让用户看得见、可随时接管 */
function revealWorker(page) {
  const win = workerWins.get(page);
  if (win && !win.isDestroyed()) {
    try { win.show(); win.focus(); } catch {}
  }
}

/* 提交单个平台（用户确认后）。
 * 用户手动点「发布此平台」不等于平台已发布：submit 正常走完只能记 accepted，
 * 最终是否成功要靠平台结果核验（或人工确认）。超时记 unknown 禁止直接重发。 */
async function submitTarget(groupId, accountId) {
  const handles = activeTasks.get(groupId) || [];
  const h = handles.find((x) => x.accountId === accountId || (!x.accountId && x.platform === accountId));
  if (!h) return { ok: false, error: "页面句柄已失效（服务重启或已关闭），请重新创建任务" };
  const adapter = ADAPTERS[h.platform];
  try {
    revealWorker(h.page);
    await adapter.submit(h.page);
    h.state = "accepted";
    return {
      ok: true, status: "accepted",
      evidence: { stage: "submitted", detail: "已点击平台发布按钮，等待平台受理/审核" },
      note: "已提交，平台受理/审核结果可在任务详情中核验或人工确认",
    };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    if (/timeout|timed out|超时/i.test(msg)) {
      h.state = "unknown";
      return { ok: false, status: "unknown", error: "提交超时：请先到平台后台核验是否已发布，确认未发布再重试（不自动重发）" };
    }
    h.state = "failed";
    return { ok: false, error: msg };
  }
}

/* 单账号重试：重新开页填充（旧句柄失效也可用） */
async function refillTarget(groupId, accountId, snapshot) {
  const acct = accountInfo(accountId);
  const adapter = ADAPTERS[acct.platform];
  if (!adapter) return { ok: false, error: "无该平台适配器" };
  if (adapter.contentType !== snapshot.type) {
    return { ok: false, error: `该平台不支持 ${snapshot.type}` };
  }
  const handles = activeTasks.get(groupId) || [];
  const h = handles.find((x) => x.accountId === accountId || (!x.accountId && x.platform === acct.platform));
  try {
    if (h && h.page) await h.page.close().catch(() => {});
    const page = await openPage(adapter.composeUrl, accountId);
    const pre = await preflight(page, adapter);
    if (!pre.ok) {
      await page.close().catch(() => {});
      return { ok: false, error: `${adapter.label} 登录态已失效（${pre.reason}）：请重新登录后再试` };
    }
    await adapter.fill(page, snapshot);
    if (h) {
      h.page = page;
      h.state = "ready";
    } else {
      handles.push({ platform: acct.platform, accountId, page, state: "ready" });
      activeTasks.set(groupId, handles);
    }
    return { ok: true, status: "ready" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  }
}

/* 登录检查（无头运行，不弹窗口；桌面版复用该账号所在分区的会话）
 * @param {string} accountId 账号 id（默认账号即平台 id）
 * 返回 method 说明判定来源：api=平台接口 / dom=页面元素兜底
 * 已登录时尽力抓取账号身份（昵称/头像/公开主页）—— 抓不到就留空，绝不编造 */
async function checkLogin(accountId) {
  const acct = accountInfo(accountId);
  const adapter = ADAPTERS[acct.platform];
  if (!adapter) return { ok: false, error: "未知平台", accountId: acct.id };
  const checkedAt = new Date().toISOString();
  let page = null;
  try {
    page = await openPage(loginUrlOf(adapter), accountId);
    const v = await verifyLogin(page, adapter);
    let identity = null;
    if (v.loggedIn) {
      identity = await captureProfile(page, adapter).catch(() => null);
    }
    return {
      ok: true, loggedIn: v.loggedIn, method: v.method, detail: v.detail, checkedAt,
      accountId: acct.id, platform: acct.platform, identity,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300), checkedAt, accountId: acct.id };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/* ---------- 账号身份抓取 ----------
 * 平台接口能给出结构化身份最好（adapter.profile 自己实现）；
 * 否则从页面 DOM 里找「头像 + 昵称 + 指向个人主页的链接」。
 * 原则：宁可空着，也不拿平台首页冒充「我的主页」—— 那会让用户点了跳到错误的地方。 */
const PERSONAL_PATH_RE = /\/(user|u|profile|member|space|author|people|creator)(\/|$|\?|#)/i;

async function captureProfile(page, adapter) {
  if (adapter && typeof adapter.profile === "function") {
    try {
      const r = await adapter.profile(page);
      if (r && (r.username || r.homeUrl || r.avatar)) return normalizeIdentity(r);
    } catch { /* 实现失败退回通用抓取 */ }
  }
  const raw = await page.evaluate(() => {
    const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)));
    const txt = (el) => String((el && (el.innerText || el.textContent)) || "").trim();
    let avatar = "";
    let homeUrl = "";
    for (const img of document.querySelectorAll("img")) {
      const cls = typeof img.className === "string" ? img.className : "";
      if (!/avatar|head|portrait|profile/i.test(cls + " " + (img.alt || ""))) continue;
      if (!vis(img)) continue;
      const src = img.currentSrc || img.src || "";
      if (src.startsWith("data:") || !src) continue;
      const link = img.closest && img.closest("a[href]");
      const href = link ? link.getAttribute("href") || "" : "";
      avatar = src;
      if (href && !/login|signin|passport|register/i.test(href)) {
        try { homeUrl = new URL(href, location.href).href; } catch { homeUrl = ""; }
      }
      if (homeUrl) break;
    }
    /* 昵称：同类名元素只有一个不同文字才算（列表页会出现多张作者卡） */
    let username = "";
    const seen = {};
    for (const el of document.querySelectorAll(
      '[class*="nickname"],[class*="user-name"],[class*="userName"],[class*="username"],[class*="account-name"],[class*="user-name"]'
    )) {
      const t = txt(el);
      if (!t || t.length > 24 || !vis(el) || /^(登录|注册|游客|未登录|立即登录)$/.test(t)) continue;
      const k = typeof el.className === "string" ? el.className : "";
      (seen[k] = seen[k] || new Set()).add(t);
    }
    for (const set of Object.values(seen)) {
      if (set.size === 1) { username = [...set][0]; break; }
    }
    return { username, avatar, homeUrl };
  }).catch(() => ({}));
  return normalizeIdentity(raw || {});
}

function normalizeIdentity(r) {
  const username = String((r && r.username) || "").trim().slice(0, 40);
  const avatar = String((r && r.avatar) || "").trim();
  let homeUrl = String((r && r.homeUrl) || "").trim();
  /* 只认「看起来是个人主页」的链接；平台首页/登录页一律丢弃 */
  if (homeUrl && !/^https?:\/\//i.test(homeUrl)) {
    try { homeUrl = new URL(homeUrl, "https://example.invalid").href; } catch { homeUrl = ""; }
    if (homeUrl.includes("example.invalid")) homeUrl = "";
  }
  if (homeUrl && (!PERSONAL_PATH_RE.test(homeUrl) || /login|signin|passport|register/i.test(homeUrl))) homeUrl = "";
  if (!username && !avatar && !homeUrl) return null;
  return { username, avatar: avatar.slice(0, 500), homeUrl, capturedAt: new Date().toISOString() };
}

/* ---------- 可见登录窗口（额外账号专用） ----------
 * 默认账号用内置浏览器登录（与历史行为一致）；额外账号必须开独立分区的窗口，
 * 否则会和默认账号抢同一份 cookie —— 同平台双账号就是这么串的。 */
async function openAccountLoginWindow(accountId) {
  const acct = accountInfo(accountId);
  const adapter = ADAPTERS[acct.platform];
  if (!adapter) throw new Error("未知平台");
  const url = loginUrlOf(adapter);
  if (!ELECTRON) {
    /* 纯浏览器访问：退回 Playwright 可见窗口（登录态落在 data/browser-profile） */
    await openForLogin(acct.platform);
    return { ok: true, mode: "playwright", note: "已在独立浏览器窗口打开登录页" };
  }
  /* 已开着就聚焦，不重复开窗（重复开窗会让同一个分区出现两份界面） */
  const existing = loginWins.get(acct.id);
  if (existing && existing.win && !existing.win.isDestroyed()) {
    try { existing.win.show(); existing.win.focus(); } catch { /* 忽略 */ }
    return { ok: true, mode: "window", reused: true, accountId: acct.id };
  }
  const page = await openWorkerPage(url, acct.partition, { label: acct.id });
  const win = workerWins.get(page);
  if (!win) throw new Error("登录窗口创建失败");
  loginWins.set(acct.id, { win, page, partition: acct.partition });
  try {
    win.show();
    win.focus();
    /* 键盘焦点必须显式落到 webContents：show:false 创建的窗口 win.focus() 只给
       窗口焦点，页面没有自动 focus 输入框时物理键盘（含 IME）打不了字 */
    win.webContents.focus();
    win.on("focus", () => { try { if (!win.webContents.isFocused()) win.webContents.focus(); } catch { /* 忽略 */ } });
  } catch { /* 忽略 */ }
  win.on("closed", () => loginWins.delete(acct.id));
  return { ok: true, mode: "window", accountId: acct.id, partition: acct.partition };
}

function closeLoginWindow(accountId) {
  const w = loginWins.get(String(accountId || ""));
  if (!w) return { ok: true, closed: false };
  loginWins.delete(String(accountId || ""));
  try { if (w.page && !w.page.isClosed()) w.page.close(); } catch { /* 忽略 */ }
  try { if (w.win && !w.win.isDestroyed()) w.win.destroy(); } catch { /* 忽略 */ }
  return { ok: true, closed: true };
}

/* 删除账号时清空它自己的分区（默认账号的共享分区不在这里清：
   那会把其它平台的登录态一起清掉） */
async function removeAccountData(accountId) {
  const acct = accountInfo(accountId);
  closeLoginWindow(acct.id);
  if (acct.partition === PARTITION) {
    return { ok: false, error: "默认账号与内置浏览器共用会话，不能单独清除（请用「清除全部登录态」）" };
  }
  /* 先关掉该分区的所有窗口，再清存储 —— 页面还开着时清 cookie 会被写回 */
  for (const [page, win] of workerWins) {
    if (workerPartition.get(page) !== acct.partition) continue;
    try { if (!page.isClosed()) await page.close(); } catch { /* 忽略 */ }
    try { win.destroy(); } catch { /* 忽略 */ }
  }
  if (ELECTRON) {
    try { await ELECTRON.session.fromPartition(acct.partition).clearStorageData(); } catch { /* 忽略 */ }
  }
  partitionsUsed.delete(acct.partition);
  return { ok: true };
}

/* 打开人工登录入口。
 * 桌面版：开**可见**窗口（按账号分区，额外账号与默认账号互不串会话）；
 * 否则：Playwright 可见浏览器（登录态留在 data/browser-profile）。 */
async function openForLogin(accountId) {
  const acct = accountInfo(accountId);
  const adapter = ADAPTERS[acct.platform];
  if (!adapter) throw new Error("未知平台");
  if (ELECTRON) {
    const r = await openAccountLoginWindow(acct.id);
    return Object.assign({ ok: true, note: "已在独立登录窗口打开平台登录页，登录完回来点「完成登录」" }, r);
  }
  await getContext({ headed: true });
  await openPage(loginUrlOf(adapter), acct.id);
  return { ok: true, note: "已在打开的浏览器窗口中人工登录，登录态会保留" };
}

function hasHandles(groupId) {
  return activeTasks.has(groupId);
}

/* 关闭所有 RPA 打开的页面/后台窗口（MultiPost 设置页同款功能） */
async function closeAll() {
  let n = 0;
  for (const [, handles] of activeTasks) {
    for (const h of handles) {
      if (h.page) {
        try { await h.page.close(); n++; } catch {}
      }
    }
  }
  activeTasks.clear();
  for (const [, w] of loginWins) {
    try { if (w.page && !w.page.isClosed()) w.page.close(); } catch {}
    try { w.win.destroy(); n++; } catch {}
  }
  loginWins.clear();
  for (const [, win] of workerWins) {
    try { win.destroy(); n++; } catch {}
  }
  workerWins.clear();
  workerPartition.clear();
  return n;
}

/* 清理浏览器配置目录（登录态全失！需用户确认） */
async function clearProfile() {
  await closeAll();
  try {
    if (ctxPromise) {
      const ctx = await ctxPromise;
      await ctx.close().catch(() => {});
    }
  } catch {}
  ctxPromise = null;
  stateApplied.clear();
  fs.rmSync(profileDir(), { recursive: true, force: true });
  fs.rmSync(stateDir(), { recursive: true, force: true });
  /* 桌面版：内置浏览器分区的登录态也一起清掉 */
  if (ELECTRON) {
    try { await ELECTRON.session.fromPartition(PARTITION).clearStorageData(); } catch {}
    /* 本次进程里建过的额外账号分区也一起清 —— 「清除全部登录态」必须说到做到 */
    for (const p of partitionsUsed) {
      if (p === PARTITION) continue;
      try { await ELECTRON.session.fromPartition(p).clearStorageData(); } catch {}
    }
  }
  return true;
}

/* 重置浏览器上下文（重新登录/清理配置后使用；测试也需要它来隔离状态） */
async function resetContext() {
  if (ctxPromise) {
    const old = ctxPromise;
    ctxPromise = null;
    try { await old.then((c) => c.close()).catch(() => {}); } catch {}
  }
  ctxPromise = null;
  ctxHeaded = false;
  stateApplied.clear();
  /* CDP 连接也要断：否则下次拿到的是已经销毁窗口的旧 context */
  if (cdpBrowser) {
    try { await cdpBrowser.close(); } catch {}
  }
  cdpBrowser = null;
  cdpCtx = null;
  workerPartition.clear();
  return true;
}

module.exports = {
  listPlatforms, publish, submitTarget, refillTarget, checkLogin, openForLogin, importState,
  hasHandles, closeAll, clearProfile, resetContext, resolveLocalMedia,
  baijiahaoApiDraft, /* 真机验证用 */
  /* 独立账号：账号 → 平台/分区解析、独立登录窗口、身份抓取、删号清分区 */
  setAccountResolver, accountInfo, openAccountLoginWindow, closeLoginWindow, removeAccountData, captureProfile,
  /* 供回归测试观察内部状态（可见性升级、平台能力表） */
  _internals: { getContext, hasOpenWorkers, ADAPTERS, loginUrlOf, resetContext, loginWins },
};
