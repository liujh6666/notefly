/*
 * 文本工具引擎：一键排版 + 一键去 AI 味
 * ------------------------------------------------------------
 * 纯函数、无 IO、无网络依赖，可直接单测；服务端直接跑同一份规则，
 * 不配置任何 AI 也能用这两个功能（完全离线）。
 *
 * 五条硬约束：
 *  1. 代码块内的字符一律不动 —— 缩进、标点、空格在代码里都有意义；
 *  2. 行内代码 / HTML 标签 / 链接 URL / 图片 / 公式一律不动；
 *  3. 每次改动必须可追溯：返回 changes 明细，界面能告诉用户「改了什么」；
 *  4. 只做保守改写 —— 宁可少改，不可把语义改坏；
 *  5. 改写后 Markdown 结构必须仍然合法（标题/列表/代码/表格/引用）。
 */
"use strict";

/* ==================== 保护段机制 ====================
 * 改写期间把不该动的片段抽走，放进 N 占位，改完还原。
 * 用 Unicode 私有区字符，避免和正文里的普通数字冲突。
 */
const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";
const PH_RE = /\uE000(\d+)\uE001/g;

/* 绝对不能动的片段（第一层保护） */
const HARD_PATTERNS = [
  /`[^`\n]+`/g,            // 行内代码
  /<[^<>]+>/g,             // HTML 标签
  /\$[^$\n]+\$/g,           // 行内公式
];

/* 结构片段：语法修正之后必须整体锁住（第二层保护） */
const STRUCT_PATTERNS = [
  /!\[[^\]]*\]\s*\([^)]+\)/g, // 图片
  /\[[^\]]*\]\s*\([^)]+\)/g,  // 链接
  /https?:\/\/[^\s)]+/g,      // 裸链接
];

function protectSegments(text, patterns, sharedStore) {
  /* 同一次排版里的多层保护必须共享同一个 store：
     各层各存各的会从 0 开始生成相同占位符，还原时串层（审查报告 P0-1） */
  const store = sharedStore || [];
  let out = String(text == null ? "" : text);
  for (const re of patterns) {
    out = out.replace(re, (m) => {
      store.push(m);
      return PH_OPEN + (store.length - 1) + PH_CLOSE;
    });
  }
  return {
    text: out,
    store,
    /* 单层保护的调用方可以直接用 restore；多层共享时用 restoreAll(s, 共享store) */
    restore(s) {
      return restoreAll(s, store);
    },
  };
}

/* 还原全部占位符。被保护的片段自身可能还含内层占位符
   （例如链接整体被第二层保护、里面的行内代码是第一层），
   replace 不会重扫替换进来的文本，所以循环还原到稳定为止。 */
function restoreAll(text, store) {
  let s = String(text);
  for (let guard = 0; guard < 8 && PH_RE.test(s); guard++) {
    PH_RE.lastIndex = 0;
    s = s.replace(PH_RE, (m, i) =>
      store[Number(i)] != null ? store[Number(i)] : m
    );
  }
  return s;
}

/* 压缩连续空行 —— 只允许作用于普通文本块，绝不能碰到代码块内部 */
function compressBlankLines(text) {
  return String(text == null ? "" : text)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}

/* ==================== 代码块切分 ==================== */
function splitFences(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let cur = { code: false, lines: [] };
  let fence = null;

  for (const line of lines) {
    if (fence) {
      cur.lines.push(line);
      const m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) {
        blocks.push(cur);
        cur = { code: false, lines: [] };
        fence = null;
      }
      continue;
    }
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (m) {
      if (cur.lines.length) blocks.push(cur);
      fence = { char: m[1][0], len: m[1].length };
      cur = { code: true, lines: [line] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.lines.length) blocks.push(cur);
  return blocks;
}

/* ==================== 记录器 ==================== */
function createRecorder() {
  const map = new Map();
  return {
    hit(rule, label, sample) {
      let e = map.get(rule);
      if (!e) {
        e = { rule, label, count: 0, samples: [] };
        map.set(rule, e);
      }
      e.count++;
      if (sample && e.samples.length < 3 && e.samples.indexOf(sample) < 0) e.samples.push(sample);
    },
    hitOnce(rule, label, sample) {
      if (map.has(rule)) return;
      this.hit(rule, label, sample);
    },
    list() {
      return Array.from(map.values()).sort((a, b) => b.count - a.count);
    },
  };
}

/* ==================== 通用小工具 ==================== */

/* 中英文 / 中数字之间补空格 */
function addCJKSpacing(text) {
  let out = text.replace(/([一-龥])([A-Za-z0-9])/g, "$1 $2");
  out = out.replace(/([A-Za-z0-9])([一-龥])/g, "$1 $2");
  return out;
}

/* 中文语境里的半角标点转全角 */
function normalizePunctuation(text) {
  let out = text;
  /* 1. 省略号优先（三个以上半角点 -> 中文省略号） */
  out = out.replace(/\.{3,}/g, "……");
  /* 2. 连续半角标点先收成一个（粘贴常见），必须在单标点转全角之前，
   *    否则 ",," 会变成 "，," 这种混合状态 */
  if (/[一-龥]/.test(out)) {
    out = out.replace(/,{2,}/g, "，").replace(/:{2,}/g, "：").replace(/;{2,}/g, "；").replace(/\.{2,}/g, "。");
  }
  /* 3. 中文后面的单个半角标点 */
  out = out.replace(/([一-龥])!/g, "$1！");
  out = out.replace(/([一-龥])\?/g, "$1？");
  out = out.replace(/([一-龥]),/g, "$1，");
  out = out.replace(/([一-龥])\./g, "$1。");
  out = out.replace(/([一-龥]):/g, "$1：");
  out = out.replace(/([一-龥]);/g, "$1；");
  /* 4. 半角括号包中文 -> 全角 */
  out = out.replace(/\(([^()]*[一-龥][^()]*)\)/g, (m, inner) => "（" + inner + "）");
  /* 5. 压缩连续的全角标点 */
  out = out.replace(/，{2,}/g, "，").replace(/。{2,}/g, "。").replace(/：{2,}/g, "：").replace(/；{2,}/g, "；");
  /* 6. 全角标点后紧跟中文时去掉空格（中文排版习惯） */
  out = out.replace(/([，。！？；：、）】》」』])[ \t]+(?=[一-龥])/g, "$1");
  return out;
}

/* 链接 / 图片语法规范化（在保护之前做，避免动到行内代码） */
function normalizeLinkSyntax(text) {
  let out = text.replace(/\]\s*\(\s*/g, "](").replace(/\s*\)/g, ")");
  out = out.replace(/!\[\]\(/g, "![图片](");
  return out;
}

/* 列表层级：制表符/多空格缩进折算成 2 空格一层 */
function normalizeListLine(line) {
  const m = line.match(/^(\s*)([*+-]|\d+[.)])\s+(.*)$/);
  if (!m) return null;
  const indentRaw = m[1];
  const spaces = indentRaw.replace(/\t/g, "    ").length;
  /* 列表标记本身占 2 列：0/2/4/6/8 空格 -> 0/1/1/2/2 层，每层 2 空格 */
  const depth = Math.floor(spaces / 4) + (spaces % 4 >= 2 ? 1 : 0);
  let norm = "  ".repeat(Math.max(0, depth));
  if (/^\d+[.)]$/.test(m[2])) norm += m[2].replace(/[)]$/, ".") + " " + m[3];
  else norm += "- " + m[3];
  return { text: norm, depth: Math.max(0, depth) };
}

/* 表格：补齐列数、统一分隔行 */
function normalizeTable(rows) {
  const splitRow = (r) =>
    r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isSep = (r) => r.indexOf("-") >= 0 && /^[|\s:-]+$/.test(r);
  const head = splitRow(rows[0]);
  const cols = head.length;
  const out = ["| " + head.join(" | ") + " |"];
  const sepCells = [];
  if (rows.length > 1 && isSep(rows[1])) {
    for (const c of splitRow(rows[1])) {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      const width = (c.match(/-/g) || []).length || 3;
      sepCells.push((left ? ":" : "") + "-".repeat(Math.max(3, width)) + (right ? ":" : ""));
    }
  } else {
    for (let i = 0; i < cols; i++) sepCells.push("---");
  }
  while (sepCells.length < cols) sepCells.push("---");
  out.push("| " + sepCells.slice(0, cols).join(" | ") + " |");
  const body = rows.length > 1 && isSep(rows[1]) ? rows.slice(2) : rows.slice(1);
  for (const r of body) {
    const cells = splitRow(r);
    while (cells.length < cols) cells.push("");
    out.push("| " + cells.slice(0, cols).join(" | ") + " |");
  }
  return out;
}

/* 代码围栏前后留空行：开围栏之前、闭围栏之后；围栏内部一律不动 */
function ensureFenceSpacing(text) {
  const lines = String(text == null ? "" : text).split("\n");
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (!fence) {
      if (m) {
        if (out.length && out[out.length - 1].trim() !== "") out.push("");
        out.push(line);
        fence = { char: m[1][0], len: m[1].length };
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
    if (m && m[1][0] === fence.char && m[1].length >= fence.len && !m[2]) {
      fence = null;
      if (i + 1 < lines.length && lines[i + 1].trim() !== "") out.push("");
    }
  }
  return out.join("\n");
}

/* 段落切分（保留代码块标记） */
const STRUCTURE_RE = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/;

/* ==================== 一键排版 ==================== */
/**
 * @param {string} text 原始 Markdown
 * @param {{level?:string}} opts light / medium / strong
 * @returns {{text:string, changes:Array, stats:object}}
 */
function formatMarkdown(text, opts) {
  const o = opts || {};
  const level = o.level === "medium" ? 2 : o.level === "strong" ? 3 : 1;
  const rec = createRecorder();
  const src = String(text == null ? "" : text);

  const blocks = splitFences(src);
  const outParts = [];
  const prot = [];                     // 全文档共享的保护段存储

  for (const block of blocks) {
    if (block.code) {
      outParts.push(block.lines.join("\n"));
      continue;
    }

    const hard = protectSegments(block.lines.join("\n"), HARD_PATTERNS, prot);
    let t = normalizeLinkSyntax(hard.text);
    const soft = protectSegments(t, STRUCT_PATTERNS, prot);
    let lines = soft.text.split("\n");

    /* 1. 行尾空白 + 全角空格 */
    lines = lines.map((l) => {
      const r = l.replace(/[ \t]+$/, "").replace(/　/g, " ");
      if (r !== l) rec.hitOnce("trim", "清理行尾空白与全角空格");
      return r;
    });

    /* 2. 标题 / 分隔线 / 引用 */
    lines = lines.map((l) => {
      let m = l.match(/^(\s{0,3})(#{1,6})\s*(.*?)\s*#*\s*$/);
      if (m) {
        const t2 = m[3].trim();
        const nn = m[1] + m[2] + " " + t2;
        if (nn !== l) rec.hitOnce("heading", "规范标题格式", m[2] + " " + t2);
        return nn;
      }
      if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(l)) {
        rec.hitOnce("hr", "统一分隔线为 ---");
        return "---";
      }
      m = l.match(/^(\s{0,3})(>+)\s*(.*)$/);
      if (m) {
        const nn = m[1] + m[2] + " " + m[3];
        if (nn !== l) rec.hitOnce("quote", "规范引用块格式");
        return nn;
      }
      return l;
    });

    /* 3. 列表符号与缩进 */
    lines = lines.map((l) => {
      const n = normalizeListLine(l);
      if (!n) return l;
      if (n.text !== l) rec.hitOnce("list", "统一列表符号与缩进");
      return n.text;
    });

    /* 4. 表格 */
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
      const rows = [];
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        rows.push(lines[j]);
        j++;
      }
      if (rows.length >= 2) {
        const fixed = normalizeTable(rows);
        if (fixed.join("\n") !== rows.join("\n")) rec.hitOnce("table", "规范表格列数与分隔行");
        lines.splice(i, rows.length, ...fixed);
        i += fixed.length - 1;
      }
    }

    /* 5. 行内强调标记 */
    lines = lines.map((l) => {
      let r = l;
      if (/__[^_\n]+__/.test(r)) {
        r = r.replace(/__([^_\n]+)__/g, "**$1**");
        rec.hitOnce("emph", "统一加粗标记为 **");
      }
      if (/(^|[^\w])_[^_\n]+_(?![a-zA-Z0-9])/.test(r)) {
        r = r.replace(/(^|[^\w])_([^_\n]+)_(?![a-zA-Z0-9])/g, "$1*$2*");
        rec.hitOnce("emph", "统一斜体标记为 *");
      }
      return r;
    });

    /* 6. 标点与中英文间距 */
    lines = lines.map((l) => {
      const before = l;
      let r = l;
      if (level >= 2) {
        r = r.replace(/!([ \t　]|$)/g, "！$1");
      }
      r = addCJKSpacing(r);
      r = normalizePunctuation(r);
      if (r !== before) rec.hitOnce("punct", "统一中英文间距与中文标点");
      return r;
    });

    /* 7. 段落间距：连续空行压成一个 */
    const tight = [];
    for (const l of lines) {
      if (l === "") {
        if (tight.length && tight[tight.length - 1] === "") continue;
        tight.push("");
        continue;
      }
      tight.push(l);
    }
    while (tight.length && tight[tight.length - 1] === "") tight.pop();
    const squashed = tight.join("\n");
    if (squashed !== lines.join("\n")) rec.hitOnce("blank", "压缩多余空行");

    outParts.push(restoreAll(squashed, prot));
  }

  /* 全局空行压缩只作用于普通文本块：先按 fence 切开，代码块逐字节保留
     （审查报告 P0-1：Python 多行字符串里的空行曾被压掉改变语义） */
  const joined = ensureFenceSpacing(outParts.join("\n"));
  const result = splitFences(joined)
    .map((b) => (b.code ? b.lines.join("\n") : compressBlankLines(b.lines.join("\n"))))
    .join("\n")
    .replace(/\s+$/, "");

  return {
    text: result,
    changes: rec.list(),
    stats: { chars: result.length, lines: result.split("\n").length, rules: rec.list().length },
  };
}

/* ==================== 去 AI 味规则 ==================== */

/* A 组：空转插入语 —— 删掉不损失任何信息 */
const DROP_PHRASES = [
  ["值得注意的是", "空转插入语"],
  ["需要指出的是", "空转插入语"],
  ["不可否认的是", "空转插入语"],
  ["不难看出", "空转插入语"],
  ["不难发现", "空转插入语"],
  ["不言而喻", "空转插入语"],
  ["众所周知", "空转插入语"],
  ["毋庸置疑", "空转插入语"],
  ["总而言之", "总结套话"],
  ["综上所述", "总结套话"],
  ["总的来说", "总结套话"],
  ["一言以蔽之", "总结套话"],
  ["总结来说", "总结套话"],
  ["简而言之", "总结套话"],
  ["从某种意义上说", "空转插入语"],
  ["在某种程度上", "空转插入语"],
  ["尽可能", "空转插入语"],
  ["有效地", "空转插入语"],
  ["进一步地", "空转插入语"],
  ["显而易见", "空转插入语"],
  ["毫无疑问", "空转插入语"],
  ["在当今", "空转插入语"],
  ["此时此刻", "空转插入语"],
  ["换句话说", "空转插入语"],
  ["也就是说", "空转插入语"],
  ["简单来说", "空转插入语"],
  ["简单而言", "空转插入语"],
  ["让我们一起", "空转插入语"],
  ["让我们来", "空转插入语"],
];

/* B 组：AI 高频抽象词 —— 降级成更具体的说法 */
const REPLACE_WORDS = [
  ["底层逻辑是", "关键在于"],
  ["底层逻辑", "根本原因"],
  ["降本增效", "降低成本、提高效率"],
  ["数字化转型", "数字化"],
  ["新基建", "基础设施"],
  ["组合拳", "配套措施"],
  ["颗粒度", "精细程度"],
  ["方法论", "方法"],
  ["全链路", "全流程"],
  ["底层能力", "基础能力"],
  ["红利期", "窗口期"],
  ["护城河", "壁垒"],
  ["赋能", "帮助"],
  ["抓手", "关键动作"],
  ["闭环", "完整流程"],
  ["打法", "做法"],
  ["心智", "认知"],
  ["势能", "增长趋势"],
  ["拉通", "打通"],
  ["深耕", "长期投入"],
  ["助力", "帮助"],
  ["提效", "提升效率"],
  ["破局", "突破"],
];

/* C 组：过渡序号 —— AI 最典型的骨架
 * SEQ_WORDS  : 只在行首删（"最后一步"、"另外一件事"可能是实义，不能乱删）
 * SEQ_GLOBAL : 纯序号，句中出现也删（后面必须接汉字，避免误伤"首先想到"之外的用法） */
const SEQ_WORDS = ["首先", "其次", "再次", "最后", "另外", "此外", "总之"];
const SEQ_GLOBAL = ["首先", "其次", "再次", "总之", "此外"];
/* 「最后」两种用法：「最后一步」是实义，「最后要复盘」是序号。
 * 只在后面接助动词/完成类词时才判定为序号，避免误删实义用法。 */
const SEQ_LAST_VERB = /最后[，,、]?(?=(要|会|需要|应该|可以|能|得|才|再|就|将|把|被|是|结束|完成|剩下))/g;

/* D 组：程度副词 —— 情绪大于信息 */
const HEDGE_WORDS = ["非常", "十分", "极其", "极为", "相当", "尤为", "无比", "真的很", "极大地", "非常地", "特别地", "十分地", "更加"];

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/**
 * 一键去 AI 味
 * @param {string} text
 * @param {{level?:string}} opts light / medium / strong
 * @returns {{text:string, changes:Array, stats:object}}
 */
function humanizeText(text, opts) {
  const o = opts || {};
  const level = o.level === "light" ? 1 : o.level === "strong" ? 3 : 2;
  const rec = createRecorder();
  const src = String(text == null ? "" : text);

  const blocks = splitFences(src);
  const outParts = [];

  for (const block of blocks) {
    if (block.code) {
      outParts.push(block.lines.join("\n"));
      continue;
    }

    const hard = protectSegments(block.lines.join("\n"), HARD_PATTERNS);
    let body = hard.text;

    /* 1. 抽象词降级 */
    if (level >= 2) {
      for (const pair of REPLACE_WORDS) {
        const from = pair[0];
        const to = pair[1];
        const n = body.split(from).length - 1;
        if (!n) continue;
        body = body.split(from).join(to);
        rec.hit("abstract", "抽象词降级：" + from + " → " + to, from + "×" + n);
      }
    }

    /* 2. 句式模板改写（必须先于短语删除：先套模板再删词，否则「在当今…的时代」会被拆残） */
    const p0 = body;
    body = body.replace(/不仅([^，,。；;!?]{1,30})[，,]?\s*而且/g, "$1，");
    body = body.replace(/不只是([^，,。；;!?]{1,30})[，,]?\s*更是/g, "$1，");
    body = body.replace(/既([^，,。；;!?]{1,20})[，,]\s*又/g, "$1，");
    if (body !== p0) rec.hit("pattern", "拆解「不仅…而且…」类套句");

    const p1 = body;
    body = body.replace(/通过([^，,。；;\n]{1,40})[，,]\s*我们(?:能够|可以|可)(?=[^\n]{0,20})/g, "通过$1，");
    body = body.replace(/通过([^，,。；;\n]{1,40})的方式/g, "通过$1");
    if (body !== p1) rec.hit("pattern", "精简「通过…的方式 / 我们能够」套句");

    const p2 = body;
    body = body.replace(/在[^，,。；;\n]{1,24}的背景下[，,]?/g, "");
    body = body.replace(/在[^，,。；;\n]{1,24}的时代[，,]?/g, "");
    body = body.replace(/随着([^，,。；;\n]{1,24})的(?:不断)?(?:发展|推进|深入)[，,]?/g, "$1");
    body = body.replace(/对于([^，,。；;\n]{1,30})而言[，,]?/g, "$1");
    body = body.replace(/这是一个[^，,。；;\n]{1,24}的问题[，,]?/g, "");
    body = body.replace(/之所以([^，,。；;\n]{1,40})[，,]\s*是因为/g, "$1，是因为");
    if (body !== p2) rec.hit("pattern", "精简过渡句式（背景下 / 对于…而言 / 之所以）");

    /* 3. 空转插入语 */
    for (const pair of DROP_PHRASES) {
      const word = pair[0];
      const n = body.split(word).length - 1;
      if (!n) continue;
      body = body.split(word).join("");
      rec.hit("filler", "删除" + pair[1] + "：" + word, word + "×" + n);
    }

    /* 4. 程度副词 */
    if (level >= 2) {
      for (const w of HEDGE_WORDS) {
        const n = body.split(w).length - 1;
        if (!n) continue;
        body = body.split(w).join("");
        rec.hit("hedge", "删除程度副词：" + w, w + "×" + n);
      }
    }

    /* 5. 序号式过渡 */
    for (const w of SEQ_WORDS) {
      const re = new RegExp("(^|\\n)[ \\t]*" + w + "[，,、]?[ \\t]*", "g");
      const m = body.match(re);
      if (!m) continue;
      body = body.replace(re, "$1");
      rec.hit("sequence", "删除序号式过渡：" + w, w + "×" + m.length);
    }
    for (const w of SEQ_GLOBAL) {
      const re = new RegExp(w + "[，,、]?(?=[一-龥])", "g");
      const m = body.match(re);
      if (!m) continue;
      body = body.replace(re, "");
      rec.hit("sequence", "删除序号式过渡：" + w, w + "×" + m.length);
    }
    {
      const m = body.match(SEQ_LAST_VERB);
      if (m) {
        body = body.replace(SEQ_LAST_VERB, "");
        rec.hit("sequence", "删除序号式过渡：最后", "最后×" + m.length);
      }
    }

    /* 6. 标点与语气 */
    if (level >= 2) {
      const d0 = body;
      body = body.replace(/——(?=[^。！？\n])/g, "，").replace(/——(?=[。！？\n])/g, "。");
      body = body.replace(/[ \t]+--[ \t]+/g, "，");
      if (body !== d0) rec.hit("dash", "拆解破折号插入语");

      const e0 = body;
      body = body.replace(/！{2,}/g, "！");
      body = body.replace(/！/g, "。");
      if (body !== e0) rec.hit("exclaim", "感叹号改为句号");
    }

    /* 7. emoji */
    if (level >= 2) {
      const m0 = body;
      const emo = body.match(EMOJI_RE);
      if (emo) {
        body = body.replace(EMOJI_RE, "");
        rec.hit("emoji", "移除表情符号", Array.from(new Set(emo)).join(" ") + "×" + emo.length);
      }
    }

    /* 8. 段落节奏 */
    let paragraphs = body.split(/\n{2,}/);
    if (level >= 2) {
      const merged = [];
      for (const para of paragraphs) {
        const plain = para.replace(/^[#>\-*+\s\d.]+/gm, "").trim();
        const prev = merged[merged.length - 1];
        const prevPlain = prev ? prev.replace(/^[#>\-*+\s\d.]+/gm, "").trim() : "";
        const canMerge =
          merged.length > 0 &&
          plain.length > 0 &&
          plain.length < 25 &&
          !STRUCTURE_RE.test(para.trim()) &&
          prevPlain.length >= 25 &&
          !STRUCTURE_RE.test(prev.trim());
        if (canMerge) {
          const head = prev.replace(/[ \t]+$/, "");
          const tail = plain.replace(/^。/, "");
          merged[merged.length - 1] = /[。！？]$/.test(head) ? head + tail : head + "。" + tail;
          rec.hit("merge", "合并过短段落", plain.slice(0, 16));
        } else {
          merged.push(para);
        }
      }
      paragraphs = merged;
    }
    if (level >= 3) {
      const last = paragraphs[paragraphs.length - 1];
      if (last && /^(总而言之|综上所述|总的来说|一言以蔽之|总结来说|简而言之)[，,、：:]?/.test(last.trim())) {
        paragraphs = paragraphs.slice(0, -1);
        rec.hit("summary", "删除总结性尾段");
      }
    }
    body = paragraphs.join("\n\n");

    /* 9. 残留清理（不动段落结构） */
    const c0 = body;
    body = body.replace(/([。！？])[，,、；：]+/g, "$1");
    body = body.replace(/，{2,}/g, "，").replace(/。{2,}/g, "。");
    body = body.replace(/[ \t]{2,}/g, " ");
    body = body.replace(/^[，。、；：]+/gm, "");
    body = body.replace(/([。！？，；：])[ \t]+/g, "$1");
    if (body !== c0) rec.hit("cleanup", "清理标点与空格残留");

    outParts.push(hard.restore(body));
  }

  const result = outParts.join("\n\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "");

  const changes = rec.list();
  return {
    text: result,
    changes,
    stats: {
      chars: result.length,
      hitCount: changes.reduce((n, c) => n + c.count, 0),
      ruleCount: changes.length,
    },
  };
}

/* ==================== AI 味体检（只检测不改） ==================== */
function analyzeAiStyle(text) {
  const src = String(text == null ? "" : text);
  const plain = splitFences(src)
    .filter((b) => !b.code)
    .map((b) => b.lines.join("\n"))
    .join("\n");

  const hits = [];
  for (const pair of DROP_PHRASES) {
    const n = plain.split(pair[0]).length - 1;
    if (n) hits.push({ kind: "filler", label: "空转插入语：" + pair[0], count: n });
  }
  for (const pair of REPLACE_WORDS) {
    const n = plain.split(pair[0]).length - 1;
    if (n) hits.push({ kind: "abstract", label: "抽象词：" + pair[0], count: n });
  }
  for (const w of SEQ_WORDS) {
    const m = plain.match(new RegExp("(^|\\n)[ \\t]*" + w + "[，,、]?", "g"));
    if (m) hits.push({ kind: "sequence", label: "序号式过渡：" + w, count: m.length });
  }
  for (const w of SEQ_GLOBAL) {
    const m = plain.match(new RegExp(w + "[，,、]?(?=[一-龥])", "g"));
    if (m) hits.push({ kind: "sequence", label: "句中序号：" + w, count: m.length });
  }
  {
    const m = plain.match(SEQ_LAST_VERB);
    if (m) hits.push({ kind: "sequence", label: "句中序号：最后", count: m.length });
  }
  for (const w of HEDGE_WORDS) {
    const n = plain.split(w).length - 1;
    if (n) hits.push({ kind: "hedge", label: "程度副词：" + w, count: n });
  }
  const push = (kind, label, count) => {
    if (count > 0) hits.push({ kind, label, count });
  };
  push("dash", "中文破折号插入语", (plain.match(/——/g) || []).length);
  push("exclaim", "感叹号", (plain.match(/！/g) || []).length);
  const emo = plain.match(EMOJI_RE);
  push("emoji", "表情符号", emo ? emo.length : 0);
  push("pattern", "「不仅…而且…」套句", (plain.match(/不仅[^，,。]{1,40}而且/g) || []).length);
  push("pattern", "「通过…的方式」套句", (plain.match(/通过[^，,。]{1,40}的方式/g) || []).length);
  push("pattern", "「在…的背景下」套句", (plain.match(/在[^，,。]{1,24}的背景下/g) || []).length);
  push("pattern", "「对于…而言」套句", (plain.match(/对于[^，,。]{1,30}而言/g) || []).length);

  /* 句长均匀度：连续句子长度方差越小越像 AI */
  const sents = plain
    .replace(/\n+/g, "")
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter(Boolean);
  let evenness = 0;
  if (sents.length >= 4) {
    const lens = sents.map((s) => s.length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const varr = lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length;
    const cv = Math.sqrt(varr) / (mean || 1);
    evenness = Math.max(0, Math.min(1, (0.4 - cv) / 0.4));
  }
  if (evenness > 0.25) {
    /* 节奏问题按「命中一次」计，不按次数累加 —— 否则机械重复会直接顶满分 */
    hits.push({ kind: "rhythm", label: "句长过于均匀（节奏机械）", count: 1 });
  }

  const hitsCount = hits.reduce((n, h) => n + h.count, 0);
  const weight = hits.reduce((n, h) => {
    if (h.kind === "rhythm") return n + 6;   /* 固定权重，不随次数放大 */
    const w = h.kind === "abstract" ? 2.2 : h.kind === "pattern" ? 2.5 : h.kind === "filler" ? 1.4 : 1;
    return n + h.count * w;
  }, 0);
  /* 按「每百字的加权命中数」归一：长文不会因为篇幅大而必然满分 */
  const density = weight / Math.max(1, plain.length / 100);
  const score = Math.max(0, Math.min(100, Math.round(density * 8)));

  return {
    score,
    level: score >= 60 ? "high" : score >= 25 ? "mid" : "low",
    hits,
    hitsCount,
    evenness: Math.round(evenness * 100),
  };
}

module.exports = {
  formatMarkdown,
  humanizeText,
  analyzeAiStyle,
  splitFences,
  protectSegments,
  DROP_PHRASES,
  REPLACE_WORDS,
  SEQ_WORDS,
};
