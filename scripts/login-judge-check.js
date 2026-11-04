/*
 * 验证：通用适配器的登录态 DOM 判据不再把「未登录」误判成「已登录」
 * 运行：node scripts/login-judge-check.js
 *
 * 误判根因（旧判据）：只要页面里存在 class 含 avatar / user-info 的元素就算已登录。
 * 现代站点未登录时也有游客默认头像占位 → 一律误判成「已登录」。
 * 新判据要求「确凿证据」：退出入口 / 用户昵称 / 指向个人主页的头像链接。
 */
const { chromium } = require("playwright");
const path = require("path");

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

/* 判据从 engines/rpa.js 里搬过来（同一份逻辑，抽出来是为了能单测） */
const JUDGE = `
(() => {
  const txtOf = (el) => ((el && (el.innerText || el.textContent)) || "").trim();
  const clsOf = (el) => {
    const c = el && el.className;
    if (!c) return "";
    return typeof c === "string" ? c : (c.baseVal || c.toString ? c.toString() : "");
  };
  const url = location.href;
  if (/login|signin|passport/i.test(url)) return false;

  const entrySel = 'a,button,[role="button"],span[class*="login"],div[class*="login"],a[href*="signin"],a[href*="register"]';
  for (const el of document.querySelectorAll(entrySel)) {
    const sig = (clsOf(el) + " " + (el.getAttribute("href") || "") + " " + (el.getAttribute("id") || ""));
    if (/\\b(login|signin|sign-in|passport|register)\\b/i.test(sig)) return false;
    const t = txtOf(el);
    if (/^(登录|注册|登陆|立即登录|免费注册|登录\\/注册|新用户注册|sign in|log in|sign up)$/i.test(t)) return false;
  }

  for (const el of document.querySelectorAll("a,button,span,div,li")) {
    if (/^(退出登录|退出|登出|退出账号|logout|sign out|log out)$/i.test(txtOf(el))) return true;
  }
  for (const el of document.querySelectorAll(
    '[class*="nickname"],[class*="user-name"],[class*="userName"],[class*="username"],[class*="header-user"],[class*="account-name"]'
  )) {
    const t = txtOf(el);
    if (t && t.length <= 24 && !/^(登录|注册|游客|未登录|立即登录)$/.test(t)) return true;
  }
  for (const el of document.querySelectorAll(
    '[class*="avatar"],[class*="user-info"],[class*="userInfo"],[class*="header-user"],img[class*="avatar"]'
  )) {
    const link = el.closest && el.closest("a[href]");
    if (link) {
      const href = link.getAttribute("href") || "";
      if (/\\/(user|my|member|profile|author|space|account|creator)(\\/|$|\\?)/i.test(href) && !/login|signin/i.test(href)) return true;
    }
    const t = txtOf(el);
    if (t && !/^(登录|注册|游客|未登录)$/.test(t)) return true;
  }
  return false;
})()
`;

/* 页面样例：覆盖各种真实站点结构 */
const PAGES = [
  {
    name: "未登录：顶栏有游客头像占位 + 登录按钮",
    html: `<div class="header"><a href="/login" class="login-btn">登录</a><img class="avatar" src="/guest.png"></div>`,
    expect: false,
  },
  {
    name: "未登录：只有图标登录按钮（无文字）+ 头像占位",
    html: `<div class="header"><a class="login-icon" href="/signin"><svg></svg></a><span class="user-avatar"></span></div>`,
    expect: false,
  },
  {
    name: "未登录：class 带 login 的按钮但文字是别的",
    html: `<div class="header"><button class="login-entry">立即登录</button><div class="user-info"><img class="avatar"></div></div>`,
    expect: false,
  },
  {
    name: "未登录：跳到登录页",
    html: `<div>请登录</div>`,
    url: "https://example.com/login",
    expect: false,
  },
  {
    name: "已登录：顶栏有昵称",
    html: `<div class="header-user"><span class="user-name">张三</span></div>`,
    expect: true,
  },
  {
    name: "已登录：有退出登录按钮",
    html: `<div class="header"><span class="avatar">李</span><a href="/logout">退出登录</a></div>`,
    expect: true,
  },
  {
    name: "已登录：头像链接指向个人主页",
    html: `<div class="header"><a href="/user/1024"><img class="avatar"></a></div>`,
    expect: true,
  },
  {
    name: "已登录：user-info 块里有真实昵称文本",
    html: `<div class="user-info"><span>技术博主</span></div>`,
    expect: true,
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const p of PAGES) {
    const url = p.url || "https://example.com/home";
    await page.goto(url.replace(/\/$/, "") + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.setContent(p.html);
    const got = await page.evaluate(JUDGE);
    check(p.name, got === p.expect, `判定=${got}，期望=${p.expect}`);
  }

  await browser.close();
  console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
