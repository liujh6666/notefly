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

/* 是否跑在 Electron 主进程里（桌面版）：是则直接接管内置浏览器会话 */
const ELECTRON = (() => {
  if (!process.versions.electron) return null;
  try { return require("electron"); } catch { return null; }
})();

/* 内置浏览器（webview）与后台发布窗口共用这个分区，登录态天然共享 */
const PARTITION = "persist:notefly";

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

/* ---------- Electron 内置会话：与 webview 共用 persist:notefly ---------- */
let cdpBrowser = null;
let cdpCtx = null;
/** Playwright Page -> 隐藏 BrowserWindow */
const workerWins = new Map();

async function getCdpContext() {
  if (cdpCtx) {
    if (cdpBrowser && cdpBrowser.isConnected()) return cdpCtx;
    cdpCtx = null;
    cdpBrowser = null;
  }
  const port = process.env.NOTEFLY_CDP_PORT || "9333";
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  /* 关键：必须复用浏览器里已有的那个 context（内置浏览器所在的分区），
   * 绝不能 newContext() —— 那会开一个空 context，登录态当场丢失。
   * 这是 CDP 接管模式下最常见的坑，同类工具（Playwright MCP / browser-use）也都这么处理。 */
  const ctx = browser.contexts()[0];
  if (!ctx) {
    await browser.close().catch(() => {});
    throw new Error("未找到内置浏览器会话，请重启 NoteFly 桌面版");
  }
  cdpBrowser = browser;
  cdpCtx = ctx;
  browser.on("disconnected", () => { cdpBrowser = null; cdpCtx = null; });
  return ctx;
}

/* 在应用内隐藏窗口打开页面：登录态就是用户在内置浏览器里登录的那一份 */
async function openElectronPage(url) {
  const ctx = await getCdpContext();
  /* 复用本进程之前开过的后台页（只复用自己创建的，绝不劫持用户正在看的标签） */
  let origin = "";
  try { origin = new URL(url).origin; } catch {}
  /* 正在被发布任务占用的页面不能复用它，否则检查结束关页会打断任务 */
  const inUse = new Set();
  for (const [, hs] of activeTasks) for (const h of hs) if (h.page) inUse.add(h.page);
  for (const [p, win] of workerWins) {
    try {
      if (!win.isDestroyed() && !inUse.has(p) && origin && p.url().startsWith(origin)) {
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await sleep(300);
        return p;
      }
    } catch {}
  }
  const before = new Set(ctx.pages());
  const win = new ELECTRON.BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: { partition: PARTITION, backgroundThrottling: false, spellcheck: false },
  });
  const page = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("内置浏览器后台页创建超时")), 15000);
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
  page.on("close", () => {
    try { win.destroy(); } catch {}
    workerWins.delete(page);
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
  await sleep(600);
  return page;
}

async function openPage(url, platform) {
  if (ELECTRON) return openElectronPage(url); // 桌面版：复用内置会话（不复制 cookie）
  if (platform) await applyState(platform);
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

/* 统一的登录态校验：先接口，再 DOM 兜底 */
async function verifyLogin(page, adapter) {
  const api = await apiLoginState(page, adapter.loginProbe);
  if (api.known) return { loggedIn: !!api.loggedIn, method: "api", detail: api.detail || "" };
  if (typeof adapter.isLoggedIn === "function") {
    try {
      const loggedIn = !!(await adapter.isLoggedIn(page));
      return { loggedIn, method: "dom", detail: "" };
    } catch (e) {
      return { loggedIn: false, method: "dom", detail: String(e.message || e).slice(0, 160) };
    }
  }
  return { loggedIn: false, method: "none", detail: "该平台暂未配置登录探测" };
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
      return page.evaluate(() => !!document.querySelector('[class*="LoginPop"], a[href*="signin"]') === false && !!document.querySelector('nav, .Main_nav_version'));
    },
    async fill(page, snap) {
      const box = await waitSel(page, '.Form_input, [contenteditable="true"][aria-label], .omp-body .DraftEditor-root div[contenteditable="true"]', 20000);
      await box.click();
      await page.keyboard.insertText((snap.title ? snap.title + "\n" : "") + (snap.body || ""));
      // 图片上传（可选）
      if (snap.images && snap.images.length) {
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(snap.images.filter((p) => !p.startsWith("http")));
          await sleep(5000); // 等上传
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
function genericArticleAdapter(cfg) {
  return {
    label: cfg.label,
    contentType: cfg.contentType || "ARTICLE",
    composeUrl: cfg.composeUrl,
    homeUrl: cfg.homeUrl || "",
    loginUrl: cfg.loginUrl || "",
    status: "unverified",
    capabilities: { draft: "unverified", autoSubmit: "unverified", verify: "unverified" },
    async isLoggedIn(page) {
      await page.goto(cfg.homeUrl || cfg.composeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await sleep(2500);
      return page.evaluate(() => {
        const url = location.href;
        // 跳到登录页 = 未登录
        if (/login|signin|passport/i.test(url)) return false;

        const txtOf = (el) => ((el && (el.innerText || el.textContent)) || "").trim();
        const clsOf = (el) => {
          const c = el && el.className;
          if (!c) return "";
          return typeof c === "string" ? c : (c.baseVal || c.toString ? c.toString() : "");
        };

        /* 1) 存在登录/注册入口 = 未登录
              判据放宽到「class/href 含 login 关键词」或「可见文字就是登录/注册」——
              旧实现要求元素文字必须匹配「登录」，遇到纯图标登录按钮就漏判，
              接着被下面的头像规则兜成「已登录」，这是误判的主要来源。 */
        const entrySel = 'a,button,[role="button"],span[class*="login"],div[class*="login"],a[href*="signin"],a[href*="register"]';
        for (const el of document.querySelectorAll(entrySel)) {
          const sig = (clsOf(el) + " " + (el.getAttribute("href") || "") + " " + (el.getAttribute("id") || ""));
          if (/\b(login|signin|sign-in|passport|register)\b/i.test(sig)) return false;
          const t = txtOf(el);
          if (/^(登录|注册|登陆|立即登录|免费注册|登录\/注册|新用户注册|sign in|log in|sign up)$/i.test(t)) return false;
        }

        /* 2) 找确凿的登录证据（按可信度从强到弱），没有就判未登录。
              宁可报「未登录」也不要误报「已登录」：误报会让用户以为能发布，
              真正发布时又被 preflight 拦下，体验更差。 */
        // a) 退出/登出入口 —— 最硬的证据
        for (const el of document.querySelectorAll("a,button,span,div,li")) {
          if (/^(退出登录|退出|登出|退出账号|logout|sign out|log out)$/i.test(txtOf(el))) return true;
        }
        // b) 用户昵称 —— 有实际文字的用户名元素
        for (const el of document.querySelectorAll(
          '[class*="nickname"],[class*="user-name"],[class*="userName"],[class*="username"],[class*="header-user"],[class*="account-name"]'
        )) {
          const t = txtOf(el);
          if (t && t.length <= 24 && !/^(登录|注册|游客|未登录|立即登录)$/.test(t)) return true;
        }
        // c) 头像/用户块 —— 必须是「指向个人主页的链接」或「带文字」，排除游客占位头像
        for (const el of document.querySelectorAll(
          '[class*="avatar"],[class*="user-info"],[class*="userInfo"],[class*="header-user"],img[class*="avatar"]'
        )) {
          const link = el.closest && el.closest("a[href]");
          if (link) {
            const href = link.getAttribute("href") || "";
            if (/\/(user|my|member|profile|author|space|account|creator)(\/|$|\?)/i.test(href) && !/login|signin/i.test(href)) return true;
          }
          const t = txtOf(el);
          if (t && !/^(登录|注册|游客|未登录)$/.test(t)) return true;
        }
        return false;
      });
    },
    async fill(page, snap) {
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
      // 标题
      const titleSel = cfg.titleSel || 'input[placeholder*="标题"], textarea[placeholder*="标题"]';
      const title = await waitSel(page, titleSel, 20000).catch(() => null);
      if (title) await title.fill((snap.title || "").slice(0, cfg.titleMax || 100));
      else console.warn(`[${cfg.label}] 未找到标题输入框，尝试直接填正文`);

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
      for (const sel of bodySels) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
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
            await el.click();
            if (cfg.plainText) {
              // 不支持 Markdown 的富文本：去标记写纯文本
              const text = body
                .replace(/^#{1,6}\s*/gm, "")
                .replace(/\*\*(.*?)\*\*/g, "$1")
                .replace(/\*(.*?)\*/g, "$1")
                .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
                .replace(/^\s*[-*]\s+/gm, "• ");
              await page.keyboard.insertText(text);
            } else {
              await page.keyboard.insertText(body);
            }
            done = true; break;
          }
        } catch (e) {
          lastErr = String(e.message || e);
        }
      }
      if (!done) throw new Error(`[${cfg.label}] 正文填充失败（编辑器未找到或改版）${lastErr ? "：" + lastErr : ""}`);
      await sleep(1500);
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

const ADAPTERS_EXTRA = {
  csdn: genericArticleAdapter({
    label: "CSDN",
    composeUrl: "https://editor.csdn.net/md/",
    homeUrl: "https://www.csdn.net/",
    /* 首页有 WAF，内置浏览器打开偶发 403；登录一律走官方登录页 */
    loginUrl: "https://passport.csdn.net/login",
    titleSel: 'input[placeholder*="标题"], .article-bar input',
    bodySel: [".CodeMirror", "div[contenteditable='true']", "textarea"],
  }),
  toutiao: genericArticleAdapter({
    label: "头条号",
    composeUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
    homeUrl: "https://mp.toutiao.com/",
    titleSel: 'input[placeholder*="标题"], .publish-title input',
    bodySel: [".ProseMirror", "div[contenteditable='true']"],
    titleMax: 30,
    submitSel: 'button:has-text("发布"), button:has-text("发表")',
  }),
  baijiahao: genericArticleAdapter({
    label: "百家号",
    composeUrl: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    homeUrl: "https://baijiahao.baidu.com/",
    titleSel: 'input[placeholder*="标题"]',
    bodySel: [".ProseMirror", ".w-e-text[contenteditable]", "div[contenteditable='true']"],
    titleMax: 64,
    plainText: false,
  }),
  sohu: genericArticleAdapter({
    label: "搜狐号",
    composeUrl: "https://mp.sohu.com/mpbp/bp/base-info",
    homeUrl: "https://mp.sohu.com/",
    titleSel: 'input[placeholder*="标题"]',
    bodySel: [".w-e-text[contenteditable]", ".ProseMirror", "div[contenteditable='true']"],
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
    titleSel: 'input[placeholder*="标题"]',
    bodySel: [".ProseMirror", "div[contenteditable='true']"],
  }),
  dayu: genericArticleAdapter({
    label: "大鱼号",
    composeUrl: "https://mp.dayu.com/dashboard/article/write",
    homeUrl: "https://mp.dayu.com/",
    titleSel: 'input[placeholder*="标题"]',
    bodySel: [".ProseMirror", ".w-e-text[contenteditable]", "div[contenteditable='true']"],
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

/* 填充发布（草稿模式）：逐平台开页填充，返回 targets 状态数组 */
/* mode: "draft" = 只填内容存草稿（人工检查后手动发）；"publish" = 填完自动点平台发布按钮 */
async function publish(snapshot, platforms, mode = "draft", opts = {}) {
  const groupId = "rpa-" + Date.now();
  const handles = [];
  const targets = [];
  const autoPublish = mode === "publish";
  /* 逐目标进度回调：每确定一个平台的结果就通知调用方持久化
     （服务端据此做逐目标落盘 —— 第二平台卡死时不丢第一阶段记录） */
  const notify = () => {
    const t = targets[targets.length - 1];
    if (t && typeof opts.onProgress === "function") {
      try { opts.onProgress(t.platform, t); } catch { /* 回调失败不影响发布 */ }
    }
  };
  for (const platform of platforms) {
    const adapter = ADAPTERS[platform];
    if (!adapter) {
      targets.push({ platform, accountId: platform, status: "failed", error: "无该平台适配器" });
      logger.error("发布引擎", `无该平台适配器：${platform}`);
      notify();
      continue;
    }
    if (adapter.contentType !== snapshot.type) {
      targets.push({ platform, accountId: platform, status: "failed", error: `该平台不支持 ${snapshot.type}` });
      logger.error("发布引擎", `平台不支持该内容类型：${platform}（${snapshot.type}）`);
      notify();
      continue;
    }
    try {
      const page = await openPage(adapter.composeUrl, platform);
      const pre = await preflight(page, adapter);
      if (!pre.ok) {
        await page.close().catch(() => {});
        throw new Error(`${adapter.label} 登录态已失效（${pre.reason}）：请到「账号管理 → 登录」重新登录后再发布`);
      }
      await adapter.fill(page, snapshot);
      if (autoPublish) {
        /* 能力闸门（引擎层强制，绕过前端直接调 API 也拦得住）：
           自动提交必须逐平台验证过才放行；草稿能力通过不等于自动提交能力通过 */
        const cap = adapter.capabilities || {};
        if (cap.autoSubmit !== "verified") {
          handles.push({ platform, page, state: "ready" });
          targets.push({
            platform, accountId: platform, status: "ready",
            error: `「${adapter.label}」自动提交能力未验证，已停在草稿待确认，请在打开的页面人工发布`,
            capabilityLimited: true,
          });
          notify();
          continue;
        }
        /* 立即发布：填完直接走平台自己的发布流程。
           语义：submit 正常返回只能证明「点击了发布且页面接受」→ 记 accepted（已受理）；
           只有拿到作品 ID / 管理页状态 / 公开 URL 等证据（capabilities.verify）才记 success */
        await adapter.submit(page);
        handles.push({ platform, page, state: "accepted" });
        targets.push({
          platform, accountId: platform, status: "accepted",
          evidence: { stage: "submitted", detail: "已点击平台发布按钮，等待平台受理/审核" },
          submittedAt: new Date().toISOString(),
        });
      } else {
        handles.push({ platform, page, state: "ready" });
        targets.push({ platform, accountId: platform, status: "ready" });
      }
      notify();
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      /* 提交超时 ≠ 失败：请求可能已被平台接收，盲目重发会造成重复发文。
         记 unknown，必须先核验再决定是否重试 */
      const isTimeout = /timeout|timed out|超时/i.test(msg);
      if (isTimeout && autoPublish) {
        handles.push({ platform, page: null, state: "unknown" });
        targets.push({
          platform, accountId: platform, status: "unknown",
          error: "提交超时：平台可能已接收请求，请先到平台后台核验是否已发布，确认未发布再重试",
        });
        logger.warn("发布引擎", `提交超时（结果未知，需人工核验）：${platform}`, { 错误: msg });
      } else {
        targets.push({ platform, accountId: platform, status: "failed", error: autoPublish ? "自动发布失败：" + msg : msg });
        logger.error("发布引擎", `填充/发布失败：${platform}`, { 错误: msg, 模式: autoPublish ? "直接发布" : "存草稿箱" });
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
  const h = handles.find((x) => x.platform === accountId);
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

/* 单平台重试：重新开页填充（旧句柄失效也可用） */
async function refillTarget(groupId, accountId, snapshot) {
  const adapter = ADAPTERS[accountId];
  if (!adapter) return { ok: false, error: "无该平台适配器" };
  if (adapter.contentType !== snapshot.type) {
    return { ok: false, error: `该平台不支持 ${snapshot.type}` };
  }
  const handles = activeTasks.get(groupId) || [];
  const h = handles.find((x) => x.platform === accountId);
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
      handles.push({ platform: accountId, page, state: "ready" });
      activeTasks.set(groupId, handles);
    }
    return { ok: true, status: "ready" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  }
}

/* 登录检查（无头运行，不弹窗口；桌面版复用内置浏览器会话）
 * 返回 method 说明判定来源：api=平台接口 / dom=页面元素兜底 */
async function checkLogin(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) return { ok: false, error: "未知平台" };
  const checkedAt = new Date().toISOString();
  let page = null;
  try {
    page = await openPage(loginUrlOf(adapter), platform);
    const v = await verifyLogin(page, adapter);
    return { ok: true, loggedIn: v.loggedIn, method: v.method, detail: v.detail, checkedAt };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300), checkedAt };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/* 降级方案（纯浏览器访问时用）：弹出可见窗口人工登录，登录态留在 data/browser-profile */
async function openForLogin(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error("未知平台");
  await getContext({ headed: true });
  await openPage(loginUrlOf(adapter), platform);
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
  for (const [, win] of workerWins) {
    try { win.destroy(); n++; } catch {}
  }
  workerWins.clear();
  return n;
}

/* 清理浏览器配置目录（登录态全失！需用户确认） */
async function clearProfile() {
  for (const [, win] of workerWins) { try { win.destroy(); } catch {} }
  workerWins.clear();
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
  return true;
}

module.exports = {
  listPlatforms, publish, submitTarget, refillTarget, checkLogin, openForLogin, importState,
  hasHandles, closeAll, clearProfile, resetContext,
  /* 供回归测试观察内部状态（可见性升级、平台能力表） */
  _internals: { getContext, hasOpenWorkers, ADAPTERS, loginUrlOf, resetContext },
};
