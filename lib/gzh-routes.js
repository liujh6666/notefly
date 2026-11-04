/*
 * 公众号排版路由
 * ------------------------------------------------------------
 *   GET  /api/gzh/templates          模板清单（7 套主题）
 *   POST /api/gzh/render             正文 → 公众号 HTML（渲染 + 合规自检）
 *
 * 渲染在服务端完成，理由：
 *   1. 同一套令牌与组件只有一份实现，编辑器预览与导出用的是同一份产物；
 *   2. 导出 HTML、复制到公众号时不需要再在前端跑一遍渲染逻辑；
 *   3. 合规校验跟着渲染一起跑，违规内容当场报错，不会静默产出坏 HTML。
 */

"use strict";

const express = require("express");
const { listThemes, DEFAULT_THEME_ID } = require("./gzh-themes");
const { renderGzh } = require("./gzh-render");
const { validateGzhHtml } = require("./gzh-validate");

function registerGzhRoutes(app) {
  /* 模板清单 */
  app.get("/api/gzh/templates", (req, res) => {
    res.json({ templates: listThemes(), defaultTheme: DEFAULT_THEME_ID });
  });

  /* 渲染 */
  app.post("/api/gzh/render", (req, res) => {
    const body = req.body || {};
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    if (!markdown.trim()) {
      return res.status(400).json({ error: "正文为空，没有可排版的内容" });
    }
    try {
      const out = renderGzh(markdown, {
        themeId: body.themeId,
        title: body.title,
        cover: body.cover,
        authorName: body.authorName,
        authorBio: body.authorBio,
        signature: body.signature,
        toc: body.toc,
        markKeywords: body.markKeywords,
      });
      const check = validateGzhHtml(out.html);
      res.json({
        ok: true,
        html: out.html,
        themeId: out.themeId,
        sectionCount: out.sectionCount,
        wordCount: out.wordCount,
        warnings: check.warnings,
        errors: check.errors,
        valid: check.ok,
      });
    } catch (e) {
      res.status(500).json({ error: "排版失败：" + String((e && e.message) || e) });
    }
  });
}

module.exports = { registerGzhRoutes };
