/*
 * 更新模块 单元测试
 * 覆盖：SemVer 比较、预发布处理、资源匹配、仓库解析、更新目标筛选
 */
const test = require("node:test");
const assert = require("node:assert");

const updater = require("../lib/updater");

test("SemVer 解析：支持 v 前缀与预发布标记", () => {
  const p = updater.parseSemver("v1.2.3");
  assert.equal(p.major, 1);
  assert.equal(p.minor, 2);
  assert.equal(p.patch, 3);
  assert.deepEqual(p.prerelease, []);
  assert.ok(updater.parseSemver("1.2.3-beta.1").prerelease.length === 2);
  assert.equal(updater.parseSemver("不是版本"), null);
});

test("SemVer 比较：相同版本相等", () => {
  assert.equal(updater.compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(updater.compareSemver("v1.0.0", "1.0.0"), 0, "v 前缀不参与比较");
});

test("SemVer 比较：新旧版本判定正确", () => {
  assert.equal(updater.compareSemver("1.0.1", "1.0.0"), 1);
  assert.equal(updater.compareSemver("1.1.0", "1.0.9"), 1);
  assert.equal(updater.compareSemver("2.0.0", "1.99.99"), 1);
  assert.equal(updater.compareSemver("1.0.0", "1.0.1"), -1);
  assert.equal(updater.compareSemver("0.9.0", "1.0.0"), -1);
});

test("SemVer 比较：预发布版本低于同号正式版", () => {
  assert.equal(updater.compareSemver("1.0.0-beta", "1.0.0"), -1);
  assert.equal(updater.compareSemver("1.0.0", "1.0.0-beta"), 1);
  assert.equal(updater.compareSemver("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(updater.compareSemver("1.0.0-beta.2", "1.0.0-beta.10"), -1);
});

test("预发布判定", () => {
  assert.equal(updater.isPrerelease("1.0.0-beta"), true);
  assert.equal(updater.isPrerelease("v1.0.0"), false);
});

test("仓库地址解析：支持简写与完整链接", () => {
  assert.deepEqual(updater.parseRepo("liujh6666/notefly"), { owner: "liujh6666", repo: "notefly" });
  assert.deepEqual(updater.parseRepo("https://github.com/liujh6666/notefly"), { owner: "liujh6666", repo: "notefly" });
  assert.deepEqual(updater.parseRepo("https://github.com/liujh6666/notefly.git"), { owner: "liujh6666", repo: "notefly" });
  assert.deepEqual(updater.parseRepo("git+https://github.com/liujh6666/notefly.git"), { owner: "liujh6666", repo: "notefly" });
  assert.equal(updater.parseRepo(""), null);
  assert.equal(updater.parseRepo("不是仓库"), null);
});

test("仓库配置优先读设置项，其次读 package.json", () => {
  const r1 = updater.resolveRepo({ getConfig: () => ({ update: { repo: "aaa/bbb" } }) });
  assert.equal(r1.owner, "aaa");
  assert.equal(r1.repo, "bbb");
  /* package.json 里配了 repository（项目实际仓库） */
  const r2 = updater.resolveRepo({ getConfig: () => ({ update: { repo: "" } }) });
  assert.ok(r2, "应能从 package.json 读到仓库");
  assert.equal(r2.owner, "liujh6666");
  assert.equal(r2.repo, "notefly");
});

test("资源匹配：Windows 挑 .exe 且架构要对", () => {
  const release = {
    assets: [
      { name: "NoteFly-1.8.0-x64-setup.exe", size: 100, browser_download_url: "u1" },
      { name: "NoteFly-1.8.0-arm64-setup.exe", size: 100, browser_download_url: "u2" },
    ],
  };
  const m = updater.matchAsset(release, { platform: "win32", arch: "x64", kind: "nsis" });
  assert.equal(m.ok, true);
  assert.equal(m.asset.name, "NoteFly-1.8.0-x64-setup.exe");
});

test("资源匹配：macOS 优先 dmg", () => {
  const release = {
    assets: [
      { name: "NoteFly-1.8.0-x64.zip", size: 100, browser_download_url: "u1" },
      { name: "NoteFly-1.8.0-arm64.dmg", size: 100, browser_download_url: "u2" },
    ],
  };
  const m = updater.matchAsset(release, { platform: "darwin", arch: "arm64", kind: "dmg" });
  assert.equal(m.ok, true);
  assert.equal(m.asset.name, "NoteFly-1.8.0-arm64.dmg");
});

test("资源匹配：没有匹配包时说明原因，不静默", () => {
  const release = { assets: [{ name: "source.zip", size: 1, browser_download_url: "u" }] };
  const m = updater.matchAsset(release, { platform: "win32", arch: "x64", kind: "nsis" });
  assert.equal(m.ok, false);
  assert.match(m.reason, /没有适配|安装包/);
});

test("资源匹配：没有任何资源时说明原因", () => {
  const m = updater.matchAsset({ assets: [] }, { platform: "win32", arch: "x64" });
  assert.equal(m.ok, false);
  assert.match(m.reason, /安装包/);
});

test("挑选更新目标：只升级到更高的正式版", () => {
  const releases = [
    { tag_name: "v1.9.0", draft: false, prerelease: false, published_at: "2026-01-02T00:00:00Z", assets: [] },
    { tag_name: "v1.8.0", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z", assets: [] },
    { tag_name: "v2.0.0-beta", draft: false, prerelease: true, published_at: "2026-01-03T00:00:00Z", assets: [] },
    { tag_name: "v3.0.0", draft: true, prerelease: false, published_at: "2026-01-04T00:00:00Z", assets: [] },
  ];
  const p = updater.pickTarget(releases, "1.8.0");
  assert.equal(p.ok, true);
  assert.equal(p.release.version, "1.9.0", "预发布与草稿不参与默认升级");
});

test("挑选更新目标：已是最新时明确说 upToDate", () => {
  const releases = [
    { tag_name: "v1.8.0", draft: false, prerelease: false, published_at: "", assets: [] },
  ];
  const p = updater.pickTarget(releases, "1.8.0");
  assert.equal(p.ok, false);
  assert.equal(p.upToDate, true);
});

test("挑选更新目标：不会降级", () => {
  const releases = [
    { tag_name: "v1.0.0", draft: false, prerelease: false, published_at: "", assets: [] },
    { tag_name: "v1.5.0", draft: false, prerelease: false, published_at: "", assets: [] },
  ];
  const p = updater.pickTarget(releases, "1.5.0");
  assert.equal(p.upToDate, true, "当前版本高于所有候选时不应降级");
});

test("挑选更新目标：允许预发布时可拿到预发布版", () => {
  const releases = [
    { tag_name: "v2.0.0-beta", draft: false, prerelease: true, published_at: "", assets: [] },
    { tag_name: "v1.9.0", draft: false, prerelease: false, published_at: "", assets: [] },
  ];
  const p = updater.pickTarget(releases, "1.9.0", { allowPrerelease: true });
  assert.equal(p.ok, true);
  assert.equal(p.release.version, "2.0.0-beta");
});

test("挑选更新目标：非法当前版本时报错而不是当成最新", () => {
  const p = updater.pickTarget([{ tag_name: "v1.0.0" }], "abc");
  assert.equal(p.ok, false);
  assert.match(p.reason, /SemVer/);
});

test("检查流程：没有配置仓库时明确报错", async () => {
  const r = await updater.check({ repo: null, currentVersion: "1.0.0" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_repo");
  assert.match(r.error, /owner\/repo/);
});
