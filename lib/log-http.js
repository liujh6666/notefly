/*
 * HTTP 访问日志中间件
 * ------------------------------------------------------------
 * 目的：把「用户做了什么操作」和「哪里报错了」都记下来。
 *
 * 分级规则（决定日志面板默认看到什么）：
 *   写操作（POST/PUT/DELETE）  → info   「保存内容」「发布到草稿箱」…
 *   读操作（GET）              → debug  「打开内容库」「查账号列表」…
 *   4xx                       → warn   参数错、找不到内容
 *   5xx / 异常                → error  服务端炸了
 *
 * 两条重要取舍：
 *  1. 轮询接口不记 —— 前端每 2.5 秒轮询一次任务、每 15 秒轮询一次引擎状态，
 *     照记的话一天能写几千条，把真正的操作淹没掉。纯读取且无副作用的轮询直接跳过。
 *  2. 日志接口自己不记 —— 否则「打开日志面板」这个动作会一直往日志里写，
 *     面板永远在动，看着像卡住了。
 */

"use strict";

const logger = require("./logger");

/* 纯读取的高频轮询接口：跳过，避免淹没真正的操作 */
const POLL_SKIP = [
  { exact: "/api/tasks" },
  { exact: "/api/stats" },
  { exact: "/api/config" },
  { exact: "/api/ai/config" },
  { exact: "/api/keepalive" },
  { prefix: "/api/tasks/" },   /* /api/tasks/:groupId/status */
];

/* 日志相关接口：自身不记 */
const LOG_SKIP = [
  { exact: "/api/logs" },
  { exact: "/api/logs/stats" },
  { exact: "/api/logs/export" },
  { exact: "/api/logs/clear" },
  { exact: "/api/logs/client" },
];

function hit(list, p) {
  for (const r of list) {
    if (r.exact && r.exact === p) return true;
    if (r.prefix && p.startsWith(r.prefix)) return true;
  }
  return false;
}

/** 只在有意义的接口上挂日志 */
function shouldLog(pathname) {
  if (!pathname.startsWith("/api/")) return false;
  if (hit(LOG_SKIP, pathname)) return false;
  if (hit(POLL_SKIP, pathname)) return false;
  return true;
}

/** 请求体的简短摘要：只留键名，不留正文（正文可能几十 MB） */
function bodySummary(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (!keys.length) return undefined;
  const out = { 字段: keys.slice(0, 20) };
  /* 少量有信息量的短字段可以留值（会被脱敏） */
  for (const k of ["title", "platform", "mode", "action", "subAction", "level", "preset", "model", "kind"]) {
    if (typeof body[k] === "string" && body[k].length <= 120) out[k] = body[k];
  }
  return out;
}

/**
 * Express 中间件
 * @param {Function} getScope 可选：把路径翻译成中文分区名
 */
function logHttpMiddleware(getScope) {
  return function logHttp(req, res, next) {
    const started = Date.now();
    if (!shouldLog(req.path)) return next();

    let scope = "接口";
    try {
      if (typeof getScope === "function") scope = getScope(req) || scope;
    } catch {
      /* 分类失败不影响记录 */
    }

    res.on("finish", () => {
      const ms = Date.now() - started;
      const status = res.statusCode || 0;
      const method = req.method;
      const path = req.originalUrl.split("?")[0];
      const extra = bodySummary(req.body);
      if (extra) extra.耗时 = ms + "ms";

      /* 4xx/5xx 一定要带上方法与路径，否则看不出是哪一步错了 */
      const tail = `${method} ${path} → ${status}`;
      if (status >= 500) {
        logger.error(scope, tail, extra);
      } else if (status >= 400) {
        logger.warn(scope, tail, extra);
      } else if (method === "GET") {
        logger.debug(scope, tail, extra);
      } else {
        logger.info(scope, tail, extra);
      }
    });

    /* 响应本身抛错（响应头已发出等）：兜底记一条 error */
    res.on("close", () => {
      if (!res.writableEnded) {
        logger.error(scope, `${req.method} ${req.originalUrl.split("?")[0]} → 响应未正常结束（连接中断）`);
      }
    });

    next();
  };
}

module.exports = { logHttpMiddleware, shouldLog, bodySummary };
