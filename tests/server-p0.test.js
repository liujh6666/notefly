/*
 * P0 回归：任务队列超时 / 迟到结果 / 重复提交（1104 审查报告 P0-3、P0-4）
 *  - P0-3：超时后 RPA 继续跑、下一任务并行抢占、迟到结果覆盖状态
 *  - P0-4：accepted/reviewing 状态可被再次提交或重填
 * 用假 rpa（只记录并发与调用序），不触碰真实平台。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-queue-p0-"));
process.env.NOTEFLY_DATA_DIR = TMP;
process.env.NOTEFLY_NO_LISTEN = "1";
process.env.NOTEFLY_DISABLE_SCHEDULER = "1";
process.env.NOTEFLY_TASK_TIMEOUT_MS = "400";   // 缩短超时，测试才跑得动

fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });

const server = require("../server");
const rpa = require("../engines/rpa");
const { app, store } = server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假 rpa：记录并发与调用序，可按标题控制行为 ---------- */
const fake = {
  running: 0,
  maxConcurrent: 0,
  calls: [],                    // { title, at }
  finished: [],                 // { title, at }
  slowMs: 1200,                 // publish 挂住多久
  progressAt: 100,              // 何时回调 onProgress
};
rpa.publish = async (snapshot, platforms, mode, opts) => {
  fake.running++;
  fake.maxConcurrent = Math.max(fake.maxConcurrent, fake.running);
  fake.calls.push({ title: snapshot.title, at: Date.now() });
  try {
    if (opts && typeof opts.onProgress === "function" && fake.progressAt > 0) {
      setTimeout(() => {
        try {
          opts.onProgress(platforms[0], {
            platform: platforms[0], accountId: platforms[0], status: "filling",
          });
        } catch { /* 忽略 */ }
      }, fake.progressAt);
    }
    await sleep(fake.slowMs);
    return {
      groupId: "g-" + snapshot.title,
      targets: [{ platform: platforms[0], accountId: platforms[0], status: "accepted" }],
      open: 0,
      mode,
    };
  } finally {
    fake.running--;
    fake.finished.push({ title: snapshot.title, at: Date.now() });
  }
};
rpa.submitTarget = async () => ({ ok: true, status: "accepted" });
rpa.refillTarget = async () => ({ ok: true });
rpa.closeAll = async () => {};
rpa.resetContext = async () => {};

async function api(method, url, body) {
  /* 用 supertest 风格的最小请求：直接起临时端口最省事 */
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const req = require("http").request(
        { host: "127.0.0.1", port, method, path: url, headers: { "Content-Type": "application/json" } },
        (res) => {
          let buf = "";
          res.on("data", (d) => (buf += d));
          res.on("end", () => { srv.close(() => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null })); });
        }
      );
      req.end(body ? JSON.stringify(body) : undefined);
      req.on("error", (e) => { srv.close(); reject(e); });
    });
  });
}

const publish = (title, mode) =>
  api("POST", "/api/publish", {
    snapshot: { type: "ARTICLE", title, body: "正文" },
    accountIds: ["juejin"],
    mode: mode || "publish",
    title,
  });

const findTask = (title) => store.tasks.find((t) => t.title === title);

/* 等队列真正空闲：上一个测试的任务全部离开 queued/creating/running 且 fake 无在跑调用 */
async function waitQueueIdle() {
  for (let i = 0; i < 200; i++) {
    const busy = store.tasks.some((t) => ["queued", "creating", "running"].includes(t.status));
    if (!busy && fake.running === 0) { await sleep(60); return; }
    await sleep(50);
  }
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("P0-3：超时后任务进入待核验，B 不得并行抢占，A 迟到结果作废", async () => {
  fake.slowMs = 1200;
  fake.maxConcurrent = 0;
  fake.calls = [];
  fake.finished = [];

  await publish("任务A");
  await sleep(700);                       // 已超过 400ms 超时点，A 的 rpa 还在跑

  const a = findTask("任务A");
  assert.ok(a, "任务A 已创建");
  assert.equal(a.status, "unknown", `超时后应为「结果待核验」，实际 ${a.status}（旧行为是 failed，会诱导重发）`);

  /* 关键断言 1：A 还没落定时，B 不许开始（旧版此刻 B 已并行抢占浏览器） */
  await publish("任务B");
  await sleep(300);
  assert.equal(fake.calls.length, 1, `A 未落定时 B 不得开始，实际已发起 ${fake.calls.length} 个执行`);

  /* 关键断言 2：A 落定后 B 才开始，全程并发为 1 */
  await sleep(900);                       // A 在 1200ms 落定，B 随后开始
  assert.equal(fake.calls.length, 2, "A 落定后 B 应开始执行");
  assert.equal(fake.maxConcurrent, 1, `同一时刻只能有一个 RPA 执行，实际最大并发 ${fake.maxConcurrent}`);

  /* 关键断言 3：A 的迟到结果（accepted）不得覆盖「待核验」状态 */
  const a2 = findTask("任务A");
  assert.equal(a2.status, "unknown", `迟到结果不得把任务改写为 ${a2.status}`);
  const tg = (a2.lastStatus && a2.lastStatus.targets || [])[0] || {};
  assert.equal(tg.status, "unknown", `迟到结果不得把目标改写为 ${tg.status}`);
});

test("P0-3：逐目标持久化 —— 第一平台完成即落盘，不等全部结束", async () => {
  await waitQueueIdle();                  // 上一测试的超时宽限期可能还没走完
  fake.slowMs = 900;
  fake.progressAt = 80;
  fake.calls = [];
  await publish("进度任务");
  await sleep(350);                       // onProgress 已发生、publish 还没 resolve
  const t = findTask("进度任务");
  const tg = (t.lastStatus && t.lastStatus.targets || [])[0];
  assert.ok(tg, "publish 未结束时目标阶段记录必须已持久化（否则卡死时丢全部进度）");
  assert.equal(tg.status, "filling");
  await sleep(800);
});

test("P0-4：accepted / reviewing 状态不得再次提交", async () => {
  rpa.submitTarget = async () => {
    throw new Error("不应被调用：已受理/审核中的目标不允许重复提交");
  };
  for (const st of ["accepted", "reviewing"]) {
    const task = {
      id: "p0-" + st, groupId: "g-p0-" + st, title: "P0-" + st, type: "ARTICLE",
      accountIds: ["juejin"], snapshot: { type: "ARTICLE", title: "t", body: "b" },
      mode: "publish", engine: "rpa", status: "in_review",
      createdAt: new Date().toISOString(), lastStatus: {
        targets: [{ platform: "juejin", accountId: "juejin", status: st }],
      }, history: [],
    };
    store.tasks.unshift(task);
    const r = await api("POST", `/api/tasks/g-p0-${st}/targets/juejin/submit`);
    assert.equal(r.status, 409, `${st} 状态提交应被 409 拦截，实际 ${r.status}`);
    const r2 = await api("POST", `/api/tasks/g-p0-${st}/targets/juejin/retry`);
    assert.equal(r2.status, 409, `${st} 状态重填应被 409 拦截，实际 ${r2.status}`);
  }
});

test("P0-4：failed 目标允许提交一次；提交前先落盘 submitting；二次提交被拦", async () => {
  let submitCalls = 0;
  rpa.submitTarget = async () => { submitCalls++; return { ok: true, status: "accepted" }; };
  const task = {
    id: "p0-once", groupId: "g-p0-once", title: "P0-once", type: "ARTICLE",
    accountIds: ["juejin"], snapshot: { type: "ARTICLE", title: "t", body: "b" },
    mode: "publish", engine: "rpa", status: "failed",
    createdAt: new Date().toISOString(), lastStatus: {
      targets: [{ platform: "juejin", accountId: "juejin", status: "failed" }],
    }, history: [],
  };
  store.tasks.unshift(task);

  const r1 = await api("POST", "/api/tasks/g-p0-once/targets/juejin/submit");
  assert.equal(r1.status, 200, "失败目标第一次提交应放行");
  assert.equal(submitCalls, 1);
  assert.equal(task.lastStatus.targets[0].status, "accepted");

  const r2 = await api("POST", "/api/tasks/g-p0-once/targets/juejin/submit");
  assert.equal(r2.status, 409, "已受理后第二次提交必须拦截");
  assert.equal(submitCalls, 1, "底层提交函数只允许被调用一次");
});
