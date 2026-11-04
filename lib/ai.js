/*
 * LLM 客户端（OpenAI 兼容协议）
 * ------------------------------------------------------------
 * 为什么不用某一家的 SDK：各家 SDK 协议不一，用户手上的 key 也各不相同。
 * OpenAI 兼容协议是事实标准 —— DeepSeek、通义千问、Kimi、智谱、
 * 硅基流动、OpenAI 官方、本地 Ollama / LM Studio 全都支持同一套
 * /v1/chat/completions，换模型只改配置不改代码。
 *
 * 安全约定：
 *  1. API Key 只存在 data/config.json，绝不回传到前端（只给掩码）；
 *  2. 所有出网请求由服务端发起，前端拿不到 key；
 *  3. 失败必须给出可读中文原因，不允许把 401 之类直接甩给用户；
 *  4. 不做自动重试 —— 重试等于重复计费，且可能重复生成。
 */
"use strict";

/* ==================== 预置服务 ==================== */
/* keyUrl  = 申请 / 管理 API Key 的官网（前端「申请 Key」按钮按预设跳转）
   keyRequired = 该服务是否必须填 Key（本地 Ollama 与自定义服务可免） */
const PRESETS = [
  { id: "deepseek", name: "DeepSeek 深度求索", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"], keyRequired: true, keyUrl: "https://platform.deepseek.com/api_keys", keyNote: "开放平台「API keys」页创建，密钥只在创建时显示一次" },
  { id: "qwen", name: "阿里通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-plus", "qwen-turbo", "qwen-max"], keyRequired: true, keyUrl: "https://bailian.console.aliyun.com/?apiKey=1", keyNote: "阿里云百炼控制台「API Key」页创建（sk- 开头）" },
  { id: "moonshot", name: "Kimi 月之暗面", baseUrl: "https://api.moonshot.cn/v1", models: ["moonshot-v1-32k", "moonshot-v1-8k"], keyRequired: true, keyUrl: "https://platform.moonshot.cn/console/api-keys", keyNote: "开放平台「API 密钥」页创建，需要大陆手机号注册" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-flash", "glm-4-plus"], keyRequired: true, keyUrl: "https://open.bigmodel.cn/usercenter/apikeys", keyNote: "用户中心「API Keys」页创建" },
  { id: "siliconflow", name: "硅基流动 SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", models: ["Qwen/Qwen2.5-7B-Instruct"], keyRequired: true, keyUrl: "https://cloud.siliconflow.cn/account/ak", keyNote: "控制台「API 密钥」页新建" },
  { id: "openai", name: "OpenAI 官方", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini", "gpt-4o"], keyRequired: true, keyUrl: "https://platform.openai.com/api-keys", keyNote: "Platform 后台「API keys」页创建" },
  { id: "ollama", name: "本地 Ollama（免 Key）", baseUrl: "http://127.0.0.1:11434/v1", models: ["qwen2.5:7b", "llama3.1:8b"], keyRequired: false, keyUrl: "", keyNote: "本机运行模型，不需要 API Key" },
  { id: "custom", name: "自定义（OpenAI 兼容）", baseUrl: "", models: [], keyRequired: false, keyUrl: "", keyNote: "自建或第三方服务，按对方要求填写" },
];

/* ==================== 基础工具 ==================== */

/** 地址归一：去掉尾部斜杠；没带版本号就补 /v1 */
function normalizeBaseUrl(url) {
  let s = String(url == null ? "" : url).trim();
  if (!s) return "";
  s = s.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) return "";
  /* 已经写了具体路径或版本号就不动 */
  if (/\/v\d+$/i.test(s)) return s;
  if (/\/chat\/completions$/i.test(s)) return s;
  return s + "/v1";
}

/** key 掩码：前端只能看到掩码 */
function maskKey(key) {
  const s = String(key == null ? "" : key);
  if (!s) return "";
  if (s.length <= 8) return s.slice(0, 2) + "***";
  return s.slice(0, 6) + "***" + s.slice(-4);
}

/** 是否为本地地址（本地模型一般不需要 Key） */
function isLocalBase(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(String(url || ""));
}

/** 取预置配置 */
function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** 该服务是否必须填 Key（本地 Ollama 与自定义服务可免） */
function keyRequired(presetId) {
  const p = presetById(presetId);
  return p ? p.keyRequired !== false : true;
}

/**
 * 是否「真正接入」：地址与模型都齐了，且该服务要的 Key 已经拿到。
 * 注意与「配置齐全」区分：填了地址和模型但没 Key，云端服务是调不通的，
 * 这时必须按未接入处理（AI 相关按钮置灰），不能让用户以为已经能用。
 */
function isConnected(cfg) {
  const c = cfg || {};
  if (!normalizeBaseUrl(c.baseUrl) || !c.model) return false;
  if (!keyRequired(c.preset)) return true;      // 免 Key 的服务（本地模型 / 自建代理）
  return !!c.apiKey || isLocalBase(c.baseUrl);
}

/** HTTP 状态 → 可读中文原因 */
function explainStatus(status, rawBody) {
  const detail = String(rawBody || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  if (status === 401 || status === 403) return "API Key 无效，或该 Key 没有这个模型的权限";
  if (status === 404) return "接口地址或模型名不对（404）";
  if (status === 429) return "请求过于频繁或额度已用尽（429）";
  if (status === 400) return "请求被模型服务拒绝（400）：" + detail;
  if (status >= 500) return "模型服务自身出错（HTTP " + status + "）" + (detail ? "：" + detail : "");
  return "模型服务返回 HTTP " + status + (detail ? "：" + detail : "");
}

/* ==================== 核心调用 ==================== */

/**
 * 发起一次对话补全
 * @param {{baseUrl:string, apiKey?:string, model:string}} cfg
 * @param {{messages:Array, temperature?:number, maxTokens?:number, timeoutMs?:number}} req
 * @returns {Promise<{ok:boolean, content?:string, error?:string, usage?:object, raw?:object}>}
 */
async function chat(cfg, req) {
  const c = cfg || {};
  const r = req || {};
  const base = normalizeBaseUrl(c.baseUrl);
  if (!base) return { ok: false, error: "没有配置模型服务地址，请到「设置 → AI 模型」填写" };

  const model = String(c.model || "").trim();
  if (!model) return { ok: false, error: "没有选择模型，请到「设置 → AI 模型」选择或填写模型名" };

  const messages = Array.isArray(r.messages) ? r.messages : [];
  if (!messages.length) return { ok: false, error: "没有可发送的内容" };

  /* 用户若直接填了完整 endpoint（…/chat/completions），不能重复拼接（审查 P2） */
  const url = /\/chat\/completions$/i.test(base) ? base : base + "/chat/completions";
  const limit = Number(r.timeoutMs) > 0 ? Number(r.timeoutMs) : 180000;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, limit);
  }

  const payload = {
    model,
    messages,
    stream: false,
  };
  if (Number(r.temperature) >= 0) payload.temperature = Number(r.temperature);
  if (Number(r.maxTokens) > 0) payload.max_tokens = Number(r.maxTokens);

  const headers = { "Content-Type": "application/json" };
  if (c.apiKey) headers.Authorization = "Bearer " + c.apiKey;

  let res;
  let text = "";
  try {
    if (typeof fetch !== "function") throw new Error("当前 Node 运行时没有 fetch");
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    text = await res.text();
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    return {
      ok: false,
      error: aborted
        ? "模型响应超时（" + Math.round(limit / 1000) + " 秒未返回）。内容较长时可以调大超时或换更快的模型"
        : "连不上模型服务，请检查服务地址、网络与代理设置：" + String((e && e.message) || e),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!res.ok) {
    const msg =
      body && body.error && body.error.message
        ? String(body.error.message)
        : body && body.message
          ? String(body.message)
          : text;
    return { ok: false, status: res.status, error: explainStatus(res.status, msg) };
  }

  if (!body || typeof body !== "object") {
    return { ok: false, status: res.status, error: "模型服务返回的不是 JSON，可能填错了地址" };
  }

  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const content =
    choice && choice.message && typeof choice.message.content === "string"
      ? choice.message.content
      : choice && typeof choice.text === "string"
        ? choice.text
        : "";

  if (!content) {
    return {
      ok: false,
      status: res.status,
      error: "模型没有返回内容，可能被内容策略拦截或模型名不对",
    };
  }

  return { ok: true, content, usage: body.usage || null, model: body.model || model, raw: body };
}

/**
 * 连通性测试：用最小请求探活
 */
async function testConnection(cfg) {
  const probe = {
    ok: false,
    error: "没有配置模型服务地址，请到「设置 → AI 模型」填写",
  };
  const base = normalizeBaseUrl((cfg || {}).baseUrl);
  if (!base) return probe;

  const r = await chat(
    cfg,
    {
      messages: [{ role: "user", content: "回复两个字：可用" }],
      maxTokens: 16,
      temperature: 0,
      timeoutMs: 30000,
    }
  );
  if (!r.ok) return r;
  return { ok: true, content: r.content, model: r.model };
}

/**
 * 让模型输出 JSON，并解析出来。
 * 解析失败不静默吞掉 —— 返回原始文本让调用方决定怎么办。
 */
async function chatJson(cfg, req) {
  const r = await chat(cfg, req);
  if (!r.ok) return r;
  let raw = String(r.content || "").trim();
  /* 去掉模型爱加的 ```json 围栏 */
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1];
  try {
    return { ok: true, data: JSON.parse(raw), raw: r.content, usage: r.usage, model: r.model };
  } catch (e) {
    return {
      ok: false,
      error: "模型返回的内容不是合法 JSON，无法解析",
      raw: r.content,
      parseError: String((e && e.message) || e),
    };
  }
}

module.exports = {
  PRESETS,
  normalizeBaseUrl,
  maskKey,
  isLocalBase,
  presetById,
  keyRequired,
  isConnected,
  explainStatus,
  chat,
  chatJson,
  testConnection,
};
