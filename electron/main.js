/*
 * NoteFly · Electron 主进程（两种形态共用这一个入口）
 * 职责：
 *   1. 启动内置 Express 服务（若未运行）→ 打开应用窗口（启用 webview 内置浏览器）
 *   2. 系统托盘常驻：点主窗口「×」隐藏，不退出；托盘菜单可恢复/新建内容/检查更新/退出
 *   3. 单实例：已常驻时再次启动只恢复已有实例
 *   4. 统一生命周期：隐藏 / 真正退出 / 更新重启 三条路径分开
 *
 * 两种形态（靠命令行参数区分）：
 *   桌面版    electron .            → 服务 + 应用窗口 + 托盘
 *   浏览器版  electron . browser     → 只拉起服务，由服务端打开系统浏览器
 *
 * 启动方式：npx electron . 或 package.json 的 "desktop" 脚本；
 *           快捷方式「启动NoteFly.lnk / 启动NoteFly桌面版.lnk」双击即用（零控制台窗口）。
 */

/* ---- 脱离控制台自举 ----
   从 .bat（cmd 控制台）启动时，Electron 继承控制台会卡在启动阶段、
   根本不加载应用脚本；而且 ELECTRON_RUN_AS_NODE 存在时 electron.exe
   会退化成普通 node，require("electron") 拿不到 API。
   两种情况都在这里统一处理：用 detached 方式拉起一个干净的自己，
   父进程立刻退出。详见 lib/detach.js。

   ⚠ 必须在 require("electron") 之前 —— 那之后拿到的已经是字符串路径了。 */
const path = require("path");
const detach = require("../lib/detach");

/* ---- 两种形态：桌面版 / 浏览器版 ----
   快捷方式（.lnk）只能表达「目标 + 参数 + 工作目录」，参数是唯一能区分
   两者的手段。两个快捷方式必须保持**完全相同的形状**（目标都是项目根的
   electron.exe、工作目录都是项目根、参数只有多一个 "browser" 的差别）：
   一旦工作目录指向子目录、或参数写成别的路径，外壳解析快捷方式就会失败
   （报「Windows 无法访问指定设备、路径或文件」，或者外壳根本不启动进程）。
   两条链路都实测过：形状一致才能都正常工作。 */
const BROWSER_MODE = process.argv.slice(1).some((a) => a === "browser");
const APP_ARGS = BROWSER_MODE ? [".", "browser"] : ["."];

if (detach.detach(BROWSER_MODE ? "浏览器版" : "桌面版", APP_ARGS,
                  path.join(__dirname, "..", "logs"),
                  path.join(__dirname, ".."))) {
  process.exit(0);
}

const { app, BrowserWindow, Menu, shell, ipcMain, webContents, dialog } = require("electron");
const http = require("http");
const fs = require("fs");
const lifecycle = require("./lifecycle");
const updater = require("./updater");
const logger = require("../lib/logger");

module.exports = { lifecycle };

/* ---- 形态分流 ----
   浏览器版（命令行带 "browser"）：只把本地服务拉起来，由服务端打开系统浏览器；
   不建应用窗口、不建托盘、也不抢单实例锁 —— 桌面版常驻时仍能单独起浏览器版。
   CommonJS 的模块体被包在函数里，顶层 return 是合法的，这里用它提前收尾，
   免得把下面几百行桌面版逻辑整体缩进一层。 */
if (BROWSER_MODE) {
  require("../scripts/launch-server.js");
  return;
}

const PORT = Number(process.env.NOTEFLY_PORT) || 3210;
const APP_URL = `http://localhost:${PORT}`;

/* 内部 CDP 端口（仅本机 127.0.0.1）：发布引擎借此直接接管内置浏览器会话，
 * 不再复制 cookie —— 同一个浏览器、同一份登录态，平台不会判定为异地登录。 */
const CDP_PORT = process.env.NOTEFLY_CDP_PORT || "9333";
process.env.NOTEFLY_CDP_PORT = CDP_PORT;
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-allow-origins", "*");

/* 单实例：二次启动时聚焦已有窗口
 * （NOTEFLY_TEST_MULTI=1 豁免：真机检查脚本用独立 NOTEFLY_DATA_DIR 起第二个实例，
 *   数据完全隔离，不会互相干扰；正常运行不受影响） */
const gotLock = process.env.NOTEFLY_TEST_MULTI === "1" || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;
  lifecycle.state.mainWindow = null;

  /* 主进程未捕获异常：隐藏窗口下没有控制台，必须弹窗 */
  process.on("uncaughtException", (e) => {
    try {
      logger.error("桌面版", `主进程未捕获异常：${String((e && e.stack) || e)}`);
    } catch { /* 忽略 */ }
    try {
      dialog.showErrorBox("NoteFly 运行出错", String((e && e.stack) || e));
    } catch { /* 忽略 */ }
  });

  /* ---- 致命错误兜底 ----
     桌面版通过 VBS 隐藏窗口启动，没有控制台可看，
     console.error 用户根本收不到。启动失败必须弹窗告知，
     否则用户只会看到"双击了但什么都没发生"。 */
  function fatal(title, detail) {
    const msg = String(detail || "");
    try {
      logger.error("桌面版", `${title}：${msg}`);
    } catch { /* 日志失败不影响弹窗 */ }
    try {
      dialog.showErrorBox(title, msg);
    } catch {
      /* 极端情况（应用未就绪）只能退回标准输出 */
      console.error(`[NoteFly] ${title}: ${msg}`);
    }
  }

  /* 若端口已有服务（比如手动 node server.js 跑着），直接复用；否则拉起内置服务 */
  function serverAlive() {
    return new Promise((resolve) => {
      const req = http.get(`${APP_URL}/api/config`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
  }

  async function ensureServer() {
    if (await serverAlive()) {
      console.log("[NoteFly] 检测到服务已在运行，直接复用端口", PORT);
      return;
    }
    /* 内置服务必须与窗口访问同一个端口 */
    process.env.PORT = String(PORT);
    /* 服务端靠这两个变量判定运行形态：桌面版 + 已打包才允许「下载并安装更新」，
       其余（浏览器版 / 开发态）一律引导到发布页。必须在 require("../server.js")
       之前设置 —— 服务端读的是 require 时刻的环境。 */
    process.env.NOTEFLY_FORM = "desktop";
    process.env.NOTEFLY_PACKAGED = app.isPackaged ? "1" : "0";
    /* 打包版的应用目录在 asar 里只读，数据必须落到用户数据区
       （%APPDATA%/NoteFly/data）。仅在打包时设置 —— 开发态仍用项目内 data/。 */
    if (app.isPackaged) {
      process.env.NOTEFLY_DEFAULT_DATA_DIR = path.join(app.getPath("userData"), "data");
    }
    /* 更新桥：桌面版里 server.js 与主进程同进程，服务端的下载/安装路由
       借这个全局对象直接调 electron-updater（node 独立跑时没有它，
       update-routes 自然落到「引导发布页」分支）。download 前必须先
       checkForUpdates —— electron-updater 的 downloadUpdate 依赖其缓存。 */
    globalThis.NOTEFLY_UPDATE_BRIDGE = {
      download: async () => {
        const c = await updater.check();
        if (!c.ok) return c;
        const r = await updater.download();
        /* 用户取消：回报 download-cancelled，服务端把任务从 cancelling 转 cancelled */
        if (r && r.cancelled) {
          try {
            lifecycle.callServer("/api/update/progress", "POST", { type: "download-cancelled" });
          } catch { /* 忽略 */ }
        }
        return r;
      },
      cancelDownload: async () => updater.cancelDownload(),
      install: async () => {
        const guard = await lifecycle.quitForUpdate("安装更新");
        if (!guard.ok) return guard;
        return updater.quitAndInstall(false);
      },
    };
    require("../server.js");
    /* 等服务就绪 */
    for (let i = 0; i < 40; i++) {
      if (await serverAlive()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    fatal(
      "NoteFly 启动失败",
      `内置服务在 10 秒内没有就绪（端口 ${PORT}）。\n\n` +
      `可能原因：端口被其它程序占用，或依赖未安装。\n` +
      `可先执行 npm install，或关闭占用 ${PORT} 端口的程序后重试。`
    );
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      title: "NoteFly",
      icon: path.join(__dirname, "..", "public", "favicon.png"),
      backgroundColor: "#0b0b0c",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        webviewTag: true,           // 内置浏览器
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    lifecycle.state.mainWindow = mainWindow;

    mainWindow.loadURL(APP_URL);

    /* 外部链接交给系统浏览器，站内链接留在窗口内 */
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(APP_URL)) return { action: "allow" };
      shell.openExternal(url);
      return { action: "deny" };
    });

    /* ---- 关闭行为：默认隐藏到托盘，不退出 ---- */
    mainWindow.on("close", (e) => {
      const phase = lifecycle.state.phase;
      /* 更新重启：允许更新器正常退出，不能被拦成隐藏 */
      if (phase === "updating" || phase === "quitting" || phase === "shuttingDown") return;
      /* 明确选了「退出软件」→ 正常退出 */
      if (lifecycle.getCloseBehavior() === "quit") {
        lifecycle.quit({ reason: "用户关闭主窗口（设置为退出软件）" });
        return;
      }
      /* 默认：拦截 close，隐藏窗口，保留进程与已编辑内容 */
      e.preventDefault();
      lifecycle.hideMainWindow();
      lifecycle.notifyHiddenOnce();
    });

    /* 隐藏之后窗口并没有销毁，这里统一把引用清掉 */
    mainWindow.on("closed", () => {
      mainWindow = null;
      if (lifecycle.state.mainWindow && lifecycle.state.mainWindow.isDestroyed()) {
        lifecycle.state.mainWindow = null;
      }
    });
  }

  /* 内置浏览器登录完成后，界面通过主进程取该 webview 的 cookie（httpOnly 也能拿到） */
  ipcMain.handle("notefly:get-cookies", async (_e, id) => {
    try {
      const wc = webContents.fromId(Number(id));
      if (!wc) return [];
      const list = await wc.session.cookies.get({});
      return list.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite,
      }));
    } catch (e) {
      console.warn("[NoteFly] 读取 cookie 失败:", e.message);
      return [];
    }
  });

  /* 打开日志目录：用户排查问题时想直接翻原始日志文件 */
  ipcMain.handle("notefly:open-dir", async (_e, dir) => {
    try {
      const target = String(dir || "");
      if (!target) return { ok: false, error: "目录为空" };
      if (!fs.existsSync(target)) return { ok: false, error: "目录不存在：" + target };
      const err = await shell.openPath(target);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /* ---- 托盘相关 IPC ---- */

  /* 「关闭主窗口时」的行为：hide（默认）| quit */
  ipcMain.handle("notefly:get-close-behavior", async () => ({ ok: true, behavior: lifecycle.getCloseBehavior() }));
  ipcMain.handle("notefly:set-close-behavior", async (_e, v) => ({ ok: true, behavior: lifecycle.setCloseBehavior(v) }));

  /* 等价于「用户点标题栏的 ×」：由主进程发起关闭，走 BrowserWindow 的 close 事件，
     于是「关闭到托盘」的拦截逻辑能生效。
     ⚠ 渲染进程里直接调 window.close() **不等价** —— 实测那样根本不会触发
       BrowserWindow 的 close 事件（只有 closed），窗口被直接销毁，
       「关闭到托盘」的行为完全失效。测试与界面都应走这个入口。 */
  ipcMain.handle("notefly:close-window", async () => {
    const w = lifecycle.state.mainWindow;
    if (!w || w.isDestroyed()) return { ok: false, error: "主窗口不存在" };
    w.close();
    return { ok: true };
  });

  /* 真正退出（前端或托盘菜单触发） */
  ipcMain.handle("notefly:quit", async () => {
    lifecycle.quit({ reason: "用户主动退出" });
    return { ok: true };
  });

  /* 渲染进程报告「稿件已保存」/「保存失败」 */
  ipcMain.on("notefly:quit-reply", (_e, payload) => {
    /* 由 lifecycle 在等待时注册监听；这里不重复处理 */
  });

  /* 检查更新（托盘菜单或界面触发） */
  ipcMain.handle("notefly:check-update", async () => {
    const r = await lifecycle.callServer("/api/update/check", "POST", { manual: true });
    return r;
  });

  /* ---- 自动更新（electron-updater）----
     检查与下载分离：这里只做「用户点了立即更新之后的下载与安装」。 */
  ipcMain.handle("notefly:update-download", async () => {
    if (!updater.isSupported()) {
      return { ok: false, error: "当前是开发模式，不执行安装覆盖。可打开正式发布页手动下载。" };
    }
    return updater.download();
  });

  ipcMain.handle("notefly:update-install", async () => {
    if (!updater.isSupported()) {
      return { ok: false, error: "当前是开发模式，不执行安装覆盖。" };
    }
    /* 安装前必须走退出条件：保存稿件 → 停新任务 → 等在途任务落定 */
    const guard = await lifecycle.quitForUpdate("安装更新");
    if (!guard.ok) return guard;
    const r = updater.quitAndInstall(false);
    return r;
  });

  ipcMain.handle("notefly:open-release-page", async (_e, url) => {
    return updater.openReleasePage(url);
  });

  /* 打开外部链接（更新发布页等） */
  ipcMain.handle("notefly:open-external", async (_e, url) => {
    const s = String(url || "");
    if (!/^https?:\/\//i.test(s)) return { ok: false, error: "只允许打开 http/https 链接" };
    await shell.openExternal(s);
    return { ok: true };
  });

  /* 托盘状态查询：界面与自动化测试都要能确认托盘到底建没建成 */
  ipcMain.handle("notefly:tray-status", async () => {
    const t = lifecycle.state.tray;
    return {
      ok: true,
      exists: !!t,
      platform: process.platform,
      /* 托盘没建成时给出原因 —— 界面要提示，不能让用户失去入口 */
      error: t ? "" : (lifecycle.trayError || "系统托盘不可用"),
    };
  });

  /* webview 内的 window.open 留在内置浏览器里打开，不弹系统浏览器 */
  app.on("web-contents-created", (_e, wc) => {
    if (wc.getType() === "webview") {
      wc.setWindowOpenHandler(({ url }) => {
        wc.loadURL(url).catch(() => {});
        return { action: "deny" };
      });
    }
  });

  app.on("second-instance", () => {
    /* 已常驻时再次启动：只恢复已有实例，不创建第二个进程/托盘/服务 */
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (!mainWindow) {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await ensureServer();
    createWindow();

    /* ---- 初始化自动更新器 ----
       只在打包后的正式版生效；开发模式不执行安装覆盖。 */
    const upInit = updater.init({
      onEvent: (evt) => {
        /* 把更新进度回报给服务端，写进统一任务记录与消息中心 */
        lifecycle.callServer("/api/update/progress", "POST", evt).catch(() => {});
      },
    });
    if (!upInit.ok) {
      console.log("[NoteFly] 自动更新不可用：" + (upInit.message || upInit.reason));
    }

    /* ---- 创建系统托盘 ----
       托盘失败时保留主窗口可见并提示原因 —— 不能隐藏后失去入口。 */
    const trayResult = lifecycle.createTray({
      onOpen: () => lifecycle.showMainWindow(),
      onNewContent: () => {
        /* 通知渲染进程跳到「新建内容」 */
        const w = lifecycle.state.mainWindow;
        if (w && !w.isDestroyed()) {
          w.webContents.send("notefly:new-content");
        }
      },
      onCheckUpdate: async () => {
        const r = await lifecycle.callServer("/api/update/check", "POST", { manual: true });
        const w = lifecycle.state.mainWindow;
        if (w && !w.isDestroyed()) {
          w.webContents.send("notefly:update-checked", r);
        }
      },
      onQuit: () => {
        lifecycle.quit({ reason: "托盘菜单退出" });
      },
    });
    if (!trayResult.ok) {
      console.error("[NoteFly] 托盘创建失败：", trayResult.error);
      /* 主窗口保持可见；把原因告诉渲染进程，在界面上显示 */
      const w = lifecycle.state.mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send("notefly:tray-error", { error: trayResult.error });
      }
    }

    /* 启动后台检查更新：异步进行，不阻塞打开软件 */
    setTimeout(async () => {
      try {
        await lifecycle.callServer("/api/update/check", "POST", { manual: false });
      } catch (e) {
        console.warn("[NoteFly] 启动更新检查失败:", e && e.message);
      }
    }, 3000);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  /* ---- 退出路径 ---- */

  /* 所有窗口都关掉了：默认不退出（应用在托盘常驻）。
     只有明确退出或更新重启时才真正结束进程。 */
  app.on("window-all-closed", () => {
    const phase = lifecycle.state.phase;
    if (phase === "updating" || phase === "quitting" || phase === "shuttingDown") return;
    /* 有托盘 → 保持常驻；托盘创建失败 → 必须退出，否则用户找不到入口 */
    if (!lifecycle.state.tray) {
      lifecycle.quit({ reason: "全部窗口关闭且托盘不可用" });
    }
  });

  /* 系统关机/注销：尽力保存，不死循环拦截 */
  app.on("before-quit", () => {
    lifecycle.state.phase = "shuttingDown";
  });
  app.on("will-quit", () => {
    lifecycle.destroyTray();
  });
}
