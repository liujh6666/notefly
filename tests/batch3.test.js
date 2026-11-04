/*
 * 回归用例 5：第三批修复 —— 状态模型拆分 + 引擎能力闸门 + 可见登录窗口
 *
 * 覆盖复审任务书第四节的 10 项定向检查中可在本层验证的部分：
 *   1) accepted 归并（原来是 unknown）
 *   2) reviewing 归并（原来是 unknown）
 *   3) unverified 微博 publish 仍调用提交且记 success  ← 本文件核心
 *   4) 浏览器先检查（无头）再登录 → 没有可见窗口    ← 本文件核心
 *
 * 引擎层用 Playwright 替身：不启动真实浏览器，验证的是决策分支，
 * 不等于真实平台验收（真实平台需实机确认）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

/* ---------- 替身：Playwright ---------- */
const launchLog = [];
let closedCount = 0;
const fakePage = {
  _url: "",
  async goto(url) { this._url = url; },
  url() { return this._url; },
  async evaluate() { return { netError: "stub-无真实网络" }; },
  async waitForSelector() { return {}; },
  async $(sel) {
    return { click: async () => {}, fill: async () => {}, setInputFiles: async () => {} };
  },
  locator() {
    return {
      first: () => ({ click: async () => {} }),
      count: async () => 0,
      click: async () => {},
    };
  },
  keyboard: { insertText: async () => {}, press: async () => {} },
  getByRole() { return { first: () => ({ click: async () => {} }) }; },
  async close() { closedCount++; },
};
const fakeCtx = {
  async newPage() { return fakePage; },
  async addCookies() {},
  async addInitScript() {},
  async close() { closedCount++; },
};

const playwrightPath = require.resolve("playwright");
require.cache[playwrightPath] = {
  id: playwrightPath,
  filename: playwrightPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    chromium: {
      launchPersistentContext: async (dir, opts) => {
        launchLog.push({ headed: !!(opts && opts.headless === false) });
        return fakeCtx;
      },
    },
  },
};

const rpa = require("../engines/rpa");
const taskStatus = require("../lib/task-status");

const mkTargets = (arr) => arr.map(([p, s]) => ({ platform: p, accountId: p, status: s }));

/* ---------- 状态模型：受理/审核中 ≠ 结果未知 ---------- */
test("accepted 归并为 in_review（不再是 unknown）", () => {
  const sum = taskStatus.summarize(mkTargets([["weibo", "accepted"]]), "publish");
  assert.equal(sum.status, "in_review");
  assert.equal(sum.status, taskStatus.TASK.IN_REVIEW);
  assert.equal(sum.counts.unknown, 0);
  assert.equal(sum.counts.inFlight, 1);
});

test("reviewing 归并为 in_review（不再是 unknown）", () => {
  const sum = taskStatus.summarize(mkTargets([["weibo", "reviewing"]]), "publish");
  assert.equal(sum.status, "in_review");
  assert.equal(sum.counts.unknown, 0);
});

test("submitting 归并为 in_review（提交中属于流程推进，不是结果未知）", () => {
  const sum = taskStatus.summarize(mkTargets([["weibo", "submitting"]]), "publish");
  assert.equal(sum.status, "in_review");
});

test("真正的 unknown 仍然归并为 unknown（必须核验）", () => {
  const sum = taskStatus.summarize(mkTargets([["weibo", "unknown"]]), "publish");
  assert.equal(sum.status, "unknown");
  assert.equal(sum.counts.unknown, 1);
});

test("已发布 + 审核中 → in_review（不能提前判完成）", () => {
  const sum = taskStatus.summarize(mkTargets([["juejin", "success"], ["weibo", "reviewing"]]), "publish");
  assert.equal(sum.status, "in_review");
  assert.equal(sum.counts.success, 1);
});

test("全部成功仍然是 done（拆分不能把完成态弄坏）", () => {
  const sum = taskStatus.summarize(mkTargets([["juejin", "success"]]), "publish");
  assert.equal(sum.status, "done");
});

test("草稿模式全 ready 仍然是 draft_ready", () => {
  const sum = taskStatus.summarize(mkTargets([["juejin", "ready"]]), "draft");
  assert.equal(sum.status, "draft_ready");
});

/* ---------- 能力闸门：未验证平台不得自动提交 ---------- */
test.afterEach(async () => {
  /* 每个用例跑完清掉活动页面句柄，避免用例之间互相污染（句柄是模块级全局） */
  await rpa.closeAll();
});

test("能力表按平台给出草稿/自动提交/核验三项能力", () => {
  const list = rpa.listPlatforms();
  const juejin = list.find((p) => p.id === "juejin");
  assert.ok(juejin, "缺少掘金平台");
  assert.ok(juejin.capabilities, "必须暴露 capabilities");
  assert.equal(typeof juejin.capabilities.draft, "string");
  assert.equal(typeof juejin.capabilities.autoSubmit, "string");
  assert.equal(typeof juejin.capabilities.verify, "string");
  /* 草稿能力验证过 ≠ 自动提交能力验证过 */
  assert.notEqual(juejin.capabilities.draft, juejin.capabilities.autoSubmit);
});

test("unverified 微博走 publish 模式：不得调用 submit，必须停在草稿", async () => {
  const adapter = rpa._internals.ADAPTERS.weibo;
  const origSubmit = adapter.submit;
  const origFill = adapter.fill;
  let submitCalls = 0;
  adapter.submit = async () => { submitCalls++; };
  adapter.fill = async () => {};
  try {
    const res = await rpa.publish({ type: "DYNAMIC", title: "t", body: "b" }, ["weibo"], "publish");
    assert.equal(submitCalls, 0, "未验证自动提交能力的平台绝不能调用 submit");
    assert.equal(res.targets.length, 1);
    assert.equal(res.targets[0].status, "ready");
    assert.equal(res.targets[0].capabilityLimited, true);
    assert.match(res.targets[0].error, /未验证/);
  } finally {
    adapter.submit = origSubmit;
    adapter.fill = origFill;
  }
});

test("能力验证通过的平台：submit 被调用，但结果只能记 accepted（不能直接 success）", async () => {
  const adapter = rpa._internals.ADAPTERS.weibo;
  const origSubmit = adapter.submit;
  const origFill = adapter.fill;
  const origCaps = adapter.capabilities;
  let submitCalls = 0;
  adapter.submit = async () => { submitCalls++; };
  adapter.fill = async () => {};
  adapter.capabilities = { draft: "verified", autoSubmit: "verified", verify: "unverified" };
  try {
    const res = await rpa.publish({ type: "DYNAMIC", title: "t", body: "b" }, ["weibo"], "publish");
    assert.equal(submitCalls, 1);
    assert.equal(res.targets[0].status, "accepted", "点击发布只能证明已提交，不能证明已发布");
    assert.notEqual(res.targets[0].status, "success");
    assert.ok(res.targets[0].evidence, "必须留下提交证据");
  } finally {
    adapter.submit = origSubmit;
    adapter.fill = origFill;
    adapter.capabilities = origCaps;
  }
});

test("提交超时必须记 unknown（不能落成 failed，否则会解锁重复发文）", async () => {
  const adapter = rpa._internals.ADAPTERS.weibo;
  const origSubmit = adapter.submit;
  const origFill = adapter.fill;
  const origCaps = adapter.capabilities;
  adapter.submit = async () => { throw new Error("Timeout 30000ms exceeded"); };
  adapter.fill = async () => {};
  adapter.capabilities = { draft: "verified", autoSubmit: "verified", verify: "unverified" };
  try {
    const res = await rpa.publish({ type: "DYNAMIC", title: "t", body: "b" }, ["weibo"], "publish");
    assert.equal(res.targets[0].status, "unknown");
    assert.match(res.targets[0].error, /核验/);
  } finally {
    adapter.submit = origSubmit;
    adapter.fill = origFill;
    adapter.capabilities = origCaps;
  }
});

test("草稿模式不受能力闸门影响（仍应填入并停在 ready）", async () => {
  const adapter = rpa._internals.ADAPTERS.weibo;
  const origSubmit = adapter.submit;
  const origFill = adapter.fill;
  let submitCalls = 0, fillCalls = 0;
  adapter.submit = async () => { submitCalls++; };
  adapter.fill = async () => { fillCalls++; };
  try {
    const res = await rpa.publish({ type: "DYNAMIC", title: "t", body: "b" }, ["weibo"], "draft");
    assert.equal(fillCalls, 1);
    assert.equal(submitCalls, 0);
    assert.equal(res.targets[0].status, "ready");
    assert.notEqual(res.targets[0].capabilityLimited, true);
  } finally {
    adapter.submit = origSubmit;
    adapter.fill = origFill;
  }
});

/* ---------- 可见登录窗口：先无头检查，后登录 ---------- */
test("先无头检查登录、再打开登录窗口：必须升级为可见浏览器", async () => {
  await rpa.resetContext();   // 隔离前序用例的上下文状态
  launchLog.length = 0;
  const ctx = rpa._internals.getContext();
  await ctx;
  assert.equal(launchLog.length, 1, "第一次应是无头启动");
  assert.equal(launchLog[0].headed, false);

  /* 第二次请求可见窗口 —— 修复前这里会复用无头上下文，永远不弹可见窗口 */
  const ctx2 = await rpa._internals.getContext({ headed: true });
  assert.ok(ctx2);
  assert.equal(launchLog.length, 2, "应重启一次浏览器以获得可见窗口");
  assert.equal(launchLog[1].headed, true, "第二次启动必须是可见（有头）模式");
});

test("可见浏览器已存在时再次请求：不重复重启（不打断用户窗口）", async () => {
  await rpa.resetContext();
  launchLog.length = 0;
  await rpa._internals.getContext({ headed: true });
  const n1 = launchLog.length;
  await rpa._internals.getContext({ headed: true });
  assert.equal(launchLog.length, n1, "已是可见模式就不该再重启");
});

test("发布任务执行中不允许切换到可见登录窗口（会中断任务）", async () => {
  await rpa.resetContext();   // 回到无头上下文，才能触发“无头 → 可见”的升级判定
  const adapter = rpa._internals.ADAPTERS.weibo;
  const origFill = adapter.fill;
  const origSubmit = adapter.submit;
  adapter.fill = async () => {};
  adapter.submit = async () => {};
  try {
    /* 草稿模式会留下活动页面句柄 */
    await rpa.publish({ type: "DYNAMIC", title: "t", body: "b" }, ["weibo"], "draft");
    assert.equal(rpa._internals.hasOpenWorkers(), true, "应存在活动页面句柄");
    await assert.rejects(
      () => rpa._internals.getContext({ headed: true }),
      /发布任务|无法切换/,
      "有任务在跑时必须拒绝切换上下文"
    );
  } finally {
    adapter.fill = origFill;
    adapter.submit = origSubmit;
    await rpa.closeAll();
  }
});
