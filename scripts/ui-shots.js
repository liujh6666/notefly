/*
 * 视觉自检：多主题 × 多宽度截图，并采集控制台错误/警告、横向溢出
 * 运行：node scripts/ui-shots.js
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-shots-"));
const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 侧边栏菜单项顺序（与 public/index.html 一致），按序号点击：
   窄屏下菜单文字会隐藏成图标栏，用序号比用文案更稳 */
const PAGES = [
  ["dashboard", "工作台"],
  ["contents", "内容库"],
  ["media", "素材库"],
  ["publish", "发布中心"],
  ["tasks", "发布记录"],
  ["calendar", "发布日历"],
  ["metrics", "数据看板"],
  ["accounts", "账号管理"],
  ["settings", "设置"],
];

const now = Date.now();
const iso = (m) => new Date(now - m * 60000).toISOString();

/* 种一份贴近真实使用的数据，避免截图全是空状态、看不出版式问题 */
function seed() {
  fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, "config.json"),
    JSON.stringify({
      baseUrl: "http://127.0.0.1:19528",
      token: "",
      engine: "rpa",
      keepalive: { enabled: true, intervalHours: 4 },
      kaState: {
        lastRun: iso(30),
        lastOnline: 4,
        lastTotal: 10,
        nextRun: iso(-180),
        details: [
          { id: "juejin", online: true, checkedAt: iso(30), method: "cookie", judge: 2 },
          { id: "zhihu", online: true, checkedAt: iso(30), method: "cookie", judge: 2 },
          { id: "weibo", online: false, checkedAt: iso(30), method: "cookie", judge: 2 },
          { id: "csdn", online: true, checkedAt: iso(30), method: "cookie", judge: 2 },
          { id: "toutiao", online: null, checkedAt: null, method: "", judge: 2 },
        ],
      },
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(TMP, "store.json"),
    JSON.stringify({
      contents: [
        { id: "c1", type: "ARTICLE", title: "从 0 到 1 搭建一个内容分发流水线", body: "这是正文示例，用于验证内容库的字数列、标题单元格与操作区排版。".repeat(4), cover: "", images: [], tags: ["技术", "长文"], createdAt: iso(180) },
        { id: "c2", type: "ARTICLE", title: "AI 协作写作的 7 条实用准则", body: "正文示例。".repeat(12), cover: "", images: [], tags: ["AI"], createdAt: iso(420) },
        { id: "c3", type: "VIDEO", title: "产品演示录屏 · v1.1 版本", body: "", cover: "", images: [], video: "demo.mp4", tags: ["产品"], createdAt: iso(900) },
        { id: "c4", type: "ARTICLE", title: "周更第 12 期：这周踩过的坑", body: "正文示例。".repeat(8), cover: "", images: [], tags: ["周更"], createdAt: iso(1500) },
      ],
      accountMeta: {
        juejin: { alias: "掘金·主号", group: "技术号" },
        zhihu: { alias: "知乎专栏", group: "技术号" },
        csdn: { alias: "CSDN·程序员", group: "技术号" },
        toutiao: { alias: "头条号", group: "媒体号" },
      },
      tasks: [
        {
          id: "t1", groupId: "g1", contentId: "c1", title: "从 0 到 1 搭建一个内容分发流水线", type: "ARTICLE",
          accountIds: ["juejin", "zhihu"], mode: "publish", status: "partial", statusReason: "1 成功 / 1 失败",
          createdAt: iso(40), engine: "rpa", error: "zhihu: 发布按钮未找到",
          lastStatus: { targets: [
            { platform: "juejin", accountId: "juejin", status: "success" },
            { platform: "zhihu", accountId: "zhihu", status: "failed", error: "发布按钮未找到" },
          ] }, history: [],
        },
        {
          id: "t2", groupId: "g2", contentId: "c2", title: "AI 协作写作的 7 条实用准则", type: "ARTICLE",
          accountIds: ["csdn", "toutiao"], mode: "draft", status: "draft_ready", statusReason: "草稿已就绪，等待人工确认",
          createdAt: iso(120), engine: "rpa", error: "",
          lastStatus: { targets: [
            { platform: "csdn", accountId: "csdn", status: "ready" },
            { platform: "toutiao", accountId: "toutiao", status: "ready" },
          ] }, history: [],
        },
        {
          id: "t3", groupId: "g3", contentId: "c3", title: "产品演示录屏 · v1.1 版本", type: "VIDEO",
          accountIds: ["weibo"], mode: "publish", status: "unknown", statusReason: "1 个平台结果待核验",
          createdAt: iso(200), engine: "rpa", error: "",
          lastStatus: { targets: [{ platform: "weibo", accountId: "weibo", status: "unknown", error: "提交后连接中断" }] },
          history: [],
        },
        {
          id: "t4", groupId: "g4", contentId: "c4", title: "周更第 12 期：这周踩过的坑", type: "ARTICLE",
          accountIds: ["juejin"], mode: "publish", status: "done", statusReason: "全部平台已确认发布",
          createdAt: iso(300), engine: "rpa", error: "",
          lastStatus: { targets: [{ platform: "juejin", accountId: "juejin", status: "success" }] }, history: [],
        },
        {
          id: "t5", groupId: "g5", contentId: null, title: "定时任务：明日早报", type: "ARTICLE",
          accountIds: ["zhihu"], mode: "publish", status: "scheduled", statusReason: "定时待发",
          scheduledAt: iso(-600), createdAt: iso(60), engine: "rpa", error: "",
          lastStatus: { targets: [] }, history: [],
        },
      ],
    }, null, 2)
  );

  /* 素材库放几张图，便于检查素材卡与操作区 */
  fs.writeFileSync(path.join(TMP, "uploads", "cover-demo.png"), Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082", "hex"));
  fs.writeFileSync(path.join(TMP, "uploads", "cover-2.png"), Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082", "hex"));
  fs.writeFileSync(path.join(TMP, "uploads", "screenshot-01.png"), Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000000000000000d49484452000000010000000108060000001f15c4890000000a49444154" +
    "789c63000100000500010d0a2db40000000049454e44ae426082", "hex"));
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
  child.stdout.on("data", () => {});
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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  seed();

  const server = startServer();
  if (!(await waitReady())) {
    console.log("服务未就绪");
    server.kill();
    process.exit(1);
  }

  const browser = await chromium.launch();
  const issues = [];

  const VIEWPORTS = [
    { name: "1440", width: 1440, height: 900 },
    { name: "1280", width: 1280, height: 860 },
    { name: "1024", width: 1024, height: 720 },
    { name: "768", width: 768, height: 1024 },
    { name: "375", width: 375, height: 812 },
  ];

  for (const dark of [false, true]) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        colorScheme: dark ? "dark" : "light",
      });
      const page = await ctx.newPage();
      const logs = [];
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`);
      });
      page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
      page.on("response", (r) => {
        if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
      });

      await page.addInitScript((d) => {
        localStorage.setItem("nf-dark", d ? "1" : "0");
      }, dark);

      await page.goto(BASE, { waitUntil: "networkidle" });
      await sleep(900);

      const theme = dark ? "dark" : "light";
      const overflowByPage = {};
      for (let pi = 0; pi < PAGES.length; pi++) {
        const [pageKey, label] = PAGES[pi];
        /* 按文案定位，不能用索引：侧栏有 10 项，索引与 PAGES 顺序对不齐 */
        const item = page.locator(".sidebar li.el-menu-item", { hasText: label });
        const cnt = await item.count();
        if (cnt) {
          await item.first().click({ timeout: 5000 }).catch(() => {});
        } else {
          issues.push(`${theme}/${vp.name} 找不到菜单项「${label}」`);
        }
        await sleep(600);
        /* 关掉浮层提示，避免遮挡顶栏与内容（提示本身在 ui-smoke 里另有断言） */
        await page.evaluate(() => {
          document.querySelectorAll(".el-message, .el-notification").forEach((n) => n.remove());
        });
        const file = path.join(OUT, `${theme}-${vp.name}-${pageKey}.png`);
        await page.screenshot({ path: file, fullPage: false });

        const ov = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const bad = [];
          /* 被祖先裁剪（overflow hidden/auto/scroll）的内容不算页面级溢出：
             Element Plus 表格头就是这样——表体横向滚动，表头被裁剪同步 */
          const inScrollable = (el) => {
            let p = el.parentElement;
            while (p && p !== document.body) {
              const s = getComputedStyle(p);
              if (s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden") return true;
              p = p.parentElement;
            }
            return false;
          };
          document.querySelectorAll("body *").forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            if (r.right > vw + 2 || r.left < -2) {
              if (inScrollable(el)) return;
              const cls = typeof el.className === "string" ? el.className : "";
              const sel = el.tagName.toLowerCase() + (cls ? "." + cls.split(" ").filter(Boolean).slice(0, 2).join(".") : "");
              const txt = (el.textContent || "").trim().slice(0, 16);
              if (bad.length < 8) bad.push(`${sel} «${txt}» [${Math.round(r.left)}..${Math.round(r.right)}] vw=${vw}`);
            }
          });
          return {
            hasHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
            bad,
          };
        });
        if (ov.bad.length || ov.hasHScroll) overflowByPage[pageKey] = ov;
      }

      const overflow = { hasHScroll: false, bad: [] };
      Object.entries(overflowByPage).forEach(([k, v]) => {
        if (v.hasHScroll) overflow.hasHScroll = true;
        v.bad.forEach((b) => overflow.bad.push(`[${k}] ${b}`));
      });

      if (overflow.hasHScroll) issues.push(`${theme}/${vp.name} 出现页面级横向滚动`);
      if (overflow.bad.length) issues.push(`${theme}/${vp.name} 元素越界：\n    - ${overflow.bad.join("\n    - ")}`);
      const realLogs = [...new Set(logs)].filter((l) => !/favicon/.test(l));
      if (realLogs.length) issues.push(`${theme}/${vp.name} 控制台：\n    - ${realLogs.join("\n    - ")}`);

      console.log(`✓ ${theme} / ${vp.name}px 完成`);
      await ctx.close();
    }
  }

  await browser.close();
  server.kill();

  console.log("\n===== 自检结论 =====");
  if (!issues.length) console.log("未发现横向溢出 / 控制台报错");
  else issues.forEach((i) => console.log("• " + i));
  console.log("\n截图目录：" + OUT);
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(issues, null, 2));
})();
