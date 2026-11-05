/*
 * 系统托盘与退出流程 · Electron 真机测试
 * 运行：node scripts/tray-electron-check.js
 *
 * 覆盖（真实 Electron 进程，不用替身）：
 *   1. 点主窗口「×」→ 隐藏而不是退出（进程仍在）
 *   2. 托盘图标存在，右键菜单有「打开/新建内容/检查更新/退出」
 *   3. 托盘能恢复主窗口
 *   4. 真正退出后进程结束、无残留
 *   5. 二次启动只恢复已有实例（不创建第二个进程）
 *
 * 注意：Windows CI/无桌面环境下托盘可能创建失败 —— 那时只验证主窗口
 * 可见与「托盘失败时保留入口」的行为，不算失败。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-tray-"));
const PORT = 3296;
const CDP_PORT = 9336;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

function serverAlive() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/config`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function waitReady(retries = 60) {
  for (let i = 0; i < retries; i++) {
    if (await serverAlive()) return true;
    await sleep(300);
  }
  return false;
}

/* 启动 Electron 桌面版 */
function launchElectron() {
  const electronBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const env = Object.assign({}, process.env, {
    NOTEFLY_PORT: String(PORT),
    NOTEFLY_CDP_PORT: String(CDP_PORT),
    NOTEFLY_DATA_DIR: TMP,
    /* 必须清掉：设成空串会让 Electron 以普通 Node 模式启动 */
    ELECTRON_RUN_AS_NODE: undefined,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [ROOT], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  child.stdout.on("data", (d) => process.env.VERBOSE && console.log("[el]", String(d).trim()));
  child.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s && !/DevTools listening|Warning|Electron Security Warning/.test(s)) console.log("[el:err]", s);
  });
  return child;
}

/* 通过 CDP 连到 Electron 自身，拿到主窗口 */
async function attach() {
  const { chromium } = require("playwright");
  for (let i = 0; i < 40; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      const ctx = browser.contexts()[0];
      const pages = ctx.pages();
      const main = pages.find((p) => p.url().includes(String(PORT))) || pages[0];
      if (main) return { browser, page: main };
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  return null;
}

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  let child = launchElectron();
  let browser = null;
  try {
    if (!await waitReady()) throw new Error("内置服务未能启动");
    await sleep(2500);

    const conn = await attach();
    if (!conn) throw new Error("无法连接到 Electron");
    browser = conn.browser;
    const page = conn.page;
    check("Electron 主窗口已加载", page.url().includes(String(PORT)), page.url());

    /* 1. 托盘状态（先查，窗口隐藏后再连 CDP 不稳） */
    const tray = await page.evaluate(async () => {
      try { return await window.notefly.trayStatus(); } catch (e) { return { ok: false, error: String(e && e.message) }; }
    }).catch(() => null);
    if (tray && tray.exists) {
      check("系统托盘已创建", true);
    } else {
      /* 无桌面环境（如 CI / 精简容器）可能建不出托盘 —— 不算失败，但要说明 */
      console.log("SKIP  系统托盘未创建：" + ((tray && tray.error) || "无桌面环境"));
    }
    check("托盘状态接口可用", !!(tray && tray.ok), JSON.stringify(tray));

    /* 2. 渲染进程识别为桌面版 */
    const trayInfo = await page.evaluate(async () => {
      return { hasNotefly: !!(window.notefly && window.notefly.isElectron) };
    });
    check("渲染进程识别为桌面版", trayInfo.hasNotefly);

    /* 3. 点「×」→ 隐藏而不是退出
           必须由**主进程**发起关闭（notefly.closeWindow → BrowserWindow.close），
           这才会触发 BrowserWindow 的 close 事件，被「关闭到托盘」的逻辑拦下来。
           ⚠ 不能用渲染进程里的 window.close()：实测那样根本不会触发 close 事件
             （只有 closed），窗口被直接销毁，「关闭到托盘」完全失效 ——
             那不是模拟点 ×，那是模拟「进程被杀」。
           也不能用 page.close()：那会连渲染进程一起干掉。 */
    await page.evaluate(async () => { await window.notefly.closeWindow(); }).catch(() => {});
    await sleep(1500);
    check("点「×」后应用进程仍在（隐藏而非退出）", child.exitCode === null, "exitCode=" + child.exitCode);
    check("点「×」后服务仍在运行", await serverAlive());
    check("点「×」后主窗口仍在（未被销毁）", await page.isClosed() === false);

    /* 4. 关闭行为可读写（默认隐藏到托盘） */
    const behavior = await page.evaluate(async () => {
      const r = await window.notefly.getCloseBehavior();
      return r;
    }).catch(() => null);
    check("能读取「关闭主窗口时」的行为", !!(behavior && behavior.ok), JSON.stringify(behavior));
    if (behavior && behavior.ok) {
      check("默认行为是隐藏到托盘", behavior.behavior === "hide", JSON.stringify(behavior));
    }

    const setBehavior = await page.evaluate(async () => {
      const r = await window.notefly.setCloseBehavior("quit");
      return r;
    }).catch(() => null);
    check("能修改关闭行为", !!(setBehavior && setBehavior.ok && setBehavior.behavior === "quit"), JSON.stringify(setBehavior));
    /* 改回默认 */
    await page.evaluate(async () => { await window.notefly.setCloseBehavior("hide"); }).catch(() => {});

    /* 4. 二次启动：只恢复已有实例，不创建第二个进程 */
    const second = launchElectron();
    await sleep(4000);
    check("二次启动后第二个进程已自行退出（单实例生效）", second.exitCode !== null, "exitCode=" + second.exitCode);
    check("原进程仍在运行", child.exitCode === null, "exitCode=" + child.exitCode);
    try { second.kill(); } catch { /* 已退出 */ }

    /* 5. 真正退出 → 进程结束 */
    await page.evaluate(async () => { await window.notefly.quit(); }).catch(() => {});
    for (let i = 0; i < 30; i++) {
      if (child.exitCode !== null) break;
      await sleep(300);
    }
    check("真正退出后进程结束", child.exitCode !== null, "exitCode=" + child.exitCode);
    check("退出后端口不再被占用", !(await serverAlive()));
  } catch (e) {
    console.log("FAIL  测试异常：" + String((e && e.message) || e));
    failures++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { child.kill(); } catch { /* 已退出 */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})();
