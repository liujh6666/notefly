/* Electron 真机冒烟：桌面版下账号 API + 引擎账号解析正常 */
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const http = require("http");
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nf-elacct-"));
const PORT = 3295, CDP_PORT = 9335;
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
async function waitReady(retries = 60) {
  for (let i = 0; i < retries; i++) {
    const r = await req("/api/config");
    if (r) return true;
    await sleep(300);
  }
  return false;
}
(async () => {
  const electronBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const env = Object.assign({}, process.env, {
    NOTEFLY_PORT: String(PORT), NOTEFLY_CDP_PORT: String(CDP_PORT), NOTEFLY_DATA_DIR: TMP,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [ROOT], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  try {
    check("桌面版启动，服务就绪", await waitReady());
    const list = await req("/api/accounts");
    check("账号列表可访问", !!list && Array.isArray(list.accounts), JSON.stringify(list).slice(0, 120));
    const j = (list.accounts || []).find((a) => a.id === "juejin");
    check("默认账号来自适配器注册表", !!j && j.isDefault === true);
    check("默认账号分区是共享分区", !!j && j.partition === "persist:notefly", j && j.partition);
    const added = await req("/api/accounts", "POST", { platform: "juejin", alias: "桌面测试号" });
    check("桌面版可添加额外账号", added.ok === true && added.account && added.account.partition === "persist:acct-juejin-2", JSON.stringify(added).slice(0, 150));
    /* CDP 端口在监听（引擎接管通道就绪） */
    const cdp = await new Promise((resolve) => {
      const r = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on("error", () => resolve(false));
    });
    check("内置 CDP 端口就绪（RPA 接管通道）", cdp === true);
    /* 登录窗口 API：桌面版下额外账号应开独立窗口（真实窗口，这里只验证不炸） */
    const login = await req("/api/accounts/juejin-2/login", "POST");
    check("独立登录窗口 API 正常返回", !!login && login.ok === true, JSON.stringify(login).slice(0, 150));
    check("返回的是窗口模式", login && login.mode === "window", login && login.mode);
    const close = await req("/api/accounts/juejin-2/close-login", "POST");
    check("关闭登录窗口正常", !!close && close.ok === true);
    const del = await req("/api/accounts/juejin-2", "DELETE");
    check("删除账号（含清分区）正常", !!del && del.ok === true, JSON.stringify(del).slice(0, 120));
    check("桌面版进程无致命错误输出", !/Uncaught|Cannot read|TypeError/.test(stderr), stderr.slice(0, 200));
    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    try {
      if (process.platform === "win32") {
        const { execSync } = require("child_process");
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
      } else { child.kill(); }
    } catch {}
    await sleep(800);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(process.exitCode || 0);
  }
})();
