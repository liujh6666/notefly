/*
 * NoteFly 企业写作风格档案
 * ------------------------------------------------------------
 * 从企业内容库里已可用的文章里，提取「这家企业怎么说话」。
 *
 * 明确不做的事：
 *  - 不做模型微调。导入几篇文章不等于模型参数训练完了 —— 任何界面文案
 *    都不能这么宣称。这里做的是「检索 + 风格分析 + 上下文组装」。
 *  - 不把历史文章里的时间、人物、产品参数、活动成果、合作方自动变成
 *    「当前事实」。事实与表达习惯分开保存（facts / style）。
 *
 * 两层：
 *  1. 规则层（本地、离线、可解释）：句长、段落长度、开头结尾模式、
 *     高频术语、品牌露出、禁用表达候选。这一层永远可用。
 *  2. 模型层（可选）：让模型读样本，输出结构化的读者/称谓/术语/语气
 *     判断。模型层失败时保留规则层结果，不能把整份档案清空。
 *
 * 样本不足时如实提示，不硬凑。
 */
"use strict";

const { tokenize } = require("./content-library");

/* 样本量门槛：低于这个数量，风格结论不可靠 */
const MIN_SAMPLES = 3;
/* 建议样本量 */
const RECOMMENDED_SAMPLES = 8;

/* 常见的 AI 套话与空泛表达 —— 作为「不宜使用的表达」的候选 */
const GENERIC_PHRASES = [
  "赋能", "抓手", "闭环", "颗粒度", "底层逻辑", "方法论", "打法", "心智",
  "势能", "降本增效", "破局", "数字化转型", "全链路", "新基建", "护城河",
  "值得注意的是", "众所周知", "不言而喻", "总而言之", "综上所述",
  "在当今这个", "随着.*的不断发展", "首先", "其次", "最后",
];

/* 常见的企业自称 / 品牌称谓线索 */
const BRAND_PATTERNS = [
  { re: /我们(公司|团队|团队)/g, label: "我们公司 / 我们团队" },
  { re: /本(公司|企业|品牌|团队)/g, label: "本公司 / 本品牌" },
  { re: /我(们)司/g, label: "我司" },
];

/**
 * 规则层分析：从一组文章里统计风格特征
 * @param {Array<{title:string, body:string, sourceUrl:string, contentType:string}>} articles
 */
function analyzeByRules(articles) {
  const samples = (articles || []).filter((a) => a && a.body);
  if (!samples.length) {
    return {
      ok: false,
      reason: "没有可分析的文章",
      profile: null,
    };
  }

  /* ---- 句子与段落 ---- */
  const sentenceLens = [];
  const paraLens = [];
  const openers = [];
  const closers = [];
  const termFreq = new Map();
  const brandHits = new Map();
  let totalChars = 0;

  for (const a of samples) {
    const paras = a.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) paraLens.push(p.replace(/\s/g, "").length);
    /* 句子：按中文句号/问号/叹号切 */
    const sentences = a.body.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 1);
    for (const s of sentences) sentenceLens.push(s.replace(/\s/g, "").length);
    if (paras.length) {
      openers.push(paras[0].slice(0, 40));
      closers.push(paras[paras.length - 1].slice(-40));
    }
    totalChars += a.body.replace(/\s/g, "").length;

    /* 术语频次（中文双字组，剔除高频虚词） */
    const toks = tokenize(`${a.title}\n${a.body}`);
    for (const t of toks) {
      if (t.length < 2) continue;
      if (STOPWORDS.has(t)) continue;
      termFreq.set(t, (termFreq.get(t) || 0) + 1);
    }
    /* 品牌露出 */
    for (const p of BRAND_PATTERNS) {
      const n = (a.body.match(p.re) || []).length;
      if (n) brandHits.set(p.label, (brandHits.get(p.label) || 0) + n);
    }
  }

  const avg = (arr) => (arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0);
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };

  /* 高频术语：出现次数多且不是几乎每篇都出现的通用词 */
  const topTerms = Array.from(termFreq.entries())
    .filter(([t, n]) => n >= 2 && t.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([term, count]) => ({ term, count }));

  /* 通用套话：样本里出现越多，越应该列进「不宜使用」 */
  const banned = GENERIC_PHRASES
    .map((p) => {
      const re = new RegExp(p, "g");
      let n = 0;
      for (const a of samples) n += (a.body.match(re) || []).length;
      return { phrase: p, count: n };
    })
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  /* 品牌露出的原文出处 */
  const brandHabits = Array.from(brandHits.entries()).map(([label, count]) => {
    const src = samples.find((a) => new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/公司|团队|企业|品牌|本|我|们|司/g, ""), "g").test(a.body));
    return {
      label,
      count,
      example: src ? (src.body.match(new RegExp("[^。！？\\n]{0,30}" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^。！？\\n]{0,30}")) || [""])[0].trim() : "",
      sourceTitle: src ? src.title : "",
      sourceUrl: src ? src.sourceUrl : "",
    };
  });

  /* 开头与结尾模式：取最常见的句式骨架（去掉具体内容） */
  const openerPatterns = topPatterns(openers);
  const closerPatterns = topPatterns(closers);

  /* 标题模式 */
  const titlePatterns = samples.map((a) => a.title || "").filter(Boolean);

  const confidence = computeConfidence(samples.length);

  return {
    ok: true,
    profile: {
      /* ---- 表达习惯（style）---- */
      style: {
        tone: inferTone(sentenceLens, avg(paraLens)),
        sentenceLength: {
          avg: Math.round(avg(sentenceLens)),
          median: median(sentenceLens),
          min: sentenceLens.length ? Math.min(...sentenceLens) : 0,
          max: sentenceLens.length ? Math.max(...sentenceLens) : 0,
        },
        paragraphLength: {
          avg: Math.round(avg(paraLens)),
          median: median(paraLens),
        },
        infoDensity: density(totalChars, samples.length),
        openers: openerPatterns,
        closers: closerPatterns,
        titlePatterns: titlePatterns.slice(0, 8),
        brandHabits,
        terms: topTerms,
        bannedExpressions: banned,
      },
      /* ---- 事实（facts）----
         注意：这里只放「用户确认过的事实」与「从文章里提取但标注了时效的线索」。
         历史文章的时间/人物/参数不会自动变成当前事实。 */
      facts: {
        confirmed: [],       // 用户确认的当前事实
        historicalHints: [], // 来自历史文章，仅供参考，标注来源与时间
        note: "历史文章中的时间、人物、产品参数、活动成果与合作关系只是过往记录，不能直接当作当前事实使用。",
      },
      /* ---- 档案元信息 ---- */
      sampleCount: samples.length,
      confidence,
      sufficiency: samples.length < MIN_SAMPLES
        ? { enough: false, level: "insufficient", message: `样本只有 ${samples.length} 篇，少于 ${MIN_SAMPLES} 篇，风格结论仅供参考，建议再导入 ${RECOMMENDED_SAMPLES - samples.length} 篇` }
        : samples.length < RECOMMENDED_SAMPLES
          ? { enough: true, level: "limited", message: `样本 ${samples.length} 篇，风格画像基本可用，但覆盖面还不全` }
          : { enough: true, level: "good", message: `样本 ${samples.length} 篇，风格画像可信度较高` },
      analyzedAt: new Date().toISOString(),
    },
  };
}

/* 高频虚词/通用词，不该进「企业术语」 */
const STOPWORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "这些", "那些", "可以", "因为", "所以",
  "但是", "如果", "已经", "还是", "不是", "就是", "什么", "怎么", "为了", "进行",
  "通过", "以及", "并且", "或者", "而且", "然后", "这样", "那样", "一个", "一些",
  "没有", "自己", "现在", "同时", "或者", "此外", "另外", "其中", "本文", "文章",
]);

/** 句子骨架：去掉具体名词，只留句式 */
function toSkeleton(s) {
  return String(s || "")
    .replace(/[，。！？、；：""''（）()《》【】\[\]—…·,.!?;:"'()<>\-—\s]/g, "")
    .replace(/[a-zA-Z0-9]+/g, "N")
    .slice(0, 12);
}

/** 从若干开头/结尾里提取常见模式 */
function topPatterns(list) {
  const freq = new Map();
  for (const s of list) {
    const sk = toSkeleton(s);
    if (!sk) continue;
    if (!freq.has(sk)) freq.set(sk, { skeleton: sk, count: 0, examples: [] });
    const e = freq.get(sk);
    e.count++;
    if (e.examples.length < 2 && s) e.examples.push(s.slice(0, 60));
  }
  return Array.from(freq.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

/** 语气推断：句长 + 段落长度 + 疑问/感叹使用 */
function inferTone(sentenceLens, avgPara) {
  const a = sentenceLens.length ? sentenceLens.reduce((s, n) => s + n, 0) / sentenceLens.length : 0;
  if (a < 18) return "简洁直白";
  if (a < 32) return "平实叙述";
  if (a < 48) return "细致讲解";
  if (avgPara > 180) return "长文论述";
  return "偏正式书面";
}

/** 信息密度：字数 / 段落数的粗略指标 */
function density(totalChars, sampleCount) {
  if (!sampleCount) return 0;
  const per = totalChars / sampleCount;
  if (per > 2000) return "高";
  if (per > 900) return "中";
  return "低";
}

/** 置信度：样本量决定 */
function computeConfidence(n) {
  if (n >= RECOMMENDED_SAMPLES) return 0.85;
  if (n >= 5) return 0.7;
  if (n >= MIN_SAMPLES) return 0.55;
  if (n >= 1) return 0.3;
  return 0;
}

/* ==================== 模型层分析 ==================== */

/**
 * 让模型读样本，输出结构化的读者/称谓/术语/语气判断。
 * 只提供「表达习惯」层面的结论 —— 不允许模型编造事实。
 * @param {{chat:Function, cfg:object}} deps
 */
async function analyzeByModel(deps, articles) {
  const chat = deps && deps.chat;
  const cfg = deps && deps.cfg;
  if (typeof chat !== "function" || !cfg) {
    return { ok: false, reason: "未接入模型，跳过模型层分析" };
  }
  const samples = (articles || []).slice(0, 12);
  if (samples.length < MIN_SAMPLES) {
    return { ok: false, reason: `样本不足 ${MIN_SAMPLES} 篇，跳过模型层分析（规则层结果仍然可用）` };
  }

  /* 只送「表达样本」的片段，不送整库，也不送任何凭据 */
  const corpus = samples.map((a, i) => {
    const text = String(a.body || "").slice(0, 1200);
    return `【样本 ${i + 1}】标题：${a.title}\n${text}`;
  }).join("\n\n");

  const sys = [
    "你是一位企业品牌内容分析师。你的任务是分析一组企业文章的「表达习惯」，不是提取事实。",
    "",
    "硬性要求：",
    "1. 只输出 JSON，不要任何解释文字。",
    "2. 严禁编造事实：你不得输出任何具体的时间、人物姓名、职务、产品参数、价格、活动成果或合作方名称。",
    "   你的输出只描述「怎么说话」：读者是谁、怎么称呼自己、常用哪些词、怎么开头结尾、语气如何。",
    "3. 不宜使用的表达：指出这些文章里出现的套话、空话、过度营销词。",
    "4. 品牌露出：描述这个品牌通常在什么位置、以什么方式提到自己，并给出原文片段作为例证。",
    "5. 样本里没有的信息就写「未知」，不要推断。",
    "",
    "JSON 结构：",
    JSON.stringify({
      audience: "目标读者描述",
      selfNaming: ["品牌/公司的自称方式"],
      terminology: [{ term: "常用术语", note: "含义或用法" }],
      forbidden: ["不宜使用的表达"],
      tone: "语气描述",
      sentencePattern: "句式特点",
      organization: "正文组织方式",
      openingPattern: "常见开头方式",
      titlePattern: "常见标题方式",
      endingPattern: "常见结尾方式",
      brandExposure: [{ label: "露出方式", example: "原文片段" }],
    }, null, 2),
  ].join("\n");

  const user = "以下是这家企业的文章样本（节选）：\n\n" + corpus;

  const r = await chat(cfg, {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    maxTokens: 2000,
    timeoutMs: 120000,
  });
  if (!r || !r.ok) {
    return { ok: false, reason: (r && r.error) || "模型分析失败", raw: r && r.raw };
  }
  let data = null;
  try {
    const fence = String(r.content || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    const raw = fence ? fence[1] : String(r.content || "").trim();
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "模型返回的不是合法 JSON", raw: r.content };
  }
  return { ok: true, data };
}

/**
 * 合并模型层与规则层
 * 模型层只补充「读者/称谓/术语/禁用/语气」这些它擅长的；
 * 统计类（句长/段落/密度）以规则层为准 —— 那是可验证的数字。
 */
function mergeProfiles(ruleProfile, modelData) {
  const p = JSON.parse(JSON.stringify(ruleProfile));
  if (!modelData) return p;
  const s = p.style;
  if (modelData.audience) s.audience = String(modelData.audience).slice(0, 400);
  if (Array.isArray(modelData.selfNaming)) s.selfNaming = modelData.selfNaming.map((x) => String(x).slice(0, 60)).slice(0, 10);
  if (Array.isArray(modelData.terminology)) {
    const modelTerms = modelData.terminology.map((t) => ({
      term: String(t.term || "").slice(0, 40),
      note: String(t.note || "").slice(0, 120),
      source: "model",
    }));
    /* 规则层统计出的高频词也并进来（它有出处，可信度更高） */
    const ruleTerms = (s.terms || []).map((t) => ({ term: t.term, note: `出现 ${t.count} 次`, source: "rule" }));
    const seen = new Set();
    s.terminology = [...modelTerms, ...ruleTerms].filter((t) => {
      if (!t.term) return false;
      const k = t.term.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 30);
  }
  if (Array.isArray(modelData.forbidden)) {
    const set = new Set((s.bannedExpressions || []).map((x) => x.phrase));
    for (const f of modelData.forbidden) {
      const ph = String(f || "").trim();
      if (!ph || set.has(ph)) continue;
      set.add(ph);
      s.bannedExpressions.push({ phrase: ph, count: 0, source: "model" });
    }
  }
  if (modelData.tone) s.tone = String(modelData.tone).slice(0, 100);
  if (modelData.sentencePattern) s.sentencePattern = String(modelData.sentencePattern).slice(0, 300);
  if (modelData.organization) s.organization = String(modelData.organization).slice(0, 300);
  if (modelData.openingPattern) s.openingPattern = String(modelData.openingPattern).slice(0, 200);
  if (modelData.titlePattern) s.titlePattern = String(modelData.titlePattern).slice(0, 200);
  if (modelData.endingPattern) s.endingPattern = String(modelData.endingPattern).slice(0, 200);
  if (Array.isArray(modelData.brandExposure) && modelData.brandExposure.length) {
    s.brandHabits = (s.brandHabits || []).concat(
      modelData.brandExposure.map((b) => ({
        label: String(b.label || "").slice(0, 60),
        count: 0,
        example: String(b.example || "").slice(0, 160),
        sourceTitle: "",
        sourceUrl: "",
        source: "model",
      }))
    ).slice(0, 12);
  }
  p.analysisSource = "rules+model";
  return p;
}

/**
 * 把风格档案渲染成给模型看的文本块
 * 只描述表达，不夹带事实。
 */
function renderProfileForPrompt(profile) {
  if (!profile) return "";
  const s = profile.style || {};
  const lines = [];
  if (s.audience) lines.push(`- 目标读者：${s.audience}`);
  if (Array.isArray(s.selfNaming) && s.selfNaming.length) lines.push(`- 品牌/公司自称：${s.selfNaming.join("、")}`);
  if (s.tone) lines.push(`- 语气：${s.tone}`);
  if (s.sentenceLength) lines.push(`- 句长：平均约 ${s.sentenceLength.avg} 字（区间 ${s.sentenceLength.min}–${s.sentenceLength.max}）`);
  if (s.paragraphLength) lines.push(`- 段落长度：平均约 ${s.paragraphLength.avg} 字`);
  if (s.infoDensity) lines.push(`- 信息密度：${s.infoDensity}`);
  if (s.sentencePattern) lines.push(`- 句式特点：${s.sentencePattern}`);
  if (s.organization) lines.push(`- 正文组织：${s.organization}`);
  if (s.openingPattern) lines.push(`- 常见开头：${s.openingPattern}`);
  if (s.endingPattern) lines.push(`- 常见结尾：${s.endingPattern}`);
  if (s.titlePattern) lines.push(`- 常见标题：${s.titlePattern}`);
  if (Array.isArray(s.terminology) && s.terminology.length) {
    lines.push(`- 常用术语：${s.terminology.slice(0, 15).map((t) => t.term).join("、")}`);
  }
  if (Array.isArray(s.bannedExpressions) && s.bannedExpressions.length) {
    lines.push(`- 不宜使用：${s.bannedExpressions.slice(0, 15).map((x) => x.phrase).join("、")}`);
  }
  if (Array.isArray(s.brandHabits) && s.brandHabits.length) {
    const bh = s.brandHabits.slice(0, 5).map((b) => `${b.label}${b.example ? `（如：${b.example.slice(0, 40)}）` : ""}`).join("；");
    lines.push(`- 品牌露出习惯：${bh}`);
  }
  if (!lines.length) return "";
  return "【企业写作风格档案】\n" + lines.join("\n");
}

module.exports = {
  MIN_SAMPLES,
  RECOMMENDED_SAMPLES,
  GENERIC_PHRASES,
  analyzeByRules,
  analyzeByModel,
  mergeProfiles,
  renderProfileForPrompt,
  computeConfidence,
};
