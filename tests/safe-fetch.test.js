/*
 * 安全抓取 单元测试
 * 覆盖：SSRF 防护、协议限制、私有网段判定、链接归一
 */
const test = require("node:test");
const assert = require("node:assert");

const safeFetch = require("../lib/safe-fetch");

test("只允许 http/https", () => {
  assert.equal(safeFetch.checkURL("https://example.com/a").ok, true);
  assert.equal(safeFetch.checkURL("http://example.com/a").ok, true);
  for (const bad of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "data:text/html,x"]) {
    const r = safeFetch.checkURL(bad);
    assert.equal(r.ok, false, bad + " 必须被拒绝");
    assert.match(r.error, /协议/);
  }
});

test("拒绝回环与本机主机名", () => {
  for (const bad of ["http://localhost/a", "http://127.0.0.1/a", "http://127.0.0.1:3210/api/config", "http://0.0.0.0/"]) {
    assert.equal(safeFetch.checkURL(bad).ok, false, bad + " 必须被拒绝");
  }
});

test("拒绝私有网段 IP 字面量", () => {
  for (const bad of [
    "http://10.0.0.1/", "http://172.16.0.1/", "http://172.31.255.1/",
    "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/", "http://[fe80::1]/",
  ]) {
    const r = safeFetch.checkURL(bad);
    assert.equal(r.ok, false, bad + " 必须被拒绝");
  }
});

test("拒绝云元数据主机名", () => {
  assert.equal(safeFetch.checkURL("http://metadata.google.internal/").ok, false);
});

test("拒绝 .local / .internal 后缀", () => {
  assert.equal(safeFetch.checkURL("http://db.local/").ok, false);
  assert.equal(safeFetch.checkURL("http://svc.internal/").ok, false);
});

test("公网地址允许", () => {
  assert.equal(safeFetch.checkURL("https://mp.weixin.qq.com/s/abc").ok, true);
  assert.equal(safeFetch.checkURL("https://8.8.8.8/").ok, true);
});

test("私有网段判定函数", () => {
  assert.equal(safeFetch.isPrivateIPv4("127.0.0.1"), true);
  assert.equal(safeFetch.isPrivateIPv4("10.1.2.3"), true);
  assert.equal(safeFetch.isPrivateIPv4("172.20.0.1"), true);
  assert.equal(safeFetch.isPrivateIPv4("172.32.0.1"), false, "172.32 不在私有段内");
  assert.equal(safeFetch.isPrivateIPv4("192.168.0.1"), true);
  assert.equal(safeFetch.isPrivateIPv4("8.8.8.8"), false);
  assert.equal(safeFetch.isPrivateIPv6("::1"), true);
  assert.equal(safeFetch.isPrivateIPv6("::ffff:127.0.0.1"), true, "IPv4 映射地址要按 IPv4 判");
  assert.equal(safeFetch.isPrivateIPv6("2606:4700::1111"), false);
});

test("链接归一：去掉追踪参数与 hash", () => {
  const a = safeFetch.normalizeUrl("https://mp.weixin.qq.com/s/abc?from=x&utm_source=y&scene=25#rd");
  const b = safeFetch.normalizeUrl("https://mp.weixin.qq.com/s/abc");
  assert.equal(a, b, "追踪参数与 hash 不应影响去重");
});

test("链接归一：参数顺序不同视为同一链接", () => {
  const a = safeFetch.normalizeUrl("https://x.com/p?b=2&a=1");
  const b = safeFetch.normalizeUrl("https://x.com/p?a=1&b=2");
  assert.equal(a, b);
});

test("链接归一：不同路径不被合并", () => {
  const a = safeFetch.normalizeUrl("https://x.com/p1");
  const b = safeFetch.normalizeUrl("https://x.com/p2");
  assert.notEqual(a, b);
});

test("非法链接不抛异常", () => {
  const r = safeFetch.checkURL("这不是链接");
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
