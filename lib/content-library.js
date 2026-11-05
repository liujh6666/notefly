/*
 * NoteFly 企业内容库
 * ------------------------------------------------------------
 * 每个企业是一套独立的资料空间：文章、风格档案、写作引用记录全部隔离。
 * 新建内容时必须明确「当前用哪个企业的资料」—— 不能暗中使用其它企业的东西。
 *
 * 存储结构（<数据目录>/library.json）：
 * {
 *   version: 1,
 *   companies: [
 *     { id, name, description, createdAt, updatedAt,
 *       styleProfile: {...},        // 写作风格档案（含版本号）
 *       articles: [ {...} ],        // 企业文章（含版本历史）
 *       citations: [ {...} ] }      // 每次生成用过的引用记录
 *   ]
 * }
 *
 * 三条硬规则：
 *  1. 企业隔离：A 企业的检索结果里绝不出现 B 企业的文章。
 *  2. 版本不覆盖：同一链接重新采集 → 新建版本；用户手改过的正文
 *     不被自动覆盖（重新采集会先比对指纹，变了就提示）。
 *  3. 缺失即未知：作者、发布时间拿不到就空着，绝不让 AI 猜。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { CONTENT_TYPES } = require("./article-extract");

/** 正文指纹：用于判断「重新采集后正文是否变化」 */
function bodyFingerprint(body) {
  const s = String(body || "").replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/**
 * 这篇文章是否「可用于检索与风格分析」。
 * 手动补录的正文同样是真实正文 —— 用户自己粘进来的内容当然算可用。
 */
function isUsable(a) {
  if (!a) return false;
  if (a.excluded) return false;
  if (!a.body || !String(a.body).trim()) return false;
  return a.collectStatus === "success" || a.collectStatus === "manual";
}

/* 存储文件（每次求值：数据目录可运行时切换） */
function storeFile() {
  try {
    const dataDir = require("./data-dir");
    return path.join(dataDir.get(), "library.json");
  } catch {
    return path.join(process.cwd(), "data", "library.json");
  }
}

let db = { version: 1, companies: [] };
/* 索引缓存：companyId -> {docId -> tokenFreq}，检索用 */
let indexCache = new Map();
let indexDirty = false;

function load() {
  const file = storeFile();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    db = {
      version: 1,
      companies: Array.isArray(j.companies) ? j.companies : [],
    };
  } catch {
    db = { version: 1, companies: [] };
  }
  for (const c of db.companies) normalizeCompany(c);
  indexDirty = true;
  return db;
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
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (e) {
      require("./logger").error("企业内容库", "内容库落盘失败：" + String((e && e.message) || e));
    }
  }, 150);
  if (saveTimer.unref) saveTimer.unref();
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return (prefix || "c") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/** 补齐企业结构的缺省字段（老数据/手工编辑的文件可能缺） */
function normalizeCompany(c) {
  if (!c || typeof c !== "object") return null;
  c.id = c.id || newId("c");
  c.name = String(c.name || "未命名企业");
  c.description = String(c.description || "");
  c.createdAt = c.createdAt || nowIso();
  c.updatedAt = c.updatedAt || nowIso();
  c.articles = Array.isArray(c.articles) ? c.articles : [];
  c.citations = Array.isArray(c.citations) ? c.citations : [];
  c.styleProfile = c.styleProfile && typeof c.styleProfile === "object" ? c.styleProfile : null;
  for (const a of c.articles) normalizeArticle(a, c.id);
  return c;
}

function normalizeArticle(a, companyId) {
  if (!a || typeof a !== "object") return null;
  a.id = a.id || newId("a");
  a.companyId = a.companyId || companyId;
  a.title = String(a.title || "");
  a.sourceUrl = String(a.sourceUrl || "");
  a.finalUrl = String(a.finalUrl || a.sourceUrl || "");
  a.author = String(a.author || "");
  a.publishedAt = a.publishedAt || "";
  a.importedAt = a.importedAt || nowIso();
  a.body = String(a.body || "");
  a.summary = String(a.summary || "");
  a.tags = Array.isArray(a.tags) ? a.tags : [];
  a.contentType = a.contentType || "opinion";
  a.versions = Array.isArray(a.versions) ? a.versions : [];
  a.version = Number(a.version) || 1;
  /* 两个独立的状态：正文采集成功与否、AI 分析成功与否 */
  a.collectStatus = a.collectStatus || "pending";   // pending|success|failed|manual
  a.analyzeStatus = a.analyzeStatus || "pending";   // pending|success|failed
  /* 用户是否排除了这篇文章（AI 不再参考） */
  a.excluded = !!a.excluded;
  /* 是否被指定为优秀范文 */
  a.exemplar = !!a.exemplar;
  a.fingerprint = a.fingerprint || bodyFingerprint(a.body);
  return a;
}

/* ---------------- 企业 ---------------- */

function listCompanies() {
  return db.companies.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    articleCount: c.articles.length,
    usableCount: c.articles.filter((a) => isUsable(a)).length,
    hasStyleProfile: !!c.styleProfile,
    styleVersion: c.styleProfile ? c.styleProfile.version || 0 : 0,
  }));
}

function getCompany(id) {
  return db.companies.find((c) => c.id === id) || null;
}

function createCompany(opts) {
  const o = opts || {};
  const name = String(o.name || "").trim();
  if (!name) return { ok: false, error: "企业名称不能为空" };
  const c = normalizeCompany({
    id: newId("c"),
    name: name.slice(0, 60),
    description: String(o.description || "").slice(0, 200),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    articles: [],
    citations: [],
    styleProfile: null,
  });
  db.companies.push(c);
  save();
  return { ok: true, company: c };
}

function updateCompany(id, patch) {
  const c = getCompany(id);
  if (!c) return { ok: false, error: "企业不存在" };
  const p = patch || {};
  if (p.name !== undefined) c.name = String(p.name).trim().slice(0, 60) || c.name;
  if (p.description !== undefined) c.description = String(p.description).slice(0, 200);
  c.updatedAt = nowIso();
  save();
  return { ok: true, company: c };
}

function deleteCompany(id) {
  const i = db.companies.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, error: "企业不存在" };
  db.companies.splice(i, 1);
  indexCache.delete(id);
  save();
  return { ok: true };
}

/* ---------------- 文章 ---------------- */

/** 按规范化链接在同一企业内查重 */
function findByUrl(companyId, normalizedUrl) {
  const c = getCompany(companyId);
  if (!c) return null;
  return c.articles.find((a) => a.normalizedUrl === normalizedUrl) || null;
}

/** 按正文指纹查重（同一篇文章被不同链接引用） */
function findByFingerprint(companyId, fp) {
  const c = getCompany(companyId);
  if (!c) return null;
  return c.articles.find((a) => a.fingerprint === fp && a.collectStatus === "success") || null;
}

function listArticles(companyId, opts) {
  const o = opts || {};
  const c = getCompany(companyId);
  if (!c) return [];
  let out = c.articles.slice();
  /* 「可用」= 有正文（自动采集成功或手动补录）且没有被用户排除 */
  if (o.usableOnly) out = out.filter((a) => isUsable(a));
  if (o.exemplarOnly) out = out.filter((a) => a.exemplar);
  if (o.type) out = out.filter((a) => a.contentType === o.type);
  if (o.tag) out = out.filter((a) => a.tags.includes(o.tag));
  const kw = String(o.keyword || "").trim().toLowerCase();
  if (kw) {
    out = out.filter((a) => {
      const hay = `${a.title} ${a.summary} ${a.tags.join(" ")} ${a.body}`.toLowerCase();
      return hay.includes(kw);
    });
  }
  out.sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
  return out;
}

function getArticle(companyId, articleId) {
  const c = getCompany(companyId);
  if (!c) return null;
  return c.articles.find((a) => a.id === articleId) || null;
}

/**
 * 新增一篇文章（采集成功或手动补录）
 * @param {string} companyId
 * @param {Object} data { sourceUrl, normalizedUrl, title, author, publishedAt,
 *                        body, summary, tags, contentType, collectStatus }
 */
function addArticle(companyId, data) {
  const c = getCompany(companyId);
  if (!c) return { ok: false, error: "企业不存在" };
  const d = data || {};
  const a = normalizeArticle({
    id: newId("a"),
    companyId,
    sourceUrl: d.sourceUrl || "",
    finalUrl: d.finalUrl || d.sourceUrl || "",
    normalizedUrl: d.normalizedUrl || d.sourceUrl || "",
    title: d.title || "(未命名)",
    author: d.author || "",
    publishedAt: d.publishedAt || "",
    importedAt: nowIso(),
    body: d.body || "",
    summary: d.summary || "",
    tags: Array.isArray(d.tags) ? d.tags : [],
    contentType: d.contentType || "opinion",
    collectStatus: d.collectStatus || "manual",
    analyzeStatus: d.analyzeStatus || "pending",
    versions: [],
    version: 1,
  }, companyId);
  a.versions.push({
    version: 1,
    at: nowIso(),
    fingerprint: a.fingerprint,
    wordCount: a.body.replace(/\s/g, "").length,
    source: d.collectStatus === "manual" ? "manual" : "collect",
  });
  c.articles.unshift(a);
  c.updatedAt = nowIso();
  indexDirty = true;
  save();
  return { ok: true, article: a };
}

/**
 * 更新正文 → 创建新版本（不覆盖用户修改）
 * @param {{reason?:string}} opts reason: collect|manual_edit
 */
function updateArticleBody(companyId, articleId, body, opts) {
  const o = opts || {};
  const a = getArticle(companyId, articleId);
  if (!a) return { ok: false, error: "文章不存在" };
  const fp = bodyFingerprint(body);
  if (fp === a.fingerprint) {
    return { ok: true, article: a, changed: false };
  }
  /* 旧版本留档 */
  a.versions.push({
    version: a.version,
    at: nowIso(),
    fingerprint: a.fingerprint,
    wordCount: a.body.replace(/\s/g, "").length,
    source: o.reason || "manual_edit",
  });
  a.body = String(body || "");
  a.fingerprint = fp;
  a.version = (Number(a.version) || 1) + 1;
  a.updatedAt = nowIso();
  /* 手动补录 → 采集状态转为 manual（正文有了） */
  if (o.reason === "manual" || o.reason === "manual_edit") {
    if (a.collectStatus === "failed" || a.collectStatus === "pending") a.collectStatus = "manual";
  }
  indexDirty = true;
  save();
  return { ok: true, article: a, changed: true, version: a.version };
}

function updateArticleMeta(companyId, articleId, patch) {
  const a = getArticle(companyId, articleId);
  if (!a) return { ok: false, error: "文章不存在" };
  const p = patch || {};
  if (p.title !== undefined) a.title = String(p.title).slice(0, 200);
  if (p.summary !== undefined) a.summary = String(p.summary).slice(0, 1000);
  if (p.tags !== undefined) a.tags = Array.isArray(p.tags) ? p.tags.slice(0, 20).map((t) => String(t).slice(0, 24)) : [];
  if (p.contentType !== undefined && CONTENT_TYPES.some((t) => t.id === p.contentType)) a.contentType = p.contentType;
  if (p.excluded !== undefined) a.excluded = !!p.excluded;
  if (p.exemplar !== undefined) a.exemplar = !!p.exemplar;
  if (p.analyzeStatus !== undefined) a.analyzeStatus = p.analyzeStatus;
  a.updatedAt = nowIso();
  indexDirty = true;
  save();
  return { ok: true, article: a };
}

function deleteArticle(companyId, articleId) {
  const c = getCompany(companyId);
  if (!c) return { ok: false, error: "企业不存在" };
  const i = c.articles.findIndex((a) => a.id === articleId);
  if (i < 0) return { ok: false, error: "文章不存在" };
  c.articles.splice(i, 1);
  c.updatedAt = nowIso();
  indexDirty = true;
  save();
  return { ok: true };
}

/* ---------------- 风格档案 ---------------- */

function getStyleProfile(companyId) {
  const c = getCompany(companyId);
  if (!c) return null;
  return c.styleProfile;
}

/**
 * 保存风格档案。
 * 用户手动修订过的规则（manualRules）永远保留 ——
 * 重新分析只能更新自动分析出来的部分，不能覆盖用户的修订。
 */
function saveStyleProfile(companyId, profile, opts) {
  const c = getCompany(companyId);
  if (!c) return { ok: false, error: "企业不存在" };
  const o = opts || {};
  const prev = c.styleProfile;
  const next = Object.assign({}, profile || {});
  next.version = (prev ? Number(prev.version) || 0 : 0) + 1;
  next.updatedAt = nowIso();
  next.companyId = companyId;
  /* 手动修订保留：优先用新档案里的，没有则用旧的 */
  next.manualRules = (next.manualRules && next.manualRules.length)
    ? next.manualRules
    : (prev && prev.manualRules ? prev.manualRules : []);
  next.analyzedArticleIds = (next.analyzedArticleIds || []).filter((id) =>
    c.articles.some((a) => a.id === id));
  c.styleProfile = next;
  c.updatedAt = nowIso();
  save();
  return { ok: true, profile: next, previous: prev };
}

/* ---------------- 引用记录 ---------------- */

/**
 * 保存一次生成用到的引用记录（可追溯：内容库、风格版本、资料快照）
 */
function saveCitation(companyId, citation) {
  const c = getCompany(companyId);
  if (!c) return { ok: false, error: "企业不存在" };
  const rec = {
    id: newId("cit"),
    companyId,
    at: nowIso(),
    action: citation.action || "",
    topic: citation.topic || "",
    styleVersion: citation.styleVersion || 0,
    /* 资料快照：本次实际引用的文章与片段 */
    snapshot: citation.snapshot || [],
    contentId: citation.contentId || null,
    contentTitle: citation.contentTitle || "",
    model: citation.model || "",
  };
  c.citations.unshift(rec);
  /* 引用记录只保留最近 200 条，避免无限膨胀 */
  if (c.citations.length > 200) c.citations.length = 200;
  c.updatedAt = nowIso();
  save();
  return { ok: true, citation: rec };
}

function listCitations(companyId, limit) {
  const c = getCompany(companyId);
  if (!c) return [];
  return c.citations.slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)));
}

/* ---------------- 检索索引 ---------------- */

/* 中文分词：按字 + 双字组切，够用且不引依赖 */
function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const tokens = [];
  /* 英文/数字词 */
  const words = s.match(/[a-z0-9][a-z0-9_+#.-]{1,}/g) || [];
  for (const w of words) tokens.push(w);
  /* 中文：双字组（单字段落才保留单字）
     只用单字会误命中：例如「定价」里的「定」会命中只提到「决策」的文章。
     双字组才是中文检索的最小可靠单位。 */
  const cn = s.match(/[一-龥]+/g) || [];
  for (const run of cn) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/** 构建/刷新某企业的检索索引 */
function buildIndex(companyId) {
  const c = getCompany(companyId);
  if (!c) return null;
  const docs = new Map();
  for (const a of c.articles) {
    if (a.collectStatus !== "success" && a.collectStatus !== "manual") continue;
    if (a.excluded) continue;   // 用户排除的文章不参与检索
    const tokens = tokenize(`${a.title}\n${a.summary}\n${a.body}`);
    const freq = new Map();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    docs.set(a.id, { freq, length: tokens.length, article: a });
  }
  /* 文档频率：算 IDF 用 */
  const df = new Map();
  for (const d of docs.values()) {
    for (const t of d.freq.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const index = { docs, df, total: docs.size, builtAt: nowIso() };
  indexCache.set(companyId, index);
  indexDirty = false;
  return index;
}

function getIndex(companyId) {
  if (indexDirty || !indexCache.has(companyId)) buildIndex(companyId);
  return indexCache.get(companyId) || null;
}

/**
 * 全文检索（BM25）
 * @param {string} companyId 严格限定在该企业内部
 * @param {string} query
 * @param {{limit?:number, type?:string, includeExemplars?:boolean}} opts
 */
function search(companyId, query, opts) {
  const o = opts || {};
  const c = getCompany(companyId);
  if (!c) return { ok: false, error: "企业不存在", hits: [] };
  const index = getIndex(companyId);
  if (!index || !index.total) {
    return { ok: true, hits: [], total: 0, reason: "该企业还没有可用于检索的文章" };
  }
  const q = String(query || "").trim();
  if (!q) {
    /* 空查询：返回可用的文章（按导入时间倒序），作为「有哪些资料」的清单 */
    const hits = c.articles
      .filter((a) => isUsable(a))
      .slice(0, o.limit || 8)
      .map((a) => ({
        articleId: a.id, title: a.title, sourceUrl: a.sourceUrl, score: 0,
        contentType: a.contentType, tags: a.tags, wordCount: a.body.replace(/\s/g, "").length,
        excerpt: (a.summary || a.body).slice(0, 160),
      }));
    return { ok: true, hits, total: hits.length };
  }

  const qTokens = tokenize(q);
  const uniq = Array.from(new Set(qTokens));
  const N = index.total || 1;
  const k1 = 1.4, b = 0.72;
  const avgLen = Array.from(index.docs.values()).reduce((s, d) => s + d.length, 0) / N || 1;

  const scored = [];
  for (const [docId, d] of index.docs) {
    let score = 0;
    const matched = [];
    for (const t of uniq) {
      const tf = d.freq.get(t) || 0;
      if (!tf) continue;
      const df = index.df.get(t) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = 1 - b + b * (d.length / avgLen);
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
      matched.push(t);
    }
    if (score <= 0) continue;
    /* 范文略微加权：用户明确指定「优秀范文」的更该被参考 */
    if (o.includeExemplars !== false && d.article.exemplar) score *= 1.25;
    scored.push({ article: d.article, score, matched });
  }

  scored.sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(Number(o.limit) || 6, 20));
  const hits = scored.slice(0, limit).map((s) => {
    const a = s.article;
    return {
      articleId: a.id,
      title: a.title,
      sourceUrl: a.sourceUrl,
      score: Math.round(s.score * 100) / 100,
      contentType: a.contentType,
      tags: a.tags,
      wordCount: a.body.replace(/\s/g, "").length,
      exemplar: !!a.exemplar,
      excerpt: excerptAround(a.body, s.matched, 200),
    };
  });
  return { ok: true, hits, total: scored.length };
}

/** 截取命中词附近的片段 */
function excerptAround(body, tokens, len) {
  const s = String(body || "");
  if (!tokens.length) return s.slice(0, len);
  const lower = s.toLowerCase();
  let best = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) return s.slice(0, len);
  const start = Math.max(0, best - 40);
  return (start > 0 ? "…" : "") + s.slice(start, start + len) + (start + len < s.length ? "…" : "");
}

/**
 * 取文章片段（按关键词切段，取最相关的几段）
 * 用于把「写什么」的事实片段喂给模型。
 */
function extractSnippets(companyId, articleId, query, maxChars) {
  const a = getArticle(companyId, articleId);
  if (!a) return [];
  const limit = Math.max(200, Math.min(Number(maxChars) || 1200, 6000));
  const paras = a.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const qTokens = Array.from(new Set(tokenize(query)));
  const scored = paras.map((p, i) => {
    const low = p.toLowerCase();
    let sc = 0;
    for (const t of qTokens) if (low.includes(t)) sc++;
    return { p, i, sc };
  });
  /* 命中不到的段落排后面，但保留原文顺序的相对位置感 */
  const chosen = scored.filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 6);
  if (!chosen.length) {
    return [{ index: 0, text: paras.slice(0, 3).join("\n").slice(0, limit) }];
  }
  chosen.sort((a, b) => a.i - b.i);
  let out = "";
  const outArr = [];
  for (const c of chosen) {
    if (out.length + c.p.length > limit) break;
    outArr.push({ index: c.i, text: c.p });
    out += c.p + "\n";
  }
  if (!outArr.length) outArr.push({ index: 0, text: paras[0] ? paras[0].slice(0, limit) : "" });
  return outArr;
}

/** 企业资料概览 */
function companyStats(companyId) {
  const c = getCompany(companyId);
  if (!c) return null;
  const usable = c.articles.filter((a) => isUsable(a));
  const analyzed = c.articles.filter((a) => a.analyzeStatus === "success");
  return {
    total: c.articles.length,
    usable: usable.length,
    failed: c.articles.filter((a) => a.collectStatus === "failed").length,
    pending: c.articles.filter((a) => a.collectStatus === "pending").length,
    manual: c.articles.filter((a) => a.collectStatus === "manual").length,
    analyzed: analyzed.length,
    excluded: c.articles.filter((a) => a.excluded).length,
    exemplars: c.articles.filter((a) => a.exemplar).length,
    styleVersion: c.styleProfile ? c.styleProfile.version || 0 : 0,
    citations: c.citations.length,
    words: usable.reduce((s, a) => s + a.body.replace(/\s/g, "").length, 0),
  };
}

/** 索引失效：文章改了就重建（写作检索必须用最新内容） */
function invalidateIndex(companyId) {
  indexCache.delete(companyId);
  indexDirty = true;
}

function init() {
  load();
  return db.companies.length;
}

module.exports = {
  CONTENT_TYPES,
  bodyFingerprint,
  tokenize,
  init,
  load,
  save,
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  listArticles,
  getArticle,
  findByUrl,
  findByFingerprint,
  addArticle,
  updateArticleBody,
  updateArticleMeta,
  deleteArticle,
  getStyleProfile,
  saveStyleProfile,
  saveCitation,
  listCitations,
  buildIndex,
  getIndex,
  invalidateIndex,
  search,
  extractSnippets,
  companyStats,
  storeFile,
};
