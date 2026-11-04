/*
 * 真实界面回归：验证「保存失败不再谎报成功」
 * 用真实浏览器打开界面，走完整交互：
 *   新建内容 → 保存成功 → 服务停掉后再保存 → 必须报错且留在编辑器、正文不丢 → 服务恢复后能再次保存成功
 * 运行：node scripts/ui-smoke.js
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-ui-"));
/* 1×1 PNG：封面上传回归用 */
fs.writeFileSync(path.join(TMP, "cover.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const PORT = 3299;
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
  /* 种一条“一成功一失败”的任务，稍后看界面是否如实显示“部分成功” */
  fs.writeFileSync(path.join(TMP, "store.json"), JSON.stringify({
    contents: [],
    tasks: [{
      id: "seed-1", groupId: "rpa-seed", contentId: null, title: "种子任务（一成功一失败）", type: "ARTICLE",
      accountIds: ["juejin", "zhihu"], mode: "publish", status: "partial", statusReason: "1 成功 / 1 失败",
      createdAt: new Date().toISOString(), engine: "rpa",
      lastStatus: { targets: [
        { platform: "juejin", accountId: "juejin", status: "success" },
        { platform: "zhihu", accountId: "zhihu", status: "failed", error: "发布按钮未找到" },
      ] },
      error: "zhihu: 发布按钮未找到", history: [],
    },
    {
      id: "seed-2", groupId: "rpa-seed-2", contentId: null, title: "种子任务（结果未知）", type: "ARTICLE",
      accountIds: ["juejin"], mode: "publish", status: "unknown", statusReason: "1 个平台结果待核验",
      createdAt: new Date().toISOString(), engine: "rpa",
      lastStatus: { targets: [
        { platform: "juejin", accountId: "juejin", status: "unknown", error: "提交后连接中断，结果未知" },
      ] },
      error: null, history: [],
    },
    {
      /* 未来定时任务：验证“到点唤醒”机制（修复前界面永远停在定时待发） */
      id: "seed-3", groupId: "rpa-seed-3", contentId: null, title: "种子任务（未来定时）", type: "ARTICLE",
      accountIds: ["juejin"], mode: "draft", status: "scheduled", statusReason: "定时待发",
      scheduledAt: new Date(Date.now() + 45000).toISOString(),
      createdAt: new Date().toISOString(), engine: "rpa",
      lastStatus: null, error: null, history: [],
    },
    ],
    accountMeta: {},
  }, null, 2));
  /* 引擎必须是 rpa：发布中心的账号来自平台注册表。
     kaState 带 checkedAt 才算有效登录检查结果：掘金/知乎/CSDN 已登录，微博未登录，头条待检查。
    judge: 2 = 当前登录判定规则版本，缺这个字段的旧结论会被自动作废（见 server.js LOGIN_JUDGE_VERSION） */
  fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({
    engine: "rpa",
    keepalive: { enabled: false, intervalHours: 4 },
    kaState: { details: [
      { id: "juejin", online: true, checkedAt: new Date(Date.now() - 5 * 60000).toISOString(), method: "dom", judge: 2 },
      { id: "zhihu", online: true, checkedAt: new Date(Date.now() - 5 * 60000).toISOString(), method: "dom", judge: 2 },
      { id: "csdn", online: true, checkedAt: new Date(Date.now() - 5 * 60000).toISOString(), method: "dom", judge: 2 },
      { id: "weibo", online: false, checkedAt: new Date(Date.now() - 5 * 60000).toISOString(), method: "dom", judge: 2 },
      { id: "toutiao", online: null, checkedAt: null, method: "", judge: 2 },
    ] },
  }));
  let srv = startServer();
  if (!(await waitReady())) throw new Error("服务未就绪");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  /* 只关心脚本错误；资源请求失败属预期环境噪声 */
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    pageErrors.push("[console] " + t);
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(800);

  /* 1. 界面渲染：Vue + Element Plus 正常挂载，菜单可见 */
  const menus = await page.locator(".sidebar .el-menu-item").count();
  check("界面渲染：左侧菜单挂载（10 项）", menus === 10, `实际 ${menus}`);
  /* 1.0 统计口径：未登录的平台占位不能算“已连接账号” */
  const dashText = await page.locator(".el-main").innerText().catch(() => "");
  check("统计卡片区分已登录与平台总数", /已登录账号/.test(dashText) && /个平台/.test(dashText), dashText.slice(0, 120).replace(/\s+/g, " "));
  check("无脚本错误", pageErrors.length === 0, pageErrors.join(" | "));

  /* 1.1 任务列表：一成功一失败必须显示“部分成功”，且能区分两个平台 */
  await page.locator(".sidebar .el-menu-item", { hasText: "发布记录" }).click();
  await sleep(500);
  const rowText = await page.locator(".el-table__body tr").first().innerText().catch(() => "");
  check("任务状态显示“部分成功”", /部分成功/.test(rowText) && !/已完成/.test(rowText), rowText.replace(/\s+/g, " "));
  check("平台标签区分已发布与失败", /已发布/.test(rowText) && /失败/.test(rowText), rowText.replace(/\s+/g, " "));

  /* 1.2 任务详情：失败平台有重试入口，错误原因可见 */
  await page.getByRole("button", { name: "详情" }).first().click();
  await sleep(600);
  const dlgText = await page.locator(".el-dialog").innerText().catch(() => "");
  check("详情显示失败原因", /发布按钮未找到/.test(dlgText), dlgText.replace(/\s+/g, " ").slice(0, 80));
  check("失败平台提供重试", /重试/.test(dlgText));
  await page.locator(".el-dialog__headerbtn").click().catch(() => {});
  await sleep(400);

  /* 1.3 unknown 目标：必须提供 打开平台 / 核验 / 确认已发布 / 登记失败 的继续处理入口 */
  const unknownRow = page.locator(".el-table__body tr", { hasText: "种子任务（结果未知）" });
  await unknownRow.getByRole("button", { name: "详情" }).click();
  await sleep(600);
  const unknownDlg = await page.locator(".el-dialog").innerText().catch(() => "");
  check("unknown 目标有核验入口", /打开平台/.test(unknownDlg) && /核验/.test(unknownDlg), unknownDlg.replace(/\s+/g, " ").slice(0, 120));
  check("unknown 目标有人工登记出口", /确认已发布/.test(unknownDlg) && /登记失败/.test(unknownDlg));
  check("unknown 不再显示“重试”按钮（与后端规则一致）", !/重试/.test(unknownDlg), unknownDlg.replace(/\s+/g, " ").slice(0, 160));

  /* 1.4 「打开平台」按平台 ID（juejin）解析地址，不能拿中文名去匹配 —— 修复前必然提示“未收录该平台首页地址” */
  const platCfg = await page.evaluate(() => (window.__nfDebug && window.__nfDebug.platforms || []).map((p) => p.id));
  check("平台清单按 ID 加载（至少含 juejin）", platCfg.includes("juejin"), JSON.stringify(platCfg));
  await page.getByRole("button", { name: /打开平台/ }).first().click();
  await sleep(400);
  const menuText = await page.locator(".el-dropdown-menu").first().innerText().catch(() => "");
  check("打开平台菜单区分创作后台与平台首页", /创作后台/.test(menuText) && /平台首页/.test(menuText), menuText.replace(/\s+/g, " "));
  await page.locator(".el-dropdown-menu__item", { hasText: "打开创作后台" }).first().click();
  await sleep(600);
  const afterOpenMsg = await page.locator(".el-message").last().innerText().catch(() => "");
  check("打开平台不再提示“未收录该平台首页地址”", !/未收录/.test(afterOpenMsg), afterOpenMsg);
  const browserVisible = await page.locator("#bWeb, .browser-panel, .b-shell").first().isVisible().catch(() => false);
  check("打开平台后进入内置浏览器视图", browserVisible === true || /内置浏览器/.test(await page.locator(".el-main").innerText().catch(() => "")));
  /* 先关掉详情弹窗：弹窗遮罩会拦截左侧菜单的点击 */
  await page.locator(".el-dialog__headerbtn").last().click().catch(() => {});
  await sleep(400);
  await page.locator(".sidebar .el-menu-item", { hasText: "发布记录" }).click();
  await sleep(400);
  await page.locator(".el-table__body tr", { hasText: "种子任务（结果未知）" }).getByRole("button", { name: "详情" }).click();
  await sleep(500);
  await page.locator(".el-dialog__headerbtn").last().click().catch(() => {});
  await sleep(300);

  /* 1.5 未来定时任务：到点必须能唤醒界面同步（修复前没有到点计时器） */
  const wakeInfo = await page.evaluate(() => {
    const d = window.__nfDebug;
    return { next: d ? d.nextScheduledAt() : null, count: d ? d.pollCount : -1, scheduled: d ? d.wakeScheduled : 0, list: (d ? d.tasks : []).map(t => t.id + ":" + t.status + ":" + t.scheduledAt) };
  });
  check("未来定时任务已排入到点唤醒", wakeInfo.next !== null && wakeInfo.scheduled > 0, JSON.stringify(wakeInfo));
  /* 把到点时间拉近，真实走一遍“到点 → 唤醒 → 同步”链路（不必等满 20 秒） */
  await page.evaluate(() => window.__nfDebug && window.__nfDebug.setScheduledSoon(1200));
  const before = wakeInfo.count;
  await sleep(4000);
  const after = await page.evaluate(() => (window.__nfDebug ? { count: window.__nfDebug.pollCount, fired: window.__nfDebug.wakeFired } : { count: -1, fired: -1 }));
  check("到点唤醒定时器已触发", after.fired > 0, JSON.stringify(after));
  check("到点后界面自动同步了一次（到点唤醒生效）", after.count > before, `pollCount ${before} → ${after.count}`);

  /* 2. 新建内容并保存成功 */
  await page.locator(".sidebar .el-menu-item", { hasText: "内容库" }).click();
  await sleep(300);
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(300);
  await page.locator(".ce-title input").fill("UI回归-标题");
  await page.locator(".ce-textarea").fill("# 小标题\n\n这是正文第一段。");
  check("编辑器占满内容区（左侧菜单仍可见）", (await page.locator(".sidebar .el-menu-item").count()) === 10);

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await sleep(900);
  const savedMsg = await page.locator(".el-message").first().innerText().catch(() => "");
  check("保存成功提示准确", /已保存/.test(savedMsg), savedMsg);
  const listAfterSave = await (await fetch(`${BASE}/api/contents`)).json();
  check("内容已落库", listAfterSave.contents.length === 1 && listAfterSave.contents[0].title === "UI回归-标题");
  check("点保存后不是草稿", listAfterSave.contents[0].draft !== true);

  /* 3. 关掉服务 → 再改再保存，必须失败且不离开编辑器 */
  srv.kill();
  await sleep(600);
  await page.getByRole("button", { name: /编辑/ }).first().click();
  await sleep(500);
  await page.locator(".ce-title input").fill("UI回归-断网时改的标题");
  await page.locator(".ce-textarea").fill("# 小标题\n\n断网时补写的正文，不能被清空。");
  pageErrors.length = 0;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await sleep(1500);

  const failMsg = await page.locator(".el-message").last().innerText().catch(() => "");
  check("保存失败提示明确（不是“已保存”）", /保存失败/.test(failMsg) && !/已保存/.test(failMsg), failMsg);
  check("失败后仍停留在编辑器", await page.locator(".ce-textarea").isVisible());
  const bodyKept = await page.locator(".ce-textarea").inputValue();
  check("失败后正文没有被清空", bodyKept.includes("断网时补写的正文"), bodyKept.slice(0, 40));
  const titleKept = await page.locator(".ce-title input").inputValue();
  check("失败后标题没有被清空", titleKept === "UI回归-断网时改的标题", titleKept);

  /* 4. 服务恢复 → 再点保存应成功，且是更新而不是新建 */
  srv = startServer();
  if (!(await waitReady())) throw new Error("服务重启失败");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await sleep(1200);
  const okMsg = await page.locator(".el-message").last().innerText().catch(() => "");
  check("服务恢复后保存成功", /已保存/.test(okMsg), okMsg);
  const afterRecover = await (await fetch(`${BASE}/api/contents`)).json();
  check("是更新而不是重复新建", afterRecover.contents.length === 1 && afterRecover.contents[0].title === "UI回归-断网时改的标题",
    `共 ${afterRecover.contents.length} 条`);

  /* 4.5 保存草稿：只落库并留在编辑器继续写，draft 标记落库、列表可见；封面必须跟着落库 */
  await page.getByRole("button", { name: "编辑" }).first().click();
  await sleep(500);
  await page.locator(".ce-title input").fill("UI回归-草稿标题");
  /* 封面输入框是编辑器里最后一个 image/* 文件输入 */
  await page.locator('input[type="file"][accept="image/*"]').last().setInputFiles(path.join(TMP, "cover.png"));
  await sleep(1500);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await sleep(900);
  const draftMsg = await page.locator(".el-message").last().innerText().catch(() => "");
  check("保存草稿提示准确", /草稿已保存/.test(draftMsg), draftMsg);
  check("保存草稿后仍留在编辑器", await page.locator(".ce-textarea").isVisible());
  const listDraft = await (await fetch(`${BASE}/api/contents`)).json();
  check("草稿标记已落库", listDraft.contents[0].title === "UI回归-草稿标题" && listDraft.contents[0].draft === true,
    JSON.stringify({ title: listDraft.contents[0].title, draft: listDraft.contents[0].draft }));
  check("封面以 Web 路径落库（/uploads/…）", /^\/uploads\//.test(listDraft.contents[0].cover || ""),
    JSON.stringify(listDraft.contents[0].cover));

  /* 4.5.1 取消 → 重新打开：封面必须还在（回归：过期列表副本把封面回填成空） */
  await page.getByRole("button", { name: "取消" }).click();
  await sleep(700);
  await page.getByRole("button", { name: "编辑" }).first().click();
  await sleep(700);
  const coverBack = await page.locator(".cover-preview").isVisible().catch(() => false);
  check("重新打开草稿后封面还在", coverBack, "");

  /* 4.5.2 素材库选封面：下拉「从素材库选择」→ 点图 → 封面回填 → 保存草稿 */
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.copyFileSync(path.join(TMP, "cover.png"), path.join(TMP, "uploads", "picker.png"));
  await page.locator(".ce-bottom .el-dropdown .el-button").last().click();
  await sleep(300);
  await page.locator(".el-dropdown-menu__item", { hasText: "从素材库选择" }).click();
  await sleep(500);
  check("素材库选图弹窗列出图片", (await page.locator(".cover-cell").count()) >= 1, "");
  await page.locator(".cover-cell").first().click();
  await sleep(500);
  check("选图后封面预览出现", await page.locator(".cover-preview").isVisible().catch(() => false), "");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await sleep(900);

  await page.getByRole("button", { name: "取消" }).click();
  await sleep(500);

  /* 4.6 账号管理：列表只显示登录成功的平台；登录账号弹窗列出全部平台 */
  await page.locator(".sidebar .el-menu-item", { hasText: "账号管理" }).click();
  await sleep(800);
  const acctText = await page.locator(".el-main").innerText().catch(() => "");
  check("账号列表只显示登录成功的平台（未登录的掘金外平台不出现）",
    /掘金/.test(acctText) && !/微博/.test(acctText) && !/头条号/.test(acctText), acctText.slice(0, 100));
  await page.getByRole("button", { name: "登录账号" }).click();
  await sleep(500);
  const pickerText = await page.locator(".login-grid").innerText().catch(() => "");
  check("登录弹窗列出全部平台（含未登录）", /掘金/.test(pickerText) && /微博/.test(pickerText) && /微信公众号/.test(pickerText));
  const cardCount = await page.locator(".login-card").count();
  check("登录弹窗平台数量与注册表一致", cardCount === (await (await fetch(`${BASE}/api/rpa/platforms`)).json()).platforms.length,
    `弹窗 ${cardCount}`);
  await page.getByRole("button", { name: "取消" }).click();
  await sleep(400);

  /* 5. 设置页：检查间隔下拉必须加载当前值；引擎切换控件必须存在 */
  await page.locator(".sidebar .el-menu-item", { hasText: "设置" }).click();
  await sleep(600);
  const setText = await page.locator(".el-main").innerText().catch(() => "");
  check("设置页有执行引擎控件且只剩 NoteFly RPA", /执行引擎/.test(setText) && /RPA（内置）/.test(setText) && !/MultiPost/.test(setText));
  check("设置页有数据存放位置选项", /数据存放位置/.test(setText) && /切换并迁移/.test(setText) && /恢复默认位置/.test(setText));
  check("设置页关于文案已去掉双引擎表述", /本地多平台内容分发工作台 · NoteFly · 数据全部存本机 data\/ 目录/.test(setText) && !/双引擎/.test(setText));
  check("设置页不再有署名编辑输入框", !/署名会用在公众号文章尾部签名区/.test(setText));
  /* 顶栏状态灯：RPA 绿灯 + AI 红灯/绿灯。服务刚重启过，灯靠 15s 周期健康检查自愈，最多等 20s */
  let topText = "";
  for (let i = 0; i < 20; i++) {
    topText = await page.locator(".topbar").innerText().catch(() => "");
    if (/NoteFly RPA 引擎就绪/.test(topText)) break;
    await sleep(1000);
  }
  check("顶栏 RPA 灯恢复绿灯（服务重启后自愈）", /NoteFly RPA 引擎就绪/.test(topText), JSON.stringify(topText));
  check("顶栏有 AI 状态灯（未接入=红）", /AI 未接入/.test(topText), JSON.stringify(topText));
  check("设置页不再宣称“草稿模式始终开启、绝不自动发布”", !/始终开启/.test(setText) && !/绝不自动/.test(setText));

  /* 6. 发布链路：断网 / HTTP 400 / 202 排队 三种响应的提示必须准确 */
  await page.locator(".sidebar .el-menu-item", { hasText: "发布中心" }).click();
  await sleep(500);
  /* 6.0 账号表只显示已登录平台（seed: juejin/zhihu/csdn 已登录；微博未登录、头条待检查不出现） */
  const pubAcctCard = page.locator(".el-card", { hasText: "选择账号" }).first();
  const pubAcctRows = await pubAcctCard.locator(".el-table__body tr").count();
  const pubAcctText = await pubAcctCard.innerText().catch(() => "");
  check("发布中心账号表只显示已登录平台（3 行）", pubAcctRows === 3, `行数 ${pubAcctRows}，文本 ${pubAcctText.slice(0, 60)}`);
  check("发布中心账号表不含未登录/待检查平台", !/微博/.test(pubAcctText) && !/头条号/.test(pubAcctText));
  await page.locator(".el-select").first().click();
  await sleep(300);
  await page.locator(".el-select-dropdown__item").first().click();
  await sleep(300);
  await page.locator(".el-table__body .el-checkbox").first().click();   // 勾选第一个平台
  await sleep(200);

  const pubBtn = () => page.getByRole("button", { name: "发布到草稿箱" });
  const lastMsg = async () => (await page.locator(".el-message").last().innerText().catch(() => ""));

  /* 6a. 断网：必须显示失败，绝不能出现“任务已创建 / 已加入定时队列” */
  await page.route("**/api/publish", (route) => route.abort());
  await pubBtn().click();
  await sleep(1200);
  let msg = await lastMsg();
  check("断网发布提示失败", /发布失败/.test(msg), msg);
  check("断网发布绝不提示任务已创建", !/任务已创建|已加入定时队列/.test(msg), msg);
  await page.unroute("**/api/publish");

  /* 6b. HTTP 400：显示服务端校验原因，不跳页 */
  await page.route("**/api/publish", (route) => route.fulfill({
    status: 400, contentType: "application/json",
    body: JSON.stringify({ error: "定时时间必须晚于当前时间" }),
  }));
  await pubBtn().click();
  await sleep(1200);
  msg = await lastMsg();
  check("HTTP 400 显示服务端原因", /定时时间必须晚于当前时间/.test(msg), msg);
  check("HTTP 400 不提示成功", !/任务已创建|已加入定时队列|已存入/.test(msg), msg);
  await page.unroute("**/api/publish");

  /* 6c. 202 + queued：提示“已创建排队执行”，跳到发布记录且能看到排队任务 */
  /* 先停掉轮询：轮询会用服务端列表整体替换本地状态，把下面 mock 出来的任务冲掉 */
  await page.evaluate(() => window.__nfDebug && window.__nfDebug.stopPoll());
  await page.route("**/api/publish", (route) => route.fulfill({
    status: 202, contentType: "application/json",
    body: JSON.stringify({
      error: null, taskStatus: "queued", taskStatusReason: "已进入执行队列，正在等待执行",
      task: {
        id: "ui-queued-1", groupId: null, contentId: null, title: "UI回归-排队任务", type: "ARTICLE",
        accountIds: ["juejin"], mode: "draft", status: "queued", statusReason: "已进入执行队列，正在等待执行",
        engine: "rpa", createdAt: new Date().toISOString(), scheduledAt: null, lastStatus: null, error: null, history: [],
      },
    }),
  }));
  await pubBtn().click();
  await sleep(1200);
  msg = await lastMsg();
  check("202 排队任务提示准确", /任务已创建，正在排队执行/.test(msg), msg);
  const queuedRow = page.locator(".el-table__body tr", { hasText: "UI回归-排队任务" });
  check("发布记录能看到排队中的任务", (await queuedRow.count()) > 0 && /排队执行/.test((await queuedRow.first().innerText().catch(() => ""))));
  await page.unroute("**/api/publish");

  /* 7. 内置浏览器：快捷方式只列已登录平台 + 新建页面入口 */
  await page.locator(".sidebar .el-menu-item", { hasText: "内置浏览器" }).click();
  await sleep(600);
  const bLinksText = await page.locator(".b-links").innerText().catch(() => "");
  check("内置浏览器有新建页面入口", /新建页面/.test(bLinksText), bLinksText.slice(0, 80));
  check("内置浏览器快捷方式只列已登录平台", /掘金/.test(bLinksText) && /知乎/.test(bLinksText) && !/微博/.test(bLinksText) && !/头条号/.test(bLinksText),
    bLinksText.replace(/\s+/g, " ").slice(0, 80));

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
