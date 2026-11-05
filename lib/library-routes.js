/*
 * NoteFly 企业内容库路由
 * ------------------------------------------------------------
 *   企业：GET/POST /api/library/companies, PUT/DELETE /api/library/companies/:id
 *   文章：GET /api/library/companies/:id/articles
 *         POST /api/library/companies/:id/articles/collect      采集链接（批量）
 *         POST /api/library/companies/:id/articles/manual       手动补录正文
 *         PUT  /api/library/companies/:id/articles/:aid        编辑正文/元信息
 *         POST /api/library/companies/:id/articles/:aid/recrawl 重新采集
 *         POST /api/library/companies/:id/articles/:aid/analyze 重新分析
 *         DELETE /api/library/companies/:id/articles/:aid
 *   风格：GET /api/library/companies/:id/style
 *         POST /api/library/companies/:id/style/analyze        重新分析
 *         PUT /api/library/companies/:id/style                编辑风格档案
 *   检索：GET /api/library/companies/:id/search?q=
 *   引用：GET /api/library/companies/:id/citations
 *
 * 所有长任务都登记到统一任务记录里，界面能看到真实阶段与进度。
 */
"use strict";

const library = require("./content-library");
const safeFetch = require("./safe-fetch");
const extractor = require("./article-extract");
const styleProfile = require("./style-profile");
const taskProgress = require("./task-progress");
const messages = require("./messages");
const logger = require("./logger");
const ai = require("./ai");
const writingContext = require("./writing-context");

/* 单次采集的超时 */
const COLLECT_TIMEOUT_MS = 25000;

/* 采集任务的取消开关：按 taskId 记录 */
const cancelFlags = new Set();

/** 该任务是否已被请求取消 */
function isCancelled(taskId) {
  return cancelFlags.has(taskId);
}

function registerLibraryRoutes(app, ctx) {
  const getConfig = ctx.getConfig;

  /* ---------------- 企业 ---------------- */

  app.get("/api/library/companies", (req, res) => {
    res.json({ ok: true, companies: library.listCompanies(), contentTypes: library.CONTENT_TYPES });
  });

  app.post("/api/library/companies", (req, res) => {
    const r = library.createCompany(req.body || {});
    if (!r.ok) return res.status(400).json({ error: r.error });
    logger.info("企业内容库", `新建企业「${r.company.name}」`, { 企业号: r.company.id });
    res.json(r);
  });

  app.put("/api/library/companies/:id", (req, res) => {
    const r = library.updateCompany(req.params.id, req.body || {});
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json(r);
  });

  app.delete("/api/library/companies/:id", (req, res) => {
    const r = library.deleteCompany(req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json(r);
  });

  /* ---------------- 文章列表与详情 ---------------- */

  app.get("/api/library/companies/:id/articles", (req, res) => {
    const q = req.query || {};
    const articles = library.listArticles(req.params.id, {
      keyword: q.q || "",
      type: q.type || "",
      tag: q.tag || "",
      usableOnly: q.usable === "1",
      exemplarOnly: q.exemplar === "1",
    });
    res.json({ ok: true, articles, stats: library.companyStats(req.params.id) });
  });

  app.get("/api/library/companies/:id/articles/:aid", (req, res) => {
    const a = library.getArticle(req.params.id, req.params.aid);
    if (!a) return res.status(404).json({ error: "文章不存在" });
    res.json({ article: a });
  });

  app.put("/api/library/companies/:id/articles/:aid", (req, res) => {
    const body = req.body || {};
    const r = library.updateArticleMeta(req.params.id, req.params.aid, body);
    if (!r.ok) return res.status(404).json({ error: r.error });
    /* 用户改了正文 → 建新版本 + 索引失效 */
    if (typeof body.body === "string") {
      const br = library.updateArticleBody(req.params.id, req.params.aid, body.body, { reason: "manual_edit" });
      if (br.ok) {
        library.invalidateIndex(req.params.id);
        res.json(br);
        return;
      }
    }
    library.invalidateIndex(req.params.id);
    res.json(r);
  });

  app.delete("/api/library/companies/:id/articles/:aid", (req, res) => {
    const r = library.deleteArticle(req.params.id, req.params.aid);
    if (!r.ok) return res.status(404).json({ error: r.error });
    library.invalidateIndex(req.params.id);
    /* 删掉文章 → 风格档案与检索缓存必须失效 */
    const c = library.getCompany(req.params.id);
    if (c && c.styleProfile) {
      library.saveStyleProfile(req.params.id, Object.assign({}, c.styleProfile, {
        analyzedArticleIds: (c.styleProfile.analyzedArticleIds || []).filter((id) => id !== req.params.aid),
      }));
    }
    res.json(r);
  });

  /* ---------------- 采集 ---------------- */

  /**
   * 批量采集：一个链接一个子任务，父任务汇总进度
   * body: { urls: string[], useAI?: boolean }
   */
  app.post("/api/library/companies/:id/articles/collect", async (req, res) => {
    const company = library.getCompany(req.params.id);
    if (!company) return res.status(404).json({ error: "企业不存在" });
    const body = req.body || {};
    const urls = Array.isArray(body.urls) ? body.urls.map((u) => String(u || "").trim()).filter(Boolean) : [];
    if (!urls.length) return res.status(400).json({ error: "请至少提供一个链接" });
    if (urls.length > 30) return res.status(400).json({ error: "一次最多采集 30 个链接，请分批处理" });

    const batchId = "batch_" + Date.now().toString(36);
    const parent = taskProgress.create({
      type: "collect",
      title: `批量采集 ${urls.length} 篇文章`,
      companyId: company.id,
      total: urls.length,
      stage: "starting",
      stageNote: "准备采集",
      cancellable: true,
      route: "library",
    });
    /* 父任务 ID 写进 batchId，便于统一查询 */
    taskProgress.update(parent.id, { batchId });

    /* 后台执行：立即返回，界面通过进度接口看进度 */
    runCollectBatch(company.id, urls, parent.id, batchId, body.useAI !== false)
      .catch((e) => {
        logger.error("企业内容库", "批量采集异常：" + String((e && e.message) || e));
        taskProgress.fail(parent.id, "批量采集异常：" + String((e && e.message) || e));
      });

    res.json({ ok: true, taskId: parent.id, batchId, total: urls.length });
  });

  /**
   * 执行批量采集
   */
  async function runCollectBatch(companyId, urls, parentId, batchId, useAI) {
    /* 企业信息在本函数内自取：请求处理函数里的 company 变量不在本作用域，
       旧代码直接引用会抛「company is not defined」，文章入库了汇总却报错 */
    const company = library.getCompany(companyId);
    if (!company) {
      taskProgress.fail(parentId, "企业不存在（可能在采集开始前被删除）");
      return { ok: 0, failed: urls.length, companyMissing: true };
    }
    taskProgress.setStage(parentId, "collecting", "正在采集第 1 篇", { completed: 0 });
    let ok = 0, failed = 0, manual = 0;

    for (let i = 0; i < urls.length; i++) {
      if (isCancelled(parentId)) {
        taskProgress.finishCancel(parentId, "采集已取消");
        cancelFlags.delete(parentId);
        return { ok, failed, cancelled: true };
      }
      const url = urls[i];
      taskProgress.setStage(parentId, "collecting", `正在采集第 ${i + 1}/${urls.length} 篇`, { completed: i });

      /* 每个链接一个子任务，便于逐条处理 */
      const child = taskProgress.create({
        type: "collect",
        title: "采集文章",
        companyId,
        target: url,
        parentId,
        batchId,
        total: 1,
        stage: "fetching",
        stageNote: "正在抓取页面",
        cancellable: false,
        route: "library",
      });

      const r = await collectOne(companyId, url, child.id, useAI);
      if (r.ok) ok++;
      else if (r.needManual) manual++;
      else failed++;

      taskProgress.update(child.id, { completed: 1 });
      if (r.ok) {
        taskProgress.succeed(child.id, { articleId: r.article.id, title: r.article.title });
      } else {
        taskProgress.fail(child.id, r.reason || "采集失败", r.detail || "");
      }
      taskProgress.update(parentId, { completed: i + 1 });
    }

    taskProgress.update(parentId, { completed: urls.length });
    const summary = `成功 ${ok} 篇${manual ? `，${manual} 篇需手动补录` : ""}${failed ? `，${failed} 篇失败` : ""}`;
    /* 全部失败必须如实标 failed，不能先标成功；其余情况按部分/全部成功收尾 */
    if (ok === 0 && !manual && failed > 0) {
      taskProgress.fail(parentId, `全部采集失败（${failed} 篇）`, summary);
    } else {
      taskProgress.succeed(parentId, { ok, failed, manual, summary });
    }

    /* 汇总成一条消息（不是每篇一条） */
    messages.push({
      eventId: `collect:${batchId}`,
      type: messages.TYPE.COLLECT,
      level: ok === 0 && !manual ? messages.LEVEL.ERROR : (failed || manual ? messages.LEVEL.WARNING : messages.LEVEL.SUCCESS),
      title: `采集完成：${summary}`,
      summary: `企业「${company.name}」共采集 ${urls.length} 个链接。` +
        (manual ? `有 ${manual} 篇未能自动获取正文，请在内容库里打开原文后手动补录。` : "") +
        (failed ? `有 ${failed} 篇采集失败。` : ""),
      companyId,
      action: { label: "查看企业内容库", kind: "navigate", payload: { page: "library", companyId } },
      meta: { ok, failed, manual, total: urls.length },
    });

    logger.info("企业内容库", `批量采集完成：${summary}`, { 企业: company.name });
    return { ok, failed, manual };
  }

  /**
   * 采集单篇
   * @returns {{ok:boolean, article?:object, reason?:string, needManual?:boolean}}
   */
  async function collectOne(companyId, rawUrl, taskId, useAI) {
    const company = library.getCompany(companyId);
    if (!company) return { ok: false, reason: "企业不存在" };

    /* 1. 链接规范化与安全检查 */
    const normalized = safeFetch.normalizeUrl(rawUrl);
    const urlCheck = safeFetch.checkURL(normalized);
    if (!urlCheck.ok) {
      return { ok: false, reason: urlCheck.error, detail: "链接未通过安全检查，已跳过" };
    }

    /* 2. 同链接去重 */
    const exist = library.findByUrl(companyId, normalized);
    if (exist && exist.collectStatus === "success" && exist.body) {
      taskProgress.setStage(taskId, "duplicate", "该链接已在库中，跳过重复采集");
      return { ok: true, article: exist, duplicate: true };
    }

    /* 3. 抓取 */
    taskProgress.setStage(taskId, "fetching", "正在抓取页面…");
    const fetched = await safeFetch.fetchText(normalized, { timeoutMs: COLLECT_TIMEOUT_MS });
    if (!fetched.ok) {
      const needManual = /验证码|验证|登录|403|超时|连不上/.test(fetched.error || "");
      return {
        ok: false,
        needManual,
        reason: fetched.error || "抓取失败",
        detail: needManual ? "可以打开原文后手动粘贴正文，文章仍会关联这个来源链接" : "",
      };
    }

    /* 4. 抽取正文 */
    taskProgress.setStage(taskId, "extracting", "正在识别正文…");
    const extracted = extractor.extractArticle(fetched.body, { finalUrl: fetched.finalUrl });
    if (!extracted.ok) {
      return {
        ok: false,
        needManual: true,
        reason: extracted.reason || "未能识别正文",
        detail: "可以打开原文后手动粘贴正文，文章仍会关联这个来源链接",
      };
    }

    /* 5. 正文指纹去重 */
    const fp = library.bodyFingerprint(extracted.bodyText);
    const dupByFp = library.findByFingerprint(companyId, fp);
    if (dupByFp && (!exist || dupByFp.id !== exist.id)) {
      /* 同一篇文章的不同链接 → 合并来源，不重复入库 */
      if (!dupByFp.sourceUrl) {
        library.updateArticleMeta(companyId, dupByFp.id, {});
      }
      taskProgress.setStage(taskId, "duplicate", "正文与库中已有文章重复，已合并");
      return { ok: true, article: dupByFp, duplicate: true };
    }

    /* 6. 入库 */
    taskProgress.setStage(taskId, "saving", "正在保存…");
    let article;
    if (exist) {
      /* 同一链接重新采集 → 新版本，不覆盖用户改过的正文 */
      const userEdited = exist.versions.some((v) => v.source === "manual_edit");
      if (userEdited && exist.fingerprint !== fp) {
        /* 用户手改过：新正文另存为新版本，原样保留 */
        const r2 = library.addArticle(companyId, {
          sourceUrl: rawUrl,
          normalizedUrl: normalized,
          finalUrl: fetched.finalUrl,
          title: extracted.title,
          author: extracted.author,
          publishedAt: extracted.publishedAt,
          body: extracted.bodyText,
          summary: (extracted.bodyText || "").slice(0, 160),
          tags: [],
          contentType: extracted.contentType,
          collectStatus: "success",
        });
        article = r2.article;
      } else {
        const r2 = library.updateArticleBody(companyId, exist.id, extracted.bodyText, { reason: "collect" });
        if (!r2.ok) return { ok: false, reason: r2.error };
        library.updateArticleMeta(companyId, exist.id, {
          title: extracted.title || exist.title,
          contentType: extracted.contentType,
        });
        article = library.getArticle(companyId, exist.id);
      }
    } else {
      const r2 = library.addArticle(companyId, {
        sourceUrl: rawUrl,
        normalizedUrl: normalized,
        finalUrl: fetched.finalUrl,
        title: extracted.title,
        author: extracted.author,
        publishedAt: extracted.publishedAt,
        body: extracted.bodyText,
        summary: (extracted.bodyText || "").slice(0, 160),
        tags: [],
        contentType: extracted.contentType,
        collectStatus: "success",
      });
      if (!r2.ok) return { ok: false, reason: r2.error };
      article = r2.article;
    }
    library.invalidateIndex(companyId);

    /* 7. AI 分析（可失败，不影响正文保存） */
    if (useAI) {
      taskProgress.setStage(taskId, "analyzing", "正在分析文章…");
      const ar = await analyzeArticle(companyId, article.id);
      if (!ar.ok) {
        library.updateArticleMeta(companyId, article.id, { analyzeStatus: "failed" });
        /* 分析失败保留已采集正文 —— 正文已经拿到了 */
        taskProgress.setStage(taskId, "analyze_failed", "正文已保存，分析失败", { error: ar.reason });
      } else {
        library.updateArticleMeta(companyId, article.id, { analyzeStatus: "success" });
      }
    }

    return { ok: true, article };
  }

  /** 分析单篇（摘要 + 标签） */
  async function analyzeArticle(companyId, articleId) {
    const cfg = getConfig();
    if (!ai.isConnected(cfg.ai || {})) {
      return { ok: false, reason: "未接入 AI 模型，已跳过分析（正文已正常保存）" };
    }
    const a = library.getArticle(companyId, articleId);
    if (!a) return { ok: false, reason: "文章不存在" };
    const text = String(a.body || "").slice(0, 6000);
    const r = await ai.chat({
      baseUrl: cfg.ai.baseUrl,
      apiKey: cfg.ai.apiKey,
      model: cfg.ai.model,
    }, {
      messages: [
        { role: "system", content: "你是一位内容编辑。请为给定的中文文章输出 JSON：{\"summary\":\"120字以内的摘要\",\"tags\":[\"最多6个标签\"]}。只输出 JSON，不要解释。" },
        { role: "user", content: `标题：${a.title}\n\n${text}` },
      ],
      temperature: 0.2,
      maxTokens: 600,
      timeoutMs: 60000,
    });
    if (!r.ok) return { ok: false, reason: r.error };
    try {
      const fence = String(r.content || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      const data = JSON.parse(fence ? fence[1] : String(r.content).trim());
      library.updateArticleMeta(companyId, articleId, {
        summary: String(data.summary || "").slice(0, 600),
        tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t).slice(0, 24)).slice(0, 10) : [],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "模型返回的不是合法 JSON" };
    }
  }

  /* ---------------- 手动补录 ---------------- */

  app.post("/api/library/companies/:id/articles/manual", async (req, res) => {
    const company = library.getCompany(req.params.id);
    if (!company) return res.status(404).json({ error: "企业不存在" });
    const body = req.body || {};
    const text = String(body.body || "").trim();
    if (!text) return res.status(400).json({ error: "正文不能为空" });
    const sourceUrl = String(body.sourceUrl || "").trim();
    const normalized = sourceUrl ? safeFetch.normalizeUrl(sourceUrl) : "";

    const task = taskProgress.create({
      type: "collect",
      title: "手动补录正文",
      companyId: company.id,
      target: sourceUrl || "(直接粘贴)",
      total: 1,
      stage: "saving",
      stageNote: "正在保存补录内容",
      cancellable: false,
      route: "library",
    });

    let article = null;
    if (normalized) {
      const exist = library.findByUrl(company.id, normalized);
      if (exist) {
        const r = library.updateArticleBody(company.id, exist.id, text, { reason: "manual" });
        if (!r.ok) {
          taskProgress.fail(task.id, r.error);
          return res.status(400).json({ error: r.error });
        }
        article = r.article;
        /* 手动补录后重新分析 */
        const ar = await analyzeArticle(company.id, article.id);
        library.updateArticleMeta(company.id, article.id, { analyzeStatus: ar.ok ? "success" : "failed" });
      }
    }
    if (!article) {
      const r = library.addArticle(company.id, {
        sourceUrl,
        normalizedUrl: normalized,
        finalUrl: sourceUrl,
        title: String(body.title || "手动补录文章").slice(0, 200),
        author: String(body.author || ""),
        publishedAt: String(body.publishedAt || ""),
        body: text,
        summary: String(body.summary || "").slice(0, 600),
        tags: Array.isArray(body.tags) ? body.tags : [],
        contentType: body.contentType || "opinion",
        collectStatus: "manual",
      });
      if (!r.ok) {
        taskProgress.fail(task.id, r.error);
        return res.status(400).json({ error: r.error });
      }
      article = r.article;
    }
    library.invalidateIndex(company.id);
    taskProgress.succeed(task.id, { articleId: article.id });

    messages.push({
      eventId: `manual:${article.id}:${article.version}`,
      type: messages.TYPE.COLLECT,
      level: messages.LEVEL.SUCCESS,
      title: `已补录正文：《${article.title}》`,
      summary: article.sourceUrl ? `来源链接：${article.sourceUrl}` : "直接粘贴，未关联来源链接",
      companyId: company.id,
      action: { label: "查看文章", kind: "navigate", payload: { page: "library", companyId: company.id, articleId: article.id } },
    });

    res.json({ ok: true, article, taskId: task.id });
  });

  /* ---------------- 重新采集 / 重新分析 ---------------- */

  app.post("/api/library/companies/:id/articles/:aid/recrawl", async (req, res) => {
    const company = library.getCompany(req.params.id);
    if (!company) return res.status(404).json({ error: "企业不存在" });
    const a = library.getArticle(req.params.id, req.params.aid);
    if (!a) return res.status(404).json({ error: "文章不存在" });
    if (!a.sourceUrl) return res.status(400).json({ error: "这篇文章没有来源链接，无法重新采集" });

    const task = taskProgress.create({
      type: "collect",
      title: "重新采集文章",
      companyId: company.id,
      target: a.sourceUrl,
      total: 1,
      stage: "fetching",
      stageNote: "正在重新抓取",
      cancellable: false,
      route: "library",
    });

    /* 重新采集：新正文建新版本 */
    const r = await collectOne(company.id, a.sourceUrl, task.id, true);
    if (r.ok) {
      taskProgress.succeed(task.id, { articleId: r.article.id });
      library.invalidateIndex(company.id);
      res.json({ ok: true, article: r.article, taskId: task.id });
    } else {
      taskProgress.fail(task.id, r.reason || "重新采集失败", r.detail || "");
      res.status(400).json({ error: r.reason, needManual: !!r.needManual, taskId: task.id });
    }
  });

  app.post("/api/library/companies/:id/articles/:aid/analyze", async (req, res) => {
    const company = library.getCompany(req.params.id);
    if (!company) return res.status(404).json({ error: "企业不存在" });
    const a = library.getArticle(req.params.id, req.params.aid);
    if (!a) return res.status(404).json({ error: "文章不存在" });

    const task = taskProgress.create({
      type: "analysis",
      title: "重新分析文章",
      companyId: company.id,
      target: a.title,
      total: 1,
      stage: "analyzing",
      stageNote: "正在分析",
      cancellable: false,
      route: "library",
    });
    const r = await analyzeArticle(company.id, a.id);
    if (r.ok) {
      library.updateArticleMeta(company.id, a.id, { analyzeStatus: "success" });
      taskProgress.succeed(task.id, { articleId: a.id });
      res.json({ ok: true, taskId: task.id });
    } else {
      library.updateArticleMeta(company.id, a.id, { analyzeStatus: "failed" });
      taskProgress.fail(task.id, r.reason || "分析失败");
      res.status(400).json({ error: r.reason, taskId: task.id });
    }
  });

  /* ---------------- 风格档案 ---------------- */

  app.get("/api/library/companies/:id/style", (req, res) => {
    const company = library.getCompany(req.params.id);
    if (!company) return res.status(404).json({ error: "企业不存在" });
    res.json({
      profile: library.getStyleProfile(req.params.id),
      stats: library.companyStats(req.params.id),
    });
  });

  /**
   * 重新分析风格档案
   * 用户手动修订的规则保留，不会被覆盖。
   */
  app.post("/api/library/companies/:id/style/analyze", async (req, res) => {
    const company = library.getCompany(req.params.id);
    if (!company) return res.status(404).json({ error: "企业不存在" });

    const usable = library.listArticles(req.params.id, { usableOnly: true });
    if (!usable.length) {
      return res.status(400).json({ error: "还没有可用的文章（正文采集成功且未被排除），无法分析风格" });
    }

    const task = taskProgress.create({
      type: "analysis",
      title: "分析企业写作风格",
      companyId: company.id,
      total: usable.length,
      stage: "analyzing",
      stageNote: "正在统计表达特征…",
      cancellable: false,
      route: "library",
    });

    taskProgress.setStage(task.id, "analyzing", `正在统计 ${usable.length} 篇文章的表达特征…`, { completed: 0 });
    const ruleRes = styleProfile.analyzeByRules(usable);
    if (!ruleRes.ok) {
      taskProgress.fail(task.id, ruleRes.reason || "规则分析失败");
      return res.status(400).json({ error: ruleRes.reason, taskId: task.id });
    }
    taskProgress.advance(task.id, usable.length, { stageNote: "表达特征统计完成，正在尝试模型层分析…" });

    /* 模型层：失败也不影响规则层结果 */
    const cfg = getConfig();
    let profile = ruleRes.profile;
    let modelNote = "";
    if (ai.isConnected(cfg.ai || {})) {
      taskProgress.setStage(task.id, "model_analyzing", "正在用模型补充读者画像与术语判断…");
      const mr = await styleProfile.analyzeByModel({
        chat: ai.chat,
        cfg: { baseUrl: cfg.ai.baseUrl, apiKey: cfg.ai.apiKey, model: cfg.ai.model },
      }, usable);
      if (mr.ok && mr.data) {
        profile = styleProfile.mergeProfiles(profile, mr.data);
        modelNote = "模型层分析已完成";
      } else {
        modelNote = "模型层分析未完成（" + (mr.reason || "未知原因") + "），已保留规则层结果";
        profile.analysisSource = "rules";
      }
    } else {
      modelNote = "未接入模型，仅使用规则层分析";
      profile.analysisSource = "rules";
    }

    profile.analyzedArticleIds = usable.map((a) => a.id);
    profile.analysisNote = modelNote;
    const saved = library.saveStyleProfile(company.id, profile);
    taskProgress.succeed(task.id, { version: saved.profile.version });

    messages.push({
      eventId: `style:${company.id}:${saved.profile.version}`,
      type: messages.TYPE.ANALYSIS,
      level: messages.LEVEL.SUCCESS,
      title: `风格档案已更新（v${saved.profile.version}）`,
      summary: `企业「${company.name}」基于 ${usable.length} 篇可用文章完成分析。${modelNote}。`,
      companyId: company.id,
      action: { label: "查看风格档案", kind: "navigate", payload: { page: "library", companyId: company.id, tab: "style" } },
    });

    res.json({ ok: true, profile: saved.profile, taskId: task.id, note: modelNote });
  });

  /* 编辑风格档案（用户手动修订） */
  app.put("/api/library/companies/:id/style", (req, res) => {
    const company = library.getCompany(req.params.id);
    if (!company) return res.status(404).json({ error: "企业不存在" });
    const body = req.body || {};
    const cur = library.getStyleProfile(req.params.id) || {};
    const next = Object.assign({}, cur, body, { manualRules: body.manualRules || cur.manualRules || [] });
    const r = library.saveStyleProfile(req.params.id, next);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  });

  /* ---------------- 检索 ---------------- */

  app.get("/api/library/companies/:id/search", (req, res) => {
    const q = req.query || {};
    const r = library.search(req.params.id, q.q || "", { limit: Number(q.limit) || 8 });
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json(r);
  });

  /* ---------------- 引用记录 ---------------- */

  app.get("/api/library/companies/:id/citations", (req, res) => {
    res.json({ ok: true, citations: library.listCitations(req.params.id, req.query.limit) });
  });

  /* 供写作上下文模块使用：把写作引用记录写进来 */
  app.locals_saveCitation = (companyId, citation) => library.saveCitation(companyId, citation);

  /* 取消采集：把任务标记为 cancelling，真正停下由采集循环检查 */
  app.post("/api/library/collect/:taskId/cancel", (req, res) => {
    const t = taskProgress.get(req.params.taskId);
    if (!t) return res.status(404).json({ error: "任务不存在" });
    cancelFlags.add(req.params.taskId);
    const r = taskProgress.requestCancel(req.params.taskId, "正在停止采集…");
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  });
}

module.exports = { registerLibraryRoutes, COLLECT_TIMEOUT_MS };
