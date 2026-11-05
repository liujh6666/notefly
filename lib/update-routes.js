/*
 * NoteFly 更新路由
 * ------------------------------------------------------------
 *   GET  /api/update/state           当前更新状态（上次检查时间、结果、跳过版本）
 *   POST /api/update/check           检查更新（手动）
 *   GET  /api/update/history         版本历史（时间轴）
 *   POST /api/update/skip            跳过某版本
 *   POST /api/update/download        请求下载（由桌面版执行）
 *   POST /api/update/install         安装并重启（由桌面版执行）
 *
 * 浏览器模式与开发模式不执行安装覆盖 —— 只显示版本信息或打开正式发布页。
 */
"use strict";

const updater = require("./updater");
const taskProgress = require("./task-progress");
const messages = require("./messages");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");

/* 状态文件：<数据目录>/update-state.json */
function stateFile() {
  try {
    const dataDir = require("./data-dir");
    return path.join(dataDir.get(), "update-state.json");
  } catch {
    return path.join(process.cwd(), "data", "update-state.json");
  }
}

function defaultState() {
  return {
    /* 上次检查时间 */
    lastCheckedAt: "",
    /* 上次检查结果：idle | up_to_date | available | failed */
    lastResult: "idle",
    lastError: "",
    lastVersion: "",
    /* 用户跳过的版本（只影响自动提醒，手动检查仍能看到） */
    skippedVersion: "",
    /* 本机安装成功记录：只有重启进入新版本后才写 */
    installedVersion: "",
    installedAt: "",
    /* 上一次安装成功的版本（用于区分「版本发布时间」与「本机安装完成时间」） */
    installHistory: [],
  };
}

let state = defaultState();

function loadState() {
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    const j = JSON.parse(raw);
    state = Object.assign(defaultState(), j);
  } catch {
    state = defaultState();
  }
  return state;
}

function saveState() {
  try {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    logger.warn("软件更新", "更新状态落盘失败：" + String((e && e.message) || e));
  }
}

/** 启动时判断：如果当前版本比记录里「已安装版本」新，说明是更新后重启 */
function detectFreshInstall(currentVersion) {
  if (!state.installedVersion) {
    /* 首次运行：记录当前版本作为「本机安装完成时间」 */
    state.installedVersion = currentVersion;
    state.installedAt = new Date().toISOString();
    state.installHistory = [{ version: currentVersion, at: state.installedAt }];
    saveState();
    return { fresh: true, firstRun: true };
  }
  if (updater.compareSemver(currentVersion, state.installedVersion) > 0) {
    state.installedVersion = currentVersion;
    state.installedAt = new Date().toISOString();
    state.installHistory.unshift({ version: currentVersion, at: state.installedAt });
    if (state.installHistory.length > 50) state.installHistory.length = 50;
    saveState();
    return { fresh: true, firstRun: false };
  }
  return { fresh: false, firstRun: false };
}

/* 供主进程回报进度（Electron 主进程通过 notefly:update-progress IPC 调用） */
const controller = {
  /** 主进程回报更新状态变化 */
  reportProgress(patch) {
    Object.assign(state, patch || {});
    saveState();
    return state;
  },
  getState() {
    return state;
  },
  /** 主进程通知「已进入新版本」 */
  recordInstalled(version) {
    state.installedVersion = version;
    state.installedAt = new Date().toISOString();
    state.installHistory.unshift({ version, at: state.installedAt });
    if (state.installHistory.length > 50) state.installHistory.length = 50;
    saveState();
    return state;
  },
  /** 主进程通知「下载完成」 */
  recordDownloaded(info) {
    Object.assign(state, { lastDownload: info || {}, downloadedAt: new Date().toISOString() });
    saveState();
    return state;
  },
};

function registerUpdateRoutes(app, ctx) {
  const getConfig = ctx.getConfig;
  const saveConfig = ctx.saveConfig;
  const getVersion = ctx.getVersion || (() => "0.0.0");
  const isDesktop = ctx.isDesktop || (() => false);

  loadState();

  /* 桌面版启动后：记录本机安装完成时间 */
  detectFreshInstall(getVersion());

  /** 取当前仓库配置 */
  function repoInfo() {
    const c = getConfig() || {};
    const repo = updater.resolveRepo({ getConfig: () => c });
    return { repo, configured: !!repo };
  }

  /** 执行一次检查 */
  async function runCheck(opts) {
    const o = opts || {};
    const { repo, configured } = repoInfo();
    if (!configured) {
      const err = "没有配置更新仓库地址。请到「设置 → 更新」填写 GitHub 仓库（格式：owner/repo）。";
      state.lastCheckedAt = new Date().toISOString();
      state.lastResult = "failed";
      state.lastError = err;
      saveState();
      return { ok: false, error: err, code: "no_repo" };
    }
    const c = getConfig() || {};
    const allowPrerelease = !!(c.update && c.update.allowPrerelease);
    const r = await updater.check({
      repo,
      currentVersion: getVersion(),
      allowPrerelease,
      timeoutMs: o.timeoutMs,
    });

    state.lastCheckedAt = new Date().toISOString();
    if (!r.ok) {
      state.lastResult = "failed";
      state.lastError = r.error || "检查失败";
      state.lastVersion = "";
      saveState();
      logger.warn("软件更新", `检查更新失败：${r.error}`, { 仓库: `${repo.owner}/${repo.repo}` });
      return r;
    }
    state.lastResult = "available";
    state.lastError = "";
    state.lastVersion = r.version;
    saveState();
    logger.info("软件更新", `发现新版本 v${r.version}（当前 v${getVersion()}）`, {
      仓库: `${repo.owner}/${repo.repo}`,
      有安装包: r.hasInstallablePackage,
    });
    return r;
  }

  /* ---------------- 状态 ---------------- */

  app.get("/api/update/state", (req, res) => {
    const { repo, configured } = repoInfo();
    const c = getConfig() || {};
    res.json({
      ok: true,
      currentVersion: getVersion(),
      repo: repo ? { owner: repo.owner, repo: repo.repo, source: repo.source } : null,
      repoConfigured: configured,
      allowPrerelease: !!(c.update && c.update.allowPrerelease),
      lastCheckedAt: state.lastCheckedAt,
      lastResult: state.lastResult,
      lastError: state.lastError,
      lastVersion: state.lastVersion,
      skippedVersion: state.skippedVersion,
      installedVersion: state.installedVersion,
      installedAt: state.installedAt,
      installHistory: state.installHistory || [],
      desktop: isDesktop(),
      target: updater.currentTarget(),
    });
  });

  /* ---------------- 检查 ---------------- */

  app.post("/api/update/check", async (req, res) => {
    const body = req.body || {};
    const manual = body.manual !== false;
    const task = taskProgress.create({
      type: "update",
      title: "检查更新",
      total: null,
      stage: "checking",
      stageNote: "正在检查 GitHub Releases…",
      cancellable: false,
      route: "settings",
    });
    const r = await runCheck({ timeoutMs: body.timeoutMs });

    if (!r.ok) {
      taskProgress.fail(task.id, r.error || "检查失败");
      /* 检查失败也要给消息：但不要每次自动检查都刷屏 —— 只在手动检查时推 */
      if (manual) {
        messages.push({
          eventId: `update:check-failed:${state.lastCheckedAt}`,
          type: messages.TYPE.UPDATE,
          level: messages.LEVEL.ERROR,
          title: "检查更新失败",
          summary: r.error || "检查失败",
          action: { label: "重试检查", kind: "invoke", payload: { path: "/api/update/check", method: "POST" } },
        });
      }
      return res.status(200).json(Object.assign({}, r, { taskId: task.id }));
    }

    if (r.upToDate) {
      taskProgress.succeed(task.id, { upToDate: true });
      if (manual) {
        messages.push({
          eventId: `update:uptodate:${state.lastCheckedAt}`,
          type: messages.TYPE.UPDATE,
          level: messages.LEVEL.INFO,
          title: "当前已是最新版本",
          summary: `当前版本 v${getVersion()}，未发现更新的正式版本。`,
        });
      }
      return res.json(Object.assign({}, r, { taskId: task.id }));
    }

    taskProgress.succeed(task.id, { version: r.version });

    /* 发现新版本：推一条消息（自动检查时也推，但用稳定 eventId 去重） */
    messages.push({
      eventId: `update:available:${r.version}`,
      type: messages.TYPE.UPDATE,
      level: messages.LEVEL.INFO,
      title: `发现新版本 v${r.version}`,
      summary: `当前 v${getVersion()} → 新版本 v${r.version}` +
        (r.asset ? `，安装包 ${r.asset.name}（${formatSize(r.asset.size)}）` : "") +
        (r.assetError ? `。${r.assetError}` : ""),
      action: { label: "查看更新", kind: "update", payload: { version: r.version } },
      meta: { version: r.version, currentVersion: getVersion(), asset: r.asset || null },
    });

    res.json(Object.assign({}, r, { taskId: task.id }));
  });

  /* ---------------- 版本历史（时间轴） ---------------- */

  app.get("/api/update/history", async (req, res) => {
    const q = req.query || {};
    const { repo, configured } = repoInfo();
    if (!configured) {
      return res.json({ ok: false, error: "没有配置更新仓库地址", items: [], cached: true });
    }
    const r = await updater.history({
      repo,
      page: Number(q.page) || 1,
      perPage: Number(q.perPage) || 20,
    });
    if (!r.ok) {
      /* 离线/失败 → 返回缓存（缓存里的历史照样要如实展示，不能编造） */
      const cached = state.cachedHistory || [];
      return res.json({
        ok: false,
        error: r.error || "获取版本历史失败",
        items: cached,
        cached: true,
        cachedAt: state.cachedHistoryAt || "",
      });
    }
    /* 缓存第一页，供离线时展示 */
    if (r.page === 1) {
      state.cachedHistory = r.items;
      state.cachedHistoryAt = new Date().toISOString();
      saveState();
    }
    res.json({
      ok: true,
      items: r.items,
      page: r.page,
      perPage: r.perPage,
      hasMore: r.hasMore,
      currentVersion: getVersion(),
      installedVersion: state.installedVersion,
      installedAt: state.installedAt,
    });
  });

  /* ---------------- 跳过某版本 ---------------- */

  app.post("/api/update/skip", (req, res) => {
    const version = String((req.body && req.body.version) || "").trim();
    if (!version) return res.status(400).json({ error: "缺少版本号" });
    state.skippedVersion = version;
    saveState();
    logger.info("软件更新", `用户跳过版本 v${version}`);
    res.json({ ok: true, skippedVersion: version });
  });

  /* ---------------- 下载 / 安装 ----------------
     桌面版由主进程执行；浏览器模式明确拒绝，不做假动作。 */

  app.post("/api/update/download", (req, res) => {
    if (!isDesktop()) {
      return res.status(400).json({
        error: "当前运行形态（浏览器版 / 未打包的开发态）不能自动下载安装包。已为你打开正式发布页，可手动下载；自动更新需使用安装版 NoteFly。",
        releaseUrl: (req.body && req.body.releaseUrl) || "",
      });
    }
    const bridge = typeof ctx.updateBridge === "function" ? ctx.updateBridge() : null;
    if (!bridge || typeof bridge.download !== "function") {
      return res.status(500).json({ error: "桌面版更新桥未就绪，请重启 NoteFly 后重试。" });
    }
    /* 桥的 download 是异步的（内含一次网络检查），不能拖住 HTTP 响应：
       先建任务立即返回，进度由主进程经 /api/update/progress 推送更新；
       启动失败则把任务标失败。 */
    const task = taskProgress.create({
      type: "update",
      title: "下载更新包",
      total: null,
      stage: "downloading",
      stageNote: "准备下载…",
      cancellable: true,
      route: "settings",
    });
    Promise.resolve()
      .then(() => bridge.download())
      .then((r) => {
        if (!r || !r.ok) taskProgress.fail(task.id, (r && r.error) || "启动下载失败");
        /* 成功路径不在这里收尾 —— 后续 download-progress / downloaded 事件接管 */
      })
      .catch((e) => taskProgress.fail(task.id, "启动下载失败：" + String((e && e.message) || e)));
    res.json({ ok: true, taskId: task.id });
  });

  app.post("/api/update/install", (req, res) => {
    if (!isDesktop()) {
      return res.status(400).json({ error: "浏览器模式不能执行安装。" });
    }
    const bridge = typeof ctx.updateBridge === "function" ? ctx.updateBridge() : null;
    if (!bridge || typeof bridge.install !== "function") {
      return res.status(500).json({ error: "桌面版更新桥未就绪，请重启 NoteFly 后重试。" });
    }
    const task = taskProgress.create({
      type: "update",
      title: "安装更新并重启",
      total: null,
      stage: "preparing",
      stageNote: "保存稿件并等待在途任务落定…",
      cancellable: false,
      route: "settings",
    });
    Promise.resolve()
      .then(() => bridge.install())
      .then((r) => {
        if (!r || !r.ok) taskProgress.fail(task.id, (r && r.error) || "启动安装失败");
        /* 成功 → quitAndInstall 会退出应用，任务状态无所谓了 */
      })
      .catch((e) => taskProgress.fail(task.id, "启动安装失败：" + String((e && e.message) || e)));
    res.json({ ok: true, taskId: task.id });
  });

  /* 主进程回报下载/安装进度（electron/updater.js 通过 HTTP 调用） */
  app.post("/api/update/progress", (req, res) => {
    const evt = req.body || {};
    const type = String(evt.type || "");

    /* 下载进度：更新「进行中」列表里的任务 */
    if (type === "download-progress") {
      const total = Number(evt.total) || 0;
      const transferred = Number(evt.transferred) || 0;
      const percent = Math.max(0, Math.min(100, Math.round(Number(evt.percent) || 0)));
      let t = taskProgress.list({ type: "update", active: true })[0];
      if (!t) {
        t = taskProgress.create({
          type: "update",
          title: "下载更新包",
          total: total || null,
          stage: "downloading",
          stageNote: "正在下载…",
          cancellable: true,
          route: "settings",
        });
      }
      const done = total ? Math.floor((transferred / total) * 100) : null;
      taskProgress.update(t.id, {
        completed: done === null ? 0 : done,
        total: total || null,
        stage: "downloading",
        stageNote: total
          ? `已下载 ${(transferred / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB`
          : "正在下载…",
      });
      return res.json({ ok: true, taskId: t.id });
    }

    if (type === "downloaded") {
      let t = taskProgress.list({ type: "update", active: true })[0];
      if (t) {
        taskProgress.succeed(t.id, { version: evt.version || "" });
      }
      controller.reportProgress({ lastDownload: { version: evt.version || "", at: new Date().toISOString() } });
      messages.push({
        eventId: `update:downloaded:${evt.version || ""}`,
        type: messages.TYPE.UPDATE,
        level: messages.LEVEL.SUCCESS,
        title: `更新包已下载完成（v${evt.version || "新版本"}）`,
        summary: "可以点击「立即更新」完成安装，安装后软件会自动重新打开。",
        action: { label: "立即更新", kind: "update", payload: { version: evt.version || "" } },
      });
      return res.json({ ok: true });
    }

    if (type === "error") {
      let t = taskProgress.list({ type: "update", active: true })[0];
      if (t) taskProgress.fail(t.id, evt.error || "更新失败");
      messages.push({
        eventId: `update:error:${Date.now()}`,
        type: messages.TYPE.UPDATE,
        level: messages.LEVEL.ERROR,
        title: "更新失败",
        summary: String(evt.error || "未知错误"),
        action: { label: "重新检查", kind: "invoke", payload: { path: "/api/update/check", method: "POST" } },
      });
      return res.json({ ok: true });
    }

    if (type === "available") {
      messages.push({
        eventId: `update:available:${evt.version || ""}`,
        type: messages.TYPE.UPDATE,
        level: messages.LEVEL.INFO,
        title: `发现新版本 v${evt.version || ""}`,
        summary: "点击可在消息中心继续更新。",
        action: { label: "查看更新", kind: "update", payload: { version: evt.version || "" } },
      });
      return res.json({ ok: true });
    }

    res.json({ ok: true });
  });

/* 桌面版主进程通过 HTTP 回传进度时用（见 electron/main.js） */
  app.locals_updateProgress = controller.reportProgress;
  app.locals_getUpdateState = controller.getState;
}

/** 字节数 → 可读大小 */
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "未知大小";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

module.exports = { registerUpdateRoutes, controller, formatSize, loadState, saveState, defaultState };
