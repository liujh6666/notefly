/*
 * 回归用例 8：AI 客户端与服务端路由
 * 覆盖：
 *   - 地址归一、Key 掩码、HTTP 状态 → 中文原因
 *   - 对接一个本地假 OpenAI 服务：正常返回、401、500、非 JSON、超时
 *   - HTTP 路由层：配置读写（Key 不回传明文）、未配置时的拒绝、文本工具接口
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ai = require("../lib/ai");
const prompts = require("../lib/ai-prompts");

/* ==================== 地址与掩码 ==================== */

test("地址归一：补版本号、去尾斜杠", () => {
  assert.equal(ai.normalizeBaseUrl("https://api.deepseek.com"), "https://api.deepseek.com/v1");
  assert.equal(ai.normalizeBaseUrl("https://api.deepseek.com/"), "https://api.deepseek.com/v1");
  assert.equal(ai.normalizeBaseUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1");
  assert.equal(ai.normalizeBaseUrl("https://x.cn/compatible-mode/v1"), "https://x.cn/compatible-mode/v1");
  assert.equal(ai.normalizeBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
});

test("地址归一：非法或空地址返回空串", () => {
  assert.equal(ai.normalizeBaseUrl(""), "");
  assert.equal(ai.normalizeBaseUrl(null), "");
  assert.equal(ai.normalizeBaseUrl("ftp://x.com"), "");
  assert.equal(ai.normalizeBaseUrl("不是地址"), "");
});

test("Key 掩码：不泄露明文", () => {
  assert.equal(ai.maskKey(""), "");
  assert.equal(ai.maskKey("short"), "sh***");
  const m = ai.maskKey("sk-abcdefghijklmnop");
  assert.ok(!m.includes("abcdefghijkl"));
  assert.ok(m.includes("***"));
});

test("本地地址判定（本地模型可免 Key）", () => {
  assert.equal(ai.isLocalBase("http://127.0.0.1:11434/v1"), true);
  assert.equal(ai.isLocalBase("http://localhost:1234/v1"), true);
  assert.equal(ai.isLocalBase("https://api.deepseek.com/v1"), false);
});

test("HTTP 状态 → 可读中文原因", () => {
  assert.match(ai.explainStatus(401), /API Key/);
  assert.match(ai.explainStatus(403), /API Key/);
  assert.match(ai.explainStatus(404), /404/);
  assert.match(ai.explainStatus(429), /额度|频繁/);
  assert.match(ai.explainStatus(500), /模型服务/);
});

/* ==================== 对接假模型服务 ==================== */

/* 起一个假的 OpenAI 兼容服务，按用例切换行为 */
function startFakeModel(mode) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (mode === "401") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid api key" } }));
          return;
        }
        if (mode === "500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "boom" } }));
          return;
        }
        if (mode === "notjson") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html>not json</html>");
          return;
        }
        if (mode === "empty") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
          return;
        }
        if (mode === "hang") {
          return; /* 故意不响应，触发客户端超时 */
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "fake-model",
            usage: { total_tokens: 42 },
            choices: [{ message: { role: "assistant", content: "这是模型返回的内容" } }],
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("模型调用：正常返回内容", async () => {
  const { server, port } = await startFakeModel("ok");
  try {
    const r = await ai.chat(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "fake-model" },
      { messages: [{ role: "user", content: "hi" }] }
    );
    assert.equal(r.ok, true);
    assert.equal(r.content, "这是模型返回的内容");
    assert.equal(r.usage.total_tokens, 42);
  } finally {
    server.close();
  }
});

test("模型调用：Key 错误返回可读原因，不抛异常", async () => {
  const { server, port } = await startFakeModel("401");
  try {
    const r = await ai.chat(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "bad", model: "fake-model" },
      { messages: [{ role: "user", content: "hi" }] }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /API Key/);
  } finally {
    server.close();
  }
});

test("模型调用：上游 5xx 也要给可读原因", async () => {
  const { server, port } = await startFakeModel("500");
  try {
    const r = await ai.chat(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "fake-model" },
      { messages: [{ role: "user", content: "hi" }] }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /模型服务/);
  } finally {
    server.close();
  }
});

test("模型调用：返回不是 JSON 时明确报错", async () => {
  const { server, port } = await startFakeModel("notjson");
  try {
    const r = await ai.chat(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "fake-model" },
      { messages: [{ role: "user", content: "hi" }] }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /不是 JSON/);
  } finally {
    server.close();
  }
});

test("模型调用：内容为空时报错，不返回空串当成功", async () => {
  const { server, port } = await startFakeModel("empty");
  try {
    const r = await ai.chat(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "fake-model" },
      { messages: [{ role: "user", content: "hi" }] }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /没有返回内容/);
  } finally {
    server.close();
  }
});

test("模型调用：超时按超时报，不假装失败在别处", async () => {
  const { server, port } = await startFakeModel("hang");
  try {
    const r = await ai.chat(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "fake-model" },
      { messages: [{ role: "user", content: "hi" }], timeoutMs: 600 }
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /超时/);
  } finally {
    server.close();
    server.closeAllConnections && server.closeAllConnections();
  }
});

test("模型调用：没配地址 / 没配模型 / 没内容，都要提前拒绝", async () => {
  assert.equal((await ai.chat({}, { messages: [{ role: "user", content: "x" }] })).ok, false);
  assert.match((await ai.chat({}, { messages: [{ role: "user", content: "x" }] })).error, /服务地址/);
  assert.match(
    (await ai.chat({ baseUrl: "http://x/v1" }, { messages: [{ role: "user", content: "x" }] })).error,
    /模型/
  );
  assert.match(
    (await ai.chat({ baseUrl: "http://x/v1", model: "m" }, { messages: [] })).error,
    /没有可发送/
  );
});

test("JSON 模式：剥掉围栏并解析", async () => {
  const { server, port } = await startFakeModel("ok");
  try {
    const r = await ai.chatJson(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "fake-model" },
      { messages: [{ role: "user", content: "hi" }] }
    );
    /* 假服务返回的是纯文本，不是 JSON —— 必须如实报解析失败，不能吞掉 */
    assert.equal(r.ok, false);
    assert.match(r.error, /不是合法 JSON/);
  } finally {
    server.close();
  }
});

/* ==================== 提示词 ==================== */

test("提示词：写作必须带主题且带反套话约束", () => {
  const msgs = prompts.buildWrite({ topic: "Vue3 性能", style: "tech", words: 800 });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /赋能/);
  assert.match(msgs[0].content, /总而言之/);
  assert.match(msgs[1].content, /Vue3 性能/);
  assert.match(msgs[1].content, /800/);
});

test("提示词：去 AI 味要求保留事实、不许总结段", () => {
  const msgs = prompts.buildDeai({ text: "原文", strength: "strong" });
  assert.match(msgs[0].content, /一个都不能丢/);
  assert.match(msgs[0].content, /不要 emoji/);
  assert.match(msgs[0].content, /强/);
});

test("提示词：起标题与打标签只输出列表", () => {
  const t = prompts.buildRewrite({ text: "x", action: "title" });
  assert.match(t[0].content, /只输出标题列表/);
  const g = prompts.buildRewrite({ text: "x", action: "tags" });
  assert.match(g[0].content, /只输出标签列表/);
});

/* ==================== HTTP 路由层 ==================== */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-ai-test-"));
process.env.NOTEFLY_DATA_DIR = TMP;
process.env.NOTEFLY_NO_LISTEN = "1";
process.env.NOTEFLY_DISABLE_SCHEDULER = "1";
process.env.NOTEFLY_DISABLE_RESTORE = "1";
fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "config.json"),
  JSON.stringify({ baseUrl: "http://127.0.0.1:9", token: "", engine: "rpa" })
);

const server = require("../server");
let base = "";
let httpServer = null;

test.before(async () => {
  httpServer = server.app.listen(0);
  await new Promise((r) => httpServer.once("listening", r));
  base = `http://127.0.0.1:${httpServer.address().port}/api`;
});

test.after(() => {
  try {
    if (httpServer) httpServer.close();
  } catch {}
});

test("路由：GET /ai/config 初始状态未就绪，且不带明文 Key", async () => {
  const r = await (await fetch(base + "/ai/config")).json();
  assert.equal(r.ok, true);
  assert.equal(r.ready, false);
  assert.equal(r.hasKey, false);
  assert.ok(Array.isArray(r.presets) && r.presets.length > 0);
  assert.ok(Array.isArray(r.styles) && r.styles.length > 0);
});

test("路由：POST /ai/config 保存后 Key 只回掩码", async () => {
  const r = await (
    await fetch(base + "/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-secret-1234567890", model: "deepseek-chat", preset: "deepseek" }),
    })
  ).json();
  assert.equal(r.ok, true);
  assert.equal(r.ready, true);
  assert.equal(r.hasKey, true);
  assert.ok(!r.keyMasked.includes("1234567890"));

  const cfg = await (await fetch(base + "/ai/config")).json();
  assert.ok(!JSON.stringify(cfg).includes("sk-secret-1234567890"), "响应里绝不能出现明文 Key");
  assert.equal(cfg.baseUrl, "https://api.deepseek.com/v1");
});

test("路由：非法地址被拒绝", async () => {
  const res = await fetch(base + "/ai/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "不是地址" }),
  });
  assert.equal(res.status, 400);
  const r = await res.json();
  assert.match(r.error, /http/);
});

test("路由：/ai/run 未配置模型时明确拒绝", async () => {
  const saved = { ...server.config.ai };
  server.config.ai = { ...saved, baseUrl: "", model: "" };
  const res = await fetch(base + "/ai/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "write", topic: "x" }),
  });
  assert.equal(res.status, 400);
  const r = await res.json();
  assert.match(r.error, /AI 模型/);
  server.config.ai = saved;
});

test("路由：/text/format 与 /text/humanize 不经过模型也能用", async () => {
  const f = await (
    await fetch(base + "/text/format", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "#标题\n\n* a\n" }),
    })
  ).json();
  assert.equal(f.ok, true);
  assert.match(f.text, /^# 标题$/m);
  assert.ok(Array.isArray(f.changes));

  const h = await (
    await fetch(base + "/text/humanize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "首先，值得注意的是这很重要。" }),
    })
  ).json();
  assert.equal(h.ok, true);
  assert.ok(!h.text.includes("值得注意的是"));

  const a = await (
    await fetch(base + "/text/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "首先，值得注意的是这很重要。" }),
    })
  ).json();
  assert.equal(a.ok, true);
  assert.ok(a.score >= 0);
});

test("路由：文本接口缺参数时返回 400", async () => {
  const res = await fetch(base + "/text/format", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /text/);
});

/* ==================== /ai/run 的 action 分发回归 ==================== */
/* 回归背景：前端曾把 aiForm.action（润色子动作，默认 "polish"）整包发回，
   覆盖了按 tab 算出的顶层 action，导致 AI 写作台所有请求都报「未知的操作类型：polish」。
   服务端侧的对应修复：子动作改走 subAction 字段，dispatch 只认 action。 */

/* 可录制请求体的假模型：记下最近一次 /chat/completions 的 body */
function startRecordingModel(reply = "好的") {
  return new Promise((resolve) => {
    const state = { lastBody: null };
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        state.lastBody = JSON.parse(raw || "{}");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model: "fake-model",
          usage: { total_tokens: 1 },
          choices: [{ message: { role: "assistant", content: reply } }],
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }));
  });
}

test("路由：rewrite 的子动作走 subAction，不再被顶层 action 混淆", async () => {
  const fake = await startRecordingModel();
  const fakeBase = `http://127.0.0.1:${fake.port}/v1`;
  try {
    await fetch(base + "/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: fakeBase, apiKey: "k", model: "fake-model" }),
    });
    const run = (payload) => fetch(base + "/ai/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    /* 精简子动作：system 提示词必须带「精简」指令 */
    let r = await (await run({ action: "rewrite", subAction: "shorten", text: "这段话有点长。" })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(/篇幅压到约一半/.test(fake.state.lastBody.messages[0].content), "system 应包含精简指令");

    /* 不带 subAction 时回落到润色 */
    r = await (await run({ action: "rewrite", text: "随意一段。" })).json();
    assert.equal(r.ok, true);
    assert.ok(/更准确、更顺/.test(fake.state.lastBody.messages[0].content), "默认子动作应为润色");

    /* write 分发不受任何残留 action 字段影响 */
    r = await (await run({ action: "write", topic: "测试主题" })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!/润色|篇幅压到约一半/.test(fake.state.lastBody.messages[0].content), "write 不应复用改写提示词");
  } finally {
    fake.server.close();
  }
});

test("路由：/ai/config 下发润色子动作清单（前端下拉数据源）", async () => {
  const r = await (await fetch(base + "/ai/config")).json();
  assert.ok(Array.isArray(r.rewriteActions) && r.rewriteActions.length >= 9, "应包含全部子动作");
  const ids = r.rewriteActions.map((a) => a.id);
  for (const id of ["polish", "shorten", "expand", "title", "digest"]) {
    assert.ok(ids.includes(id), "缺少子动作：" + id);
  }
  assert.ok(r.rewriteActions.every((a) => a.id && a.name), "每项必须有 id 与展示名");
});

/* ==================== AI 标题 + 填充新建内容 ==================== */
/* 需求：「写文章」可勾选 AI 标题，生成文章时一起出标题；标题由服务端拆出来单独回传，
   前端据此分别填入新建内容的标题与正文。 */

test("提示词：勾选 AI 标题时要标题行，取消时明确不要标题", () => {
  const on = prompts.buildWrite({ topic: "x", withTitle: true });
  assert.match(on[0].content, /标题单独占第一行/);
  assert.match(on[1].content, /# 标题/);

  const off = prompts.buildWrite({ topic: "x", withTitle: false });
  assert.match(off[0].content, /不要输出标题/);
  assert.ok(!/标题单独占第一行/.test(off[0].content), "取消勾选时不能还要求标题行");

  /* 不传 withTitle 保持老行为（要标题） */
  const dft = prompts.buildWrite({ topic: "x" });
  assert.match(dft[0].content, /标题单独占第一行/);
});

test("路由：write 把首行「# 标题」拆成 title，正文不含标题行", async () => {
  const fake = await startRecordingModel("# 我生成的标题\n\n这是正文第一段。\n\n这是第二段。");
  try {
    await fetch(base + "/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "k", model: "fake-model" }),
    });
    const r = await (
      await fetch(base + "/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", topic: "t", withTitle: true }),
      })
    ).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.title, "我生成的标题");
    assert.equal(r.content, "这是正文第一段。\n\n这是第二段。");
    assert.ok(!r.content.startsWith("#"), "正文里不应残留标题行");
  } finally {
    fake.server.close();
  }
});

test("路由：write 没有标题行时 title 为空、正文原样", async () => {
  const fake = await startRecordingModel("直接就是正文。");
  try {
    await fetch(base + "/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "k", model: "fake-model" }),
    });
    const r = await (
      await fetch(base + "/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", topic: "t", withTitle: false }),
      })
    ).json();
    assert.equal(r.title, "");
    assert.equal(r.content, "直接就是正文。");
  } finally {
    fake.server.close();
  }
});

test("路由：text/marks 给任意两段文本算标记（AI 深度改写后重算）", async () => {
  const r = await (
    await fetch(base + "/text/marks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ before: "当底层能力不再是稀缺资源", after: "当基础能力不再是稀缺资源" }),
    })
  ).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.beforeHtml, /<mark class="tt-hit">底层<\/mark>/);
  assert.match(r.afterHtml, /<mark class="tt-fix">基础<\/mark>/);
  assert.equal(r.skipped, false);

  const bad = await fetch(base + "/text/marks", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ before: 1 }),
  });
  assert.equal(bad.status, 400);
});

/* ==================== 接入判定 / 申请 Key / 断开 AI ==================== */

test("接入判定：云端服务没 Key 不算接入，本地与免 Key 服务算", () => {
  const deepseek = { preset: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
  assert.equal(ai.isConnected(Object.assign({}, deepseek, { apiKey: "" })), false);
  assert.equal(ai.isConnected(Object.assign({}, deepseek, { apiKey: "sk-x" })), true);
  /* 地址或模型缺一不可 */
  assert.equal(ai.isConnected({ preset: "deepseek", baseUrl: "", model: "m", apiKey: "sk-x" }), false);
  assert.equal(ai.isConnected({ preset: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "", apiKey: "sk-x" }), false);
  /* 本地模型免 Key */
  assert.equal(ai.isConnected({ preset: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", apiKey: "" }), true);
  /* 填了云端地址但走本地端口，免 Key 判定仍成立 */
  assert.equal(ai.isConnected({ preset: "deepseek", baseUrl: "http://127.0.0.1:8080/v1", model: "m", apiKey: "" }), true);
});

test("预置服务：每个云厂商都有 Key 申请页，本地与自定义免申请", () => {
  const withUrl = ai.PRESETS.filter((p) => p.keyUrl);
  assert.ok(withUrl.length >= 6, "至少 6 个云厂商要有申请页");
  for (const p of withUrl) assert.ok(p.keyUrl.startsWith("https://"), p.id + " 的申请页必须是 https");
  assert.match(ai.presetById("deepseek").keyUrl, /platform\.deepseek\.com/);
  assert.match(ai.presetById("moonshot").keyUrl, /moonshot\.cn/);
  assert.match(ai.presetById("zhipu").keyUrl, /bigmodel\.cn/);
  assert.match(ai.presetById("siliconflow").keyUrl, /siliconflow\.cn/);
  assert.match(ai.presetById("qwen").keyUrl, /aliyun\.com/);
  assert.match(ai.presetById("openai").keyUrl, /openai\.com/);
  assert.equal(ai.presetById("ollama").keyUrl, "");
  assert.equal(ai.presetById("custom").keyUrl, "");
  assert.equal(ai.keyRequired("ollama"), false);
  assert.equal(ai.keyRequired("deepseek"), true);
});

test("路由：/ai/config 下发 connected 与预置申请页", async () => {
  await fetch(base + "/ai/disconnect", { method: "POST" });   /* 清掉前面用例留下的配置 */
  const r = await (await fetch(base + "/ai/config")).json();
  assert.equal(r.ok, true);
  assert.equal(r.connected, false, "没配地址模型时不算接入");
  const deepseek = r.presets.find((p) => p.id === "deepseek");
  assert.ok(deepseek.keyUrl.startsWith("https://"));
  assert.equal(deepseek.keyRequired, true);
});

test("路由：配了地址模型但没 Key → 配置齐全但未接入；断开后回到未接入", async () => {
  await fetch(base + "/ai/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clearKey: true }),
  });
  const save = await (
    await fetch(base + "/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", preset: "deepseek" }),
    })
  ).json();
  assert.equal(save.ready, true, "地址与模型齐了");
  assert.equal(save.connected, false, "但没有 Key，不能算接入");

  await fetch(base + "/ai/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-secret-1234567890" }),
  });
  const on = await (await fetch(base + "/ai/config")).json();
  assert.equal(on.connected, true, "Key 到位才算接入");
  assert.equal(on.hasKey, true);

  const off = await (await fetch(base + "/ai/disconnect", { method: "POST" })).json();
  assert.equal(off.ok, true);
  assert.equal(off.connected, false);
  assert.equal(off.hasKey, false);
  assert.equal(off.keyMasked, "", "断开后掩码也不能留");

  const after = await (await fetch(base + "/ai/config")).json();
  assert.equal(after.connected, false);
  assert.equal(after.ready, false, "地址与模型也被清掉");
  assert.equal(after.hasKey, false);
  assert.equal(after.preset, "deepseek", "服务预设保留，方便一键回填");
});
