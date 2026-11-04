/*
 * 微信公众号排版主题令牌
 * ------------------------------------------------------------
 * 来源：gzh-design skill 的 references/theme-index.md 与各 theme-*.md 的
 * 「设计变量速查表」。这里只保留渲染必需的令牌（颜色 / 字号 / 间距 / 形态），
 * 不搬运组件库原文 —— 组件由 lib/gzh-render.js 按令牌参数化生成。
 *
 * 为什么要蒸馏而不是直接搬 44KB 组件库：
 *   1. 组件库是给 AI 阅读的 Markdown，不是可执行数据；
 *   2. 7 套主题共用同一套组件语义（章节标题 / 段落 / 引用 / 提示 / 代码 / 图片），
 *      差异全部落在颜色与形态上，参数化后 7 套主题只占几 KB；
 *   3. 新增主题 = 加一条令牌，不用再抄一遍组件。
 *
 * 每个主题的字段含义见下方 THEME_FIELDS 注释。
 */

"use strict";

/**
 * 主题字段说明
 * - id / name / en：标识、中文名、英文名
 * - scene：适用场景（内容库模板选择器里展示）
 * - swatch：模板卡片上的三个代表色
 * - primary：主色
 * - primaryDeep：主色深（强调文字用）
 * - primaryLight：主色浅（装饰用）
 * - primaryBg：主色极浅底
 * - accent：点缀色（高亮 / 次强调）
 * - titleColor / bodyColor / mutedColor / faintColor：文字层级
 * - lineColor / borderColor：分隔线与描边
 * - softBg：浅底（引用 / 提示 / 卡片底）
 * - underline / underlineWeight：正文关键词下划线（权威值来自 theme-index）
 * - fontSize / lineHeight / letterSpacing：正文排版参数
 * - paraGap：段间距
 * - padX：内容区左右内边距
 * - sectionGap：章节上间距
 * - radius：圆角
 * - heading：章节标题形态 —— 见 lib/gzh-render.js 的 renderChapter()
 *   "split"    大编号 + 竖线 + 中英双行（摸鱼绿 / 只此青绿 / 橄榄手记）
 *   "badge"    红底编号标签 + 标题 + 底部粗线（红白色系）
 *   "watermark"超大水印编号 + 标题 + 细线（石墨极简）
 *   "serif"    墨绿英文小标 + 衬线大标题 + 短细线（留白禅意）
 *   "ticket"   实底方块编号 + 标题 + 斜杠副标（摸鱼票据）
 * - quoteStyle：引用块形态 —— "bar" 左竖条 / "card" 圆角底卡 / "plain" 细线
 * - codeStyle：代码块形态 —— "dark" 深色 / "light" 浅色
 * - paperBg：纸张底色（票据 / 手记类主题用非白底）
 * - headingFont：标题字体栈（衬线类主题用衬线）
 */

const THEMES = [
  {
    id: "moyu-green",
    name: "摸鱼绿",
    en: "Moyu Green",
    scene: "教程、测评、清单、工具盘点",
    swatch: ["#059669", "#34D399", "#ECFDF5"],
    primary: "#059669",
    primaryDeep: "#047857",
    primaryLight: "#34D399",
    primaryBg: "#ECFDF5",
    accent: "#FDE68A",
    titleColor: "#111827",
    bodyColor: "#374151",
    mutedColor: "#6B7280",
    faintColor: "#9CA3AF",
    lineColor: "#E5E7EB",
    borderColor: "#BBF7D0",
    softBg: "#F0FDF4",
    underline: "#A7F3D0",
    underlineWeight: "2px",
    fontSize: "14px",
    lineHeight: "1.9",
    letterSpacing: "0.5px",
    paraGap: "20px",
    padX: "20px",
    sectionGap: "48px",
    radius: "10px",
    heading: "split",
    quoteStyle: "card",
    codeStyle: "dark",
    paperBg: "#ffffff",
    headingFont: "inherit",
  },
  {
    id: "zhici-qinglv",
    name: "只此青绿",
    en: "Zhici Qinglv",
    scene: "观点复盘、文化叙事、品牌故事、东方美学",
    swatch: ["#007C7E", "#54AAB9", "#E8F5F5"],
    primary: "#007C7E",
    primaryDeep: "#026B6D",
    primaryLight: "#54AAB9",
    primaryBg: "#E8F5F5",
    accent: "#A5D1D2",
    titleColor: "#111827",
    bodyColor: "#374151",
    mutedColor: "#6B7280",
    faintColor: "#9CA3AF",
    lineColor: "#E5E7EB",
    borderColor: "#A5D1D2",
    softBg: "#E8F5F5",
    underline: "#A5D1D2",
    underlineWeight: "2px",
    fontSize: "14px",
    lineHeight: "1.9",
    letterSpacing: "0.5px",
    paraGap: "20px",
    padX: "20px",
    sectionGap: "48px",
    radius: "10px",
    heading: "split",
    quoteStyle: "card",
    codeStyle: "dark",
    paperBg: "#ffffff",
    headingFont: "inherit",
  },
  {
    id: "red-white",
    name: "红白色系",
    en: "Red White",
    scene: "深度分析、观点、力量感话题",
    swatch: ["#DC2626", "#FCA5A5", "#FEF2F2"],
    primary: "#DC2626",
    primaryDeep: "#991B1B",
    primaryLight: "#FCA5A5",
    primaryBg: "#FEE2E2",
    accent: "#FECACA",
    titleColor: "#1C1917",
    bodyColor: "#374151",
    mutedColor: "#9CA3AF",
    faintColor: "#9CA3AF",
    lineColor: "#E5E7EB",
    borderColor: "#FECACA",
    softBg: "#FEF2F2",
    underline: "#FECACA",
    underlineWeight: "2px",
    fontSize: "15px",
    lineHeight: "1.8",
    letterSpacing: "0.5px",
    paraGap: "20px",
    padX: "10px",
    sectionGap: "48px",
    radius: "10px",
    heading: "badge",
    quoteStyle: "bar",
    codeStyle: "light",
    paperBg: "#ffffff",
    headingFont: "inherit",
  },
  {
    id: "graphite-minimal",
    name: "石墨极简风",
    en: "Graphite Minimal",
    scene: "设计、科技评论、专业观点、高端品牌",
    swatch: ["#52525B", "#A1A1AA", "#FAFAFA"],
    primary: "#52525B",
    primaryDeep: "#27272A",
    primaryLight: "#A1A1AA",
    primaryBg: "#F4F4F5",
    accent: "#F97316",
    titleColor: "#27272A",
    bodyColor: "#52525B",
    mutedColor: "#71717A",
    faintColor: "#A1A1AA",
    lineColor: "#E4E4E7",
    borderColor: "#E4E4E7",
    softBg: "#FAFAFA",
    underline: "#52525B",
    underlineWeight: "2px",
    fontSize: "15px",
    lineHeight: "1.8",
    letterSpacing: "0.3px",
    paraGap: "22px",
    padX: "10px",
    sectionGap: "56px",
    radius: "6px",
    heading: "watermark",
    quoteStyle: "plain",
    codeStyle: "light",
    paperBg: "#ffffff",
    headingFont: "inherit",
  },
  {
    id: "zen-whitespace",
    name: "留白禅意风",
    en: "Zen Whitespace",
    scene: "禅意冥想、极简生活、深度随笔、艺术留白",
    swatch: ["#4A5D52", "#B5C8BC", "#EEF3F0"],
    primary: "#4A5D52",
    primaryDeep: "#3D5046",
    primaryLight: "#B5C8BC",
    primaryBg: "#EEF3F0",
    accent: "#D6E4DC",
    titleColor: "#2B2B2B",
    bodyColor: "#525252",
    mutedColor: "#A3A3A3",
    faintColor: "#A3A3A3",
    lineColor: "#E8E8E8",
    borderColor: "#D6E4DC",
    softBg: "#EEF3F0",
    underline: "#B5C8BC",
    underlineWeight: "1.5px",
    fontSize: "15px",
    lineHeight: "1.9",
    letterSpacing: "0.3px",
    paraGap: "26px",
    padX: "16px",
    sectionGap: "64px",
    radius: "4px",
    heading: "serif",
    quoteStyle: "plain",
    codeStyle: "light",
    paperBg: "#ffffff",
    headingFont: "'Noto Serif SC',Georgia,'Times New Roman',serif",
  },
  {
    id: "moyu-ticket",
    name: "摸鱼票据风",
    en: "Moyu Ticket",
    scene: "测评、工具对比、创意评测",
    swatch: ["#059669", "#1a1a1a", "#fffef8"],
    primary: "#059669",
    primaryDeep: "#047857",
    primaryLight: "#A7F3D0",
    primaryBg: "#F0FDF4",
    accent: "#7C3AED",
    titleColor: "#1a1a1a",
    bodyColor: "#555555",
    mutedColor: "#888888",
    faintColor: "#999999",
    lineColor: "#1a1a1a",
    borderColor: "#A7F3D0",
    softBg: "#F3F4F6",
    underline: "#A7F3D0",
    underlineWeight: "2px",
    fontSize: "14px",
    lineHeight: "1.9",
    letterSpacing: "0.5px",
    paraGap: "20px",
    padX: "20px",
    sectionGap: "32px",
    radius: "6px",
    heading: "ticket",
    quoteStyle: "card",
    codeStyle: "dark",
    paperBg: "#fffef8",
    headingFont: "inherit",
  },
  {
    id: "olive-journal",
    name: "橄榄手记",
    en: "Olive Journal",
    scene: "内刊手记、深度评测、案例复盘、系统性说明文档",
    swatch: ["#1e1f23", "#ed7b2f", "#fdfdf8"],
    primary: "#1e1f23",
    primaryDeep: "#23251d",
    primaryLight: "#ed7b2f",
    primaryBg: "#eeefe9",
    accent: "#ed7b2f",
    titleColor: "#23251d",
    bodyColor: "#4d4f46",
    mutedColor: "#65675e",
    faintColor: "#9ea096",
    lineColor: "#bfc1b7",
    borderColor: "#bfc1b7",
    softBg: "#eeefe9",
    underline: "#ed7b2f",
    underlineWeight: "2px",
    fontSize: "14px",
    lineHeight: "1.9",
    letterSpacing: "0.5px",
    paraGap: "20px",
    padX: "8px",
    sectionGap: "24px",
    radius: "6px",
    heading: "split",
    quoteStyle: "plain",
    codeStyle: "dark",
    paperBg: "#fdfdf8",
    headingFont: "'IBM Plex Sans',-apple-system,sans-serif",
  },
];

const DEFAULT_THEME_ID = "moyu-green";

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** 取主题令牌；未知 id 回落到默认主题（不抛错，避免前端传错参数就整篇渲染失败） */
function getTheme(id) {
  return BY_ID.get(String(id || "")) || BY_ID.get(DEFAULT_THEME_ID);
}

/** 对外暴露的模板清单（不含实现细节，前端拿去做选择器） */
function listThemes() {
  return THEMES.map((t) => ({
    id: t.id,
    name: t.name,
    en: t.en,
    scene: t.scene,
    swatch: t.swatch,
  }));
}

module.exports = { THEMES, DEFAULT_THEME_ID, getTheme, listThemes };
