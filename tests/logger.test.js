/*
 * 回归用例：运行日志（lib/logger.js + lib/log-http.js）
 * 覆盖：写入与读取、级别过滤、关键词过滤、磁盘落盘与重启后可读、
 *       敏感信息脱敏、轮询接口跳过、错误分级、清空。
 *
 * 日志目录用 NOTEFLY_LOG_DIR 指到临时区，绝不污染真实用户目录。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-log-"));
const LOG_DIR = path.join(TMP, "logs");
process.env.NOTEFLY_LOG_DIR = LOG_DIR;

const logger = require("../lib/logger");
const logHttp = require("../lib/log-http");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

/* 落盘是异步的：等它落完再断言 */
const settle = () => new Promise((r) => setTimeout(r, 120));

test("日志目录可配置（测试不污染真实目录）", () => {
  assert.equal(logger.logsDir(), LOG_DIR);
  assert.ok(LOG_DIR.startsWith(TMP));
  logger.init();
  assert.ok(fs.existsSync(LOG_DIR));
});

test("写入后能按级别与关键词读回", () => {
  logger.clear();
  logger.info("发布任务", "创建任务「测试稿」", { 平台: ["juejin"] });
  logger.warn("登录引擎", "登录检查：zhihu 未登录");
  logger.error("AI 模型", "模型调用失败：超时");
  logger.debug("接口", "GET /api/contents → 200");

  const all = logger.list({ limit: 100 });
  assert.equal(all.length, 4);

  const errs = logger.list({ limit: 100, level: "error" });
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /模型调用失败/);

  const kw = logger.list({ limit: 100, keyword: "zhihu" });
  assert.equal(kw.length, 1);
  assert.equal(kw[0].scope, "登录引擎");

  /* 列表是新的在前：最后写入的 debug 应排在最前 */
  const ordered = logger.list({ limit: 100 });
  assert.match(ordered[0].message, /GET \/api\/contents/);
  assert.match(ordered[ordered.length - 1].message, /创建任务/);
});

test("附加信息里的敏感字段被打码（API Key 不进日志）", () => {
  logger.clear();
  logger.info("AI 模型", "保存配置", { apiKey: "sk-abcdef123456789", token: "tok_secret_value" });
  const hit = logger.list({ limit: 10 })[0];
  assert.equal(hit.extra.apiKey, "***");
  assert.equal(hit.extra.token, "***");
  /* 文本里的密钥形态也要遮 */
  logger.info("AI 模型", "调用失败 sk-abcdef123456789");
  const masked = logger.list({ limit: 10, keyword: "调用失败" })[0];
  assert.doesNotMatch(masked.message, /sk-abcdef123456789/);
  assert.match(masked.message, /sk-\*\*\*/);
});

test("日志落盘成 JSONL，重启后仍可读", async () => {
  logger.clear();
  await settle();
  logger.info("内容库", "落盘验证条目");
  await settle();
  const files = fs.readdirSync(LOG_DIR).filter((n) => /^notefly-\d{8}\.log$/.test(n));
  assert.ok(files.length >= 1, "应生成当天日志文件");
  const raw = fs.readFileSync(path.join(LOG_DIR, files[0]), "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.message, "落盘验证条目");
  assert.equal(parsed.level, "info");
  assert.ok(parsed.ts);
  /* 每一行都必须是合法 JSON（JSONL 格式），不能是半截 JSON */
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test("坏行不影响整份日志的读取", async () => {
  logger.clear();
  logger.info("内容库", "坏行之前的条目");
  await settle();
  const files = fs.readdirSync(LOG_DIR).filter((n) => /^notefly-\d{8}\.log$/.test(n));
  fs.appendFileSync(path.join(LOG_DIR, files[0]), "这不是 JSON\n", "utf8");
  logger.info("内容库", "坏行之后的条目");
  await settle();
  const list = logger.list({ limit: 50 });
  assert.ok(list.some((e) => e.message === "坏行之前的条目"));
  assert.ok(list.some((e) => e.message === "坏行之后的条目"));
});

test("统计按级别计数，清空后归零", () => {
  logger.clear();
  logger.info("A", "一");
  logger.warn("A", "二");
  logger.error("A", "三");
  const s = logger.stats();
  assert.equal(s.byLevel.info, 1);
  assert.equal(s.byLevel.warn, 1);
  assert.equal(s.byLevel.error, 1);
  assert.equal(s.total, 3);
  assert.equal(s.dir, LOG_DIR);
  assert.ok(s.retainDays >= 1);

  logger.clear();
  assert.equal(logger.stats().total, 0);
  assert.equal(logger.list({ limit: 10 }).length, 0);
});

test("导出纯文本包含时间、级别与分区", () => {
  logger.clear();
  logger.error("发布任务", "导出验证：任务失败");
  const text = logger.toText({});
  assert.match(text, /发布任务/);
  assert.match(text, /导出验证：任务失败/);
  assert.match(text, /ERROR/);
});

test("内存缓冲有上限，不会无限增长", () => {
  logger.clear();
  for (let i = 0; i < logger.MAX_MEMORY + 50; i++) logger.debug("压力", "第 " + i + " 条");
  const s = logger.stats();
  assert.ok(s.memory <= logger.MAX_MEMORY, "内存条数应受上限约束");
});

/* ---------------- HTTP 中间件的取舍 ---------------- */

test("轮询接口与日志接口自身不记（否则日志会被刷屏）", () => {
  assert.equal(logHttp.shouldLog("/api/tasks"), false);
  assert.equal(logHttp.shouldLog("/api/tasks/abc/status"), false);
  assert.equal(logHttp.shouldLog("/api/stats"), false);
  assert.equal(logHttp.shouldLog("/api/config"), false);
  assert.equal(logHttp.shouldLog("/api/logs"), false);
  assert.equal(logHttp.shouldLog("/api/logs/export"), false);
  /* 真正的操作要记 */
  assert.equal(logHttp.shouldLog("/api/contents"), true);
  assert.equal(logHttp.shouldLog("/api/publish"), true);
  assert.equal(logHttp.shouldLog("/api/ai/run"), true);
  /* 静态资源不记 */
  assert.equal(logHttp.shouldLog("/index.html"), false);
});

test("请求体摘要只留键名与短字段，不留正文", () => {
  const s = logHttp.bodySummary({ title: "标题", body: "很长的正文内容".repeat(50), tags: ["a"] });
  assert.deepEqual(s.字段, ["title", "body", "tags"]);
  assert.equal(s.title, "标题");
  /* 长正文不落进摘要 */
  assert.equal(s.body, undefined);
  assert.equal(logHttp.bodySummary({}), undefined);
  assert.equal(logHttp.bodySummary(null), undefined);
});

test("中间件按状态码分级：5xx→error，4xx→warn，写操作→info，读操作→debug", async () => {
  logger.clear();
  /* 每个请求用不同的路径，便于在列表里精确定位 */
  const mk = (method, status, path) => {
    const handlers = {};
    const res = {
      statusCode: status,
      writableEnded: false,
      on(ev, fn) { handlers[ev] = fn; return res; },
    };
    const req = { method, path, originalUrl: path, body: { title: "x" } };
    const mw = logHttp.logHttpMiddleware(() => "内容库");
    mw(req, res, () => {});
    handlers.finish();
    return handlers;
  };
  mk("POST", 200, "/api/contents");
  mk("POST", 404, "/api/contents/missing");
  mk("POST", 500, "/api/contents/boom");
  mk("GET", 200, "/api/contents/list");
  await settle();

  const list = logger.list({ limit: 50 });
  const byPath = (p) => list.find((e) => e.message.includes(p));
  assert.equal(byPath("/api/contents →").level, "info");
  assert.equal(byPath("/api/contents/missing").level, "warn");
  assert.equal(byPath("/api/contents/boom").level, "error");
  const get = byPath("/api/contents/list");
  assert.equal(get.level, "debug");
  assert.equal(get.scope, "内容库");
});
