/*
 * NoteFly 运行日志
 * ------------------------------------------------------------
 * 目标：把所有「操作」与「报错」都留下来，让用户不用去翻控制台就能看到
 *      刚才到底做了什么、哪里失败了。
 *
 * 设计取舍：
 *  1. 日志落在数据目录下的 logs/ 里（与 store.json / uploads 同级）。
 *     —— 保持「所有数据都在一个目录」的口径：备份、搬家、发给客服都是同一个文件夹。
 *     —— 切换数据目录时日志跟着搬（见 lib/data-dir.js 的 migrate）。
 *     —— 打包导出时 data/ 整个排除，用户日志不会外泄（见 _export/pack.js）。
 *     —— 测试可用 NOTEFLY_LOG_DIR 覆盖，绝不污染真实数据目录。
 *  2. 双层存储：内存环形缓冲（最近 3000 条，秒开）+ 磁盘 JSONL（按天分文件）。
 *     内存给「看最新」，磁盘给「查历史」。
 *  3. 写日志永远不能影响主流程：落盘异步、失败静默降级、绝不让业务请求挂掉。
 *  4. 敏感信息一律脱敏：API Key / Cookie / Token 不进日志。
 */

"use strict";

const fs = require("fs");
const path = require("path");

/* 等级：数值越大越严重，便于按等级过滤 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = Object.keys(LEVELS);

/* 内存环形缓冲上限：超过就把最旧的丢掉 */
const MAX_MEMORY = 3000;
/* 磁盘保留天数 */
const RETAIN_DAYS = 14;
/* 单个日志文件上限：超过就滚到 .1（只保留一代） */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/* 内存缓冲 */
let buffer = [];
/* 统计计数（进程级，用于「查看日志」面板顶部的概况） */
const counters = { debug: 0, info: 0, warn: 0, error: 0, writeFailed: 0 };
/* 串行化写盘，避免并发 append 打乱顺序 */
let writeChain = Promise.resolve();
/* 写盘代号：每次清空日志自增，让清空前排队的写入自动作废 */
let writeGeneration = 0;
/* 当天文件已清理过过期文件 */
let cleanedFor = "";

/* ------------------------------------------------------------------ *
 * 目录解析
 * ------------------------------------------------------------------ */

/**
 * 日志目录：默认跟随当前数据目录（<data>/logs）。
 * 惰性 require data-dir —— 避免模块初始化顺序问题；拿不到就退回用户主目录。
 */
function logsDir() {
  if (process.env.NOTEFLY_LOG_DIR) return path.resolve(process.env.NOTEFLY_LOG_DIR);
  try {
    const dataDir = require("./data-dir");
    return path.join(dataDir.get(), "logs");
  } catch {
    const os = require("os");
    return path.join(os.homedir(), ".notefly", "logs");
  }
}

/* ------------------------------------------------------------------ *
 * 脱敏
 * ------------------------------------------------------------------ */

const SECRET_KEYS = /^(api_?key|apikey|key|token|access_?token|refresh_?token|secret|password|passwd|authorization|cookie|cookies|session|credential)$/i;

/* 日志文本里可能夹带的密钥形态 */
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_\-]{6,}/g, "sk-***"],
  [/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer ***"],
  [/\b[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, "***.***.***"],
];

/** 把一段文本里的密钥形态遮掉 */
function redactText(s) {
  let out = String(s == null ? "" : s);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** 深度脱敏一个对象：敏感键直接打码，其余递归处理 */
function redactValue(v, depth) {
  const d = depth || 0;
  if (d > 4) return "[深度超限]";
  if (v == null) return v;
  if (typeof v === "string") return redactText(v);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, d + 1));
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).slice(0, 50)) {
      out[k] = SECRET_KEYS.test(k) ? "***" : redactValue(v[k], d + 1);
    }
    return out;
  }
  return String(v);
}

/* ------------------------------------------------------------------ *
 * 文件读写
 * ------------------------------------------------------------------ */

/** 某天对应的日志文件名（按本地日期） */
function fileNameFor(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `notefly-${y}${m}${day}.log`;
}

function currentFile() {
  return path.join(logsDir(), fileNameFor(new Date()));
}

/** 列出日志文件（新的在前） */
function listFiles() {
  let names = [];
  try {
    names = fs.readdirSync(logsDir()).filter((n) => /^notefly-\d{8}(\.\d)?\.log$/.test(n));
  } catch {
    return [];
  }
  /* notefly-20261104.log 比 notefly-20261104.1.log 新 → 排序时基础名优先 */
  names.sort((a, b) => {
    const base = (n) => n.replace(/\.\d+\.log$/, ".log");
    if (base(a) === base(b)) return a < b ? 1 : -1;
    return base(a) < base(b) ? 1 : -1;
  });
  return names.map((n) => path.join(logsDir(), n));
}

/** 清掉超过保留天数的旧日志；每天只做一次 */
function cleanupOldFiles() {
  const today = fileNameFor(new Date());
  if (cleanedFor === today) return;
  cleanedFor = today;
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  for (const f of listFiles()) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs < cutoff) fs.rmSync(f, { force: true });
    } catch {
      /* 删不掉不影响其它文件 */
    }
  }
}

/** 把一行追加到当天文件（异步、串行、失败不影响主流程） */
function appendLine(entry, generation) {
  const line = JSON.stringify(entry) + "\n";
  const gen = generation === undefined ? writeGeneration : generation;
  writeChain = writeChain
    .then(async () => {
      /* 清空日志后，先前排队的写入必须作废，否则会把已清掉的内容又写回来 */
      if (gen !== writeGeneration) return;
      cleanupOldFiles();
      const file = currentFile();
      /* 单文件超限：滚一代，避免无限膨胀 */
      try {
        const st = fs.statSync(file);
        if (st.size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
          const rolled = file.replace(/\.log$/, ".1.log");
          try { fs.rmSync(rolled, { force: true }); } catch {}
          fs.renameSync(file, rolled);
        }
      } catch {
        /* 文件不存在 = 正常情况 */
      }
      await fs.promises.mkdir(logsDir(), { recursive: true });
      await fs.promises.appendFile(file, line, "utf8");
    })
    .catch(() => {
      counters.writeFailed++;
    });
}

/** 同步追加一行（只给「马上要退出」的致命路径用，保证日志一定落盘） */
function appendLineSync(entry) {
  try {
    const file = currentFile();
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    counters.writeFailed++;
  }
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/**
 * 写一条日志
 * @param {string} level debug|info|warn|error
 * @param {string} scope 来源分区（如 发布 / AI / 账号）
 * @param {string} message 主消息
 * @param {*} extra 附加信息（会脱敏）
 */
function write(level, scope, message, extra) {
  const lv = LEVELS[level] ? level : "info";
  const entry = {
    ts: new Date().toISOString(),
    level: lv,
    scope: redactText(scope || "应用"),
    message: redactText(message == null ? "" : message),
  };
  if (extra !== undefined && extra !== null) {
    const r = redactValue(extra, 0);
    if (r !== null && r !== undefined && !(typeof r === "object" && Object.keys(r).length === 0)) {
      entry.extra = r;
    }
  }
  buffer.push(entry);
  if (buffer.length > MAX_MEMORY) buffer.splice(0, buffer.length - MAX_MEMORY);
  counters[lv]++;
  appendLine(entry);
  return entry;
}

const debug = (scope, message, extra) => write("debug", scope, message, extra);
const info = (scope, message, extra) => write("info", scope, message, extra);
const warn = (scope, message, extra) => write("warn", scope, message, extra);
const error = (scope, message, extra) => write("error", scope, message, extra);

/**
 * 致命错误：同步落盘（进程即将退出，异步写来不及）
 */
function fatal(scope, message, extra) {
  const lv = "error";
  const entry = {
    ts: new Date().toISOString(),
    level: lv,
    scope: redactText(scope || "应用"),
    message: redactText(message == null ? "" : message),
  };
  if (extra !== undefined && extra !== null) {
    const r = redactValue(extra, 0);
    if (r !== null && r !== undefined && !(typeof r === "object" && Object.keys(r).length === 0)) {
      entry.extra = r;
    }
  }
  buffer.push(entry);
  counters[lv]++;
  appendLineSync(entry);
  return entry;
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

/** 解析一个日志文件里的所有条目（坏行跳过，不让坏文件读不出来） */
function readEntries(file) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.ts) out.push(e);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/**
 * 列出日志（新的在前）
 *
 * 合并「内存缓冲 + 磁盘文件」两份数据：
 * 落盘是异步的，刚写完立刻读磁盘可能还拿不到 —— 用户点完「保存」就打开日志面板，
 * 不能看到空白。内存里的条目与磁盘条目用「时间戳+内容」去重。
 *
 * level 是「阈值」而非「精确匹配」：传 warn 表示「警告及以上」。
 * 只有不传 level 时才包含 debug —— 读接口的调试记录很多，默认不该淹没真正的操作。
 *
 * @param {{limit?:number, level?:string, keyword?:string, scope?:string}} opts
 */
function list(opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(Number(o.limit) || 200, 2000));
  const level = o.level && LEVELS[o.level] ? o.level : "";
  const minLevel = level ? LEVELS[level] : 0;
  const kw = String(o.keyword || "").trim().toLowerCase();
  const scope = String(o.scope || "").trim().toLowerCase();

  const out = [];
  const seen = new Set();
  const key = (e) => `${e.ts}|${e.level}|${e.scope}|${e.message}`;

  const push = (e) => {
    if (out.length >= limit) return;
    const k = key(e);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  /* 先收内存（最新，写得最全），再补磁盘（更久远的历史） */
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    if (LEVELS[e.level] === undefined || LEVELS[e.level] < minLevel) continue;
    if (scope && String(e.scope || "").toLowerCase() !== scope) continue;
    if (kw) {
      const hay = `${e.scope || ""} ${e.message || ""} ${e.extra ? JSON.stringify(e.extra) : ""}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    push(e);
  }

  for (const f of listFiles()) {
    if (out.length >= limit) break;
    const entries = readEntries(f);
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = entries[i];
      if (LEVELS[e.level] === undefined || LEVELS[e.level] < minLevel) continue;
      if (scope && String(e.scope || "").toLowerCase() !== scope) continue;
      if (kw) {
        const hay = `${e.scope || ""} ${e.message || ""} ${e.extra ? JSON.stringify(e.extra) : ""}`.toLowerCase();
        if (!hay.includes(kw)) continue;
      }
      push(e);
    }
  }
  return out;
}

/** 全量统计：按级别计数 + 文件数 + 目录 */
function stats() {
  const byLevel = { debug: 0, info: 0, warn: 0, error: 0 };
  let total = 0;
  const seen = new Set();
  const key = (e) => `${e.ts}|${e.level}|${e.scope}|${e.message}`;
  /* 与 list() 同样合并内存与磁盘，否则刚写完统计会是 0 */
  const all = list({ limit: 2000 });
  for (const e of all) {
    const k = key(e);
    if (seen.has(k)) continue;
    seen.add(k);
    total++;
    if (byLevel[e.level] !== undefined) byLevel[e.level]++;
  }
  const files = listFiles();
  let size = 0;
  for (const f of files) {
    try { size += fs.statSync(f).size; } catch {}
  }
  return {
    dir: logsDir(),
    file: currentFile(),
    files: files.length,
    size,
    total,
    byLevel,
    retainDays: RETAIN_DAYS,
    memory: buffer.length,
    writeFailed: counters.writeFailed,
  };
}

/** 全部日志导出成纯文本（用于「复制」「另存为」） */
function toText(opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(Number(o.limit) || 5000, 20000));
  const rows = list({ limit, level: o.level, keyword: o.keyword, scope: o.scope });
  const lines = rows.map((e) => {
    const time = new Date(e.ts).toLocaleString("zh-CN", { hour12: false });
    const lv = String(e.level || "info").toUpperCase().padEnd(5, " ");
    const sc = String(e.scope || "");
    const extra = e.extra ? " " + JSON.stringify(e.extra) : "";
    return `[${time}] ${lv} [${sc}] ${e.message || ""}${extra}`;
  });
  return lines.join("\n");
}

/** 清空日志（磁盘文件 + 内存缓冲 + 计数） */
function clear() {
  /* 先自增代号：清空前排队的异步写入到这里会被丢弃 */
  writeGeneration++;
  buffer = [];
  for (const k of LEVEL_NAMES) counters[k] = 0;
  const files = listFiles();
  for (const f of files) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
  /* 把「再删一次」排到写盘队列末尾：
     正在飞行中的 appendFile 可能在删完文件后又把文件写回来（内容还是旧的）。
     队列末尾再删一次就能兜住；清空之后新写的条目排在这次清理之后，不会被误删。 */
  writeChain = writeChain
    .then(async () => {
      for (const f of listFiles()) {
        try { fs.rmSync(f, { force: true }); } catch {}
      }
    })
    .catch(() => {});
  return { ok: true, removed: files.length };
}

/* 启动时先清一次过期文件 */
function init() {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
  } catch {
    /* 建不出来也不影响启动，只是没有磁盘日志 */
  }
  cleanupOldFiles();
  return logsDir();
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  MAX_MEMORY,
  RETAIN_DAYS,
  init,
  logsDir,
  debug,
  info,
  warn,
  error,
  fatal,
  write,
  list,
  stats,
  toText,
  clear,
  redactText,
  redactValue,
  currentFile,
  listFiles,
};
