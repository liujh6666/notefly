/*
 * NoteFly 数据存储目录管理
 * ------------------------------------------------------------
 * 「设置 → 数据存储」要能改数据存放位置。难点在于：指针文件本身不能放在
 * data/ 里 —— 换目录时它会被一起搬走，就再也找不到「现在的目录在哪」。
 *
 * 因此指针放在用户主目录（~/.notefly/location.json），与应用目录无关：
 *   优先级  NOTEFLY_DATA_DIR 环境变量 > 指针文件 > <应用根>/data
 *
 * 目录切换做成【运行时热切换】，不要求重启应用：
 *   数据文件（store/config/uploads/登录态）先迁移到新目录，再切指针与内存态。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/* 应用根目录：server.js 与 engines/rpa.js 都在根目录下一层，../ 即根 */
const APP_ROOT = path.join(__dirname, "..");
const DEFAULT_DIR = path.join(APP_ROOT, "data");
/* 指针文件目录：用户主目录下的 .notefly，随用户走，不随应用搬家 */
const HOME_DIR = path.join(os.homedir(), ".notefly");
const POINTER_FILE = path.join(HOME_DIR, "location.json");

/* 运行时当前目录（绝对路径）。空表示尚未解析。 */
let current = "";

/** 读取指针文件；读不到/坏了都当作「没设置过」 */
function readPointer() {
  try {
    const j = JSON.parse(fs.readFileSync(POINTER_FILE, "utf8"));
    if (j && typeof j.dataDir === "string" && j.dataDir.trim()) return path.resolve(j.dataDir.trim());
  } catch {
    /* 文件不存在是正常情况（首次运行） */
  }
  return "";
}

/** 写入指针文件 */
function writePointer(dir) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const payload = { dataDir: path.resolve(dir), updatedAt: new Date().toISOString() };
  const tmp = `${POINTER_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, POINTER_FILE);
}

/** 删除指针（恢复默认目录） */
function clearPointer() {
  try {
    fs.rmSync(POINTER_FILE, { force: true });
  } catch {
    /* 删不掉不算致命：下次解析仍会因文件损坏回落到默认 */
  }
}

/** 按优先级解析应使用的目录 */
function resolve() {
  if (process.env.NOTEFLY_DATA_DIR) return path.resolve(process.env.NOTEFLY_DATA_DIR);
  const p = readPointer();
  if (p) return p;
  return DEFAULT_DIR;
}

/** 初始化（服务端启动时调用一次） */
function init() {
  current = resolve();
  return current;
}

/** 当前数据目录；未初始化时按需解析 */
function get() {
  if (!current) current = resolve();
  return current;
}

/** 运行时切换到指定目录（迁移与校验由调用方负责） */
function setCurrent(dir) {
  current = path.resolve(dir);
  return current;
}

const uploads = () => path.join(get(), "uploads");
const storeFile = () => path.join(get(), "store.json");
const configFile = () => path.join(get(), "config.json");
const wordsFile = () => path.join(get(), "forbidden-words.txt");
/* 运行日志：与其它数据同目录，换目录时一起搬走 */
const logsDir = () => path.join(get(), "logs");
/* 登录态：Chromium 持久化配置 + 从内置浏览器导入的 storage-state */
const profileDir = () => path.join(get(), "browser-profile");
const stateDir = () => path.join(get(), "storage-state");

/** 该目录是否就是默认目录（用于界面提示「当前为默认位置」） */
function isDefault(dir) {
  return path.resolve(dir || get()) === path.resolve(DEFAULT_DIR);
}

/**
 * 校验目标目录是否可用：绝对路径、可创建、可写。
 * 返回 { ok, dir, error }
 */
function validateTarget(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "目录不能为空" };
  if (!path.isAbsolute(raw)) return { ok: false, error: "请填写绝对路径（例如 D:\\NoteFlyData）" };
  const abs = path.resolve(raw);
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch (e) {
    return { ok: false, error: "无法创建目录：" + String(e.message || e) };
  }
  /* 写权限探针：建目录成功不代表能写文件 */
  const probe = path.join(abs, `.notefly-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
  } catch (e) {
    return { ok: false, error: "目录不可写：" + String(e.message || e) };
  }
  return { ok: true, dir: abs };
}

/**
 * 把现有数据从 from 迁移到 to。
 * 只搬 NoteFly 自己的东西，不碰目录里的其它文件。
 * 每一项独立容错：某个文件被占用（例如 Chromium 正在跑）不该让整次迁移失败。
 * 返回 { ok, moved: [...], skipped: [...], error }
 */
function migrate(from, to) {
  const src = path.resolve(from);
  const dst = path.resolve(to);
  if (src === dst) return { ok: true, moved: [], skipped: [], error: "" };

  const moved = [];
  const skipped = [];
  try {
    fs.mkdirSync(dst, { recursive: true });
  } catch (e) {
    return { ok: false, moved, skipped, error: "无法创建目标目录：" + String(e.message || e) };
  }

  /* 单个数据文件 */
  for (const name of ["store.json", "config.json", "forbidden-words.txt"]) {
    const s = path.join(src, name);
    if (!fs.existsSync(s)) continue;
    try {
      fs.copyFileSync(s, path.join(dst, name));
      moved.push(name);
    } catch (e) {
      skipped.push(`${name}（${String(e.message || e)}）`);
    }
  }

  /* 目录型数据：上传素材、Chromium 配置、登录态、运行日志 */
  for (const name of ["uploads", "browser-profile", "storage-state", "logs"]) {
    const s = path.join(src, name);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dst, name);
    /* 目标已存在同名目录时不覆盖：跳过并告知，避免抹掉新目录里的东西 */
    if (fs.existsSync(d)) {
      skipped.push(name);
      continue;
    }
    try {
      fs.cpSync(s, d, { recursive: true, force: false, errorOnExist: false });
      moved.push(name);
    } catch (e) {
      /* Chromium 正开着 profile 目录时部分文件会被锁：这一项跳过，其余照迁 */
      skipped.push(`${name}（${String(e.message || e)}）`);
    }
  }

  return { ok: true, moved, skipped, error: "" };
}

module.exports = {
  APP_ROOT,
  DEFAULT_DIR,
  HOME_DIR,
  POINTER_FILE,
  init,
  get,
  resolve,
  setCurrent,
  uploads,
  storeFile,
  configFile,
  wordsFile,
  logsDir,
  profileDir,
  stateDir,
  readPointer,
  writePointer,
  clearPointer,
  isDefault,
  validateTarget,
  migrate,
};
