/*
 * P0 回归：数据迁移不得覆盖目标记录、不得漏迁素材（1104 审查报告 P0-2）
 * 复现场景：源 A 有稿件与 uploads/a.png；目标 B 已有稿件与 uploads/b.png。
 * 旧行为：store.json 直接覆盖（B 记录丢失），uploads 整目录跳过（a.png 缺失）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-datadir-p0-"));
const FAKE_HOME = path.join(TMP, "home");
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const dataDir = require("../lib/data-dir");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function makeSource() {
  const dir = path.join(TMP, "src-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({ contents: [{ id: "a", title: "A稿" }], tasks: [] }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ai: {} }));
  fs.writeFileSync(path.join(dir, "uploads", "a.png"), "A-IMAGE");
  return dir;
}

test("迁移到已有数据的目录：必须拒绝并给出冲突清单，不产生部分覆盖", () => {
  const src = makeSource();
  const dst = path.join(TMP, "dst-full");
  fs.mkdirSync(path.join(dst, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(dst, "store.json"), JSON.stringify({ contents: [{ id: "b", title: "B稿" }], tasks: [] }));
  fs.writeFileSync(path.join(dst, "uploads", "b.png"), "B-IMAGE");

  const r = dataDir.migrate(src, dst);
  assert.equal(r.ok, false, "非空目标必须拒绝迁入");
  assert.ok(Array.isArray(r.conflicts) && r.conflicts.length > 0, "必须给出冲突清单");

  /* 目标内容必须原封不动 */
  const dstStore = JSON.parse(fs.readFileSync(path.join(dst, "store.json"), "utf8"));
  assert.equal(dstStore.contents[0].id, "b", "目标 store.json 不得被覆盖");
  assert.equal(fs.readFileSync(path.join(dst, "uploads", "b.png"), "utf8"), "B-IMAGE", "目标素材不得被动过");
  /* 源内容也原封不动（还能从原目录启动） */
  const srcStore = JSON.parse(fs.readFileSync(path.join(src, "store.json"), "utf8"));
  assert.equal(srcStore.contents[0].id, "a");
});

test("迁移到空目录：全部迁入，素材与稿件同时到位", () => {
  const src = makeSource();
  const dst = path.join(TMP, "dst-empty");
  const r = dataDir.migrate(src, dst);
  assert.equal(r.ok, true, r.error || "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dst, "store.json"), "utf8")).contents[0].id, "a");
  assert.equal(fs.readFileSync(path.join(dst, "uploads", "a.png"), "utf8"), "A-IMAGE", "素材必须随稿件一起到位");
});

test("关键数据复制失败：整体失败并回滚，不留半套数据", () => {
  const src = makeSource();
  const dst = path.join(TMP, "dst-fail");
  fs.mkdirSync(dst, { recursive: true });
  /* 让 config.json 的复制失败：目标上放一个同名「目录」 */
  fs.mkdirSync(path.join(dst, "config.json"));

  const r = dataDir.migrate(src, dst);
  assert.equal(r.ok, false, "关键数据失败必须整体失败");
  assert.equal(
    fs.existsSync(path.join(dst, "store.json")),
    false,
    "回滚后不得残留已复制的 store.json"
  );
});

test("源目录为空/不存在：不是错误，直接成功", () => {
  const ghost = path.join(TMP, "no-such-dir");
  const dst = path.join(TMP, "dst-ghost");
  const r = dataDir.migrate(ghost, dst);
  assert.equal(r.ok, true);
});
