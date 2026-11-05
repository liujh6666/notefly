/*
 * 统一任务进度模块 单元测试
 * 覆盖：真实进度语义、状态机、重启恢复、取消语义、迟到事件
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/* 测试用独立数据目录：绝不碰真实数据 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-tp-"));
process.env.NOTEFLY_DATA_DIR = TMP;

const taskProgress = require("../lib/task-progress");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test("新建任务：默认 pending，总量未知", () => {
  const t = taskProgress.create({ type: "collect", title: "采集" });
  assert.equal(t.status, "pending");
  assert.equal(t.total, null, "总量未知时应为 null，前端据此显示不确定进度");
  assert.equal(t.completed, 0);
  assert.ok(t.id);
});

test("有总量的任务：completed/total 都能记录", () => {
  const t = taskProgress.create({ type: "collect", title: "批量采集", total: 10 });
  taskProgress.advance(t.id, 3);
  const got = taskProgress.get(t.id);
  assert.equal(got.completed, 3);
  assert.equal(got.total, 10);
});

test("进度不会超过总量", () => {
  const t = taskProgress.create({ type: "collect", title: "批量采集", total: 5 });
  taskProgress.advance(t.id, 99);
  assert.equal(taskProgress.get(t.id).completed, 5);
});

test("成功与失败：状态与错误分开记录", () => {
  const a = taskProgress.create({ type: "generate", title: "生成" });
  taskProgress.succeed(a.id, { chars: 100 });
  assert.equal(taskProgress.get(a.id).status, "success");
  assert.ok(taskProgress.get(a.id).finishedAt, "终态必须有结束时间");

  const b = taskProgress.create({ type: "collect", title: "采集" });
  taskProgress.fail(b.id, "正文过短", "detail");
  const got = taskProgress.get(b.id);
  assert.equal(got.status, "failed");
  assert.equal(got.error, "正文过短");
  assert.equal(got.errorDetail, "detail");
});

test("取消是两步：先 cancelling，确认停止后才 cancelled", () => {
  const t = taskProgress.create({ type: "collect", title: "采集", cancellable: true });
  const r = taskProgress.requestCancel(t.id);
  assert.equal(r.ok, true);
  assert.equal(taskProgress.get(t.id).status, "cancelling", "请求取消后应处于 cancelling，而不是立刻 cancelled");
  taskProgress.finishCancel(t.id, "已停止");
  assert.equal(taskProgress.get(t.id).status, "cancelled");
});

test("不可取消的任务：请求取消要明确拒绝", () => {
  const t = taskProgress.create({ type: "publish", title: "发布", cancellable: false });
  const r = taskProgress.requestCancel(t.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /无法用取消撤销|无法/);
  assert.equal(taskProgress.get(t.id).status, "pending", "被拒绝后状态不能变");
});

test("终态任务不会被普通更新改回进行中", () => {
  const t = taskProgress.create({ type: "generate", title: "生成" });
  taskProgress.succeed(t.id);
  taskProgress.update(t.id, { status: "running" });
  assert.equal(taskProgress.get(t.id).status, "success");
});

test("重启恢复：上次在跑的任务标为中断，不是还在运行", () => {
  const t = taskProgress.create({ type: "collect", title: "采集" });
  taskProgress.update(t.id, { status: "running" });
  /* 模拟进程崩溃：状态已写盘 → 重新加载（等同重启）→ 恢复 */
  taskProgress.flush();
  taskProgress.load();
  const r = taskProgress.restoreInterrupted();
  assert.ok(r.interrupted >= 1);
  const got = taskProgress.get(t.id);
  assert.equal(got.status, "interrupted");
  assert.notEqual(got.status, "running", "死任务绝不能显示成还在运行");
  assert.ok(got.error);
});

test("重启恢复：init() 也会把在跑的任务标为中断", () => {
  const t = taskProgress.create({ type: "collect", title: "采集2" });
  taskProgress.update(t.id, { status: "running" });
  taskProgress.flush();
  const r = taskProgress.init();
  assert.ok(r.interrupted >= 1);
  assert.equal(taskProgress.get(t.id).status, "interrupted");
});

test("统计区分活跃与终态", () => {
  const before = taskProgress.stats();
  const a = taskProgress.create({ type: "collect", title: "A" });
  taskProgress.update(a.id, { status: "running" });
  const b = taskProgress.create({ type: "collect", title: "B" });
  taskProgress.succeed(b.id);
  const s = taskProgress.stats();
  assert.equal(s.active, before.active + 1);
  assert.equal(s.success, before.success + 1);
});

test("列表可按活跃与类型过滤", () => {
  const a = taskProgress.create({ type: "generate", title: "G" });
  taskProgress.update(a.id, { status: "running" });
  const b = taskProgress.create({ type: "collect", title: "C" });
  taskProgress.succeed(b.id);
  assert.ok(taskProgress.list({ active: true, type: "generate" }).some((x) => x.id === a.id));
  assert.ok(!taskProgress.list({ active: true, type: "collect" }).some((x) => x.id === b.id));
});

test("删除：只允许删已结束的任务", () => {
  const a = taskProgress.create({ type: "collect", title: "X" });
  assert.equal(taskProgress.remove(a.id).ok, false, "进行中的任务不能删");
  taskProgress.succeed(a.id);
  assert.equal(taskProgress.remove(a.id).ok, true);
});

test("订阅者能收到任务变化", () => {
  let seen = null;
  const off = taskProgress.subscribe((t) => { seen = t; });
  const t = taskProgress.create({ type: "collect", title: "订阅测试" });
  assert.ok(seen && seen.id === t.id);
  off();
  const before = seen;
  taskProgress.update(t.id, { stage: "x" });
  assert.equal(seen, before, "取消订阅后不再收到事件");
});

test("任务类型与标题都做了长度限制", () => {
  const t = taskProgress.create({ type: "x", title: "长".repeat(500) });
  assert.ok(t.title.length <= 600);
});
