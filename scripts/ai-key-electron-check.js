/*
 * Electron 真机验证：「申请 Key」在内置浏览器里真的加载了厂商申请页
 * 运行：node scripts/ai-key-electron-check.js
 *
 * 启动桌面版（Electron），通过 CDP attach 到它自己（绝不 newContext），
 * 点「申请 Key」，然后看 webview 的真实 URL 是否落在厂商申请页上。
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-keye-"));
/* Electron 主进程把服务端口写死 3210（electron/main.js），这里必须对齐，
   否则 Electron 会另起一个内置服务，CDP 里看到的是另一份页面 */
const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9334;
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

  const electronBin = require("electron");
  /* 宿主环境里 ELECTRON_RUN_AS_NODE=1（宿主自身是 Electron 应用），
     会让 electron.exe 以纯 node 模式跑 —— 必须清掉，否则 main.js 里 app 是 undefined */
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    NOTEFLY_DATA_DIR: TMP,
    NOTEFLY_CDP_PORT: String(CDP_PORT),
    NOTEFLY_DISABLE_SCHEDULER: "1",
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(electronBin, [ROOT], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.on("error", (e) => console.error("electron 启动失败:", e.message));

  /* 等 CDP 端口起来 */
  let browser = null;
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      break;
    } catch { await sleep(500); }
  }
  if (!browser) {
    console.log("FAIL  Electron CDP 未就绪（桌面版可能无法在本环境启动）");
    app.kill(); srv.kill();
    process.exit(1);
  }

  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  if (!page) {
    console.log("FAIL  CDP 里找不到主窗口页面");
    try { await browser.close(); } catch {}
    app.kill(); srv.kill();
    process.exit(1);
  }
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  check("桌面版界面加载", (await page.locator(".sidebar").count()) > 0);
  check("运行时是 Electron", await page.evaluate(() => !!window.notefly && window.notefly.isElectron === true));

  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).first().click();
  await sleep(700);

  const keyBtn = page.getByRole("button", { name: "申请 Key" });
  await page.locator(".ai-cfg-item").first().locator(".el-select").click();
  await sleep(500);
  await page.locator(".el-select-dropdown__item", { hasText: "DeepSeek" }).first().click();
  await sleep(600);
  check("「申请 Key」可用", !(await keyBtn.isDisabled()));

  await keyBtn.click();
  await sleep(2500);

  check("跳到内置浏览器页", (await page.locator(".b-bar input").count()) > 0);
  check("顶部有申请 Key 提示条", (await page.locator(".b-key-bar").count()) === 1);

  const addr = (await page.locator(".b-bar input").first().inputValue().catch(() => "")) || "";
  check("地址栏是厂商申请页", /platform\.deepseek\.com\/api_keys/.test(addr), addr);

  /* 关键：webview 真的加载了这个地址（不是只改了地址栏）
     注意：厂商未登录时会重定向到登录页（如 /sign_in），所以只断言域名归属厂商 */
  const realUrl = await page.evaluate(async () => {
    const w = document.getElementById("bWeb");
    if (!w) return "";
    try { return w.getURL ? w.getURL() : (w.src || ""); } catch { return ""; }
  });
  check(
    "内置浏览器 webview 实际加载了厂商站点",
    /(^|\/\/)platform\.deepseek\.com\//.test(realUrl),
    realUrl
  );

  check("无脚本报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  try { await page.screenshot({ path: path.join(ROOT, "_export", "key-browser.png") }); } catch {}

  try { await browser.close(); } catch {}
  app.kill();
  srv.kill();
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
