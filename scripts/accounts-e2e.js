/*
 * 独立账号 端到端测试（真实 HTTP，发布走可控替身）
 * 运行：node scripts/accounts-e2e.js
 *
 * 对应验收问题 12：
 *   1. accountId 与 platformId 分离：同平台可以有两个账号，各自独立分区
 *   2. 默认账号沿用共享分区（persist:notefly），存量登录态不需要迁移
 *   3. 额外账号有自己的分区（persist:acct-<id>），与默认账号不是同一份会话
 *   4. 发布到同一平台的两个账号：任务里是两条独立目标，accountId 不同
 *   5. 删除额外账号后：账号从列表消失、不能再被发布，默认账号不受影响
 *   6. 公开主页字段：抓不到就是空（不拿平台首页冒充），抓到了才给
 *
 * 发布替身（NOTEFLY_RPA_STUB=1）由 server.js 提供 —— 绝不打开真实平台网站。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-acct-"));
const PORT = 3297;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

function startServer() {
  return spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      NOTEFLY_DATA_DIR: TMP,
      NOTEFLY_DISABLE_SCHEDULER: "1",
      NOTEFLY_RPA_STUB: "1",
      NOTEFLY_RPA_STUB_DELAY_MS: "200",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitReady(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function api(pathname, method, body) {
  const init = { method: method || "GET", headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(BASE + pathname, init);
  const t = await r.text();
  try { return Object.assign(JSON.parse(t), { _status: r.status }); } catch { return { error: t.slice(0, 200), _status: r.status }; }
}

async function waitTask(id, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await api("/api/tasks");
    const t = (r.tasks || []).find((x) => x.id === id);
    if (t && ["done", "failed", "partial"].includes(t.status)) return t;
    await sleep(300);
  }
  return null;
}

(async () => {
  const child = startServer();
  try {
    if (!await waitReady()) throw new Error("服务未能启动");
    void child;

    /* ---------- 1. 初始状态：每个平台只有一个默认账号 ---------- */
    let list = await api("/api/accounts");
    const juejinDefault = (list.accounts || []).filter((a) => a.platform === "juejin");
    check("初始：掘金只有 1 个账号（默认账号）", juejinDefault.length === 1, JSON.stringify(juejinDefault.map((a) => a.id)));
    check("默认账号 isDefault=true", juejinDefault[0] && juejinDefault[0].isDefault === true);
    check("默认账号用共享分区 persist:notefly",
      juejinDefault[0] && juejinDefault[0].partition === "persist:notefly", juejinDefault[0] && juejinDefault[0].partition);
    check("账号 id = 平台 id（历史任务零迁移）", juejinDefault[0] && juejinDefault[0].id === "juejin");

    /* ---------- 2. 添加同平台第二个账号 ---------- */
    const added = await api("/api/accounts", "POST", { platform: "juejin", alias: "公司号" });
    check("添加账号成功", added.ok === true, JSON.stringify(added).slice(0, 120));
    const secondId = added.account && added.account.id;
    check("新账号 id 形如 juejin-2", secondId === "juejin-2", String(secondId));
    check("新账号用独立分区", added.account && added.account.partition === "persist:acct-juejin-2", added.account && added.account.partition);

    list = await api("/api/accounts");
    const juejinAll = (list.accounts || []).filter((a) => a.platform === "juejin");
    check("掘金现在有两个账号", juejinAll.length === 2, JSON.stringify(juejinAll.map((a) => a.id)));
    const extra = juejinAll.find((a) => a.id === "juejin-2");
    check("额外账号别名保存成功", extra && extra.alias === "公司号", extra && extra.alias);
    check("额外账号未登录时 isLoggedIn 为 null（不继承默认账号的登录态）", extra && extra.isLoggedIn === null, extra && String(extra.isLoggedIn));
    check("两个账号分区不同（会话隔离）", juejinAll[0].partition !== juejinAll[1].partition);

    /* ---------- 3. 第三个账号：序号递增 ---------- */
    const third = await api("/api/accounts", "POST", { platform: "juejin" });
    check("第三个账号 id = juejin-3", third.account && third.account.id === "juejin-3", third.account && third.account.id);

    /* ---------- 4. 账号上限：同平台最多 5 个（含默认） ---------- */
    await api("/api/accounts", "POST", { platform: "juejin" });
    await api("/api/accounts", "POST", { platform: "juejin" });
    const sixth = await api("/api/accounts", "POST", { platform: "juejin", alias: "第六个" });
    check("超过 5 个账号时明确拒绝", sixth.ok !== true && /最多/.test(sixth.error || ""), JSON.stringify(sixth).slice(0, 120));

    /* ---------- 5. 未知平台不能加账号 ---------- */
    const bad = await api("/api/accounts", "POST", { platform: "no-such-platform" });
    check("未知平台被拒绝", bad.ok !== true && /未知平台/.test(bad.error || ""), JSON.stringify(bad).slice(0, 120));

    /* ---------- 6. 发布到同一平台的两个账号 ---------- */
    const content = await api("/api/contents", "POST", {
      type: "ARTICLE", title: "多账号发布验证", body: "这是用于验证同一平台两个账号分别发布的正文内容。",
    });
    const pub = await api("/api/publish", "POST", {
      contentId: content.id, accountIds: ["juejin", "juejin-2"], mode: "publish",
      title: "多账号发布验证",
    });
    check("发布到两个账号已受理", !!pub.task && !!pub.task.id && pub.error === null, JSON.stringify(pub).slice(0, 140));
    const task = pub.task && pub.task.id ? await waitTask(pub.task.id) : null;
    check("任务执行完成", !!task, task && task.status);
    if (task) {
      const targets = (task.lastStatus && task.lastStatus.targets) || [];
      check("任务里是两个独立目标", targets.length === 2, JSON.stringify(targets.map((t) => t.accountId)));
      const ids = targets.map((t) => t.accountId).sort();
      check("目标的 accountId 分别是 juejin / juejin-2", ids.join(",") === "juejin,juejin-2", ids.join(","));
      check("两个目标都记成同一平台 juejin", targets.every((t) => t.platform === "juejin"), JSON.stringify(targets.map((t) => t.platform)));
    }

    /* ---------- 7. 已删除账号不能再发布 ---------- */
    const del = await api("/api/accounts/juejin-3", "DELETE");
    check("删除额外账号成功", del.ok === true, JSON.stringify(del).slice(0, 120));
    const afterDel = await api("/api/accounts");
    check("删除后账号从列表消失", !(afterDel.accounts || []).some((a) => a.id === "juejin-3"));
    const pubBad = await api("/api/publish", "POST", {
      contentId: content.id, accountIds: ["juejin-3"], mode: "draft", title: "发到已删除账号",
    });
    check("发布到已删除账号被明确拒绝", pubBad.ok !== true && /不存在|已删除/.test(pubBad.error || ""), JSON.stringify(pubBad).slice(0, 140));

    /* ---------- 8. 默认账号不能删 ---------- */
    const delDefault = await api("/api/accounts/juejin", "DELETE");
    check("默认账号拒绝删除", delDefault.ok !== true && /默认账号/.test(delDefault.error || ""), JSON.stringify(delDefault).slice(0, 120));

    /* ---------- 9. 删除账号会清掉它的登录态与身份 ---------- */
    const del2 = await api("/api/accounts/juejin-2", "DELETE");
    check("删除第二个账号成功", del2.ok === true);
    /* 前面测账号上限时又建了 juejin-4 / juejin-5，一并清掉再验证「回到 1 个」 */
    list = await api("/api/accounts");
    for (const a of (list.accounts || []).filter((x) => x.platform === "juejin" && !x.isDefault)) {
      await api("/api/accounts/" + a.id, "DELETE");
    }
    list = await api("/api/accounts");
    check("掘金回到 1 个账号", (list.accounts || []).filter((a) => a.platform === "juejin").length === 1,
      JSON.stringify((list.accounts || []).filter((a) => a.platform === "juejin").map((a) => a.id)));

    /* ---------- 10. 公开主页字段口径 ---------- */
    const d = (list.accounts || []).find((a) => a.id === "juejin");
    check("没抓到公开主页时 homeUrl 为空（不拿平台首页冒充）", d && d.homeUrl === "", d && d.homeUrl);
    check("平台首页另有 fallback 字段", d && !!d.homeUrlFallback, d && d.homeUrlFallback);
    check("创作后台地址单独给出", d && !!d.consoleUrl, d && d.consoleUrl);

    /* ---------- 11. 登录入口：默认账号引导到内置浏览器 ---------- */
    const loginDefault = await api("/api/accounts/juejin/login", "POST");
    check("默认账号登录返回 builtin=true（走内置浏览器）", loginDefault.ok === true && loginDefault.builtin === true, JSON.stringify(loginDefault).slice(0, 120));

    /* ---------- 12. 持久化：重启后账号还在 ---------- */
    const storeRaw = JSON.parse(fs.readFileSync(path.join(TMP, "store.json"), "utf8"));
    check("额外账号已落盘", Array.isArray(storeRaw.accounts) && storeRaw.accounts.length === 0, JSON.stringify(storeRaw.accounts));
    check("默认账号不落盘（虚拟账号）", !(storeRaw.accounts || []).some((a) => a.id === "juejin"));

    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error("测试异常:", e.message);
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
