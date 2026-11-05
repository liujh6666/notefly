/* 真机验证草稿链路：CSDN 填充 → 点「保存草稿」→ 捕获平台反馈（一条测试草稿） */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  const host = ctx.pages().find((p) => p.url().startsWith("file:") || p.url().includes("127.0.0.1")) || ctx.pages()[0];
  await host.evaluate((u) => window.open(u, "_blank", "width=1280,height=900"), "https://editor.csdn.net/md/");
  await new Promise((r) => setTimeout(r, 3500));
  const page = ctx.pages().filter((p) => p.url().includes("editor.csdn.net")).pop();
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 6000));

  const title = "NoteFly草稿链路验证" + new Date().getMinutes();
  // 填标题
  const t = page.locator('input[placeholder*="标题"]').first();
  await t.fill(title);
  // 填正文（pre.editor__inner，StackEdit 风格）
  const body = page.locator("pre.editor__inner").first();
  await body.evaluate((n) => n.focus());
  await page.keyboard.insertText("这是一条 NoteFly 草稿链路自动验证，可直接删除。");
  await new Promise((r) => setTimeout(r, 1500));

  // 点「保存草稿」
  const btn = page.locator("button.btn-save").first();
  const visible = await btn.isVisible().catch(() => false);
  console.log("保存草稿按钮可见:", visible, "| 文案:", await btn.innerText().catch(() => "?"));
  await btn.click();
  await new Promise((r) => setTimeout(r, 3500));

  // 捕获反馈（toast / 消息条）
  const toast = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".el-message, [class*=toast], [class*=message], [class*=notice]")];
    return els.map((e) => (e.innerText || "").trim().slice(0, 60)).filter(Boolean).slice(0, 4);
  });
  console.log("平台反馈:", JSON.stringify(toast));

  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
})();
