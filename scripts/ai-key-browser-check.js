/*
 * 验证：「申请 Key」在软件内置浏览器里打开厂商申请页（Electron 桌面版行为）
 * 运行：node scripts/ai-key-browser-check.js
 *
 * 桌面端才有的内置浏览器，普通 Chromium 里没有 <webview>。
 * 这里用带 "Electron" 的 User-Agent 伪造桌面环境，验证前端的状态流转：
 *   点「申请 Key」→ 跳到内置浏览器页 → 地址栏是厂商申请页 → 顶部有申请提示条
 *   点「返回设置填写 Key」→ 回到设置页并滚到 AI 卡片
 *   点「关闭提示」→ 提示条消失
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-keyb-"));
const PORT = 3317;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "store.json"), JSON.stringify({ contents: [], tasks: [], accounts: [] }));

  const srv = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), NOTEFLY_DATA_DIR: TMP, NOTEFLY_DISABLE_SCHEDULER: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + "/api/config")).ok) break; } catch {}
    await sleep(250);
  }

  const browser = await chromium.launch({ headless: true });
  /* 伪造 Electron UA：让 isElectron 判定为真，走内置浏览器分支 */
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 NoteFly/1.0.0 Electron/33.0.0",
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    errors.push("[console] " + t);
  });

  /* 记录 window.open：内置浏览器分支不该再走它 */
  await page.addInitScript(() => {
    window.__opened = [];
    const orig = window.open;
    window.open = (url, ...rest) => { window.__opened.push(String(url)); return { closed: false }; };
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(600);

  check("前端判定为桌面版（isElectron）", await page.evaluate(() => /Electron/i.test(navigator.userAgent)));

  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).first().click();
  await sleep(600);

  const keyBtn = page.getByRole("button", { name: "申请 Key" });
  check("设置页有「申请 Key」按钮", (await keyBtn.count()) === 1);

  /* 选 DeepSeek */
  await page.locator(".ai-cfg-item").first().locator(".el-select").click();
  await sleep(400);
  await page.locator(".el-select-dropdown__item", { hasText: "DeepSeek" }).first().click();
  await sleep(500);
  check("选 DeepSeek 后「申请 Key」可用", !(await keyBtn.isDisabled()));

  /* 点申请 Key → 应跳到内置浏览器页 */
  await keyBtn.click();
  await sleep(1200);

  const onBrowserPage = await page.locator(".b-bar input").count();
  check("跳到内置浏览器页", onBrowserPage > 0);

  const addr = onBrowserPage ? await page.locator(".b-bar input").first().inputValue() : "";
  check(
    "地址栏是 DeepSeek 的 Key 申请页",
    /platform\.deepseek\.com\/api_keys/.test(addr),
    addr
  );

  const opened = await page.evaluate(() => window.__opened || []);
  check("桌面版不再走 window.open（不再开系统浏览器）", opened.length === 0, JSON.stringify(opened));

  /* 顶部申请提示条 */
  const keyBar = page.locator(".b-key-bar");
  check("内置浏览器顶部有申请 Key 提示条", (await keyBar.count()) === 1);
  const barText = (await keyBar.innerText().catch(() => "")) || "";
  check("提示条写明服务名与用途", /DeepSeek/.test(barText) && /API Key/.test(barText), barText.replace(/\n/g, " "));

  /* 「返回设置填写 Key」 */
  await keyBar.getByRole("button", { name: "返回设置填写 Key" }).click();
  await sleep(1000);
  check("返回后回到设置页", (await page.locator("#set-ai").count()) > 0);
  check("返回后申请提示条已清除", (await page.locator(".b-key-bar").count()) === 0);

  /* 再进一次，用「关闭提示」收起 */
  await keyBtn.click();
  await sleep(1000);
  check("再次进入内置浏览器时提示条重现", (await page.locator(".b-key-bar").count()) === 1);
  await page.locator(".b-key-bar").getByRole("button", { name: "关闭提示" }).click();
  await sleep(500);
  check("「关闭提示」后提示条消失", (await page.locator(".b-key-bar").count()) === 0);

  /* 离开浏览器页后不应再带出提示条 */
  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).first().click();
  await sleep(700);
  await page.getByRole("button", { name: "申请 Key" }).click();
  await sleep(900);
  check("重新申请后提示条再次出现", (await page.locator(".b-key-bar").count()) === 1);
  await page.locator(".sidebar .el-menu-item", { hasText: "工作台" }).first().click();
  await sleep(600);
  await page.locator(".sidebar .el-menu-item", { hasText: "内置浏览器" }).first().click();
  await sleep(900);
  check("离开再回来提示条是干净状态", (await page.locator(".b-key-bar").count()) === 0);

  check("无脚本报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
