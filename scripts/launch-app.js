/*
 * NoteFly 启动器（纯 Node，供脚本 / 定时任务调用）
 * ------------------------------------------------------------
 * 日常启动请用仓库根目录的两个快捷方式（npm run make:lnk 生成）：
 *   启动NoteFly桌面版.lnk / 启动NoteFly.lnk
 * 它们指向 electron.exe（GUI 子系统程序），**双击零控制台窗口**。
 * 本脚本是给「从命令行 / 计划任务 / 其他程序里拉起」用的。
 *
 * 为什么用 detached：
 *   Electron 作为 cmd 的子进程会继承 cmd 的控制台，在 Windows 11 的
 *   「默认终端应用」（Windows Terminal，ConPTY）下 Chromium 初始化会卡住，
 *   **应用脚本根本不加载**（实测：进程活着、无子进程、日志一条不写）。
 *   detached（DETACHED_PROCESS）⇒ 子进程**不继承控制台** ⇒ 一切正常。
 *
 * 用法：node scripts/launch-app.js <desktop|browser>
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MODE = (process.argv[2] || "desktop").toLowerCase();

/* 两种形态的应用路径：
     desktop → 项目根（package.json 的 main = electron/main.js）
     browser → 同一个项目根 + 多一个 "browser" 参数（主进程据此分流）
   两者形状一致：同一个 electron.exe、同一个工作目录。 */
const APP = {
  desktop: { args: ["."], cwd: ROOT },
  browser: { args: [".", "browser"], cwd: ROOT },
};

function log(msg) {
  try {
    const dir = path.join(ROOT, "logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "_launch.log"),
      "[" + new Date().toISOString() + "] " + msg + "\n"
    );
  } catch { /* 日志失败不影响启动 */ }
}

const target = APP[MODE];
if (!target) {
  log("启动失败：未知模式 " + MODE);
  process.exit(2);
}

/* Electron 运行时：优先用项目里的 node_modules，其次用打包进来的资源 */
function findElectron() {
  const cands = [
    path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
    path.join(ROOT, "node_modules", "electron", "dist", "electron"),
    path.join(ROOT, "resources", "electron.exe"),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return "";
}

const electron = findElectron();
if (!electron) {
  log("启动失败：找不到 Electron 运行时，请先执行 npm install");
  process.exit(3);
}

const env = Object.assign({}, process.env);
/* 必须清掉：带着它 electron.exe 会退化成普通 node，拿不到 app/BrowserWindow */
delete env.ELECTRON_RUN_AS_NODE;
delete env.NOTEFLY_DETACHED;

const child = spawn(electron, target.args, {
  cwd: target.cwd,
  env,
  detached: true,          // DETACHED_PROCESS：不继承 cmd 的控制台
  stdio: "ignore",
  /* ⚠ 不能加 windowsHide：它在 Windows 上等价于 STARTF_USESHOWWINDOW + SW_HIDE，
     会把子进程的**第一个窗口**也隐藏掉。electron.exe 是 GUI 程序，
     本来就不分配控制台，不需要这个标志。 */
});

child.unref();
log("已拉起 " + MODE + " 版 Electron PID=" + child.pid +
    " execPath=" + electron +
    " args=" + JSON.stringify(target.args) +
    " cwd=" + target.cwd);

child.on("error", (e) => log("启动失败：" + e.message));
