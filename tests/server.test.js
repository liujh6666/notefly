/*
 * 回归用例 4：服务端集成
 * 直接起一个真实 Express 实例（临时数据目录 + 替身 RPA 引擎），
 * 验证「保存失败不谎报成功」「一成功一失败必须部分成功」「重试后父任务同步」。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-test-"));
process.env.NOTEFLY_DATA_DIR = TMP;
process.env.NOTEFLY_NO_LISTEN = "1";
process.env.NOTEFLY_DISABLE_SCHEDULER = "1";
/* 本文件不测启动恢复（那是 server-recovery.test.js 的职责），避免恢复逻辑重新执行本文件创建的任务 */
process.env.NOTEFLY_DISABLE_RESTORE = "1";

fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "config.json"),
  JSON.stringify({ baseUrl: "http://127.0.0.1:9", token: "", engine: "rpa", keepalive: { enabled: false, intervalHours: 4 }, kaState: { details: [] } })
);

/* 替身 RPA：只返回预设结果，不碰浏览器 */
const rpa = require("../engines/rpa");
let nextResult = { targets: [] };
let refillResult = { ok: true, status: "ready" };
let submitResult = { ok: true, status: "success" };
rpa.publish = async () => ({ groupId: "rpa-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), targets: nextResult.targets });
rpa.refillTarget = async () => refillResult;
rpa.submitTarget = async () => submitResult;
rpa.hasHandles = () => true;

const server = require("../server");
const store = server.store;

let base = "";
let httpServer = null;

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
  setTimeout(() => process.exit(0), 30).unref();
});

const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const put = (p, body) => fetch(base + p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const get = (p) => fetch(base + p);

/* ---------- 保存链路 ---------- */
test("新建内容 → 200 且有 id；写入落盘", async () => {
  const res = await post("/contents", { type: "ARTICLE", title: "标题A", body: "正文" });
  assert.equal(res.status, 200);
  const c = await res.json();
  assert.ok(c.id);
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, "store.json"), "utf8"));
  assert.equal(onDisk.contents[0].title, "标题A");
  /* 原子写入：不应残留临时文件 */
  const leftovers = fs.readdirSync(TMP).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("更新不存在的内容 → 404 + 中文错误（不能静默“成功”）", async () => {
  const res = await put("/contents/not-exist", { title: "x" });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /内容不存在/);
});

test("更新已有内容 → 200，读回一致，并生成 .bak 备份", async () => {
  const list = await (await get("/contents")).json();
  const id = list.contents[0].id;
  const res = await put(`/contents/${id}`, { title: "标题A-改", body: "正文-改" });
  assert.equal(res.status, 200);
  const after = await (await get("/contents")).json();
  assert.equal(after.contents.find((c) => c.id === id).title, "标题A-改");
  assert.ok(fs.existsSync(path.join(TMP, "store.json.bak")), "应保留上一版备份");
});

/* 故障注入：原子写需要 rename 临时文件，把临时文件路径占成目录即可让写入真实失败 */
test("磁盘写入失败 → 500 且回滚内存，绝不当成功", async () => {
  const list = await (await get("/contents")).json();
  const id = list.contents[0].id;
  const before = list.contents[0].title;
  const blocker = path.join(TMP, `store.json.tmp-${process.pid}`);
  fs.mkdirSync(blocker);
  try {
    const res = await put(`/contents/${id}`, { title: "不该保存成功的标题" });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /磁盘写入异常/);

    /* 内存也要回滚：否则界面刷新后显示“已改”，磁盘上却还是旧值 */
    const after = await (await get("/contents")).json();
    assert.equal(after.contents.find((c) => c.id === id).title, before);
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
  }
});

/* ---------- 任务状态归并（发布已改为：接口快速返回 queued 任务，后台队列执行） ---------- */
const publish = (accountIds, mode = "publish") =>
  post("/publish", { snapshot: { type: "ARTICLE", title: "t", body: "b" }, accountIds, mode });

const PENDING = ["queued", "creating", "running", "publishing"];
async function waitTerminal(id, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const t = store.tasks.find((x) => x.id === id);
    if (t && !PENDING.includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("后台任务执行超时（" + id + "）");
}
async function publishAndWait(accountIds, mode = "publish", timeout = 5000) {
  const res = await publish(accountIds, mode);
  assert.equal(res.status, 202, "发布接口必须快速返回 202（已持久化任务），不能同步等执行完");
  const body = await res.json();
  assert.ok(body.task && body.task.id, "响应必须带回已持久化的任务（含 id）");
  const task = await waitTerminal(body.task.id, timeout);
  return { body, task };
}

test("发布接口快速返回 queued 任务（不等待多平台执行完）", async () => {
  let release;
  const real = rpa.publish;
  rpa.publish = () => new Promise((resolve) => { release = resolve; });  // 卡住引擎模拟慢平台
  try {
    const started = Date.now();
    const res = await publish(["juejin"], "draft");
    const elapsed = Date.now() - started;
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.task.status, "queued");
    assert.ok(elapsed < 1500, "必须在 1.5 秒内返回，实际 " + elapsed + "ms —— 否则前端 20s 超时后用户会重复点击");
    release({ groupId: "rpa-slow-" + Date.now(), targets: [{ platform: "juejin", accountId: "juejin", status: "ready" }] });
    const t = await waitTerminal(body.task.id);
    assert.equal(t.status, "draft_ready");
  } finally {
    rpa.publish = real;
  }
});

test("一成功一失败（立即发布）→ 部分成功，不能是 done", async () => {
  nextResult = {
    targets: [
      { platform: "juejin", accountId: "juejin", status: "success" },
      { platform: "zhihu", accountId: "zhihu", status: "failed", error: "发布按钮未找到" },
    ],
  };
  const { task } = await publishAndWait(["juejin", "zhihu"], "publish");
  assert.equal(task.status, "partial");
  assert.match(task.error, /zhihu/);
});

test("全部成功 → done", async () => {
  nextResult = { targets: [{ platform: "juejin", accountId: "juejin", status: "success" }] };
  const { task } = await publishAndWait(["juejin"], "publish");
  assert.equal(task.status, "done");
  assert.equal(task.error, null);
});

test("空目标（引擎什么都没做）→ 结果待核验，不能算完成", async () => {
  nextResult = { targets: [] };
  const { task } = await publishAndWait(["juejin"], "publish");
  assert.equal(task.status, "unknown");
});

test("草稿模式全部 ready → 草稿待确认", async () => {
  nextResult = { targets: [{ platform: "juejin", accountId: "juejin", status: "ready" }] };
  const { task } = await publishAndWait(["juejin"], "draft");
  assert.equal(task.status, "draft_ready");
});

test("定时时间早于当前 → 400 明确报错，且不产生任务", async () => {
  const before = store.tasks.length;
  const res = await post("/publish", {
    snapshot: { type: "ARTICLE", title: "t", body: "b" },
    accountIds: ["juejin"],
    scheduledAt: new Date(Date.now() - 60000).toISOString(),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /晚于当前时间/);
  assert.equal(store.tasks.length, before, "校验失败绝不能留下半成品任务");
});

test("创建任务时冻结引擎与模式，响应带 queued 状态", async () => {
  const res = await publish(["juejin"], "draft");
  const body = await res.json();
  assert.equal(body.task.engine, "rpa");
  assert.equal(body.task.mode, "draft");
  assert.ok(body.task.frozenAt);
  assert.equal(body.taskStatus, "queued");
  await waitTerminal(body.task.id);
});

/* 单引擎：MultiPost 已下线，配置里再写 engine:"multipost" 也不能把引擎切走 */
test("引擎只有 NoteFly RPA：写入 engine:multipost 不生效", async () => {
  await post("/config", { engine: "multipost" });
  const res = await fetch(base + "/config");
  const body = await res.json();
  assert.equal(body.engine, "rpa");
  assert.ok(!("baseUrl" in body), "配置响应里不应再出现 MultiPost 的 baseUrl");
  assert.ok(!("token" in body) && !("tokenMasked" in body), "配置响应里不应再出现 MultiPost 的 token");
  const r = await publish(["juejin"], "draft");
  const b = await r.json();
  assert.equal(b.task.engine, "rpa");
  await waitTerminal(b.task.id);
});

/* ---------- 重试后父任务同步（原缺陷：目标 ready，任务仍 failed） ---------- */
test("全部失败 → failed；单平台重填成功后父任务立即重算", async () => {
  nextResult = {
    targets: [
      { platform: "juejin", accountId: "juejin", status: "failed", error: "没找到标题框" },
      { platform: "zhihu", accountId: "zhihu", status: "failed", error: "没找到标题框" },
    ],
  };
  const { task: created } = await publishAndWait(["juejin", "zhihu"], "publish");
  assert.equal(created.status, "failed");
  const gid = created.groupId;

  refillResult = { ok: true, status: "ready" };
  const res = await post(`/tasks/${gid}/targets/juejin/retry`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.taskStatus, "needs_manual", "一个待人工 + 一个失败 → 等待人工，而不是停在 failed");
  assert.equal(body.task.status, "needs_manual");
  const tg = body.task.lastStatus.targets.find((t) => t.accountId === "juejin");
  assert.equal(tg.status, "ready");
  assert.equal(tg.error, "");
  /* 本地列表里也必须是新状态，避免不同页面显示不一致 */
  assert.equal(store.tasks.find((t) => t.groupId === gid).status, "needs_manual");
});

test("单目标提交回传完整任务，父任务从 draft_ready 重算为 partial", async () => {
  nextResult = {
    targets: [
      { platform: "juejin", accountId: "juejin", status: "ready" },
      { platform: "zhihu", accountId: "zhihu", status: "ready" },
    ],
  };
  const { task } = await publishAndWait(["juejin", "zhihu"], "draft");
  assert.equal(task.status, "draft_ready");
  submitResult = { ok: true, status: "success" };
  const res = await post(`/tasks/${task.groupId}/targets/juejin/submit`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.task && body.task.id, "单目标提交必须回传完整任务，否则弹窗头部总状态会停在旧值");
  assert.equal(body.task.status, "partial", "1 已发布 + 1 待确认 → 部分成功");
  assert.equal(body.task.lastStatus.targets.find((t) => t.accountId === "juejin").status, "success");
  assert.equal(store.tasks.find((t) => t.id === task.id).status, "partial");
});

test("unknown 目标拒绝重试（与服务端/前端规则一致），必须先核验", async () => {
  nextResult = { targets: [{ platform: "juejin", accountId: "juejin", status: "unknown", error: "提交后连接中断" }] };
  const { task } = await publishAndWait(["juejin"], "publish");
  assert.equal(task.status, "unknown");
  const res = await post(`/tasks/${task.groupId}/targets/juejin/retry`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /核验/);
});

test("核验链路：check 给出明确提示；人工确认后标记 verifiedBy=manual 且父任务重算", async () => {
  nextResult = { targets: [{ platform: "juejin", accountId: "juejin", status: "unknown", error: "提交后连接中断" }] };
  const { task } = await publishAndWait(["juejin"], "publish");
  const url = `/tasks/${task.groupId}/targets/juejin/verify`;

  let res = await post(url, { action: "check" });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.handleAlive, true);
  assert.ok(body.hint && body.hint.length > 4, "必须告诉用户下一步怎么处理");

  res = await post(url, { action: "confirm_success" });
  body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.target.status, "success");
  assert.equal(body.target.verifiedBy, "manual", "人工确认必须明确标注来源，不能伪造成平台自动核验");
  assert.equal(body.taskStatus, "done");

  res = await post(url, { action: "confirm_success" });
  assert.equal(res.status, 409, "已成功后不能再次登记");
});

test("人工登记失败后可以正常重试", async () => {
  nextResult = { targets: [{ platform: "zhihu", accountId: "zhihu", status: "unknown" }] };
  const { task } = await publishAndWait(["zhihu"], "publish");
  let res = await post(`/tasks/${task.groupId}/targets/zhihu/verify`, { action: "confirm_failed" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).target.status, "failed");
  refillResult = { ok: true, status: "ready" };
  res = await post(`/tasks/${task.groupId}/targets/zhihu/retry`);
  assert.equal(res.status, 200);
  const rb = await res.json();
  assert.equal(rb.task.lastStatus.targets.find((t) => t.accountId === "zhihu").status, "ready");
});

test("已成功的目标拒绝重复提交（防重复发文）", async () => {
  nextResult = { targets: [{ platform: "juejin", accountId: "juejin", status: "success" }] };
  const { task } = await publishAndWait(["juejin"], "publish");
  const res = await post(`/tasks/${task.groupId}/targets/juejin/submit`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /已确认发布|重复/);
});

test("结果未知的目标拒绝重复提交", async () => {
  const task = store.tasks[0];
  task.lastStatus = { targets: [{ platform: "zhihu", accountId: "zhihu", status: "unknown", error: "提交后连接中断" }] };
  task.status = "unknown";
  const res = await post(`/tasks/${task.groupId}/targets/zhihu/submit`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /核验/);
});

test("没有待发目标时 /submit 返回 409 而不是假装成功", async () => {
  const task = store.tasks.find((t) => t.lastStatus && (t.lastStatus.targets || []).some((x) => x.status === "success"));
  const res = await post(`/tasks/${task.groupId}/submit`);
  assert.equal(res.status, 409);
});
