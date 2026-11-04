/*
 * 回归用例 6：第三批 —— 服务端队列恢复 / 核验状态机 / 词库检测状态
 *
 * 覆盖复审任务书点名的三个服务端缺口：
 *   1) queued 任务重启后不恢复入队
 *   2) success 目标人工登记失败被允许（后端规则不完整）
 *   3) 词库缺失被包装成“未检出”
 *
 * 独立进程 + 独立数据目录：队列恢复必须在「启动时」发生，
 * 所以 store.json 必须在 require server 之前写好。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-recover-"));
process.env.NOTEFLY_DATA_DIR = TMP;
process.env.NOTEFLY_NO_LISTEN = "1";
/* 注意：这里必须让启动恢复逻辑生效，所以不设 NOTEFLY_DISABLE_RESTORE；
   但要停掉定时调度器与保活（否则进程不会退出） */
delete process.env.NOTEFLY_DISABLE_SCHEDULER;
delete process.env.NOTEFLY_DISABLE_RESTORE;
process.env.NOTEFLY_DISABLE_SCHEDULER = "1";

fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "config.json"),
  JSON.stringify({ baseUrl: "http://127.0.0.1:9", token: "", engine: "rpa", checkInterval: 30, keepalive: { enabled: false, intervalHours: 4 }, kaState: { details: [] } })
);

/* ---------- 预置数据：两个中断任务 ---------- */
const NOW = new Date().toISOString();
const mkTask = (over) => Object.assign({
  id: over.id,
  groupId: null,
  contentId: null,
  title: over.title,
  type: "ARTICLE",
  accountIds: ["juejin"],
  snapshot: { type: "ARTICLE", title: over.title, body: "b" },
  mode: "draft",
  engine: "rpa",
  scheduledAt: null,
  status: "queued",
  createdAt: NOW,
  startedAt: null,
  lastStatus: null,
  error: null,
  history: [],
}, over);

const store0 = {
  contents: [], accountMeta: {}, metrics: {},
  tasks: [
    /* A：queued 但从未执行（无 startedAt、无目标）→ 应重新入队 */
    mkTask({ id: "task-never-run", title: "未执行过" }),
    /* B：执行到一半中断（有 startedAt，目标处于 submitting）→ 必须转人工核验，不能重发 */
    mkTask({
      id: "task-interrupted", title: "执行中断", startedAt: NOW, status: "running",
      lastStatus: { targets: [{ platform: "juejin", accountId: "juejin", status: "submitting" }] },
    }),
  ],
};
fs.writeFileSync(path.join(TMP, "store.json"), JSON.stringify(store0, null, 2));

/* 替身 RPA：记录执行次数 */
const rpa = require("../engines/rpa");
let publishCalls = [];
rpa.publish = async (snap, ids) => {
  publishCalls.push(ids);
  return { groupId: "rpa-recovered-" + publishCalls.length, targets: [{ platform: "juejin", accountId: "juejin", status: "ready" }] };
};
rpa.hasHandles = () => false;

const server = require("../server");
const store = server.store;

const post = (p, body) => fetch(`http://127.0.0.1:${server.__testPort || 0}/api${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

let httpServer = null;
let base = "";
test.before(async () => {
  httpServer = server.app.listen(0);
  await new Promise((r) => httpServer.once("listening", r));
  base = `http://127.0.0.1:${httpServer.address().port}/api`;
});
test.after(() => {
  try {
    if (httpServer) {
      /* 关掉 keep-alive 连接，否则 node --test 的子进程会一直挂着不退出 */
      if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
      httpServer.close();
    }
  } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
  /* 断言已全部完成，显式退出，避免测试运行器的 IPC 连接把进程吊住 */
  setTimeout(() => process.exit(0), 30).unref();
});

const waitFor = async (fn, timeout = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

/* ---------- 1. 队列恢复 ---------- */
test("重启后 queued 且从未执行的任务会重新入队并执行", async () => {
  const ok = await waitFor(() => publishCalls.length >= 1);
  assert.equal(ok, true, "中断任务应被重新入队执行");
  const taskA = store.tasks.find((t) => t.id === "task-never-run");
  assert.equal(taskA.status, "draft_ready", "重新执行后应按草稿模式归并为草稿待确认");
  assert.ok(
    (taskA.history || []).some((h) => h.event === "requeued_after_restart"),
    "应记录重新入队的历史事件"
  );
});

test("执行到一半中断的任务：转人工核验，绝不自动重发", async () => {
  await waitFor(() => store.tasks.find((t) => t.id === "task-interrupted").status !== "running");
  const taskB = store.tasks.find((t) => t.id === "task-interrupted");
  /* 只有「未执行过」那个任务被重发，中断的那个不能被重发 */
  assert.equal(publishCalls.length, 1, "中断的任务不能被自动重发");
  const tg = taskB.lastStatus.targets.find((t) => t.accountId === "juejin");
  assert.equal(tg.status, "unknown", "提交中的目标必须转为结果未知，等人工核验");
  assert.equal(taskB.status, "unknown", "父任务应为结果待核验");
  assert.match(tg.error, /核验/);
});

/* ---------- 2. 核验端点状态机 ---------- */
test("已成功发布的目标不允许登记为失败（不能解锁重复发文）", async () => {
  const gid = "rpa-verify-test";
  store.tasks.push({
    id: "verify-task", groupId: gid, title: "核验用例", type: "ARTICLE",
    accountIds: ["juejin"], snapshot: { type: "ARTICLE", title: "t", body: "b" },
    mode: "publish", engine: "rpa", status: "partial", createdAt: NOW, startedAt: NOW,
    lastStatus: {
      targets: [
        { platform: "juejin", accountId: "juejin", status: "success" },
        { platform: "weibo", accountId: "weibo", status: "unknown", error: "超时" },
      ],
    },
    history: [],
  });
  /* 任务已在内存 store 中，接口读的就是它，无需再落盘 */

  const res = await fetch(`${base}/tasks/${gid}/targets/juejin/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm_failed" }),
  });
  assert.equal(res.status, 409, "已发布目标登记失败必须被拒绝");
  const body = await res.json();
  assert.match(body.error, /不能直接登记失败|更正流程/);
  /* 状态不能被改回去 */
  const tg = store.tasks.find((t) => t.groupId === gid).lastStatus.targets.find((t) => t.accountId === "juejin");
  assert.equal(tg.status, "success", "已成功目标的状态不能被改写");
});

test("已成功目标重复确认成功 → 409（幂等）", async () => {
  const gid = "rpa-verify-test";
  const res = await fetch(`${base}/tasks/${gid}/targets/juejin/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm_success" }),
  });
  assert.equal(res.status, 409);
});

test("unknown 目标允许登记失败（正常人工核验路径）", async () => {
  const gid = "rpa-verify-test";
  const res = await fetch(`${base}/tasks/${gid}/targets/weibo/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm_failed", note: "平台后台确认没有发布" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.target.status, "failed");
  assert.equal(body.target.verifiedBy, "manual", "人工登记必须标注来源");
  /* 登记后应变成可重试的失败 */
  const retry = await fetch(`${base}/tasks/${gid}/targets/weibo/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.ok(retry.status < 500, "登记失败后应允许重试");
});

/* ---------- 3. 词库检测状态 ---------- */
test("词库可用时返回 checked，命中词能检出", async () => {
  const res = await fetch(`${base}/checkwords`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "这是最好的产品，全网最低价" }),
  });
  const body = await res.json();
  assert.equal(body.status, "checked");
  assert.ok(body.hits.length > 0, "默认词库应能检出风险词");
});

test("词库文件缺失 → 自动初始化默认词库，仍然是 checked", async () => {
  const wf = path.join(TMP, "forbidden-words.txt");
  const existed = fs.existsSync(wf);
  const backup = existed ? fs.readFileSync(wf, "utf8") : null;
  fs.rmSync(wf, { force: true });
  const res = await fetch(`${base}/checkwords`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "普通内容" }),
  });
  const body = await res.json();
  assert.equal(body.status, "checked", "词库缺失应自动初始化，而不是变成“未检测”");
  assert.ok(fs.existsSync(wf), "默认词库应被写回磁盘");
  if (backup !== null) fs.writeFileSync(wf, backup, "utf8");
});

test("词库不可用（路径被占成目录）→ 明确返回 unavailable，绝不能说“未检出”", async () => {
  const wf = path.join(TMP, "forbidden-words.txt");
  const backup = fs.existsSync(wf) ? fs.readFileSync(wf, "utf8") : null;
  fs.rmSync(wf, { force: true });
  fs.mkdirSync(wf);   // 目录占位：读写都失败
  const res = await fetch(`${base}/checkwords`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "普通内容" }),
  });
  const body = await res.json();
  assert.equal(body.status, "unavailable", "词库不可用必须如实返回 unavailable");
  assert.ok(!body.hits.length, "没有检测时不应返回命中项");
  assert.match(body.note, /未检测/);
  fs.rmSync(wf, { recursive: true, force: true });
  if (backup !== null) fs.writeFileSync(wf, backup, "utf8");
});
