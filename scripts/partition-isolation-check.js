/* 分区隔离真机验证：两个账号的页面之间 cookie 互不可见 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const http = require("http");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nf-iso-"));
const PORT = 3293, CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
(async () => {
  const electronBin = path.join(ROOT, "node_modules", ".bin", "electron.cmd");
  const env = Object.assign({}, process.env, { NOTEFLY_PORT: String(PORT), NOTEFLY_CDP_PORT: String(CDP_PORT), NOTEFLY_DATA_DIR: TMP });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [ROOT], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], shell: true });
  for (let i = 0; i < 60; i++) { if (await req("/api/config")) break; await sleep(300); }
  await sleep(1000);
  await req("/api/accounts", "POST", { platform: "juejin", alias: "A" });
  await req("/api/accounts", "POST", { platform: "juejin", alias: "B" });
  /* 打开两个独立分区窗口（登录窗口可见，测试无所谓） */
  await req("/api/accounts/juejin-2/login", "POST");
  await req("/api/accounts/juejin-3/login", "POST");
  await sleep(3000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages().filter((p) => p.url().includes("juejin.cn"));
  console.log("juejin pages:", pages.length);
  if (pages.length < 2) { console.log("FAIL 页面不足"); process.exit(1); }
  const [pa, pb] = pages;
  /* A 里种 cookie */
  await pa.evaluate(() => { document.cookie = "nfprobe=accountA; path=/"; });
  await sleep(500);
  const inA = await pa.evaluate(() => document.cookie);
  const inB = await pb.evaluate(() => document.cookie);
  console.log("A cookies:", inA);
  console.log("B cookies:", inB);
  console.log(inA.includes("nfprobe=accountA") && !inB.includes("nfprobe") ? "PASS 分区隔离生效：A 的 cookie 在 B 里不可见" : "FAIL 会话串了！");
  /* 反向再验一次 */
  await pb.evaluate(() => { document.cookie = "nfprobe2=accountB; path=/"; });
  await sleep(500);
  const inA2 = await pa.evaluate(() => document.cookie);
  console.log(inA2.includes("nfprobe2") ? "FAIL 反向也串了" : "PASS 反向隔离同样生效");
  await browser.close().catch(() => {});
  try { require("child_process").execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})();
