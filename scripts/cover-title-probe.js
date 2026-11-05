/* 真机探针：各平台编辑器的封面 input[type=file] 与标题元素形态（只读） */
const { chromium } = require("playwright");

const TARGETS = [
  ["csdn", "https://editor.csdn.net/md/", null],
  ["toutiao", "https://mp.toutiao.com/profile_v4/graphic/publish", null],
  ["baijiahao", "https://baijiahao.baidu.com/builder/rc/edit?type=news", null],
  ["sohu", "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1", null],
  ["yidian", "https://mp.yidianzixun.com/home/q/editor", 'a[href="#/Writing/articleEditor"]'],
  ["dayu", "https://mp.dayu.com/dashboard/article/write", null],
];

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  for (const [name, url, entrySel] of TARGETS) {
    try {
      const host = ctx.pages().find((p) => p.url().startsWith("file:") || p.url().includes("127.0.0.1")) || ctx.pages()[0];
      await host.evaluate((u) => window.open(u, "_blank", "width=1280,height=900"), url);
      await new Promise((r) => setTimeout(r, 3500));
      const page = ctx.pages().filter((p) => p.url().includes(new URL(url).host)).pop();
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 7000));
      if (entrySel) {
        const entry = await page.$(entrySel).catch(() => null);
        if (entry) { await entry.click().catch(() => {}); await new Promise((r) => setTimeout(r, 4000)); }
      }
      const info = await page.evaluate(() => {
        const brief = (el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.id || "", name: el.name || "", accept: el.accept || "",
            cls: String(el.className || "").slice(0, 60),
            visible: r.width > 0 && r.height > 0,
          };
        };
        const files = [...document.querySelectorAll('input[type=file]')].map(brief).slice(0, 8);
        const titles = [...document.querySelectorAll('input[placeholder*="标题"], textarea[placeholder*="标题"], [contenteditable="true"][data-placeholder*="标题"], [contenteditable="true"][placeholder*="标题"], [class*="title"] input, [class*="title"][contenteditable="true"]')]
          .map((el) => ({ tag: el.tagName.toLowerCase(), ph: el.placeholder || el.getAttribute("data-placeholder") || "", cls: String(el.className || "").slice(0, 50), vis: el.getBoundingClientRect().width > 0 }))
          .slice(0, 6);
        return { files, titles, url: location.href.slice(0, 90) };
      });
      console.log("=== " + name + "  " + info.url);
      console.log("  file inputs:", JSON.stringify(info.files));
      console.log("  title els :", JSON.stringify(info.titles));
      await page.close().catch(() => {});
    } catch (e) {
      console.log("=== " + name + " 探测失败:", String(e.message || e).slice(0, 100));
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  await browser.close().catch(() => {});
  process.exit(0);
})();
