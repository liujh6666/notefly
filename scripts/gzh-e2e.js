/*
 * 公众号排版端到端回归
 * ------------------------------------------------------------
 * 覆盖两种新建模式、模板选择、渲染预览、切换模板、复制与导出：
 *   1. 内容库「＋ 新建内容」主按钮 → 普通文章（行为与原来一致）
 *   2. 下拉菜单 → 微信公众号文章 → 模板选择器 → 进编辑器
 *   3. 编辑器出现公众号排版栏，预览渲染出内联样式 HTML
 *   4. 切换模板 → 预览随之变化
 *   5. 渲染产物合规（无禁用标签、文字都在 span leaf 内）
 *   6. 保存后内容库能查到该篇且带模板标识
 *   7. 复制到公众号 / 导出 HTML 按钮可用
 *
 * 运行：node scripts/gzh-e2e.js
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-gzh-"));
const PORT = 3301;
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

async function waitReady(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

const SAMPLE = `# 用 NoteFly 写公众号文章

> 排版不是装饰，是让读者在三秒内决定要不要读完。

## 为什么需要模板

同一份 Markdown，在不同平台上需要不同的视觉语言。公众号读者在手机上阅读，字号、留白、章节层级都要更克制。

## 模板带来什么

- 章节自动编号
- 关键词自动加下划线
- 代码块一键换色

## 写在最后

排版工具的价值，是让你把时间花在内容上。`;

(async () => {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  const srv = startServer();
  if (!(await waitReady())) {
    console.log("FAIL  服务未能启动");
    process.exit(1);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".sidebar .el-menu-item");

  /* ---------- 0. 全站扫一遍控制台报错（模板变量写错这类问题只有渲染时才暴露） ---------- */
  /* 排除网络噪声：外部请求失败与本次改动无关，不能算作界面缺陷。 */
  const isEngineNoise = (t) => /502|Bad Gateway|Failed to fetch|net::ERR/i.test(t);
  for (const name of ["工作台", "内容库", "素材库", "发布中心", "发布记录", "发布日历", "数据看板", "账号管理", "设置"]) {
    await page.locator(".sidebar .el-menu-item", { hasText: name }).first().click();
    await sleep(500);
  }
  const realErrors = consoleErrors.filter((t) => !isEngineNoise(t));
  check("全站无控制台报错", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
  consoleErrors.length = 0;

  /* ---------- 1. 模板清单接口 ---------- */
  const tpl = await (await fetch(`${BASE}/api/gzh/templates`)).json();
  check("模板清单返回 7 套主题", (tpl.templates || []).length === 7, `实际 ${(tpl.templates || []).length}`);
  check("模板清单带名称与配色", !!(tpl.templates || []).every((t) => t.name && t.swatch && t.swatch.length === 3));

  /* ---------- 2. 普通文章路径：主按钮行为不变 ---------- */
  await page.locator(".sidebar .el-menu-item").filter({ hasText: /^内容库$/ }).click();
  await sleep(400);
  await page.getByRole("button", { name: /新建内容/ }).click();
  await sleep(500);
  check("主按钮直接进普通文章编辑器", await page.locator(".ce-title input").isVisible());
  check("普通文章不显示公众号排版栏", (await page.locator(".ce-gzh").count()) === 0);

  await page.locator(".ce-title input").fill("普通文章-回归");
  await page.locator(".ce-textarea").fill("## 普通章节\n\n这是一篇普通文章，走的是原来的路径。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await sleep(900);
  const list1 = await (await fetch(`${BASE}/api/contents`)).json();
  const normal = list1.contents.find((c) => c.title === "普通文章-回归");
  check("普通文章保存成功", !!normal);
  check("普通文章不带模板标识", normal ? !normal.gzhTheme : false, JSON.stringify(normal && normal.gzhTheme));

  /* ---------- 3. 公众号文章路径：下拉 → 模板选择 ---------- */
  await page.locator(".sidebar .el-menu-item").filter({ hasText: /^内容库$/ }).click();
  await sleep(400);
  /* 点下拉箭头（不是主按钮） */
  await page.locator(".el-dropdown__caret-button").first().click();
  await sleep(500);
  const menuVisible = await page.locator(".el-dropdown-menu").first().isVisible();
  check("下拉菜单展开", menuVisible);
  await page.locator(".el-dropdown-menu__item", { hasText: "微信公众号文章" }).first().click();
  await sleep(700);
  check("模板选择器弹出", await page.locator(".gzh-grid").isVisible());
  const cardCount = await page.locator(".gzh-card").count();
  check("模板选择器列出 7 张卡片", cardCount === 7, `实际 ${cardCount}`);

  /* 选第二套主题（红白色系），验证不是写死第一套 */
  await page.locator(".gzh-card").nth(1).click();
  await sleep(250);
  await page.getByRole("button", { name: /用这个模板开始写/ }).click();
  await sleep(1200);
  check("选模板后进入编辑器", await page.locator(".ce-title input").isVisible());
  check("编辑器显示公众号排版栏", await page.locator(".ce-gzh").isVisible());

  /* ---------- 4. 渲染预览 ---------- */
  await page.locator(".ce-title input").fill("公众号文章-回归");
  await page.locator(".ce-textarea").fill(SAMPLE);
  await sleep(1800);
  const gzhHtml = await page.locator(".gzh-preview").innerHTML().catch(() => "");
  check("公众号预览渲染出内容", gzhHtml.length > 500, `长度 ${gzhHtml.length}`);
  check("预览含内联样式章节标题", /font-weight:\s*900/.test(gzhHtml));
  check("预览文字被 span leaf 包裹", /<span leaf="">/.test(gzhHtml));
  check("预览无禁用标签", !/<div|<style|class=/i.test(gzhHtml));

  /* 服务端渲染结果与预览一致 */
  const rendered = await (await fetch(`${BASE}/api/gzh/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: SAMPLE, themeId: "red-white", title: "公众号文章-回归", authorName: "爱吃桔子" }),
  })).json();
  check("服务端渲染合规（0 ERROR）", rendered.valid === true && rendered.errors.length === 0, JSON.stringify(rendered.errors));
  check("服务端渲染有章节数", rendered.sectionCount >= 3, String(rendered.sectionCount));
  check("渲染产物无禁用标签", !/<div|<style|class=|position:\s*(fixed|absolute)/i.test(rendered.html));

  /* ---------- 5. 切换模板 → 预览变化 ---------- */
  const before = gzhHtml.length;
  await page.locator(".ce-gzh .el-select").click();
  await sleep(400);
  await page.locator(".el-select-dropdown__item", { hasText: "石墨极简风" }).first().click();
  await sleep(1500);
  const gzhHtml2 = await page.locator(".gzh-preview").innerHTML().catch(() => "");
  check("切换模板后预览重新渲染", gzhHtml2.length > 500 && gzhHtml2 !== gzhHtml, `长度 ${gzhHtml2.length} / 原 ${before}`);
  check("新模板用上石墨色 #52525B", /#52525B/i.test(gzhHtml2));

  /* ---------- 6. 保存并核对落库 ---------- */
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await sleep(1000);
  const list2 = await (await fetch(`${BASE}/api/contents`)).json();
  const wechat = list2.contents.find((c) => c.title === "公众号文章-回归");
  check("公众号文章保存成功", !!wechat);
  check("保存后带模板标识", wechat ? wechat.gzhTheme === "graphite-minimal" : false, JSON.stringify(wechat && wechat.gzhTheme));
  check("公众号文章仍是 ARTICLE 类型（不影响发布）", wechat ? wechat.type === "ARTICLE" : false, wechat && wechat.type);

  /* ---------- 7. 列表显示形态 ---------- */
  await page.locator(".sidebar .el-menu-item").filter({ hasText: /^内容库$/ }).click();
  await sleep(600);
  const rowText = await page.locator(".el-table__body").innerText();
  check("列表显示公众号形态标签", /石墨极简风/.test(rowText), rowText.slice(0, 200));

  /* ---------- 8. 复制 / 导出按钮存在 ---------- */
  await page.locator(".el-table__body .el-button", { hasText: "编辑" }).first().click();
  await sleep(1500);
  check("复制到公众号按钮存在", (await page.getByRole("button", { name: /复制到公众号/ }).count()) > 0);
  check("导出 HTML 按钮存在", (await page.getByRole("button", { name: /导出 HTML/ }).count()) > 0);

  /* ---------- 9. 页面无 JS 报错 ---------- */
  check("页面无 JS 运行时错误", pageErrors.length === 0, pageErrors.join(" | "));
  const realErr2 = consoleErrors.filter((t) => !isEngineNoise(t));
  check("公众号流程无控制台报错", realErr2.length === 0, realErr2.slice(0, 3).join(" | "));

  await page.screenshot({ path: path.join(ROOT, "_shots-tmp-gzh", "gzh-editor.png"), fullPage: false }).catch(() => {});
  await browser.close();
  srv.kill();
  console.log(`\n${failures === 0 ? "全部通过" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
