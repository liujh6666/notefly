/*
 * 任务/目标状态统一归并
 * ------------------------------------------------------------
 * 全项目只允许通过这里判定「任务到底算不算完成」，避免出现
 * “一个平台成功、一个平台失败，任务却显示已完成”这类误报。
 *
 * 目标状态（target.status）语义：
 *   pending       排队中，尚未开始
 *   filling       正在填入编辑器
 *   draft_saving  内容已填入，正在确认平台草稿保存
 *   ready         已填入并留存页面，等待人工确认/发布（草稿模式）
 *   needs_manual  平台要求人工处理（原创声明、验证码、二次确认等）
 *   submitting    已点击提交，等待平台回执
 *   accepted      平台已受理（作品已创建，可能处于审核中）
 *   reviewing     平台审核中
 *   success       已确认发布成功（有作品 ID / 管理页状态 / 公开 URL 为证）
 *   failed        明确失败
 *   unknown       提交了但结果未知（超时/连接中断），必须先核验再决定是否重试
 *
 * 任务状态（task.status）语义：
 *   scheduled     定时待发
 *   creating      正在创建远端任务
 *   running       有目标在填充/提交中
 *   draft_ready   全部目标已存为草稿，等人工确认（草稿模式的正常终点）
 *   needs_manual  有目标等待人工处理
 *   partial       部分成功（成功 + 失败/待确认/未知混合）
 *   done          全部目标确认成功
 *   failed        全部目标失败
 *   unknown       存在结果未知的目标，不能算完成
 */
"use strict";

const TARGET_SUCCESS = new Set(["success", "published"]);
const TARGET_FAILED = new Set(["failed"]);
const TARGET_MANUAL = new Set(["ready", "needs_manual"]);
/* 已受理/审核中：提交已被平台接收，流程正常推进中（不是结果未知） */
const TARGET_IN_FLIGHT = new Set(["submitting", "accepted", "reviewing"]);
/* 真正的结果未知：超时/中断，必须先核验再决定是否重试 */
const TARGET_UNKNOWN = new Set(["unknown"]);
const TARGET_RUNNING = new Set(["pending", "filling", "draft_saving"]);

const TASK = {
  SCHEDULED: "scheduled",
  CREATING: "creating",
  RUNNING: "running",
  IN_REVIEW: "in_review",
  DRAFT_READY: "draft_ready",
  NEEDS_MANUAL: "needs_manual",
  PARTIAL: "partial",
  DONE: "done",
  FAILED: "failed",
  UNKNOWN: "unknown",
};

/* 前端展示用文案（服务端也用它生成 history 描述） */
const TASK_LABEL = {
  scheduled: "定时待发",
  creating: "创建中",
  running: "进行中",
  in_review: "审核中",
  draft_ready: "草稿待确认",
  needs_manual: "等待人工",
  partial: "部分成功",
  done: "已完成",
  failed: "有失败",
  unknown: "结果待核验",
};

const TARGET_LABEL = {
  pending: "排队中",
  filling: "填入中",
  draft_saving: "草稿保存中",
  ready: "草稿待确认",
  needs_manual: "等待人工",
  submitting: "提交中",
  accepted: "已受理",
  reviewing: "审核中",
  success: "已发布",
  failed: "失败",
  unknown: "结果未知",
};

function isDone(t) {
  return !!t && TARGET_SUCCESS.has(t.status);
}
function isFailed(t) {
  return !!t && TARGET_FAILED.has(t.status);
}

/**
 * 归并目标状态 → 任务状态
 * @param {Array} targets 目标数组
 * @param {String} mode "draft" | "publish"
 * @returns {{status:string,label:string,counts:object,total:number,reason:string}}
 */
function summarize(targets, mode = "draft") {
  const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
  const counts = { total: list.length, success: 0, failed: 0, manual: 0, unknown: 0, running: 0, inFlight: 0 };
  for (const t of list) {
    if (TARGET_SUCCESS.has(t.status)) counts.success++;
    else if (TARGET_FAILED.has(t.status)) counts.failed++;
    else if (TARGET_MANUAL.has(t.status)) counts.manual++;
    else if (TARGET_IN_FLIGHT.has(t.status)) counts.inFlight++;
    else if (TARGET_UNKNOWN.has(t.status)) counts.unknown++;
    else counts.running++; // pending / filling / draft_saving / 未知取值都按未完成处理
  }

  /* 空目标绝不能算成功：没有执行对象就没有结果 */
  if (!counts.total) {
    return { status: TASK.UNKNOWN, label: TASK_LABEL.unknown, counts, total: 0, reason: "无目标" };
  }

  /* 真正的结果未知优先级最高：宁可显示待核验，也不能把不确定当成功 */
  if (counts.unknown > 0) {
    return {
      status: TASK.UNKNOWN,
      label: TASK_LABEL.unknown,
      counts,
      reason: `${counts.unknown} 个平台结果待核验`,
    };
  }

  if (counts.running > 0) {
    return {
      status: TASK.RUNNING,
      label: TASK_LABEL.running,
      counts,
      reason: `${counts.running} 个平台仍在执行`,
    };
  }

  /* 已受理/审核中：平台已接收作品，等最终结果，不是“结果待核验” */
  if (counts.inFlight > 0) {
    const bits = [];
    if (counts.success) bits.push(`${counts.success} 已发布`);
    if (counts.inFlight) bits.push(`${counts.inFlight} 审核中`);
    if (counts.failed) bits.push(`${counts.failed} 失败`);
    if (counts.manual) bits.push(`${counts.manual} 待确认`);
    return {
      status: TASK.IN_REVIEW,
      label: TASK_LABEL.in_review,
      counts,
      reason: bits.join(" / "),
    };
  }

  if (counts.failed === counts.total) {
    return { status: TASK.FAILED, label: TASK_LABEL.failed, counts, reason: "全部平台失败" };
  }
  if (counts.success === counts.total) {
    return { status: TASK.DONE, label: TASK_LABEL.done, counts, reason: "全部平台已确认发布" };
  }
  if (counts.success > 0 && counts.failed > 0) {
    return {
      status: TASK.PARTIAL,
      label: TASK_LABEL.partial,
      counts,
      reason: `${counts.success} 成功 / ${counts.failed} 失败`,
    };
  }
  if (counts.success > 0 && counts.manual > 0) {
    return {
      status: TASK.PARTIAL,
      label: TASK_LABEL.partial,
      counts,
      reason: `${counts.success} 已发布 / ${counts.manual} 待确认`,
    };
  }
  if (counts.manual === counts.total) {
    return mode === "publish"
      ? { status: TASK.NEEDS_MANUAL, label: TASK_LABEL.needs_manual, counts, reason: "全部平台等待人工处理" }
      : { status: TASK.DRAFT_READY, label: TASK_LABEL.draft_ready, counts, reason: "草稿已就绪，等待人工确认" };
  }
  if (counts.manual > 0) {
    return {
      status: TASK.NEEDS_MANUAL,
      label: TASK_LABEL.needs_manual,
      counts,
      reason: `${counts.manual} 个平台等待人工处理${counts.failed ? `，${counts.failed} 个失败` : ""}`,
    };
  }
  return { status: TASK.UNKNOWN, label: TASK_LABEL.unknown, counts, reason: "状态无法判定" };
}

/** 失败目标的错误摘要（没有失败就返回 null，避免残留旧错误） */
function errorText(targets) {
  const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
  const bad = list.filter((t) => TARGET_FAILED.has(t.status));
  if (!bad.length) return null;
  return bad
    .map((t) => `${t.platform || t.accountId || "?"}: ${t.error || "失败（平台未返回原因）"}`)
    .join("；")
    .slice(0, 800);
}

/**
 * 把最新目标状态写回任务对象（就地修改）
 * 任何目标变化都必须调用它，保证父任务与目标一致。
 */
function syncTask(task, { save, silent } = {}) {
  if (!task) return null;
  const targets = (task.lastStatus && task.lastStatus.targets) || [];
  const sum = summarize(targets, task.mode || "draft");
  const prev = task.status;
  task.status = sum.status;
  task.statusReason = sum.reason || "";
  task.error = errorText(targets);

  if (sum.status === TASK.DONE) {
    task.finishedAt = task.finishedAt || new Date().toISOString();
  } else if (prev === TASK.DONE || task.finishedAt) {
    /* 状态回退（例如重试后又有失败）时必须清掉完成时间，否则统计会把它算成已完成 */
    if (sum.status !== TASK.DONE) task.finishedAt = null;
  }

  if (prev !== task.status && !silent) {
    task.history = task.history || [];
    task.history.push({
      at: new Date().toISOString(),
      event: "status_change",
      detail: `${prev || "-"} → ${task.status}（${sum.reason || ""}）`,
    });
  }
  if (typeof save === "function") save();
  return sum;
}

module.exports = {
  TASK,
  TASK_LABEL,
  TARGET_LABEL,
  summarize,
  errorText,
  syncTask,
  isDone,
  isFailed,
};
