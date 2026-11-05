/*
 * Dispatch Hub —— NoteFly 多平台分发工作台（本地版）
 * 后端：Express，静态前端 + 本地 JSON 存储 + 内置 RPA 发布引擎调度
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const rpa = require("./engines/rpa");
const taskStatus = require("./lib/task-status");
const aiRoutes = require("./lib/ai-routes");
const gzhRoutes = require("./lib/gzh-routes");
const dataDir = require("./lib/data-dir");
const logger = require("./lib/logger");
const logHttp = require("./lib/log-http");
const logRoutes = require("./lib/log-routes");
const taskProgress = require("./lib/task-progress");
const messages = require("./lib/messages");
const progressRoutes = require("./lib/progress-routes");
const library = require("./lib/content-library");
const libraryRoutes = require("./lib/library-routes");
const updateRoutes = require("./lib/update-routes");

const PORT = process.env.PORT || 3210;
/* 应用版本：与 package.json 保持一致（发布时同步） */
const APP_VERSION = (() => {
  try {
    return require("./package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
/* 登录态快照的有效期：超过就降级成「待复核」。
   巡检结果是某一时刻的事实，不该永久当成现状展示。 */
const ACCOUNT_STALE_MS = 12 * 60 * 60 * 1000;
/* 登录判定规则版本：判据改过之后，旧规则得出的结论不再可信。
   巡检结果里带版本号，对不上的直接退回「待检查」，让用户重新确认一次。
   （v1 = 只看有没有头像元素，会把游客占位误判成已登录） */
const LOGIN_JUDGE_VERSION = 2;
/* 数据目录：可用设置页切换（指针写在 ~/.notefly/location.json，与 data/ 无关）。
   解析优先级：NOTEFLY_DATA_DIR 环境变量 > 指针文件 > 应用内 data/。
   所有路径都做成「每次调用时求值」，否则运行时切换目录会写到旧位置。 */
dataDir.init();

/* ---------------- 运行日志 ----------------
   所有「操作」与「报错」都落盘，用户在设置页「关于」里点版本号 5 下即可查看。
   日志目录跟随数据目录（<data>/logs/），换目录时一起搬走。 */
logger.init();
logger.info("服务", "NoteFly 服务启动", { 端口: PORT, 数据目录: dataDir.get(), 平台数: (() => { try { return rpa.listPlatforms().length; } catch { return 0; } })() });

/* 未捕获异常与 Promise 拒绝：必须留痕，否则崩溃现场就没了。
   只记录不退出 —— 交由 Node 默认行为处理进程生命周期。 */
process.on("uncaughtException", (e) => {
  logger.fatal("异常", "未捕获异常：" + String((e && e.message) || e), { 堆栈: e && e.stack ? String(e.stack).slice(0, 2000) : "" });
});
process.on("unhandledRejection", (e) => {
  logger.fatal("异常", "未处理的 Promise 拒绝：" + String((e && e.message) || e), { 堆栈: e && e.stack ? String(e.stack).slice(0, 2000) : "" });
});

/* 数据目录切换后，这些模块的内存态必须重载，否则会出现「指针指向新目录、
   内存还是旧数据」的错位（内容库与任务记录尤其明显）。 */
function reloadDataModules() {
  try { taskProgress.init(); } catch { /* 忽略 */ }
  try { messages.init(); } catch { /* 忽略 */ }
  try { library.init(); } catch { /* 忽略 */ }
  /* 当前企业在新目录里可能不存在了 */
  if (currentCompanyId && !library.getCompany(currentCompanyId)) {
    currentCompanyId = "";
    config.currentCompanyId = "";
  }
}

/* ---------------- 存储层 ----------------
 * 三条硬规则：
 *  1. 写入先落临时文件再 rename —— 断电/崩溃不会留下半个 JSON；
 *  2. 覆盖前把上一份存成 .bak —— 内容写坏了还能退回去；
 *  3. 解析失败不静默当空数据：把损坏文件另存 .corrupt-<时间>，并向上报告。
 */
const dataWarnings = [];
function backupCorrupt(file, err) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.corrupt-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
    dataWarnings.push({
      file: path.basename(file),
      message: `数据文件无法解析（${err && err.message ? err.message.slice(0, 120) : "未知错误"}），已另存为 ${path.basename(dest)}，当前使用空数据启动`,
      backup: dest,
      at: new Date().toISOString(),
    });
    console.warn("[存储] " + dest + " 已保留损坏副本");
  } catch (e) {
    dataWarnings.push({ file: path.basename(file), message: "数据文件损坏且备份失败：" + e.message, at: new Date().toISOString() });
  }
}

function loadJSON(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") {
      dataWarnings.push({ file: path.basename(file), message: "读取失败：" + e.message, at: new Date().toISOString() });
    }
    return fallback; // 首次运行没有文件，正常
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    backupCorrupt(file, e);
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  /* 保留上一版，便于人工回退 */
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch (e) {
    console.warn("[存储] 备份失败:", e.message);
  }
  fs.renameSync(tmp, file);
}

/* 配置与内容库的默认值。目录切换后会重新从新目录读取，并补齐缺失的键。 */
function defaultConfig() {
  return {
    engine: "rpa",
    /* 更新设置：仓库地址优先读这里的 update.repo，其次读 package.json */
    update: { repo: "", allowPrerelease: false },
  };
}
function defaultStore() {
  return {
    contents: [],   // 内容库 {id,type,title,body,cover,images,tags,video,audio,createdAt}
    tasks: [],      // 发布任务 {id,groupId,accountIds,platforms,contentId,snapshot,scheduledAt,status,createdAt,history:[]}
    accountMeta: {},// accountId -> {alias, group}
  };
}
/* 补齐缺失的顶层键：老数据文件/手工编辑过的文件可能缺字段，缺了就补，绝不能崩 */
function normalizeStore(s) {
  s.contents = Array.isArray(s.contents) ? s.contents : [];
  s.tasks = Array.isArray(s.tasks) ? s.tasks : [];
  s.accountMeta = s.accountMeta && typeof s.accountMeta === "object" && !Array.isArray(s.accountMeta) ? s.accountMeta : {};
  return s;
}
function normalizeConfig(c) {
  c.keepalive = c.keepalive || { enabled: false, intervalHours: 4 };
  /* AI 模型配置（Key 存在本地 config.json，绝不回传前端） */
  c.ai = c.ai || aiRoutes.defaultAiConfig();
  c.kaState = c.kaState || { lastRun: null, lastOnline: 0, lastTotal: 0, details: [], nextRun: null };
  /* 更新设置：仓库地址与预发布开关 */
  c.update = c.update && typeof c.update === "object" ? c.update : { repo: "", allowPrerelease: false };
  if (typeof c.update.repo !== "string") c.update.repo = "";
  c.update.allowPrerelease = !!c.update.allowPrerelease;
  /* 引擎已收敛为单一 RPA：老配置里的 multipost 一律归一，避免走到已下线的分支 */
  c.engine = "rpa";
  return c;
}

let config = normalizeConfig(loadJSON(dataDir.configFile(), defaultConfig()));
let store = normalizeStore(loadJSON(dataDir.storeFile(), defaultStore()));

/* 写入路径每次求值：目录切换后必须写到新位置 */
const saveStore = () => saveJSON(dataDir.storeFile(), store);
const saveConfig = () => saveJSON(dataDir.configFile(), config);

/* ---------------- 当前选中的企业内容库 ----------------
 * 新建内容时「当前用哪个企业的资料」必须是显式的、用户能看见的。
 * 这里保存当前选择（写进 config，跨重启保持），所有 AI 写作请求都带上它。
 * 没选企业时为 null —— 此时写作明确按通用风格，不暗用任何企业资料。 */
let currentCompanyId = config.currentCompanyId || "";
function setCurrentCompany(id) {
  const c = library.getCompany(id);
  currentCompanyId = c ? c.id : "";
  config.currentCompanyId = currentCompanyId;
  try { saveConfig(); } catch { /* 落盘失败不影响本次会话 */ }
  return currentCompanyId;
}

/* ---------------- 任务进度 / 消息中心 / 内容库 ----------------
 * 启动时初始化：
 *  - 任务记录：把上次进程「正在跑」的任务标成已中断（不能显示成还在转圈）
 *  - 消息中心：加载已读状态与未读数
 *  - 内容库：加载企业与文章
 */
taskProgress.init();
messages.init();
library.init();

/* RPA 执行队列（内存）：同一时刻只执行一个发布任务，避免多任务争抢同一批浏览器页面。
   声明提前到此处：启动恢复逻辑在模块前部就要用它。 */
const publishQueue = { pending: [], running: false };

/* 启动恢复：执行队列在内存里，重启会丢。
 * 必须在「状态迁移」之前跑：迁移会把 running 重算成别的状态，
 * 那时再判断“是否执行到一半”就失真了。
 *  - queued 且从未执行（无 startedAt、无目标）→ 重新入队继续跑
 *  - queued/running/creating 且执行到一半（有 startedAt）→ 不能盲目重发：
 *    已提交/受理的目标保持原状等核验；没有目标记录的按新规则归并（unknown 优先） */
(function restoreInterruptedTasks() {
  /* 恢复必须始终执行（它决定有没有任务被漏掉）；
     只有显式设置 NOTEFLY_DISABLE_RESTORE=1 才跳过（测试可用） */
  if (process.env.NOTEFLY_DISABLE_RESTORE === "1") return;
  let requeued = 0, pendingVerify = 0;
  for (const t of store.tasks || []) {
    if (!t || !["queued", "running", "creating", "publishing"].includes(t.status)) continue;
    const targets = (t.lastStatus && t.lastStatus.targets) || [];
    const executed = !!t.startedAt || targets.some((x) => x && x.status && x.status !== "pending");
    if (t.status === "queued" && !executed) {
      /* 从未执行：安全重新入队 */
      t.history = t.history || [];
      t.history.push({ at: new Date().toISOString(), event: "requeued_after_restart", detail: "服务重启，任务重新进入执行队列" });
      enqueuePublish(t.id);
      requeued++;
    } else {
      /* 执行到一半中断：提交中的目标结果不确定 → 标 unknown 等人工核验，绝不重发 */
      for (const tg of targets) {
        if (tg && tg.status === "submitting") {
          tg.status = "unknown";
          tg.error = "服务重启导致提交中断，请到平台后台核验是否已发布，确认未发布再重试";
        }
      }
      if (!targets.length) {
        t.status = "unknown";
        t.statusReason = "服务重启时任务执行中断且无目标记录，请人工核验平台后台后处理";
      } else {
        taskStatus.syncTask(t, { silent: true });
        t.statusReason = t.statusReason || "服务重启时执行中断，已按目标状态重算";
      }
      t.history = t.history || [];
      t.history.push({ at: new Date().toISOString(), event: "interrupted_by_restart", detail: "执行中断，已按保守规则处理（不自动重发）" });
      pendingVerify++;
    }
  }
  if (requeued || pendingVerify) {
    try {
      saveStore();
      console.log(`[恢复] 重新入队 ${requeued} 个未执行任务；${pendingVerify} 个中断任务转人工核验（不重发）`);
    } catch (e) {
      console.warn("[恢复] 状态回写失败:", e.message);
    }
  }
})();

/* 启动迁移：按当前规则重算历史任务的派生状态（只动 status/error/finishedAt，不改内容与快照） */
(function migrateTaskStatuses() {
  let changed = 0;
  for (const t of store.tasks || []) {
    if (!t) continue;
    const targets = t.lastStatus && Array.isArray(t.lastStatus.targets) ? t.lastStatus.targets : [];
    if (!targets.length) {
      /* 老版本停在 publishing 的任务没有任何目标记录，结果无法确认：
         不能永远显示“进行中”骗轮询，也不能假装完成，标成待核验让人工处理 */
      if (t.status === "publishing" || t.status === "running") {
        t.status = "unknown";
        t.statusReason = "历史任务：执行结果未记录，请打开任务详情核验";
        changed++;
      }
      continue;
    }
    const before = t.status;
    taskStatus.syncTask(t, { silent: true });
    if (t.status !== before) changed++;
  }
  if (changed) {
    try {
      saveStore();
      console.log(`[迁移] 已按统一规则重算 ${changed} 个历史任务状态`);
    } catch (e) {
      console.warn("[迁移] 状态回写失败:", e.message);
    }
  }
})();

/* ---------------- 定时调度器 ---------------- */
/* 把 RPA 填充结果写回任务。
 * 状态一律交给 lib/task-status 归并：一成功一失败必须是“部分成功”，
 * 只要存在未知结果就不能算完成。 */
function applyRpaResult(task, result) {
  if (result && result.groupId) task.groupId = result.groupId;
  task.lastStatus = { targets: (result && result.targets) || [], updatedAt: new Date().toISOString() };
  const sum = taskStatus.syncTask(task);           // 内部会重算 status / error / finishedAt
  task.history = task.history || [];
  task.history.push({
    at: new Date().toISOString(),
    event: `rpa_result_${sum.status}`,
    detail: sum.reason || "",
  });
  saveStore();
  /* 执行结果必须留痕：哪些平台成了、哪些没成，一目了然 */
  const targets = (task.lastStatus && task.lastStatus.targets) || [];
  const okList = targets.filter((t) => t && t.status === "success").map((t) => t.platform);
  const failList = targets.filter((t) => t && (t.status === "failed" || t.status === "unknown")).map((t) => `${t.platform}(${t.status})`);
  const line = `任务「${task.title}」执行结果：${sum.status}${sum.reason ? " · " + sum.reason : ""}`;
  const detail = { 成功平台: okList, 异常平台: failList, 任务号: task.id };
  if (sum.status === "done") logger.info("发布任务", line, detail);
  else if (sum.status === "failed") logger.error("发布任务", line, detail);
  else logger.warn("发布任务", line, detail);
  return task;
}

/* 对外输出的任务对象：去掉 snapshot 大字段，避免每个响应都拖着全文快照 */
function publicTask(task) {
  if (!task) return null;
  const { snapshot, ...rest } = task;
  return rest;
}

async function startTask(task) {
  /* 引擎已收敛为单一 RPA：不再有分支，任务一律走内置发布引擎 */
  task.engine = "rpa";
  /* 能力预检（服务端执行，不依赖前端）：自动提交必须逐平台验证过才放行。
     未验证的平台即使选了「立即发布」也会停在草稿待确认，这里提前告知用户。 */
  try {
    const caps = rpa.listPlatforms();
    const picked = caps.filter((p) => (task.accountIds || []).includes(p.id));
    const noAuto = picked.filter((p) => !p.capabilities || p.capabilities.autoSubmit !== "verified");
    task.capabilityNotice = (task.mode === "publish" && noAuto.length)
      ? `以下平台自动提交能力未验证，将停在草稿待确认（需人工在平台页面发布）：${noAuto.map((p) => p.label).join("、")}`
      : null;
  } catch {
    task.capabilityNotice = null;
  }
  /* 快速返回：任务已持久化并进入执行队列，实际填充由后台逐个完成（前端按任务 ID 轮询） */
  if (task.status !== "queued") {
    task.status = "queued";
    task.history = task.history || [];
    task.history.push({ at: new Date().toISOString(), event: "queued", detail: "进入执行队列" });
    saveStore();
  }
  enqueuePublish(task.id);
  return { ok: true, queued: true, status: task.status };
}

/* RPA 执行队列：同一时刻只执行一个发布任务，避免多任务争抢同一批浏览器页面。
   任务先持久化（status=queued）再排队，执行结果写回任务对象。
   单任务异常/超时全部隔离在循环内 —— 一个任务写盘失败或卡死，不能拖垮队列里后面的任务。 */
/* 单任务最长执行时间：10 分钟（多个平台逐个开页填充，每个都要等页面加载）。
   NOTEFLY_TASK_TIMEOUT_MS 仅供测试缩短（下限 50ms，防止误配 0 造成空转）。 */
const TASK_EXECUTE_TIMEOUT_MS = Math.max(50, Number(process.env.NOTEFLY_TASK_TIMEOUT_MS) || 10 * 60 * 1000);
/* 进行中的执行登记：taskId → runToken。
   超时把登记删除，之后才返回的「迟到结果」会被识别并作废（P0-3） */
const activeRuns = new Map();
/* 这些状态的目标已代表「平台侧有动作或结论」，不允许再翻转成 unknown：
   pending/filling/draft_saving 这类未落定状态超时后必须转 unknown 待核验 */
const TARGET_STABLE_ON_TIMEOUT = new Set([
  "success", "published", "failed", "ready", "needs_manual", "unknown", "accepted", "reviewing", "submitting",
]);
/* 这些状态的目标绝不允许再次提交/重填：重复发文无法撤回（P0-4） */
const NO_RESUBMIT = new Set(["success", "published", "accepted", "reviewing", "submitting", "unknown"]);
function NO_RESUBMIT_REASON(status) {
  switch (status) {
    case "unknown":
      return "该平台提交结果待核验，请先核验再决定是否重试";
    case "accepted":
    case "reviewing":
      return "该平台已受理/审核中，重复提交会造成重复发文，已阻止。请等待平台出结果";
    case "submitting":
      return "该平台正在提交中，请勿重复操作";
    default:
      return "该平台已确认发布，已阻止重复提交";
  }
}

function enqueuePublish(taskId) {
  if (!publishQueue.pending.includes(taskId)) publishQueue.pending.push(taskId);
  setImmediate(runPublishQueue);
}
async function runPublishQueue() {
  if (publishQueue.running) return;
  publishQueue.running = true;
  try {
    while (publishQueue.pending.length) {
      const id = publishQueue.pending.shift();
      let task = null;
      task = store.tasks.find((t) => t.id === id);
      if (!task || !["queued", "creating"].includes(task.status)) continue; // 已删除或已在别处执行
      /* 保留底层执行的引用：Promise.race 超时只代表「不再等」，RPA 还在跑 */
      const executing = executeRpaTask(task);
      try {
        await Promise.race([
          executing,
          new Promise((_, rej) => setTimeout(() => rej(new Error("任务执行超时（10 分钟），已中止后续等待")), TASK_EXECUTE_TIMEOUT_MS)),
        ]);
      } catch (e) {
        /* 超时（executeRpaTask 自身不抛错，走到这里的只有超时定时器）：
           1. 作废本执行的迟到结果  2. 任务进「待核验」而非 failed（failed 会解锁重发，可能造成重复发文）
           3. 未落定的目标翻成 unknown，请用户核验 */
        const msg = String((e && e.message) || e).slice(0, 400);
        activeRuns.delete(id);
        logger.warn("发布任务", `任务执行超时，进入待核验：${msg}`, { 任务号: id, 标题: task ? task.title : "" });
        try {
          if (task) {
            const targets = (task.lastStatus && task.lastStatus.targets) || [];
            for (const t of targets) {
              if (!TARGET_STABLE_ON_TIMEOUT.has(t.status)) {
                t.status = "unknown";
                t.error = "执行超时，结果未知：请到平台后台核验是否已发布/已存草稿，再决定后续处理";
              }
            }
            task.status = taskStatus.TASK.UNKNOWN;
            task.error = "执行超时：部分平台动作可能已完成，请核验各平台状态后再处理";
            task.statusReason = "执行超时·待核验";
            taskStatus.syncTask(task);
            task.history = task.history || [];
            task.history.push({ at: new Date().toISOString(), event: "queue_timeout", detail: msg });
            saveStore();
          }
        } catch (e2) {
          console.error("[队列] 超时状态落盘失败:", e2.message);
          logger.error("发布任务", `超时状态落盘失败：${e2.message}`, { 任务号: id });
        }
      }
      /* 绝不并行：前一个任务的浏览器操作真正落定之前，不放行下一个任务
         （旧版 Promise.race 超时后立刻取下一个任务，两个 RPA 同时开页互相踩）
         宽限期内仍未落定则强制关闭浏览器上下文，逼执行结束。 */
      const settle = Promise.resolve(executing).catch(() => {});
      const grace = new Promise((res) => setTimeout(res, TASK_EXECUTE_TIMEOUT_MS));
      const settled = await Promise.race([settle.then(() => true), grace.then(() => false)]);
      if (!settled) {
        logger.error("发布任务", "任务执行超过宽限期，强制关闭 RPA 浏览器上下文", { 任务号: id });
        try { await rpa.closeAll(); } catch { /* 已关就算了 */ }
        await settle;
      }
    }
  } finally {
    publishQueue.running = false;
  }
}
async function executeRpaTask(task) {
  const runToken = { id: task.id };
  activeRuns.set(task.id, runToken);
  try {
    task.status = taskStatus.TASK.RUNNING;
    task.startedAt = task.startedAt || new Date().toISOString();
    task.history = task.history || [];
    task.history.push({ at: new Date().toISOString(), event: "rpa_fill_start" });
    saveStore();
  } catch (e) {
    /* 状态落盘失败不能让异常向外冒出（会中断队列），任务本次不执行 */
    console.error("[队列] 任务状态落盘失败，跳过:", task.id, e.message);
    return;
  }
  try {
    const result = await rpa.publish(task.snapshot, task.accountIds, task.mode || "draft", {
      /* 逐目标持久化：第一个平台完成就落盘，第二个平台卡死也不丢第一阶段记录 */
      onProgress: (platform, target) => {
        try {
          if (activeRuns.get(task.id) !== runToken) return;   // 已被超时作废
          task.progressTargets = Object.assign({}, task.progressTargets, { [platform]: target });
          task.lastStatus = { targets: Object.values(task.progressTargets), updatedAt: new Date().toISOString() };
          taskStatus.syncTask(task);
          task.history = task.history || [];
          task.history.push({ at: new Date().toISOString(), event: "target_progress", detail: `${platform} → ${target.status}` });
          saveStore();
        } catch { /* 进度落盘失败不影响执行 */ }
      },
    });
    /* 迟到结果作废：超时时登记已删除，此刻还在 map 里才允许应用 */
    if (activeRuns.get(task.id) !== runToken) {
      logger.warn("发布任务", "任务超时后的迟到结果已作废（防止覆盖待核验状态）", { 任务号: task.id });
      task.history = task.history || [];
      task.history.push({ at: new Date().toISOString(), event: "stale_result_discarded" });
      try { saveStore(); } catch { /* 忽略 */ }
      return task;
    }
    /* 合并逐目标进度与最终结果：最终结果优先，进度补齐没走完的目标 */
    const merged = Object.assign({}, task.progressTargets || {});
    for (const t of (result && result.targets) || []) merged[t.platform] = t;
    applyRpaResult(task, {
      groupId: result && result.groupId,
      targets: Object.values(merged),
      open: result && result.open,
      mode: result && result.mode,
    });
  } catch (e) {
    task.status = taskStatus.TASK.FAILED;
    task.error = String(e.message || e).slice(0, 400);
    task.statusReason = "执行异常";
    task.history.push({ at: new Date().toISOString(), event: "rpa_error", detail: task.error });
    try { saveStore(); } catch (e2) { console.error("[队列] 结果落盘失败:", e2.message); }
  } finally {
    if (activeRuns.get(task.id) === runToken) activeRuns.delete(task.id);
  }
}

/* 启动恢复：执行队列在内存里，重启会丢。
 *  - queued 且从未执行（无 startedAt）→ 重新入队继续跑
 *  - queued/running/creating 且执行到一半（有 startedAt）→ 不能盲目重发：
 *    已提交/受理的目标保持原状等核验；没有目标记录的按新规则归并（unknown 优先） */
/* 定时调度器（间隔可在设置页调整 config.checkInterval 秒）
 * 单个任务抛错不能影响其他任务，更不能掐断下一轮调度 —— 所以：
 *   1. 每个任务单独 try/catch；
 *   2. 下一轮 setTimeout 放在 finally 里注册。 */
let schedulerTimer = null;
async function schedulerTick() {
  try {
    const now = Date.now();
    const due = store.tasks.filter(
      (t) => t.status === "scheduled" && t.scheduledAt && new Date(t.scheduledAt).getTime() <= now
    );
    for (const task of due) {
      try {
        await startTask(task);
      } catch (e) {
        console.error("[调度] 任务执行异常:", task.id, e && e.message);
        task.status = "failed";
        task.error = String((e && e.message) || e).slice(0, 400);
        task.statusReason = "调度异常";
        task.history = task.history || [];
        task.history.push({ at: new Date().toISOString(), event: "scheduler_error", detail: task.error });
        try { saveStore(); } catch (e2) { console.error("[调度] 状态落盘失败:", e2.message); }
      }
    }
  } catch (e) {
    console.error("[调度] 本轮检查异常:", e && e.message);
  } finally {
    schedulerTimer = setTimeout(schedulerTick, Math.max(5, (config.checkInterval || 30)) * 1000);
  }
}
if (process.env.NOTEFLY_DISABLE_SCHEDULER !== "1") schedulerTick();

/* ---------------- 应用 ---------------- */
/* 把接口路径翻译成中文分区名，日志面板按分区看更直观。 */
function logScope(req) {
  const p = req.path || "";
  if (p.startsWith("/api/ai/")) return "AI 模型";
  if (p.startsWith("/api/text/")) return "文本工具";
  if (p.startsWith("/api/gzh/")) return "公众号排版";
  if (p.startsWith("/api/rpa/")) return "登录引擎";
  if (p.startsWith("/api/accounts")) return "账号";
  if (p.startsWith("/api/contents")) return "内容库";
  if (p.startsWith("/api/library")) return "企业内容库";
  if (p.startsWith("/api/progress")) return "任务进度";
  if (p.startsWith("/api/messages")) return "消息中心";
  if (p.startsWith("/api/update")) return "软件更新";
  if (p.startsWith("/api/media")) return "素材库";
  if (p.startsWith("/api/upload")) return "素材库";
  if (p.startsWith("/api/tasks")) return "发布任务";
  if (p.startsWith("/api/publish")) return "发布任务";
  if (p.startsWith("/api/data-dir")) return "数据目录";
  if (p.startsWith("/api/keepalive")) return "账号巡检";
  if (p.startsWith("/api/metrics")) return "数据看板";
  if (p.startsWith("/api/checkwords")) return "违禁词";
  if (p.startsWith("/api/config")) return "设置";
  if (p.startsWith("/api/logs")) return "日志";
  return "接口";
}

const app = express();
app.use(express.json({ limit: "50mb" }));
/* 访问日志：放在 json 解析之后才能读到请求体摘要。
   挂在静态资源之后 —— 图片、字体、脚本这类请求不记（噪声太大）。 */
app.use(express.static(path.join(__dirname, "public")));
app.use(logHttp.logHttpMiddleware(logScope));
/* 上传的图片/媒体以静态资源方式暴露：本地绝对路径浏览器加载不了，预览必须走这个地址。
   数据目录可运行时切换，express.static 会在创建时固定根目录 —— 所以这里按当前目录
   惰性重建静态服务，目录一变就自动指向新位置。 */
let uploadsStatic = null;
let uploadsStaticDir = "";
app.use("/uploads", (req, res, next) => {
  const dir = dataDir.uploads();
  if (dir !== uploadsStaticDir) {
    uploadsStatic = express.static(dir, { maxAge: "7d", fallthrough: true });
    uploadsStaticDir = dir;
  }
  uploadsStatic(req, res, next);
});

/* 配置 */
app.get("/api/config", (req, res) => {
  res.json({
    /* 引擎已收敛为单一 RPA，不再可切换 */
    engine: "rpa",
    checkInterval: config.checkInterval || 30,
    /* 作者信息：设置页与公众号签名区共用同一份数据源 */
    authorName: config.authorName || "",
    authorBio: config.authorBio || "",
    /* 数据存储位置（当前目录 + 是否用了自定义目录） */
    dataDir: dataDir.get(),
    dataDirIsDefault: dataDir.isDefault(),
    /* 版本号：界面各处显示用 */
    version: APP_VERSION,
    /* 更新设置：仓库地址与预发布开关（Key 类敏感信息不回传） */
    update: {
      repo: config.update.repo || "",
      allowPrerelease: !!config.update.allowPrerelease,
    },
    /* 数据文件损坏等启动告警：前端必须显式提示，不能静默用空库 */
    dataWarnings,
  });
});
app.post("/api/config", (req, res) => {
  const { checkInterval, authorName, authorBio, update } = req.body || {};
  if (Number(checkInterval) >= 5) config.checkInterval = Number(checkInterval);
  if (typeof authorName === "string") config.authorName = authorName.trim().slice(0, 40);
  if (typeof authorBio === "string") config.authorBio = authorBio.trim().slice(0, 80);
  if (update && typeof update === "object") {
    if (typeof update.repo === "string") {
      const repo = update.repo.trim();
      /* 空值合法（表示「不配置」）；非空时必须是 owner/repo 或 GitHub 链接 */
      if (repo) {
        const parsed = require("./lib/updater").parseRepo(repo);
        if (!parsed) {
          return res.status(400).json({ error: "仓库地址格式不正确，请填 owner/repo 或完整的 GitHub 仓库链接" });
        }
        config.update.repo = repo;
      } else {
        config.update.repo = "";
      }
    }
    if (update.allowPrerelease !== undefined) config.update.allowPrerelease = !!update.allowPrerelease;
  }
  try {
    saveConfig();
  } catch (e) {
    return res.status(500).json({ error: "配置写入失败：" + String(e.message || e) });
  }
  res.json({ ok: true });
});

/* ---------------- 数据存储位置 ----------------
 * 换目录 = 把现有数据搬过去 + 写指针 + 重载内存态。
 * 三者必须一起做，否则会出现「指针指向新目录、内存还是旧数据」的错位。
 * 指针写在 ~/.notefly/location.json：放在 data/ 里会跟着搬家，就再也找不回位置了。 */
app.post("/api/data-dir", async (req, res) => {
  const target = (req.body && req.body.dir) || "";
  const migrate = !req.body || req.body.migrate !== false;

  const check = dataDir.validateTarget(target);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const from = dataDir.get();
  if (path.resolve(check.dir) === path.resolve(from)) {
    return res.json({ ok: true, dir: from, unchanged: true, moved: [], skipped: [] });
  }

  /* 有发布任务在跑时不能换目录：任务快照与页面句柄都指向旧目录的登录态 */
  if (publishQueue.running || publishQueue.pending.length) {
    return res.status(409).json({ error: "有发布任务正在执行，请等任务结束后再切换数据目录" });
  }

  let moved = [];
  let skipped = [];
  if (migrate) {
    const r = dataDir.migrate(from, check.dir);
    if (!r.ok) {
      /* 409：目标目录有数据/复制失败。指针与内存态都没动，原目录继续可用 */
      return res.status(409).json({ error: r.error, conflicts: r.conflicts || [] });
    }
    moved = r.moved;
    skipped = r.skipped;
  }

  /* 写指针：失败要回滚内存态，否则重启后又回到旧目录 */
  try {
    dataDir.writePointer(check.dir);
  } catch (e) {
    return res.status(500).json({ error: "写入目录指针失败：" + String(e.message || e) });
  }
  dataDir.setCurrent(check.dir);

  /* 重载内存态：store/config 必须跟着换，否则读写会串到两个目录 */
  const newStore = normalizeStore(loadJSON(dataDir.storeFile(), defaultStore()));
  const newConfig = normalizeConfig(loadJSON(dataDir.configFile(), defaultConfig()));
  store.contents = newStore.contents;
  store.tasks = newStore.tasks;
  store.accountMeta = newStore.accountMeta;
  Object.assign(config, newConfig);

  /* 登录态随目录迁移了，但已开的浏览器上下文还指着旧路径：关掉，下次发布时按新目录重开 */
  try {
    await rpa.closeAll();
    await rpa.resetContext();
  } catch {
    /* 浏览器没开就算了，不影响切换本身 */
  }

  reloadDataModules();

  logger.info("数据目录", `数据目录已切换：${from} → ${check.dir}`, { 已迁移: moved, 已跳过: skipped });
  res.json({
    ok: true,
    dir: check.dir,
    from,
    moved,
    skipped,
    counts: { contents: store.contents.length, tasks: store.tasks.length },
  });
});

/* 恢复默认目录（应用内 data/） */
app.post("/api/data-dir/reset", async (req, res) => {
  const from = dataDir.get();
  if (dataDir.isDefault(from)) return res.json({ ok: true, dir: from, unchanged: true });
  if (publishQueue.running || publishQueue.pending.length) {
    return res.status(409).json({ error: "有发布任务正在执行，请等任务结束后再切换数据目录" });
  }
  const check = dataDir.validateTarget(dataDir.DEFAULT_DIR);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const r = dataDir.migrate(from, check.dir);
  if (!r.ok) return res.status(500).json({ error: r.error });
  try {
    dataDir.clearPointer();
  } catch (e) {
    return res.status(500).json({ error: "清除目录指针失败：" + String(e.message || e) });
  }
  dataDir.setCurrent(check.dir);

  const newStore = normalizeStore(loadJSON(dataDir.storeFile(), defaultStore()));
  const newConfig = normalizeConfig(loadJSON(dataDir.configFile(), defaultConfig()));
  store.contents = newStore.contents;
  store.tasks = newStore.tasks;
  store.accountMeta = newStore.accountMeta;
  Object.assign(config, newConfig);
  try {
    await rpa.closeAll();
    await rpa.resetContext();
  } catch {}

  reloadDataModules();

  logger.info("数据目录", `数据目录已恢复默认：${from} → ${check.dir}`, { 已迁移: r.moved, 已跳过: r.skipped });
  res.json({ ok: true, dir: check.dir, from, moved: r.moved, skipped: r.skipped });
});

/* 当前选中的企业内容库：新建内容时显示它，AI 写作也用它 */
app.get("/api/library/current", (req, res) => {
  const c = currentCompanyId ? library.getCompany(currentCompanyId) : null;
  res.json({
    ok: true,
    companyId: c ? c.id : "",
    companyName: c ? c.name : "",
    companies: library.listCompanies(),
  });
});
app.post("/api/library/current", (req, res) => {
  const id = String((req.body && req.body.companyId) || "");
  const c = library.getCompany(id);
  if (id && !c) return res.status(404).json({ error: "企业不存在" });
  setCurrentCompany(id);
  logger.info("企业内容库", c ? `切换当前企业为「${c.name}」` : "清除当前企业选择");
  res.json({ ok: true, companyId: currentCompanyId, companyName: c ? c.name : "" });
});

/* RPA 引擎：平台列表 / 登录 */
app.get("/api/rpa/platforms", (req, res) => res.json({ platforms: rpa.listPlatforms() }));
app.post("/api/rpa/login", async (req, res) => {
  try {
    const r = await rpa.openForLogin(req.body.platform);
    logger.info("登录引擎", `打开登录页：${req.body.platform || "未知平台"}`);
    res.json(r);
  } catch (e) {
    logger.error("登录引擎", `打开登录页失败：${String(e.message || e)}`, { 平台: req.body.platform });
    res.status(400).json({ error: String(e.message || e) });
  }
});
/* 应用内浏览器登录完成 → 导入登录态（cookie + localStorage），供无头发布引擎复用 */
app.post("/api/rpa/import-state", async (req, res) => {
  try {
    const { platform, url, cookies, localStorage: ls } = req.body || {};
    if (!platform) return res.status(400).json({ error: "缺少 platform" });
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    /* 只保留与该平台域名相关的 cookie，避免把整个浏览器会话塞进来 */
    const keep = (cookies || []).filter((c) => {
      const d = String((c && c.domain) || "").replace(/^\./, "").replace(/^www\./, "");
      if (!host || !d) return false;
      return host === d || host.endsWith("." + d) || d.endsWith("." + host);
    });
    const r = await rpa.importState(platform, { cookies: keep, localStorage: Array.isArray(ls) ? ls : [], url });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post("/api/rpa/checklogin", async (req, res) => {
  try {
    const r = await rpa.checkLogin(req.body.platform);
    /* 单平台检查结果回写进巡检缓存，账号列表即时可见（含上次检查时间与判定方式） */
    if (r.ok) {
      const details = config.kaState.details || [];
      const e = details.find((x) => x.id === req.body.platform);
      const patch = { online: !!r.loggedIn, checkedAt: r.checkedAt || new Date().toISOString(), method: r.method || "", error: "" };
      if (e) Object.assign(e, patch);
      else details.push({ platform: req.body.platform, id: req.body.platform, ...patch });
      config.kaState.details = details;
      saveConfig();
    }
    if (r.loggedIn) logger.info("登录引擎", `登录检查：${req.body.platform} 已登录（判定方式 ${r.method || "未知"}）`);
    else logger.warn("登录引擎", `登录检查：${req.body.platform} 未登录`, { 原因: r.reason || r.error || "" });
    res.json(r);
  } catch (e) {
    logger.error("登录引擎", `登录检查失败：${String(e.message || e)}`, { 平台: req.body.platform });
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post("/api/rpa/closeall", async (req, res) => {
  try {
    res.json({ ok: true, closed: await rpa.closeAll() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post("/api/rpa/clearprofile", async (req, res) => {
  try {
    await rpa.clearProfile();
    res.json({ ok: true, note: "浏览器缓存已清理，所有平台登录态已失效，需重新登录" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* 平台清单：直接来自内置 RPA 引擎的适配器注册表 */
app.get("/api/platforms", (req, res) => {
  res.json({ platforms: rpa.listPlatforms() });
});

/* 账号（带本地分组/别名；来自 RPA 适配器平台） */
app.get("/api/accounts", async (req, res) => {
  const kaDetails = config.kaState.details || [];
  let outdated = 0;
  const accounts = rpa.listPlatforms().map((p) => {
    const d = kaDetails.find((x) => x.id === p.id);
    const checkedAt = d?.checkedAt || null;
    /* 旧判定规则得出的结论不可信 → 退回「待检查」，不参与已登录计数 */
    const ruleOld = !!(d && d.checkedAt && d.judge !== LOGIN_JUDGE_VERSION);
    if (ruleOld) outdated++;
    /* 登录态是「一次性巡检的快照」，不是实时事实。
       超过有效期（默认 12 小时）就标为 stale —— 前端降级成「待复核」，
       避免把几小时前的旧结论当成现在还登着。 */
    const stale = !!(checkedAt && !ruleOld && Date.now() - new Date(checkedAt).getTime() > ACCOUNT_STALE_MS);
    return {
      id: p.id,
      platform: p.platform,
      displayName: p.label,
      username: "",
      avatar: "",
      /* 只认带时间戳的检查结果；旧缓存（无 checkedAt）视为待检查，避免误报已登录 */
      isLoggedIn: d && d.checkedAt && !ruleOld ? d.online : null,
      checkedAt,
      stale,
      ruleOld,
      checkMethod: d?.method || "",
      group: store.accountMeta[p.id]?.group || "未分组",
      alias: store.accountMeta[p.id]?.alias || "",
      adapterStatus: p.status,
      loginUrl: p.loginUrl,
      homeUrl: p.homeUrl || "",
    };
  });
  res.json({ accounts, outdated });
});
app.post("/api/accounts/:id/meta", (req, res) => {
  const { alias, group } = req.body || {};
  const m = store.accountMeta[req.params.id] || (store.accountMeta[req.params.id] = {});
  if (alias !== undefined) m.alias = alias;
  if (group !== undefined) m.group = group;
  saveStore();
  res.json({ ok: true });
});
/* 刷新登录态：重新跑一次该平台的登录检测，并回写巡检缓存 */
app.post("/api/accounts/:id/refresh", async (req, res) => {
  const platform = req.params.id;
  try {
    const r = await rpa.checkLogin(platform);
    const details = config.kaState.details || [];
    const e = details.find((x) => x.id === platform);
    const patch = { online: !!r.loggedIn, checkedAt: r.checkedAt || new Date().toISOString(), method: r.method || "", error: "" };
    if (e) Object.assign(e, patch);
    else details.push({ platform, id: platform, ...patch });
    config.kaState.details = details;
    saveConfig();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

/* 图片/媒体上传：前端传 base64，存到 data/uploads
   path = 本地绝对路径（发布时给 file input 用）；url = 网页可访问地址（预览用） */
app.post("/api/upload", (req, res) => {
  const { name, data } = req.body || {};
  if (!name || !data) return res.status(400).json({ error: "name/data 必填" });
  const m = String(data).match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return res.status(400).json({ error: "data 需为 base64 dataURL" });
  const ext = (path.extname(name) || "").toLowerCase() || "." + (m[1].split("/")[1] || "bin");
  const base = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext;
  const file = path.join(dataDir.uploads(), base);
  fs.mkdirSync(dataDir.uploads(), { recursive: true });
  fs.writeFileSync(file, Buffer.from(m[2], "base64"));
  /* path 返回 Web 路径（/uploads/<name>）而不是绝对磁盘路径：
     存进内容里的引用必须与数据目录解耦——换目录、换机器后仍然可用 */
  const web = "/uploads/" + encodeURIComponent(base);
  res.json({ ok: true, path: web, url: web, name: base });
});

/* 导入 Markdown 文本为一篇内容 */
app.post("/api/contents/import", (req, res) => {
  const { filename, body } = req.body || {};
  if (!body) return res.status(400).json({ error: "body 必填" });
  // 从正文提取首行 # 标题（如有）
  let title = (filename || "").replace(/\.md$/i, "");
  let text = body;
  const m = body.match(/^\s*#\s+(.+)\n/);
  if (m) {
    title = title || m[1].trim();
    text = body.replace(/^\s*#\s+.+\n/, "");
  }
  if (!title) title = "导入内容 " + new Date().toLocaleString("zh-CN", { hour12: false });
  const c = {
    id: crypto.randomUUID(),
    type: "ARTICLE",
    title,
    digest: "",
    body: text,
    cover: "",
    tags: [],
    createdAt: new Date().toISOString(),
    imported: true,
  };
  store.contents.unshift(c);
  saveStore();
  res.json(c);
});

/* 内容库 */
app.get("/api/contents", (req, res) => res.json({ contents: store.contents }));
app.post("/api/contents", (req, res) => {
  const c = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...req.body };
  store.contents.unshift(c);
  try {
    saveStore();
  } catch (e) {
    /* 落盘失败必须回滚内存，否则界面看到的“已保存”是假的 */
    store.contents = store.contents.filter((x) => x.id !== c.id);
    logger.error("内容库", `保存内容失败（磁盘写入异常）：${String(e.message || e)}`, { 标题: c.title || "" });
    return res.status(500).json({ error: "内容保存失败（磁盘写入异常）：" + String(e.message || e) });
  }
  logger.info("内容库", `保存内容「${c.title || "(无标题)"}」${c.draft ? "（草稿）" : "（新建）"}`);
  res.json(c);
});
app.put("/api/contents/:id", (req, res) => {
  const c = store.contents.find((x) => x.id === req.params.id);
  if (!c) {
    logger.warn("内容库", `更新内容失败：内容不存在（${req.params.id}）`);
    return res.status(404).json({ error: "内容不存在（可能已被删除），请刷新内容库" });
  }
  const before = { ...c };
  Object.assign(c, req.body, { id: c.id });
  try {
    saveStore();
  } catch (e) {
    Object.keys(c).forEach((k) => { if (!(k in before)) delete c[k]; });
    Object.assign(c, before);
    logger.error("内容库", `保存内容失败（磁盘写入异常）：${String(e.message || e)}`, { 标题: c.title || "" });
    return res.status(500).json({ error: "内容保存失败（磁盘写入异常）：" + String(e.message || e) });
  }
  logger.info("内容库", `保存内容「${c.title || "(无标题)"}」${c.draft ? "（草稿）" : ""}`);
  res.json(c);
});
app.delete("/api/contents/:id", (req, res) => {
  const before = store.contents;
  store.contents = store.contents.filter((x) => x.id !== req.params.id);
  try {
    saveStore();
  } catch (e) {
    store.contents = before;
    return res.status(500).json({ error: "删除失败（磁盘写入异常）：" + String(e.message || e) });
  }
  res.json({ ok: true });
});

/* 发布：立即 / 定时；mode: draft=存草稿箱（待人工确认） / publish=立即发布 */
app.post("/api/publish", async (req, res) => {
  const { contentId, snapshot, accountIds, scheduledAt, title, mode } = req.body || {};
  if (!accountIds || !accountIds.length) return res.status(400).json({ error: "请至少选择一个账号" });
  const pubMode = mode === "publish" ? "publish" : "draft";
  const snap = snapshot || (() => {
    const c = store.contents.find((x) => x.id === contentId);
    if (!c) return null;
    return { type: c.type, title: c.title, digest: c.digest, body: c.body, cover: c.cover, images: c.images, tags: c.tags, video: c.video, audio: c.audio };
  })();
  if (!snap) return res.status(400).json({ error: "内容不存在，请重新选择" });

  /* 定时时间校验：非法或已过去的时间必须明确报错，不能排进队列后永远不执行 */
  let scheduledAtIso = null;
  if (scheduledAt) {
    const ts = new Date(scheduledAt).getTime();
    if (Number.isNaN(ts)) return res.status(400).json({ error: "定时时间格式不正确" });
    if (ts <= Date.now() + 1000) return res.status(400).json({ error: "定时时间必须晚于当前时间" });
    scheduledAtIso = new Date(ts).toISOString();
  }

  const task = {
    id: crypto.randomUUID(),
    groupId: null,
    contentId: contentId || null,
    title: title || snap.title || "(无标题)",
    type: snap.type,
    accountIds,
    snapshot: snap,
    /* 冻结创建时的模式/时间/账号：排队期间改设置不影响已建任务 */
    engine: "rpa",
    frozenAt: new Date().toISOString(),
    mode: pubMode,
    scheduledAt: scheduledAtIso,
    status: scheduledAtIso ? "scheduled" : "creating",
    createdAt: new Date().toISOString(),
    startedAt: null,
    lastStatus: null,
    error: null,
    history: [{ at: new Date().toISOString(), event: scheduledAtIso ? "scheduled" : "immediate", detail: `engine=rpa, mode=${pubMode}` }],
  };
  store.tasks.unshift(task);
  saveStore();
  logger.info("发布任务", `创建任务「${task.title}」`, {
    模式: pubMode === "publish" ? "直接发布" : "存草稿箱",
    平台: accountIds,
    定时: scheduledAtIso || "立即",
    任务号: task.id,
  });

  /* 定时任务先排队，到点由调度器执行（不要在此立即填充） */
  if (task.status === "scheduled") return res.status(202).json({ error: null, task: publicTask(task), taskStatus: task.status });
  task.status = "queued";
  task.history.push({ at: new Date().toISOString(), event: "queued", detail: "任务已创建，进入执行队列" });
  saveStore();
  enqueuePublish(task.id);
  return res.status(202).json({
    error: null,
    task: publicTask(task),
    taskStatus: task.status,
    taskStatusReason: "已进入执行队列，正在等待执行",
  });
});

/* 任务列表 */
app.get("/api/tasks", (req, res) => res.json({ tasks: store.tasks }));
app.get("/api/tasks/:groupId/status", async (req, res) => {
  /* 状态在本地任务里（页面句柄在进程内） */
  const task = store.tasks.find((t) => t.groupId === req.params.groupId);
  if (!task) return res.status(404).json({ error: "not_found" });
  res.json({ targets: (task.lastStatus && task.lastStatus.targets) || [], handlesAlive: rpa.hasHandles(req.params.groupId) });
});
/* 手动发布/重试后重算任务状态（历史函数名保留，实现已统一） */
function settleTask(task) {
  if (!task) return null;
  return taskStatus.syncTask(task, { save: saveStore });
}

app.post("/api/tasks/:groupId/submit", async (req, res) => {
  {
    const task = store.tasks.find((t) => t.groupId === req.params.groupId);
    if (!task) return res.status(404).json({ error: "任务不存在" });
    /* 统一拦截规则（NO_RESUBMIT）：已成功/受理/审核中/提交中/结果待核验一律不再提交 */
    const skipped = (task.lastStatus?.targets || []).filter((t) => NO_RESUBMIT.has(t.status));
    const targets = (task.lastStatus?.targets || []).filter((t) => ["ready", "needs_manual"].includes(t.status));
    if (!targets.length) {
      return res.status(409).json({
        error: skipped.length ? "没有可提交的目标（已发布、已受理或结果待核验的平台不会重复提交）" : "没有待发布的平台",
        skipped: skipped.map((t) => ({ accountId: t.accountId, status: t.status })),
        targets: task.lastStatus?.targets || [],
      });
    }
    for (const t of targets) {
      t.status = "submitting";       // 先标记，失败再落回具体结果
      t.error = "";
      saveStore();                   // 「已开始提交」先持久化，再操作平台（幂等前提）
      const r = await rpa.submitTarget(req.params.groupId, t.accountId);
      /* 提交超时不能落成 failed：平台可能已接收，落成失败会解锁重复发文。
         必须是 unknown —— 先核验，再决定是否重试 */
      t.status = r.ok ? (r.status || "accepted") : (r.status === "unknown" ? "unknown" : "failed");
      if (r.error) t.error = r.error;
      t.history = (t.history || []).concat([{ at: new Date().toISOString(), action: "submit", ok: !!r.ok, msg: r.error || "" }]);
    }
    settleTask(task);
    return res.json({ targets: task.lastStatus.targets, task: publicTask(task), taskStatus: task.status, taskError: task.error });
  }
});
app.post("/api/tasks/:groupId/targets/:accountId/submit", async (req, res) => {
  {
    const task = store.tasks.find((t) => t.groupId === req.params.groupId);
    if (!task) return res.status(404).json({ error: "任务不存在" });
    const tg = (task.lastStatus?.targets || []).find((x) => x.accountId === req.params.accountId);
    if (!tg) return res.status(404).json({ error: "该任务没有这个平台目标" });
    /* 统一拦截规则（NO_RESUBMIT）：含 accepted/reviewing —— 平台已接收的作品重复提交会造成重复发文 */
    if (NO_RESUBMIT.has(tg.status)) {
      return res.status(409).json({
        ok: false,
        error: NO_RESUBMIT_REASON(tg.status),
      });
    }
    tg.status = "submitting";
    saveStore();                     // 先持久化「已开始提交」，再操作平台
    const r = await rpa.submitTarget(req.params.groupId, req.params.accountId);
    tg.status = r.ok ? (r.status || "accepted") : (r.status === "unknown" ? "unknown" : "failed");
    if (r.error) tg.error = r.error;
    tg.history = (tg.history || []).concat([{ at: new Date().toISOString(), action: "submit", ok: !!r.ok, msg: r.error || "" }]);
    settleTask(task);
    return res.status(r.ok ? 200 : 400).json(Object.assign({}, r, { task: publicTask(task), taskStatus: task.status, taskError: task.error }));
  }
});
app.post("/api/tasks/:groupId/targets/:accountId/retry", async (req, res) => {
  {
    const task = store.tasks.find((t) => t.groupId === req.params.groupId);
    if (!task || !task.snapshot) return res.status(404).json({ error: "任务不存在或缺快照" });
    const tg = (task.lastStatus?.targets || []).find((x) => x.accountId === req.params.accountId);
    /* 统一拦截规则（NO_RESUBMIT）：unknown 必须先核验；accepted/reviewing 重复重填同样危险 */
    if (tg && NO_RESUBMIT.has(tg.status)) {
      return res.status(409).json({
        ok: false,
        error: NO_RESUBMIT_REASON(tg.status),
      });
    }
    const r = await rpa.refillTarget(req.params.groupId, req.params.accountId, task.snapshot);
    if (tg) {
      tg.status = r.ok ? "ready" : "failed";
      tg.error = r.ok ? "" : r.error || "";
      tg.history = (tg.history || []).concat([{ at: new Date().toISOString(), action: "refill", ok: !!r.ok, msg: r.error || "" }]);
    }
    /* 关键修复：目标变化后必须立即重算父任务（此前只改目标，任务一直停在 failed） */
    settleTask(task);
    return res.status(r.ok ? 200 : 400).json(Object.assign({}, r, {
      taskStatus: task.status,
      taskError: task.error,
      task,
    }));
  }
});
/* 结果核验（针对 unknown 目标）：
 *   action=check            自动能查多少查多少（执行页面是否还在），给用户明确的下一步提示
 *   action=confirm_success  人工确认已发布 —— 明确标记 verifiedBy=manual，绝不伪造成平台自动核验
 *   action=confirm_failed   人工登记失败，之后可以正常重试 */
app.post("/api/tasks/:groupId/targets/:accountId/verify", async (req, res) => {
  if (!req.params.groupId.startsWith("rpa-")) return res.status(400).json({ error: "该操作仅支持 RPA 引擎任务" });
  const task = store.tasks.find((t) => t.groupId === req.params.groupId);
  const tg = task && (task.lastStatus?.targets || []).find((x) => x.accountId === req.params.accountId);
  if (!task || !tg) return res.status(404).json({ error: "任务或目标不存在" });
  const action = (req.body && req.body.action) || "check";
  tg.history = tg.history || [];
  const now = new Date().toISOString();

  if (action === "check") {
    const alive = rpa.hasHandles(req.params.groupId);
    const hint = alive
      ? "执行页面仍打开着，可回到该平台页面人工查看实际状态，再登记结果"
      : "无法自动核验：执行页面已关闭。请打开平台后台确认后，用「确认已发布 / 登记失败」登记结果（会记录为人工确认）";
    tg.history.push({ at: now, action: "verify", msg: hint, source: "manual" });
    saveStore();
    return res.json({ ok: true, handleAlive: alive, hint, target: tg, task: publicTask(task), taskStatus: task.status });
  }

  if (action === "confirm_success" || action === "confirm_failed") {
    /* 状态机限制：人工登记只允许作用于「结果未知」的目标。
       - 已成功目标再确认成功 → 幂等拒绝
       - 已成功目标登记失败 → 拒绝。已发布记录如需修正，必须走独立的更正流程（带审计），
         绝不能一键变回可重试的普通失败，否则会解锁重复发文 */
    if (["success", "published"].includes(tg.status)) {
      return res.status(409).json({
        ok: false,
        error: action === "confirm_success"
          ? "该平台已记录为发布成功"
          : "该平台已记录为发布成功，不能直接登记失败。如发布实际未成功，请联系开发走更正流程（会保留完整审计记录）",
      });
    }
    if (!["unknown", "accepted", "reviewing", "failed"].includes(tg.status)) {
      return res.status(409).json({
        ok: false,
        error: `当前目标状态为「${tg.status}」，人工登记不适用于该状态`,
      });
    }
    if (action === "confirm_failed" && !["unknown"].includes(tg.status)) {
      return res.status(409).json({
        ok: false,
        error: "登记失败只适用于结果未知（unknown）的目标；已受理/审核中的目标请先到平台确认结果",
      });
    }
    tg.status = action === "confirm_success" ? "success" : "failed";
    tg.verifiedBy = "manual";           // 人工确认，与平台自动核验区分
    tg.verifiedAt = now;
    if (action === "confirm_success") { tg.error = ""; tg.manualConfirmedAt = now; }
    else tg.error = ((req.body && req.body.note) || "") || "人工登记失败";
    tg.history.push({ at: now, action: action === "confirm_success" ? "manual_confirm_success" : "manual_confirm_failed", msg: tg.error, source: "manual" });
    settleTask(task);
    return res.json({ ok: true, target: tg, task: publicTask(task), taskStatus: task.status, taskError: task.error });
  }

  return res.status(400).json({ error: "未知操作，支持 check / confirm_success / confirm_failed" });
});
/* 删除任务：只删本地记录（页面句柄由 RPA 引擎自行回收） */
app.delete("/api/tasks/:groupId", async (req, res) => {
  const i = store.tasks.findIndex((t) => t.groupId === req.params.groupId);
  if (i < 0) return res.status(404).json({ error: "任务不存在" });
  store.tasks.splice(i, 1);
  saveStore();
  res.json({ ok: true });
});

/* 统计（基于本地任务记录） */
app.get("/api/stats", (req, res) => {
  const tasks = store.tasks;
  const byStatus = {};
  const byPlatform = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const targets = t.lastStatus?.targets || [];
    for (const tg of targets) {
      const key = `${tg.platform}`;
      byPlatform[key] = byPlatform[key] || { total: 0, success: 0, failed: 0 };
      byPlatform[key].total++;
      if (tg.status === "success") byPlatform[key].success++;
      if (tg.status === "failed") byPlatform[key].failed++;
    }
  }
  res.json({
    totalTasks: tasks.length,
    scheduled: tasks.filter((t) => t.status === "scheduled").length,
    byStatus,
    byPlatform,
    contents: store.contents.length,
  });
});

/* ---------------- 蚁小二功能融合：素材库 / 违禁词 / 数据看板 ---------------- */

/* 素材库：列出当前数据目录 uploads 下的文件 */
app.get("/api/media", (req, res) => {
  const dir = dataDir.uploads();
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return {
      name,
      path: path.join(dir, name).replace(/\\/g, "/"),
      url: "/uploads/" + encodeURIComponent(name),
      size: st.size,
      mtime: st.mtime.toISOString(),
      isImage: /\.(png|jpe?g|gif|webp|bmp)$/i.test(name),
      isVideo: /\.(mp4|mov|avi|mkv|webm)$/i.test(name),
      isAudio: /\.(mp3|wav|m4a|aac|flac)$/i.test(name),
    };
  }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  res.json({ files });
});
app.delete("/api/media", (req, res) => {
  const name = path.basename(req.query.name || "");
  const file = path.join(dataDir.uploads(), name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

/* 违禁词检测（广告法/平台风控常用词，词库可编辑 data/forbidden-words.txt）
 * 响应 status 字段区分三种情况，前端不允许把「没检测」说成「未检出」：
 *   checked    正常完成检测
 *   unavailable 词库缺失且无法初始化，本次没有检测
 *   skipped    没有提交文本 */
/* 内置默认词库：文件缺失时自动落盘，保证开箱即检；用户编辑过的文件不会被覆盖 */
const DEFAULT_WORDS = [
  "国家级", "世界级", "最高级", "最佳", "第一", "顶级", "极品", "独家", "首创",
  "全网最低", "史上最低", "绝无仅有", "万能", "百分百", "包治", "根治", "无效退款",
  "秒杀", "抢购", "点击领奖", "免费送", "稳赚", "暴利", "零风险", "保本高收益",
  "立即爆单", "躺赚", "日入过万", "永久", "绝对", "国家级认证", "无需审核",
];
function loadWords() {
  const WORDS_FILE = dataDir.wordsFile();
  try {
    return {
      status: "checked",
      words: fs.readFileSync(WORDS_FILE, "utf8").split(/\r?\n/).map((w) => w.trim()).filter(Boolean),
    };
  } catch {
    /* 尝试初始化默认词库（目录已存在则直接写；失败则降级为未检测） */
    try {
      fs.writeFileSync(WORDS_FILE, DEFAULT_WORDS.join("\n") + "\n", "utf8");
      return { status: "checked", words: DEFAULT_WORDS.slice() };
    } catch (e) {
      return { status: "unavailable", words: [], error: e.message };
    }
  }
}
app.post("/api/checkwords", (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.json({ status: "skipped", hits: [] });
  const w = loadWords();
  if (w.status === "unavailable") {
    return res.json({
      status: "unavailable",
      hits: [],
      note: "违禁词词库不可用（data/forbidden-words.txt 无法读取/创建），本次未检测 —— 请检查文件权限或手动创建词库",
    });
  }
  const hits = [];
  for (const word of w.words) {
    const count = (String(text).match(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    if (count) hits.push({ word, count });
  }
  res.json({ status: "checked", words: w.words.length, hits });
});

/* 数据看板：按任务手动登记各平台数据 + 聚合 */
app.post("/api/tasks/:id/metrics/:accountId", (req, res) => {
  const task = store.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "not_found" });
  task.metrics = task.metrics || {};
  task.metrics[req.params.accountId] = {
    reads: Number(req.body.reads) || 0,
    likes: Number(req.body.likes) || 0,
    comments: Number(req.body.comments) || 0,
    shares: Number(req.body.shares) || 0,
    updatedAt: new Date().toISOString(),
  };
  saveStore();
  res.json({ ok: true });
});
app.get("/api/metrics/summary", (req, res) => {
  const byPlatform = {};
  for (const t of store.tasks) {
    if (!t.metrics) continue;
    const targets = t.lastStatus?.targets || [];
    for (const [accountId, m] of Object.entries(t.metrics)) {
      const tg = targets.find((x) => x.accountId === accountId);
      const key = tg?.platform || accountId;
      const s = (byPlatform[key] = byPlatform[key] || { platform: key, reads: 0, likes: 0, comments: 0, shares: 0, entries: 0 });
      s.reads += m.reads || 0;
      s.likes += m.likes || 0;
      s.comments += m.comments || 0;
      s.shares += m.shares || 0;
      s.entries++;
    }
  }
  res.json({ summary: Object.values(byPlatform).sort((a, b) => b.reads - a.reads) });
});

/* ---------------- 账号保活（MultiPost 设置页同款三件套） ---------------- */
let kaRunning = false;
async function runKeepAlive() {
  if (kaRunning) return { skipped: true };
  kaRunning = true;
  try {
    let details = [];
    /* 逐平台打开首页检查登录态（页面即开即关） */
    for (const p of rpa.listPlatforms()) {
      const r = await rpa.checkLogin(p.id).catch((e) => ({ ok: false, error: String(e.message || e) }));
      details.push({
        platform: p.label,
        id: p.id,
        online: !!(r.ok && r.loggedIn),
        error: r.ok ? "" : r.error || "",
        checkedAt: r.checkedAt || new Date().toISOString(),
        method: r.method || "",
        /* 判定规则版本：规则升级后旧结论会被自动作废 */
        judge: LOGIN_JUDGE_VERSION,
      });
    }
    const intervalH = config.keepalive.intervalHours || 4;
    config.kaState = {
      lastRun: new Date().toISOString(),
      lastOnline: details.filter((d) => d.online).length,
      lastTotal: details.length,
      details,
      /* 下一轮时间 = 间隔 ± 10% 随机浮动（更接近真人使用习惯） */
      nextRun: new Date(Date.now() + intervalH * 3600 * 1000 * (0.9 + Math.random() * 0.2)).toISOString(),
    };
    saveConfig();
    return { ok: true, ...config.kaState };
  } finally {
    kaRunning = false;
  }
}
/* 保活调度：每 60 秒检查一次是否到期（测试时可用 NOTEFLY_DISABLE_SCHEDULER=1 关闭） */
if (process.env.NOTEFLY_DISABLE_SCHEDULER !== "1") {
  setInterval(() => {
  const ka = config.keepalive;
  if (!ka || !ka.enabled || kaRunning) return;
  const st = config.kaState || {};
  const next = st.nextRun ? new Date(st.nextRun).getTime() : (st.lastRun ? new Date(st.lastRun).getTime() + (ka.intervalHours || 4) * 3600 * 1000 : 0);
  if (Date.now() >= next) runKeepAlive();
  }, 60 * 1000);
}

app.get("/api/keepalive", (req, res) => {
  const ka = config.keepalive;
  /* 旧规则得出的结论不可信：对外一律抹成 null（= 待检查），
     前端就不会拿旧结论去报「掉线」或算「已登录」 */
  const st = config.kaState || {};
  const details = (st.details || []).map((d) => {
    if (d.checkedAt && d.judge !== LOGIN_JUDGE_VERSION) return { ...d, online: null, outdated: true };
    return { ...d };
  });
  res.json({
    running: kaRunning,
    keepalive: config.keepalive,
    ...st,
    details,
    lastOnline: details.filter((d) => d.online === true).length,
  });
});
app.post("/api/keepalive/config", (req, res) => {
  const { enabled, intervalHours } = req.body || {};
  if (enabled !== undefined) config.keepalive.enabled = !!enabled;
  if ([1, 2, 4, 8, 12, 24].includes(Number(intervalHours))) config.keepalive.intervalHours = Number(intervalHours);
  config.kaState.nextRun = null; // 配置变更后按新间隔重新计算
  saveConfig();
  res.json({ ok: true, keepalive: config.keepalive });
});
app.post("/api/keepalive/run", async (req, res) => {
  const r = await runKeepAlive();
  res.json(r.skipped ? { error: "上一轮巡检仍在执行中，请稍候" } : r);
});

/* ---------------- AI 与文本工具 ----------------
 * 单独模块维护，避免本文件继续膨胀；详见 lib/ai-routes.js。 */
aiRoutes.registerAiRoutes(app, {
  getConfig: () => config,
  saveConfig: () => saveConfig(),
  /* 写作引用记录：内容库模块负责保存，便于追溯「这次用了哪些资料」 */
  saveCitation: (companyId, citation) => library.saveCitation(companyId, citation),
});

/* ---------------- 企业内容库 ----------------
 * 采集、风格档案、检索。详见 lib/library-routes.js。 */
libraryRoutes.registerLibraryRoutes(app, {
  getConfig: () => config,
  getCurrentCompanyId: () => currentCompanyId,
});

/* ---------------- 任务进度与消息中心 ----------------
 * 统一后台任务记录 + 右上角消息中心。详见 lib/progress-routes.js。 */
progressRoutes.registerProgressRoutes(app, {
  getCurrentCompanyId: () => currentCompanyId,
});

/* ---------------- 软件更新 ----------------
 * GitHub Releases 检查、版本历史、跳过与下载/安装入口。详见 lib/update-routes.js。 */
updateRoutes.registerUpdateRoutes(app, {
  getConfig: () => config,
  saveConfig: () => saveConfig(),
  getVersion: () => APP_VERSION,
  /* 只有「桌面版且已打包」（NOTEFLY_FORM=desktop + NOTEFLY_PACKAGED=1，
     由 electron/main.js 在 require 本文件前设置）才允许自动下载安装更新；
     浏览器版与开发态都没有可替换的安装目录，一律引导到发布页。 */
  isDesktop: () =>
    process.env.NOTEFLY_FORM === "desktop" && process.env.NOTEFLY_PACKAGED === "1",
  /* 更新桥（仅桌面版存在，由 electron/main.js 挂在 globalThis 上）：
     服务端收到下载/安装请求后经它直接调 electron-updater。 */
  updateBridge: () => globalThis.NOTEFLY_UPDATE_BRIDGE || null,
});

/* ---------------- 公众号排版 ----------------
 * 模板清单 + Markdown 渲染成公众号内联样式 HTML；详见 lib/gzh-routes.js。 */
gzhRoutes.registerGzhRoutes(app);

/* ---------------- 运行日志 ----------------
 * 设置页「关于」里点版本号 5 下会打开日志面板；详见 lib/log-routes.js。 */
logRoutes.registerLogRoutes(app);

/* ---------------- 启动 ----------------
 * 桌面版（electron/main.js）require 本文件时默认监听 3210；
 * 测试用 NOTEFLY_NO_LISTEN=1 只拿 app 实例，不起端口。 */

/* 浏览器版启动后自动打开浏览器（端口就绪时）。
   桌面版自己开窗口，不受这个开关影响。

   ⚠ 这里**不能**用 `cmd /c start` 开浏览器：cmd.exe 是控制台程序，
     Windows 11 会把它交给「默认终端应用」（本机是 Windows Terminal），
     结果是在 Terminal 里开出一个**可见的 cmd 标签页**，而且 `start` 会
     等到浏览器真正启动才返回 —— 实测这个标签页会挂在屏幕上十几秒。
     改用 GUI 子系统程序唤起系统的 URL 协议处理器，全程零控制台窗口。 */
function openBrowserWhenReady(url) {
  try {
    const { spawn } = require("child_process");
    /* rundll32.exe 与 explorer.exe 都是 GUI 程序，不分配控制台。
       先试 rundll32 的协议处理器（更直接），失败再退回 explorer。 */
    const candidates = [
      { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] },
      { cmd: "explorer.exe", args: [url] },
    ];
    for (const c of candidates) {
      try {
        const child = spawn(c.cmd, c.args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
        return;
      } catch (e) {
        /* 试下一个 */
      }
    }
  } catch (e) {
    /* 打不开浏览器不影响服务本身 */
  }
}

function startServer(port) {
  /* 显式绑定回环地址：app.listen 不传 host 时会监听全部网卡（含局域网），
     本地接口没有鉴权，不能暴露给同网段其它设备（审查报告 P1 安全项） */
  return app.listen(port || PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port || PORT}`;
    console.log(`Dispatch Hub 已启动: ${url}`);
    if (process.env.NOTEFLY_OPEN_BROWSER === "1") {
      openBrowserWhenReady(url);
    }
  });
}

if (process.env.NOTEFLY_NO_LISTEN !== "1") {
  startServer();
}

module.exports = { app, startServer, store, config, dataWarnings, settleTask, applyRpaResult, summarize: taskStatus.summarize, TASK: taskStatus.TASK };
