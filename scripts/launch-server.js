/*
 * 浏览器版启动器 —— 用 Electron（GUI 子系统程序）当「无窗口启动器」。
 * ------------------------------------------------------------
 * 为什么不用 node 直接跑 server.js：
 *   node.exe 是控制台程序（PE Subsystem=3）。双击就会分配一个控制台，
 *   在 Windows 11 上还会被「默认终端应用」接管（本机是 Windows Terminal），
 *   弹出一个 Terminal 窗口，而且那个窗口**不会自行关闭**。
 *   electron.exe 是 GUI 程序（PE Subsystem=2），不分配控制台。
 *
 * 链路：electron.exe（本脚本）→ spawn(node, server.js)
 *        spawn 带 windowsHide + detached + stdio:'ignore'，
 *        服务端从此与任何控制台无关，也不依赖本进程存活。
 *
 * 调用方式有两种：
 *   1) 快捷方式「启动NoteFly.lnk」→ electron.exe . browser
 *      主进程（electron/main.js）识别到 "browser" 参数后转发到本文件；
 *   2) 直接执行：electron.exe "<项目根>\scripts\launch-server.js"
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

/* 启动日志：隐藏窗口场景下没有任何控制台可看，出错只能靠日志定位。 */
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

log("启动器被调用 pid=" + process.pid +
    " argv=" + JSON.stringify(process.argv.slice(1)) +
    " cwd=" + process.cwd() +
    " stdoutTTY=" + !!(process.stdout && process.stdout.isTTY));

/* ---- 脱离控制台自举 ----
   两种情况都要在这里处理（必须在 require("electron") 之前）：
     1. ELECTRON_RUN_AS_NODE 存在 → electron.exe 退化成普通 node，拿不到 API
     2. 从 cmd 控制台启动 → Electron 继承控制台会卡住不加载脚本
   统一做法：detached 拉起一个干净的自己，父进程立刻退出。
   详见 lib/detach.js。 */
const detach = require("../lib/detach");
if (detach.detach("浏览器版启动器", [__filename], path.join(ROOT, "logs"), ROOT)) {
  process.exit(0);
}

const { app, dialog, BrowserWindow } = require("electron");

process.on("uncaughtException", (e) => {
  log("未捕获异常：" + String((e && e.stack) || e));
  try { dialog.showErrorBox("NoteFly 启动失败", String((e && e.stack) || e)); } catch { /* 忽略 */ }
  try { app.quit(); } catch { /* 忽略 */ }
});

/** 找 node.exe：从 PATH 扫，找不到就退回到常见的安装位置 */
function findNode() {
  const exts = (process.env.PATHEXT || ".EXE;.CMD").split(";");
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, "node" + ext.toLowerCase());
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* 忽略 */ }
    }
  }
  const fallbacks = [
    "C:/Program Files/nodejs/node.exe",
    "C:/Program Files (x86)/nodejs/node.exe",
    "D:/Program Files/nodejs/node.exe",
  ];
  for (const p of fallbacks) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 忽略 */ }
  }
  return "";
}

app.whenReady().then(() => {
  const node = findNode();
  const server = path.join(ROOT, "server.js");

  log("启动器就绪 pid=" + process.pid + " node=" + (node || "(未找到)"));

  /* ---- 建一个隐藏窗口 ----
     目的不是显示界面，而是让 Electron 进程能进入「输入空闲」状态。
     cmd 的 start 命令会等被启动的程序进入输入空闲才返回（实测：不返回）。
     一个**始终没有窗口**的 Electron 进程永远等不到这个信号，
     于是 start 一直挂着 → 终端窗口就一直挂在屏幕上。
     有了窗口（哪怕是隐藏的）就立刻空闲，start 马上返回，终端窗口随即消失。 */
  let keepAlive = null;
  try {
    keepAlive = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      frame: false,
    });
  } catch (e) {
    log("隐藏窗口创建失败（不影响启动）：" + String((e && e.message) || e));
  }

  if (!node || !fs.existsSync(server)) {
    /* 没有任何窗口可依附，错误只能弹窗 */
    log("启动失败：" + (node ? "缺少 server.js" : "缺少 node.exe"));
    try {
      dialog.showErrorBox(
        "NoteFly 启动失败",
        node ? "找不到 server.js：" + server : "没有找到 Node.js，请先安装（https://nodejs.org）。"
      );
    } catch { /* 忽略 */ }
    app.quit();
    return;
  }

  const env = Object.assign({}, process.env);
  /* 服务端监听成功后自动打开浏览器 —— 隐藏窗口场景下用户看不到控制台，
     总得有个东西告诉他「起来了」。这个变量在 Node 侧设置，
     不依赖 WScript.Shell.Environment（实测会卡死）。 */
  env.NOTEFLY_OPEN_BROWSER = "1";
  /* 形态标记：浏览器版不允许「下载并安装更新」（没有 Electron 外壳执行安装），
     服务端据此把更新引导到发布页。桌面版由 electron/main.js 设 NOTEFLY_FORM=desktop。 */
  env.NOTEFLY_FORM = "browser";

  const child = spawn(node, [server], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: "ignore",
    /* 这里**必须**带 windowsHide：node.exe 是控制台子系统程序，
       不加就会分配一个控制台并被 Windows Terminal 接管，弹出 Terminal 窗口。
       对控制台程序而言 SW_HIDE 正是我们要的效果。 */
    windowsHide: true,
  });
  child.unref();
  log("已拉起服务端 PID=" + child.pid);

  /* 启动器本身没有界面，交给服务端后立刻退出 */
  setTimeout(() => {
    try { if (keepAlive && !keepAlive.isDestroyed()) keepAlive.destroy(); } catch { /* 忽略 */ }
    app.quit();
  }, 600);
});

app.on("window-all-closed", () => app.quit());
