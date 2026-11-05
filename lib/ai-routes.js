/*
 * AI 与文本工具的服务端路由
 * ------------------------------------------------------------
 * 独立成模块，避免 server.js 继续膨胀。职责：
 *   /api/ai/config     读取 / 保存模型配置（Key 只回掩码）
 *   /api/ai/test       连通性测试
 *   /api/ai/run        统一的生成入口（写作 / 续写 / 改写 / 深度去 AI 味）
 *   /api/text/format   一键排版（纯本地规则，离线可用）
 *   /api/text/humanize 一键去 AI 味（纯本地规则，离线可用）
 *   /api/text/analyze  AI 味体检（只检测不改）
 *
 * 约定：
 *   - 失败一律回 { ok:false, error:"可读中文原因" }，不吐堆栈；
 *   - 模型配置缺失属于「未配置」而非「服务出错」，用 400 而不是 500；
 *   - 上游模型服务失败用 502，方便前端区分。
 */
"use strict";

const ai = require("./ai");
const prompts = require("./ai-prompts");
const textTools = require("./text-tools");
const textDiff = require("./text-diff");
const logger = require("./logger");
const writingContext = require("./writing-context");
const taskProgress = require("./task-progress");
const messages = require("./messages");

/* 默认配置：首次启动时用这些字段 */
function defaultAiConfig() {
  return {
    enabled: false,
    preset: "custom",
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.7,
    maxTokens: 4096,
    timeoutSec: 180,
  };
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function registerAiRoutes(app, ctx) {
  const getConfig = ctx.getConfig;
  const saveConfig = ctx.saveConfig;
  /* 内容库引用记录：有则保存，便于追溯「这次用了哪些资料」 */
  const saveCitation = typeof ctx.saveCitation === "function" ? ctx.saveCitation : null;

  /* 取出当前 AI 配置并补齐缺省字段 */
  function aiConfig() {
    const c = getConfig();
    if (!c.ai || typeof c.ai !== "object") c.ai = defaultAiConfig();
    const d = defaultAiConfig();
    for (const k of Object.keys(d)) if (c.ai[k] === undefined || c.ai[k] === null) c.ai[k] = d[k];
    return c.ai;
  }

  /** 组装给 ai.chat 用的客户端配置 */
  function clientConfig(c) {
    return {
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
    };
  }

  /* ---------------- 配置 ---------------- */

  app.get("/api/ai/config", (req, res) => {
    const c = aiConfig();
    res.json({
      ok: true,
      enabled: !!c.enabled,
      preset: c.preset || "custom",
      baseUrl: c.baseUrl || "",
      model: c.model || "",
      hasKey: !!c.apiKey,
      keyMasked: ai.maskKey(c.apiKey),
      temperature: c.temperature,
      maxTokens: c.maxTokens,
      timeoutSec: c.timeoutSec,
      ready: !!(ai.normalizeBaseUrl(c.baseUrl) && c.model),
      /* connected = 真正接入（地址+模型+该服务要的 Key 都到位），
         前端用它决定 AI 功能是否可用 —— 与 ready（配置齐全）不是一回事 */
      connected: ai.isConnected(c),
      presets: ai.PRESETS,
      styles: prompts.STYLES,
      rewriteActions: prompts.REWRITE_ACTIONS,
    });
  });

  app.post("/api/ai/config", (req, res) => {
    const b = req.body || {};
    const c = aiConfig();
    if (b.baseUrl !== undefined) {
      const u = String(b.baseUrl || "").trim();
      if (u && !/^https?:\/\//i.test(u)) {
        return res.status(400).json({ error: "服务地址必须以 http:// 或 https:// 开头" });
      }
      c.baseUrl = u;
    }
    if (b.apiKey !== undefined && b.apiKey !== "") c.apiKey = String(b.apiKey);
    if (b.clearKey) c.apiKey = "";
    if (b.model !== undefined) c.model = String(b.model || "").trim();
    if (b.preset !== undefined) c.preset = String(b.preset || "custom");
    if (b.enabled !== undefined) c.enabled = !!b.enabled;
    if (b.temperature !== undefined) c.temperature = clampNumber(b.temperature, 0, 2, 0.7);
    if (b.maxTokens !== undefined) c.maxTokens = clampNumber(b.maxTokens, 256, 32768, 4096);
    if (b.timeoutSec !== undefined) c.timeoutSec = clampNumber(b.timeoutSec, 10, 600, 180);

    try {
      saveConfig();
    } catch (e) {
      logger.error("AI 模型", `配置保存失败：${String(e.message || e)}`);
      return res.status(500).json({ error: "配置保存失败（磁盘写入异常）：" + String(e.message || e) });
    }
    logger.info("AI 模型", `保存模型配置（预设 ${c.preset || "custom"}，模型 ${c.model || "未填"}）`, {
      已填Key: !!c.apiKey,
      已启用: !!c.enabled,
    });
    res.json({
      ok: true,
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      model: c.model,
      preset: c.preset,
      hasKey: !!c.apiKey,
      keyMasked: ai.maskKey(c.apiKey),
      ready: !!(ai.normalizeBaseUrl(c.baseUrl) && c.model),
      connected: ai.isConnected(c),
    });
  });

  /* ---------------- 断开 AI ---------------- */
  /* 清掉 Key、地址与模型，回到「完全未接入」：AI 相关按钮重新置灰，
     但保留服务预设，用户重新接入时地址与模型可以一键回填，只差一个 Key。 */
  app.post("/api/ai/disconnect", (req, res) => {
    const c = aiConfig();
    c.apiKey = "";
    c.baseUrl = "";
    c.model = "";
    c.enabled = false;
    try {
      saveConfig();
    } catch (e) {
      logger.error("AI 模型", `断开 AI 失败：${String(e.message || e)}`);
      return res.status(500).json({ error: "断开失败（磁盘写入异常）：" + String(e.message || e) });
    }
    logger.info("AI 模型", "已断开 AI，AI 功能回到未接入状态");
    res.json({
      ok: true,
      preset: c.preset || "custom",
      hasKey: false,
      keyMasked: "",
      ready: false,
      connected: false,
    });
  });

  /* ---------------- 连通性测试 ---------------- */

  app.post("/api/ai/test", async (req, res) => {
    const body = req.body || {};
    const c = aiConfig();
    /* 允许用请求里的临时配置测试（用户在设置页改完还没保存就能试） */
    const cfg = {
      baseUrl: body.baseUrl !== undefined ? body.baseUrl : c.baseUrl,
      apiKey: body.apiKey !== undefined && body.apiKey !== "" ? body.apiKey : c.apiKey,
      model: body.model !== undefined && body.model !== "" ? body.model : c.model,
    };
    if (!ai.normalizeBaseUrl(cfg.baseUrl)) {
      return res.status(400).json({ error: "没有配置模型服务地址，请先填写" });
    }
    if (!cfg.model) return res.status(400).json({ error: "没有填写模型名，请先填写" });
    const r = await ai.testConnection(cfg);
    if (!r.ok) {
      logger.error("AI 模型", `连通性测试失败：${r.error}`, { 模型: cfg.model });
      return res.status(502).json({ error: r.error });
    }
    logger.info("AI 模型", `连通性测试通过（模型 ${cfg.model}）`);
    res.json({ ok: true, message: "连通正常，模型返回：" + String(r.content || "").slice(0, 60), model: r.model });
  });

  /* ---------------- 统一生成入口 ---------------- */

  app.post("/api/ai/run", async (req, res) => {
    const body = req.body || {};
    const action = String(body.action || "").trim();
    const c = aiConfig();

    /* ---------- 企业内容库上下文（每次正文生成前都走一遍） ----------
       起稿 / 续写 / 改写 / 重新生成都从这里进，不存在「只第一次参考」的情况。
       这一段放在 AI 配置检查之前：资料不足是内容层面的问题，
       应该先告诉用户「缺什么资料」，而不是先报「没配 AI」。 */
    const usesBody = ["write", "continue", "rewrite", "deai"].includes(action);
    let ctxResult = null;
    let context = null;
    if (usesBody) {
      const query = String(body.topic || body.text || body.before || "").slice(0, 500);
      const requireLibrary = body.useLibrary === true;
      const allowGeneric = body.allowGeneric === true;
      ctxResult = writingContext.buildContext({
        companyId: body.companyId || "",
        query,
        action,
        requireLibrary,
        allowGeneric,
      });
      if (!ctxResult.ok) {
        /* 资料不足 / 企业未选：明确提示，让用户决定补资料还是按通用风格写。
           绝不能假装参考过内容库。 */
        logger.warn("AI 模型", `生成前置检查未通过：${ctxResult.reason}`, { 操作: action });
        return res.status(409).json({
          error: ctxResult.reason,
          needConfirmation: true,
          reason: "insufficient_library",
        });
      }
      context = ctxResult.context;
    }

    if (!ai.normalizeBaseUrl(c.baseUrl)) {
      return res.status(400).json({ error: "还没有配置 AI 模型，请到「设置 → AI 模型」填写服务地址、Key 与模型名" });
    }
    if (!c.model) {
      return res.status(400).json({ error: "还没有选择模型，请到「设置 → AI 模型」选择或填写模型名" });
    }

    let messages_ = null;
    try {
      switch (action) {
        case "write":
          messages_ = prompts.buildWrite(body);
          break;
        case "continue":
          messages_ = prompts.buildContinue(body);
          break;
        case "rewrite":
          /* 子动作（润色/精简/扩写…）走 subAction —— action 字段被顶层 dispatch 占用 */
          messages_ = prompts.buildRewrite(Object.assign({}, body, { action: body.subAction || "polish" }));
          break;
        case "deai":
          messages_ = prompts.buildDeai(body);
          break;
        default:
          logger.warn("AI 模型", `未知的操作类型：${action}`);
          return res.status(400).json({ error: "未知的操作类型：" + action });
      }
    } catch (e) {
      logger.error("AI 模型", `生成请求构造失败：${String(e.message || e)}`, { 操作: action });
      return res.status(400).json({ error: "生成请求构造失败：" + String(e.message || e) });
    }

    /* 把企业上下文接到提示词上 */
    if (context) {
      messages_ = writingContext.appendContextToMessages(messages_, context);
      messages_ = writingContext.appendMissingFactsNotice(messages_, context);
    }

    /* 登记后台任务：让「进行中」列表能看到这次生成 */
    const task = taskProgress.create({
      type: "generate",
      title: action === "write" ? "AI 起稿" : action === "continue" ? "AI 续写" : action === "deai" ? "AI 去 AI 味（模型）" : "AI 改写",
      companyId: (context && context.companyId) || null,
      target: (context && context.companyName) || "",
      total: null,               /* 模型耗时不估算总量 → 不确定进度 */
      stage: "calling_model",
      stageNote: "正在生成正文…",
      cancellable: false,        /* 模型请求发出后无法真正撤销 */
      route: "editor",
    });

    const r = await ai.chat(clientConfig(c), {
      messages: messages_,
      temperature: body.temperature !== undefined ? clampNumber(body.temperature, 0, 2, c.temperature) : c.temperature,
      maxTokens: body.maxTokens !== undefined ? clampNumber(body.maxTokens, 256, 32768, c.maxTokens) : c.maxTokens,
      timeoutMs: clampNumber(c.timeoutSec, 10, 600, 180) * 1000,
    });

    if (!r.ok) {
      taskProgress.fail(task.id, r.error);
      logger.error("AI 模型", `模型调用失败：${r.error}`, { 操作: action, 模型: c.model });
      return res.status(502).json({ error: r.error, taskId: task.id });
    }

    /* 写文章：把第一行「# 标题」拆出来单独回传 —— 前端要分别填标题和正文。
       模型偶尔不照格式输出，拆不出来就 title 为空、正文原样返回，不报错。 */
    let content = r.content || "";
    let title = "";
    if (action === "write") {
      const m = content.match(/^\s*#\s+([^\n]{1,120})\r?\n+/);
      if (m) {
        title = m[1].trim();
        content = content.slice(m[0].length).replace(/^\s+/, "");
      }
    }
    taskProgress.succeed(task.id, { model: r.model || c.model, chars: content.length });

    /* 保存本次引用记录：内容库、风格版本、资料快照 */
    let citation = null;
    if (context && context.usedLibrary && saveCitation && context.companyId) {
      try {
        const cr = saveCitation(context.companyId, {
          action,
          topic: String(body.topic || "").slice(0, 200),
          styleVersion: context.styleVersion,
          snapshot: ctxResult.citations || [],
          contentId: body.contentId || null,
          contentTitle: body.contentTitle || "",
          model: r.model || c.model,
        });
        citation = cr && cr.citation ? cr.citation : null;
      } catch (e) {
        logger.warn("AI 模型", "引用记录保存失败：" + String((e && e.message) || e));
      }
    }

    logger.info("AI 模型", `模型调用完成（操作 ${action}，模型 ${r.model || c.model}）`, {
      正文字数: content.length,
      用量: r.usage || null,
      参考资料数: context ? (context.materials || []).length : 0,
    });
    res.json({
      ok: true,
      content,
      title,
      usage: r.usage || null,
      model: r.model || c.model,
      taskId: task.id,
      /* 本次参考资料（前端显示在编辑辅助区，不混入正文） */
      references: context ? {
        companyId: context.companyId,
        companyName: context.companyName,
        styleVersion: context.styleVersion,
        materials: context.materials || [],
        exemplars: context.exemplars || [],
        missingFacts: context.missingFacts || [],
        note: context.note || "",
        citations: ctxResult.citations || [],
      } : null,
      citationId: citation ? citation.id : null,
    });
  });

  /* ---------------- 写作上下文预览 ----------------
     编辑页「本次参考资料」用：只查不生成，展示会引用哪些资料。 */
  app.get("/api/ai/context", (req, res) => {
    const q = req.query || {};
    const r = writingContext.buildContext({
      companyId: q.companyId || "",
      query: String(q.q || "").slice(0, 500),
      action: "preview",
      requireLibrary: false,
    });
    if (!r.ok) return res.status(400).json({ error: r.reason, needConfirmation: r.needConfirmation });
    res.json({
      ok: true,
      context: r.context,
      citations: r.citations || [],
      styleVersion: r.styleVersion || 0,
    });
  });

  /* ---------------- 本地文本工具（不经过模型） ---------------- */

  app.post("/api/text/format", (req, res) => {
    const body = req.body || {};
    if (typeof body.text !== "string") return res.status(400).json({ error: "text 必须是字符串" });
    try {
      const r = textTools.formatMarkdown(body.text, { level: body.level });
      res.json({ ok: true, text: r.text, changes: r.changes, stats: r.stats });
    } catch (e) {
      res.status(500).json({ error: "排版失败：" + String(e.message || e) });
    }
  });

  app.post("/api/text/humanize", (req, res) => {
    const body = req.body || {};
    if (typeof body.text !== "string") return res.status(400).json({ error: "text 必须是字符串" });
    try {
      const r = textTools.humanizeText(body.text, { level: body.level });
      /* 标记：原文标出被改写的片段，处理后标出对应的新片段。
         服务端直接给安全的 HTML（内容全部转义），前端 v-html 即可。
         注意：正文只认 r.text（纯文本），标记 HTML 绝不回写正文。 */
      const marks = textDiff.diffMarkRanges(body.text, r.text);
      res.json({
        ok: true,
        text: r.text,
        changes: r.changes,
        stats: r.stats,
        marks: {
          beforeHtml: textDiff.markHtml(body.text, marks.before, "tt-hit"),
          afterHtml: textDiff.markHtml(r.text, marks.after, "tt-fix"),
          countBefore: marks.before.length,
          countAfter: marks.after.length,
          skipped: marks.skipped,
        },
      });
    } catch (e) {
      res.status(500).json({ error: "去 AI 味处理失败：" + String(e.message || e) });
    }
  });

  app.post("/api/text/analyze", (req, res) => {
    const body = req.body || {};
    if (typeof body.text !== "string") return res.status(400).json({ error: "text 必须是字符串" });
    try {
      res.json({ ok: true, ...textTools.analyzeAiStyle(body.text) });
    } catch (e) {
      res.status(500).json({ error: "检测失败：" + String(e.message || e) });
    }
  });

  /* 标记任意两段文本的改动位置（AI 深度改写后要重新算标记，不能沿用本地规则的） */
  app.post("/api/text/marks", (req, res) => {
    const body = req.body || {};
    if (typeof body.before !== "string" || typeof body.after !== "string") {
      return res.status(400).json({ error: "before / after 必须是字符串" });
    }
    try {
      const marks = textDiff.diffMarkRanges(body.before, body.after);
      res.json({
        ok: true,
        beforeHtml: textDiff.markHtml(body.before, marks.before, "tt-hit"),
        afterHtml: textDiff.markHtml(body.after, marks.after, "tt-fix"),
        countBefore: marks.before.length,
        countAfter: marks.after.length,
        skipped: marks.skipped,
      });
    } catch (e) {
      res.status(500).json({ error: "标记计算失败：" + String(e.message || e) });
    }
  });
}

module.exports = { registerAiRoutes, defaultAiConfig };
