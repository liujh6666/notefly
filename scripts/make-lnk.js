/*
 * 生成 Windows 快捷方式（.lnk）的入口包装器。
 * ------------------------------------------------------------
 * 零窗口启动入口就是这两个 .lnk：
 *     启动NoteFly桌面版.lnk → electron.exe .            （桌面版）
 *     启动NoteFly.lnk        → electron.exe . browser    （浏览器版）
 *
 * 为什么需要两个后端：
 *   .lnk 是二进制格式，手写要按 MS-SHLLINK 规范拼字节，
 *   而且**必须有 LinkTargetIDList**（外壳靠它解析目标，
 *   少了这一段实测双击无反应）。生成这段 PIDL 需要调用
 *   Win32 的 SHParseDisplayName —— Python 用 ctypes 能调，
 *   纯 Node 调不了。
 *   所以：
 *     1) 首选 scripts/make-lnk.py（Python + ctypes，字节最准）；
 *     2) 退路 scripts/make-lnk.ps1（WScript.Shell COM，Windows 自带）。
 *
 * 用法：npm run make:lnk
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

/** 判断一条命令在本机是否可用 */
function has(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 20000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(ELECTRON)) {
    console.log("[make:lnk] 没找到 Electron 运行时（" + ELECTRON + "），先执行 npm install");
    process.exit(0);   // 不让 postinstall 失败
  }

  /* ---- 后端 1：Python + ctypes ---- */
  const py = ["python", "py", "python3"].find((c) => has(c, ["--version"]));
  if (py) {
    console.log("[make:lnk] 用 Python 生成（" + py + "）");
    const r = spawnSync(py, [path.join(__dirname, "make-lnk.py")],
      { cwd: ROOT, stdio: "inherit" });
    if (r.status === 0) {
      console.log("[make:lnk] 完成：启动NoteFly.lnk / 启动NoteFly桌面版.lnk");
      return;
    }
    console.log("[make:lnk] Python 生成失败（退出码 " + r.status + "），改用 PowerShell");
  }

  /* ---- 后端 2：PowerShell + WScript.Shell COM ---- */
  if (has("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"])) {
    console.log("[make:lnk] 用 PowerShell 生成");
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", path.join(__dirname, "make-lnk.ps1")],
      { cwd: ROOT, stdio: "inherit" });
    if (r.status === 0) {
      console.log("[make:lnk] 完成：启动NoteFly.lnk / 启动NoteFly桌面版.lnk");
      return;
    }
    console.log("[make:lnk] PowerShell 生成失败（退出码 " + r.status + "）");
  }

  console.log("[make:lnk] 没有可用的生成器（既没有 Python 也没有 PowerShell）。");
  console.log("[make:lnk] 不影响使用：双击同名的 .bat 也能启动，只是会闪一下控制台。");
  process.exit(0);
}

main();
