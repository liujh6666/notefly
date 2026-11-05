/* 编辑器结构探针：attach 到运行中的 NoteFly（CDP 9333），
   通过已有页面 window.open 开探针窗，dump 编辑器相关 DOM 结构。
   只读不写，不碰 cookie / 登录态。用法：
   node scripts/editor-probe.js csdn baijiahao sohu dayu */
const { chromium } = require("playwright");

const CDP = "http://127.0.0.1:9333";
const COMPOSE = {
  csdn: "https://editor.csdn.net/md/",
  baijiahao: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
  sohu: "https://mp.sohu.com/mpbp/bp/base-info",
  dayu: "https://mp.dayu.com/dashboard/article/write",
  yidian: "https://mp.yidianzixun.com/home/qianseditor",
  toutiao: "https://mp.toutiao.com/profile_v4/graphic/publish",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 在主窗口上下文里执行 window.open，返回新 target 列表 */
async function openViaExistingPage(url) {
  const list = await (await fetch(CDP + "/json/list")).json();
  // 找一个 app 自身页面（file: 或 localhost）作为宿主
  const host = list.find((t) => t.type === "page" && (t.url.startsWith("file:") || t.url.includes("127.0.0.1") || t.url === "about:blank"))
    || list.find((t) => t.type === "page");
  if (!host || !host.webSocketDebuggerUrl) throw new Error("找不到可用的宿主页面");
  const ws = new WebSocket(host.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const expr = `window.open(${JSON.stringify(url)}, "_blank", "width=1280,height=900") ? "opened" : "blocked"`;
  const ret = await new Promise((res, rej) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m.result); };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr } }));
    setTimeout(() => rej(new Error("evaluate 超时")), 8000);
  }).finally(() => ws.close());
  return ret;
}

async function dumpPage(page) {
  return await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const brief = (el) => {
      const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "");
      return { tag: el.tagName.toLowerCase(), id: el.id || "", cls: cls.slice(0, 140), visible: vis(el), editable: el.isContentEditable === true };
    };
    const out = {
      url: location.href.slice(0, 140),
      title: document.title.slice(0, 60),
      contenteditable: [...document.querySelectorAll("[contenteditable='true'],[contenteditable='']")].slice(0, 12).map(brief),
      textareas: [...document.querySelectorAll("textarea")].slice(0, 8).map(brief),
      iframes: [...document.querySelectorAll("iframe")].slice(0, 10).map((f) => ({
        id: f.id || "", cls: String(f.className || "").slice(0, 80), src: (f.src || "").slice(0, 140), visible: vis(f),
      })),
      marks: {},
    };
    for (const m of [".CodeMirror", ".cm-editor", ".ProseMirror", ".w-e-text", ".ql-editor",
      "#edui1_iframeholder", ".note-editable", ".baidu-editor", ".ueditor", ".ck-editor__editable",
      "div[role='textbox']", ".article-bar", "#editor"]) {
      const els = document.querySelectorAll(m);
      if (els.length) out.marks[m] = [...els].slice(0, 3).map(brief);
    }
    return out;
  }).catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
}

(async () => {
  const platforms = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(COMPOSE);
  for (const pf of platforms) {
    const url = COMPOSE[pf];
    if (!url) { console.log(`[?] 未知平台 ${pf}`); continue; }
    console.log(`\n========== ${pf} → ${url} ==========`);
    let browser = null, page = null;
    try {
      const opened = await openViaExistingPage(url);
      if (opened.result && opened.result.value !== "opened") throw new Error("window.open 被拦截: " + JSON.stringify(opened.result).slice(0, 150));
      await sleep(2000);
      browser = await chromium.connectOverCDP(CDP);
      const ctx = browser.contexts()[0];
      for (let i = 0; i < 15 && !page; i++) {
        page = ctx.pages().find((p) => p.url().includes(new URL(url).hostname)) || null;
        if (!page) await sleep(1000);
      }
      if (!page) { console.log("  [!] 未定位到探针窗；当前 pages: " + ctx.pages().map((p) => p.url().slice(0, 60)).join(" | ")); continue; }
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await sleep(6000);
      console.log(JSON.stringify(await dumpPage(page), null, 1));
    } catch (e) {
      console.log("  [x] " + String(e.message || e).slice(0, 300));
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {}); // CDP 连接仅断开
    }
  }
  process.exit(0);
})();
