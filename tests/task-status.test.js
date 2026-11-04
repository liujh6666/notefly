/*
 * 回归用例 1：任务状态归并
 * 对应缺陷：一成功一失败却显示“已完成”、空目标判成功、重试后父任务停在 failed。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize, syncTask, TASK } = require("../lib/task-status");

const T = (status, platform = "p") => ({ platform, accountId: platform, status });

test("一成功一失败 → 部分成功（不是 done）", () => {
  const s = summarize([T("success", "juejin"), T("failed", "zhihu")], "publish");
  assert.equal(s.status, TASK.PARTIAL);
  assert.equal(s.counts.success, 1);
  assert.equal(s.counts.failed, 1);
});

test("全部成功 → done", () => {
  const s = summarize([T("success", "a"), T("success", "b")], "publish");
  assert.equal(s.status, TASK.DONE);
});

test("全部失败 → failed", () => {
  const s = summarize([T("failed", "a"), T("failed", "b")], "publish");
  assert.equal(s.status, TASK.FAILED);
});

test("空目标数组 → 不能算成功", () => {
  const s = summarize([], "publish");
  assert.notEqual(s.status, TASK.DONE);
  assert.equal(s.status, TASK.UNKNOWN);
  assert.equal(s.counts.total, 0);
  assert.equal(summarize(null).status, TASK.UNKNOWN);
});

test("草稿模式全部 ready → draft_ready；发布模式全部 ready → needs_manual", () => {
  assert.equal(summarize([T("ready", "a")], "draft").status, TASK.DRAFT_READY);
  assert.equal(summarize([T("ready", "a")], "publish").status, TASK.NEEDS_MANUAL);
});

test("一成功一待确认 → 部分成功", () => {
  assert.equal(summarize([T("success", "a"), T("ready", "b")], "publish").status, TASK.PARTIAL);
});

test("存在结果未知 → 结果待核验（不能判完成）", () => {
  assert.equal(summarize([T("success", "a"), T("unknown", "b")], "publish").status, TASK.UNKNOWN);
});

test("提交中/已受理/审核中 → 审核中（第三批：与结果未知分开）", () => {
  /* 这三种是“平台已接收、流程推进中”，不是“结果不确定”。
     混进 unknown 会造成平台行显示“审核中”但任务行显示“结果待核验”的矛盾 */
  assert.equal(summarize([T("submitting", "a")], "publish").status, TASK.IN_REVIEW);
  assert.equal(summarize([T("accepted", "a")], "publish").status, TASK.IN_REVIEW);
  assert.equal(summarize([T("reviewing", "a")], "publish").status, TASK.IN_REVIEW);
  /* 真正的 unknown 仍然必须判待核验 */
  assert.equal(summarize([T("unknown", "a")], "publish").status, TASK.UNKNOWN);
});

test("仍有排队/填入中 → running", () => {
  assert.equal(summarize([T("pending", "a")], "draft").status, TASK.RUNNING);
  assert.equal(summarize([T("filling", "a")], "draft").status, TASK.RUNNING);
});

test("syncTask 会清理旧错误并重算完成时间", () => {
  const task = {
    status: "done",
    finishedAt: new Date().toISOString(),
    error: "旧的错误",
    mode: "publish",
    lastStatus: { targets: [T("success", "a")] },
  };
  /* 先确认全部成功 → done，错误被清空 */
  task.lastStatus.targets = [T("success", "a")];
  syncTask(task);
  assert.equal(task.status, TASK.DONE);
  assert.equal(task.error, null);

  /* 重试后又有失败：done 必须回退，finishedAt 必须清空 */
  task.lastStatus.targets = [T("success", "a"), T("failed", "b")];
  syncTask(task);
  assert.equal(task.status, TASK.PARTIAL);
  assert.equal(task.finishedAt, null);
  assert.match(task.error, /b/);
});

test("状态变化会写入 history，便于追溯", () => {
  const task = { status: "failed", mode: "publish", lastStatus: { targets: [T("success", "a")] }, history: [] };
  syncTask(task);
  assert.equal(task.status, TASK.DONE);
  assert.equal(task.history.length, 1);
  assert.match(task.history[0].detail, /failed → done/);
});
