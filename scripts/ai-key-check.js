/*
 * 验证：设置页「申请 Key」按预设跳转 + 「断开 AI」回到未接入
 * 运行：node scripts/ai-key-check.js
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-key-"));
const PORT = 3313;
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

  const srv = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), NOTEFLY_DATA_DIR: TMP, NOTEFLY_DISABLE_SCHEDULER: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + "/api/config")).ok) break; } catch {}
    await sleep(250);
  }

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

  /* 捕获 window.open 的目标地址（不真的打开外网） */
  await page.addInitScript(() => {
    window.__opened = [];
    const orig = window.open;
    window.open = (url, ...rest) => { window.__opened.push(String(url)); return { closed: false }; };
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(600);
  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).first().click();
  await sleep(600);

  /* 1. 「申请 Key」按钮存在 */
  const keyBtn = page.getByRole("button", { name: "申请 Key" });
  check("设置页有「申请 Key」按钮", (await keyBtn.count()) === 1);

  /* 2. 未选云厂商时（custom）按钮禁用 */
  check("自定义服务时「申请 Key」禁用", await keyBtn.isDisabled());

  /* 3. 选 DeepSeek → 按钮可用，点击打开对应官网 */
  await page.locator(".ai-cfg-item").first().locator(".el-select").click();
  await sleep(400);
  await page.locator(".el-select-dropdown__item", { hasText: "DeepSeek" }).first().click();
  await sleep(500);
  check("选 DeepSeek 后「申请 Key」可用", !(await keyBtn.isDisabled()));
  await keyBtn.click();
  await sleep(600);
  const opened = await page.evaluate(() => window.__opened || []);
  check("点击跳到 DeepSeek 的 Key 申请页",
    opened.length === 1 && /platform\.deepseek\.com\/api_keys/.test(opened[0]), JSON.stringify(opened));

  /* 4. 切到 Ollama → 免 Key，按钮禁用 */
  await page.locator(".ai-cfg-item").first().locator(".el-select").click();
  await sleep(400);
  await page.locator(".el-select-dropdown__item", { hasText: "Ollama" }).first().click();
  await sleep(500);
  check("本地 Ollama 时「申请 Key」禁用（免 Key）", await keyBtn.isDisabled());

  /* 5. 填地址与模型 + Key，保存 → 已接入 */
  await page.locator(".ai-cfg-item").first().locator(".el-select").click();
  await sleep(400);
  await page.locator(".el-select-dropdown__item", { hasText: "DeepSeek" }).first().click();
  await sleep(500);
  await page.locator(".ai-cfg-item").nth(1).locator("input").fill("https://api.deepseek.com/v1");
  await page.locator(".ai-cfg-item").nth(2).locator("input").fill("sk-test-1234567890");
  await page.getByRole("button", { name: "保存配置" }).click();
  await sleep(1200);
  const cfgOn = await (await fetch(BASE + "/api/ai/config")).json();
  check("保存后已接入", cfgOn.connected === true, JSON.stringify({ connected: cfgOn.connected, hasKey: cfgOn.hasKey }));
  check("顶栏显示 AI 已接入", /AI 已接入/.test(await page.locator(".el-header").innerText()));

  /* 6. 断开 AI → 确认弹窗 → 回到未接入 */
  const offBtn = page.getByRole("button", { name: "断开 AI" });
  check("已接入时「断开 AI」可用", !(await offBtn.isDisabled()));
  await offBtn.click();
  await sleep(700);
  const box = page.locator(".el-message-box").first();
  check("断开前有确认弹窗", await box.isVisible().catch(() => false));
  await box.getByRole("button", { name: "断开" }).click();
  await sleep(1200);
  const cfgOff = await (await fetch(BASE + "/api/ai/config")).json();
  check("断开后 connected=false", cfgOff.connected === false);
  check("断开后 Key 已清除", cfgOff.hasKey === false);
  check("断开后地址已清除", cfgOff.baseUrl === "" && cfgOff.model === "");
  check("断开后预设保留（便于一键回填）", cfgOff.preset === "deepseek", cfgOff.preset);
  check("顶栏回到 AI 未接入", /AI 未接入/.test(await page.locator(".el-header").innerText()));
  await page.screenshot({ path: "_export/key-settings.png" });

  /* 7. 断开后编辑器里的「AI 写作」按钮恢复灰态 */
  await page.locator(".sidebar .el-menu-item", { hasText: "内容库" }).click();
  await sleep(500);
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(600);
  const aiBtnCls = (await page.getByRole("button", { name: /AI 写作/ }).getAttribute("class")) || "";
  check("断开后「AI 写作」按钮恢复灰态", aiBtnCls.includes("is-ai-locked"), aiBtnCls);

  check("无脚本报错", errors.length === 0, errors.join(" | ").slice(0, 200));

  await browser.close();
  srv.kill();
  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
