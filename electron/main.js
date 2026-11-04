/*
 * NoteFly Desktop · Electron 主进程
 * 职责：启动内置 Express 服务（若未运行）→ 打开应用窗口（启用 webview 内置浏览器）
 * 启动方式：npx electron . 或 package.json 的 "desktop" 脚本
 */
const { app, BrowserWindow, Menu, shell, ipcMain, webContents } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PORT = 3210;
const APP_URL = `http://localhost:${PORT}`;

/* 内部 CDP 端口（仅本机 127.0.0.1）：发布引擎借此直接接管内置浏览器会话，
 * 不再复制 cookie —— 同一个浏览器、同一份登录态，平台不会判定为异地登录。 */
const CDP_PORT = process.env.NOTEFLY_CDP_PORT || "9333";
process.env.NOTEFLY_CDP_PORT = CDP_PORT;
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-allow-origins", "*");

/* 单实例：二次启动时聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;

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
    require("../server.js");
    /* 等服务就绪 */
    for (let i = 0; i < 40; i++) {
      if (await serverAlive()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.error("[NoteFly] 内置服务启动失败");
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

    mainWindow.loadURL(APP_URL);

    /* 外部链接交给系统浏览器，站内链接留在窗口内 */
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(APP_URL)) return { action: "allow" };
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.on("closed", () => { mainWindow = null; });
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      /* 旧实例窗口已丢（僵尸状态）：直接补开一个窗口 */
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await ensureServer();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit(); // 关窗即退出（内置服务随之停止）
  });
}
