/*
 * 文章抽取 + HTML 净化 单元测试
 * 覆盖：正文识别、验证码/登录页判定、脚本清除、实体解码
 */
const test = require("node:test");
const assert = require("node:assert");

const extractor = require("../lib/article-extract");
const sanitizer = require("../lib/html-sanitize");

const WECHAT_HTML = `<!DOCTYPE html><html><head>
<title>云原生数据库的三个关键取舍</title>
<meta property="og:site_name" content="某某科技">
</head><body>
<div id="js_article" class="rich_media">
  <div id="js_content" style="visibility: hidden;">
    <p>在过去的半年里，我们把核心业务系统迁移到了云原生数据库。</p>
    <p>第一是数据一致性边界。我们没有追求全局强一致，而是把一致性收敛到单个租户内部。</p>
    <p>第二是连接管理。连接池不再是配置项，而是随扩缩容自动伸缩的运行时行为。</p>
    <p>需要说明的是，上面的数据来自我们自己的生产环境，仅供参考。</p>
    <script>alert('xss')</script>
  </div>
</div>
<div class="recommend"><p>推荐阅读：别的文章</p></div>
</body></html>`;

test("公众号文章能抽出正文与标题", () => {
  const r = extractor.extractArticle(WECHAT_HTML, { finalUrl: "https://mp.weixin.qq.com/s/abc" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.title, "云原生数据库的三个关键取舍");
  assert.ok(r.bodyText.includes("云原生数据库"));
  assert.ok(r.bodyText.includes("连接管理"));
});

test("抽出的正文不含脚本与推荐内容", () => {
  const r = extractor.extractArticle(WECHAT_HTML, { finalUrl: "https://mp.weixin.qq.com/s/abc" });
  assert.ok(!r.bodyText.includes("alert"), "脚本内容必须被清除");
  assert.ok(!r.bodyText.includes("推荐阅读"), "无关推荐必须被清除");
});

test("验证码页判为失败，不能当成功", () => {
  const html = "<html><head><title>环境异常</title></head><body>完成验证后即可继续访问</body></html>";
  const r = extractor.extractArticle(html, { finalUrl: "https://x.com/a" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "blocked_page");
});

test("登录页判为失败", () => {
  const html = "<html><head><title>登录</title></head><body>登录后即可查看全部内容</body></html>";
  const r = extractor.extractArticle(html, { finalUrl: "https://x.com/a" });
  assert.equal(r.ok, false);
});

test("已删除文章判为失败", () => {
  const html = "<html><body>该内容已被发布者删除</body></html>";
  const r = extractor.extractArticle(html, { finalUrl: "https://x.com/a" });
  assert.equal(r.ok, false);
});

test("只有标题没有正文判为失败（不能算成功）", () => {
  const html = "<html><head><title>只有一个标题</title></head><body><div>短</div></body></html>";
  const r = extractor.extractArticle(html, { finalUrl: "https://x.com/a" });
  assert.equal(r.ok, false, "没有正文必须失败");
  assert.equal(r.code, "no_content");
});

test("空页面判为失败", () => {
  const r = extractor.extractArticle("", {});
  assert.equal(r.ok, false);
});

test("内容类型能按关键词区分", () => {
  assert.equal(extractor.guessContentType("本次活动大会将于本月举办"), "event");
  assert.equal(extractor.guessContentType("我们的产品新版本上线了"), "product");
  assert.equal(extractor.guessContentType("某客户成功落地的实践案例"), "case");
  assert.equal(extractor.guessContentType("关于我们公司使命与愿景"), "company");
  assert.equal(extractor.guessContentType("一点普通的想法"), "opinion");
});

test("净化：去掉 script 与 on* 事件", () => {
  const out = sanitizer.sanitizeHtml('<div onclick="x()"><script>bad()</script>正文</div>');
  assert.ok(!out.includes("script"));
  assert.ok(!out.includes("onclick"));
  assert.ok(out.includes("正文"));
});

test("净化：去掉 javascript: 链接", () => {
  const out = sanitizer.sanitizeHtml('<a href="javascript:alert(1)">点</a>');
  assert.ok(!out.toLowerCase().includes("javascript:"));
});

test("净化：保留 http 链接", () => {
  const out = sanitizer.sanitizeHtml('<a href="https://example.com/a">链接</a>');
  assert.ok(out.includes("https://example.com/a"));
});

test("净化：去掉 position/float/display 等布局样式", () => {
  const out = sanitizer.sanitizeHtml('<p style="position:fixed;color:red">文字</p>');
  assert.ok(!out.includes("position"), "布局类样式必须被去掉");
  assert.ok(out.includes("color"), "安全的样式属性要保留");
});

test("净化：去掉 data: 图片", () => {
  const out = sanitizer.sanitizeHtml('<img src="data:text/html;base64,xxx" />');
  assert.ok(!out.includes("data:text/html"));
});

test("HTML 转文本：保留段落与列表结构", () => {
  const t = sanitizer.htmlToText("<p>第一段</p><p>第二段</p><ul><li>项目一</li></ul>");
  assert.ok(t.includes("第一段"));
  assert.ok(t.includes("第二段"));
  assert.ok(t.includes("- 项目一"), "列表要保留列表标记");
});

test("HTML 转文本：解码常见实体", () => {
  const t = sanitizer.htmlToText("<p>A&amp;B&nbsp;C</p>");
  assert.ok(t.includes("A&B"));
  assert.ok(t.includes("C"));
});

/* ---- 嵌套容器抽取（对应验收问题 5：正文截断却返回成功）----
 * 旧实现 `([\s\S]*?)<\/tag>` 在第一个同名闭合标签就截断，
 * 长开头让最小长度检查通过 → 不完整正文被当作成功。 */
test("嵌套抽取：#id 容器里的同名子标签不能截断正文", () => {
  const html = [
    '<html><head><title>嵌套测试</title></head><body>',
    '<div id="js_content">',
    '<div>这是足够长的开头段落，用来描述背景与上下文，重复填充以保证超过最小正文长度检查线。',
    '继续补充一句，让开头部分明确超过八十字的阈值，模拟真实的公众号文章首段内容。</div>',
    '<p>重要结论和后续正文：迁移必须在演练之后执行。</p>',
    '<p>末段：全文完。</p>',
    '</div>',
    '</body></html>',
  ].join("");
  const inner = extractor.extractBySelector(html, "#js_content");
  assert.ok(inner.includes("足够长的开头"), "首段必须在");
  assert.ok(inner.includes("重要结论和后续正文"), "嵌套 div 之后的段落不能被截掉");
  assert.ok(inner.includes("末段：全文完"), "容器末尾不能被截掉");

  const r = extractor.extractArticle(html, { finalUrl: "https://mp.weixin.qq.com/s/x" });
  assert.equal(r.ok, true);
  assert.ok(r.bodyText.includes("重要结论"), "完整正文必须包含中段");
  assert.ok(r.bodyText.includes("末段"), "完整正文必须包含末段");
});

test("嵌套抽取：多层 section 嵌套也能配平", () => {
  const html = [
    '<body>',
    '<section class="rich_media_content">',
    '<section><section><p>第一层深处的开头文字，写得很长很长，主要用来占位超过最小长度阈值线，',
    '再补一句确保长度达标，模拟真实文章开头段落的样子。</p></section></section>',
    '<p>中段关键句：配置中心是稳定性的前提。</p>',
    '</section>',
    '</body>',
  ].join("");
  const inner = extractor.extractBySelector(html, ".rich_media_content");
  assert.ok(inner.includes("中段关键句"), "多层嵌套后内容必须完整");
});

test("嵌套抽取：属性值里的 > 与自闭合标签不干扰配平", () => {
  const html = [
    '<div id="js_content" data-x="a > b">',
    '<p>开头段落，写得足够长以便通过正文最小长度检查，这里继续补充内容保证长度超过阈值。',
    '再补充一行让首段长度超过八十字，模拟真实长文的开头。</p>',
    '<img src="https://example.com/a.png"/>',
    '<p>结论段：图片之后的文字必须在。</p>',
    '</div>',
  ].join("");
  const inner = extractor.extractBySelector(html, "#js_content");
  assert.ok(inner.includes("结论段"), "自闭合 img 之后的段落必须在");
});

test("article 标签选择器：嵌套 article 不截断", () => {
  const html = [
    '<article>',
    '<article>作者简介：某人，长期写数据库相关内容，这里写足够长的简介文字来确保',
    '这段文字单独看也能超过最小长度线，继续补充内容。</article>',
    '<p>正文真正的结尾：总结陈词。</p>',
    '</article>',
  ].join("");
  const inner = extractor.extractBySelector(html, "article");
  assert.ok(inner.includes("正文真正的结尾"), "内层 article 闭合后外层必须继续");
});
