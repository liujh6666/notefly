/*
 * 回归用例：数据存储目录管理（lib/data-dir.js）
 * 覆盖：优先级解析、指针读写、目标校验、迁移与逐项容错。
 *
 * 指针文件固定落在 os.homedir()/.notefly/location.json —— 为了不污染真实用户目录，
 * 本文件在 require 之前把 HOME / USERPROFILE 指到临时目录。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-datadir-"));
const FAKE_HOME = path.join(TMP, "home");
fs.mkdirSync(FAKE_HOME, { recursive: true });

/* 必须在 require("lib/data-dir") 之前改：HOME_DIR 是模块加载时算出来的常量 */
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const dataDir = require("../lib/data-dir");

const DATA_A = path.join(TMP, "dataA");
const DATA_B = path.join(TMP, "dataB");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("默认目录是应用根下的 data/", () => {
  assert.equal(dataDir.DEFAULT_DIR, path.join(dataDir.APP_ROOT, "data"));
  assert.equal(dataDir.isDefault(dataDir.DEFAULT_DIR), true);
  assert.equal(dataDir.isDefault(DATA_A), false);
});

test("指针文件放在用户主目录，不在 data/ 里", () => {
  /* 指针若在 data/ 内，换目录时会被一起搬走，就再也找不到当前目录 */
  assert.equal(dataDir.HOME_DIR, path.join(FAKE_HOME, ".notefly"));
  assert.equal(dataDir.POINTER_FILE, path.join(FAKE_HOME, ".notefly", "location.json"));
  assert.ok(!dataDir.POINTER_FILE.startsWith(dataDir.DEFAULT_DIR));
});

test("指针读写往返；清掉指针后回落到默认目录", () => {
  assert.equal(dataDir.readPointer(), "", "初始没有指针");
  dataDir.writePointer(DATA_A);
  assert.equal(dataDir.readPointer(), DATA_A);
  assert.ok(fs.existsSync(dataDir.POINTER_FILE));
  dataDir.clearPointer();
  assert.equal(dataDir.readPointer(), "");
});

test("NOTEFLY_DATA_DIR 优先级最高，压过指针文件", () => {
  dataDir.writePointer(DATA_A);
  process.env.NOTEFLY_DATA_DIR = DATA_B;
  try {
    assert.equal(dataDir.resolve(), path.resolve(DATA_B));
    assert.equal(dataDir.init(), path.resolve(DATA_B));
    assert.equal(dataDir.get(), path.resolve(DATA_B));
  } finally {
    delete process.env.NOTEFLY_DATA_DIR;
  }
  /* 环境变量撤掉后，指针重新生效 */
  assert.equal(dataDir.resolve(), DATA_A);
});

test("所有数据路径都跟着当前目录走", () => {
  dataDir.setCurrent(DATA_A);
  assert.equal(dataDir.get(), DATA_A);
  assert.equal(dataDir.storeFile(), path.join(DATA_A, "store.json"));
  assert.equal(dataDir.configFile(), path.join(DATA_A, "config.json"));
  assert.equal(dataDir.wordsFile(), path.join(DATA_A, "forbidden-words.txt"));
  assert.equal(dataDir.uploads(), path.join(DATA_A, "uploads"));
  assert.equal(dataDir.profileDir(), path.join(DATA_A, "browser-profile"));
  assert.equal(dataDir.stateDir(), path.join(DATA_A, "storage-state"));
});

test("validateTarget：空值 / 相对路径 / 可创建可写", () => {
  assert.equal(dataDir.validateTarget("").ok, false);
  assert.equal(dataDir.validateTarget("   ").ok, false);
  const rel = dataDir.validateTarget("relative/dir");
  assert.equal(rel.ok, false);
  assert.match(rel.error, /绝对路径/);

  const target = path.join(TMP, "created", "nested");
  const ok = dataDir.validateTarget(target);
  assert.equal(ok.ok, true);
  assert.equal(ok.dir, path.resolve(target));
  assert.ok(fs.existsSync(target), "校验时应把目录建出来");
  /* 写探针文件必须已清理 */
  assert.deepEqual(fs.readdirSync(target), []);
});

test("migrate：搬走数据文件与目录型数据", () => {
  const from = path.join(TMP, "m1");
  const to = path.join(TMP, "m2");
  fs.mkdirSync(path.join(from, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(from, "storage-state"), { recursive: true });
  fs.writeFileSync(path.join(from, "store.json"), "{}");
  fs.writeFileSync(path.join(from, "config.json"), '{"engine":"rpa"}');
  fs.writeFileSync(path.join(from, "forbidden-words.txt"), "违禁词");
  fs.writeFileSync(path.join(from, "uploads", "a.png"), "png");
  fs.writeFileSync(path.join(from, "storage-state", "juejin.json"), "{}");

  const r = dataDir.migrate(from, to);
  assert.equal(r.ok, true);
  assert.ok(r.moved.includes("store.json"));
  assert.ok(r.moved.includes("uploads"));
  assert.ok(r.moved.includes("storage-state"));
  assert.equal(fs.readFileSync(path.join(to, "store.json"), "utf8"), "{}");
  assert.equal(fs.readFileSync(path.join(to, "uploads", "a.png"), "utf8"), "png");
  /* 源目录保留不动 */
  assert.ok(fs.existsSync(path.join(from, "store.json")));
});

test("migrate：目标已存在同名目录时跳过，不覆盖", () => {
  const from = path.join(TMP, "m3");
  const to = path.join(TMP, "m4");
  fs.mkdirSync(path.join(from, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(to, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(from, "uploads", "old.png"), "old");
  fs.writeFileSync(path.join(to, "uploads", "new.png"), "new");

  const r = dataDir.migrate(from, to);
  assert.equal(r.ok, true);
  assert.ok(r.skipped.includes("uploads"));
  assert.ok(!r.moved.includes("uploads"));
  assert.equal(fs.readFileSync(path.join(to, "uploads", "new.png"), "utf8"), "new");
  assert.ok(!fs.existsSync(path.join(to, "uploads", "old.png")));
});

test("migrate：源目录不存在文件时不报错", () => {
  const r = dataDir.migrate(path.join(TMP, "empty-src"), path.join(TMP, "empty-dst"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.skipped, []);
});

test("migrate：同一目录直接返回空操作", () => {
  const r = dataDir.migrate(DATA_A, DATA_A);
  assert.equal(r.ok, true);
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.skipped, []);
});
