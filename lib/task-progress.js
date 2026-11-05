/*
 * NoteFly 统一后台任务记录
 * ------------------------------------------------------------
 * 所有「点了按钮要等一会儿」的操作都在这里登记一条任务记录：
 *   采集文章、批量导入、AI 分析、风格学习、检索、写作改写、图片上传、
 *   排版、导出、账号登录检查、发布与核验、备份迁移、更新检查与下载……
 *
 * 设计原则（对应需求「统一显示操作进度」）：
 *  1. 进度必须来自真实状态。拿得到分子分母就写 completed/total，
 *     拿不到就把 total 留空 —— 前端据此显示「不确定进度」，
 *     绝不允许用定时器把 0% 涨到 99% 冒充真实进度。
 *  2. 状态变化即落盘。页面跳转、窗口隐藏后重新打开都能看到真实进度；
 *     重启后从磁盘恢复：跑完的记完成，中断的记「已中断」——
 *     绝不把死掉的任务显示成还在转圈。
 *  3. 每个任务有稳定 taskId。迟到的事件（超时后才回来的回调）带着旧
 *     taskId 到达时会被丢弃，不会覆盖新一轮结果。
 *  4. 取消是「请求取消」：先置 cancelling，等后台真正停下才标 cancelled。
 *     已向平台提交的动作不能靠取消按钮假装撤销（cancellable=false）。
 *
 * 存储位置：<数据目录>/tasks.json —— 跟随数据目录迁移，与备份流程一致。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* 任务状态字典：终态只有四种，中断单独算一种（不是失败，也不是成功） */
const STATUS = {
  PENDING: "pending",     // 已创建还没开始
  RUNNING: "running",     // 执行中
  CANCELLING: "cancelling", // 已请求取消，等后台停下
  SUCCESS: "success",     // 成功
  FAILED: "failed",       // 失败（明确失败）
  CANCELLED: "cancelled", // 已取消（后台确认停下了）
  INTERRUPTED: "interrupted", // 中断：进程重启/崩溃导致，没跑完
};

/* 终态集合：进入终态后不再改状态（除 retry 重新开一条） */
const TERMINAL = new Set([STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCELLED, STATUS.INTERRUPTED]);
/* 活跃态：这些任务占着后台，需要阻止「新的发布任务」并发 */
const ACTIVE = new Set([STATUS.PENDING, STATUS.RUNNING, STATUS.CANCELLING]);

/* 保留策略：活跃任务永不清理；已结束的任务最多留 N 条（更早的只保留摘要） */
const MAX_FINISHED = 200;

/* 内存态 */
let tasks = [];
/* 存储文件路径（每次求值：数据目录可在运行时切换） */
function storeFile() {
  try {
    const dataDir = require("./data-dir");
    return path.join(dataDir.get(), "tasks.json");
  } catch {
    return path.join(process.cwd(), "data", "tasks.json");
  }
}

/* 事件订阅者：任务变化时通知（SSE / 日志 / 消息中心都用得上） */
const listeners = new Set();

/** 订阅任务变化；返回取消订阅函数 */
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(task) {
  for (const fn of listeners) {
    try {
      fn(task);
    } catch {
      /* 订阅者出错不能影响任务流程 */
    }
  }
}

/* ---------------- 持久化 ---------------- */

function load() {
  const file = storeFile();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    tasks = Array.isArray(j.tasks) ? j.tasks : [];
  } catch {
    tasks = [];
  }
  return tasks;
}

let saveTimer = null;
let savePending = false;

/** 落盘：合并短时间内的多次写入，避免高频进度把磁盘打满 */
function save() {
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!savePending) return;
    savePending = false;
    const file = storeFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch {
      /* 落盘失败不能影响主流程：任务状态仍在内存里 */
    }
  }, 150);
  if (saveTimer.unref) saveTimer.unref();
}

/* ---------------- 基础操作 ---------------- */

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return "task_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * 创建一条任务记录
 * @param {{type:string, title:string, companyId?:string, target?:string,
 *          parentId?:string, batchId?:string, total?:number|null,
 *          cancellable?:boolean, retryable?:boolean, stage?:string,
 *          stageNote?:string}} opts
 */
function create(opts) {
  const o = opts || {};
  const t = {
    id: newId(),
    type: String(o.type || "generic"),
    title: String(o.title || "后台任务"),
    /* 所属企业：内容库相关的任务必须带上，消息中心按它隔离 */
    companyId: o.companyId || null,
    /* 任务目标（平台名 / 文件名 / 设备名等），用于列表里看得懂 */
    target: o.target || "",
    /* 父任务：批量导入里的单篇采集挂在批量任务下 */
    parentId: o.parentId || null,
    /* 执行批次：同一批操作共享一个批次号，用于分组统计 */
    batchId: o.batchId || null,
    status: STATUS.PENDING,
    /* 当前阶段标识 + 阶段说明（人话） */
    stage: String(o.stage || "queued"),
    stageNote: String(o.stageNote || "等待开始"),
    /* 完成量 / 总量：total 为 null 表示总量未知 → 不确定进度 */
    completed: 0,
    total: o.total === undefined ? null : (o.total === null ? null : Number(o.total)),
    startedAt: null,
    updatedAt: nowIso(),
    finishedAt: null,
    result: null,
    error: "",
    errorDetail: "",
    /* 能否取消：已向平台提交的操作不能靠取消按钮假装撤销 */
    cancellable: o.cancellable === undefined ? true : !!o.cancellable,
    /* 能否重试 */
    retryable: o.retryable === undefined ? true : !!o.retryable,
    /* 重试自哪条任务 */
    retryOf: o.retryOf || null,
    /* 跳转到任务所在页面的路由名 */
    route: o.route || "",
  };
  tasks.unshift(t);
  trim();
  save();
  emit(t);
  return t;
}

/**
 * 更新任务
 * @param {string} id
 * @param {Object} patch 支持 stage/stageNote/completed/total/status/result/error...
 * @param {{silent?:boolean}} opts silent=true 时不触发订阅者（用于批量合并）
 */
function update(id, patch, opts) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  const p = patch || {};
  const prevStatus = t.status;

  for (const k of Object.keys(p)) {
    if (k === "id") continue;
    t[k] = p[k];
  }
  t.updatedAt = nowIso();

  /* 状态机约束：终态任务不再被普通更新改状态（要改请显式传 status 且任务未终结） */
  if (TERMINAL.has(prevStatus) && p.status && p.status !== prevStatus) {
    t.status = prevStatus;
  }
  /* 进入终态时补结束时间 */
  if (TERMINAL.has(t.status) && !t.finishedAt) t.finishedAt = nowIso();
  /* 离开终态（比如 retry 重开）时清掉结束时间 */
  if (!TERMINAL.has(t.status) && t.finishedAt) t.finishedAt = null;

  /* 进度不能倒退，也不能超过总量 */
  if (typeof t.completed === "number") {
    if (t.completed < 0) t.completed = 0;
    if (typeof t.total === "number" && t.total >= 0 && t.completed > t.total) t.completed = t.total;
  }
  if (t.total !== null && t.total !== undefined && typeof t.total !== "number") t.total = null;

  trim();
  save();
  if (!(opts && opts.silent)) emit(t);
  return t;
}

/** 设置阶段（阶段说明 + 阶段标识） */
function setStage(id, stage, stageNote, extra) {
  return update(id, Object.assign({ stage, stageNote: stageNote || "" }, extra || {}));
}

/** 推进完成量：increment 为正数，total 已知时自动夹住 */
function advance(id, increment, extra) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  const cur = typeof t.completed === "number" ? t.completed : 0;
  let next = cur + (Number(increment) || 0);
  if (typeof t.total === "number" && t.total >= 0 && next > t.total) next = t.total;
  return update(id, Object.assign({ completed: next }, extra || {}));
}

/** 结束任务（成功） */
function succeed(id, result) {
  return update(id, {
    status: STATUS.SUCCESS,
    stage: "done",
    stageNote: "已完成",
    result: result === undefined ? null : result,
    error: "",
  });
}

/** 结束任务（失败）：error 是给人看的一句话，errorDetail 可放原始错误 */
function fail(id, error, detail) {
  return update(id, {
    status: STATUS.FAILED,
    stage: "failed",
    stageNote: String(error || "执行失败"),
    error: String(error || "执行失败").slice(0, 400),
    errorDetail: detail === undefined ? "" : String(detail).slice(0, 2000),
  });
}

/**
 * 请求取消：只置 cancelling，不直接标 cancelled。
 * 后台真正停下后由调用方调 finishCancel。
 */
function requestCancel(id, reason) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: "任务不存在" };
  if (TERMINAL.has(t.status)) return { ok: false, error: "任务已结束" };
  if (!t.cancellable) return { ok: false, error: "该操作已提交到外部平台，无法用取消撤销" };
  t.status = STATUS.CANCELLING;
  t.stage = "cancelling";
  t.stageNote = reason || "正在停止…";
  t.updatedAt = nowIso();
  save();
  emit(t);
  return { ok: true, task: t };
}

/** 确认取消：后台已停下 */
function finishCancel(id, note) {
  return update(id, {
    status: STATUS.CANCELLED,
    stage: "cancelled",
    stageNote: note || "已取消",
    finishedAt: nowIso(),
  });
}

/** 中断：进程重启/崩溃导致 */
function markInterrupted(id, reason) {
  return update(id, {
    status: STATUS.INTERRUPTED,
    stage: "interrupted",
    stageNote: reason || "执行被中断",
    error: reason || "执行被中断",
  });
}

function get(id) {
  return tasks.find((x) => x.id === id) || null;
}

/**
 * 列出任务
 * @param {{active?:boolean, type?:string, companyId?:string, limit?:number}} opts
 */
function list(opts) {
  const o = opts || {};
  let out = tasks.slice();
  if (o.active) out = out.filter((t) => ACTIVE.has(t.status));
  if (o.type) out = out.filter((t) => t.type === o.type);
  if (o.companyId) out = out.filter((t) => t.companyId === o.companyId);
  if (o.parentId) out = out.filter((t) => t.parentId === o.parentId);
  if (o.batchId) out = out.filter((t) => t.batchId === o.batchId);
  const limit = Math.max(1, Math.min(Number(o.limit) || 100, 500));
  return out.slice(0, limit);
}

/** 统计：进行中 / 已完成 / 失败 / 已取消 / 中断 */
function stats() {
  const s = { active: 0, success: 0, failed: 0, cancelled: 0, interrupted: 0, pending: 0 };
  for (const t of tasks) {
    if (t.status === STATUS.RUNNING || t.status === STATUS.CANCELLING) s.active++;
    else if (t.status === STATUS.PENDING) s.pending++;
    else if (t.status === STATUS.SUCCESS) s.success++;
    else if (t.status === STATUS.FAILED) s.failed++;
    else if (t.status === STATUS.CANCELLED) s.cancelled++;
    else if (t.status === STATUS.INTERRUPTED) s.interrupted++;
  }
  return s;
}

/** 清理：只删老的已结束任务，活跃任务永不删 */
function trim() {
  if (tasks.length <= MAX_FINISHED * 2) return;
  const finished = tasks.filter((t) => TERMINAL.has(t.status));
  const excess = finished.length - MAX_FINISHED;
  if (excess <= 0) return;
  const drop = new Set(finished.slice(-excess).map((t) => t.id));
  tasks = tasks.filter((t) => !drop.has(t.id));
}

/** 删除一条任务记录（只允许删已结束的） */
function remove(id) {
  const t = get(id);
  if (!t) return { ok: false, error: "任务不存在" };
  if (!TERMINAL.has(t.status)) return { ok: false, error: "任务还在进行中，不能删除" };
  tasks = tasks.filter((x) => x.id !== id);
  save();
  return { ok: true };
}

/** 清空已结束的任务记录（活跃的保留） */
function clearFinished() {
  const before = tasks.length;
  tasks = tasks.filter((t) => !TERMINAL.has(t.status));
  save();
  return { ok: true, removed: before - tasks.length };
}

/**
 * 启动恢复：把「上次进程还在跑」的任务标记为中断。
 * 绝不能把已经死掉的任务显示成还在运行 —— 那会让用户一直等一个永远不会
 * 完成的进度条。
 *
 * 注意：本函数只处理当前内存里的任务记录，不负责从磁盘加载。
 * 磁盘加载由 load()/init() 负责 —— 两者混在一起会在运行中把内存态冲掉。
 */
function restoreInterrupted() {
  let n = 0;
  for (const t of tasks) {
    if (t.status === STATUS.RUNNING || t.status === STATUS.CANCELLING || t.status === STATUS.PENDING) {
      t.status = STATUS.INTERRUPTED;
      t.stage = "interrupted";
      t.stageNote = "上次运行被中断（应用退出或崩溃），需要重新执行";
      t.error = "上次运行中断，未完成";
      t.finishedAt = t.finishedAt || nowIso();
      t.updatedAt = nowIso();
      n++;
    }
  }
  if (n) save();
  return { interrupted: n };
}

/** 同步落盘：模拟「进程写完状态后崩溃」的测试场景 */
function flush() {
  const file = storeFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* 落盘失败不影响主流程 */
  }
  return true;
}

/**
 * 重试：基于旧任务创建一条新任务（旧的保留，便于追溯）
 * 需要调用方提供 createFn（真正干活的逻辑在路由层）
 */
function retrySource(id) {
  const t = get(id);
  if (!t) return null;
  return {
    type: t.type,
    title: t.title,
    companyId: t.companyId,
    target: t.target,
    parentId: t.parentId,
    batchId: t.batchId,
    total: t.total,
    retryOf: t.id,
  };
}

function init() {
  /* 先从磁盘恢复（上次进程留下的记录），再把「在跑」的标成中断 */
  load();
  const r = restoreInterrupted();
  return r;
}

module.exports = {
  STATUS,
  TERMINAL,
  ACTIVE,
  MAX_FINISHED,
  init,
  restoreInterrupted,
  flush,
  load,
  create,
  update,
  setStage,
  advance,
  succeed,
  fail,
  requestCancel,
  finishCancel,
  markInterrupted,
  get,
  list,
  stats,
  remove,
  clearFinished,
  retrySource,
  subscribe,
  storeFile,
};
