/*
 * NoteFly 任务进度与消息中心路由
 * ------------------------------------------------------------
 *   GET  /api/progress/tasks        任务列表（可按企业/类型/活跃过滤）
 *   GET  /api/progress/tasks/:id    单条任务
 *   POST /api/progress/tasks/:id/cancel  请求取消（返回 ok=false 说明不可取消）
 *   DELETE /api/progress/tasks/:id  删除已结束任务
 *   POST /api/progress/clear        清理已结束任务
 *   GET  /api/messages              消息列表
 *   POST /api/messages/:id/read     标记已读
 *   POST /api/messages/read-all     全部已读
 *   DELETE /api/messages/:id        删除消息
 *   GET  /api/progress/stream       SSE：任务与消息变化实时推送
 *
 * SSE 断线时前端会自动回落到有界轮询，两条路都能拿到真实状态。
 */
"use strict";

const taskProgress = require("./task-progress");
const messages = require("./messages");
const logger = require("./logger");

function registerProgressRoutes(app, ctx) {
  const getCompanyId = () => {
    const c = ctx && typeof ctx.getCurrentCompanyId === "function" ? ctx.getCurrentCompanyId() : null;
    return c || null;
  };

  /* ---------------- 任务 ---------------- */

  app.get("/api/progress/tasks", (req, res) => {
    const q = req.query || {};
    const tasks = taskProgress.list({
      active: q.active === "1" || q.active === "true",
      type: q.type || "",
      companyId: q.companyId || "",
      parentId: q.parentId || "",
      batchId: q.batchId || "",
      limit: Number(q.limit) || 100,
    });
    res.json({ tasks, stats: taskProgress.stats() });
  });

  app.get("/api/progress/tasks/:id", (req, res) => {
    const t = taskProgress.get(req.params.id);
    if (!t) return res.status(404).json({ error: "任务不存在" });
    res.json({ task: t });
  });

  app.post("/api/progress/tasks/:id/cancel", (req, res) => {
    const t = taskProgress.get(req.params.id);
    if (!t) return res.status(404).json({ error: "任务不存在" });
    /* 不可取消的操作（已提交到平台）必须明确拒绝，不能假装能撤 */
    const r = taskProgress.requestCancel(req.params.id, "正在停止…");
    if (!r.ok) return res.status(409).json(r);
    logger.info("任务进度", `请求取消任务「${t.title}」`, { 任务号: t.id });
    res.json(r);
  });

  app.delete("/api/progress/tasks/:id", (req, res) => {
    const r = taskProgress.remove(req.params.id);
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  });

  app.post("/api/progress/clear", (req, res) => {
    res.json(taskProgress.clearFinished());
  });

  /* ---------------- 消息 ---------------- */

  app.get("/api/messages", (req, res) => {
    const q = req.query || {};
    const companyId = q.companyId === "global" ? null : (q.companyId || getCompanyId());
    const r = messages.list({
      companyId: companyId || undefined,
      includeGlobal: q.includeGlobal !== "0",
      type: q.type || "",
      level: q.level || "",
      unreadOnly: q.unreadOnly === "1" || q.unreadOnly === "true",
      limit: Number(q.limit) || 50,
      offset: Number(q.offset) || 0,
    });
    res.json(Object.assign({}, r, { unread: messages.unreadCount(companyId) }));
  });

  app.post("/api/messages/:id/read", (req, res) => {
    const r = messages.markRead(req.params.id);
    if (!r.ok) return res.status(404).json(r);
    res.json(r);
  });

  app.post("/api/messages/read-all", (req, res) => {
    const companyId = (req.body && req.body.companyId) || getCompanyId();
    res.json(messages.markAllRead(companyId));
  });

  app.delete("/api/messages/:id", (req, res) => {
    const r = messages.remove(req.params.id);
    if (!r.ok) return res.status(404).json(r);
    res.json(r);
  });

  /* ---------------- SSE：真实状态推送 ---------------- */
  /* 前端优先走 SSE；连不上再回落有界轮询。两条路读的是同一份状态。 */
  app.get("/api/progress/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders && res.flushHeaders();

    /* 先发一条握手，浏览器 EventSource 收到后才算连上 */
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);

    const onTask = (t) => {
      try {
        res.write(`event: task\ndata: ${JSON.stringify(t)}\n\n`);
      } catch { /* 写失败说明连接已断 */ }
    };
    const onMsg = (m) => {
      try {
        res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      } catch { /* 同上 */ }
    };
    const un1 = taskProgress.subscribe(onTask);
    const un2 = messages.subscribe(onMsg);

    /* 心跳：避免代理把长时间静默的连接掐掉 */
    const hb = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch { /* 忽略 */ }
    }, 25000);
    if (hb.unref) hb.unref();

    req.on("close", () => {
      clearInterval(hb);
      un1();
      un2();
      try { res.end(); } catch { /* 已断开 */ }
    });
  });
}

module.exports = { registerProgressRoutes };
