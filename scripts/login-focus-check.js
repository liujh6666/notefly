/* Electron 真机检查：独立登录窗口打开后，webContents 必须持有键盘焦点
   （修复前：show:false 创建 + win.show()/focus() 只给窗口焦点，
     页面没有自动 focus 输入框时物理键盘打不了字） */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const http = require("http");
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nf-loginfocus-"));
const PORT = 3297, CDP_PORT = 9337;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}
function req(p, m, b) {
  return new Promise((resolve) => {
    const data = b ? JSON.stringify(b) : null;
    const r = http.request(BASE + p, { method: m || "GET", headers: { "Content-Type": "application/json" } }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { try { resolve(JSON.parse(t)); } catch { resolve({ raw: t.slice(0, 100) }); } });
    });
    r.on("error", () => resolve(null));
    if (data) r.write(data);
    r.end();
  });
}
async function waitReady(retries = 80) {
  for (let i = 0; i < retries; i++) {
    const r = await req("/api/config");
    if (r) return true;
    await sleep(500);
  }
  return false;
}
(async () => {
  const electronBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const env = Object.assign({}, process.env, {
    NOTEFLY_PORT: String(PORT), NOTEFLY_CDP_PORT: String(CDP_PORT), NOTEFLY_DATA_DIR: TMP, NOTEFLY_TEST_MULTI: "1",
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [ROOT], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    const ready = await waitReady();
    if (!ready) throw new Error("桌面版服务 18s 内未就绪");
    check("桌面版启动，服务就绪", true);
    const added = await req("/api/accounts", "POST", { platform: "juejin", alias: "焦点测试号" });
    check("添加额外账号", added.ok === true, JSON.stringify(added).slice(0, 120));
    const login = await req("/api/accounts/juejin-2/login", "POST");
    check("独立登录窗口已打开", !!login && login.ok === true && login.mode === "window", JSON.stringify(login).slice(0, 150));
    await sleep(2500);

    /* 关键断言：登录页 document.hasFocus() === true（物理键盘可用前提）。
       焦点可能被终端抢占，重试几轮，任一次 true 即算过 */
    const { chromium } = require("playwright");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    let page = null, hasFocus = false, detail = "";
    for (let i = 0; i < 8 && !hasFocus; i++) {
      page = ctx.pages().find((p) => /juejin\.cn/.test(p.url())) || null;
      if (!page) { await sleep(1000); continue; }
      const r = await page.evaluate(() => ({
        hasFocus: document.hasFocus(),
        active: (document.activeElement && document.activeElement.tagName) || "",
      })).catch((e) => ({ err: String(e.message || e).slice(0, 100) }));
      if (r.err) { detail = r.err; } else { hasFocus = !!r.hasFocus; detail = `hasFocus=${r.hasFocus} active=${r.active}`; }
      if (!hasFocus) await sleep(1200);
    }
    check("登录窗口页面持有键盘焦点（document.hasFocus）", hasFocus, detail);
    await browser.close().catch(() => {});
  } finally {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: true });
    setTimeout(() => process.exit(failures ? 1 : 0), 1500);
  }
})();
