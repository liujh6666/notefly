"use strict";
/**
 * 脱离控制台自举（detach bootstrap）
 * ------------------------------------------------------------
 * 为什么需要它：
 *   从资源管理器双击快捷方式启动时，Electron 是被 Explorer 创建的，
 *   不带控制台，一切正常。
 *   但从 .bat 启动时，Electron 会继承 cmd.exe 的控制台 —— 在 Windows 11
 *   的「默认终端应用」（本机是 Windows Terminal，ConPTY）下，这会让
 *   Electron 卡在启动阶段、**根本不去加载应用脚本**（实测：进程活着、
 *   没有子进程、日志一条没写）。cmd 的 start 命令于是永远等不到
 *   被启动程序返回，终端窗口就一直挂在屏幕上。
 *
 * 做法：
 *   在 require("electron") 之前判断「当前是不是带着控制台」，
 *   如果是，就用 detached 方式把自己重新拉起 —— detached 会带上
 *   DETACHED_PROCESS，子进程**不继承控制台**，因此能正常加载应用；
 *   父进程随即退出，控制台被释放，命令窗口一闪即逝。
 *
 * 顺带处理 ELECTRON_RUN_AS_NODE：
 *   这个变量只要存在，electron.exe 就会退化成普通 node，
 *   require("electron") 拿不到 app / BrowserWindow。必须清掉再重启。
 *
 * ⚠ 必须在 require("electron") 之前调用 —— 那之后拿到的
 *   已经是字符串路径而不是 API 了。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/** 标记「已经脱离过一次」，防止无限重启 */
const MARK = "NOTEFLY_DETACHED";

function _log(dir, msg) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "_launch.log"),
      "[" + new Date().toISOString() + "] " + msg + "\n"
    );
  } catch { /* 日志失败不影响启动 */ }
}

/**
 * 当前进程是否带着控制台。
 * Windows 上输出到控制台时 isTTY 才为真；从资源管理器启动时
 * stdout 拿不到有效句柄，isTTY 为假。
 */
function hasConsole() {
  try {
    return !!(process.stdout && process.stdout.isTTY);
  } catch {
    return false;
  }
}

/**
 * 需要脱离控制台吗？
 *   - 已经脱离过 → 不需要
 *   - 带着控制台 → 需要（否则 Electron 会卡住不加载应用）
 *   - ELECTRON_RUN_AS_NODE 被设了 → 需要（否则拿不到 Electron API）
 */
function shouldDetach() {
  const env = process.env || {};
  if (env[MARK] === "1") return false;
  if (env.ELECTRON_RUN_AS_NODE) return true;
  return hasConsole();
}

/**
 * 执行脱离。返回 true 表示「已经重启了一个干净的自己」，调用方应当立刻退出。
 *
 * @param {string} label     日志里的名字，例如「桌面版」
 * @param {string[]} args    重启时传给可执行文件的参数
 * @param {string} logDir    日志目录
 * @param {string} cwd       重启后的工作目录
 */
function detach(label, args, logDir, cwd) {
  if (!shouldDetach()) return false;

  const env = Object.assign({}, process.env);
  env[MARK] = "1";
  delete env.ELECTRON_RUN_AS_NODE;

  _log(logDir, label + "自举：execPath=" + process.execPath +
       " cwd=" + (cwd || process.cwd()) +
       " 带控制台=" + hasConsole() +
       " ELECTRON_RUN_AS_NODE=" + JSON.stringify(process.env.ELECTRON_RUN_AS_NODE));

  const child = spawn(process.execPath, args, {
    cwd: cwd || process.cwd(),
    env,
    detached: true,      // DETACHED_PROCESS：子进程不继承控制台
    stdio: "ignore",
    /* ⚠ 这里**不能**加 windowsHide：它在 Windows 上等价于
       STARTF_USESHOWWINDOW + SW_HIDE，会把子进程的**第一个窗口**也隐藏掉。
       electron.exe 是 GUI 子系统程序，本来就不分配控制台，不需要这个标志。 */
  });
  child.unref();
  _log(logDir, label + "自举：已重启 PID=" + child.pid);
  child.on("error", (e) => _log(logDir, label + "自举：spawn 出错 —— " + e.message));
  return true;
}

module.exports = { detach, hasConsole, shouldDetach, MARK };
