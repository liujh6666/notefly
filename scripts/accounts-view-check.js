/*
 * 验证：修复后的账号管理页真实表现（用项目真实数据目录）
 * 运行：node scripts/accounts-view-check.js
 */
const { chromium } = require("playwright");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASE = "http://localhost:3210";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

(async () => {
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
  await sleep(700);

  await page.locator(".sidebar .el-menu-item", { hasText: "账号管理" }).first().click();
  await sleep(1000);

  const body = await page.locator(".el-main").innerText();
  check("不再显示虚假的已登录账号", !/CSDN|头条号|百家号|一点资讯|大鱼号|博客园|InfoQ/.test(body), body.slice(0, 300));
  check("显示「判定规则已升级」提示", /判定规则已升级/.test(body));
  check("显示「立即重新检查」按钮", (await page.getByRole("button", { name: "立即重新检查" }).count()) === 1);
  const rows = await page.locator(".el-table__body tr").count();
  check("表格无已登录行（全部待检查）", rows === 0, String(rows));

  await page.screenshot({ path: path.join(ROOT, "_export", "accounts-fixed.png") });

  /* 内容库数据在迁移后的目录里仍可访问（草稿 + 封面） */
  await page.locator(".sidebar .el-menu-item").filter({ hasText: /^内容库$/ }).first().click();
  await sleep(900);
  const cBody = await page.locator(".el-main").innerText();
  check("内容库能看到迁移过来的草稿", /测试/.test(cBody), cBody.slice(0, 200));

  const cover = await page.evaluate(async () => {
    const r = await fetch("/api/contents");
    const j = await r.json();
    const c = (j.contents || [])[0];
    if (!c || !c.cover) return { ok: false, reason: "无封面" };
    const res = await fetch(c.cover);
    return { ok: res.ok, status: res.status, cover: c.cover };
  });
  check("草稿封面在新目录下仍可访问", cover.ok, JSON.stringify(cover));

  check("无脚本报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
