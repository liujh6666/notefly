/* 独立账号模型：accountId 与 platformId 分离
 *
 * 设计要点：
 * - 每个平台有一个「默认账号」，id 就等于平台 id（如 juejin）—— 它是**虚拟的**、
 *   不落盘。这样旧数据（任务记录里的 accountIds、kaState.details、accountMeta）
 *   全部零迁移继续可用，存量登录态也不动。
 * - 同平台的第 2/3/… 个账号叫平台 id 加序号（juejin-2、juejin-3…），落在
 *   store.accounts 里，每个账号有独立的持久化会话分区 persist:acct-<id>。
 * - 登录态巡检（config.kaState.details）按 accountId 索引：默认账号的键就是
 *   平台 id，历史巡检结果自动对上。
 * - 账号身份（昵称/头像/公开主页）存 store.accountIdentity，登录检查通过时尽力抓取。
 *
 * ⚠ 判定「默认账号还是额外账号」必须看 store.accounts，不能从 id 字符串猜 ——
 *   平台 id 本身可能带连字符，字符串规则会把它误判成额外账号的独立分区。
 */

/** 默认账号（虚拟，id=平台 id）使用的共享分区：与内置浏览器同会话 */
const DEFAULT_PARTITION = "persist:notefly";

/** 额外账号的独立分区前缀 */
const ACCT_PARTITION_PREFIX = "persist:acct-";

/** 账号 id 里的平台序号后缀（juejin-2 → juejin） */
function platformOf(accountId, extras) {
  const id = String(accountId || "");
  const own = (extras || []).find((a) => a.id === id);
  if (own) return own.platform;
  const m = id.match(/^(.+)-(\d+)$/);
  return m ? m[1] : id;
}

/** 解析账号：返回 {id, platform, isDefault, partition}；未知账号返回 null */
function resolve(accountId, extras) {
  const id = String(accountId || "");
  if (!id) return null;
  const own = (extras || []).find((a) => a.id === id);
  if (own) {
    return { id, platform: own.platform, isDefault: false, partition: ACCT_PARTITION_PREFIX + id };
  }
  const m = id.match(/^(.+)-(\d+)$/);
  if (m) return null; /* 形如「额外账号」但注册表里没有 → 已删除/伪造，明确不认 */
  return { id, platform: id, isDefault: true, partition: DEFAULT_PARTITION };
}

/** 在已有账号里找同平台的最大序号，生成下一个可用账号 id（从 2 起） */
function nextAccountId(platform, extras) {
  let max = 1;
  for (const a of extras || []) {
    if (a.platform !== platform) continue;
    const m = String(a.id).match(/-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return platform + "-" + (max + 1);
}

/** 规范化 store.accounts（老数据/手工编辑缺字段时补齐，绝不能崩） */
function normalizeAccountList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((a) => a && a.id && a.platform)
    .map((a) => ({
      id: String(a.id),
      platform: String(a.platform),
      alias: String(a.alias || ""),
      group: String(a.group || "未分组"),
      createdAt: String(a.createdAt || new Date().toISOString()),
    }))
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      /* 额外账号的 id 必须是「平台-序号」，且与 platform 字段自洽；
         默认账号（id = platform）不落盘，重复项/矛盾数据一律丢弃 */
      const m = a.id.match(/^(.+)-(\d+)$/);
      return !!m && m[1] === a.platform;
    });
}

/**
 * 合成完整账号列表：默认账号（每平台一个，虚拟）+ 额外账号。
 * @param {Array} platforms rpa.listPlatforms() 结果 [{id,label,status,loginUrl,homeUrl,composeUrl}]
 * @param {Array} extras store.accounts
 * @param {Object} metaMap store.accountMeta
 * @param {Object} identityMap store.accountIdentity
 * @param {Object} detailsMap accountId -> 巡检结果 {online,checkedAt,method,...}
 */
function buildAccountList(platforms, extras, metaMap, identityMap, detailsMap) {
  const out = [];
  const list = extras || [];
  for (const p of platforms || []) {
    out.push(makeAccount(p.id, p, list, metaMap, identityMap, detailsMap));
    for (const a of list) {
      if (a.platform === p.id) out.push(makeAccount(a.id, p, list, metaMap, identityMap, detailsMap));
    }
  }
  /* 平台适配器已下线但账号还在：也要展示出来，否则用户没法清理 */
  const known = new Set((platforms || []).map((p) => p.id));
  for (const a of list) {
    if (known.has(a.platform)) continue;
    out.push(makeAccount(a.id, { id: a.platform, label: a.platform + "（适配器已下线）" }, list, metaMap, identityMap, detailsMap));
  }
  return out;
}

function makeAccount(id, platformInfo, extras, metaMap, identityMap, detailsMap) {
  const r = resolve(id, extras);
  const extra = extras.find((a) => a.id === id) || null;
  const meta = (metaMap && metaMap[id]) || {};
  const identity = (identityMap && identityMap[id]) || {};
  const detail = (detailsMap && detailsMap[id]) || null;
  return {
    id,
    platform: r ? r.platform : platformInfo.id,
    displayName: platformInfo.label || (r ? r.platform : id),
    isDefault: !extra,
    partition: r ? r.partition : DEFAULT_PARTITION,
    username: identity.username || "",
    avatar: identity.avatar || "",
    homeUrl: identity.homeUrl || "",
    capturedAt: identity.capturedAt || "",
    group: extra ? extra.group : (meta.group || "未分组"),
    alias: extra ? extra.alias : (meta.alias || ""),
    isLoggedIn: detail && detail.checkedAt ? !!detail.online : null,
    checkedAt: (detail && detail.checkedAt) || "",
    checkMethod: (detail && detail.method) || "",
    adapterStatus: platformInfo.status || "",
    loginUrl: platformInfo.loginUrl || "",
    homeUrlFallback: platformInfo.homeUrl || "",
    consoleUrl: platformInfo.composeUrl || "",
  };
}

module.exports = {
  DEFAULT_PARTITION,
  ACCT_PARTITION_PREFIX,
  platformOf,
  resolve,
  nextAccountId,
  normalizeAccountList,
  buildAccountList,
};
