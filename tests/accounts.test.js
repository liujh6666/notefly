/* 独立账号模型（lib/accounts.js）
 * 验收要求：accountId 与 platformId 分离、同平台多账号各自独立分区、
 *           默认账号沿用共享分区（存量登录态不迁移）。 */
const test = require("node:test");
const assert = require("node:assert");
const accounts = require("../lib/accounts");

const PLATFORMS = [
  { id: "juejin", label: "掘金", status: "verified", loginUrl: "https://juejin.cn/login", homeUrl: "https://juejin.cn/", composeUrl: "https://juejin.cn/editor/drafts/new" },
  { id: "csdn", label: "CSDN", status: "unverified", loginUrl: "https://passport.csdn.net/login", homeUrl: "https://www.csdn.net/", composeUrl: "https://mp.csdn.net/mp_blog/creation/editor" },
];

test("默认账号：id=平台 id，用共享分区（存量登录态不迁移）", () => {
  const r = accounts.resolve("juejin", []);
  assert.deepEqual(r, { id: "juejin", platform: "juejin", isDefault: true, partition: accounts.DEFAULT_PARTITION });
  assert.equal(accounts.DEFAULT_PARTITION, "persist:notefly");
});

test("额外账号：独立分区，不能与默认账号共用会话", () => {
  const extras = [{ id: "juejin-2", platform: "juejin", alias: "公司号", group: "未分组", createdAt: "2026-01-01T00:00:00.000Z" }];
  const r = accounts.resolve("juejin-2", extras);
  assert.equal(r.platform, "juejin");
  assert.equal(r.isDefault, false);
  assert.equal(r.partition, "persist:acct-juejin-2");
  assert.notEqual(r.partition, accounts.resolve("juejin", extras).partition);
});

test("未知的「形如额外账号」的 id 一律不认（防止误发到已删除的账号）", () => {
  assert.equal(accounts.resolve("juejin-9", []), null);
  assert.equal(accounts.resolve("juejin-2", [{ id: "juejin-3", platform: "juejin" }]), null);
  assert.equal(accounts.resolve("", []), null);
});

test("下一个账号 id：从 -2 起，跳过已用的序号，不受其它平台影响", () => {
  assert.equal(accounts.nextAccountId("juejin", []), "juejin-2");
  assert.equal(accounts.nextAccountId("juejin", [{ id: "juejin-2", platform: "juejin" }]), "juejin-3");
  assert.equal(accounts.nextAccountId("juejin", [
    { id: "juejin-2", platform: "juejin" },
    { id: "juejin-5", platform: "juejin" },
    { id: "csdn-2", platform: "csdn" },
  ]), "juejin-6");
});

test("规范化：丢弃与平台同名的「默认账号」重复项、去重、补齐缺失字段", () => {
  const out = accounts.normalizeAccountList([
    { id: "juejin", platform: "juejin" },          // 默认账号不能落盘
    { id: "juejin-2", platform: "juejin" },
    { id: "juejin-2", platform: "juejin" },        // 重复
    { id: "csdn-2", platform: "juejin" },          // 自相矛盾
    { platform: "juejin" },                        // 缺 id
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "juejin-2");
  assert.equal(out[0].alias, "");
  assert.equal(out[0].group, "未分组");
  assert.ok(out[0].createdAt);
  assert.deepEqual(accounts.normalizeAccountList(null), []);
  assert.deepEqual(accounts.normalizeAccountList("nope"), []);
});

test("账号列表：默认账号在前，同平台额外账号紧随其后", () => {
  const extras = [
    { id: "juejin-2", platform: "juejin", alias: "公司号", group: "团队", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "csdn-2", platform: "csdn", alias: "小号", group: "未分组", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const list = accounts.buildAccountList(PLATFORMS, extras, {}, {}, {});
  assert.deepEqual(list.map((a) => a.id), ["juejin", "juejin-2", "csdn", "csdn-2"]);
  assert.equal(list[0].isDefault, true);
  assert.equal(list[1].isDefault, false);
  assert.equal(list[1].alias, "公司号");
  assert.equal(list[1].displayName, "掘金", "额外账号显示的平台名与默认账号一致");
});

test("登录态与身份按 accountId 关联，默认账号的旧缓存不会串给第二个账号", () => {
  const extras = [{ id: "juejin-2", platform: "juejin", alias: "", group: "未分组", createdAt: "2026-01-01T00:00:00.000Z" }];
  const details = {
    juejin: { id: "juejin", online: true, checkedAt: "2026-11-05T00:00:00.000Z", method: "api" },   // 历史数据：按平台 id 索引
  };
  const identity = { "juejin-2": { username: "公司号昵称", homeUrl: "https://juejin.cn/user/123", capturedAt: "2026-11-05T00:00:00.000Z" } };
  const list = accounts.buildAccountList(PLATFORMS, extras, {}, identity, details);
  const d = list.find((a) => a.id === "juejin");
  const e = list.find((a) => a.id === "juejin-2");
  assert.equal(d.isLoggedIn, true, "默认账号沿用历史巡检结果");
  assert.equal(e.isLoggedIn, null, "新账号不能继承默认账号的登录态");
  assert.equal(e.username, "公司号昵称");
  assert.equal(e.homeUrl, "https://juejin.cn/user/123");
  assert.equal(d.homeUrl, "", "默认账号没抓到主页就是空，不能拿平台首页冒充");
});

test("适配器下线的遗留账号仍会列出（用户要能删掉它）", () => {
  const extras = [{ id: "gone-2", platform: "gone", alias: "旧平台号", group: "未分组", createdAt: "2026-01-01T00:00:00.000Z" }];
  const list = accounts.buildAccountList(PLATFORMS, extras, {}, {}, {});
  const g = list.find((a) => a.id === "gone-2");
  assert.ok(g, "遗留账号必须在列表里");
  assert.match(g.displayName, /适配器已下线/);
});

test("platformOf：额外账号归还平台，默认账号原样返回", () => {
  const extras = [{ id: "juejin-2", platform: "juejin" }];
  assert.equal(accounts.platformOf("juejin-2", extras), "juejin");
  assert.equal(accounts.platformOf("juejin", extras), "juejin");
  /* 未注册的 juejin-9 不猜，按原样返回 —— 调用方会先 resolve 校验 */
  assert.equal(accounts.platformOf("juejin-9", extras), "juejin");
});
