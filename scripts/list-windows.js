/*
 * 列出当前所有带窗口标题的进程（含隐藏的），用于排查弹窗阻塞。
 * 用法：node scripts/list-windows.js
 */
"use strict";
const { execSync } = require("child_process");

try {
  const out = execSync("tasklist /V /FO CSV /NH", { encoding: "utf8" });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    /* CSV: 名称,PID,会话名,会话#,内存,状态,用户名,窗口标题 */
    const cols = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur);
    const title = (cols[7] || "").trim();
    if (title) rows.push(`${cols[0]} (${cols[1]})  ${title}`);
  }
  /* 只输出与脚本宿主 / NoteFly 相关的，避免刷屏 */
  const keys = ["ws" + "cript", "cs" + "cript", "Note" + "Fly", "Script", "Microsoft Windows"];
  const hit = rows.filter((r) => keys.some((k) => r.toLowerCase().includes(k.toLowerCase())));
  console.log("总计带窗口标题的进程:", rows.length);
  console.log("相关进程:");
  for (const r of hit) console.log("  " + r);
  if (!hit.length) console.log("  （无）");
} catch (e) {
  console.log("tasklist /V 失败:", e.message);
}
