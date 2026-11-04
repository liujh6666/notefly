/*
 * 桌面版（Electron）真机验证：日志功能
 *   1. 桌面版内置浏览器 / preload 正常加载
 *   2. 设置页连点版本号 5 次能打开日志面板
 *   3. 「打开日志目录」走主进程 IPC 成功
 *
 * 运行：node scripts/log-electron-check.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-logelec-"));
/* Electron 主进程把服务端口写死 3210（electron/main.js），这里必须对齐，
   否则 Electron 会另起一个内置服务，CDP 里看到的是另一份页面 */
const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9336;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({
    engine: "rpa", keepalive: { enabled: false, intervalHours: 4 }, kaState: { details: [] },
  }, null, 2));

  /* 先把服务起在 3210：Electron 检测到端口已有服务就会直接复用，
     避免 Electron 另起一份内置服务导致 CDP 里看到的是另一个数据目录 */
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), NOTEFLY_DATA_DIR: TMP,
      NOTEFLY_DISABLE_SCHEDULER: "1", NOTEFLY_DISABLE_RESTORE: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stderr.on("data", (d) => console.log("[srv:err]", String(d).trim()));
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + "/api/config")).ok) break; } catch {}
    await sleep(250);
  }

  const electronBin = require("electron");
  /* 宿主环境里 ELECTRON_RUN_AS_NODE=1（宿主自身是 Electron 应用），
     会让 electron.exe 以纯 node 模式跑 —— 必须删掉，否则 main.js 里 app 是 undefined */
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    NOTEFLY_DATA_DIR: TMP,
    NOTEFLY_CDP_PORT: String(CDP_PORT),
    NOTEFLY_DISABLE_SCHEDULER: "1",
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [ROOT], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.VERBOSE && console.log("[el]", String(d).trim()));
  child.stderr.on("data", (d) => console.log("[el:err]", String(d).trim()));

  /* 等 Electron 窗口起来（通过 CDP 探活） */
  let browser = null;
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      break;
    } catch { await sleep(500); }
  }
  if (!browser) throw new Error("Electron 未就绪（CDP 连不上）");

  const ctx = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 30; i++) {
    const pages = ctx.pages();
    if (pages.length) { page = pages[0]; break; }
    await sleep(300);
  }
  if (!page) throw new Error("没找到 Electron 窗口页面");
  await sleep(2500);

  check("桌面版 preload 桥已注入", await page.evaluate(() => !!(window.notefly && window.notefly.isElectron)));

  /* 设置页 → 连点版本号 5 次 → 打开日志面板 */
  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).click();
  await sleep(800);
  for (let i = 0; i < 5; i++) { await page.locator(".nf-version").first().click(); await sleep(130); }
  await sleep(1000);
  const visible = await page.locator(".log-dialog").isVisible().catch(() => false);
  check("桌面版连点 5 次能打开日志面板", visible);

  /* 面板要有内容 */
  const rows = await page.locator(".log-row").count();
  check("桌面版日志面板列出了条目", rows > 0, `行数 ${rows}`);

  /* 「打开日志目录」走主进程 IPC */
  await page.locator(".log-bar").getByRole("button", { name: "打开日志目录" }).click();
  await sleep(1200);
  const msg = await page.locator(".el-message").last().innerText().catch(() => "");
  check("「打开日志目录」调用主进程成功", /已打开日志目录/.test(msg), msg);

  await browser.close();
  child.kill();
  srv.kill();
  await sleep(400);
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
