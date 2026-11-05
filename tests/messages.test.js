/*
 * 消息中心 单元测试
 * 覆盖：事件去重、已读状态持久化、企业隔离、保留策略
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-msg-"));
process.env.NOTEFLY_DATA_DIR = TMP;

const messages = require("../lib/messages");

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test("追加消息：字段齐全", () => {
  messages.clear();
  const m = messages.push({
    eventId: "e1", type: messages.TYPE.COLLECT, title: "采集完成", summary: "成功 3 篇",
  });
  assert.equal(m.title, "采集完成");
  assert.equal(m.summary, "成功 3 篇");
  assert.equal(m.read, false);
  assert.ok(m.at, "必须有发生时间");
  assert.ok(m.id);
});

test("相同 eventId 只保留一条（重试/重复检查不刷屏）", () => {
  messages.clear();
  messages.push({ eventId: "dup", type: messages.TYPE.COLLECT, title: "第一次" });
  messages.push({ eventId: "dup", type: messages.TYPE.COLLECT, title: "第二次" });
  const list = messages.list({});
  const same = list.items.filter((m) => m.eventId === "dup");
  assert.equal(same.length, 1, "同 eventId 只能有一条");
  assert.equal(same[0].title, "第二次", "后写的覆盖先写的");
});

test("已读状态不会被重复事件重置", () => {
  messages.clear();
  const m = messages.push({ eventId: "r1", type: messages.TYPE.COLLECT, title: "A" });
  messages.markRead(m.id);
  messages.push({ eventId: "r1", type: messages.TYPE.COLLECT, title: "A 更新" });
  const got = messages.list({}).items.find((x) => x.eventId === "r1");
  assert.equal(got.read, true, "重复事件不该把已读消息重新变成未读");
});

test("未读数可按企业过滤", () => {
  messages.clear();
  messages.push({ eventId: "g1", type: messages.TYPE.UPDATE, title: "全局更新" });
  messages.push({ eventId: "c1", type: messages.TYPE.COLLECT, title: "A 企业", companyId: "A" });
  messages.push({ eventId: "c2", type: messages.TYPE.COLLECT, title: "B 企业", companyId: "B" });
  const a = messages.list({ companyId: "A" });
  assert.equal(a.unread, 2, "A 企业应看到全局消息 + 自己的消息");
  const titles = a.items.map((m) => m.title);
  assert.ok(!titles.includes("B 企业"), "A 企业不应看到 B 企业的消息");
});

test("全部已读只影响对应范围", () => {
  messages.clear();
  messages.push({ eventId: "g1", type: messages.TYPE.UPDATE, title: "全局" });
  messages.push({ eventId: "c1", type: messages.TYPE.COLLECT, title: "A", companyId: "A" });
  messages.push({ eventId: "c2", type: messages.TYPE.COLLECT, title: "B", companyId: "B" });
  messages.markAllRead("A");
  assert.equal(messages.unreadCount("B"), 1, "B 的未读不应被 A 的操作清掉");
});

test("未读数可查询", () => {
  messages.clear();
  messages.push({ eventId: "u1", type: messages.TYPE.COLLECT, title: "X" });
  assert.equal(messages.unreadCount(), 1);
  messages.markAllRead();
  assert.equal(messages.unreadCount(), 0);
});

test("删除单条消息", () => {
  messages.clear();
  const m = messages.push({ eventId: "d1", type: messages.TYPE.COLLECT, title: "X" });
  assert.equal(messages.remove(m.id).ok, true);
  assert.equal(messages.get(m.id), null);
});

test("订阅者能收到消息", () => {
  let seen = null;
  const off = messages.subscribe((m) => { seen = m; });
  const m = messages.push({ eventId: "s1", type: messages.TYPE.COLLECT, title: "订阅" });
  assert.ok(seen && seen.id === m.id);
  off();
});
