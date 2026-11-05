/*
 * NoteFly 桌面版 · 生命周期
 * ------------------------------------------------------------
 * 三种状态必须严格区分，绝不能互相串：
 *
 *   hidden     点主窗口「×」→ 隐藏窗口，进程与应用继续活着
 *   quitting   用户主动退出 → 保存并清理资源后真正结束进程
 *   updating   更新重启 → 允许更新器退出并重新启动，不再被拦截成隐藏
 *
 * 另有：
 *   shuttingDown  系统关机/注销 → 尽力保存，不死循环拦截
 *
 * 关键约束：
 *  - 隐藏不是销毁：主窗口只是 hide()，编辑内容与页面状态都还在。
 *  - 真正退出后不能有残留进程：关掉后台服务、销毁托盘、释放端口。
 *  - 不关闭用户自己启动的其它程序。
 */
"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

/* ---------------- 生命周期状态 ---------------- */

const state = {
  /** hidden | quitting | updating | shuttingDown | running */
  phase: "running",
  /** 首次隐藏提示是否已弹过（不反复打扰） */
  hideHintShown: false,
  /** 托盘对象：必须保留引用，否则会被垃圾回收导致图标消失 */
  tray: null,
  /** 托盘创建失败的原因（界面要提示，不能让用户失去入口） */
  trayError: "",
  /** 主窗口引用 */
  mainWindow: null,
  /** 关闭主窗口时的行为：hide（默认）| quit */
  closeBehavior: "hide",
};

/* 托盘图标：优先用 32px 的 PNG（Windows 通知区会按 @2x 自动取高清版本），
   打包后路径仍然有效 */
function trayIconPath() {
  const candidates = [
    path.join(__dirname, "..", "public", "tray.png"),
    path.join(__dirname, "..", "public", "tray.ico"),
    path.join(__dirname, "..", "public", "app.ico"),
    path.join(__dirname, "..", "public", "favicon.png"),
    path.join(__dirname, "..", "public", "logo.png"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 忽略 */ }
  }
  return "";
}

/** 读取「关闭主窗口时」的行为设置（存在用户主目录的设置文件里） */
function readSettings() {
  try {
    const os = require("os");
    const f = path.join(os.homedir(), ".notefly", "desktop.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j && j.closeBehavior === "quit") return j;
    if (j && j.closeBehavior === "hide") return j;
  } catch {
    /* 没有设置文件或读不了：用默认值 */
  }
  return {};
}

function writeSettings(patch) {
  try {
    const os = require("os");
    const dir = path.join(os.homedir(), ".notefly");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "desktop.json");
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* 新建 */ }
    const next = Object.assign({}, cur, patch || {});
    fs.writeFileSync(f, JSON.stringify(next, null, 2), "utf8");
    return next;
  } catch (e) {
    return null;
  }
}

/** 供前端查询与修改「关闭主窗口时」的行为 */
function getCloseBehavior() {
  return state.closeBehavior;
}
function setCloseBehavior(v) {
  const val = v === "quit" ? "quit" : "hide";
  state.closeBehavior = val;
  writeSettings({ closeBehavior: val });
  return val;
}

/* ---------------- 主窗口显示 / 隐藏 ---------------- */

/** 恢复并聚焦主窗口（已最小化则先恢复） */
function showMainWindow() {
  const w = state.mainWindow;
  if (!w || w.isDestroyed()) return false;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return true;
}

/** 隐藏主窗口（不销毁） */
function hideMainWindow() {
  const w = state.mainWindow;
  if (!w || w.isDestroyed()) return false;
  w.hide();
  return true;
}

/**
 * 首次隐藏时轻量提示一次。
 * 不反复打扰：提示过就不再弹。
 */
function notifyHiddenOnce() {
  if (state.hideHintShown) return;
  state.hideHintShown = true;
  try {
    const { Notification } = require("electron");
    if (Notification && Notification.isSupported()) {
      const n = new Notification({
        title: "NoteFly 已在后台运行",
        body: "可从托盘图标打开或退出。采集、AI 与发布任务会继续运行。",
      });
      n.on("click", () => showMainWindow());
      n.show();
    }
  } catch {
    /* 通知不可用就算了，不影响隐藏 */
  }
}

/* ---------------- 托盘 ---------------- */

/**
 * 创建系统托盘图标
 * @param {{onOpen:Function, onNewContent:Function, onCheckUpdate:Function,
 *          onQuit:Function, onShowWindow:Function}} handlers
 * @returns {{ok:boolean, error?:string}}
 */
function createTray(handlers) {
  if (state.tray) return { ok: true };
  const iconPath = trayIconPath();
  if (!iconPath) {
    state.trayError = "找不到托盘图标资源（public/tray.png），已保留主窗口显示";
    return { ok: false, error: state.trayError };
  }
  let image;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (process.platform === "win32" && image.isEmpty()) {
      state.trayError = "托盘图标文件无法识别（public/tray.png 损坏或格式不支持）";
      return { ok: false, error: state.trayError };
    }
    /* 高 DPI 屏幕：手动挂 @2x 版本，托盘图标才不会糊 */
    if (/\.png$/i.test(iconPath)) {
      const hiPath = iconPath.replace(/\.png$/i, "@2x.png");
      try {
        if (fs.existsSync(hiPath)) {
          const hi = nativeImage.createFromPath(hiPath);
          if (!hi.isEmpty()) {
            hi.setScaleFactor(2);
            image = hi;
          }
        }
      } catch { /* 高清图缺失就用基础图 */ }
    }
    /* macOS 用模板图更贴合系统风格 */
    if (process.platform === "darwin") image.setTemplateImage(true);
  } catch (e) {
    state.trayError = "托盘图标加载失败：" + String((e && e.message) || e);
    return { ok: false, error: state.trayError };
  }

  try {
    const tray = new Tray(image);
    /* 保留引用 —— 否则 Tray 会被 GC，图标从托盘消失 */
    state.tray = tray;

    const isMac = process.platform === "darwin";

    /* macOS 走菜单栏交互；Windows 走左键恢复 + 右键菜单 */
    tray.setToolTip("NoteFly");
    if (!isMac) {
      tray.on("click", () => {
        showMainWindow();
      });
      /* 双击也恢复 */
      tray.on("double-click", () => showMainWindow());
    }

    const menu = Menu.buildFromTemplate([
      { label: "打开 NoteFly", click: () => showMainWindow() },
      { label: "新建内容", click: () => { showMainWindow(); handlers.onNewContent && handlers.onNewContent(); } },
      { type: "separator" },
      { label: "检查更新", click: () => { showMainWindow(); handlers.onCheckUpdate && handlers.onCheckUpdate(); } },
      { type: "separator" },
      { label: "退出软件", click: () => handlers.onQuit && handlers.onQuit() },
    ]);
    tray.setContextMenu(menu);

    /* macOS：菜单栏点一下就是菜单，左键点击不拦截 */
    if (isMac) {
      tray.on("click", () => showMainWindow());
    }
    return { ok: true };
  } catch (e) {
    state.tray = null;
    state.trayError = "创建系统托盘失败：" + String((e && e.message) || e);
    return { ok: false, error: state.trayError };
  }
}

/** 销毁托盘（真正退出时调用，避免残留） */
function destroyTray() {
  if (!state.tray) return;
  try { state.tray.destroy(); } catch { /* 已销毁 */ }
  state.tray = null;
}

/* ---------------- 退出流程 ---------------- */

/**
 * 真正退出：先保存状态，等在途任务落定，再释放资源。
 * @param {{reason?:string, force?:boolean, onDone?:Function}} opts
 */
async function quit(opts) {
  const o = opts || {};
  if (state.phase === "quitting") return { ok: true, already: true };
  state.phase = o.phase || "quitting";

  const win = state.mainWindow;

  /* 1. 需要提示用户时，先把主窗口恢复出来（否则用户不知道发生了什么） */
  if (o.restoreWindow !== false && win && !win.isDestroyed() && !win.isVisible()) {
    try { win.show(); } catch { /* 忽略 */ }
  }

  /* 2. 通知渲染进程保存未保存的稿件。
     保存失败 / 保存超时 / 用户取消都必须中止退出 —— 绝不能带着没保存的稿子销毁窗口。
     （渲染进程挂死导致回复收不到时按超时处理，同样中止退出；用户可从托盘重试，
       若反复超时说明渲染进程已无响应，重启应用即可。） */
  let saved = true;
  let saveNote = "";
  try {
    const r = await notifyRendererSave(o.reason || "退出");
    saved = r.saved;
    saveNote = r.note || "";
  } catch (e) {
    saved = false;
    saveNote = String((e && e.message) || e);
  }
  if (!saved && !o.force) {
    state.phase = "running";
    try {
      const { Notification } = require("electron");
      if (Notification && Notification.isSupported()) {
        new Notification({
          title: "退出已推迟：稿件未保存",
          body: saveNote || "有稿件没有保存成功，已保留窗口与编辑内容。处理后再从托盘退出。",
        }).show();
      }
    } catch { /* 忽略 */ }
    return { ok: false, error: "稿件保存失败，已保留窗口与编辑内容" };
  }

  /* 3. 等待在途任务落定（有超时，不无限等） */
  if (!o.force) {
    const settled = await waitForTasksToSettle(o.timeoutMs || 15000);
    if (!settled) {
      /* 任务暂时无法安全停止：按要求不强杀，提示用户并允许稍后继续 */
      if (!o.force) {
        try {
          const { Notification } = require("electron");
          if (Notification && Notification.isSupported()) {
            new Notification({
              title: "NoteFly 正在执行任务",
              body: "有采集或发布操作尚未结束，已推迟退出。可在任务完成后从托盘选择「退出软件」。",
            }).show();
          }
        } catch { /* 忽略 */ }
        state.phase = "running";
        return { ok: false, error: "有任务正在执行，已推迟退出" };
      }
    }
  }

  /* 4. 关闭后台服务（内置 Express 随进程退出即可，但要确认端口释放） */
  try {
    await notifyRendererShutdown();
  } catch { /* 忽略 */ }

  /* 5. 销毁托盘与窗口 */
  destroyTray();
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch { /* 忽略 */ }
  }
  state.mainWindow = null;

  /* 6. 结束进程 */
  try { app.quit(); } catch { /* 忽略 */ }
  return { ok: true };
}

/**
 * 让渲染进程保存未保存内容
 * @returns {Promise<{saved:boolean, note:string}>} 保存是否成功（失败/超时都算不成功）
 */
function notifyRendererSave(reason) {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return Promise.resolve({ saved: true, note: "" });
  return new Promise((resolve) => {
    let done = false;
    const finish = (saved, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMainRemove("notefly:quit-reply", onReply);
      resolve({ saved, note: note || "" });
    };
    const timer = setTimeout(() => {
      /* 超时按「未确认保存成功」处理：退出被推迟（绝不能带着可能没保存的稿子退出） */
      finish(false, "保存确认超时，无法确认稿件已落盘");
    }, 8000);
    const onReply = (_e, payload) => {
      /* 渲染进程回复 saved:false（保存失败/用户取消）时，退出被推迟 */
      finish(!(payload && payload.saved === false), payload && payload.note);
    };
    try {
      win.webContents.send("notefly:before-quit", { reason });
      require("electron").ipcMain.on("notefly:quit-reply", onReply);
    } catch {
      finish(false, "无法通知渲染进程保存");
    }
  });
}

function ipcMainRemove(channel, handler) {
  try { require("electron").ipcMain.removeListener(channel, handler); } catch { /* 忽略 */ }
}

/** 通知渲染进程关闭（用于释放定时器等） */
function notifyRendererShutdown() {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return Promise.resolve();
  try {
    win.webContents.send("notefly:before-shutdown");
  } catch { /* 忽略 */ }
  return Promise.resolve();
}

/**
 * 等待在途任务落定：轮询服务端接口
 * @returns {Promise<boolean>} true = 已落定；false = 超时
 */
function waitForTasksToSettle(timeoutMs) {
  const port = process.env.NOTEFLY_PORT || 3210;
  const deadline = Date.now() + timeoutMs;
  const check = () => new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/progress/tasks?active=1`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve((j.tasks || []).length === 0);
        } catch {
          resolve(true);   /* 读不到就当作没有在途任务 */
        }
      });
    });
    req.on("error", () => resolve(true));
    req.setTimeout(2000, () => { req.destroy(); resolve(true); });
  });
  return (async () => {
    while (Date.now() < deadline) {
      const ok = await check();
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  })();
}

/**
 * 更新重启：允许更新器退出并重新启动。
 * 不再走「隐藏」分支 —— 否则更新器永远等不到进程退出。
 *
 * 与普通退出共用同一套守卫（对应「安装前必须安全退出」）：
 *   1. 渲染进程保存稿件 —— 失败/超时/取消 → 推迟安装，恢复界面；
 *   2. 等待真实在途任务落定（含接入统一进度中心的发布任务）→ 未落定 → 推迟安装；
 *   3. 都满足后才销毁窗口、交给安装器。
 */
async function quitForUpdate(reason) {
  const win = state.mainWindow;

  /* 1. 保存稿件：失败必须推迟安装，绝不能带着未保存内容重启 */
  try { win && !win.isDestroyed() && win.show(); } catch { /* 忽略 */ }
  const r = await notifyRendererSave(reason || "更新重启");
  if (!r.saved) {
    try {
      const { Notification } = require("electron");
      if (Notification && Notification.isSupported()) {
        new Notification({
          title: "更新已推迟：稿件未保存",
          body: r.note || "有稿件没有保存成功，已保留窗口与编辑内容。处理后再更新。",
        }).show();
      }
    } catch { /* 忽略 */ }
    return { ok: false, error: "稿件保存失败，已推迟安装（" + (r.note || "保存未确认") + "）" };
  }

  /* 2. 等待在途任务落定（有超时，不无限等） */
  const settled = await waitForTasksToSettle(15000);
  if (!settled) {
    try {
      const { Notification } = require("electron");
      if (Notification && Notification.isSupported()) {
        new Notification({
          title: "更新已推迟：任务未结束",
          body: "有采集、生成或发布任务尚未结束。任务完成后再更新，避免打断执行。",
        }).show();
      }
    } catch { /* 忽略 */ }
    return { ok: false, error: "有任务正在执行，已推迟安装" };
  }

  /* 3. 守卫全部通过：销毁窗口，交给安装器 */
  state.phase = "updating";
  try { await notifyRendererShutdown(); } catch { /* 忽略 */ }
  destroyTray();
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch { /* 忽略 */ }
  }
  state.mainWindow = null;
  try { app.quit(); } catch { /* 忽略 */ }
  return { ok: true };
}

/* ---------------- 外部服务调用 ---------------- */

/** 调服务端接口（主进程 → 内置 Express） */
function callServer(pathname, method, body, timeoutMs) {
  const port = process.env.NOTEFLY_PORT || 3210;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: method || "GET",
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      timeout: timeoutMs || 15000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ error: data.slice(0, 200) }); }
      });
    });
    req.on("error", (e) => resolve({ error: String((e && e.message) || e) }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "请求超时" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  state,
  createTray,
  destroyTray,
  showMainWindow,
  hideMainWindow,
  notifyHiddenOnce,
  quit,
  quitForUpdate,
  getCloseBehavior,
  setCloseBehavior,
  readSettings,
  writeSettings,
  waitForTasksToSettle,
  callServer,
  trayIconPath,
};
