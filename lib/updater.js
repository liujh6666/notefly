/*
 * NoteFly 更新检查（服务端）
 * ------------------------------------------------------------
 * 负责「检查」这一半：读 GitHub Releases、判断有没有新版本、挑出匹配
 * 当前系统的安装包。下载与安装由 Electron 主进程执行（那边才有权限
 * 替换程序文件）。
 *
 * 三条底线：
 *  1. 只认 GitHub Releases 里「已发布的正式版本」。draft 与预发布不参与
 *     默认升级（预发布需要用户在设置里显式打开）。
 *  2. 比较用 SemVer：正确处理 v 前缀、相同版本、旧版本、预发布。
 *     默认不升级测试版，也不降级。
 *  3. 离线、超时、限流、仓库不可达 → 一律显示「检查失败」，
 *     绝不能显示「已是最新版」。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* 检查超时 */
const CHECK_TIMEOUT_MS = 15000;
/* 单次请求的 User-Agent（GitHub API 要求） */
const UA = "NoteFly-Desktop";

/* ==================== SemVer ==================== */

/**
 * 解析版本号
 * @param {string} v 支持 "1.2.3" / "v1.2.3" / "1.2.3-beta.1"
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],raw:string}|null}
 */
function parseSemver(v) {
  const s = String(v == null ? "" : v).trim().replace(/^v/i, "");
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
    build: m[5] || "",
    raw: s,
  };
}

/** 是否为合法版本号 */
function isValidVersion(v) {
  return !!parseSemver(v);
}

/**
 * 比较两个版本
 * @returns {number} -1 表示 a < b，0 相等，1 表示 a > b
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  /* 有预发布标记的版本低于同号正式版 */
  if (pa.prerelease.length && !pb.prerelease.length) return -1;
  if (!pa.prerelease.length && pb.prerelease.length) return 1;
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (nx !== ny) {
      /* 数字标识优先级低于字母标识 */
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 是否为预发布版本 */
function isPrerelease(v) {
  const p = parseSemver(v);
  return !!(p && p.prerelease.length);
}

/* ==================== 仓库配置 ==================== */

/**
 * 解析仓库地址 → { owner, repo }
 * 支持 "owner/repo" / "https://github.com/owner/repo" / "git+https://..."
 */
function parseRepo(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  const u = s.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/)?$/i);
  if (u) return { owner: u[1], repo: u[2] };
  return null;
}

/**
 * 读取仓库配置。
 * 优先级：环境变量 NOTEFLY_UPDATE_REPO > data/config.json 的 update.repo
 *          > package.json 的 repository 字段
 * 都读不到时返回空，由调用方提示用户去填写（不编造地址）。
 */
function resolveRepo(ctx) {
  const c = ctx && typeof ctx.getConfig === "function" ? ctx.getConfig() : {};
  const fromConfig = c && c.update && c.update.repo ? c.update.repo : "";
  const fromEnv = process.env.NOTEFLY_UPDATE_REPO || "";
  const fromPkg = readPackageRepo();

  const candidates = [
    { source: "环境变量 NOTEFLY_UPDATE_REPO", value: fromEnv },
    { source: "设置项「更新 → 仓库地址」", value: fromConfig },
    { source: "package.json 的 repository 字段", value: fromPkg },
  ];
  for (const c2 of candidates) {
    if (!c2.value) continue;
    const p = parseRepo(c2.value);
    if (p) return Object.assign({ source: c2.source }, p);
  }
  return null;
}

/** 从 package.json 读 repository */
function readPackageRepo() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const j = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const r = j.repository;
    if (!r) return "";
    if (typeof r === "string") return r;
    if (typeof r === "object" && r.url) return r.url;
    return "";
  } catch {
    return "";
  }
}

/* ==================== 平台与资源匹配 ==================== */

/**
 * 判断当前系统需要哪种安装包
 * @returns {{platform:string, arch:string, kind:string, label:string}}
 */
function currentTarget() {
  const platform = process.platform;   // win32 / darwin / linux
  const arch = process.arch;           // x64 / arm64 / ia32
  if (platform === "win32") {
    return { platform, arch, kind: "nsis", label: "Windows 安装包（.exe）" };
  }
  if (platform === "darwin") {
    return { platform, arch, kind: "dmg", label: "macOS 安装包（.dmg）" };
  }
  return { platform, arch, kind: "appimage", label: "Linux 安装包（.AppImage）" };
}

/**
 * 从 Release 的 assets 里挑出匹配当前系统的安装包
 * @param {object} release GitHub Release 对象
 * @param {{platform?:string, arch?:string, kind?:string}} target
 * @returns {{ok:boolean, asset?:object, reason?:string}}
 */
function matchAsset(release, target) {
  const t = Object.assign({}, currentTarget(), target || {});
  const assets = (release && release.assets) || [];
  if (!assets.length) {
    return { ok: false, reason: "该版本没有附带任何安装包（可能是只发布源码的版本）" };
  }

  const exts = {
    win32: [".exe", ".msi"],
    darwin: [".dmg", ".zip", ".pkg"],
    linux: [".AppImage", ".appimage", ".deb", ".rpm"],
  }[t.platform] || [];

  /* 架构关键词：x64 兼容 arm64 的部分场景，这里按明确匹配 */
  const archTokens = {
    x64: ["x64", "x86_64", "amd64", "win64", "win-x64"],
    arm64: ["arm64", "aarch64", "mac-arm64"],
    ia32: ["ia32", "x86", "i386"],
  }[t.arch] || [];

  const candidates = assets.filter((a) => {
    const name = String(a.name || "").toLowerCase();
    if (!exts.some((e) => name.endsWith(e))) return false;
    /* 有架构标识时必须匹配；没有标识（通用包）也算匹配 */
    const hasOtherArch = ["x64", "amd64", "arm64", "aarch64", "ia32", "i386"]
      .some((tk) => name.includes(tk) && !archTokens.some((at) => name.includes(at)));
    if (hasOtherArch) return false;
    return true;
  });

  if (!candidates.length) {
    const names = assets.map((a) => a.name).join("、");
    return {
      ok: false,
      reason: `该版本没有适配当前系统的安装包（需要 ${t.label}，${t.arch}）。该版本提供的文件：${names}`,
    };
  }
  /* 优先 dmg（macOS 用户体验更好），其次 zip */
  if (t.platform === "darwin") {
    const dmg = candidates.find((a) => String(a.name).toLowerCase().endsWith(".dmg"));
    if (dmg) return { ok: true, asset: dmg };
  }
  return { ok: true, asset: candidates[0] };
}

/* ==================== GitHub API ==================== */

/**
 * 请求 GitHub Releases
 * @returns {Promise<{ok:boolean, releases?:Array, error?:string, code?:string, rateLimit?:object}>}
 */
async function fetchReleases(repo, opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : CHECK_TIMEOUT_MS;
  const perPage = Math.max(1, Math.min(Number(o.perPage) || 30, 100));
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/releases?per_page=${perPage}`;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
  let res, text = "";
  try {
    res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller ? controller.signal : undefined,
    });
    text = await res.text();
  } catch (e) {
    if (timer) clearTimeout(timer);
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    return {
      ok: false,
      error: aborted
        ? `检查更新超时（${Math.round(timeoutMs / 1000)} 秒未响应）`
        : "连不上 GitHub，请检查网络连接或代理设置：" + String((e && e.message) || e),
      code: aborted ? "timeout" : "network",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }

  if (!res.ok) {
    const remaining = res.headers && res.headers.get ? res.headers.get("x-ratelimit-remaining") : null;
    const reset = res.headers && res.headers.get ? res.headers.get("x-ratelimit-reset") : null;
    if (res.status === 403 || res.status === 429) {
      const resetText = reset
        ? `（配额将在 ${new Date(Number(reset) * 1000).toLocaleString("zh-CN", { hour12: false })} 恢复）`
        : "";
      return {
        ok: false,
        error: `GitHub 访问受限（HTTP ${res.status}），多半是请求太频繁${resetText}`,
        code: "rate_limited",
        rateLimit: { remaining, reset },
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        error: `仓库 ${repo.owner}/${repo.repo} 不存在或不是公开仓库（HTTP 404）`,
        code: "repo_not_found",
      };
    }
    const detail = body && body.message ? String(body.message) : text.slice(0, 160);
    return {
      ok: false,
      error: `GitHub 返回 HTTP ${res.status}：${detail}`,
      code: "http_error",
    };
  }

  if (!Array.isArray(body)) {
    return { ok: false, error: "GitHub 返回的数据格式异常", code: "bad_payload" };
  }
  return { ok: true, releases: body };
}

/**
 * 从 Release 列表里挑出「应该升级到」的版本
 * @param {Array} releases GitHub 返回的原始列表
 * @param {string} currentVersion
 * @param {{allowPrerelease?:boolean, includeDraft?:boolean}} opts
 */
function pickTarget(releases, currentVersion, opts) {
  const o = opts || {};
  const cur = parseSemver(currentVersion);
  if (!cur) {
    return { ok: false, reason: `当前版本号「${currentVersion}」不是合法的 SemVer，无法比较` };
  }
  const list = (releases || []).filter((r) => {
    if (!o.includeDraft && r.draft) return false;
    if (!o.allowPrerelease && r.prerelease) return false;
    return isValidVersion(r.tag_name || r.name);
  });
  if (!list.length) {
    return { ok: false, reason: "仓库里没有可用于升级的正式发布版本（草稿与预发布不参与）" };
  }
  /* 同一仓库里可能同时存在 tag 与 release，tag_name 优先 */
  const candidates = list.map((r) => Object.assign({}, r, { version: String(r.tag_name || r.name).replace(/^v/i, "") }));
  /* 只允许升级：版本必须严格大于当前版本 */
  const newer = candidates.filter((r) => compareSemver(r.version, currentVersion) > 0);
  if (!newer.length) {
    const latest = candidates.slice().sort((a, b) => compareSemver(b.version, a.version))[0];
    return {
      ok: false,
      reason: "当前已是最新版本",
      latest: latest ? { version: latest.version, publishedAt: latest.published_at } : null,
      upToDate: true,
    };
  }
  newer.sort((a, b) => compareSemver(b.version, a.version));
  return { ok: true, release: newer[0] };
}

/**
 * 完整的检查流程
 * @param {{repo:{owner:string,repo:string}, currentVersion:string,
 *          allowPrerelease?:boolean, timeoutMs?:number, target?:object}} opts
 */
async function check(opts) {
  const o = opts || {};
  const repo = o.repo;
  if (!repo || !repo.owner || !repo.repo) {
    return { ok: false, code: "no_repo", error: "没有配置更新仓库地址，请在「设置 → 更新」里填写 owner/repo" };
  }
  const fetched = await fetchReleases(repo, { timeoutMs: o.timeoutMs });
  if (!fetched.ok) return Object.assign({ ok: false }, fetched);

  const picked = pickTarget(fetched.releases, o.currentVersion, { allowPrerelease: !!o.allowPrerelease });
  if (!picked.ok) {
    return {
      ok: false,
      code: picked.upToDate ? "up_to_date" : "no_candidate",
      error: picked.reason,
      upToDate: !!picked.upToDate,
      latest: picked.latest || null,
    };
  }
  const release = picked.release;
  const matched = matchAsset(release, o.target);
  return {
    ok: true,
    repo,
    currentVersion: o.currentVersion,
    version: release.version,
    tagName: release.tag_name,
    name: release.name || release.version,
    publishedAt: release.published_at || "",
    prerelease: !!release.prerelease,
    notes: String(release.body || ""),
    url: release.html_url || "",
    asset: matched.ok ? {
      name: matched.asset.name,
      size: matched.asset.size,
      url: matched.asset.browser_download_url,
      downloadCount: matched.asset.download_count,
      contentType: matched.asset.content_type,
    } : null,
    assetError: matched.ok ? "" : matched.reason,
    hasInstallablePackage: matched.ok,
  };
}

/**
 * 版本历史（给「更新记录」时间轴用）
 * @param {{repo, page?:number, perPage?:number, timeoutMs?:number}} opts
 */
async function history(opts) {
  const o = opts || {};
  const repo = o.repo;
  if (!repo || !repo.owner || !repo.repo) {
    return { ok: false, code: "no_repo", error: "没有配置更新仓库地址" };
  }
  const page = Math.max(1, Number(o.page) || 1);
  const perPage = Math.max(1, Math.min(Number(o.perPage) || 20, 100));
  const fetched = await fetchReleases(repo, { timeoutMs: o.timeoutMs, perPage });
  if (!fetched.ok) return Object.assign({ ok: false }, fetched);

  const items = (fetched.releases || [])
    /* 过滤草稿；预发布默认也不展示在正式时间轴里 */
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      version: String(r.tag_name || r.name || "").replace(/^v/i, ""),
      tagName: r.tag_name || "",
      name: r.name || "",
      publishedAt: r.published_at || "",
      notes: String(r.body || ""),
      url: r.html_url || "",
      assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
    }))
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

  return { ok: true, items, page, perPage, hasMore: items.length >= perPage };
}

module.exports = {
  CHECK_TIMEOUT_MS,
  parseSemver,
  isValidVersion,
  compareSemver,
  isPrerelease,
  parseRepo,
  resolveRepo,
  readPackageRepo,
  currentTarget,
  matchAsset,
  fetchReleases,
  pickTarget,
  check,
  history,
};
