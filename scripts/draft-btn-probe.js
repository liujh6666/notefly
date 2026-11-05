/* 真机探针：逐平台打开创作页，找「存草稿」按钮真实选择器（只读，不点击） */
const { chromium } = require("playwright");

const TARGETS = [
  ["csdn", "https://editor.csdn.net/md/"],
  ["toutiao", "https://mp.toutiao.com/profile_v4/graphic/publish"],
  ["baijiahao", "https://baijiahao.baidu.com/builder/rc/edit?type=news"],
  ["sohu", "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1"],
  ["yidian", "https://mp.yidianzixun.com/home/q/editor"],
  ["dayu", "https://mp.dayu.com/dashboard/article/write"],
];

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  for (const [name, url] of TARGETS) {
    try {
      const host = ctx.pages().find((p) => p.url().startsWith("file:") || p.url().includes("127.0.0.1")) || ctx.pages()[0];
      await host.evaluate((u) => window.open(u, "_blank", "width=1280,height=900"), url);
      await new Promise((r) => setTimeout(r, 3500));
      const page = ctx.pages().filter((p) => p.url().includes(new URL(url).host)).pop();
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 7000));
      const info = await page.evaluate(() => {
        const btns = [];
        for (const el of document.querySelectorAll("button, a, [class*=btn], [class*=button], span, div")) {
          const t = (el.innerText || "").trim();
          if (!t || t.length > 8) continue;
          if (!/草稿|存草|保存/.test(t)) continue;
          const r = el.getBoundingClientRect();
          btns.push({
            tag: el.tagName.toLowerCase(),
            text: t.slice(0, 8),
            cls: String(el.className || "").slice(0, 70),
            visible: r.width > 0 && r.height > 0,
          });
        }
        // 去重
        const seen = new Set();
        return btns.filter((b) => {
          const k = b.tag + b.cls + b.text;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }).slice(0, 10);
      });
      console.log("=== " + name + " url=" + page.url().slice(0, 90));
      if (!info.length) console.log("  （没找到含草稿/保存的按钮）");
      for (const b of info) console.log("  ", b.visible ? "[可见]" : "[隐藏]", b.tag, JSON.stringify(b.text), b.cls);
      await page.close().catch(() => {});
    } catch (e) {
      console.log("=== " + name + " 探测失败:", String(e.message || e).slice(0, 120));
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  await browser.close().catch(() => {});
  process.exit(0);
})();
