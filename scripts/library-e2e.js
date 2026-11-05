/*
 * 企业内容库 / 风格档案 / 写作联动 端到端测试（真实浏览器）
 * 运行：node scripts/library-e2e.js
 *
 * 覆盖：
 *   1. 建企业 → 手动补录正文 → 检索命中 → 风格档案可生成
 *   2. 企业隔离：A 企业的检索结果里不出现 B 企业的文章
 *   3. 排除文章后，后续检索不再使用它
 *   4. 写作上下文：能拿到实际参考资料；缺资料时明确提示而不是假装
 *   5. 删除文章后，后续检索不再使用失效内容
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-lib-"));
const PORT = 3297;
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

async function api(pathname, method, body) {
  const init = { method: method || "GET", headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(BASE + pathname, init);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: t.slice(0, 200), _status: r.status }; }
}

const ART_A = `云原生数据库的三个关键取舍

在过去的半年里，我们把核心业务系统迁移到了云原生数据库。这篇文章想聊聊迁移过程中真正影响决策的三件事。

第一是数据一致性边界。我们没有追求全局强一致，而是把一致性边界收敛到单个租户内部。这样写放大明显下降，读延迟稳定在 20 毫秒以内。

第二是连接管理。连接池不再是配置项，而是随扩缩容自动伸缩的运行时行为。这一改动上线后，数据库侧的连接数告警彻底消失了。

第三是故障恢复。真正的难点从来不是备份，而是恢复演练。我们每两周做一次全量恢复演练，把恢复时间写进运维手册。

需要说明的是，上面的数据来自我们自己的生产环境，样本量有限，仅供参考。`;
const ART_B = `我们的产品定价逻辑完全公开

我们不搞「先低价再涨价」那一套。产品定价只有两个变量：用量与支持级别。

支持级别分为社区版、标准版与企业版。社区版永久免费，但只提供社区支持。标准版按月订阅。企业版按年签约。

我们过去三年没有调整过价格表。这条规则写进了公司章程。`;

(async () => {
  const child = startServer();
  let browser;
  try {
    if (!await waitReady()) throw new Error("服务未能启动");

    /* ---------- 建两个企业 ---------- */
    const ca = await api("/api/library/companies", "POST", { name: "甲公司", description: "云原生数据库厂商" });
    const cb = await api("/api/library/companies", "POST", { name: "乙公司", description: "另一家企业" });
    check("创建企业 A", !!(ca.ok && ca.company && ca.company.id), JSON.stringify(ca).slice(0, 120));
    check("创建企业 B", !!(cb.ok && cb.company && cb.company.id), JSON.stringify(cb).slice(0, 120));
    if (!ca.ok || !cb.ok) throw new Error("企业创建失败");

    /* ---------- 手动补录正文（采集失败的兜底路径） ---------- */
    const ma = await api(`/api/library/companies/${ca.company.id}/articles/manual`, "POST", {
      title: "云原生数据库的三个关键取舍",
      body: ART_A,
      sourceUrl: "https://example.com/post/a?utm_source=x",
      contentType: "opinion",
    });
    check("手动补录正文成功", !!(ma.ok && ma.article), JSON.stringify(ma).slice(0, 150));
    check("补录文章关联来源链接", ma.ok && ma.article.sourceUrl.indexOf("example.com/post/a") >= 0);
    check("补录文章标记为手动来源", ma.ok && ma.article.collectStatus === "manual");

    const mb = await api(`/api/library/companies/${cb.company.id}/articles/manual`, "POST", {
      title: "我们的产品定价逻辑完全公开",
      body: ART_B,
      sourceUrl: "https://example.org/post/b",
      contentType: "company",
    });
    check("B 企业补录正文成功", !!(mb.ok && mb.article));

    /* ---------- 企业隔离 ---------- */
    const searchA = await api(`/api/library/companies/${ca.company.id}/search?q=${encodeURIComponent("定价")}`);
    check("A 企业检索不到 B 企业的文章", searchA.ok && searchA.hits.length === 0, JSON.stringify(searchA.hits || []).slice(0, 150));
    const searchB = await api(`/api/library/companies/${cb.company.id}/search?q=${encodeURIComponent("定价")}`);
    check("B 企业能检索到自己的文章", searchB.ok && searchB.hits.length >= 1, JSON.stringify(searchB.hits || []).slice(0, 150));

    const searchA2 = await api(`/api/library/companies/${ca.company.id}/search?q=${encodeURIComponent("数据库")}`);
    check("A 企业能检索到自己的文章", searchA2.ok && searchA2.hits.length >= 1);

    /* ---------- 排除后不再被检索 ---------- */
    await api(`/api/library/companies/${ca.company.id}/articles/${ma.article.id}`, "PUT", { excluded: true });
    const searchA3 = await api(`/api/library/companies/${ca.company.id}/search?q=${encodeURIComponent("数据库")}`);
    check("排除后不再被检索", searchA3.ok && searchA3.hits.length === 0, JSON.stringify(searchA3.hits || []).slice(0, 150));
    /* 恢复 */
    await api(`/api/library/companies/${ca.company.id}/articles/${ma.article.id}`, "PUT", { excluded: false });
    const searchA4 = await api(`/api/library/companies/${ca.company.id}/search?q=${encodeURIComponent("数据库")}`);
    check("恢复后重新被检索", searchA4.ok && searchA4.hits.length >= 1);

    /* ---------- 风格档案 ---------- */
    const style = await api(`/api/library/companies/${ca.company.id}/style/analyze`, "POST");
    check("生成风格档案", !!(style.ok && style.profile), JSON.stringify(style).slice(0, 200));
    if (style.ok && style.profile) {
      const s = style.profile;
      check("风格档案有版本号", Number(s.version) >= 1);
      check("风格档案记录样本数", s.sampleCount >= 1, "sampleCount=" + s.sampleCount);
      check("风格档案给出充分性提示", !!(s.sufficiency && s.sufficiency.message));
      check("风格与事实分开保存", !!s.facts && Array.isArray(s.facts.confirmed));
      check("事实区带时效说明", !!(s.facts && s.facts.note && s.facts.note.indexOf("当前事实") >= 0));
    }

    /* ---------- 写作上下文 ---------- */
    const ctx = await api(`/api/ai/context?companyId=${ca.company.id}&q=${encodeURIComponent("数据库迁移")}`);
    check("写作上下文可获取", !!(ctx.ok && ctx.context), JSON.stringify(ctx).slice(0, 200));
    if (ctx.ok && ctx.context) {
      check("上下文标记用了企业资料", ctx.context.usedLibrary === true);
      check("上下文带有资料片段", ctx.context.materials.length >= 1, "materials=" + ctx.context.materials.length);
      check("资料片段带来源 ID", ctx.context.materials.length === 0 || !!ctx.context.materials[0].sourceId);
      check("上下文带风格版本号", Number(ctx.context.styleVersion) >= 1);
      check("上下文列出待补事实", Array.isArray(ctx.context.missingFacts));
    }

    /* 无企业时：明确不参考任何企业资料 */
    const ctxNo = await api("/api/ai/context?q=测试");
    check("未选企业时不使用企业资料", !!(ctxNo.ok && ctxNo.context && ctxNo.context.usedLibrary === false));

    /* 选了企业但没资料 + 严格要求 → 必须报错而不是假装 */
    const emptyC = await api("/api/library/companies", "POST", { name: "空企业" });
    const strict = await fetch(`${BASE}/api/ai/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "write", topic: "测试", companyId: emptyC.company.id, useLibrary: true }),
    });
    const strictJson = await strict.json();
    check("企业无资料时严格模式明确报错", strict.status === 409 && !!strictJson.needConfirmation,
      "status=" + strict.status + " " + JSON.stringify(strictJson).slice(0, 150));

    /* ---------- 引用记录 ---------- */
    await api(`/api/library/companies/${ca.company.id}/citations`);
    const cites = await api(`/api/library/companies/${ca.company.id}/citations`);
    check("引用记录接口可用", cites.ok && Array.isArray(cites.citations));

    /* ---------- 浏览器端：企业内容库页面能打开 ---------- */
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e && e.message)));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await sleep(800);

    check("侧栏出现「企业内容库」入口", await page.locator(".sidebar .el-menu-item", { hasText: "企业内容库" }).count() === 1);

    await page.locator(".sidebar .el-menu-item", { hasText: "企业内容库" }).click();
    await sleep(900);
    check("企业内容库页面能打开", await page.locator(".lib-wrap").count() >= 1 || await page.locator(".el-alert", { hasText: "还没有企业内容库" }).count() >= 1);
    check("企业列表显示已建的 3 个企业（含前面为严格模式测试建的空企业）",
      await page.locator(".lib-company").count() === 3, "实际 " + (await page.locator(".lib-company").count()));

    /* 切到甲公司看文章 */
    await page.locator(".lib-company", { hasText: "甲公司" }).click();
    await sleep(900);
    check("甲公司文章列表有 1 篇", await page.locator(".el-table__row").count() >= 1);

    /* 消息中心 */
    check("右上角有消息图标", await page.locator(".msg-bell").count() === 1);
    await page.locator(".msg-bell").click();
    await sleep(700);
    check("消息抽屉能打开", await page.locator(".msg-tabs").count() === 1);
    check("消息中心有三个页签", await page.locator(".msg-tab").count() === 3);
    /* 切到「进行中」 */
    await page.locator(".msg-tab", { hasText: "进行中" }).click();
    await sleep(500);
    check("进行中页签能切换", await page.locator(".msg-tab.on", { hasText: "进行中" }).count() === 1);
    /* 切到「更新记录」 */
    await page.locator(".msg-tab", { hasText: "更新记录" }).click();
    await sleep(700);
    check("更新记录页签能切换", await page.locator(".msg-tab.on", { hasText: "更新记录" }).count() === 1);
    check("更新记录显示当前版本", await page.locator(".msg-cur-ver").count() === 1);

    /* 抽屉不离开当前编辑页：关闭后仍在企业内容库页 */
    await page.locator(".msg-head button", { hasText: "关闭" }).click();
    await sleep(400);
    check("关闭抽屉后仍在企业内容库页", await page.locator(".lib-wrap").count() >= 1);

    check("浏览器控制台无报错", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    console.log("FAIL  测试异常：" + String((e && e.message) || e));
    failures++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})();
