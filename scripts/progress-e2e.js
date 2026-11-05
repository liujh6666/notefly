/*
 * 统一进度中心 端到端测试（真实 HTTP，发布走可控替身）
 * 运行：node scripts/progress-e2e.js
 *
 * 对应验收问题 8/9/10：
 *   1. 发布主任务接入进度中心：运行中可在 /api/progress/tasks?active=1 看到，
 *      逐平台推进，结束后有正确终态（不再「发布进行中却查无此任务」）
 *   2. 下载进度量纲一致：completed/total 都是字节，50% 不会再显示成 0%
 *   3. 取消接到底层消费逻辑：download-cancelled 回报后任务转 cancelled，
 *      不再永远卡在 cancelling
 *
 * 发布替身（NOTEFLY_RPA_STUB=1）由 server.js 提供 —— 绝不打开真实平台网站。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-progress-"));
const PORT = 3296;
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
      NOTEFLY_RPA_STUB_DELAY_MS: "1200",
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

    /* ---------- 1. 发布任务接入进度中心 ---------- */
    const content = await api("/api/contents", "POST", {
      type: "ARTICLE", title: "进度中心验证文章", body: "这是用于验证发布接入进度中心的正文内容，长度足够保存。",
    });
    check("准备：测试内容保存成功", !!content.id, JSON.stringify(content).slice(0, 120));

    const pub = await api("/api/publish", "POST", {
      contentId: content.id,
      accountIds: ["juejin", "csdn"],
      mode: "publish",
      title: "进度中心验证文章",
    });
    const pubTaskId = (pub.task && pub.task.id) || pub.id;
    check("发布任务已受理", !!pubTaskId, JSON.stringify(pub).slice(0, 120));

    /* 执行中（替身每账号延时 1.2s，这个窗口内必须是活跃任务） */
    await sleep(900);
    const activeDuring = await api("/api/progress/tasks?active=1");
    const pubActive = (activeDuring.tasks || []).filter((t) => t.type === "publish");
    check("发布执行中出现在统一进度中心（active=1）", pubActive.length >= 1,
      `active 列表：${JSON.stringify(activeDuring.tasks.map((t) => t.type))}`);
    if (pubActive.length) {
      check("发布任务标题可读", /进度中心验证文章|发布：/.test(pubActive[0].title), pubActive[0].title);
      check("发布任务不可「假装取消」", pubActive[0].cancellable === false);
      check("发布任务总量 = 平台数", pubActive[0].total === 2, `total=${pubActive[0].total}`);
      check("执行中阶段说明是真实状态（非伪造百分比）",
        !!pubActive[0].stageNote && pubActive[0].stageNote !== "等待开始", pubActive[0].stageNote);
    }

    /* 等执行结束（2 个平台 × 1.2s + 余量） */
    let pubFinal = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const all = await api("/api/progress/tasks?type=publish");
      const t = (all.tasks || []).find((x) => x.id === (pubActive[0] && pubActive[0].id));
      if (t && ["success", "failed", "cancelled", "interrupted"].includes(t.status)) { pubFinal = t; break; }
    }
    check("发布进度记录进入终态", !!pubFinal, "超时未观察到终态");
    if (pubFinal) {
      check("发布成功 → 进度记录 success", pubFinal.status === "success", `status=${pubFinal.status}`);
      check("进度分子分母一致（2/2）", pubFinal.completed === 2 && pubFinal.total === 2,
        `completed=${pubFinal.completed} total=${pubFinal.total}`);
      check("终态阶段说明是「已完成」", pubFinal.stageNote === "已完成", pubFinal.stageNote);
    }
    /* 发布记录本身也应完成 */
    const pubRecord = await api("/api/tasks");
    const rec = (pubRecord.tasks || []).find((t) => t.id === pubTaskId);
    check("发布记录最终状态 done", rec && rec.status === "done", rec && rec.status);

    /* ---------- 2. 下载进度量纲：completed/total 都是字节 ---------- */
    await api("/api/update/progress", "POST", {
      type: "download-progress", transferred: 50000000, total: 100000000, percent: 50,
    });
    const afterProg = await api("/api/progress/tasks?type=update");
    const dlTask = (afterProg.tasks || []).find((t) => t.stage === "downloading");
    check("下载进度任务存在", !!dlTask);
    if (dlTask) {
      check("量纲统一：completed=已下载字节", dlTask.completed === 50000000, `completed=${dlTask.completed}`);
      check("量纲统一：total=总字节", dlTask.total === 100000000, `total=${dlTask.total}`);
      const pct = Math.round((dlTask.completed / dlTask.total) * 100);
      check("前端公式不再得到 0%", pct === 50, `pct=${pct}`);
      check("阶段说明带 MB 进度", /MB/.test(dlTask.stageNote), dlTask.stageNote);
    }

    /* ---------- 3. 取消接到底层消费逻辑 ---------- */
    const cancelRes = await api(`/api/progress/tasks/${dlTask.id}/cancel`, "POST", {});
    check("取消请求受理（进入 cancelling）", cancelRes.ok === true, JSON.stringify(cancelRes).slice(0, 120));
    let mid = await api(`/api/progress/tasks/${dlTask.id}`);
    check("任务处于 cancelling", mid.task && mid.task.status === "cancelling", mid.task && mid.task.status);

    /* 主进程确认下载已真正停止 → 任务转 cancelled，绝不永远卡在 cancelling */
    await api("/api/update/progress", "POST", { type: "download-cancelled" });
    mid = await api(`/api/progress/tasks/${dlTask.id}`);
    check("回报 download-cancelled 后任务转 cancelled",
      mid.task && mid.task.status === "cancelled", mid.task && mid.task.status);

    /* ---------- 4. 切换数据目录：当前企业必须从新目录配置恢复 ----------
       对应验收问题 7：新目录 config.json 已选企业 new-co，
       切换（migrate:false）后 /api/library/current 必须返回 new-co，
       而不是空企业或旧目录残留的企业。 */
    const newDir = path.join(TMP, "other-data");
    fs.mkdirSync(newDir, { recursive: true });
    const otherCompanyId = "co-other-0001";
    fs.writeFileSync(path.join(newDir, "library.json"), JSON.stringify({
      version: 1,
      companies: [{ id: otherCompanyId, name: "新目录企业", articles: [], createdAt: new Date().toISOString() }],
    }), "utf8");
    fs.writeFileSync(path.join(newDir, "config.json"), JSON.stringify({ currentCompanyId: otherCompanyId }), "utf8");

    const sw = await api("/api/data-dir", "POST", { dir: newDir, migrate: false });
    check("切换到已有数据目录成功", sw.ok === true, JSON.stringify(sw).slice(0, 160));
    const cur = await api("/api/library/current");
    check("当前企业从新目录配置恢复", cur.companyId === otherCompanyId,
      `companyId=${cur.companyId} companyName=${cur.companyName}`);

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
