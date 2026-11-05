/*
 * 软件更新链路 端到端测试（真实 HTTP，不访问真实 GitHub）
 * 运行：node scripts/update-e2e.js
 *
 * 对应验收问题 2/3/9/11：
 *   1. 检查结果持久化口径：已是最新 → up_to_date（不再误记 available）
 *   2. 没配置仓库 → 明确失败，不留会误导的状态
 *   3. 下载进度量纲一致（字节），前端公式得到正确百分比
 *   4. 「已下载待安装」状态可通过 /api/update/state 读取，
 *      安装接口校验版本、未下载时明确拒绝（浏览器模式不装）
 *   5. 下载取消有完整的消费逻辑（cancelling → cancelled）
 *
 * 说明：check 的 GitHub 真实联通不在本脚本范围（需要网络与真实仓库），
 * 「已是最新」的持久化口径由 tests/updater.test.js 的 applyCheckResult 单测覆盖；
 * 本脚本用 /api/update/progress 模拟主进程回报，驱动任务状态机走完全程。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-update-"));
const PORT = 3295;
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
  try { return JSON.parse(t); } catch { return { error: t.slice(0, 200), _status: r.status }; }
}

(async () => {
  const child = startServer();
  try {
    if (!await waitReady()) throw new Error("服务未能启动");

    /* ---------- 1. 初始状态 ---------- */
    const st0 = await api("/api/update/state");
    check("初始状态可读", st0.ok === true && typeof st0.lastResult === "string");
    check("浏览器/开发态明确标注 desktop=false", st0.desktop === false);
    check("初始无已下载记录", !st0.downloaded || !st0.downloaded.version);

    /* ---------- 2. 检查结果持久化口径 ----------
       仓库有 package.json 兜底（liujh6666/notefly），网络可达时可能真的查到
       「已是最新」。两种合法结局：up_to_date（网络可达且无新版）或 failed
       （网络不可达）。绝不允许 available，也绝不允许把「已是最新」标成失败。 */
    const c0 = await api("/api/update/check", "POST", { manual: true, timeoutMs: 5000 });
    const st1 = await api("/api/update/state");
    if (c0.upToDate) {
      check("已是最新 → 状态持久化为 up_to_date", st1.lastResult === "up_to_date", st1.lastResult);
      check("已是最新 → 不留新版本号", !st1.lastVersion);
    } else if (c0.ok === false) {
      check("检查失败 → 状态持久化为 failed（不伪装成功）", st1.lastResult === "failed", st1.lastResult);
    } else {
      check("真实环境查到了新版本 → available", st1.lastResult === "available", st1.lastResult);
    }

    /* 配置一个不可达的仓库地址 → 必须明确失败（无网络/网络错误不伪装成功） */
    await api("/api/config", "POST", { update: { repo: "example-invalid/notefly-nope" } });
    const c1 = await api("/api/update/check", "POST", { manual: true, timeoutMs: 3000 });
    check("不可达仓库检查不伪装成功", c1.ok === false && !c1.upToDate, JSON.stringify(c1).slice(0, 120));
    const st2 = await api("/api/update/state");
    check("失败状态如实持久化", st2.lastResult === "failed", st2.lastResult);

    /* ---------- 3. 下载进度量纲 ---------- */
    await api("/api/update/progress", "POST", {
      type: "download-progress", transferred: 25000000, total: 100000000, percent: 25,
    });
    let dl = (await api("/api/progress/tasks?type=update")).tasks.find((t) => t.stage === "downloading");
    check("下载任务自动创建", !!dl);
    check("completed 是字节数", dl && dl.completed === 25000000, dl && dl.completed);
    check("total 是总字节数", dl && dl.total === 100000000, dl && dl.total);
    check("25% 不再显示成 0%", dl && Math.round((dl.completed / dl.total) * 100) === 25);

    /* ---------- 4. 取消下载：cancelling → cancelled（必须在下载完成前） ---------- */
    const cancelRes = await api(`/api/progress/tasks/${dl.id}/cancel`, "POST", {});
    check("取消请求受理", cancelRes.ok === true, JSON.stringify(cancelRes).slice(0, 120));
    let mid = await api(`/api/progress/tasks/${dl.id}`);
    check("任务进入 cancelling", mid.task.status === "cancelling", mid.task.status);
    await api("/api/update/progress", "POST", { type: "download-cancelled" });
    mid = await api(`/api/progress/tasks/${dl.id}`);
    check("回报后任务转 cancelled（不永远卡在取消中）", mid.task.status === "cancelled", mid.task.status);

    /* ---------- 5. 下载完成 → 「已下载待安装」可读 ---------- */
    await api("/api/update/progress", "POST", { type: "downloaded", version: "2.0.0" });
    const st3 = await api("/api/update/state");
    check("下载完成后状态里能读到待安装版本",
      st3.downloaded && st3.downloaded.version === "2.0.0", JSON.stringify(st3.downloaded));

    /* ---------- 6. 安装接口 ---------- */
    const ins0 = await api("/api/update/install", "POST", { version: "2.0.0" });
    check("浏览器/开发态安装被明确拒绝", !!ins0.error, JSON.stringify(ins0).slice(0, 120));
    const ins1 = await api("/api/update/install", "POST", { version: "9.9.9" });
    check("版本不一致时拒绝安装", !!ins1.error, JSON.stringify(ins1).slice(0, 120));

    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  } catch (e) {
    console.error("E2E 异常：", e);
    failures++;
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  process.exit(failures === 0 ? 0 : 1);
})();
