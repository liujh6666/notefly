/*
 * AI 与文本工具的端到端验证
 * ------------------------------------------------------------
 * 真实浏览器 + 真实 Express 实例，覆盖：
 *   1. 编辑器工具条出现「一键排版 / 去 AI 味 / AI 写作」
 *   2. 一键排版：原文 → 处理后 → 应用到正文
 *   3. 去 AI 味：AI 味评分 + 改动明细 + 应用到正文
 *   4. AI 写作台：未配置模型时给出明确提示，不静默失败
 *   5. 设置页 AI 模型配置区可渲染、可保存、Key 只回掩码
 *   6. 全程无控制台报错
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nf-ai-e2e-"));
const PORT = 3417;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || "" });
  console.log((cond ? "✓ " : "✗ ") + name + (extra ? "  " + extra : ""));
}

/* 编辑器里有未保存内容时，点侧边栏会弹「确认离开？」，必须先确认 */
async function confirmLeave(page) {
  const box = page.locator(".el-message-box").last();
  if ((await box.count()) === 0) return;
  await sleep(350);
  const ok = box.locator("button.el-button--primary").last();
  if (await ok.count()) {
    await ok.click();
    await sleep(700);
    return;
  }
  await box.getByText("确定", { exact: true }).last().click().catch(() => {});
  await sleep(700);
}

/* 清掉对话框遮罩与提示气泡，避免残留遮罩挡住后续点击 */
async function clearOverlays(page) {
  await page
    .waitForFunction(() => document.querySelectorAll(".el-overlay").length === 0, null, { timeout: 6000 })
    .catch(() => {});
  await page.evaluate(() =>
    document.querySelectorAll(".el-overlay, .el-message, .el-notification").forEach((n) => n.remove())
  );
  await sleep(200);
}

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, "config.json"),
    JSON.stringify({ baseUrl: "http://127.0.0.1:9", token: "", engine: "rpa", ai: {} })
  );

  const srv = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NOTEFLY_DATA_DIR: TMP, NOTEFLY_DISABLE_SCHEDULER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + "/api/config");
      if (r.ok) { boot = true; break; }
    } catch {}
    await sleep(250);
  }
  if (!boot) { console.error("服务没起来"); process.exit(1); }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const logs = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(700);

  /* --- 进入编辑器 --- */
  await page.locator(".sidebar .el-menu-item").filter({ hasText: /^内容库$/ }).click();
  await sleep(500);
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(700);
  check("进入编辑器", await page.locator(".ce-textarea").isVisible());

  /* --- 1. 工具条按钮 --- */
  const fmtBtn = page.getByRole("button", { name: /一键排版/ });
  const humBtn = page.getByRole("button", { name: /去 AI 味/ });
  const aiBtn = page.getByRole("button", { name: /AI 写作/ });
  check("工具条：一键排版", (await fmtBtn.count()) > 0);
  check("工具条：去 AI 味", (await humBtn.count()) > 0);
  check("工具条：AI 写作", (await aiBtn.count()) > 0);

  /* --- 2. 一键排版 --- */
  await page.locator(".ce-textarea").fill("#标题\n\n* 项目一\n    * 嵌套\n第二段,, 第二段.\n\n```js\nconst a = 1; // 保留\n```\n");
  await fmtBtn.first().click();
  await sleep(1200);
  const dlgFmt = page.locator(".el-dialog").filter({ hasText: "一键排版" });
  check("排版对话框打开", await dlgFmt.first().isVisible());
  const after = await dlgFmt.locator(".tt-text").nth(1).innerText();
  check("排版：标题规范化", after.includes("# 标题"), after.slice(0, 30).replace(/\n/g, "\\n"));
  check("排版：列表符号统一", after.includes("- 项目一"));
  check("排版：中文标点归一", after.includes("第二段，第二段。"));
  check("排版：代码块内容保留", after.includes("const a = 1; // 保留"));
  await dlgFmt.getByRole("button", { name: "应用到正文" }).click();
  await sleep(500);
  const body1 = await page.locator(".ce-textarea").inputValue();
  check("排版结果已写回正文", body1.includes("# 标题") && body1.includes("- 项目一"));

  /* --- 3. 去 AI 味 --- */
  await page.locator(".ce-textarea").fill(
    "首先，值得注意的是，众所周知，Node.js 生态非常成熟。\n其次，通过赋能的方式，我们能够构建闭环的底层逻辑，这极大地提效了。\n\n不仅提升了效率，而且还降低了成本。总而言之，这是一次成功的赋能。\n"
  );
  await humBtn.first().click();
  await sleep(1200);
  const dlgHum = page.locator(".el-dialog").filter({ hasText: "去 AI 味" });
  check("去AI味对话框打开", await dlgHum.first().isVisible());
  const scoreTag = await dlgHum.locator(".el-tag").first().innerText();
  check("显示 AI 味评分", /AI 味\s*\d+/.test(scoreTag), scoreTag);
  const changeRows = await dlgHum.locator(".tt-change-row").count();
  check("列出改动明细", changeRows > 0, changeRows + " 条");
  const humAfter = await dlgHum.locator(".tt-text").nth(1).innerText();
  check("删除空转插入语", !humAfter.includes("值得注意的是") && !humAfter.includes("众所周知"));
  check("抽象词降级", !humAfter.includes("赋能") && !humAfter.includes("闭环"));
  check("拆解不仅…而且", humAfter.includes("提升了效率，降低了成本") || humAfter.includes("提升了效率，"));
  await dlgHum.getByRole("button", { name: "应用到正文" }).click();
  await sleep(500);
  const body2 = await page.locator(".ce-textarea").inputValue();
  check("去AI味结果已写回正文", !body2.includes("赋能"));

  /* --- 4. AI 写作台（未配置模型）：按钮灰态，点击弹「接入 AI」提醒 --- */
  const aiBtnCls = (await aiBtn.first().getAttribute("class")) || "";
  check("未接入时 AI 写作按钮呈灰态", aiBtnCls.includes("is-ai-locked"), aiBtnCls);
  await aiBtn.first().click();
  await sleep(900);
  const lockBox = page.locator(".el-message-box").first();
  check("点击弹出「AI 未接入」提醒", await lockBox.isVisible().catch(() => false));
  check("提醒带「接入 AI」按钮", (await lockBox.getByRole("button", { name: "接入 AI" }).count()) === 1);
  await lockBox.getByRole("button", { name: "稍后再说" }).click();
  await sleep(400);
  const dlgAiClosed = await page.locator(".el-dialog").filter({ hasText: "AI 写作台" }).isVisible().catch(() => false);
  check("写作台在未接入时不会打开", !dlgAiClosed);
  await page.evaluate(() => document.querySelectorAll(".el-message, .el-notification").forEach((n) => n.remove()));

  /* --- 5. 设置页 AI 配置 --- */
  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).first().click();
  await sleep(400);
  await confirmLeave(page);
  await sleep(900);
  console.log("   [诊断] message-box:", await page.locator(".el-message-box").count(),
    "| title:", await page.locator(".page-title").first().innerText().catch(() => "(无)"),
    "| main 前80字:", (await page.locator(".main-area").innerText().catch(() => "(无)")).slice(0, 80).replace(/\n/g, " "));
  const setGroups = await page.locator(".set-group").count();
  check("设置页有 AI 模型分组", (await page.locator(".ai-cfg-grid").count()) > 0, "set-group=" + setGroups);
  await page.locator(".ai-cfg-item").filter({ hasText: "服务地址" }).locator("input").fill("https://api.deepseek.com/v1");
  await page.locator(".ai-cfg-item").filter({ hasText: "API Key" }).locator("input").fill("sk-test-1234567890abcdef");
  const modelInput = page.locator(".ai-cfg-item").filter({ hasText: "模型名" }).locator("input").first();
  await modelInput.fill("deepseek-chat");
  await modelInput.press("Enter");
  await sleep(500);
  await page.getByRole("button", { name: "保存配置" }).click();
  await sleep(900);
  const cfg = await (await fetch(BASE + "/api/ai/config")).json();
  console.log("   [诊断] cfg:", JSON.stringify({ baseUrl: cfg.baseUrl, model: cfg.model, ready: cfg.ready, hasKey: cfg.hasKey }));
  check("配置已保存", cfg.baseUrl === "https://api.deepseek.com/v1" && cfg.model === "deepseek-chat");
  check("Key 已存储", cfg.hasKey === true);
  check("Key 只回掩码", cfg.keyMasked && !cfg.keyMasked.includes("1234567890"), cfg.keyMasked);
  check("ready 状态正确", cfg.ready === true);

  /* Key 落盘后确认明文只存在于 config.json，不在其它地方 */
  const rawCfg = fs.readFileSync(path.join(TMP, "config.json"), "utf8");
  check("Key 只写入 config.json", rawCfg.includes("sk-test-1234567890abcdef"));

  await page.screenshot({ path: path.join(ROOT, "_shots", "ai-settings.png") });

  /* --- 5.5 AI 写作台分发回归：顶层 action 不得被子动作覆盖 ---
     回归背景：aiForm.action（润色子动作，默认 polish）曾被整包发回，
     覆盖按 tab 算出的顶层 action，所有请求报「未知的操作类型: polish」。
     模型调用发生在服务端，所以用本地假模型服务（page.route 拦不到）；
     先刷新页面：clearOverlays 强删过 overlay DOM，热态下弹窗可能失效（测试辅助的副作用） */
  await page.reload({ waitUntil: "networkidle" });
  await sleep(700);
  let lastModelBody = null;
  const fakeModel = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastModelBody = JSON.parse(raw || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "fake", usage: { total_tokens: 5 }, choices: [{ message: { role: "assistant", content: "# 我的AI标题\n\n模拟的模型输出" } }] }));
    });
  });
  await new Promise((r) => fakeModel.listen(0, "127.0.0.1", r));
  const fakePort = fakeModel.address().port;
  await fetch(BASE + "/api/ai/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: "k", model: "fake-model" }),
  });

  await page.locator(".sidebar .el-menu-item").filter({ hasText: /^内容库$/ }).click();
  await sleep(500);
  await confirmLeave(page);
  await sleep(400);
  /* e2e 前面的内容从未保存过，这里新建一篇并写正文，润色改写才有可处理文本 */
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(700);
  await page.locator(".ce-title input").fill("AI 分发回归");
  await page.locator(".ce-textarea").fill("需要被润色改写的正文内容。");
  await page.getByRole("button", { name: /AI 写作/ }).first().click();
  await sleep(900);
  const dlgAi2 = page.locator(".el-dialog").filter({ hasText: "AI 写作台" });
  await dlgAi2.locator("textarea").first().fill("回归测试主题");
  let runReqP = page.waitForRequest((r) => r.url().includes("/api/ai/run"));
  await dlgAi2.getByRole("button", { name: "生成文章" }).click();
  const runBody = (await runReqP).postDataJSON();
  check("写作台 write 分发正确（不被子动作覆盖）", runBody.action === "write", JSON.stringify(runBody).slice(0, 100));
  /* 等 Vue 把结果渲染进结果区（响应 200 ≠ 渲染完成） */
  let resultShown = false;
  for (let i = 0; i < 20 && !resultShown; i++) {
    resultShown = /模拟的模型输出/.test(await dlgAi2.innerText().catch(() => ""));
    if (!resultShown) await sleep(500);
  }
  check("假模型的生成结果已展示", resultShown);
  await dlgAi2.locator(".el-tabs__item", { hasText: "润色改写" }).click();
  await sleep(400);
  /* el-tabs 未激活的 pane 仍留在 DOM，必须限定可见 pane，否则取到 write 页签里隐藏的 select */
  await dlgAi2.locator(".el-tab-pane:visible .el-select").first().click();
  await sleep(300);
  const rwOpts = await page.locator(".el-select-dropdown__item:visible").count();
  check("润色改写动作下拉有全部子动作", rwOpts >= 9, "选项数 " + rwOpts);
  await page.locator(".el-select-dropdown__item:visible", { hasText: "精简" }).first().click();
  await sleep(200);
  runReqP = page.waitForRequest((r) => r.url().includes("/api/ai/run"));
  await dlgAi2.getByRole("button", { name: "开始处理" }).click();
  const runBody2 = (await runReqP).postDataJSON();
  check("润色改写分发为 rewrite + subAction=shorten", runBody2.action === "rewrite" && runBody2.subAction === "shorten", JSON.stringify(runBody2).slice(0, 100));
  /* 假模型是并行进程收请求，断言前要等录制变量落下来，否则偶发抢跑 */
  for (let i = 0; i < 20 && !/篇幅压到约一半/.test(JSON.stringify(lastModelBody || "")); i++) await sleep(150);
  check("服务端按精简指令构造提示词", /篇幅压到约一半/.test(JSON.stringify(lastModelBody || "")));

  /* --- 5.6 AI 标题 → 直接填充到新建内容 ---
     假模型返回「# 标题 + 正文」，服务端要拆成 title/content，前端分别填进标题与正文 */
  await dlgAi2.locator(".el-tabs__item", { hasText: "写文章" }).click();
  await sleep(300);
  const withTitleBox = dlgAi2.locator(".el-checkbox", { hasText: "生成文章时一起生成标题" });
  check("写文章页有 AI 标题开关", (await withTitleBox.count()) > 0);
  check("AI 标题默认勾选", await withTitleBox.locator("input").isChecked());
  runReqP = page.waitForRequest((r) => r.url().includes("/api/ai/run"));
  await dlgAi2.getByRole("button", { name: "生成文章" }).click();
  const writeBody = (await runReqP).postDataJSON();
  check("write 请求带 withTitle", writeBody.withTitle === true, JSON.stringify(writeBody).slice(0, 120));
  let titleShown = "";
  for (let i = 0; i < 20 && !titleShown; i++) {
    titleShown = (await dlgAi2.locator(".ai-result-title .ai-title-text").innerText().catch(() => "")).trim();
    if (!titleShown) await sleep(400);
  }
  check("结果区单独显示 AI 标题", titleShown === "我的AI标题", "实际：" + titleShown);
  await dlgAi2.getByRole("button", { name: "填充到新建内容" }).click();
  await sleep(600);
  /* 编辑器里本来就有正文 → 会弹确认框（防误覆盖）；真实用户也是这个流程 */
  const confirmBox = page.locator(".el-message-box");
  if (await confirmBox.isVisible().catch(() => false)) {
    await confirmBox.getByRole("button", { name: "覆盖填充" }).click();
  }
  await sleep(900);
  const filledTitle = await page.locator(".ce-title input").inputValue();
  const filledBody = await page.locator(".ce-textarea").inputValue();
  check("标题已填进新建内容", filledTitle === "我的AI标题", "实际：" + filledTitle);
  check("正文已填进新建内容", /模拟的模型输出/.test(filledBody));
  check("正文里没有残留标题行", !/^#\s/.test(filledBody), filledBody.slice(0, 40));

  /* --- 5.7 去 AI 味调用模型（AI 深度改写） ---
     本地规则先预清洗，再走 /ai/run action=deai；返回后重新算标记 */
  await page.getByRole("button", { name: /去 AI 味/ }).first().click();
  await sleep(1200);
  const dlgHum2 = page.locator(".el-dialog").filter({ hasText: "去 AI 味" });
  const aiBox = dlgHum2.locator(".el-checkbox", { hasText: "AI 深度改写" });
  check("去 AI 味有 AI 深度改写开关", (await aiBox.count()) > 0);
  check("已接入模型时开关可用", !(await aiBox.locator("input").isDisabled()));
  runReqP = page.waitForRequest((r) => r.url().includes("/api/ai/run"));
  await aiBox.click();
  await sleep(300);
  const deaiBody = (await runReqP).postDataJSON();
  check("去 AI 味走 deai 动作", deaiBody.action === "deai", JSON.stringify(deaiBody).slice(0, 100));
  let aiAfter = "";
  for (let i = 0; i < 24 && !aiAfter; i++) {
    const pane = (await dlgHum2.locator(".tt-text").nth(1).innerText().catch(() => "")) || "";
    if (/模拟的模型输出/.test(pane)) aiAfter = pane;
    else await sleep(500);
  }
  check("处理后一栏显示模型改写结果", !!aiAfter, aiAfter.slice(0, 40));
  const modeNote = await dlgHum2.locator(".tt-changes").first().innerText().catch(() => "");
  check("AI 模式下列出处理方式说明", /AI 深度改写/.test(modeNote), modeNote.replace(/\n/g, " "));
  await dlgHum2.getByRole("button", { name: "取消" }).click();
  await sleep(300);

  /* 5.6 里点过「填充到新建内容」，写作台已自行关闭，这里不能再点关闭 */
  fakeModel.close();
  await clearOverlays(page);

  /* --- 6. 控制台 --- */
  const realErrors = logs.filter((l) => !/DevTools|favicon|Download the Vue/i.test(l));
  check("无控制台报错", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await browser.close();
  srv.kill();

  const failed = results.filter((r) => !r.ok);
  console.log("\n================ 汇总 ================");
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log("失败项：");
    failed.forEach((f) => console.log("  ✗ " + f.name + "  " + f.extra));
    process.exit(1);
  }
  console.log("全部通过");
})().catch((e) => {
  console.error("异常:", e);
  process.exit(1);
});
