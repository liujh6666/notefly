/*
 * 运行日志路由
 * ------------------------------------------------------------
 *   GET  /api/logs          日志列表（可按级别 / 关键词过滤）
 *   GET  /api/logs/stats    日志概况（各级别计数、文件位置）
 *   GET  /api/logs/export   导出为纯文本（下载）
 *   POST /api/logs/clear    清空日志
 *   POST /api/logs/client   前端报错上报（window.onerror / unhandledrejection）
 *
 * 约定：
 *   - 失败一律回 { ok:false, error:"可读中文原因" }；
 *   - 列表默认只回最近 200 条，最多 2000 条 —— 日志可能很大，不能一次全吐给前端。
 */
"use strict";

const logger = require("./logger");

function registerLogRoutes(app) {
  /* 列表 */
  app.get("/api/logs", (req, res) => {
    try {
      const q = req.query || {};
      const entries = logger.list({
        limit: Number(q.limit) || 200,
        level: q.level || "",
        keyword: q.keyword || "",
        scope: q.scope || "",
      });
      res.json({
        ok: true,
        entries,
        stats: logger.stats(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: "读取日志失败：" + String((e && e.message) || e) });
    }
  });

  /* 概况 */
  app.get("/api/logs/stats", (req, res) => {
    try {
      res.json({ ok: true, stats: logger.stats() });
    } catch (e) {
      res.status(500).json({ ok: false, error: "读取日志概况失败：" + String((e && e.message) || e) });
    }
  });

  /* 导出纯文本 */
  app.get("/api/logs/export", (req, res) => {
    try {
      const q = req.query || {};
      const text = logger.toText({
        limit: Number(q.limit) || 5000,
        level: q.level || "",
        keyword: q.keyword || "",
      });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="notefly-log-${stamp}.txt"`);
      res.send(text || "（暂无日志）");
    } catch (e) {
      res.status(500).json({ ok: false, error: "导出日志失败：" + String((e && e.message) || e) });
    }
  });

  /* 清空 */
  app.post("/api/logs/clear", (req, res) => {
    try {
      const r = logger.clear();
      res.json({ ok: true, removed: r.removed, stats: logger.stats() });
    } catch (e) {
      res.status(500).json({ ok: false, error: "清空日志失败：" + String((e && e.message) || e) });
    }
  });

  /* 前端报错上报：界面里的 JS 异常也要能查 */
  app.post("/api/logs/client", (req, res) => {
    const b = req.body || {};
    const level = b.level === "error" ? "error" : b.level === "warn" ? "warn" : "info";
    const e = logger.write(level, b.scope || "界面", b.message || "前端未捕获异常", {
      url: b.url || "",
      line: b.line,
      column: b.column,
      stack: b.stack ? String(b.stack).slice(0, 1200) : "",
    });
    res.json({ ok: true, id: e.ts });
  });
}

module.exports = { registerLogRoutes };
