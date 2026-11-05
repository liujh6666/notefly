/*
 * NoteFly 消息中心
 * ------------------------------------------------------------
 * 把「该让用户知道的事」集中到一个地方：更新提醒、下载完成、安装结果、
 * 采集结果、AI 生成结果、导出结果、发布结果与失败。
 *
 * 设计原则（对应需求「右上角消息中心」）：
 *  1. 一条消息必须带：类型、标题、简要说明、发生时间、已读状态、
 *     可用的操作入口。没有处理入口的报错等于没报。
 *  2. 任务每次阶段变化只更新进度，不刷出几十条消息。消息只在
 *     「阶段完成 / 出结果 / 出错」这类节点产生。
 *  3. 稳定事件 ID 去重：同一次操作的重试、重复检查、重启后恢复，
 *     都不会产生第二条消息。
 *  4. 企业内容库的消息按企业隔离；软件更新消息全局可见。
 *  5. 已读状态与未读数本地持久化 —— 重启后还在。
 *
 * 存储位置：<数据目录>/messages.json —— 跟随数据目录迁移。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* 消息类型 */
const TYPE = {
  UPDATE: "update",           // 软件更新
  COLLECT: "collect",         // 内容采集
  ANALYSIS: "analysis",       // AI 分析 / 风格学习
  GENERATE: "generate",       // AI 写作 / 改写
  EXPORT: "export",           // 导出 / 复制
  PUBLISH: "publish",         // 发布与核验
  ACCOUNT: "account",         // 账号登录
  SYSTEM: "system",           // 备份、迁移等系统操作
  ERROR: "error",             // 兜底错误
};

/* 级别：决定角标颜色 */
const LEVEL = { INFO: "info", SUCCESS: "success", WARNING: "warning", ERROR: "error" };

/* 保留策略：最多保留的消息条数（更早的清理掉）
   注意：只清理消息本身，绝不碰稿件、内容库或正在执行的任务 */
const MAX_MESSAGES = 500;

/* 内存态 */
let messages = [];
/* 事件订阅者（用于 SSE 推送） */
const listeners = new Set();

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(msg) {
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch {
      /* 订阅者出错不影响消息落库 */
    }
  }
}

function storeFile() {
  try {
    const dataDir = require("./data-dir");
    return path.join(dataDir.get(), "messages.json");
  } catch {
    return path.join(process.cwd(), "data", "messages.json");
  }
}

/* ---------------- 持久化 ---------------- */

function load() {
  const file = storeFile();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    messages = Array.isArray(j.messages) ? j.messages : [];
  } catch {
    messages = [];
  }
  return messages;
}

let saveTimer = null;
let savePending = false;

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
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages }, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }, 150);
  if (saveTimer.unref) saveTimer.unref();
}

/* ---------------- 写入 ---------------- */

function nowIso() {
  return new Date().toISOString();
}

/**
 * 追加一条消息
 * @param {{eventId?:string, type:string, level?:string, title:string,
 *          summary?:string, detail?:string, companyId?:string|null,
 *          action?:{label:string, kind?:string, payload?:object},
 *          meta?:object, at?:string}} opts
 * @returns {object|null} eventId 重复时返回已有消息（不新增）
 */
function push(opts) {
  const o = opts || {};
  const type = o.type || TYPE.SYSTEM;
  /* 企业隔离：companyId 为空表示全局消息（软件更新等） */
  const companyId = o.companyId || null;
  /* 稳定事件 ID：没给就用「类型+标题+时间桶」兜底 */
  const eventId = String(o.eventId || `${type}:${companyId || "global"}:${o.title || ""}:${Date.now()}`);

  /* 去重：同一 eventId 只保留一条（后写的覆盖先写的，例如重试后状态更新） */
  const exist = messages.find((m) => m.eventId === eventId);
  if (exist) {
    /* 已读状态保留：重复事件不该把用户已读的消息重新标成未读 */
    const wasRead = exist.read;
    Object.assign(exist, {
      type,
      level: o.level || exist.level || LEVEL.INFO,
      title: o.title || exist.title,
      summary: o.summary === undefined ? exist.summary : o.summary,
      detail: o.detail === undefined ? exist.detail : o.detail,
      action: o.action === undefined ? exist.action : o.action,
      meta: o.meta === undefined ? exist.meta : o.meta,
      at: o.at || nowIso(),
      read: wasRead,
      updatedAt: nowIso(),
    });
    save();
    emit(exist);
    return exist;
  }

  const msg = {
    id: "msg_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    eventId,
    type,
    level: o.level || LEVEL.INFO,
    title: String(o.title || "").slice(0, 200),
    summary: String(o.summary || "").slice(0, 600),
    detail: String(o.detail || "").slice(0, 4000),
    /* null = 全局可见（更新）；有值 = 只在该企业下可见 */
    companyId,
    action: o.action || null,
    meta: o.meta || null,
    at: o.at || nowIso(),
    updatedAt: nowIso(),
    read: false,
  };
  messages.unshift(msg);
  trim();
  save();
  emit(msg);
  return msg;
}

/**
 * 更新一条已有消息（阶段变化只更新内容，不新增）
 */
function patch(eventId, fields) {
  const m = messages.find((x) => x.eventId === eventId);
  if (!m) return null;
  Object.assign(m, fields || {});
  m.updatedAt = nowIso();
  save();
  emit(m);
  return m;
}

/** 按 id 找消息 */
function get(id) {
  return messages.find((m) => m.id === id || m.eventId === id) || null;
}

/**
 * 列出消息
 * @param {{companyId?:string|null, includeGlobal?:boolean, type?:string,
 *          level?:string, unreadOnly?:boolean, limit?:number, offset?:number}} opts
 */
function list(opts) {
  const o = opts || {};
  let out = messages.slice();
  /* 企业隔离：企业消息只在对应企业下可见；全局消息对所有企业可见 */
  if (o.companyId) {
    out = out.filter((m) => !m.companyId || m.companyId === o.companyId);
  } else if (o.includeGlobal === false) {
    out = out.filter((m) => !m.companyId);
  }
  if (o.type) out = out.filter((m) => m.type === o.type);
  if (o.level) out = out.filter((m) => m.level === o.level);
  if (o.unreadOnly) out = out.filter((m) => !m.read);
  const total = out.length;
  const offset = Math.max(0, Number(o.offset) || 0);
  const limit = Math.max(1, Math.min(Number(o.limit) || 50, 500));
  return { items: out.slice(offset, offset + limit), total, unread: unreadCount(o.companyId) };
}

/** 未读数：可按企业过滤（全局消息对所有企业计入） */
function unreadCount(companyId) {
  return messages.filter((m) => {
    if (m.read) return false;
    if (companyId && m.companyId && m.companyId !== companyId) return false;
    return true;
  }).length;
}

/** 标记已读 */
function markRead(id) {
  const m = get(id);
  if (!m) return { ok: false, error: "消息不存在" };
  m.read = true;
  m.readAt = nowIso();
  save();
  emit(m);
  return { ok: true, message: m };
}

/** 全部标记已读 */
function markAllRead(companyId) {
  let n = 0;
  for (const m of messages) {
    if (companyId && m.companyId && m.companyId !== companyId) continue;
    if (m.read) continue;
    m.read = true;
    m.readAt = nowIso();
    n++;
  }
  if (n) save();
  return { ok: true, marked: n };
}

/** 删除一条消息 */
function remove(id) {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return { ok: false, error: "消息不存在" };
  messages.splice(i, 1);
  save();
  return { ok: true };
}

/** 清理旧消息：只删超出上限的已读消息，未读的保留 */
function trim() {
  if (messages.length <= MAX_MESSAGES) return;
  const excess = messages.length - MAX_MESSAGES;
  let removed = 0;
  for (let i = messages.length - 1; i >= 0 && removed < excess; i--) {
    if (messages[i].read) {
      messages.splice(i, 1);
      removed++;
    }
  }
}

function clear() {
  messages = [];
  save();
  return { ok: true };
}

function init() {
  load();
  return messages.length;
}

module.exports = {
  TYPE,
  LEVEL,
  MAX_MESSAGES,
  init,
  push,
  patch,
  get,
  list,
  unreadCount,
  markRead,
  markAllRead,
  remove,
  clear,
  subscribe,
  storeFile,
};
