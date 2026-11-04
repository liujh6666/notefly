/*
 * 临时验证：未接入 AI 时，AI 功能按钮灰态 + 点击弹「接入 AI」提醒 + 点提醒跳设置并高亮
 * 运行：node scripts/ai-gate-check.js
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-gate-"));
const PORT = 3311;
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

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "store.json"), JSON.stringify({ contents: [], tasks: [], accounts: [] }));

  const srv = startServer();
  if (!(await waitReady())) throw new Error("服务未起来");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

  /* 1. 顶栏状态灯仍是「AI 未接入」且可点 */
  check("顶栏显示 AI 未接入", /AI 未接入/.test(await page.locator(".el-header").innerText()));
  check("AI 状态灯可点", (await page.locator(".engine-chip--click").count()) >= 1);

  /* 2. 编辑器里的「AI 写作」按钮：灰态但不是 disabled（要能吃点击） */
  await page.locator(".sidebar .el-menu-item", { hasText: "内容库" }).click();
  await sleep(400);
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(500);

  const aiBtn = page.getByRole("button", { name: /AI 写作/ });
  const cls = (await aiBtn.getAttribute("class")) || "";
  check("未接入时 AI 写作按钮是灰态", cls.includes("is-ai-locked"), cls);
  check("灰态按钮没有被 disabled（否则点不出提醒）", !(await aiBtn.isDisabled()), cls);
  const btnColor = await aiBtn.evaluate((el) => getComputedStyle(el).color);
  check("灰态按钮文字颜色变浅", /rgb\((1[0-9]{2}|2[0-9]{2})/.test(btnColor) || btnColor !== "rgb(178, 58, 38)", btnColor);

  /* 3. 点它 → 弹「AI 未接入」提醒，带「接入 AI」按钮 */
  await aiBtn.click();
  await sleep(700);
  const box = page.locator(".el-message-box").first();
  check("点击弹出未接入提醒", await box.isVisible().catch(() => false));
  const boxText = await box.innerText().catch(() => "");
  check("提醒文案说明要接入 AI", /AI 未接入/.test(boxText) && /接入 AI/.test(boxText), boxText.replace(/\s+/g, " ").slice(0, 120));

  /* 4. 点「接入 AI」→ 跳设置页并高亮 AI 卡 */
  await box.getByRole("button", { name: "接入 AI" }).click();
  await sleep(1000);
  const mainText = await page.locator(".el-main").innerText().catch(() => "");
  check("跳转到设置页", /AI 模型/.test(mainText) && /服务地址 Base URL/.test(mainText), mainText.replace(/\s+/g, " ").slice(0, 100));
  const flashed = await page.locator("#set-ai").evaluate((el) => el.classList.contains("set-flash")).catch(() => false);
  check("AI 卡片被高亮标出", flashed);
  const inView = await page.locator("#set-ai").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  }).catch(() => false);
  check("AI 卡片滚动到了可视区", inView);

  /* 5. 去 AI 味弹窗里的「AI 深度改写」：灰但可点 */
  await page.locator(".sidebar .el-menu-item", { hasText: "内容库" }).click();
  await sleep(400);
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(500);
  await page.locator(".ce-textarea").fill("总而言之，这是一个非常重要的问题。我们通过不断的探索，能够有效地提升整体的效率。");
  await page.getByRole("button", { name: /去 AI 味/ }).click();
  await sleep(1200);
  const gate = page.locator(".ai-gate").first();
  check("AI 深度改写是灰态", (await gate.getAttribute("class")).includes("locked"));
  await gate.click();
  await sleep(700);
  const box2 = page.locator(".el-message-box").first();
  const box2Text = await box2.innerText().catch(() => "");
  check("点灰态开关也弹接入提醒", /AI 未接入/.test(box2Text), box2Text.replace(/\s+/g, " ").slice(0, 100));
  await box2.getByRole("button", { name: "稍后再说" }).click();
  await sleep(400);

  check("无脚本报错", errors.length === 0, errors.join(" | ").slice(0, 200));

  await browser.close();
  srv.kill();
  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
