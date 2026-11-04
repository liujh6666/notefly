/*
 * 内容保存：把“构建请求体 + 判断成败”从界面里拆出来，便于回归测试。
 * 约定：只有持久化成功才返回 ok:true；失败时调用方必须保留编辑页与正文。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NFContent = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 表单 → 接口请求体（字段裁剪与类型归一都放这里） */
  function buildPayload(form) {
    const f = form || {};
    const tags = String(f.tagsStr == null ? "" : f.tagsStr)
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const body = {
      type: f.type || "ARTICLE",
      title: String(f.title == null ? "" : f.title).trim(),
      digest: f.digest || "",
      body: f.body || "",
      cover: f.cover || "",
      tags,
      video: "",
      audio: "",
      /* 公众号排版：模板 id（空 = 普通文章）。type 仍是 ARTICLE ——
         平台适配器按 contentType 严格匹配，新增类型会导致所有平台发布失败，
         所以「公众号文章」是形态差异，不是内容类型差异。 */
      gzhTheme: f.gzhTheme || "",
      /* 草稿标记：true = 还在写，未定稿；「保存」（定稿）会清掉它 */
      draft: !!f.draft,
    };
    if (body.type === "VIDEO") body.video = f.media || "";
    if (body.type === "PODCAST") body.audio = f.media || "";
    return body;
  }

  /** 本地前置校验：明显不合法就不发请求，避免“空标题保存成功” */
  function validate(form) {
    const p = buildPayload(form);
    if (!p.title && !p.body.trim()) return { ok: false, error: "标题和正文都是空的，没有可保存的内容" };
    if (p.title.length > 120) return { ok: false, error: "标题超过 120 字，请缩短后再保存（" + p.title.length + " 字）" };
    if ((p.type === "VIDEO" && !p.video) || (p.type === "PODCAST" && !p.audio)) {
      return { ok: false, error: p.type === "VIDEO" ? "视频内容需要先上传视频文件" : "播客内容需要先上传音频文件" };
    }
    return { ok: true, payload: p };
  }

  /**
   * 保存内容
   * @param {Function} api  统一 api 客户端
   * @param {Object} form   编辑器表单（含 id 表示更新）
   * @returns {{ok:boolean, content?:object, error?:string}}
   */
  async function save(api, form) {
    const v = validate(form);
    if (!v.ok) return v;

    const editing = !!form.id;
    const res = editing
      ? await api("/contents/" + form.id, { method: "PUT", body: v.payload })
      : await api("/contents", { method: "POST", body: v.payload });

    if (!res || !res.ok) {
      return {
        ok: false,
        error: (res && res.error) || "保存请求没有被服务确认",
        status: res && res.status,
      };
    }
    /* 服务端必须回传 id，否则说明响应不是内容对象（例如被网关改写） */
    if (!res.id) {
      return { ok: false, error: "服务响应缺少内容 ID，无法确认已保存" };
    }
    return { ok: true, content: res, created: !editing };
  }

  return { save, buildPayload, validate };
});
