/*
 * NoteFly Desktop · preload
 * 仅向界面暴露必要能力：
 *   1. 读取内置浏览器（webview）的 cookie —— 渲染进程无法直接访问其他会话的 cookie，
 *      必须经主进程代取；
 *   2. 在系统文件管理器里打开日志目录 —— 日志落在数据目录的 logs/ 下，
 *      用户排查问题时想直接翻原始文件。
 *   3. 生命周期相关：关闭主窗口时的行为、真正退出、托盘事件订阅。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notefly", {
  isElectron: true,
  /** 取某个 webview 所在会话的全部 cookie（用于同步给发布引擎） */
  getCookies: (webContentsId) => ipcRenderer.invoke("notefly:get-cookies", webContentsId),
  /** 在系统文件管理器里打开指定目录 */
  openDir: (dir) => ipcRenderer.invoke("notefly:open-dir", dir),
  /** 读取「关闭主窗口时」的行为（hide | quit） */
  getCloseBehavior: () => ipcRenderer.invoke("notefly:get-close-behavior"),
  /** 设置「关闭主窗口时」的行为 */
  setCloseBehavior: (v) => ipcRenderer.invoke("notefly:set-close-behavior", v),
  /** 请求关闭主窗口（等价于用户点标题栏的 ×，走主进程的 close 事件） */
  closeWindow: () => ipcRenderer.invoke("notefly:close-window"),
  /** 真正退出应用（保存并清理资源后结束进程） */
  quit: () => ipcRenderer.invoke("notefly:quit"),
  /** 查询系统托盘状态（是否建成、失败原因） */
  trayStatus: () => ipcRenderer.invoke("notefly:tray-status"),
  /** 触发一次更新检查 */
  checkUpdate: () => ipcRenderer.invoke("notefly:check-update"),
  /** 用系统浏览器打开外部链接（只允许 http/https） */
  openExternal: (url) => ipcRenderer.invoke("notefly:open-external", url),
  /** 订阅托盘/主进程事件 */
  on: (channel, cb) => {
    const allowed = ["notefly:new-content", "notefly:update-checked", "notefly:tray-error", "notefly:before-quit", "notefly:before-shutdown"];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /** 退出前保存结果回报给主进程 */
  replyQuit: (saved, note) => ipcRenderer.send("notefly:quit-reply", { saved, note }),
});
