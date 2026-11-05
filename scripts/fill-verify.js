/* 验证修复后的编辑器定位逻辑（只定位 + focus，不写正文） */
const { chromium } = require("playwright");

const CDP = "http://127.0.0.1:9333";
const CASES = {
  csdn: { url: "https://editor.csdn.net/md/", bodySel: ["pre.editor__inner", ".CodeMirror", "div[contenteditable='true']", "textarea"] },
  baijiahao: { url: "https://baijiahao.baidu.com/builder/rc/edit?type=news", bodySel: ['div[class*="FeEditor"][contenteditable="true"]', ".ProseMirror", ".w-e-text[contenteditable]", "div[contenteditable='true']"] },
  dayu: { url: "https://mp.dayu.com/dashboard/article/write", bodySel: [".ProseMirror", ".w-e-text[contenteditable]", "div[contenteditable='true']"] },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const [pf, c] of Object.entries(CASES)) {
    console.log(`\n===== ${pf} =====`);
    let browser = null, page = null;
    try {
      const list = await (await fetch(CDP + "/json/list")).json();
      const host = list.find((t) => t.type === "page" && (t.url.startsWith("file:") || t.url.includes("127.0.0.1"))) || list.find((t) => t.type === "page");
      const ws = new WebSocket(host.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      await new Promise((res) => { ws.onmessage = res; ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `window.open(${JSON.stringify(c.url)},"_blank","width=1280,height=900")` } })); });
      ws.close();
      await sleep(2000);
      browser = await chromium.connectOverCDP(CDP);
      const ctx = browser.contexts()[0];
      for (let i = 0; i < 15 && !page; i++) {
        page = ctx.pages().find((p) => p.url().includes(new URL(c.url).hostname)) || null;
        if (!page) await sleep(1000);
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await sleep(6000);
      const title = await page.title().catch(() => "");
      console.log("  title:", title.slice(0, 40), /404|页面不存在/.test(title) ? "  ← 会触发 404 检测" : "");

      let hit = null;
      for (const sel of c.bodySel) {
        const el = await page.$(sel).catch(() => null);
        if (!el) { console.log(`  [skip] ${sel}  （未找到）`); continue; }
        const vis = await el.isVisible().catch(() => false);
        if (!vis) { console.log(`  [skip] ${sel}  （不可见）`); continue; }
        hit = { sel, el }; break;
      }
      let where = hit ? "主文档 " + hit.sel : "";
      if (!hit) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const el = await frame.$("body[contenteditable='true'], body[contenteditable='']").catch(() => null);
          if (!el || !(await el.isVisible().catch(() => false))) continue;
          hit = { el, frame: frame.url().slice(0, 60) }; where = "iframe(" + frame.url().slice(0, 50) + ") body[contenteditable]"; break;
        }
      }
      if (!hit) { console.log("  [FAIL] 全部候选未命中"); continue; }
      // focus 验证（不写内容）
      const focused = await hit.el.evaluate((n) => { n.focus(); return document.activeElement === n || n.contains(document.activeElement); }).catch((e) => "ERR:" + String(e.message || e).slice(0, 60));
      console.log(`  [HIT] ${where}  focus=${focused}`);
    } catch (e) {
      console.log("  [x] " + String(e.message || e).slice(0, 200));
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
  process.exit(0);
})();
