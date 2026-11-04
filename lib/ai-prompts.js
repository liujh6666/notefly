/*
 * AI 提示词库
 * ------------------------------------------------------------
 * 所有提示词集中在这里，方便统一调校，也避免把长 prompt 塞进前端。
 *
 * 写作类提示词统一遵守两条底线：
 *  1. 不许输出 AI 套话（"在当今这个……的时代"、"赋能"、"闭环"……）；
 *  2. 不许凭空编造事实 —— 需要数据但没给数据时，用占位符标出来让人补。
 */
"use strict";

/* 写作风格预设 */
const STYLES = [
  { id: "tech", name: "技术解析", hint: "讲清原理，给出可复现的步骤与代码" },
  { id: "practice", name: "实践教程", hint: "面向动手，分步骤，能照着做出来" },
  { id: "experience", name: "经验分享", hint: "讲踩过的坑与真实取舍，口语化" },
  { id: "product", name: "产品思考", hint: "从用户与商业视角拆解问题" },
  { id: "insight", name: "行业观察", hint: "给判断与依据，不做无据推测" },
  { id: "essay", name: "轻松随笔", hint: "少术语多故事，可读性优先" },
];

/* 通用负面约束：任何生成类任务都带上 */
const NO_SLOP = [
  "不要使用这些词：赋能、抓手、闭环、颗粒度、底层逻辑、方法论、打法、心智、势能、降本增效、破局、数字化转型、全链路、新基建。",
  "不要使用套话：值得注意的是、众所周知、不言而喻、总而言之、综上所述、在当今这个……的时代、随着……的不断发展。",
  "不要用「首先/其次/最后」当段落骨架，不要用破折号插入语，不要用感叹号，不要用 emoji。",
  "不要写「引言」「总结」式的模板段落；开头直接进入正题，结尾落在具体结论或行动上。",
  "不要编造数据、案例、引用。确实需要具体数字但用户没提供时，用【待补：xxx】标出来。",
].join("\n");

/* ==================== 写作 ==================== */
function buildWrite(req) {
  const topic = String(req.topic || "").trim();
  const style = STYLES.find((s) => s.id === req.style) || STYLES[0];
  const words = Math.max(200, Math.min(8000, Number(req.words) || 1200));
  const audience = String(req.audience || "").trim();
  const keywords = String(req.keywords || "").trim();
  const extra = String(req.extra || "").trim();
  const outline = String(req.outline || "").trim();
  /* 默认带标题（老行为不变）：勾选「AI 标题」时让模型把标题作为第一行输出，
     取消勾选就只要正文，正文里也不要出现 # 标题行 */
  const withTitle = req.withTitle === undefined ? true : !!req.withTitle;

  const sys = [
    "你是一位中文技术写作作者，擅长把复杂内容写成能直接发布的中文文章。",
    "行文要求：",
    NO_SLOP,
    "输出必须是 Markdown 正文（不要输出解释、不要包裹在代码块里）。",
    withTitle
      ? "标题单独占第一行，格式为「# 标题」。"
      : "不要输出标题：直接从正文第一段开始，不要出现以 # 开头的标题行。",
  ].join("\n");

  const user = [
    "请写一篇中文文章。",
    "",
    "主题：" + (topic || "（未指定，请自拟一个适合技术社区的选题）"),
    "风格：" + style.name + " —— " + style.hint,
    "篇幅：约 " + words + " 字。",
    audience ? "目标读者：" + audience + "。" : "",
    keywords ? "必须覆盖的关键词：" + keywords + "。" : "",
    outline ? "请按这个提纲展开：\n" + outline : "",
    extra ? "补充要求：\n" + extra : "",
    "",
    withTitle ? "请直接输出「# 标题」加 Markdown 正文。" : "请直接输出 Markdown 正文，不要标题行。",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

/* ==================== 续写 ==================== */
function buildContinue(req) {
  const before = String(req.before || "").trim();
  const after = String(req.after || "").trim();
  const topic = String(req.topic || "").trim();
  const words = Math.max(100, Math.min(4000, Number(req.words) || 600));
  const sys = [
    "你是一位中文写作助手，负责接着已有内容往下写。",
    "要求：",
    NO_SLOP,
    "只输出新增的正文，不要重复已有内容，不要输出解释。",
    "与前文语气、时态、人称保持一致。",
  ].join("\n");
  const user = [
    "下面是文章已有部分：",
    "---",
    before || "（空）",
    "---",
    after ? "光标后面还有这些内容（不要重复它）：\n" + after : "",
    topic ? "接下来的重点：\n" + topic : "",
    "请接着写约 " + words + " 字。",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

/* ==================== 润色 / 改写 ==================== */
/* 改写子动作：id + 展示名（/api/ai/config 下发给前端下拉，buildRewrite 按同一份 id 取指令） */
const REWRITE_ACTS = {
  polish: ["润色", "在保持原意与信息量不变的前提下，把表达改得更准确、更顺、更像人写的。"],
  shorten: ["精简", "在不丢失关键信息的前提下，把篇幅压到约一半，删掉重复与铺陈。"],
  expand: ["扩写", "在不编造事实的前提下补充细节、例子与解释，篇幅约扩到两倍。"],
  formal: ["改正式", "把口语化表达改成书面表达，保持专业但不生硬。"],
  casual: ["改口语", "把书面表达改得口语化一些，像博客作者在讲经验。"],
  title: ["起标题", "为下面这段内容起 8 个中文标题，要求具体、有信息量、不要用夸张词，不要用问号以外的标点堆砌。"],
  digest: ["写摘要", "为下面这段内容写 2 段中文摘要，每段不超过 120 字，概括核心观点与读者收益，不要用「本文」「这篇文章」开头。"],
  tags: ["打标签", "为下面这段内容打 6 个中文标签，每个 2-6 个字，不要重复，不要用「技术」「学习」这类无信息量的词。"],
  outline: ["拟提纲", "为下面这段内容列一个 Markdown 提纲，用 ## 标题，不要写正文。"],
};
const REWRITE_ACTIONS = Object.entries(REWRITE_ACTS).map(([id, [name]]) => ({ id, name }));

function buildRewrite(req) {
  const text = String(req.text || "").trim();
  const action = req.action || "polish";
  const style = STYLES.find((s) => s.id === req.style) || null;
  const extra = String(req.extra || "").trim();

  const act = REWRITE_ACTS[action] || REWRITE_ACTS.polish;
  const outFormat =
    action === "title"
      ? "只输出标题列表，每行一个标题，前面加「- 」。"
      : action === "tags"
        ? "只输出标签列表，每行一个，前面加「- 」。"
        : action === "digest"
          ? "只输出摘要正文。\n\n" + act[1]
          : action === "outline"
            ? "只输出提纲。"
            : "只输出改写后的正文，不要解释，不要额外加标题。";

  const sys = [
    "你是一位中文文字编辑。",
    act[1],
    "硬性要求：",
    NO_SLOP,
    "不得改变原意，不得添加原文没有的事实、观点或引用。",
    "保持原文的 Markdown 结构（标题、列表、代码块、表格）不变。",
    outFormat,
  ].join("\n");

  const user = [
    style ? "期望的行文风格：" + style.name + " —— " + style.hint + "。" : "",
    extra ? "额外要求：\n" + extra : "",
    "---",
    text,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

/* ==================== 深度去 AI 味 ==================== */
function buildDeai(req) {
  const text = String(req.text || "").trim();
  const strength = req.strength === "strong" ? "强" : req.strength === "light" ? "轻" : "中";
  const sys = [
    "你是一位中文编辑，专门把「一眼看出是机器写的」的文章改成真人写作。",
    "",
    "操作要求：",
    "1. 保留全部事实、数据、论点与例子，一个都不能丢，也绝对不能新增原文没有的事实。",
    "2. 拆掉模板骨架：删掉「引言—主体—总结」的三段式，删掉段首的「首先/其次/最后」。",
    "3. 打散句式：把连续长句拆开，插入短句；相邻句子不要用同一个句式开头。",
    "4. 具体化：抽象名词换成具体的动作、主体或场景（但不要凭空添加信息）。",
    "5. 去掉情绪词与程度词（非常、十分、极其、显著地……）。",
    "6. 破折号插入语改写成正常句子。",
    "7. 不要 emoji，不要感叹号，不要「综上所述」类总结段。",
    "8. 结尾落在具体判断或可执行的动作上，不要升华。",
    "",
    "力度要求（" + strength + "）：",
    strength === "轻" ? "只做最小必要改动，尽量保留原句。" : strength === "强" ? "可以大幅重写句子结构，但事实必须一字不差地保留。" : "在保留原意的前提下明显改写句式与节奏。",
    "",
    "只输出改写后的 Markdown 正文，不要解释、不要给建议清单。",
  ].join("\n");
  return [
    { role: "system", content: sys },
    { role: "user", content: text },
  ];
}

/* ==================== 分发 ==================== */
function buildActions() {
  return {
    write: buildWrite,
    continue: buildContinue,
    rewrite: buildRewrite,
    deai: buildDeai,
  };
}

module.exports = {
  STYLES,
  NO_SLOP,
  REWRITE_ACTIONS,
  buildWrite,
  buildContinue,
  buildRewrite,
  buildDeai,
  buildActions,
};
