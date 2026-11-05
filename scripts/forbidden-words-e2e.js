/* 违禁词库 UI 端到端：设置页可见、可编辑、保存落盘、恢复默认 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nf-fw-e2e-"));
const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}
(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), NOTEFLY_DATA_DIR: TMP, NOTEFLY_DISABLE_SCHEDULER: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = await fetch(BASE + "/api/config").then((r) => r.ok).catch(() => false); if (!up) await sleep(400); }
    check("服务端就绪", up);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(BASE);
    /* 进设置页：侧栏按文案定位（ui-smoke 契约：.sidebar .el-menu-item 10 项） */
    await page.click('.sidebar .el-menu-item:has-text("设置")');
    await sleep(600);
    const fwTitle = await page.locator('.set-row:has-text("违禁词库")').count();
    check("设置页出现违禁词库卡片", fwTitle >= 1);

    const ta = page.locator('.set-row:has-text("违禁词库") textarea').first();
    const before = await ta.inputValue();
    check("词库文本域已列出默认词（30+ 行）", before.split("\n").filter((w) => w.trim()).length >= 30, "实际 " + before.split("\n").filter(Boolean).length + " 行");

    /* 增：追加一个词并保存 */
    await ta.fill(before + "\n测试违禁词XYZ");
    const words = before.split(/\r?\n/).filter((w) => w.trim()).concat(["测试违禁词XYZ"]);
    await page.click('button:has-text("保存词库")');
    await sleep(800);
    const onDisk = fs.readFileSync(path.join(TMP, "forbidden-words.txt"), "utf8");
    check("保存后落盘含新增词", onDisk.includes("测试违禁词XYZ"));
    check("保存后行数正确", onDisk.split("\n").filter((w) => w.trim()).length === words.length);

    /* 删：清掉新增词再保存 */
    await ta.fill(before);
    await page.click('button:has-text("保存词库")');
    await sleep(800);
    const onDisk2 = fs.readFileSync(path.join(TMP, "forbidden-words.txt"), "utf8");
    check("删除后落盘不含该词", !onDisk2.includes("测试违禁词XYZ"));

    /* 恢复默认 */
    page.once("dialog", (d) => d.accept()); // 原生 confirm 兜底（实际用 ElMessageBox）
    await page.click('button:has-text("恢复默认词库")');
    await sleep(500);
    const confirmBtn = page.locator('.el-message-box button:has-text("恢复默认")');
    if (await confirmBtn.count()) await confirmBtn.click();
    await sleep(1000);
    const onDisk3 = fs.readFileSync(path.join(TMP, "forbidden-words.txt"), "utf8");
    check("恢复默认后回到 30+ 词", onDisk3.split("\n").filter((w) => w.trim()).length >= 30);
    check("默认词含「国家级」", onDisk3.includes("国家级"));

    /* 未保存提示：改一下文本，按钮应解锁 */
    await ta.fill(before + "\n再来一个");
    const saveDisabled = await page.locator('button:has-text("保存词库")').isDisabled().catch(() => null);
    check("修改后保存按钮解锁", saveDisabled === false);
  } catch (e) {
    check("流程无异常", false, String(e.message || e).slice(0, 200));
  } finally {
    if (browser) await browser.close().catch(() => {});
    spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { shell: true });
    setTimeout(() => process.exit(failures ? 1 : 0), 1500);
  }
})();
