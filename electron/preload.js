/*
 * NoteFly Desktop · preload
 * 仅向界面暴露必要能力：
 *   1. 读取内置浏览器（webview）的 cookie —— 渲染进程无法直接访问其他会话的 cookie，
 *      必须经主进程代取；
 *   2. 在系统文件管理器里打开日志目录 —— 日志落在数据目录的 logs/ 下，
 *      用户排查问题时想直接翻原始文件。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notefly", {
  isElectron: true,
  /** 取某个 webview 所在会话的全部 cookie（用于同步给发布引擎） */
  getCookies: (webContentsId) => ipcRenderer.invoke("notefly:get-cookies", webContentsId),
  /** 在系统文件管理器里打开指定目录 */
  openDir: (dir) => ipcRenderer.invoke("notefly:open-dir", dir),
});
