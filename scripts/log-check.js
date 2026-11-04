/*
 * 运行日志功能端到端验证（真实浏览器）
 * 覆盖：
 *   1. 设置页「关于」里的版本号：连点 5 次才解锁日志入口，没点够不能出现
 *   2. 点够 5 次 → 出现「查看日志」按钮 → 能打开日志面板
 *   3. 面板能列出刚才的操作（保存内容）与报错（404）
 *   4. 级别筛选、关键词搜索、清空可用
 *   5. 日志文件真的落到磁盘上（重启后仍能读到）
 *
 * 运行：node scripts/log-check.js
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-logcheck-"));
const PORT = 3377;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

function startServer() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      NOTEFLY_DATA_DIR: TMP,
      NOTEFLY_DISABLE_SCHEDULER: "1",
      NOTEFLY_DISABLE_RESTORE: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.VERBOSE && console.log("[srv]", String(d).trim()));
  child.stderr.on("data", (d) => console.log("[srv:err]", String(d).trim()));
  return child;
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

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({
    engine: "rpa", keepalive: { enabled: false, intervalHours: 4 }, kaState: { details: [] },
  }, null, 2));

  let srv = startServer();
  if (!(await waitReady())) throw new Error("服务未就绪");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    pageErrors.push("[console] " + t);
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(900);

  /* 先制造一些操作与报错，让日志里有东西可看 */
  await page.locator(".sidebar .el-menu-item", { hasText: "内容库" }).click();
  await sleep(400);
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(400);
  await page.locator(".ce-title input").fill("日志回归-标题");
  await page.locator(".ce-textarea").fill("正文内容，用于验证日志记录。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await sleep(1200);
  /* 制造一次报错：访问不存在的内容 */
  await fetch(`${BASE}/api/contents/does-not-exist`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}",
  }).catch(() => {});
  await sleep(600);

  /* 1. 设置页：日志入口默认是藏着的 */
  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).click();
  await sleep(700);
  const aboutText = await page.locator(".el-main").innerText().catch(() => "");
  check("设置页仍显示关于文案", /本地多平台内容分发工作台 · NoteFly/.test(aboutText));
  check("日志入口默认不出现（点版本号前不能有「查看日志」）", !/查看日志/.test(aboutText), aboutText.slice(-200));

  const ver = page.locator(".nf-version").first();
  check("关于区有可点的版本号", (await ver.count()) === 1, `count=${await ver.count()}`);

  /* 2. 连点 4 次：还不够 5 次，不能解锁 */
  for (let i = 0; i < 4; i++) { await ver.click(); await sleep(120); }
  await sleep(400);
  let t1 = await page.locator(".el-main").innerText().catch(() => "");
  check("连点 4 次不解锁（日志入口仍不出现）", !/查看日志/.test(t1), t1.slice(-160));

  /* 3. 第 5 次：解锁并自动打开日志面板 */
  await ver.click();
  await sleep(900);
  const t2 = await page.locator(".el-main").innerText().catch(() => "");
  check("连点 5 次后出现「查看日志」入口", /查看日志/.test(t2), t2.slice(-200));

  const dlg = page.locator(".log-dialog");
  check("日志面板已打开", await dlg.isVisible().catch(() => false));

  /* 4. 面板里能看到刚才的操作与报错 */
  const rows = await page.locator(".log-row").count();
  check("日志面板列出了条目", rows > 0, `行数 ${rows}`);
  const panelText = await page.locator(".log-dialog").innerText().catch(() => "");
  check("记录了保存内容的操作", /保存内容/.test(panelText), panelText.slice(0, 200));
  check("记录了 404 报错", /404/.test(panelText), panelText.slice(0, 200));

  /* 5. 级别筛选：阈值语义（警告及以上应包含 404 那条警告） */
  await page.locator(".log-dialog .el-select").first().click();
  await sleep(300);
  await page.locator(".el-select-dropdown__item", { hasText: "警告及以上" }).first().click();
  await sleep(700);
  const warnLevels = await page.locator(".log-dialog .log-row .log-level").allInnerTexts().catch(() => []);
  check("级别筛选生效（警告及以上只剩警告/错误行）",
    warnLevels.length >= 1 && warnLevels.every((t) => /警告|错误/.test(t)),
    JSON.stringify(warnLevels.slice(0, 8)));

  /* 6. 关键词搜索（搜索框在工具条里，是 el-input 不是 el-select） */
  await page.locator(".log-dialog .el-select").first().click();
  await sleep(300);
  await page.locator(".el-select-dropdown__item", { hasText: "全部（含调试）" }).first().click();
  await sleep(500);
  await page.locator(".log-bar .el-input input").first().fill("保存内容");
  await page.locator(".log-dialog").getByRole("button", { name: "搜索" }).click();
  await sleep(700);
  const kwRows = await page.locator(".log-dialog .log-row").count();
  const kwText = await page.locator(".log-dialog").innerText().catch(() => "");
  check("关键词搜索能过滤（只剩匹配行）", kwRows >= 1 && /保存内容/.test(kwText) && !/404/.test(kwText),
    `行数 ${kwRows}，${kwText.slice(0, 160)}`);

  /* 6.1 前端报错也要能上报到日志（界面里的 JS 异常） */
  await page.locator(".log-bar .el-input input").first().fill("");
  await page.locator(".log-dialog").getByRole("button", { name: "搜索" }).click();
  await sleep(400);
  await fetch(`${BASE}/api/logs/client`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level: "error", scope: "界面", message: "前端异常上报验证", url: "http://x/y" }),
  }).catch(() => {});
  await sleep(600);
  await page.locator(".log-dialog .el-select").first().click();
  await sleep(300);
  await page.locator(".el-select-dropdown__item", { hasText: "仅看错误" }).first().click();
  await sleep(800);
  const errRows = await page.locator(".log-dialog .log-row").count();
  const errLevels = await page.locator(".log-dialog .log-row .log-level").allInnerTexts().catch(() => []);
  check("前端上报的异常记为错误级", errRows >= 1 && errLevels.every((t) => /错误/.test(t)),
    `行数 ${errRows}，${JSON.stringify(errLevels.slice(0, 8))}`);

  /* 7. 磁盘上真的有日志文件 */
  const logDir = path.join(TMP, "logs");
  const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((n) => n.endsWith(".log")) : [];
  check("日志已落盘到数据目录的 logs/ 下", logFiles.length >= 1, JSON.stringify(logFiles));
  if (logFiles.length) {
    const raw = fs.readFileSync(path.join(logDir, logFiles[0]), "utf8");
    check("日志文件是 JSONL（每行可解析）", raw.split("\n").filter(Boolean).every((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    }));
    check("日志文件里有保存内容的记录", /保存内容/.test(raw));
  }

  /* 8. 服务重启后日志仍在（磁盘持久化） */
  srv.kill();
  await sleep(700);
  srv = startServer();
  if (!(await waitReady())) throw new Error("服务重启失败");
  const afterRestart = await (await fetch(`${BASE}/api/logs?limit=50`)).json();
  check("重启后历史日志仍可读", (afterRestart.entries || []).some((e) => /保存内容/.test(e.message)),
    JSON.stringify((afterRestart.entries || []).slice(0, 3).map((e) => e.message)));

  /* 9. 清空（先点工具条的「清空」，再在确认框里确认） */
  await page.reload({ waitUntil: "networkidle" });
  await sleep(800);
  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).click();
  await sleep(600);
  for (let i = 0; i < 5; i++) { await page.locator(".nf-version").first().click(); await sleep(110); }
  await sleep(800);
  await page.locator(".log-bar").getByRole("button", { name: "清空" }).click();
  await sleep(500);
  /* 确认框（ElMessageBox）在弹窗外，单独定位 */
  await page.locator(".el-message-box").getByRole("button", { name: "清空" }).click();
  await sleep(900);
  const afterClear = await (await fetch(`${BASE}/api/logs?limit=50`)).json();
  check("清空后日志条数归零", (afterClear.entries || []).length === 0,
    `剩余 ${(afterClear.entries || []).length} 条`);

  check("无脚本错误", pageErrors.length === 0, pageErrors.join(" | "));

  await browser.close();
  srv.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
