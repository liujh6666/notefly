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

/* 迁移涉及的数据项 */
const MIGRATE_FILES = ["store.json", "config.json", "forbidden-words.txt"];
const MIGRATE_DIRS = ["uploads", "browser-profile", "storage-state", "logs"];
/* 关键数据：任何一项复制失败都必须整体失败并回滚，绝不能「半套数据」 */
const CRITICAL_FILES = ["store.json", "config.json"];

/* 目录是否含 NoteFly 数据（用于判断「目标非空」） */
function hasNoteFlyData(dir) {
  for (const name of MIGRATE_FILES) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  for (const name of MIGRATE_DIRS) {
    const d = path.join(dir, name);
    try {
      if (fs.existsSync(d) && fs.readdirSync(d).length > 0) return true;
    } catch { /* 读不了就当没有 */ }
  }
  return false;
}

/**
 * 把现有数据从 from 迁移到 to。
 * 硬规则（1104 审查 P0-2）：
 *  - 目标已有 NoteFly 数据 → 拒绝迁入，给出冲突清单，一个字节都不动
 *    （旧版「文件覆盖 + 目录跳过」混用会导致：目标记录被覆盖、源素材漏迁、稿件图片错配）
 *  - 关键数据（store/config）复制失败 → 回滚已复制项，整体失败
 *  - 源目录不存在/为空 → 直接成功（没什么可搬）
 * 返回 { ok, moved, skipped, conflicts, error }
 */
function migrate(from, to) {
  const src = path.resolve(from);
  const dst = path.resolve(to);
  if (src === dst) return { ok: true, moved: [], skipped: [], conflicts: [], error: "" };

  const moved = [];
  const skipped = [];
  const conflicts = [];

  /* ---- 第一步：冲突预检（在任何写入之前）---- */
  if (fs.existsSync(dst) && hasNoteFlyData(dst)) {
    for (const name of MIGRATE_FILES) {
      if (fs.existsSync(path.join(dst, name))) conflicts.push(name);
    }
    for (const name of MIGRATE_DIRS) {
      const d = path.join(dst, name);
      try {
        if (fs.existsSync(d) && fs.readdirSync(d).length > 0) conflicts.push(`${name}/`);
      } catch { /* 忽略 */ }
    }
    return {
      ok: false,
      moved,
      skipped,
      conflicts,
      error:
        "目标目录已存在 NoteFly 数据（" + conflicts.join("、") +
        "），为避免覆盖已有记录与素材错配，已停止迁移。请先备份并清空目标目录，或换一个空目录。",
    };
  }

  try {
    fs.mkdirSync(dst, { recursive: true });
  } catch (e) {
    return { ok: false, moved, skipped, conflicts, error: "无法创建目标目录：" + String(e.message || e) };
  }

  /* ---- 第二步：复制（关键数据失败 → 回滚）---- */
  const copied = [];   // 已成功复制到目标的东西，用于回滚
  const rollBack = () => {
    for (const rel of copied.slice().reverse()) {
      const d = path.join(dst, rel);
      try {
        if (fs.statSync(d).isDirectory()) fs.rmSync(d, { recursive: true, force: true });
        else fs.rmSync(d, { force: true });
      } catch { /* 回滚尽力而为 */ }
    }
  };

  for (const name of MIGRATE_FILES) {
    const s = path.join(src, name);
    if (!fs.existsSync(s)) continue;
    try {
      fs.copyFileSync(s, path.join(dst, name));
      copied.push(name);
      moved.push(name);
    } catch (e) {
      if (CRITICAL_FILES.includes(name)) {
        rollBack();
        return { ok: false, moved: [], skipped, conflicts, error: `关键数据 ${name} 复制失败，已回滚：${String(e.message || e)}` };
      }
      skipped.push(`${name}（${String(e.message || e)}）`);
    }
  }

  for (const name of MIGRATE_DIRS) {
    const s = path.join(src, name);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dst, name);
    if (fs.existsSync(d)) {
      /* 冲突预检已保证目标为空，理论上走不到；防御：跳过而非覆盖 */
      skipped.push(name);
      continue;
    }
    try {
      fs.cpSync(s, d, { recursive: true, force: false, errorOnExist: false });
      copied.push(name);
      moved.push(name);
    } catch (e) {
      /* 素材目录复制失败与稿件错配，等同关键失败：回滚 */
      rollBack();
      return { ok: false, moved: [], skipped, conflicts, error: `目录 ${name} 复制失败，已回滚：${String(e.message || e)}` };
    }
  }

  return { ok: true, moved, skipped, conflicts, error: "" };
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
