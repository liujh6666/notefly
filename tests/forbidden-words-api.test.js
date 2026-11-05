/* 违禁词库管理 API：列出 / 全量保存 / 恢复默认 + 清洗规则 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-fw-"));
process.env.NOTEFLY_DATA_DIR = TMP;
process.env.NOTEFLY_NO_LISTEN = "1";
process.env.NOTEFLY_DISABLE_SCHEDULER = "1";
process.env.NOTEFLY_DISABLE_RESTORE = "1";

fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({}));

const server = require("../server");

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request("http://127.0.0.1" + ":" + httpPort + p, {
      method, headers: { "Content-Type": "application/json" },
    }, (res) => {
      let t = ""; res.on("data", (c) => (t += c));
      res.on("end", () => { try { resolve({ code: res.statusCode, json: JSON.parse(t) }); } catch (e) { reject(e); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
let httpPort;
test.before(async () => {
  const s = server.app.listen(0);
  await new Promise((r) => s.once("listening", r));
  httpPort = s.address().port;
});

test("词库缺失时 GET 自动初始化默认词库", async () => {
  const res = await req("GET", "/api/forbidden-words");
  assert.equal(res.code, 200);
  assert.ok(Array.isArray(res.json.words) && res.json.words.length > 10, "默认词库应有 30+ 词");
  assert.equal(res.json.status, "checked");
  assert.ok(fs.existsSync(path.join(TMP, "forbidden-words.txt")), "词库文件已落盘");
});

test("PUT 全量保存：去空、trim、去重", async () => {
  const res = await req("PUT", "/api/forbidden-words", { words: ["  秒杀 ", "最佳", "", null, "秒杀", "x".repeat(80), "全网最低"] });
  assert.equal(res.code, 200);
  assert.equal(res.json.count, 3, "去空/去重/超长剔除后剩 3 个");
  const onDisk = fs.readFileSync(path.join(TMP, "forbidden-words.txt"), "utf8");
  assert.deepEqual(onDisk.split("\n").filter(Boolean), ["秒杀", "最佳", "全网最低"]);
});

test("PUT 非数组被拒", async () => {
  const res = await req("PUT", "/api/forbidden-words", { words: "秒杀" });
  assert.equal(res.code, 400);
});

test("GET 返回保存后的词库", async () => {
  const res = await req("GET", "/api/forbidden-words");
  assert.deepEqual(res.json.words, ["秒杀", "最佳", "全网最低"]);
});

test("POST reset 恢复默认词库", async () => {
  const res = await req("POST", "/api/forbidden-words/reset");
  assert.equal(res.code, 200);
  assert.equal(res.json.ok, true);
  const back = await req("GET", "/api/forbidden-words");
  assert.ok(back.json.words.length > 10, "恢复后回到默认词量");
  assert.ok(back.json.words.includes("国家级"));
});

test("PUT 空数组允许（清空词库=关闭检测）", async () => {
  const res = await req("PUT", "/api/forbidden-words", { words: [] });
  assert.equal(res.code, 200);
  const back = await req("GET", "/api/forbidden-words");
  assert.deepEqual(back.json.words, []);
});

test.after(() => {
  setTimeout(() => process.exit(0), 30).unref();
});
