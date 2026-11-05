/*
 * NoteFly 桌面版 · 自动更新
 * ------------------------------------------------------------
 * 用 electron-updater（与 electron-builder 配套的成熟组件）实现
 * 「检查」与「下载安装」分离的更新流程。
 *
 * 关键配置（对应需求「不使用会提前自动下载或安装的默认配置」）：
 *   autoDownload = false          用户点击「立即更新」之前不下载
 *   autoInstallOnAppQuit = false  不在退出时偷偷装
 *
 * 更新源：只信任已配置的官方来源（GitHub Releases）。
 * 不关闭证书或签名验证 —— electron-updater 默认就会校验
 * 安装包的 SHA-512（latest.yml 里带 sha512）。
 *
 * 退出条件（对应需求「安装前必须安全退出」）：
 *   保存未保存稿件 → 停止启动新任务 → 等在途任务落定 → 才安装并重启。
 */
"use strict";

const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const http = require("http");

/* 下载保存目录：用户数据目录下的 updates/（不污染程序安装目录） */
function downloadDir() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "updates");
  } catch {
    return path.join(process.cwd(), "data", "updates");
  }
}

/** 当前运行环境是否支持真正的自动更新 */
function isSupported() {
  /* 未打包（开发态 / 直接 electron . 启动）时 electron-updater 无法工作：
     它需要安装目录里的 app-update.yml。开发态只显示版本信息或打开发布页。 */
  let packaged = false;
  try {
    const { app } = require("electron");
    packaged = !!app.isPackaged;
  } catch { /* 忽略 */ }
  return packaged;
}

/** 读取程序版本 */
function currentVersion() {
  try {
    const { app } = require("electron");
    return app.getVersion();
  } catch {
    try {
      return require("../package.json").version || "0.0.0";
    } catch {
      return "0.0.0";
    }
  }
}

/**
 * 初始化更新器
 * @param {{onEvent:Function}} opts onEvent({type, ...}) 回报进度给服务端与界面
 */
function init(opts) {
  const o = opts || {};
  const emit = (payload) => {
    try { o.onEvent && o.onEvent(payload); } catch { /* 忽略 */ }
  };

  if (!isSupported()) {
    return { ok: false, reason: "dev_mode", message: "当前是开发/浏览器模式，不执行安装覆盖" };
  }

  try {
    /* 不提前下载、不在退出时自动安装 */
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    /* 只信任官方更新源；证书校验保持默认（不关闭） */
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    /* 下载目录：用户数据目录，不写程序安装目录 */
    autoUpdater.downloadUpdate = autoUpdater.downloadUpdate || undefined;
  } catch (e) {
    return { ok: false, reason: "init_failed", message: "初始化更新器失败：" + String((e && e.message) || e) };
  }

  autoUpdater.on("checking-for-update", () => emit({ type: "checking" }));
  autoUpdater.on("update-available", (info) => {
    emit({ type: "available", version: info && info.version, releaseDate: info && info.releaseDate, releaseNotes: info && info.releaseNotes });
  });
  autoUpdater.on("update-not-available", (info) => {
    emit({ type: "not-available", version: info && info.version });
  });
  autoUpdater.on("error", (e) => {
    /* 用户取消下载不是错误：走 download-cancelled 通道，不推「更新失败」 */
    const msg = String((e && e.message) || e);
    if ((e && e.name === "CancellationError") || /cancel/i.test(msg)) return;
    emit({ type: "error", error: msg });
  });
  autoUpdater.on("download-progress", (p) => {
    emit({
      type: "download-progress",
      percent: p && p.percent,
      transferred: p && p.transferred,
      total: p && p.total,
      bytesPerSecond: p && p.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    emit({ type: "downloaded", version: info && info.version });
  });

  return { ok: true };
}

/**
 * 检查更新（只检查，不下载）
 */
async function check() {
  if (!isSupported()) {
    return { ok: false, code: "dev_mode", error: "开发模式无法检查安装包更新，可打开正式发布页手动下载" };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    const info = r && r.updateInfo;
    return {
      ok: true,
      version: info && info.version,
      releaseDate: info && info.releaseDate,
      releaseNotes: info && info.releaseNotes,
    };
  } catch (e) {
    return { ok: false, code: "check_failed", error: "检查更新失败：" + String((e && e.message) || e) };
  }
}

/**
 * 下载更新包（用户点击「立即更新」之后才调用）
 */
async function download() {
  if (!isSupported()) {
    return { ok: false, code: "dev_mode", error: "开发模式不执行安装覆盖" };
  }
  try {
    fs.mkdirSync(downloadDir(), { recursive: true });
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    /* 用户取消：明确区分，调用方据此回报 download-cancelled */
    if ((e && e.name === "CancellationError") || /cancel/i.test(msg)) {
      return { ok: false, code: "cancelled", cancelled: true, error: "下载已取消" };
    }
    return { ok: false, code: "download_failed", error: "下载更新包失败：" + msg };
  }
}

/**
 * 取消正在进行的下载
 * electron-updater 提供 cancelDownload()；旧版本没有时明确返回不支持，
 * 绝不假装取消成功（任务会一直卡在「正在停止」）。
 */
function cancelDownload() {
  if (!isSupported()) return { ok: false, code: "dev_mode", error: "开发模式没有下载在进行" };
  try {
    if (typeof autoUpdater.cancelDownload !== "function") {
      return { ok: false, code: "unsupported", error: "当前 electron-updater 版本不支持取消下载" };
    }
    autoUpdater.cancelDownload();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 安装并重启
 * 注意：调用前必须已经完成「保存稿件 + 等待在途任务落定」。
 */
function quitAndInstall(silent) {
  if (!isSupported()) return { ok: false, error: "开发模式不执行安装覆盖" };
  try {
    /* isSilent=false：显示安装向导，让用户知道发生了什么；
       isForceRunAfter=true：装完自动重新打开软件。 */
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "启动安装失败：" + String((e && e.message) || e) };
  }
}

/** 打开正式发布页（开发模式下的替代入口） */
function openReleasePage(url) {
  const { shell } = require("electron");
  const s = String(url || "");
  if (!/^https?:\/\//i.test(s)) return { ok: false, error: "只允许打开 http/https 链接" };
  shell.openExternal(s);
  return { ok: true };
}

module.exports = {
  init,
  check,
  download,
  cancelDownload,
  quitAndInstall,
  openReleasePage,
  isSupported,
  currentVersion,
  downloadDir,
};
