/*
 * 验证：账号管理不再把「误判的登录态」显示成已登录
 * 运行：node scripts/account-state-check.js
 *
 * 场景还原：用户只登录了 1 个平台，但历史巡检把 8 个平台判成了「已登录」，
 * 其中 7 个是 DOM 判定（游客占位头像被误判）。修复后：
 *   1. 旧规则（judge 版本不符）的结论一律作废 → 退回「待检查」
 *   2. 结果过期的结论降级成「待复核」
 *   3. 只有「新鲜 + 规则匹配」的结论才算「已登录」
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-acct-"));
const PORT = 3321;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "store.json"), JSON.stringify({ contents: [], tasks: [], accounts: [] }));

  /* 造一份「用户真实历史」：8 条误判为已登录（7 条旧规则 dom + 1 条 api），
     2 条未登录，1 条用新规则确认的已登录 */
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();   /* 3 小时前 */
  const cfg = {
    kaState: {
      lastRun: old,
      lastOnline: 8,
      lastTotal: 19,
      details: [
        { platform: "掘金", id: "juejin", online: true, checkedAt: now, method: "api", judge: 2 },
        { platform: "CSDN", id: "csdn", online: true, checkedAt: old, method: "dom" },
        { platform: "头条号", id: "toutiao", online: true, checkedAt: old, method: "dom" },
        { platform: "百家号", id: "baijiahao", online: true, checkedAt: old, method: "dom" },
        { platform: "一点资讯", id: "yidian", online: true, checkedAt: old, method: "dom" },
        { platform: "大鱼号", id: "dayu", online: true, checkedAt: old, method: "dom" },
        { platform: "博客园", id: "cnblogs", online: true, checkedAt: old, method: "dom" },
        { platform: "InfoQ", id: "infoq", online: true, checkedAt: old, method: "dom" },
        { platform: "知乎", id: "zhihu", online: false, checkedAt: now, method: "api", judge: 2 },
        { platform: "微博", id: "weibo", online: false, checkedAt: now, method: "dom", judge: 2 },
      ],
      nextRun: null,
    },
  };
  fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify(cfg));

  const srv = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), NOTEFLY_DATA_DIR: TMP, NOTEFLY_DISABLE_SCHEDULER: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + "/api/config")).ok) break; } catch {}
    await sleep(250);
  }

  /* --- 服务端层 --- */
  const acc = await (await fetch(BASE + "/api/accounts")).json();
  const byId = Object.fromEntries((acc.accounts || []).map((a) => [a.id, a]));
  check("掘金（新规则+新鲜）仍算已登录", byId.juejin.isLoggedIn === true && byId.juejin.stale === false);
  check("知乎/微博（新规则+未登录）算未登录", byId.zhihu.isLoggedIn === false && byId.weibo.isLoggedIn === false);
  check("旧规则判为已登录的 7 个已退回待检查",
    ["csdn", "toutiao", "baijiahao", "yidian", "dayu", "cnblogs", "infoq"].every((id) => byId[id].isLoggedIn === null),
    JSON.stringify(Object.fromEntries(["csdn", "toutiao", "baijiahao", "yidian", "dayu", "cnblogs", "infoq"].map((id) => [id, byId[id].isLoggedIn]))));
  check("服务端统计出作废条数", acc.outdated === 7, String(acc.outdated));

  /* --- 界面层 --- */
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    errors.push("[console] " + t);
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(600);
  await page.locator(".sidebar .el-menu-item", { hasText: "账号管理" }).first().click();
  await sleep(900);

  const body = await page.locator(".el-main").innerText();
  check("界面只列出 1 个账号（掘金）", /掘金/.test(body) && !/CSDN/.test(body), body.slice(0, 200));
  check("不再出现「8 个已登录」的说法", !/8\s*个已登录/.test(body));
  check("显示作废提示", /判定规则已升级/.test(body), body.slice(0, 300));
  check("提供「立即重新检查」入口", (await page.getByRole("button", { name: "立即重新检查" }).count()) === 1);

  /* 单个平台检查后应更新状态 */
  const rows = await page.locator(".el-table__body tr").count();
  check("表格只渲染 1 行", rows === 1, String(rows));

  check("无脚本报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
